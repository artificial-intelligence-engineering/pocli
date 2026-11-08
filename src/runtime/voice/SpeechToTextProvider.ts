import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthStorage } from '../../core/auth.js';

export interface SpeechToTextProvider extends EventEmitter {
  readonly id: string;
  readonly name: string;
  isAvailable(): boolean;
  startStream(language: 'es' | 'en'): Promise<boolean>;
  writeAudio(pcmChunk: Buffer): void;
  flushStream(): Promise<void>;
  stopStream(): Promise<void>;
  transcribeWavBuffer(wavBuffer: Buffer, language: 'es' | 'en'): Promise<string>;
}

/**
 * Resamples 16kHz 16-bit mono PCM to 24kHz 16-bit mono PCM (3:2 ratio) for OpenAI Realtime API.
 */
export function resample16kTo24kPcm16(pcm16k: Buffer): Buffer {
  const inSamples = Math.floor(pcm16k.length / 2);
  if (inSamples === 0) return Buffer.alloc(0);

  const outSamples = Math.floor((inSamples * 3) / 2);
  const outBuf = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const srcPos = (i * 2) / 3;
    const idx0 = Math.min(inSamples - 1, Math.floor(srcPos));
    const idx1 = Math.min(inSamples - 1, idx0 + 1);
    const frac = srcPos - idx0;
    const s0 = pcm16k.readInt16LE(idx0 * 2);
    const s1 = pcm16k.readInt16LE(idx1 * 2);
    const interpolated = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)));
    outBuf.writeInt16LE(interpolated, i * 2);
  }

  return outBuf;
}

/**
 * OpenAI Realtime Streaming Speech-to-Text Provider.
 * Operates strictly in transcription-only mode (`intent=transcription`), never invoking
 * a conversational LLM to interpret or answer user speech.
 */
export class OpenAIRealtimeSTT extends EventEmitter implements SpeechToTextProvider {
  public readonly id = 'openai-realtime';
  public readonly name = 'OpenAI Realtime STT (Streaming)';

  private ws: WebSocket | null = null;
  private isConnected = false;
  private isConnecting = false;
  private shouldReconnect = false;
  private language: 'es' | 'en' = 'es';
  private currentItemDelta = '';
  private reconnectTimer: NodeJS.Timeout | null = null;

  public isAvailable(): boolean {
    return Boolean(process.env.OPENAI_API_KEY || AuthStorage.getApiKey('openai'));
  }

  private getApiKey(): string | null {
    return process.env.OPENAI_API_KEY || AuthStorage.getApiKey('openai') || null;
  }

  public async startStream(language: 'es' | 'en'): Promise<boolean> {
    this.language = language;
    const apiKey = this.getApiKey();
    if (!apiKey || typeof WebSocket === 'undefined') {
      return false;
    }

    if (this.isConnected && this.ws) {
      this.sendSessionUpdate();
      return true;
    }

    this.shouldReconnect = true;
    return this.connectWebSocket(apiKey);
  }

  private connectWebSocket(apiKey: string): Promise<boolean> {
    if (this.isConnecting) return Promise.resolve(false);
    this.isConnecting = true;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (!settled) {
          settled = true;
          this.isConnecting = false;
          resolve(ok);
        }
      };

      try {
        const url = 'wss://api.openai.com/v1/realtime?intent=transcription';
        const protocols = [
          'realtime',
          `openai-insecure-api-key.${apiKey}`,
          'openai-beta.realtime-v1',
        ];
        const socket = new WebSocket(url, protocols);
        this.ws = socket;

        const connectTimeout = setTimeout(() => {
          finish(false);
        }, 5000);

        socket.onopen = () => {
          clearTimeout(connectTimeout);
          this.isConnected = true;
          this.currentItemDelta = '';
          this.sendSessionUpdate();
          finish(true);
        };

        socket.onmessage = (event: MessageEvent) => {
          this.handleRealtimeMessage(String(event.data));
        };

        socket.onerror = () => {
          clearTimeout(connectTimeout);
          this.isConnected = false;
          finish(false);
        };

        socket.onclose = () => {
          clearTimeout(connectTimeout);
          this.isConnected = false;
          this.ws = null;
          finish(false);

          if (this.shouldReconnect) {
            this.reconnectTimer = setTimeout(() => {
              const key = this.getApiKey();
              if (key && this.shouldReconnect) {
                void this.connectWebSocket(key);
              }
            }, 2000);
          }
        };
      } catch {
        finish(false);
      }
    });
  }

  private sendSessionUpdate(): void {
    if (!this.ws || !this.isConnected) return;
    try {
      const payload = {
        type: 'transcription_session.update',
        session: {
          input_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'gpt-4o-transcribe',
            language: this.language,
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      };
      this.ws.send(JSON.stringify(payload));
    } catch {
      // ignore send errors
    }
  }

  private handleRealtimeMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as {
        type?: string;
        delta?: string;
        transcript?: string;
        error?: { message?: string };
      };

      if (msg.type === 'conversation.item.input_audio_transcription.delta') {
        const delta = msg.delta ?? '';
        if (delta) {
          this.currentItemDelta += delta;
          this.emit('partial', this.currentItemDelta.trim());
        }
      } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        const finalTranscript = (msg.transcript ?? this.currentItemDelta).trim();
        this.currentItemDelta = '';
        if (finalTranscript) {
          this.emit('final', finalTranscript);
        }
      } else if (msg.type === 'error' && msg.error?.message) {
        this.emit('error', new Error(msg.error.message));
      }
    } catch {
      // ignore malformed JSON
    }
  }

  public writeAudio(pcmChunk: Buffer): void {
    if (!this.ws || !this.isConnected) return;
    try {
      const resampled24k = resample16kTo24kPcm16(pcmChunk);
      const payload = {
        type: 'input_audio_buffer.append',
        audio: resampled24k.toString('base64'),
      };
      this.ws.send(JSON.stringify(payload));
    } catch {
      // ignore socket write errors
    }
  }

  public async flushStream(): Promise<void> {
    if (!this.ws || !this.isConnected) return;
    try {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch {
      // ignore
    }
  }

  public async stopStream(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      this.isConnected = false;
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    this.currentItemDelta = '';
  }

  public async transcribeWavBuffer(wavBuffer: Buffer, language: 'es' | 'en'): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) return '';

    try {
      const formData = new FormData();
      const blob = new Blob([wavBuffer], { type: 'audio/wav' });
      formData.append('file', blob, 'audio.wav');
      formData.append('model', 'whisper-1');
      formData.append('language', language);

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      });

      if (res.ok) {
        const json = (await res.json()) as { text?: string };
        if (json.text) return json.text.trim();
      }
    } catch {
      // ignore
    }
    return '';
  }
}

/**
 * Local Offline Vosk Streaming Speech-to-Text Provider.
 * Streams 16kHz PCM audio to a persistent Python/Kaldi process (`native-stt.py --stream`)
 * emitting real-time partial and finalized transcripts with 0 cloud tokens.
 */
export class VoskStreamingSTT extends EventEmitter implements SpeechToTextProvider {
  public readonly id = 'vosk-streaming';
  public readonly name = 'Vosk Streaming (Kaldi Local STT · 0 Tokens)';

  private pythonBin: string | null;
  private scriptPath: string;
  private streamProcess: ChildProcess | null = null;
  private stdoutBuffer = '';
  private language: 'es' | 'en' = 'es';

  constructor(options: { pythonBin?: string | null; scriptPath: string }) {
    super();
    this.pythonBin = options.pythonBin ?? null;
    this.scriptPath = options.scriptPath;
  }

  public isAvailable(): boolean {
    if (!this.pythonBin || !fs.existsSync(this.scriptPath)) return false;
    try {
      const res = spawnSync(this.pythonBin, ['-c', 'import vosk; print("ok")'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      return res.status === 0 && res.stdout.includes('ok');
    } catch {
      return false;
    }
  }

  public async startStream(language: 'es' | 'en'): Promise<boolean> {
    if (this.streamProcess && this.language === language) {
      return true;
    }
    await this.stopStream();
    this.language = language;

    if (!this.pythonBin || !fs.existsSync(this.scriptPath)) {
      return false;
    }

    try {
      this.streamProcess = spawn(this.pythonBin, [this.scriptPath, '--stream', language], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      this.stdoutBuffer = '';

      this.streamProcess.stdout?.on('data', (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString('utf8');
        const lines = this.stdoutBuffer.split('\n');
        this.stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as {
              type?: 'ready' | 'partial' | 'final' | 'error';
              text?: string;
              error?: string;
            };
            if (parsed.type === 'partial' && typeof parsed.text === 'string') {
              this.emit('partial', parsed.text);
            } else if (parsed.type === 'final' && parsed.text) {
              this.emit('final', parsed.text);
            } else if (parsed.type === 'error' && parsed.error) {
              this.emit('error', new Error(parsed.error));
            }
          } catch {
            // ignore non-json stdout lines
          }
        }
      });

      this.streamProcess.on('close', () => {
        this.streamProcess = null;
      });

      this.streamProcess.on('error', (err) => {
        this.streamProcess = null;
        this.emit('error', err);
      });

      return true;
    } catch {
      this.streamProcess = null;
      return false;
    }
  }

  public writeAudio(pcmChunk: Buffer): void {
    if (!this.streamProcess?.stdin || this.streamProcess.stdin.destroyed) return;
    try {
      this.streamProcess.stdin.write(pcmChunk);
    } catch {
      // ignore broken pipe
    }
  }

  public async flushStream(): Promise<void> {
    // Feed a short silence frame (0.3s) so KaldiRecognizer commits any pending partial words
    if (this.streamProcess?.stdin && !this.streamProcess.stdin.destroyed) {
      try {
        const silence = Buffer.alloc(9600);
        this.streamProcess.stdin.write(silence);
      } catch {
        // ignore
      }
    }
  }

  public async stopStream(): Promise<void> {
    if (this.streamProcess) {
      const proc = this.streamProcess;
      this.streamProcess = null;
      try {
        proc.stdin?.end();
        proc.stdout?.removeAllListeners();
        proc.removeAllListeners();
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.stdoutBuffer = '';
  }

  public async transcribeWavBuffer(wavBuffer: Buffer, language: 'es' | 'en'): Promise<string> {
    if (!this.pythonBin || !fs.existsSync(this.scriptPath)) return '';

    const tmpWav = path.join(
      os.tmpdir(),
      `pocli-vosk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
    );

    try {
      fs.writeFileSync(tmpWav, wavBuffer);
      const res = spawnSync(this.pythonBin, [this.scriptPath, language, tmpWav], {
        encoding: 'utf8',
        timeout: 10000,
      });
      if (res.status === 0 && res.stdout.trim()) {
        const parsed = JSON.parse(res.stdout.trim()) as { text?: string };
        if (parsed.text) return parsed.text.trim();
      }
    } catch {
      // ignore
    } finally {
      try {
        if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
      } catch {
        // ignore
      }
    }
    return '';
  }
}

/**
 * Local Offline Whisper.cpp (`whisper-cli`) Speech-to-Text Provider.
 */
export class WhisperCppSTT extends EventEmitter implements SpeechToTextProvider {
  public readonly id = 'whisper-cpp';
  public readonly name = 'Whisper.cpp Local Native STT (0 Tokens)';

  private scriptPath: string;
  private pythonBin: string | null;

  constructor(options: { pythonBin?: string | null; scriptPath: string }) {
    super();
    this.pythonBin = options.pythonBin ?? null;
    this.scriptPath = options.scriptPath;
  }

  public isAvailable(): boolean {
    for (const cmd of ['whisper-cli', 'whisper-cpp']) {
      try {
        const res = spawnSync('which', [cmd], { encoding: 'utf8' });
        if (res.status === 0 && res.stdout.trim()) return true;
      } catch {
        // ignore
      }
    }
    return false;
  }

  public async startStream(_language: 'es' | 'en'): Promise<boolean> {
    return this.isAvailable();
  }

  public writeAudio(_pcmChunk: Buffer): void {
    // WhisperCpp processes buffered segments via transcribeWavBuffer
  }

  public async flushStream(): Promise<void> {}

  public async stopStream(): Promise<void> {}

  public async transcribeWavBuffer(wavBuffer: Buffer, language: 'es' | 'en'): Promise<string> {
    const tmpWav = path.join(
      os.tmpdir(),
      `pocli-whisper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
    );

    try {
      fs.writeFileSync(tmpWav, wavBuffer);
      if (this.pythonBin && fs.existsSync(this.scriptPath)) {
        const res = spawnSync(this.pythonBin, [this.scriptPath, language, tmpWav], {
          encoding: 'utf8',
          timeout: 10000,
        });
        if (res.status === 0 && res.stdout.trim()) {
          const parsed = JSON.parse(res.stdout.trim()) as { text?: string };
          if (parsed.text) return parsed.text.trim();
        }
      }
    } catch {
      // ignore
    } finally {
      try {
        if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
      } catch {
        // ignore
      }
    }
    return '';
  }
}

