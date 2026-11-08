import { describe, it, expect, vi } from 'vitest';
import {
  stripMarkdownForSpeech,
  parseVoiceIntent,
  getSwitchConfirmationText,
  pcmToWav,
  computeRmsVolume,
  getAudioHardwareInfo,
  adjustSourceVolume,
  toggleSourceMute,
  VoiceService,
  VoiceStateManager,
  VoiceCommandRecognizer,
  VoiceActivityDetector,
  VoiceController,
  resample16kTo24kPcm16,
} from '../src/runtime/voice-service.js';

describe('VoiceService — Real-time Bidirectional Live Voice System', () => {
  describe('stripMarkdownForSpeech', () => {
    it('removes code blocks and replaces them with clean audio pause', () => {
      const input = 'Aquí está la implementación:\n```python\ndef run():\n    return 42\n```\n¿Deseas probarla?';
      const stripped = stripMarkdownForSpeech(input, 'es');
      expect(stripped).toContain('Aquí está la implementación:');
      expect(stripped).toContain('[Bloque de código omitido].');
      expect(stripped).toContain('¿Deseas probarla?');
      expect(stripped).not.toContain('def run()');
    });

    it('removes markdown tables cleanly', () => {
      const input = 'Resumen de entregables:\n| Artefacto | Versión |\n| --- | --- |\n| CODE-001 | v1 |\nFin del resumen.';
      const stripped = stripMarkdownForSpeech(input, 'es');
      expect(stripped).toContain('Resumen de entregables:');
      expect(stripped).toContain('[Tabla de datos omitida].');
      expect(stripped).not.toContain('| Artefacto |');
    });

    it('strips bold, italics, backticks, and links', () => {
      const input = 'Revisa **este archivo** con `pocli run` y mira [este enlace](https://example.com).';
      const stripped = stripMarkdownForSpeech(input, 'es');
      expect(stripped).toBe('Revisa este archivo con pocli run y mira este enlace.');
    });

    it('supports English omission labels', () => {
      const input = 'Code below:\n```ts\nconst x = 1;\n```\nDone.';
      const stripped = stripMarkdownForSpeech(input, 'en');
      expect(stripped).toContain('[Code block omitted].');
    });
  });

  describe('parseVoiceIntent', () => {
    it('detects switch to Architect in Spanish and English', () => {
      expect(parseVoiceIntent('Quiero hablar con el Arquitecto')).toEqual({
        type: 'switch_agent',
        targetRole: 'architect',
        roleName: 'Arquitecto de Software',
        originalUtterance: 'Quiero hablar con el Arquitecto',
      });

      expect(parseVoiceIntent('pásame al arquitecto')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'architect',
      });

      expect(parseVoiceIntent('I want to talk to the architect', 'developer', 'en')).toEqual({
        type: 'switch_agent',
        targetRole: 'architect',
        roleName: 'Software Architect',
        originalUtterance: 'I want to talk to the architect',
      });

      expect(parseVoiceIntent('quiero con el arquitecto')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'architect',
      });

      expect(parseVoiceIntent('con el arquitecto')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'architect',
      });

      expect(parseVoiceIntent('arquitecto')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'architect',
      });
    });

    it('detects switch to Developer', () => {
      expect(parseVoiceIntent('pásame con el desarrollador')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'developer',
      });

      expect(parseVoiceIntent('switch to developer', 'architect', 'en')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'developer',
      });
    });

    it('detects switch to QA Engineer', () => {
      expect(parseVoiceIntent('quiero hablar con QA')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'qa',
      });

      expect(parseVoiceIntent('pásame a control de calidad')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'qa',
      });

      expect(parseVoiceIntent('talk to qa engineer', 'architect', 'en')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'qa',
      });
    });

    it('detects switch to Project Manager (PM)', () => {
      expect(parseVoiceIntent('quiero hablar con el PM')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'pm',
      });

      expect(parseVoiceIntent('pásame con el project manager')).toMatchObject({
        type: 'switch_agent',
        targetRole: 'pm',
      });
    });

    it('detects language selection commands', () => {
      expect(parseVoiceIntent('Español')).toEqual({
        type: 'select_language',
        selectedLanguage: 'es',
        originalUtterance: 'Español',
      });
      expect(parseVoiceIntent('Spanish')).toMatchObject({
        type: 'select_language',
        selectedLanguage: 'es',
      });
      expect(parseVoiceIntent('2')).toMatchObject({
        type: 'select_language',
        selectedLanguage: 'es',
      });
      expect(parseVoiceIntent('English')).toEqual({
        type: 'select_language',
        selectedLanguage: 'en',
        originalUtterance: 'English',
      });
      expect(parseVoiceIntent('Inglés')).toMatchObject({
        type: 'select_language',
        selectedLanguage: 'en',
      });
      expect(parseVoiceIntent('1')).toMatchObject({
        type: 'select_language',
        selectedLanguage: 'en',
      });
    });

    it('detects mute commands', () => {
      expect(parseVoiceIntent('silencio').type).toBe('mute');
      expect(parseVoiceIntent('mute').type).toBe('mute');
      expect(parseVoiceIntent('apaga el micrófono').type).toBe('mute');
      expect(parseVoiceIntent('stop listening').type).toBe('mute');
    });

    it('detects unmute commands', () => {
      expect(parseVoiceIntent('activar micrófono').type).toBe('unmute');
      expect(parseVoiceIntent('unmute').type).toBe('unmute');
    });

    it('routes general conversation to active agent', () => {
      const intent = parseVoiceIntent(
        'Explícame cómo diseñaste la arquitectura del sistema',
        'architect',
        'es',
      );
      expect(intent).toEqual({
        type: 'agent_message',
        targetRole: 'architect',
        text: 'Explícame cómo diseñaste la arquitectura del sistema',
        originalUtterance: 'Explícame cómo diseñaste la arquitectura del sistema',
      });
    });
  });

  describe('getSwitchConfirmationText', () => {
    it('returns Spanish confirmations', () => {
      expect(getSwitchConfirmationText('architect', 'es')).toBe(
        'El arquitecto está escuchando.',
      );
      expect(getSwitchConfirmationText('developer', 'es')).toBe(
        'El desarrollador está escuchando.',
      );
      expect(getSwitchConfirmationText('qa', 'es')).toBe(
        'El especialista de control de calidad está escuchando.',
      );
      expect(getSwitchConfirmationText('pm', 'es')).toBe(
        'El jefe de proyecto está escuchando.',
      );
    });

    it('returns English confirmations', () => {
      expect(getSwitchConfirmationText('architect', 'en')).toBe(
        'The Software Architect is listening.',
      );
      expect(getSwitchConfirmationText('developer', 'en')).toBe(
        'The Senior Developer is listening.',
      );
    });
  });

  describe('pcmToWav and computeRmsVolume', () => {
    it('generates a valid 44-byte RIFF WAVE header for PCM data', () => {
      const pcm = Buffer.alloc(16000); // 0.5s of mono 16kHz
      const wav = pcmToWav(pcm, 16000, 1, 16);

      expect(wav.length).toBe(16044);
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      expect(wav.subarray(8, 12).toString()).toBe('WAVE');
      expect(wav.subarray(12, 16).toString()).toBe('fmt ');
      expect(wav.readUInt32LE(24)).toBe(16000); // Sample rate
      expect(wav.readUInt16LE(22)).toBe(1); // Channels
      expect(wav.subarray(36, 40).toString()).toBe('data');
      expect(wav.readUInt32LE(40)).toBe(16000); // Data length
    });

    it('computes 0 RMS for silent PCM and positive RMS for signal', () => {
      const silence = Buffer.alloc(100);
      expect(computeRmsVolume(silence)).toBe(0);

      const signal = Buffer.alloc(100);
      for (let i = 0; i < signal.length; i += 2) {
        signal.writeInt16LE(1000, i);
      }
      expect(computeRmsVolume(signal)).toBeCloseTo(1000);
    });
  });

  describe('VoiceService Lifecycle & Simulation', () => {
    it('initializes in idle state', () => {
      const service = new VoiceService({ language: 'es' });
      expect(service.getState()).toBe('idle');
      expect(service.isLive()).toBe(false);
      expect(service.isMuted()).toBe(false);
    });

    it('transitions to listening, muted, and idle', async () => {
      const service = new VoiceService({ language: 'es' });
      const stateSpy = vi.fn();
      service.on('state_change', stateSpy);

      await service.startLive();
      expect(service.isLive()).toBe(true);

      service.mute();
      expect(service.isMuted()).toBe(true);
      expect(service.isLive()).toBe(false);

      service.unmute();
      expect(service.getState()).toBe('listening');

      service.stopLive();
      expect(service.getState()).toBe('idle');
    });

    it('simulates spoken utterances and emits transcription events', async () => {
      const service = new VoiceService({ language: 'es' });
      const transcriptionSpy = vi.fn();
      service.on('transcription', transcriptionSpy);

      const res = await service.simulateUtterance('Quiero hablar con el Arquitecto');
      expect(res.intent.type).toBe('switch_agent');
      expect(res.intent.targetRole).toBe('architect');
      expect(transcriptionSpy).toHaveBeenCalledWith({
        text: 'Quiero hablar con el Arquitecto',
        intent: res.intent,
      });
    });

    it('supports diagnostic monitoring mode without changing live state', () => {
      const service = new VoiceService({ language: 'es' });
      service.startMonitoring();
      expect(service.getState()).toBe('idle');
      expect(service.isLive()).toBe(false);

      service.stopMonitoring();
      expect(service.getState()).toBe('idle');
    });
  });

  describe('Audio Hardware Diagnostics & Mixer (/check)', () => {
    it('retrieves audio hardware information', () => {
      const info = getAudioHardwareInfo();
      expect(info).toHaveProperty('defaultSource');
      expect(info).toHaveProperty('defaultSink');
      expect(info).toHaveProperty('sourceVolumePercent');
      expect(info).toHaveProperty('sinkVolumePercent');
      expect(info.ttsEngine).toContain('spd-say');
      expect(typeof info.sourceMuted).toBe('boolean');
      expect(typeof info.sinkMuted).toBe('boolean');
    });

    it('adjusts volume and toggles mute safely', () => {
      const adjusted = adjustSourceVolume(0);
      expect(adjusted).toHaveProperty('sourceVolumePercent');

      const toggled = toggleSourceMute();
      expect(typeof toggled.sourceMuted).toBe('boolean');
      // Toggle back to original state
      const restored = toggleSourceMute();
      expect(typeof restored.sourceMuted).toBe('boolean');
    });

    it('detects native STT provider correctly', () => {
      const service = new VoiceService({ language: 'es' });
      expect(typeof service.hasConfiguredSttProvider()).toBe('boolean');
      const name = service.getConfiguredSttProviderName();
      if (name) {
        expect(typeof name).toBe('string');
      }
    });
  });

  describe('Hands-Free Modular Architecture (VoiceStateManager, VoiceCommandRecognizer, VAD, VoiceController)', () => {
    it('manages the IDLE -> LISTENING -> PROCESSING -> SPEAKING -> LISTENING state machine', () => {
      const sm = new VoiceStateManager('IDLE');
      const transitions: string[] = [];
      sm.on('transition', (evt) => transitions.push(`${evt.from}->${evt.to}`));

      expect(sm.getState()).toBe('IDLE');
      expect(sm.isActiveConversation()).toBe(false);

      sm.transitionTo('LISTENING', 'ctrl_space');
      expect(sm.getState()).toBe('LISTENING');
      expect(sm.getLegacyState()).toBe('listening');
      expect(sm.isListening()).toBe(true);
      expect(sm.isActiveConversation()).toBe(true);

      sm.transitionTo('PROCESSING', 'end_of_speech');
      expect(sm.getState()).toBe('PROCESSING');
      expect(sm.getLegacyState()).toBe('transcribing');
      expect(sm.isProcessing()).toBe(true);

      sm.transitionTo('SPEAKING', 'agent_reply');
      expect(sm.getState()).toBe('SPEAKING');
      expect(sm.getLegacyState()).toBe('speaking');
      expect(sm.isSpeaking()).toBe(true);

      sm.transitionTo('LISTENING', 'tts_complete');
      expect(sm.getState()).toBe('LISTENING');

      sm.transitionTo('PAUSED', 'user_pause');
      expect(sm.getState()).toBe('PAUSED');
      expect(sm.getLegacyState()).toBe('muted');
      expect(sm.isPaused()).toBe(true);

      expect(transitions).toEqual([
        'IDLE->LISTENING',
        'LISTENING->PROCESSING',
        'PROCESSING->SPEAKING',
        'SPEAKING->LISTENING',
        'LISTENING->PAUSED',
      ]);
    });

    it('recognizes explicit send trigger phrases ("qué opinas", "enviar mensaje", "terminar intervención") and strips them', () => {
      const recognizer = new VoiceCommandRecognizer({ language: 'es' });

      const r1 = recognizer.analyze(
        'Deberíamos desacoplar el servicio de inventario mediante eventos, ¿qué opinas?',
      );
      expect(r1).toEqual({
        type: 'send_now',
        cleanedText: 'Deberíamos desacoplar el servicio de inventario mediante eventos',
        triggerPhrase: 'qué opinas',
        originalText:
          'Deberíamos desacoplar el servicio de inventario mediante eventos, ¿qué opinas?',
      });

      const r2 = recognizer.analyze('Revisa los tests unitarios de la pasarela enviar mensaje');
      expect(r2).toEqual({
        type: 'send_now',
        cleanedText: 'Revisa los tests unitarios de la pasarela',
        triggerPhrase: 'enviar mensaje',
        originalText: 'Revisa los tests unitarios de la pasarela enviar mensaje',
      });

      const r3 = recognizer.analyze('Propongo usar PostgreSQL con PostGIS terminar intervención.');
      expect(r3).toEqual({
        type: 'send_now',
        cleanedText: 'Propongo usar PostgreSQL con PostGIS',
        triggerPhrase: 'terminar intervención',
        originalText: 'Propongo usar PostgreSQL con PostGIS terminar intervención.',
      });
    });

    it('preserves trigger phrase when escaped with "literalmente"', () => {
      const recognizer = new VoiceCommandRecognizer({ language: 'es' });
      const res = recognizer.analyze('El cliente me preguntó literalmente qué opinas');
      expect(res.type).toBe('none');
      if (res.type === 'none') {
        expect(res.text).toBe('El cliente me preguntó qué opinas');
      }
    });

    it('supports adding custom trigger phrases and control commands ("detener conversación", "pausar escucha")', () => {
      const recognizer = new VoiceCommandRecognizer({ language: 'es' });
      expect(recognizer.analyze('detener conversación').type).toBe('stop_conversation');
      expect(recognizer.analyze('pausar escucha').type).toBe('pause_listening');
      expect(recognizer.analyze('reanudar escucha').type).toBe('resume_listening');

      recognizer.addSendTriggerPhrase('adelante compañero');
      const custom = recognizer.analyze('Analiza este módulo por favor adelante compañero');
      expect(custom).toMatchObject({
        type: 'send_now',
        cleanedText: 'Analiza este módulo por favor',
        triggerPhrase: 'adelante compañero',
      });
    });

    it('integrates trigger phrase stripping directly into parseVoiceIntent', () => {
      const intent = parseVoiceIntent(
        'Necesitamos validar la latencia del bus de eventos, qué opinas',
        'architect',
        'es',
      );
      expect(intent).toEqual({
        type: 'agent_message',
        targetRole: 'architect',
        text: 'Necesitamos validar la latencia del bus de eventos',
        triggerPhrase: 'qué opinas',
        originalUtterance: 'Necesitamos validar la latencia del bus de eventos, qué opinas',
      });
    });

    it('detects end_of_speech after configurable silence and barge_in during agent speech in VoiceActivityDetector', () => {
      const vad = new VoiceActivityDetector({
        rmsThreshold: 400,
        silenceDurationMs: 1200,
        bargeInRequiredFrames: 3,
      });

      const speechEvents: string[] = [];
      vad.on('speech_start', () => speechEvents.push('speech_start'));
      vad.on('end_of_speech', () => speechEvents.push('end_of_speech'));
      vad.on('barge_in', () => speechEvents.push('barge_in'));

      // Speak at t=1000..1500
      vad.processChunk(2000, false, 1000);
      vad.processChunk(2200, false, 1300);
      expect(speechEvents).toContain('speech_start');

      // Brief thinking pause (500ms < 1200ms) does NOT trigger end_of_speech
      vad.processChunk(100, false, 1800);
      expect(speechEvents).not.toContain('end_of_speech');

      // Silence reaches 1300ms (>= 1200ms) -> triggers end_of_speech
      vad.processChunk(100, false, 2650);
      expect(speechEvents).toContain('end_of_speech');

      // Test barge-in while agent is speaking (isAgentSpeaking = true)
      vad.processChunk(3500, true, 5000);
      vad.processChunk(3500, true, 5200);
      expect(speechEvents).not.toContain('barge_in');
      vad.processChunk(3500, true, 5400);
      expect(speechEvents).toContain('barge_in');
    });

    it('accumulates streaming partial and final transcripts progressively without duplicates and dispatches on "qué opinas"', () => {
      const controller = new VoiceController({
        language: 'es',
        silenceDurationMs: 1500,
      });
      controller.stateManager.transitionTo('LISTENING', 'test');

      const drafts: string[] = [];
      const readyTurns: Array<{ text: string; triggerPhrase?: string; reason: string }> = [];

      controller.on('draft_update', (d) => drafts.push(d.fullText));
      controller.on('turn_ready', (t) => readyTurns.push(t));

      controller.handlePartialTranscript('vamos a revisar');
      controller.handlePartialTranscript('vamos a revisar el diseño');
      controller.handleFinalTranscript('vamos a revisar el diseño de microservicios');
      // Duplicate final segment is ignored
      controller.handleFinalTranscript('vamos a revisar el diseño de microservicios');

      expect(controller.getAccumulatedText()).toBe(
        'vamos a revisar el diseño de microservicios',
      );

      // Now user says "qué opinas"
      controller.handleFinalTranscript('qué opinas');

      expect(readyTurns).toHaveLength(1);
      expect(readyTurns[0]).toEqual({
        text: 'vamos a revisar el diseño de microservicios',
        triggerPhrase: 'qué opinas',
        reason: 'trigger_phrase',
      });
      expect(controller.getTurnState()).toBe('PROCESSING');
      expect(controller.getAccumulatedText()).toBe('');
    });

    it('resamples 16kHz 16-bit PCM to 24kHz 16-bit PCM for OpenAI Realtime API', () => {
      const pcm16k = Buffer.alloc(320); // 160 samples at 16kHz (10ms)
      for (let i = 0; i < 160; i++) {
        pcm16k.writeInt16LE(i * 10, i * 2);
      }
      const pcm24k = resample16kTo24kPcm16(pcm16k);
      // 160 * 1.5 = 240 samples -> 480 bytes
      expect(pcm24k.length).toBe(480);
    });
  });
});

