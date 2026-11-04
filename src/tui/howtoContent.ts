import { SupportedLanguage } from '../core/i18n.js';

export interface HowtoBullet {
  command?: string;
  text: string;
}

export interface HowtoSection {
  badge: string;
  badgeColor: string;
  title: string;
  titleColor: string;
  paragraphs?: string[];
  bullets?: HowtoBullet[];
}

export interface HowtoRenderLine {
  text: string;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
  prefix?: string;
  prefixColor?: string;
  prefixBold?: boolean;
}

/**
 * Returns structured sections for the PO CLI /howto workflow guide.
 */
export function getHowtoSections(lang: SupportedLanguage): HowtoSection[] {
  if (lang === 'es') {
    return [
      {
        badge: '[PO]',
        badgeColor: 'magenta',
        title: 'TÚ ERES EL PRODUCT OWNER',
        titleColor: 'cyan',
        paragraphs: [
          'En POCLI la IA nunca toma decisiones unilaterales. Tú diriges un equipo de profesionales virtuales (Arquitecto, Desarrollador, QA y PM). Tú defines la visión, apruebas la arquitectura, supervisas el código y das el visto bueno final.',
        ],
      },
      {
        badge: '[1]',
        badgeColor: 'green',
        title: 'PASO 1: CREAR O ELEGIR PROYECTO (/project | /projects)',
        titleColor: 'green',
        bullets: [
          {
            command: '/project',
            text: 'Inicia el asistente para crear un proyecto vinculado a una carpeta de tu disco (o usa /project <nombre> <ruta>).',
          },
          {
            command: '/projects',
            text: 'Lista los proyectos existentes, cambia de proyecto activo o elimina/archiva los que no uses.',
          },
        ],
      },
      {
        badge: '[2]',
        badgeColor: 'cyan',
        title: 'PASO 2: DISEÑO CON EL ARQUITECTO (/architect & /propose)',
        titleColor: 'cyan',
        bullets: [
          {
            command: '/architect',
            text: 'Cambia al Software Architect y conversa sobre tu idea, objetivos y requisitos.',
          },
          {
            command: '/propose',
            text: 'Solicita una propuesta técnica formal. El Arquitecto redactará la arquitectura (ARCH-001) y especificaciones (SPEC) para tu revisión.',
          },
        ],
      },
      {
        badge: '[3]',
        badgeColor: 'yellow',
        title: 'PASO 3: APROBAR O RECHAZAR (/approve | /reject)',
        titleColor: 'yellow',
        paragraphs: [
          'Como Product Owner, tienes autoridad absoluta: el Senior Developer tiene estrictamente prohibido tocar código sin una arquitectura aprobada.',
        ],
        bullets: [
          {
            command: '/approve',
            text: 'Aprueba formalmente la propuesta si estás conforme con la arquitectura y especificaciones.',
          },
          {
            command: '/reject',
            text: 'Rechaza la propuesta y solicita ajustes si detectas deficiencias o deseas otro enfoque.',
          },
        ],
      },
      {
        badge: '[4]',
        badgeColor: 'blue',
        title: 'PASO 4: TRANSFERIR E IMPLEMENTAR (/handoff & /implement)',
        titleColor: 'blue',
        bullets: [
          {
            command: '/handoff',
            text: 'Entrega el paquete normativo aprobado al Senior Developer.',
          },
          {
            command: '/implement',
            text: 'Ordena la implementación. El Developer generará y modificará el código en tu directorio de trabajo.',
          },
          {
            command: '/consult',
            text: 'Si el Developer encuentra dudas técnicas, consultará formalmente al Arquitecto en vez de improvisar.',
          },
        ],
      },
      {
        badge: '[5]',
        badgeColor: 'red',
        title: 'PASO 5: VALIDACIÓN INDEPENDIENTE DE CALIDAD (/qa & /validate)',
        titleColor: 'red',
        paragraphs: [
          'Principio de "No Auto-Revisión": el QA Engineer trabaja de forma independiente al Developer y ejecuta comprobaciones empíricas reales.',
        ],
        bullets: [
          {
            command: '/validate',
            text: 'QA ejecuta las suites de pruebas y verifica criterios de aceptación.',
          },
          {
            text: 'Si detecta defectos (DEF-*), los devuelve al Developer para corrección. Cuando todo es conforme, emite veredicto ACCEPT (QA-*).',
          },
        ],
      },
      {
        badge: '[6]',
        badgeColor: 'green',
        title: 'PASO 6: ACEPTACIÓN FINAL (/accept)',
        titleColor: 'green',
        paragraphs: [
          'Revisa el código entregado y el informe de QA. Como Product Owner, ejecuta /accept para cerrar formalmente el ciclo y registrar la entrega.',
        ],
      },
      {
        badge: '[PM]',
        badgeColor: 'magenta',
        title: 'SUPERVISIÓN CONTINUA CON EL PROJECT MANAGER (/pm)',
        titleColor: 'magenta',
        paragraphs: [
          'En cualquier momento puedes consultar al PM. Realiza consultas simultáneas o encadenadas a Arquitecto, Dev y QA para darte un resumen consolidado de avance, métricas y bloqueos.',
        ],
      },
      {
        badge: '[★]',
        badgeColor: 'yellow',
        title: 'ATAJOS DE TECLADO Y HERRAMIENTAS ESENCIALES',
        titleColor: 'yellow',
        bullets: [
          {
            command: 'Tab / Ctrl+Tab',
            text: 'Alternar entre la Vista de Chat limpia y el Centro de Control Multipanel.',
          },
          {
            command: 'Ctrl+N / Shift+Tab',
            text: 'Rotar rápidamente el especialista activo (PM → Arquitecto → Developer → QA).',
          },
          {
            command: '/',
            text: 'Abrir menú interactivo con todos los comandos slash y autocompletado.',
          },
          {
            command: '/models',
            text: 'Configurar modelos LLM independientes para cada especialista (Gemini, Claude, GPT, Ollama...).',
          },
          {
            command: '/settings',
            text: 'Cambiar idioma (Español/English), tema de color o directorio de trabajo.',
          },
          {
            command: '/system',
            text: 'Inspeccionar los system prompts y directivas de comportamiento de los agentes.',
          },
          {
            command: '/db',
            text: 'Consultar directamente la base de datos relacional SQLite de PoCLI.',
          },
          {
            command: '/help',
            text: 'Referencia rápida de todos los comandos disponibles.',
          },
        ],
      },
    ];
  }

  // English fallback
  return [
    {
      badge: '[PO]',
      badgeColor: 'magenta',
      title: 'YOU ARE THE PRODUCT OWNER',
      titleColor: 'cyan',
      paragraphs: [
        'In POCLI, AI never makes unilateral decisions. As the Product Owner, you direct a team of virtual specialists (Architect, Developer, QA, and PM). You set the product vision, approve architecture, supervise code, and grant final acceptance.',
      ],
    },
    {
      badge: '[1]',
      badgeColor: 'green',
      title: 'STEP 1: CREATE OR SELECT PROJECT (/project | /projects)',
      titleColor: 'green',
      bullets: [
        {
          command: '/project',
          text: 'Launch interactive wizard to link a workspace folder on disk (or /project <name> <dir>).',
        },
        {
          command: '/projects',
          text: 'List existing projects, switch the active project, or archive/delete unused ones.',
        },
      ],
    },
    {
      badge: '[2]',
      badgeColor: 'cyan',
      title: 'STEP 2: ARCHITECTURE DESIGN (/architect & /propose)',
      titleColor: 'cyan',
      bullets: [
        {
          command: '/architect',
          text: 'Converse with the Software Architect about goals, constraints, and requirements.',
        },
        {
          command: '/propose',
          text: 'Request a formal technical proposal. The Architect writes the reference architecture (ARCH-001) and specifications (SPEC) for your review.',
        },
      ],
    },
    {
      badge: '[3]',
      badgeColor: 'yellow',
      title: 'STEP 3: APPROVE OR REJECT (/approve | /reject)',
      titleColor: 'yellow',
      paragraphs: [
        'As Product Owner, you have ultimate authority: the Senior Developer is strictly blocked from writing code without approved architecture.',
      ],
      bullets: [
        {
          command: '/approve',
          text: 'Formally approve the proposal if you agree with the design and specifications.',
        },
        {
          command: '/reject',
          text: 'Reject the proposal and request adjustments if you want changes or a different approach.',
        },
      ],
    },
    {
      badge: '[4]',
      badgeColor: 'blue',
      title: 'STEP 4: HANDOFF & IMPLEMENTATION (/handoff & /implement)',
      titleColor: 'blue',
      bullets: [
        {
          command: '/handoff',
          text: 'Transfer the approved normative bundle to the Senior Developer.',
        },
        {
          command: '/implement',
          text: 'Instruct the Developer to implement the code in your workspace directory.',
        },
        {
          command: '/consult',
          text: 'If the Developer encounters ambiguities, they formally consult the Architect instead of guessing.',
        },
      ],
    },
    {
      badge: '[5]',
      badgeColor: 'red',
      title: 'STEP 5: INDEPENDENT QA VALIDATION (/qa & /validate)',
      titleColor: 'red',
      paragraphs: [
        'Strict "No Self-Review": the Independent QA Engineer executes real empirical tests rather than trusting developer claims.',
      ],
      bullets: [
        {
          command: '/validate',
          text: 'QA runs automated test suites and verifies acceptance criteria against deliverables.',
        },
        {
          text: 'If defects (DEF-*) are found, they return to Developer. When all pass, QA issues an ACCEPT verdict (QA-*).',
        },
      ],
    },
    {
      badge: '[6]',
      badgeColor: 'green',
      title: 'STEP 6: FINAL ACCEPTANCE (/accept)',
      titleColor: 'green',
      paragraphs: [
        'Review the code delivery and QA verification evidence. As Product Owner, execute /accept to complete the iteration.',
      ],
    },
    {
      badge: '[PM]',
      badgeColor: 'magenta',
      title: 'CROSS-AGENT MANAGEMENT WITH PM (/pm)',
      titleColor: 'magenta',
      paragraphs: [
        'At any time, query the Project Manager (/pm). The PM executes parallel or sequential inquiries across Architect, Dev, and QA to consolidate status and detect bottlenecks.',
      ],
    },
    {
      badge: '[★]',
      badgeColor: 'yellow',
      title: 'KEYBOARD SHORTCUTS & ESSENTIAL TOOLS',
      titleColor: 'yellow',
      bullets: [
        {
          command: 'Tab / Ctrl+Tab',
          text: 'Toggle between clean OpenCode Chat View and Multipanel Command Center.',
        },
        {
          command: 'Ctrl+N / Shift+Tab',
          text: 'Quickly cycle the active specialist (PM → Architect → Developer → QA).',
        },
        {
          command: '/',
          text: 'Open interactive slash command menu with autocomplete.',
        },
        {
          command: '/models',
          text: 'Configure independent LLM models per role (Gemini, Claude, GPT, Ollama...).',
        },
        {
          command: '/settings',
          text: 'Configure UI language (English/Español), theme, or working directory.',
        },
        {
          command: '/system',
          text: 'Inspect active system prompts and behavioral harness directives.',
        },
        {
          command: '/db',
          text: 'Inspect and query the internal SQLite relational database directly.',
        },
        {
          command: '/help',
          text: 'Quick reference cheat sheet of all available slash commands.',
        },
      ],
    },
  ];
}

/**
 * Word-wraps text to a given maxWidth, returning an array of lines.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  const safeWidth = Math.max(20, maxWidth);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= safeWidth) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

/**
 * Converts structured Howto sections into display lines formatted for Ink TUI.
 */
export function getHowtoRenderLines(
  lang: SupportedLanguage,
  maxWidth: number,
): HowtoRenderLine[] {
  const sections = getHowtoSections(lang);
  const lines: HowtoRenderLine[] = [];
  const safeWidth = Math.max(30, maxWidth);

  sections.forEach((section, sIdx) => {
    if (sIdx > 0) {
      lines.push({ text: '' });
    }

    // Section Header
    lines.push({
      prefix: section.badge,
      prefixColor: section.badgeColor,
      prefixBold: true,
      text: section.title,
      color: section.titleColor,
      bold: true,
    });

    // Paragraphs
    if (section.paragraphs) {
      for (const para of section.paragraphs) {
        const wrapped = wrapText(para, safeWidth - 4);
        for (const w of wrapped) {
          lines.push({
            text: '    ' + w,
            color: 'white',
          });
        }
      }
    }

    // Bullets
    if (section.bullets) {
      for (const bullet of section.bullets) {
        const bulletPrefix = bullet.command
          ? `  • ${bullet.command}: `
          : `  • `;
        const indentLength = 4;
        const availableWidth = safeWidth - bulletPrefix.length - indentLength;
        const wrapped = wrapText(bullet.text, Math.max(20, availableWidth));

        if (wrapped.length > 0) {
          lines.push({
            prefix: bulletPrefix,
            prefixColor: bullet.command ? 'yellow' : 'cyan',
            prefixBold: !!bullet.command,
            text: wrapped[0],
            color: 'white',
          });
          const continuationIndent = ' '.repeat(bulletPrefix.length);
          for (let i = 1; i < wrapped.length; i++) {
            lines.push({
              text: continuationIndent + wrapped[i],
              color: 'white',
            });
          }
        }
      }
    }
  });

  return lines;
}
