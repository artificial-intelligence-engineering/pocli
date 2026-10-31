import { z } from 'zod';
import { ActorRole } from './contracts.js';

export const SupportedLanguageSchema = z.enum(['en', 'es']);
export type SupportedLanguage = z.infer<typeof SupportedLanguageSchema>;

export const AppSettingsSchema = z.object({
  language: SupportedLanguageSchema.default('en'),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export interface SlashCommandTranslation {
  command: string;
  description: string;
  phaseHint?: string;
}

export interface UiTranslations {
  projectLabel: string;
  phaseLabel: string;
  viewLabel: string;
  cleanViewName: string;
  multipanelViewName: string;
  toggleViewHint: string;
  virtualEngineeringTeam: string;
  archVersionShort: string;
  qaCyclesShort: string;
  availableCommandsHeader: string;
  noCommandMatches: string;
  inputPlaceholderHint: string;
  bottomShortcutsHint: string;
  initialStatusBanner: string;
  settingsTitle: string;
  settingsSubtitle: string;
  settingLanguageLabel: string;
  settingLanguageDesc: string;
  settingsSavedMsg: (lang: SupportedLanguage) => string;
  helpTitle: string;
  helpSubtitle: string;
  helpOpenedMsg: string;
  activeInterlocutorMsg: (roleName: string) => string;
  statusClearedMsg: string;
  unknownCommandMsg: (cmd: string) => string;
  consultingAgentMsg: (role: string) => string;
  agentRepliedMsg: (role: string, pid: number, artifactCount: number) => string;
  archApprovedMsg: (version: number) => string;
  archRejectedMsg: string;
  handoffCompletedMsg: (version: number) => string;
  consultationEvaluatedMsg: (status: string) => string;
  qaRunningMsg: string;
  qaCompletedMsg: (code: string, verdict: string, passed: number, total: number) => string;
  projectAcceptedMsg: string;
  notebooksIndexedMsg: (count: number, names: string) => string;
  multipanelHeaderTitle: string;
  sectionTeamTitle: string;
  sectionArtifactsTitle: (count: number) => string;
  noArtifactsYet: string;
  rootTraceLabel: string;
  sectionNotebooksTitle: (count: number) => string;
  noNotebooksLinked: string;
  directChannelHeader: (roleName: string) => string;
  noMessagesInChannel: string;
  returnToCleanViewHint: string;
  roleNames: Record<string, string>;
  slashCommands: SlashCommandTranslation[];
}

export const I18N_DICTIONARY: Record<SupportedLanguage, UiTranslations> = {
  en: {
    projectLabel: 'project',
    phaseLabel: 'phase',
    viewLabel: 'view',
    cleanViewName: 'clean',
    multipanelViewName: 'multipanel',
    toggleViewHint: 'press Ctrl+Tab for Multipanel',
    virtualEngineeringTeam: 'Virtual Engineering Team',
    archVersionShort: 'Arch',
    qaCyclesShort: 'QA Cycles',
    availableCommandsHeader:
      'Available commands (↑/↓ select · Tab autocomplete · Enter execute)',
    noCommandMatches: 'No matches for',
    inputPlaceholderHint:
      'Type your instruction or "/" for commands (/propose, /approve, /handoff, /implement, /validate, /settings)',
    bottomShortcutsHint: '/ commands · Ctrl+Tab multipanel · Esc exit',
    initialStatusBanner:
      'Type a message for the active professional or use "/" for commands. Press Ctrl+Tab to switch views.',
    settingsTitle: 'Application Settings (/settings)',
    settingsSubtitle:
      'Use ←/→ or Enter to toggle values · Esc to close settings',
    settingLanguageLabel: 'Interface Language',
    settingLanguageDesc: 'Switch TUI display language between English and Spanish',
    settingsSavedMsg: (lang) =>
      `✔ Settings updated: Interface language set to ${lang === 'en' ? 'English (en)' : 'Spanish (es)'}.`,
    helpTitle: 'Available Commands & Shortcuts (/help)',
    helpSubtitle: 'Press Esc, Enter, or q to close help',
    helpOpenedMsg: 'Showing all available slash commands (/help).',
    activeInterlocutorMsg: (roleName) => `Active interlocutor: ${roleName}`,
    statusClearedMsg: 'Screen status log cleared.',
    unknownCommandMsg: (cmd) =>
      `Unknown command: ${cmd}. Type "/" to view available commands.`,
    consultingAgentMsg: (role) =>
      `⏳ Consulting ${role.toUpperCase()} in isolated Linux worker process...`,
    agentRepliedMsg: (role, pid, count) =>
      `✔ ${role.toUpperCase()} replied (Worker PID ${pid} | ${count} new artifacts).`,
    archApprovedMsg: (version) =>
      `✔ Architecture ARCH-001 v${version} formally APPROVED by the Product Owner.`,
    archRejectedMsg:
      '↺ Architecture ARCH-001 rejected. Returned to Phase 2 (Architect Analysis).',
    handoffCompletedMsg: (version) =>
      `✔ Normative Handoff transferred to Developer (ARCH v${version}).`,
    consultationEvaluatedMsg: (status) =>
      `✔ Developer → Architect consultation recorded and evaluated: ${status}`,
    qaRunningMsg: '⏳ Independent QA Engineer executing verification tests...',
    qaCompletedMsg: (code, verdict, passed, total) =>
      `✔ QA emitted ${code}: ${verdict} (${passed}/${total} tests passed).`,
    projectAcceptedMsg: '★ Project formally ACCEPTED and COMPLETED by the Product Owner!',
    notebooksIndexedMsg: (count, names) =>
      `✔ Active Notebooks linked to project: ${count} (${names || 'none'}).`,
    multipanelHeaderTitle: 'PO CLI — Multipanel Command Center (Linux)',
    sectionTeamTitle: '1. Virtual Engineering Team',
    sectionArtifactsTitle: (count) => `2. Versioned Artifacts (${count})`,
    noArtifactsYet: '  No artifacts generated yet.',
    rootTraceLabel: 'root',
    sectionNotebooksTitle: (count) => `3. Linked RAG Notebooks (${count})`,
    noNotebooksLinked: '  No notebooks linked.',
    directChannelHeader: (roleName) =>
      `Direct Channel PO ↔ ${roleName.toUpperCase()}`,
    noMessagesInChannel: 'No messages in this channel yet.',
    returnToCleanViewHint: 'Press Ctrl+Tab to return to clean view',
    roleNames: {
      product_owner: 'Product Owner',
      architect: 'Software Architect',
      developer: 'Senior Developer',
      qa: 'Independent QA Engineer',
      security_auditor: 'DevSecOps Security Auditor',
    },
    slashCommands: [
      {
        command: '/architect',
        description: 'Switch active interlocutor to the Software Architect',
      },
      {
        command: '/developer',
        description: 'Switch active interlocutor to the Senior Developer',
      },
      {
        command: '/qa',
        description: 'Switch active interlocutor to the Independent QA Engineer',
      },
      {
        command: '/propose',
        description: 'Ask the Architect for a formal architecture & requirements proposal',
        phaseHint: 'Phase 2 → 3',
      },
      {
        command: '/approve',
        description: 'Formally approve the architecture (ARCH-001) as Product Owner',
        phaseHint: 'Phase 3 → 4',
      },
      {
        command: '/reject',
        description: 'Reject the proposed architecture and return to analysis',
        phaseHint: 'Phase 3 → 2',
      },
      {
        command: '/handoff',
        description: 'Transfer approved normative bundle to the Developer',
        phaseHint: 'Phase 4 → 5',
      },
      {
        command: '/implement',
        description: 'Instruct the Developer to implement the approved Handoff',
        phaseHint: 'Phase 5',
      },
      {
        command: '/consult',
        description: 'Trigger a formal Developer → Architect authority consultation',
        phaseHint: 'Phase 5',
      },
      {
        command: '/validate',
        description: 'Run independent QA validation with tests and evidence',
        phaseHint: 'Phase 6 / 7',
      },
      {
        command: '/accept',
        description: 'Final project acceptance by the Product Owner',
        phaseHint: 'Phase 8',
      },
      {
        command: '/notebooks',
        description: 'Re-index and display linked RAG Notebooks status',
      },
      {
        command: '/settings',
        description: 'Open settings menu or change language (/settings lang en|es)',
      },
      {
        command: '/view',
        description: 'Toggle between clean view (OpenCode) and Multipanel (Ctrl+Tab)',
      },
      {
        command: '/clear',
        description: 'Clear the on-screen status notification banner',
      },
      {
        command: '/help',
        description: 'Display all available commands and keyboard shortcuts',
      },
      {
        command: '/exit',
        description: 'Exit Product Owner CLI',
      },
    ],
  },
  es: {
    projectLabel: 'proyecto',
    phaseLabel: 'fase',
    viewLabel: 'vista',
    cleanViewName: 'limpia',
    multipanelViewName: 'multipanel',
    toggleViewHint: 'pulsa Ctrl+Tab para Multipanel',
    virtualEngineeringTeam: 'Equipo Virtual de Ingeniería',
    archVersionShort: 'Arq',
    qaCyclesShort: 'Ciclos QA',
    availableCommandsHeader:
      'Comandos disponibles (↑/↓ seleccionar · Tab autocompletar · Enter ejecutar)',
    noCommandMatches: 'Sin coincidencias para',
    inputPlaceholderHint:
      'Escribe tu instrucción o "/" para comandos (/propose, /approve, /handoff, /implement, /validate, /settings)',
    bottomShortcutsHint: '/ comandos · Ctrl+Tab multipanel · Esc salir',
    initialStatusBanner:
      'Escribe un mensaje para el profesional activo o usa "/" para comandos. Pulsa Ctrl+Tab para alternar vista.',
    settingsTitle: 'Configuración de la Aplicación (/settings)',
    settingsSubtitle:
      'Usa ←/→ o Enter para cambiar valores · Esc para cerrar configuración',
    settingLanguageLabel: 'Idioma de la Interfaz',
    settingLanguageDesc: 'Alternar el idioma de la interfaz TUI entre Inglés y Español',
    settingsSavedMsg: (lang) =>
      `✔ Configuración actualizada: Idioma establecido a ${lang === 'en' ? 'Inglés (en)' : 'Español (es)'}.`,
    helpTitle: 'Comandos Disponibles y Atajos (/help)',
    helpSubtitle: 'Pulsa Esc, Enter o q para cerrar la ayuda',
    helpOpenedMsg: 'Mostrando todos los comandos disponibles (/help).',
    activeInterlocutorMsg: (roleName) => `Interlocutor activo: ${roleName}`,
    statusClearedMsg: 'Registro de notificaciones limpiado.',
    unknownCommandMsg: (cmd) =>
      `Comando desconocido: ${cmd}. Escribe "/" para ver los comandos disponibles.`,
    consultingAgentMsg: (role) =>
      `⏳ Consultando a ${role.toUpperCase()} en proceso worker Linux aislado...`,
    agentRepliedMsg: (role, pid, count) =>
      `✔ ${role.toUpperCase()} respondió (Worker PID ${pid} | ${count} artefactos nuevos).`,
    archApprovedMsg: (version) =>
      `✔ Arquitectura ARCH-001 v${version} APROBADA formalmente por el Product Owner.`,
    archRejectedMsg:
      '↺ Arquitectura ARCH-001 rechazada. Devuelta a Fase 2 (Análisis).',
    handoffCompletedMsg: (version) =>
      `✔ Paquete normativo Handoff transferido al Desarrollador (ARCH v${version}).`,
    consultationEvaluatedMsg: (status) =>
      `✔ Consulta Desarrollador → Arquitecto registrada y evaluada: ${status}`,
    qaRunningMsg: '⏳ Ingeniero de QA independiente ejecutando pruebas de verificación...',
    qaCompletedMsg: (code, verdict, passed, total) =>
      `✔ QA emitió ${code}: ${verdict} (${passed}/${total} pruebas superadas).`,
    projectAcceptedMsg: '★ ¡Proyecto ACEPTADO y COMPLETADO formalmente por el Product Owner!',
    notebooksIndexedMsg: (count, names) =>
      `✔ Notebooks activos asociados al proyecto: ${count} (${names || 'ninguno'}).`,
    multipanelHeaderTitle: 'PO CLI — Centro de Mando Multipanel (Linux)',
    sectionTeamTitle: '1. Equipo Virtual de Ingeniería',
    sectionArtifactsTitle: (count) => `2. Artefactos Versionados (${count})`,
    noArtifactsYet: '  Sin artefactos generados aún.',
    rootTraceLabel: 'raíz',
    sectionNotebooksTitle: (count) => `3. Notebooks RAG Asociados (${count})`,
    noNotebooksLinked: '  Sin notebooks vinculados.',
    directChannelHeader: (roleName) =>
      `Canal Directo PO ↔ ${roleName.toUpperCase()}`,
    noMessagesInChannel: 'No hay mensajes en este canal todavía.',
    returnToCleanViewHint: 'Pulsa Ctrl+Tab para volver a vista limpia',
    roleNames: {
      product_owner: 'Product Owner',
      architect: 'Arquitecto de Software',
      developer: 'Desarrollador Experto',
      qa: 'Ingeniero de QA Independiente',
      security_auditor: 'Auditor de Seguridad DevSecOps',
    },
    slashCommands: [
      {
        command: '/architect',
        description: 'Cambiar interlocutor activo al Arquitecto de Software',
      },
      {
        command: '/developer',
        description: 'Cambiar interlocutor activo al Desarrollador Experto',
      },
      {
        command: '/qa',
        description: 'Cambiar interlocutor activo al Ingeniero de QA Independiente',
      },
      {
        command: '/propose',
        description: 'Pedir al Arquitecto propuesta formal de requisitos y arquitectura',
        phaseHint: 'Fase 2 → 3',
      },
      {
        command: '/approve',
        description: 'Aprobar formalmente la arquitectura (ARCH-001) como Product Owner',
        phaseHint: 'Fase 3 → 4',
      },
      {
        command: '/reject',
        description: 'Rechazar la arquitectura propuesta y devolver a análisis',
        phaseHint: 'Fase 3 → 2',
      },
      {
        command: '/handoff',
        description: 'Transferir paquete normativo aprobado al Desarrollador',
        phaseHint: 'Fase 4 → 5',
      },
      {
        command: '/implement',
        description: 'Ordenar al Desarrollador implementar según el Handoff aprobado',
        phaseHint: 'Fase 5',
      },
      {
        command: '/consult',
        description: 'Lanzar consulta técnica formal Desarrollador → Arquitecto',
        phaseHint: 'Fase 5',
      },
      {
        command: '/validate',
        description: 'Ejecutar validación independiente de QA con pruebas y evidencias',
        phaseHint: 'Fase 6 / 7',
      },
      {
        command: '/accept',
        description: 'Aceptación definitiva del proyecto por el Product Owner',
        phaseHint: 'Fase 8',
      },
      {
        command: '/notebooks',
        description: 'Re-indexar y mostrar estado de los Notebooks RAG asociados',
      },
      {
        command: '/settings',
        description: 'Abrir menú de ajustes o cambiar idioma (/settings lang en|es)',
      },
      {
        command: '/view',
        description: 'Alternar entre vista limpia (OpenCode) y Multipanel (Ctrl+Tab)',
      },
      {
        command: '/clear',
        description: 'Limpiar el registro de notificaciones en pantalla',
      },
      {
        command: '/help',
        description: 'Mostrar todos los comandos disponibles y atajos de teclado',
      },
      {
        command: '/exit',
        description: 'Salir de Product Owner CLI',
      },
    ],
  },
};

export function getRoleDisplayName(role: ActorRole, lang: SupportedLanguage): string {
  return I18N_DICTIONARY[lang].roleNames[role] ?? role;
}

