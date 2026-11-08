import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface AudioCaptureOptions {
  sampleRate?: number;
  channels?: number;
  device?: string;
}

/**
 * Captures raw 16-bit signed little-endian mono PCM audio from the system microphone
 * using Linux native PipeWire/PulseAudio/ALSA capture (`arecord`).
 */
export class AudioCapture extends EventEmitter {
  private sampleRate: number;
  private channels: number;
  private device?: string;
  private recordProcess: ChildProcess | null = null;
  private isCapturingFlag = false;
  private exitCleanupHandler: () => void;

  constructor(options: AudioCaptureOptions = {}) {
    super();
    this.sampleRate = options.sampleRate ?? 16000;
    this.channels = options.channels ?? 1;
    this.device = options.device;
    this.exitCleanupHandler = () => {
      this.stop();
    };
  }

  public isCapturing(): boolean {
    return this.isCapturingFlag;
  }

  public start(): boolean {
    if (this.isCapturingFlag && this.recordProcess) {
      return true;
    }

    try {
      const args = [
        '-q',
        '-f',
        'S16_LE',
        '-r',
        String(this.sampleRate),
        '-c',
        String(this.channels),
        '-t',
        'raw',
      ];
      if (this.device) {
        args.unshift('-D', this.device);
      }

      this.recordProcess = spawn('arecord', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.isCapturingFlag = true;
      process.on('exit', this.exitCleanupHandler);

      this.recordProcess.stdout?.on('data', (chunk: Buffer) => {
        if (this.isCapturingFlag) {
          this.emit('data', chunk);
        }
      });

      this.recordProcess.on('error', (err) => {
        this.isCapturingFlag = false;
        this.emit('error', err);
      });

      this.recordProcess.on('close', (code) => {
        this.isCapturingFlag = false;
        this.recordProcess = null;
        this.emit('close', code);
      });

      return true;
    } catch (err) {
      this.isCapturingFlag = false;
      this.recordProcess = null;
      this.emit('error', err as Error);
      return false;
    }
  }

  public stop(): void {
    this.isCapturingFlag = false;
    process.off('exit', this.exitCleanupHandler);

    if (this.recordProcess) {
      const proc = this.recordProcess;
      this.recordProcess = null;
      try {
        proc.stdout?.removeAllListeners();
        proc.removeAllListeners();
        proc.kill('SIGTERM');
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

