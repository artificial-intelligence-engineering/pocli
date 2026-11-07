import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ActorRole } from '../core/contracts.js';
import { AuthStorage } from '../core/auth.js';

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking' | 'muted';

export type VoiceIntentType = 'switch_agent' | 'mute' | 'unmute' | 'agent_message';

export interface VoiceIntent {
  type: VoiceIntentType;
  targetRole?: ActorRole;
  roleName?: string;
  text?: string;
  originalUtterance: string;
}

export interface VoiceServiceOptions {
  language?: 'es' | 'en';
  vadSilenceMs?: number;
  vadRmsThreshold?: number;
  autoSpeakReplies?: boolean;
}

/**
 * Strips markdown symbols, code fences, ascii tables, and backticks from text
 * so that Text-to-Speech synthesizers pronounce it naturally.
 */
export function stripMarkdownForSpeech(text: string, language: 'es' | 'en' = 'es'): string {
  let cleaned = text;

  // 1. Remove code blocks
  cleaned = cleaned.replace(
    /```[\s\S]*?```/g,
    language === 'es' ? ' [Bloque de código omitido]. ' : ' [Code block omitted]. ',
  );

  // 2. Remove markdown tables
  cleaned = cleaned.replace(
    /(?:^|\n)\s*\|.*\|(?:\r?\n\s*\|.*\|)+/g,
    language === 'es' ? ' [Tabla de datos omitida]. ' : ' [Data table omitted]. ',
  );

  // 3. Remove headers
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');

  // 4. Remove bold / italics
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
  cleaned = cleaned.replace(/_([^_]+)_/g, '$1');

  // 5. Remove inline code backticks
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // 6. Convert links [label](url) -> label
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 7. Remove list bullets (*, -, +) at start of lines
  cleaned = cleaned.replace(/^\s*[-*+]\s+/gm, '');

  // 8. Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // 9. Cap length to avoid reading endless essay out loud (keeps first 700 chars)
  if (cleaned.length > 700) {
    cleaned = `${cleaned.slice(0, 680)}... ${
      language === 'es'
        ? '[Detalles completos en pantalla]'
        : '[Full details on screen]'
    }`;
  }

  return cleaned;
}

/**
 * Parses spoken user text to detect intent:
 * - Switch agent: "quiero hablar con el arquitecto", "talk to developer", etc.
 * - Mute control: "silencio", "mute", "apaga el micro", etc.
 * - Unmute control: "unmute", "activar micro", etc.
 * - Agent message: conversational turn for current active agent.
 */
export function parseVoiceIntent(
  text: string,
  currentRole: ActorRole = 'architect',
  language: 'es' | 'en' = 'es',
): VoiceIntent {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. Mute intent
  if (
    /^(?:silencio|mute|mutear|silenciar|apaga(?:r)?\s+(?:el\s+)?micr[oó]fono|desactiva(?:r)?\s+(?:el\s+)?micr[oó]fono|stop\s+listening|mute\s+mic(?:rophone)?)$/i.test(
      lower,
    )
  ) {
    return {
      type: 'mute',
      originalUtterance: trimmed,
    };
  }

  // 2. Unmute intent
  if (
    /^(?:activar\s+micr[oó]fono|desmutear|unmute|live|activar\s+voz)$/i.test(lower)
  ) {
    return {
      type: 'unmute',
      originalUtterance: trimmed,
    };
  }

  // 3. Switch Agent Intents
  const prefix =
    '(?:quiero\\s+hablar\\s+con|p[aá]same\\s+con|p[aá]same\\s+al?|p[aá]same|hablar\\s+con|conectar\\s+con|cambia(?:r)?\\s+(?:a|al)?|talk\\s+to|switch\\s+to|connect\\s+to)\\s+(?:el\\s+|la\\s+|the\\s+)?';

  // 3a. Architect
  if (
    new RegExp(`${prefix}(?:arquitecto|architect)`, 'i').test(lower)
  ) {
    return {
      type: 'switch_agent',
      targetRole: 'architect',
      roleName: language === 'es' ? 'Arquitecto de Software' : 'Software Architect',
      originalUtterance: trimmed,
    };
  }

  // 3b. Developer
  if (
    new RegExp(`${prefix}(?:desarrollador|developer|dev)`, 'i').test(lower)
  ) {
    return {
      type: 'switch_agent',
      targetRole: 'developer',
      roleName: language === 'es' ? 'Desarrollador Senior' : 'Senior Developer',
      originalUtterance: trimmed,
    };
  }

  // 3c. QA Engineer
  if (
    new RegExp(`${prefix}(?:qa|tester|control\\s+de\\s+calidad|ingeniero\\s+de\\s+qa)`, 'i').test(
      lower,
    )
  ) {
    return {
      type: 'switch_agent',
      targetRole: 'qa',
      roleName: language === 'es' ? 'Ingeniero de QA' : 'QA Engineer',
      originalUtterance: trimmed,
    };
  }

  // 3d. Project Manager (PM)
  if (
    new RegExp(
      `${prefix}(?:pm|project\\s+manager|gestor\\s+de\\s+proyecto|jefe\\s+de\\s+proyecto)`,
      'i',
    ).test(lower)
  ) {
    return {
      type: 'switch_agent',
      targetRole: 'pm',
      roleName: language === 'es' ? 'Project Manager' : 'Project Manager',
      originalUtterance: trimmed,
    };
  }

  // 4. Default: message to current active agent
  return {
    type: 'agent_message',
    targetRole: currentRole,
    text: trimmed,
    originalUtterance: trimmed,
  };
}

/**
 * Returns the spoken confirmation text when switching to an interlocutor.
 */
export function getSwitchConfirmationText(role: ActorRole, language: 'es' | 'en' = 'es'): string {
  if (language === 'es') {
    switch (role) {
      case 'architect':
        return 'El arquitecto está escuchando.';
      case 'developer':
        return 'El desarrollador está escuchando.';
      case 'qa':
        return 'El especialista de control de calidad está escuchando.';
      case 'pm':
        return 'El jefe de proyecto está escuchando.';
      default:
        return 'El especialista está escuchando.';
    }
  } else {
    switch (role) {
      case 'architect':
        return 'The Software Architect is listening.';
      case 'developer':
        return 'The Senior Developer is listening.';
      case 'qa':
        return 'The QA Engineer is listening.';
      case 'pm':
        return 'The Project Manager is listening.';
      default:
        return 'The specialist is listening.';
    }
  }
}

/**
 * Encapsulates raw 16-bit mono 16kHz PCM audio data into a standard 44-byte RIFF WAVE buffer.
 */
export function pcmToWav(
  pcmData: Buffer,
  sampleRate = 16000,
  channels = 1,
  bitDepth = 16,
): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

/**
 * Calculates the Root-Mean-Square (RMS) volume level of 16-bit mono PCM chunks.
 */
export function computeRmsVolume(buffer: Buffer): number {
  let sum = 0;
  const count = Math.floor(buffer.length / 2);
  if (count === 0) return 0;
  for (let i = 0; i < buffer.length - 1; i += 2) {
    const val = buffer.readInt16LE(i);
    sum += val * val;
  }
  return Math.sqrt(sum / count);
}

/**
 * Bidirectional Live Voice Service for PO CLI.
 */
export class VoiceService extends EventEmitter {
  private state: VoiceState = 'idle';
  private language: 'es' | 'en' = 'es';
  private currentRole: ActorRole = 'architect';
  private vadSilenceMs: number;
  private vadRmsThreshold: number;
  private autoSpeakReplies: boolean;
  private recordProcess: ChildProcess | null = null;
  private isCapturing = false;
  private speechChunks: Buffer[] = [];
  private hasSpoken = false;
  private lastSoundTimestamp = 0;
  private silenceCheckTimer: NodeJS.Timeout | null = null;
  private activeTtsProcess: ChildProcess | null = null;

  constructor(options: VoiceServiceOptions = {}) {
    super();
    this.language = options.language ?? 'es';
    this.vadSilenceMs = options.vadSilenceMs ?? 1200;
    this.vadRmsThreshold = options.vadRmsThreshold ?? 400;
    this.autoSpeakReplies = options.autoSpeakReplies ?? true;
  }

  public setLanguage(lang: 'es' | 'en'): void {
    this.language = lang;
  }

  public setCurrentRole(role: ActorRole): void {
    this.currentRole = role;
  }

  public getState(): VoiceState {
    return this.state;
  }

  public isLive(): boolean {
    return this.state !== 'idle' && this.state !== 'muted';
  }

  public isMuted(): boolean {
    return this.state === 'muted';
  }

  private setState(next: VoiceState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state_change', next);
  }

  /**
   * Activates live listening mode.
   */
  public async startLive(): Promise<void> {
    if (this.isLive()) return;
    this.setState('listening');
    this.startMicrophoneCapture();
  }

  /**
   * Mutes live voice mode.
   */
  public mute(): void {
    this.cancelSpeechOutput();
    this.stopMicrophoneCapture();
    this.setState('muted');
  }

  /**
   * Unmutes and restores live listening mode.
   */
  public unmute(): void {
    if (this.state === 'muted') {
      this.setState('listening');
      this.startMicrophoneCapture();
    }
  }

  /**
   * Deactivates live voice completely.
   */
  public stopLive(): void {
    this.cancelSpeechOutput();
    this.stopMicrophoneCapture();
    this.setState('idle');
  }

  /**
   * Starts low-latency native microphone capture via ALSA/PipeWire (arecord).
   */
  private startMicrophoneCapture(): void {
    if (this.isCapturing) return;
    this.isCapturing = true;
    this.speechChunks = [];
    this.hasSpoken = false;

    try {
      // Use arecord in raw PCM mode: 16kHz, mono, 16-bit little-endian
      const child = spawn(
        'arecord',
        ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-q'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );

      this.recordProcess = child;

      child.stdout.on('data', (chunk: Buffer) => {
        if (!this.isCapturing || this.state === 'speaking' || this.state === 'transcribing') {
          return;
        }

        const rms = computeRmsVolume(chunk);
        const now = Date.now();

        if (rms >= this.vadRmsThreshold) {
          this.hasSpoken = true;
          this.lastSoundTimestamp = now;
          this.speechChunks.push(chunk);
        } else if (this.hasSpoken) {
          // Keep trailing silence chunks up to vadSilenceMs for smooth utterance boundaries
          this.speechChunks.push(chunk);
          if (now - this.lastSoundTimestamp >= this.vadSilenceMs) {
            // Voice Activity Detection triggered end-of-utterance
            this.handleUtteranceComplete();
          }
        }
      });

      child.on('error', (err) => {
        this.emit('error', err);
        this.isCapturing = false;
      });

      child.on('close', () => {
        this.isCapturing = false;
      });

      // Start periodic silence watchdog timer
      if (this.silenceCheckTimer) clearInterval(this.silenceCheckTimer);
      this.silenceCheckTimer = setInterval(() => {
        if (
          this.hasSpoken &&
          this.isCapturing &&
          Date.now() - this.lastSoundTimestamp >= this.vadSilenceMs
        ) {
          this.handleUtteranceComplete();
        }
      }, 250);
    } catch (err) {
      this.emit('error', err as Error);
      this.isCapturing = false;
    }
  }

  /**
   * Stops the active recording process.
   */
  private stopMicrophoneCapture(): void {
    this.isCapturing = false;
    if (this.silenceCheckTimer) {
      clearInterval(this.silenceCheckTimer);
      this.silenceCheckTimer = null;
    }
    if (this.recordProcess) {
      try {
        this.recordProcess.kill('SIGTERM');
      } catch {
        // ignore error
      }
      this.recordProcess = null;
    }
    this.speechChunks = [];
    this.hasSpoken = false;
  }

  /**
   * Called when silence is detected after user speech.
   */
  private async handleUtteranceComplete(): Promise<void> {
    if (!this.hasSpoken || this.speechChunks.length === 0) return;

    const collectedPcm = Buffer.concat(this.speechChunks);
    this.speechChunks = [];
    this.hasSpoken = false;

    // Minimum utterance duration: ~0.4s (12,800 bytes at 16kHz 16-bit mono)
    if (collectedPcm.length < 12800) return;

    const wavBuffer = pcmToWav(collectedPcm, 16000, 1, 16);
    this.setState('transcribing');

    try {
      const transcription = await this.transcribeAudio(wavBuffer);
      if (transcription.trim()) {
        const intent = parseVoiceIntent(transcription, this.currentRole, this.language);
        this.emit('transcription', { text: transcription.trim(), intent });
      }
    } catch (err) {
      this.emit('error', err as Error);
    } finally {
      if (this.state === 'transcribing') {
        this.setState('listening');
      }
    }
  }

  /**
   * Transcribes WAV audio buffer to text via Groq Whisper, OpenAI Whisper, Gemini, or simulated fallback.
   */
  public async transcribeAudio(wavBuffer: Buffer): Promise<string> {
    const groqKey = AuthStorage.getApiKey('groq');
    const openaiKey = AuthStorage.getApiKey('openai');
    const geminiKey = AuthStorage.getApiKey('gemini');

    // 1. Try Groq Whisper (Ultra low latency ~200ms)
    if (groqKey) {
      try {
        const formData = new FormData();
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        formData.append('file', blob, 'audio.wav');
        formData.append('model', 'whisper-large-v3-turbo');
        formData.append('language', this.language);

        const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${groqKey}` },
          body: formData,
        });

        if (res.ok) {
          const json = (await res.json()) as { text?: string };
          if (json.text) return json.text.trim();
        }
      } catch {
        // Fallback to next provider
      }
    }

    // 2. Try OpenAI Whisper
    if (openaiKey) {
      try {
        const formData = new FormData();
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        formData.append('file', blob, 'audio.wav');
        formData.append('model', 'whisper-1');
        formData.append('language', this.language);

        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${openaiKey}` },
          body: formData,
        });

        if (res.ok) {
          const json = (await res.json()) as { text?: string };
          if (json.text) return json.text.trim();
        }
      } catch {
        // Fallback
      }
    }

    // 3. Try Gemini Multimodal Audio
    if (geminiKey) {
      try {
        const promptText =
          this.language === 'es'
            ? 'Transcribe este audio palabra por palabra. Devuelve únicamente la transcripción exacta, sin comentarios.'
            : 'Transcribe this audio verbatim. Return only the transcription, without any extra text.';

        const body = {
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/wav',
                    data: wavBuffer.toString('base64'),
                  },
                },
                { text: promptText },
              ],
            },
          ],
        };

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );

        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const out = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (out) return out.trim();
        }
      } catch {
        // Fallback
      }
    }

    return '';
  }

  /**
   * Injects simulated spoken text (used for testing or explicit text-to-voice simulation).
   */
  public async simulateUtterance(
    text: string,
    currentRole: ActorRole = 'architect',
  ): Promise<{ text: string; intent: VoiceIntent }> {
    const intent = parseVoiceIntent(text, currentRole, this.language);
    this.emit('transcription', { text, intent });
    return { text, intent };
  }

  /**
   * Speaks a response out loud using native Linux speech-dispatcher (spd-say).
   */
  public async speak(text: string, options: { language?: 'es' | 'en'; interrupt?: boolean } = {}): Promise<void> {
    const lang = options.language ?? this.language;
    const cleaned = stripMarkdownForSpeech(text, lang);
    if (!cleaned) return;

    if (options.interrupt ?? true) {
      this.cancelSpeechOutput();
    }

    const previousState = this.state;
    this.setState('speaking');
    this.emit('speaking_start', { text: cleaned });

    return new Promise<void>((resolve) => {
      try {
        const spdArgs = ['-w', '-l', lang, '-r', '-5', cleaned];
        const child = spawn('spd-say', spdArgs, {
          stdio: ['ignore', 'ignore', 'ignore'],
        });

        this.activeTtsProcess = child;

        child.on('close', () => {
          this.activeTtsProcess = null;
          this.emit('speaking_end', { text: cleaned });
          if (this.state === 'speaking') {
            this.setState(previousState === 'speaking' ? 'listening' : previousState);
          }
          resolve();
        });

        child.on('error', () => {
          this.activeTtsProcess = null;
          this.emit('speaking_end', { text: cleaned });
          if (this.state === 'speaking') {
            this.setState(previousState === 'speaking' ? 'listening' : previousState);
          }
          resolve();
        });
      } catch {
        this.emit('speaking_end', { text: cleaned });
        if (this.state === 'speaking') {
          this.setState(previousState === 'speaking' ? 'listening' : previousState);
        }
        resolve();
      }
    });
  }

  /**
   * Cancels any active speech synthesis output.
   */
  public cancelSpeechOutput(): void {
    if (this.activeTtsProcess) {
      try {
        this.activeTtsProcess.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.activeTtsProcess = null;
    }
    try {
      spawn('spd-say', ['-C'], { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }
}
