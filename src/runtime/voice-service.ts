import { spawn, spawnSync, execSync, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActorRole } from '../core/contracts.js';
import { AuthStorage } from '../core/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking' | 'muted';

export interface AudioHardwareInfo {
  defaultSource: string;
  defaultSink: string;
  sourceVolumePercent: number;
  sourceVolumeDb: string;
  sinkVolumePercent: number;
  sinkVolumeDb: string;
  sourceMuted: boolean;
  sinkMuted: boolean;
  ttsEngine: string;
  sttEngine: string;
  captureMode: string;
}

export function findNativePythonBinary(): string | null {
  const candidates = [
    process.env.POCLI_PYTHON_BIN,
    process.env.PYTHON_BIN,
    path.join(os.homedir(), 'miniconda3', 'bin', 'python'),
    path.join(os.homedir(), 'anaconda3', 'bin', 'python'),
    path.join(os.homedir(), '.conda', 'bin', 'python'),
    'python3',
    'python',
    '/usr/bin/python3',
  ].filter(Boolean) as string[];

  for (const py of candidates) {
    try {
      const res = spawnSync(py, ['-c', 'import vosk; print("ok")'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      if (res.status === 0 && res.stdout.includes('ok')) {
        return py;
      }
    } catch {
      // try next candidate
    }
  }

  for (const py of ['python3', '/usr/bin/python3', path.join(os.homedir(), 'miniconda3', 'bin', 'python')]) {
    try {
      const res = spawnSync(py, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      if (res.status === 0) return py;
    } catch {
      // try next candidate
    }
  }

  return null;
}

export function getNativeSttScriptPath(): string {
  const candidates = [
    path.join(__dirname, 'native-stt.py'),
    path.resolve(process.cwd(), 'src', 'runtime', 'native-stt.py'),
    path.resolve(process.cwd(), 'dist', 'runtime', 'native-stt.py'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export function detectNativeSttEngine(): string | null {
  const py = findNativePythonBinary();
  if (py) {
    try {
      const res = spawnSync(py, ['-c', 'import vosk; print("ok")'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      if (res.status === 0 && res.stdout.includes('ok')) {
        return 'Vosk (Kaldi Local STT · 0 Tokens)';
      }
    } catch {
      // ignore
    }
  }

  try {
    const whisperRes = spawnSync('which', ['whisper-cli'], { encoding: 'utf8' });
    if (whisperRes.status === 0 && whisperRes.stdout.trim()) {
      return 'whisper-cli (Local Native C++ · 0 Tokens)';
    }
  } catch {
    // ignore
  }

  try {
    const psRes = spawnSync('which', ['pocketsphinx'], { encoding: 'utf8' });
    if (psRes.status === 0 && psRes.stdout.trim()) {
      return 'PocketSphinx (Local Native · 0 Tokens)';
    }
  } catch {
    // ignore
  }

  return null;
}

export function getConfiguredSttProviderName(): string | null {
  const nativeEngine = detectNativeSttEngine();
  if (nativeEngine) return nativeEngine;
  if (AuthStorage.getApiKey('groq')) return 'Groq (Whisper-v3-turbo · Fallback)';
  if (AuthStorage.getApiKey('openai')) return 'OpenAI (Whisper-1 · Fallback)';
  if (AuthStorage.getApiKey('gemini')) return 'Google Gemini (Multimodal · Fallback)';
  return null;
}

export function getAudioHardwareInfo(): AudioHardwareInfo {
  let defaultSource = 'Default ALSA/PulseAudio input';
  let defaultSink = 'Default ALSA/PulseAudio output';
  let sourceVolumePercent = 100;
  let sourceVolumeDb = '0.00 dB';
  let sinkVolumePercent = 80;
  let sinkVolumeDb = '-4.00 dB';
  let sourceMuted = false;
  let sinkMuted = false;

  try {
    const rawSource = execSync('pactl get-default-source', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (rawSource) defaultSource = rawSource;
  } catch {
    // fallback
  }

  try {
    const rawSink = execSync('pactl get-default-sink', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (rawSink) defaultSink = rawSink;
  } catch {
    // fallback
  }

  try {
    const rawSrcVol = execSync('pactl get-source-volume @DEFAULT_SOURCE@', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = rawSrcVol.match(/(\d+)%\s*\/\s*(-?[\d.]+\s*dB)/);
    if (match) {
      sourceVolumePercent = parseInt(match[1], 10);
      sourceVolumeDb = match[2];
    }
  } catch {
    // fallback
  }

  try {
    const rawSinkVol = execSync('pactl get-sink-volume @DEFAULT_SINK@', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = rawSinkVol.match(/(\d+)%\s*\/\s*(-?[\d.]+\s*dB)/);
    if (match) {
      sinkVolumePercent = parseInt(match[1], 10);
      sinkVolumeDb = match[2];
    }
  } catch {
    // fallback
  }

  try {
    const rawSrcMute = execSync('pactl get-source-mute @DEFAULT_SOURCE@', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    sourceMuted = /Mute:\s*yes/i.test(rawSrcMute);
  } catch {
    // fallback
  }

  try {
    const rawSinkMute = execSync('pactl get-sink-mute @DEFAULT_SINK@', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    sinkMuted = /Mute:\s*yes/i.test(rawSinkMute);
  } catch {
    // fallback
  }

  return {
    defaultSource,
    defaultSink,
    sourceVolumePercent,
    sourceVolumeDb,
    sinkVolumePercent,
    sinkVolumeDb,
    sourceMuted,
    sinkMuted,
    ttsEngine: 'speech-dispatcher (spd-say)',
    sttEngine: getConfiguredSttProviderName() || 'Not Configured (Requires Groq, Gemini, or OpenAI)',
    captureMode: 'arecord 16000Hz mono S16_LE (PipeWire/ALSA)',
  };
}

export function adjustSourceVolume(deltaPercent: number): AudioHardwareInfo {
  try {
    const sign = deltaPercent >= 0 ? '+' : '';
    execSync(`pactl set-source-volume @DEFAULT_SOURCE@ ${sign}${deltaPercent}%`, {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // ignore
  }
  return getAudioHardwareInfo();
}

export function toggleSourceMute(): AudioHardwareInfo {
  try {
    execSync('pactl set-source-mute @DEFAULT_SOURCE@ toggle', {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // ignore
  }
  return getAudioHardwareInfo();
}

export type VoiceIntentType =
  | 'select_language'
  | 'switch_agent'
  | 'mute'
  | 'unmute'
  | 'agent_message';

export interface VoiceIntent {
  type: VoiceIntentType;
  targetRole?: ActorRole;
  roleName?: string;
  selectedLanguage?: 'es' | 'en';
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

  // 3. Language selection intent (e.g. "español", "spanish", "english", "inglés", "1", "2")
  const isSpanish =
    /^(?:(?:por\s+favor\s+)?(?:en\s+)?(?:idioma\s+)?español|castellano|spanish|(?:quiero|elijo|prefiero)\s+(?:el\s+)?español|hablar?\s+en\s+español|cambiar?\s+a\s+español|(?:opci[oó]n\s+)?(?:dos|2))$/i.test(
      lower,
    );
  const isEnglish =
    /^(?:(?:please\s+)?(?:in\s+)?(?:idioma\s+|language\s+)?english|ingl[eé]s|(?:i\s+want|choose|prefer)\s+english|speak\s+in\s+english|switch\s+to\s+english|(?:option\s+|opci[oó]n\s+)?(?:one|uno|1))$/i.test(
      lower,
    );

  if (isSpanish) {
    return {
      type: 'select_language',
      selectedLanguage: 'es',
      originalUtterance: trimmed,
    };
  }

  if (isEnglish) {
    return {
      type: 'select_language',
      selectedLanguage: 'en',
      originalUtterance: trimmed,
    };
  }

  // 4. Switch Agent Intents
  const prefix =
    '(?:quiero\\s+(?:hablar\\s+)?con|ponme\\s+con|p[aá]same\\s+con|p[aá]same\\s+al?|p[aá]same|hablar\\s+con|conectar\\s+con|cambia(?:r)?\\s+(?:a|al)?|ir\\s+al?|talk\\s+to|switch\\s+to|connect\\s+to|speak\\s+to|speak\\s+with)\\s+(?:el\\s+|la\\s+|the\\s+)?';

  const matchesRole = (roleRegex: string) =>
    new RegExp(`^(?:(?:con|al|a|el|la|the)\\s+)*${roleRegex}$`, 'i').test(lower) ||
    new RegExp(`${prefix}${roleRegex}`, 'i').test(lower);

  // 4a. Architect
  if (matchesRole('(?:arquitecto|architect)')) {
    return {
      type: 'switch_agent',
      targetRole: 'architect',
      roleName: language === 'es' ? 'Arquitecto de Software' : 'Software Architect',
      originalUtterance: trimmed,
    };
  }

  // 4b. Developer
  if (matchesRole('(?:desarrollador|developer|dev|programador)')) {
    return {
      type: 'switch_agent',
      targetRole: 'developer',
      roleName: language === 'es' ? 'Desarrollador Senior' : 'Senior Developer',
      originalUtterance: trimmed,
    };
  }

  // 4c. QA Engineer
  if (matchesRole('(?:qa|tester|control\\s+de\\s+calidad|ingeniero\\s+de\\s+qa)')) {
    return {
      type: 'switch_agent',
      targetRole: 'qa',
      roleName: language === 'es' ? 'Ingeniero de QA' : 'QA Engineer',
      originalUtterance: trimmed,
    };
  }

  // 4d. Project Manager (PM)
  if (matchesRole('(?:pm|project\\s+manager|gestor\\s+de\\s+proyecto|jefe\\s+de\\s+proyecto)')) {
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
  private isMonitoringOnly = false;
  private speechChunks: Buffer[] = [];
  private hasSpoken = false;
  private lastSoundTimestamp = 0;
  private noiseFloor = 300;
  private utteranceStartTime = 0;
  private maxUtteranceMs = 6000;
  private silenceCheckTimer: NodeJS.Timeout | null = null;
  private activeTtsProcess: ChildProcess | null = null;

  constructor(options: VoiceServiceOptions = {}) {
    super();
    this.language = options.language ?? 'es';
    this.vadSilenceMs = options.vadSilenceMs ?? 900;
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

  public hasConfiguredSttProvider(): boolean {
    return Boolean(
      detectNativeSttEngine() ||
      AuthStorage.getApiKey('groq') ||
      AuthStorage.getApiKey('openai') ||
      AuthStorage.getApiKey('gemini'),
    );
  }

  public getConfiguredSttProviderName(): string | null {
    return getConfiguredSttProviderName();
  }

  private setState(next: VoiceState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state_change', next);
  }

  /**
   * Starts microphone capture in diagnostic monitoring mode (emits audio_level without turning on full agent live turns).
   */
  public startMonitoring(): void {
    if (!this.isCapturing) {
      this.isMonitoringOnly = true;
      this.startMicrophoneCapture();
    }
  }

  /**
   * Stops diagnostic monitoring capture if live mode is not active.
   */
  public stopMonitoring(): void {
    if (this.isMonitoringOnly) {
      this.isMonitoringOnly = false;
      if (this.state === 'idle') {
        this.stopMicrophoneCapture();
      }
    }
  }

  /**
   * Activates live listening mode.
   */
  public async startLive(): Promise<void> {
    this.isMonitoringOnly = false;
    if (this.isLive()) return;
    this.setState('listening');
    this.startMicrophoneCapture();
  }

  /**
   * Mutes live voice mode.
   */
  public mute(): void {
    this.isMonitoringOnly = false;
    this.cancelSpeechOutput();
    this.stopMicrophoneCapture();
    this.setState('muted');
  }

  /**
   * Unmutes and restores live listening mode.
   */
  public unmute(): void {
    this.isMonitoringOnly = false;
    if (this.state === 'muted') {
      this.setState('listening');
      this.startMicrophoneCapture();
    }
  }

  /**
   * Deactivates live voice completely.
   */
  public stopLive(): void {
    this.isMonitoringOnly = false;
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
        const rms = computeRmsVolume(chunk);
        const db = rms > 0 ? Math.max(-60, Math.round(20 * Math.log10(rms / 32768))) : -60;

        // Dynamic Speech Detection Threshold based on background noise floor
        const dynamicThreshold = Math.max(this.vadRmsThreshold, this.noiseFloor * 1.5 + 400);
        const isSpeech = rms >= dynamicThreshold;

        // Emit real-time audio levels for the /check mixer VU-meter
        this.emit('audio_level', {
          rms,
          db,
          isSpeech,
          noiseFloor: this.noiseFloor,
          dynamicThreshold,
          isSpeaking: this.state === 'speaking',
          state: this.state,
        });

        if (!this.isCapturing || this.state === 'speaking' || this.state === 'transcribing') {
          return;
        }

        if (this.isMonitoringOnly && this.state === 'idle') {
          return;
        }

        const now = Date.now();

        if (isSpeech) {
          if (!this.hasSpoken) {
            this.hasSpoken = true;
            this.utteranceStartTime = now;
            this.emit('utterance_start');
          }
          this.lastSoundTimestamp = now;
          this.speechChunks.push(chunk);

          // Hard safety limit: force utterance complete if speaking continuously for > maxUtteranceMs
          if (now - this.utteranceStartTime >= this.maxUtteranceMs) {
            this.handleUtteranceComplete();
          }
        } else if (this.hasSpoken) {
          // Keep trailing silence chunks up to vadSilenceMs for smooth utterance boundaries
          this.speechChunks.push(chunk);
          if (now - this.lastSoundTimestamp >= this.vadSilenceMs) {
            // Voice Activity Detection triggered end-of-utterance
            this.handleUtteranceComplete();
          }
        } else {
          // Adapt noise floor slowly during silence
          this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
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
      if (!this.hasConfiguredSttProvider()) {
        const errorMsg =
          this.language === 'es'
            ? '⚠ Falta motor de reconocimiento de voz nativo (Vosk o whisper-cli).'
            : '⚠ Missing native speech recognition engine (Vosk or whisper-cli).';
        this.emit('error', new Error(errorMsg));
        return;
      }

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
   * Transcribes WAV audio buffer using native OS STT (Vosk/Kaldi, whisper-cli, PocketSphinx - 0 tokens),
   * with secondary cloud API fallback if native tool is unavailable.
   */
  public async transcribeAudio(wavBuffer: Buffer): Promise<string> {
    // 1. Primary: Native OS Speech-to-Text (0 LLM Tokens, 100% Offline)
    try {
      const nativeText = await this.transcribeViaNativeOs(wavBuffer);
      if (nativeText && nativeText.trim()) {
        return nativeText.trim();
      }
    } catch {
      // Continue to cloud fallback
    }

    const groqKey = AuthStorage.getApiKey('groq');
    const openaiKey = AuthStorage.getApiKey('openai');
    const geminiKey = AuthStorage.getApiKey('gemini');

    // 2. Secondary Fallback: Groq Whisper
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
   * Transcribes audio using native OS tools (Vosk / Kaldi, whisper-cli, PocketSphinx)
   * without consuming any LLM or cloud API tokens.
   */
  private async transcribeViaNativeOs(wavBuffer: Buffer): Promise<string | null> {
    const py = findNativePythonBinary();
    if (!py) return null;

    const tmpWav = path.join(
      os.tmpdir(),
      `pocli-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
    );

    try {
      fs.writeFileSync(tmpWav, wavBuffer);
      const scriptPath = getNativeSttScriptPath();
      const res = spawnSync(py, [scriptPath, this.language, tmpWav], {
        encoding: 'utf8',
        timeout: 10000,
      });

      if (res.status === 0 && res.stdout.trim()) {
        try {
          const json = JSON.parse(res.stdout.trim()) as { text?: string; error?: string };
          if (json.text) {
            return json.text.trim();
          }
        } catch {
          // not json output
        }
      }
    } catch {
      // ignore native error
    } finally {
      try {
        if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
      } catch {
        // ignore error
      }
    }
    return null;
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
