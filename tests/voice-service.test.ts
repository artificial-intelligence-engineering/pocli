import { describe, it, expect, vi } from 'vitest';
import {
  stripMarkdownForSpeech,
  parseVoiceIntent,
  getSwitchConfirmationText,
  pcmToWav,
  computeRmsVolume,
  VoiceService,
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
  });
});
