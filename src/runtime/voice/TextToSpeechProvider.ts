import { spawn, execSync, ChildProcess } from 'node:child_process';
import { AuthStorage } from '../../core/auth.js';

export interface TextToSpeechProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): boolean;
  speak(text: string, options?: { language?: 'es' | 'en'; voice?: string }): Promise<void>;
  stop(): void;
  isSpeaking(): boolean;
}

/**
 * Native Linux Speech-Dispatcher (`spd-say`) TTS Provider (0 tokens, offline).
 */
export class SystemNativeTTS implements TextToSpeechProvider {
  public readonly id = 'system-native';
  public readonly name = 'speech-dispatcher (spd-say · 0 Tokens)';

  private activeProcess: ChildProcess | null = null;

  public isAvailable(): boolean {
    return true;
  }

  public isSpeaking(): boolean {
    return this.activeProcess !== null;
  }

  public async speak(
    text: string,
    options: { language?: 'es' | 'en'; voice?: string } = {},
  ): Promise<void> {
    const cleaned = text.trim();
    if (!cleaned) return;

    const lang = options.language ?? 'es';
    const spdLang = lang === 'es' ? 'es' : 'en';

    return new Promise<void>((resolve) => {
      try {
        const proc = spawn('spd-say', ['--wait', '-l', spdLang, '-r', '10', cleaned], {
          stdio: 'ignore',
        });
        this.activeProcess = proc;

        proc.on('close', () => {
          if (this.activeProcess === proc) {
            this.activeProcess = null;
          }
          resolve();
        });

        proc.on('error', () => {
          if (this.activeProcess === proc) {
            this.activeProcess = null;
          }
          resolve();
        });
      } catch {
        this.activeProcess = null;
        resolve();
      }
    });
  }

  public stop(): void {
    if (this.activeProcess) {
      const proc = this.activeProcess;
      this.activeProcess = null;
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    try {
      execSync('spd-say --cancel', { stdio: 'ignore' });
    } catch {
      // ignore if spd-say not running
    }
  }
}

/**
 * OpenAI TTS Provider (`/v1/audio/speech` streamed to `aplay`).
 */
export class OpenAITTS implements TextToSpeechProvider {
  public readonly id = 'openai-tts';
  public readonly name = 'OpenAI TTS (tts-1)';

  private activePlayer: ChildProcess | null = null;
  private abortController: AbortController | null = null;

  public isAvailable(): boolean {
    return Boolean(process.env.OPENAI_API_KEY || AuthStorage.getApiKey('openai'));
  }

  private getApiKey(): string | null {
    return process.env.OPENAI_API_KEY || AuthStorage.getApiKey('openai') || null;
  }

  public isSpeaking(): boolean {
    return this.activePlayer !== null || this.abortController !== null;
  }

  public async speak(
    text: string,
    options: { language?: 'es' | 'en'; voice?: string } = {},
  ): Promise<void> {
    const cleaned = text.trim();
    if (!cleaned) return;

    const apiKey = this.getApiKey();
    if (!apiKey) return;

    const voice = options.voice ?? 'alloy';
    const controller = new AbortController();
    this.abortController = controller;

    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: cleaned,
          voice,
          response_format: 'pcm',
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        this.abortController = null;
        return;
      }

      const arrayBuf = await res.arrayBuffer();
      const pcmBuf = Buffer.from(arrayBuf);

      await new Promise<void>((resolve) => {
        try {
          // OpenAI PCM format is 24kHz 16-bit signed LE mono
          const player = spawn('aplay', ['-q', '-f', 'S16_LE', '-r', '24000', '-c', '1', '-t', 'raw'], {
            stdio: ['pipe', 'ignore', 'ignore'],
          });
          this.activePlayer = player;

          player.on('close', () => {
            if (this.activePlayer === player) {
              this.activePlayer = null;
            }
            resolve();
          });

          player.on('error', () => {
            if (this.activePlayer === player) {
              this.activePlayer = null;
            }
            resolve();
          });

          player.stdin?.write(pcmBuf);
          player.stdin?.end();
        } catch {
          this.activePlayer = null;
          resolve();
        }
      });
    } catch {
      // Aborted or network error
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  public stop(): void {
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {
        // ignore
      }
      this.abortController = null;
    }
    if (this.activePlayer) {
      const proc = this.activePlayer;
      this.activePlayer = null;
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }
}
