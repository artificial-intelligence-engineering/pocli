import { ActorRole } from '../../core/contracts.js';

export type VoiceControlAction =
  | {
      type: 'send_now';
      cleanedText: string;
      triggerPhrase: string;
      originalText: string;
    }
  | {
      type: 'stop_conversation';
      originalText: string;
    }
  | {
      type: 'pause_listening';
      originalText: string;
    }
  | {
      type: 'resume_listening';
      originalText: string;
    }
  | {
      type: 'switch_agent';
      targetRole: ActorRole;
      roleName: string;
      originalText: string;
    }
  | {
      type: 'select_language';
      selectedLanguage: 'es' | 'en';
      originalText: string;
    }
  | {
      type: 'none';
      text: string;
      originalText: string;
    };

export interface VoiceCommandRecognizerOptions {
  language?: 'es' | 'en';
  customSendTriggers?: string[];
}

const DEFAULT_SEND_TRIGGERS = [
  'qué opinas',
  'que opinas',
  'enviar mensaje',
  'envía el mensaje',
  'envia el mensaje',
  'terminar intervención',
  'terminar intervencion',
  'fin de intervención',
  'fin de intervencion',
  'what do you think',
  'send message',
  'end intervention',
];

/**
 * Recognizes explicit voice control commands and end-of-turn trigger phrases
 * (such as "qué opinas", "enviar mensaje", "terminar intervención", "detener conversación").
 */
export class VoiceCommandRecognizer {
  private language: 'es' | 'en';
  private sendTriggers: string[];

  constructor(options: VoiceCommandRecognizerOptions = {}) {
    this.language = options.language ?? 'es';
    this.sendTriggers = [
      ...DEFAULT_SEND_TRIGGERS,
      ...(options.customSendTriggers ?? []),
    ];
  }

  public setLanguage(lang: 'es' | 'en'): void {
    this.language = lang;
  }

  public addSendTriggerPhrase(phrase: string): void {
    const clean = phrase.trim().toLowerCase();
    if (clean && !this.sendTriggers.includes(clean)) {
      this.sendTriggers.push(clean);
    }
  }

  public getSendTriggerPhrases(): string[] {
    return [...this.sendTriggers];
  }

  /**
   * Analyzes accumulated or incoming spoken text for explicit control phrases.
   */
  public analyze(text: string): VoiceControlAction {
    const trimmed = text.trim();
    if (!trimmed) {
      return { type: 'none', text: '', originalText: text };
    }

    const lower = trimmed
      .toLowerCase()
      .replace(/[¿?¡!.,;:]+$/g, '')
      .trim();

    // 1. Stop Conversation commands ("detener conversación", "desactivar voz")
    if (
      /^(?:detener\s+conversaci[oó]n|finalizar\s+conversaci[oó]n|desactivar\s+(?:modo\s+de\s+)?voz|cerrar\s+micr[oó]fono|stop\s+conversation|exit\s+voice\s+mode)$/i.test(
        lower,
      )
    ) {
      return { type: 'stop_conversation', originalText: trimmed };
    }

    // 2. Pause Listening commands ("pausar escucha", "silencio", "mute", "apagar micrófono")
    if (
      /^(?:pausar\s+(?:la\s+)?escucha|pausar\s+conversaci[oó]n|silencio|mute|mutear|silenciar|apaga(?:r)?\s+(?:el\s+)?micr[oó]fono|desactiva(?:r)?\s+(?:el\s+)?micr[oó]fono|stop\s+listening|pause\s+listening|mute\s+mic(?:rophone)?)$/i.test(
        lower,
      )
    ) {
      return { type: 'pause_listening', originalText: trimmed };
    }

    // 3. Resume Listening commands ("reanudar escucha", "activar micrófono", "unmute")
    if (
      /^(?:reanudar\s+(?:la\s+)?escucha|continuar\s+conversaci[oó]n|activar\s+micr[oó]fono|desmutear|unmute|live|activar\s+voz|resume\s+listening)$/i.test(
        lower,
      )
    ) {
      return { type: 'resume_listening', originalText: trimmed };
    }

    // 4. Language selection commands
    const isSpanish =
      /^(?:(?:por\s+favor\s+)?(?:en\s+)?(?:idioma\s+)?español|castellano|spanish|(?:quiero|elijo|prefiero)\s+(?:el\s+)?español|hablar?\s+en\s+español|cambiar?\s+a\s+español|(?:opci[oó]n\s+)?(?:dos|2))$/i.test(
        lower,
      );
    if (isSpanish) {
      return {
        type: 'select_language',
        selectedLanguage: 'es',
        originalText: trimmed,
      };
    }

    const isEnglish =
      /^(?:(?:please\s+)?(?:in\s+)?(?:idioma\s+|language\s+)?english|ingl[eé]s|(?:i\s+want|choose|prefer)\s+english|speak\s+in\s+english|switch\s+to\s+english|(?:option\s+|opci[oó]n\s+)?(?:one|uno|1))$/i.test(
        lower,
      );
    if (isEnglish) {
      return {
        type: 'select_language',
        selectedLanguage: 'en',
        originalText: trimmed,
      };
    }

    // 5. Switch Agent commands
    const prefix =
      '(?:(?:i\\s+want\\s+to|quiero)\\s+(?:talk\\s+to|speak\\s+(?:to|with)|hablar\\s+con)|quiero\\s+con|ponme\\s+con|p[aá]same\\s+con|p[aá]same\\s+al?|p[aá]same|hablar\\s+con|conectar\\s+con|cambia(?:r)?\\s+(?:a|al)?|ir\\s+al?|talk\\s+to|switch\\s+to|connect\\s+to|speak\\s+to|speak\\s+with)\\s+(?:el\\s+|la\\s+|the\\s+)?';

    const matchesRole = (roleRegex: string) =>
      new RegExp(`^(?:(?:con|al|a|el|la|the)\\s+)*${roleRegex}$`, 'i').test(lower) ||
      new RegExp(`${prefix}${roleRegex}`, 'i').test(lower);

    if (matchesRole('(?:arquitecto|architect)')) {
      return {
        type: 'switch_agent',
        targetRole: 'architect',
        roleName: this.language === 'es' ? 'Arquitecto de Software' : 'Software Architect',
        originalText: trimmed,
      };
    }

    if (matchesRole('(?:desarrollador|developer|dev|programador)')) {
      return {
        type: 'switch_agent',
        targetRole: 'developer',
        roleName: this.language === 'es' ? 'Desarrollador Senior' : 'Senior Developer',
        originalText: trimmed,
      };
    }

    if (matchesRole('(?:qa(?:\s+engineer)?|tester|control\\s+de\\s+calidad|ingeniero\\s+de\\s+qa)')) {
      return {
        type: 'switch_agent',
        targetRole: 'qa',
        roleName: this.language === 'es' ? 'Ingeniero de QA' : 'QA Engineer',
        originalText: trimmed,
      };
    }

    if (matchesRole('(?:pm|project\\s+manager|gestor\\s+de\\s+proyecto|jefe\\s+de\\s+proyecto)')) {
      return {
        type: 'switch_agent',
        targetRole: 'pm',
        roleName: 'Project Manager',
        originalText: trimmed,
      };
    }

    // 6. Explicit Send Trigger Phrases at the end of the utterance (e.g., "qué opinas", "enviar mensaje")
    // Check if the user explicitly requested literal text (e.g., "literalmente qué opinas" or quoted)
    const literalEscapeRegex =
      /(?:literalmente|como\s+texto\s+literal|literally)\s+([¿?¡!"']*[\w\sáéíóúñ]+["'?!.]*)$/i;
    if (literalEscapeRegex.test(trimmed)) {
      const unescaped = trimmed.replace(
        /\b(?:literalmente|como\s+texto\s+literal|literally)\s+/i,
        '',
      );
      return { type: 'none', text: unescaped.trim(), originalText: trimmed };
    }

    for (const trigger of this.sendTriggers) {
      const escapedTrigger = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match trigger at the end of the text, optionally preceded by punctuation/spaces and followed by question/exclamation marks
      const endTriggerRegex = new RegExp(
        `^(.*?)(?:[\\s,.;:¿¡]+|^)(${escapedTrigger})[\\s?¿!¡."']*$`,
        'i',
      );
      const match = trimmed.match(endTriggerRegex);
      if (match) {
        const leadingContent = (match[1] ?? '').replace(/[,;:\s]+$/, '').trim();
        return {
          type: 'send_now',
          cleanedText: leadingContent,
          triggerPhrase: match[2],
          originalText: trimmed,
        };
      }
    }

    return { type: 'none', text: trimmed, originalText: trimmed };
  }
}
