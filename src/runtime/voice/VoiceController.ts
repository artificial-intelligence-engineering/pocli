import { EventEmitter } from 'node:events';
import type { ActorRole } from '../../core/contracts.js';
import { VoiceStateManager } from './VoiceStateManager.js';
import type { VoiceTurnState, LegacyVoiceState } from './VoiceStateManager.js';
import { AudioCapture } from './AudioCapture.js';
import { VoiceActivityDetector } from './VoiceActivityDetector.js';
import { VoiceCommandRecognizer } from './VoiceCommandRecognizer.js';
import type { VoiceControlAction } from './VoiceCommandRecognizer.js';
import type { SpeechToTextProvider } from './SpeechToTextProvider.js';
import type { TextToSpeechProvider } from './TextToSpeechProvider.js';

export interface VoiceDraftUpdateEvent {
  committedText: string;
  partialText: string;
  fullText: string;
}

export interface VoiceControllerOptions {
  language?: 'es' | 'en';
  silenceDurationMs?: number;
  rmsThreshold?: number;
  sttProvider?: SpeechToTextProvider;
  ttsProvider?: TextToSpeechProvider;
}

/**
 * Coordinates the hands-free voice conversation lifecycle:
 * LISTENING -> PROCESSING -> SPEAKING -> LISTENING
 */
export class VoiceController extends EventEmitter {
  public readonly stateManager: VoiceStateManager;
  public readonly audioCapture: AudioCapture;
  public readonly vad: VoiceActivityDetector;
  public readonly commandRecognizer: VoiceCommandRecognizer;

  private sttProvider: SpeechToTextProvider | null = null;
  private ttsProvider: TextToSpeechProvider | null = null;
  private language: 'es' | 'en';
  private currentRole: ActorRole = 'architect';

  private committedSegments: string[] = [];
  private partialText = '';
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(options: VoiceControllerOptions = {}) {
    super();
    this.language = options.language ?? 'es';
    this.stateManager = new VoiceStateManager('IDLE');
    this.audioCapture = new AudioCapture({ sampleRate: 16000, channels: 1 });
    this.vad = new VoiceActivityDetector({
      rmsThreshold: options.rmsThreshold ?? 400,
      silenceDurationMs: options.silenceDurationMs ?? 1800,
    });
    this.commandRecognizer = new VoiceCommandRecognizer({ language: this.language });

    if (options.sttProvider) {
      this.setSttProvider(options.sttProvider);
    }
    if (options.ttsProvider) {
      this.setTtsProvider(options.ttsProvider);
    }

    this.wireInternalEvents();
  }

  private wireInternalEvents(): void {
    this.stateManager.on('transition', (evt) => {
      this.emit('turn_state_change', evt.to, evt);
      this.emit('state_change', evt.legacyState);
    });

    this.vad.on('end_of_speech', () => {
      if (this.stateManager.isListening() && this.getAccumulatedText().length > 0) {
        this.finalizeAndDispatchTurn('pause_timeout');
      }
    });

    this.vad.on('barge_in', () => {
      if (this.stateManager.isSpeaking()) {
        this.interruptSpeech();
      }
    });
  }

  public setSttProvider(provider: SpeechToTextProvider): void {
    if (this.sttProvider) {
      this.sttProvider.removeAllListeners();
    }
    this.sttProvider = provider;

    provider.on('partial', (text: string) => {
      if (!this.stateManager.isListening()) return;
      this.handlePartialTranscript(text);
    });

    provider.on('final', (text: string) => {
      if (!this.stateManager.isListening()) return;
      this.handleFinalTranscript(text);
    });

    provider.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  public getSttProvider(): SpeechToTextProvider | null {
    return this.sttProvider;
  }

  public setTtsProvider(provider: TextToSpeechProvider): void {
    this.ttsProvider = provider;
  }

  public getTtsProvider(): TextToSpeechProvider | null {
    return this.ttsProvider;
  }

  public setLanguage(lang: 'es' | 'en'): void {
    this.language = lang;
    this.commandRecognizer.setLanguage(lang);
  }

  public getLanguage(): 'es' | 'en' {
    return this.language;
  }

  public setCurrentRole(role: ActorRole): void {
    this.currentRole = role;
  }

  public getCurrentRole(): ActorRole {
    return this.currentRole;
  }

  public getTurnState(): VoiceTurnState {
    return this.stateManager.getState();
  }

  public getLegacyState(): LegacyVoiceState {
    return this.stateManager.getLegacyState();
  }

  /**
   * Appends a finalized transcript segment without duplicating overlapping fragments.
   */
  public appendCommittedSegment(segment: string): void {
    const clean = segment.trim();
    if (!clean) return;

    if (this.committedSegments.length > 0) {
      const last = this.committedSegments[this.committedSegments.length - 1];
      if (last.toLowerCase() === clean.toLowerCase()) {
        // Exact duplicate of previous finalized segment
        return;
      }
      if (clean.toLowerCase().startsWith(last.toLowerCase())) {
        // Provider emitted cumulative transcript; replace previous segment
        this.committedSegments[this.committedSegments.length - 1] = clean;
        return;
      }
    }

    this.committedSegments.push(clean);
  }

  public getAccumulatedText(): string {
    const committed = this.committedSegments.join(' ').trim();
    const partial = this.partialText.trim();
    if (committed && partial) {
      // Avoid duplicating if partial already starts with committed
      if (partial.toLowerCase().startsWith(committed.toLowerCase())) {
        return partial;
      }
      return `${committed} ${partial}`.trim();
    }
    return committed || partial;
  }

  public clearDraft(): void {
    this.committedSegments = [];
    this.partialText = '';
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.emitDraftUpdate();
  }

  private emitDraftUpdate(): void {
    const committedText = this.committedSegments.join(' ').trim();
    const partialText = this.partialText.trim();
    const fullText = this.getAccumulatedText();
    const payload: VoiceDraftUpdateEvent = {
      committedText,
      partialText,
      fullText,
    };
    this.emit('draft_update', payload);
  }

  private resetSilenceWatchdog(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
    const timeoutMs = this.vad.getSilenceDurationMs();
    this.silenceTimer = setTimeout(() => {
      if (this.stateManager.isListening() && this.getAccumulatedText().length > 0) {
        this.finalizeAndDispatchTurn('pause_timeout');
      }
    }, timeoutMs);
  }

  public handlePartialTranscript(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.vad.notifyTranscriptActivity();
    this.partialText = trimmed;
    this.emitDraftUpdate();

    // Check if the partial already contains an explicit send trigger phrase at the end
    const full = this.getAccumulatedText();
    const action = this.commandRecognizer.analyze(full);
    if (action.type === 'send_now' && action.cleanedText.length > 0) {
      this.finalizeAndDispatchTurn('trigger_phrase', action);
      return;
    }

    this.resetSilenceWatchdog();
  }

  public handleFinalTranscript(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.vad.notifyTranscriptActivity();
    this.partialText = '';
    this.appendCommittedSegment(trimmed);
    this.emitDraftUpdate();

    const full = this.getAccumulatedText();
    const action = this.commandRecognizer.analyze(full);

    if (action.type !== 'none') {
      this.finalizeAndDispatchTurn('control_command', action);
      return;
    }

    this.resetSilenceWatchdog();
  }

  public finalizeAndDispatchTurn(
    reason: 'pause_timeout' | 'trigger_phrase' | 'control_command' | 'manual',
    precomputedAction?: VoiceControlAction,
  ): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    const rawAccumulated = this.getAccumulatedText();
    this.committedSegments = [];
    this.partialText = '';
    this.vad.reset();
    this.emitDraftUpdate();

    if (!rawAccumulated) return;

    const action = precomputedAction ?? this.commandRecognizer.analyze(rawAccumulated);

    if (action.type === 'send_now') {
      const textToSend = action.cleanedText.trim();
      if (!textToSend) return;
      this.stateManager.transitionTo('PROCESSING', reason);
      this.emit('turn_ready', {
        text: textToSend,
        triggerPhrase: action.triggerPhrase,
        reason: 'trigger_phrase',
      });
      return;
    }

    if (
      action.type === 'stop_conversation' ||
      action.type === 'pause_listening' ||
      action.type === 'resume_listening' ||
      action.type === 'switch_agent' ||
      action.type === 'select_language'
    ) {
      this.emit('control_action', action);
      return;
    }

    // Standard message turn completed by pause detection
    const finalText = action.text.trim();
    if (!finalText) return;

    this.stateManager.transitionTo('PROCESSING', reason);
    this.emit('turn_ready', {
      text: finalText,
      reason,
    });
  }

  /**
   * Interrupts ongoing TTS playback (barge-in) and returns immediately to LISTENING.
   */
  public interruptSpeech(): void {
    if (this.ttsProvider) {
      this.ttsProvider.stop();
    }
    this.emit('barge_in');
    if (this.stateManager.isSpeaking() || this.stateManager.isProcessing()) {
      this.stateManager.transitionTo('LISTENING', 'barge_in');
    }
  }
}

