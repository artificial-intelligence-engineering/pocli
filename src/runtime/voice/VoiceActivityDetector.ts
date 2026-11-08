import { EventEmitter } from 'node:events';

export interface VoiceActivityDetectorOptions {
  rmsThreshold?: number;
  silenceDurationMs?: number;
  bargeInRmsMultiplier?: number;
  bargeInRequiredFrames?: number;
}

export interface VadFrameMetrics {
  rms: number;
  db: number;
  isSpeech: boolean;
  noiseFloor: number;
  dynamicThreshold: number;
  silenceElapsedMs: number;
}

/**
 * Computes Root Mean Square (RMS) energy of a 16-bit signed PCM buffer.
 */
export function computePcmRms(pcmBuffer: Buffer): number {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount * 2; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Voice Activity Detector (VAD) with adaptive noise floor, configurable end-of-turn pause detection,
 * and barge-in detection during agent TTS playback.
 */
export class VoiceActivityDetector extends EventEmitter {
  private rmsThreshold: number;
  private silenceDurationMs: number;
  private bargeInRmsMultiplier: number;
  private bargeInRequiredFrames: number;

  private noiseFloor = 250;
  private isCurrentlySpeaking = false;
  private lastActivityTimestamp = 0;
  private consecutiveBargeInFrames = 0;
  private endOfSpeechEmitted = false;

  constructor(options: VoiceActivityDetectorOptions = {}) {
    super();
    this.rmsThreshold = options.rmsThreshold ?? 400;
    this.silenceDurationMs = options.silenceDurationMs ?? 1800;
    this.bargeInRmsMultiplier = options.bargeInRmsMultiplier ?? 2.8;
    this.bargeInRequiredFrames = options.bargeInRequiredFrames ?? 5;
  }

  public getSilenceDurationMs(): number {
    return this.silenceDurationMs;
  }

  public setSilenceDurationMs(ms: number): void {
    this.silenceDurationMs = Math.max(400, Math.min(10000, ms));
  }

  public getRmsThreshold(): number {
    return this.rmsThreshold;
  }

  public setRmsThreshold(threshold: number): void {
    this.rmsThreshold = Math.max(50, threshold);
  }

  public reset(): void {
    this.isCurrentlySpeaking = false;
    this.lastActivityTimestamp = 0;
    this.consecutiveBargeInFrames = 0;
    this.endOfSpeechEmitted = false;
  }

  /**
   * Called when streaming STT produces a new partial/final token, refreshing the activity timestamp
   * so pause detection waits until the user genuinely stops speaking.
   */
  public notifyTranscriptActivity(): void {
    this.lastActivityTimestamp = Date.now();
    this.isCurrentlySpeaking = true;
    this.endOfSpeechEmitted = false;
  }

  /**
   * Processes a raw 16-bit mono PCM audio chunk (or precomputed RMS value) and returns frame metrics.
   */
  public processChunk(
    chunkOrRms: Buffer | number,
    optionsOrIsSpeaking:
      | { isAgentSpeaking?: boolean; hasAccumulatedText?: boolean; now?: number }
      | boolean = {},
    explicitNow?: number,
  ): VadFrameMetrics {
    const opts =
      typeof optionsOrIsSpeaking === 'boolean'
        ? { isAgentSpeaking: optionsOrIsSpeaking, now: explicitNow }
        : optionsOrIsSpeaking;
    const now = opts.now ?? explicitNow ?? Date.now();
    const rms = typeof chunkOrRms === 'number' ? chunkOrRms : computePcmRms(chunkOrRms);
    const db = rms > 0 ? Math.max(-60, Math.round(20 * Math.log10(rms / 32768))) : -60;

    const dynamicThreshold = Math.max(this.rmsThreshold, this.noiseFloor * 1.5 + 350);
    const isSpeech = rms >= dynamicThreshold;

    if (opts.isAgentSpeaking) {
      // Barge-in check: requires sustained high energy above barge-in threshold
      const bargeThreshold = Math.max(dynamicThreshold * this.bargeInRmsMultiplier, 2200);
      if (rms >= bargeThreshold) {
        this.consecutiveBargeInFrames += 1;
        if (this.consecutiveBargeInFrames >= this.bargeInRequiredFrames) {
          this.consecutiveBargeInFrames = 0;
          this.emit('barge_in', { rms, db });
        }
      } else {
        this.consecutiveBargeInFrames = Math.max(0, this.consecutiveBargeInFrames - 1);
      }

      return {
        rms,
        db,
        isSpeech: false,
        noiseFloor: this.noiseFloor,
        dynamicThreshold,
        silenceElapsedMs: 0,
      };
    }

    this.consecutiveBargeInFrames = 0;

    if (isSpeech) {
      if (!this.isCurrentlySpeaking) {
        this.isCurrentlySpeaking = true;
        this.endOfSpeechEmitted = false;
        this.emit('speech_start', { rms, db, timestamp: now });
      }
      this.lastActivityTimestamp = now;
    } else {
      // Adapt noise floor smoothly during silence
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;

      if (
        (this.isCurrentlySpeaking || opts.hasAccumulatedText) &&
        this.lastActivityTimestamp > 0
      ) {
        const silenceElapsedMs = now - this.lastActivityTimestamp;
        if (silenceElapsedMs >= this.silenceDurationMs && !this.endOfSpeechEmitted) {
          this.endOfSpeechEmitted = true;
          this.isCurrentlySpeaking = false;
          this.emit('end_of_speech', { silenceElapsedMs, timestamp: now });
        }
        return {
          rms,
          db,
          isSpeech,
          noiseFloor: this.noiseFloor,
          dynamicThreshold,
          silenceElapsedMs,
        };
      }
    }

    const silenceElapsedMs =
      this.lastActivityTimestamp > 0 ? Math.max(0, now - this.lastActivityTimestamp) : 0;

    return {
      rms,
      db,
      isSpeech,
      noiseFloor: this.noiseFloor,
      dynamicThreshold,
      silenceElapsedMs,
    };
  }
}
