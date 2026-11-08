import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ActorRole } from './contracts.js';

export const DEFAULT_POCLI_HOME_DIR = path.join(os.homedir(), '.pocli');

export function resolveDefaultWorkDir(): string {
  return process.env.POCLI_DATA_DIR
    ? path.resolve(process.env.POCLI_DATA_DIR)
    : DEFAULT_POCLI_HOME_DIR;
}

export const SupportedLanguageSchema = z.enum(['en', 'es']);
export type SupportedLanguage = z.infer<typeof SupportedLanguageSchema>;

export const SupportedThemeSchema = z.enum([
  'system',
  'solarized-light',
  'solarized-dark',
]);
export type SupportedTheme = z.infer<typeof SupportedThemeSchema>;

export const AppSettingsSchema = z.object({
  language: SupportedLanguageSchema.default('en'),
  theme: SupportedThemeSchema.default('system'),
  workDir: z.string().default(DEFAULT_POCLI_HOME_DIR),
  activeProjectId: z.string().optional(),
  persistentWorkers: z.boolean().default(true),
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
  settingThemeLabel: string;
  settingThemeDesc: string;
  themeSystemLabel: string;
  themeSolarizedLightLabel: string;
  themeSolarizedDarkLabel: string;
  settingWorkDirLabel: string;
  settingWorkDirDesc: string;
  settingWorkDirEditPrompt: string;
  settingsSavedMsg: (lang: SupportedLanguage) => string;
  themeSavedMsg: (theme: SupportedTheme) => string;
  themeInvalidMsg: (invalidTheme: string) => string;
  workDirSavedMsg: (dir: string) => string;
  modelsTitle: string;
  modelsSubtitle: string;
  modelsTargetAgentLabel: string;
  modelsAllAgentsLabel: string;
  modelsSearchLabel: string;
  modelsSearchPlaceholder: string;
  modelsAssignedMsg: (
    targetLabel: string,
    provider: string,
    modelId: string,
  ) => string;
  modelsNotFoundMsg: (query: string) => string;
  helpTitle: string;
  helpSubtitle: string;
  helpOpenedMsg: string;
  howtoTitle: string;
  howtoSubtitle: string;
  howtoOpenedMsg: string;
  newProjectTitle: string;
  newProjectStepNameLabel: string;
  newProjectStepDirLabel: (projectName: string) => string;
  newProjectWizardSubtitle: string;
  projectCreatedMsg: (name: string, dir: string, repoCount: number) => string;
  projectsListTitle: string;
  projectsListSubtitle: string;
  projectSwitchedMsg: (name: string, dir: string) => string;
  projectDeletedMsg: (name: string, renamedDir?: string) => string;
  confirmDeleteProject: (name: string) => string;
  projectsListFooterHints: string;
  projectNotFoundMsg: (query: string) => string;
  reposLabel: string;
  activeBadge: string;
  activeInterlocutorMsg: (roleName: string) => string;
  statusClearedMsg: string;
  unknownCommandMsg: (cmd: string) => string;
  llmMissingApiKeyError: (provider: string) => string;
  llmConnectionError: (provider: string, reason: string) => string;
  llmStatusBannerError: (provider: string) => string;
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
  compactedMsg: (role: string, count: number, savedTokens: number) => string;
  multipanelHeaderTitle: string;
  sectionTeamTitle: string;
  sectionArtifactsTitle: (count: number) => string;
  noArtifactsYet: string;
  rootTraceLabel: string;
  sectionNotebooksTitle: (count: number) => string;
  noNotebooksLinked: string;
  directChannelHeader: (roleName: string) => string;
  noMessagesInChannel: string;
  multipanelInspectorTitle: (roleName: string) => string;
  multipanelWorkerHeader: string;
  multipanelContextStatsHeader: string;
  multipanelMemoryHeader: string;
  multipanelRecentExchangeHeader: string;
  multipanelNoExchangesYet: string;
  multipanelNoCompactionYet: string;
  copiedToClipboardMsg: (charCount: number) => string;
  returnToCleanViewHint: string;
  expertBoxTitles: {
    pm: string;
    architect: string;
    developer: string;
    qa: string;
  };
  expertBoxSummaryLabel: string;
  expertBoxNoChatsYet: string;
  roleNames: Record<string, string>;
  liveModeActivated: string;
  liveModeDeactivated: string;
  liveStateListening: string;
  liveStateTranscribing: string;
  liveStateSpeaking: string;
  slashCommands: SlashCommandTranslation[];
}

export const I18N_DICTIONARY: Record<SupportedLanguage, UiTranslations> = {
  en: {
    projectLabel: 'project',
    phaseLabel: 'phase',
    viewLabel: 'view',
    cleanViewName: 'clean',
    multipanelViewName: 'multipanel',
    toggleViewHint: 'press Tab for Multipanel',
    virtualEngineeringTeam: 'Virtual Engineering Team',
    archVersionShort: 'Arch',
    qaCyclesShort: 'QA Cycles',
    availableCommandsHeader:
      'Available commands (↑/↓ select · Tab autocomplete · Enter execute)',
    noCommandMatches: 'No matches for',
    inputPlaceholderHint:
      'Type your instruction or "/" for commands (/project, /validate, /accept, /settings)',
    bottomShortcutsHint:
      '/ commands · Mouse click/wheel · Ctrl+N cycle · Tab multipanel · Esc exit',
    initialStatusBanner:
      'Type a message for the active professional or use "/" for commands. Press Ctrl+N to cycle agents, Tab for multipanel.',
    settingsTitle: 'Application Settings (/settings)',
    settingsSubtitle:
      'Use ↑/↓ to select option · ←/→ or Enter to edit · Esc to close',
    settingLanguageLabel: 'Interface Language',
    settingLanguageDesc: 'Switch TUI display language between English and Spanish',
    settingThemeLabel: 'Visual Theme',
    settingThemeDesc:
      'Select color theme (system, solarized-light, solarized-dark)',
    themeSystemLabel: 'system',
    themeSolarizedLightLabel: 'solarized-light',
    themeSolarizedDarkLabel: 'solarized-dark',
    settingWorkDirLabel: 'Central POCLI Home Directory',
    settingWorkDirDesc:
      'Central folder (default $HOME/.pocli/) for CLI configuration, SQLite database, logs & workspaces',
    settingWorkDirEditPrompt:
      'Enter new Central Working Directory path (Enter to save · Esc to cancel):',
    settingsSavedMsg: (lang) =>
      `✔ Settings updated: Interface language set to ${lang === 'en' ? 'English (en)' : 'Spanish (es)'}.`,
    themeSavedMsg: (thm) =>
      `✔ Settings updated: Visual theme set to ${thm}.`,
    themeInvalidMsg: (thm) =>
      `✖ Invalid theme "${thm}". Available: system, solarized-light, solarized-dark.`,
    workDirSavedMsg: (dir) =>
      `✔ Central Working & Artifacts Directory updated to: ${dir}`,
    modelsTitle: 'Select Model — Per-Agent Model Picker (/models)',
    modelsSubtitle:
      '←/→ or Tab: target agent · ↑/↓ or Wheel: select model · Type to filter · Enter/Click: apply · Esc: close',
    modelsTargetAgentLabel: 'Target Agent Conversation:',
    modelsAllAgentsLabel: 'All Agents',
    modelsSearchLabel: 'Search:',
    modelsSearchPlaceholder:
      'type to filter models (e.g. claude, gpt, gemini, ollama, deterministic)...',
    modelsAssignedMsg: (targetLabel, provider, modelId) =>
      `✔ Model for ${targetLabel} set to ${provider}/${modelId} in SQLite.`,
    modelsNotFoundMsg: (query) =>
      `✖ Model "${query}" not found. Use /models to open the interactive model picker.`,
    helpTitle: 'Available Commands & Shortcuts (/help)',
    helpSubtitle: 'Press Esc, Enter, or q to close help',
    helpOpenedMsg: 'Showing all available slash commands (/help).',
    howtoTitle: 'PO CLI Workflow & Methodology Guide (/howto)',
    howtoSubtitle: '↑/↓ scroll · Esc, Enter or q to close',
    howtoOpenedMsg: 'Showing PoCLI workflow and methodology guide (/howto).',
    newProjectTitle: 'Create New Project (/project)',
    newProjectStepNameLabel: 'Step 1/2 — Enter Project Name:',
    newProjectStepDirLabel: (projectName) =>
      `Step 2/2 — Enter Filesystem Directory for "${projectName}":`,
    newProjectWizardSubtitle:
      'Press Enter to confirm step · Esc to cancel',
    projectCreatedMsg: (name, dir, repoCount) =>
      `✔ Project "${name}" created & activated at ${dir} (${repoCount} existing repo(s) detected).`,
    projectsListTitle: 'Existing Projects — Select Active Project (/projects)',
    projectsListSubtitle:
      'Use ↑/↓ and Enter to switch active project · Esc to close',
    projectSwitchedMsg: (name, dir) =>
      `✔ Switched active project to "${name}" (${dir}).`,
    projectDeletedMsg: (name, renamedDir) =>
      `✔ Project "${name}" deleted from database and archived as ${renamedDir ? path.basename(renamedDir) : 'DELETED_' + name}.`,
    confirmDeleteProject: (name) =>
      `Are you sure you want to delete "${name}"? It will be archived on disk as DELETED_${name}. (y/n)`,
    projectsListFooterHints:
      '↑/↓ Navigate · Enter Select · d Delete/Archive · Esc Close',
    projectNotFoundMsg: (query) =>
      `✖ Project "${query}" not found. Use /projects to list all projects.`,
    reposLabel: 'repos',
    activeBadge: 'ACTIVE',
    activeInterlocutorMsg: (roleName) => `Active interlocutor: ${roleName}`,
    statusClearedMsg: 'Screen status log cleared.',
    unknownCommandMsg: (cmd) =>
      `Unknown command: ${cmd}. Type "/" to view available commands.`,
    llmMissingApiKeyError: (provider) =>
      `✖ Error: API key for provider '${provider}' is not configured. Use /auth to configure your API key or /models to select another model.`,
    llmConnectionError: (provider, reason) =>
      `✖ Error: Failed to connect to provider '${provider}': ${reason}. Verify credentials via /auth or select another model with /models.`,
    llmStatusBannerError: (provider) =>
      `✖ Error: ${provider.toUpperCase()} API key not configured (use /auth or /models)`,
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
    compactedMsg: (role, count, savedTokens) =>
      `✔ Pi-style context compaction completed for ${role}: ${count} message(s) condensed (${savedTokens} tokens saved).`,
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
    multipanelInspectorTitle: (roleName) =>
      `WORKER RUNTIME & CONTEXT INSPECTOR ↔ ${roleName.toUpperCase()}`,
    multipanelWorkerHeader: '1. Process Worker Runtime Status',
    multipanelContextStatsHeader: '2. Context Window & Compaction Statistics',
    multipanelMemoryHeader: '3. 4-Layer Persistent Memory & 3-Tier Architecture',
    multipanelRecentExchangeHeader: '4. Active Channel Exchange & Runtime Activity',
    multipanelNoExchangesYet: 'No conversational activity recorded yet. Type below to converse.',
    multipanelNoCompactionYet: 'Within budget (no compactions executed yet)',
    copiedToClipboardMsg: (charCount) =>
      `✔ Copied ${charCount} character${charCount === 1 ? '' : 's'} to clipboard.`,
    returnToCleanViewHint: '←/→ switch agent · Tab return to clean view',
    expertBoxTitles: {
      pm: 'Project Manager',
      architect: 'Architect',
      developer: 'Developer',
      qa: 'QA Engineer',
    },
    expertBoxSummaryLabel: 'Summary:',
    expertBoxNoChatsYet: 'No chats recorded in SQLite yet.',
    roleNames: {
      product_owner: 'Product Owner',
      architect: 'Software Architect',
      developer: 'Senior Developer',
      qa: 'Independent QA Engineer',
      pm: 'Project Manager (PM)',
      security_auditor: 'DevSecOps Security Auditor',
    },
    liveModeActivated:
      '🎙 Hands-free voice mode ACTIVATED (Spanish). Speak naturally (press Ctrl+S to deactivate).',
    liveModeDeactivated:
      '🔇 Hands-free voice mode DEACTIVATED. Microphone off.',
    liveStateListening: 'LIVE · Listening (ES)...',
    liveStateTranscribing: 'LIVE · Transcribing...',
    liveStateSpeaking: 'LIVE · Speaking...',
    slashCommands: [
      {
        command: '/check',
        description: 'Audio mixer, hardware input/output diagnostics & live VU meters (/check)',
      },
      {
        command: '/agents',
        description: 'Switch active agent (Architect, Developer, QA, PM)',
      },
      {
        command: '/system',
        description: 'Inspect agent system prompts and behavior location overrides',
      },
      {
        command: '/project',
        description: 'Create a new project (prompts for name & filesystem directory)',
        phaseHint: 'Phase 1',
      },
      {
        command: '/projects',
        description: 'List all existing projects and switch the active project',
      },
      {
        command: '/switch',
        description: 'Switch active project by name or ID (/switch <name>)',
      },
      {
        command: '/architect',
        description: 'Switch active interlocutor to the Software Architect',
      },
      {
        command: '/developer',
        description: 'Switch active interlocutor to the Senior Developer',
      },
      {
        command: '/tree',
        description: 'Toggle repository code tree explorer sidebar (Shift-T)',
      },
      {
        command: '/qa',
        description: 'Switch active interlocutor to the Independent QA Engineer',
      },
      {
        command: '/pm',
        description: 'Switch to Project Manager or run parallel/sequential team inquiry',
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
        command: '/compact',
        description:
          'Pi-style context window compaction for active agent or all (/compact [all])',
      },
      {
        command: '/models',
        description:
          'OpenCode-style model picker to configure LLM model per agent (/models [agent] [provider/model])',
      },
      {
        command: '/auth',
        description:
          'OpenCode & Pi-style modal to manage LLM provider API keys securely in ~/.pocli/auth.json',
      },
      {
        command: '/db',
        description:
          'Inspect SQLite database or run query (/db [.stats|.tables|.experts|<sql>])',
      },
      {
        command: '/logs',
        description:
          'Inspect application runtime diagnostic logs (/logs [clear|path])',
      },
      {
        command: '/settings',
        description:
          'Open settings or change language/theme/working dir (/settings lang en|es · /settings theme system|solarized-light|solarized-dark · /settings dir <path>)',
      },
      {
        command: '/workers',
        description:
          'Inspect, restart, or manage persistent concurrent agent workers (/workers [status|restart|stop])',
      },
      {
        command: '/view',
        description: 'Toggle between clean view (OpenCode) and Multipanel (Tab)',
      },
      {
        command: '/clear',
        description: 'Clear the on-screen status notification banner',
      },
      {
        command: '/howto',
        description: 'Show comprehensive workflow guide for getting started with POCLI',
        phaseHint: 'Workflow Guide',
      },
      {
        command: '/help',
        description: 'Display all available commands and keyboard shortcuts',
      },
      {
        command: '/exit',
        description: 'Exit Product Owner CLI (aliases: /quit, /q)',
      },
      {
        command: '/quit',
        description: 'Exit Product Owner CLI (alias for /exit)',
      },
      {
        command: '/q',
        description: 'Quick exit Product Owner CLI (alias for /exit)',
      },
    ],
  },
  es: {
    projectLabel: 'proyecto',
    phaseLabel: 'fase',
    viewLabel: 'vista',
    cleanViewName: 'limpia',
    multipanelViewName: 'multipanel',
    toggleViewHint: 'pulsa Tab para Multipanel',
    virtualEngineeringTeam: 'Equipo Virtual de Ingeniería',
    archVersionShort: 'Arq',
    qaCyclesShort: 'Ciclos QA',
    availableCommandsHeader:
      'Comandos disponibles (↑/↓ seleccionar · Tab autocompletar · Enter ejecutar)',
    noCommandMatches: 'Sin coincidencias para',
    inputPlaceholderHint:
      'Escribe tu instrucción o "/" para comandos (/project, /validate, /accept, /settings)',
    bottomShortcutsHint:
      '/ comandos · Ratón clic/rueda · Ctrl+N carrusel · Tab multipanel · Esc salir',
    initialStatusBanner:
      'Escribe un mensaje para el profesional activo o usa "/" para comandos. Pulsa Ctrl+N para cambiar de agente, Tab para multipanel.',
    settingsTitle: 'Configuración de la Aplicación (/settings)',
    settingsSubtitle:
      'Usa ↑/↓ para elegir opción · ←/→ o Enter para editar · Esc para cerrar',
    settingLanguageLabel: 'Idioma de la Interfaz',
    settingLanguageDesc: 'Alternar el idioma de la interfaz TUI entre Inglés y Español',
    settingThemeLabel: 'Tema Visual',
    settingThemeDesc:
      'Seleccionar tema de color (system, solarized-light, solarized-dark)',
    themeSystemLabel: 'system',
    themeSolarizedLightLabel: 'solarized-light',
    themeSolarizedDarkLabel: 'solarized-dark',
    settingWorkDirLabel: 'Directorio Central de POCLI',
    settingWorkDirDesc:
      'Carpeta central (por defecto $HOME/.pocli/) para configuración del CLI, base de datos SQLite, logs y workspaces',
    settingWorkDirEditPrompt:
      'Introduce la nueva ruta del Directorio Central de Trabajo (Enter guardar · Esc cancelar):',
    settingsSavedMsg: (lang) =>
      `✔ Configuración actualizada: Idioma establecido a ${lang === 'en' ? 'Inglés (en)' : 'Español (es)'}.`,
    themeSavedMsg: (thm) =>
      `✔ Configuración actualizada: Tema visual establecido a ${thm}.`,
    themeInvalidMsg: (thm) =>
      `✖ Tema no válido "${thm}". Disponibles: system, solarized-light, solarized-dark.`,
    workDirSavedMsg: (dir) =>
      `✔ Directorio Central de Trabajo y Artefactos actualizado a: ${dir}`,
    modelsTitle: 'Seleccionar Modelo — Configuración de Modelo por Agente (/models)',
    modelsSubtitle:
      '←/→ o Tab: agente destino · ↑/↓ o Rueda: elegir modelo · Escribe para filtrar · Enter/Clic: aplicar · Esc: cerrar',
    modelsTargetAgentLabel: 'Conversación de Agente Destino:',
    modelsAllAgentsLabel: 'Todos los Agentes',
    modelsSearchLabel: 'Buscar:',
    modelsSearchPlaceholder:
      'escribe para filtrar modelos (ej. claude, gpt, gemini, ollama, deterministic)...',
    modelsAssignedMsg: (targetLabel, provider, modelId) =>
      `✔ Modelo para ${targetLabel} establecido a ${provider}/${modelId} en SQLite.`,
    modelsNotFoundMsg: (query) =>
      `✖ Modelo "${query}" no encontrado. Usa /models para abrir el selector interactivo.`,
    helpTitle: 'Comandos Disponibles y Atajos (/help)',
    helpSubtitle: 'Pulsa Esc, Enter o q para cerrar la ayuda',
    helpOpenedMsg: 'Mostrando todos los comandos disponibles (/help).',
    howtoTitle: 'Guía de Proceso y Metodología de PO CLI (/howto)',
    howtoSubtitle: '↑/↓ desplazarse · Esc, Enter o q para cerrar',
    howtoOpenedMsg: 'Mostrando la guía de proceso y metodología de PoCLI (/howto).',
    newProjectTitle: 'Crear Nuevo Proyecto (/project)',
    newProjectStepNameLabel: 'Paso 1/2 — Introduce el Nombre del Proyecto:',
    newProjectStepDirLabel: (projectName) =>
      `Paso 2/2 — Introduce el Directorio del Filesystem para "${projectName}":`,
    newProjectWizardSubtitle:
      'Pulsa Enter para confirmar paso · Esc para cancelar',
    projectCreatedMsg: (name, dir, repoCount) =>
      `✔ Proyecto "${name}" creado y activado en ${dir} (${repoCount} repositorio(s) detectados).`,
    projectsListTitle: 'Proyectos Existentes — Cambiar Proyecto Activo (/projects)',
    projectsListSubtitle:
      'Usa ↑/↓ y Enter para cambiar al proyecto seleccionado · Esc para cerrar',
    projectSwitchedMsg: (name, dir) =>
      `✔ Proyecto activo cambiado a "${name}" (${dir}).`,
    projectDeletedMsg: (name, renamedDir) =>
      `✔ Proyecto "${name}" eliminado de la base de datos y archivado como ${renamedDir ? path.basename(renamedDir) : 'DELETED_' + name}.`,
    confirmDeleteProject: (name) =>
      `¿Seguro que deseas eliminar "${name}"? Se archivará en disco como DELETED_${name}. (s/n)`,
    projectsListFooterHints:
      '↑/↓ Navegar · Enter Seleccionar · d Eliminar/Archivar · Esc Cerrar',
    projectNotFoundMsg: (query) =>
      `✖ Proyecto "${query}" no encontrado. Usa /projects para listar proyectos.`,
    reposLabel: 'repos',
    activeBadge: 'ACTIVO',
    activeInterlocutorMsg: (roleName) => `Interlocutor activo: ${roleName}`,
    statusClearedMsg: 'Registro de notificaciones limpiado.',
    unknownCommandMsg: (cmd) =>
      `Comando desconocido: ${cmd}. Escribe "/" para ver los comandos disponibles.`,
    llmMissingApiKeyError: (provider) =>
      `✖ Error: La API key para el proveedor '${provider}' no está configurada. Usa el comando /auth para añadir tu clave de API o cambia de modelo con /models.`,
    llmConnectionError: (provider, reason) =>
      `✖ Error: Fallo de conexión con el proveedor '${provider}': ${reason}. Verifica tus credenciales con /auth o cambia de modelo con /models.`,
    llmStatusBannerError: (provider) =>
      `✖ Error: ${provider.toUpperCase()} API key no configurada (usa /auth o /models)`,
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
    compactedMsg: (role, count, savedTokens) =>
      `✔ Compactación de contexto (estilo Pi) completada para ${role}: ${count} mensaje(s) condensados (${savedTokens} tokens ahorrados).`,
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
    multipanelInspectorTitle: (roleName) =>
      `INSPECTOR DE WORKER Y CONTEXTO ↔ ${roleName.toUpperCase()}`,
    multipanelWorkerHeader: '1. Estado del Worker de Proceso en Tiempo Real',
    multipanelContextStatsHeader: '2. Ventana de Contexto y Estadísticas de Compactación',
    multipanelMemoryHeader: '3. Memoria Persistente de 4 Capas y Arquitectura de 3 Tiers',
    multipanelRecentExchangeHeader: '4. Actividad del Canal y Último Intercambio',
    multipanelNoExchangesYet: 'Sin actividad conversacional registrada aún. Escribe abajo para enviar un mensaje.',
    multipanelNoCompactionYet: 'Dentro del presupuesto (sin compactaciones aún)',
    copiedToClipboardMsg: (charCount) =>
      `✔ ${charCount} carácter(es) copiado(s) al portapapeles.`,
    returnToCleanViewHint: '←/→ cambiar agente · Pulsa Tab para volver a vista limpia',
    expertBoxTitles: {
      pm: 'Project Manager',
      architect: 'Arquitecto',
      developer: 'Desarrollador',
      qa: 'Ingeniero QA',
    },
    expertBoxSummaryLabel: 'Resumen:',
    expertBoxNoChatsYet: 'Sin charlas registradas en SQLite aún.',
    roleNames: {
      product_owner: 'Product Owner',
      architect: 'Arquitecto de Software',
      developer: 'Desarrollador Experto',
      qa: 'Ingeniero de QA Independiente',
      pm: 'Project Manager (PM)',
      security_auditor: 'Auditor de Seguridad DevSecOps',
    },
    liveModeActivated:
      '🎙 Modo de voz manos libres ACTIVADO (Español). Habla con naturalidad (pulsa Ctrl+S para desactivar).',
    liveModeDeactivated:
      '🔇 Modo de voz manos libres DESACTIVADO. Micrófono apagado.',
    liveStateListening: 'LIVE · Escuchando (ES)...',
    liveStateTranscribing: 'LIVE · Transcribiendo...',
    liveStateSpeaking: 'LIVE · Hablando...',
    slashCommands: [
      {
        command: '/check',
        description:
          'Mezclador de audio, diagnóstico de hardware y vúmetro en tiempo real (/check)',
      },
      {
        command: '/agents',
        description: 'Cambiar de agente activo (Architect, Developer, QA, PM)',
      },
      {
        command: '/system',
        description: 'Inspeccionar system prompts de los agentes y overrides de ubicación',
      },
      {
        command: '/project',
        description: 'Crear nuevo proyecto (pregunta nombre y directorio en filesystem)',
        phaseHint: 'Fase 1',
      },
      {
        command: '/projects',
        description: 'Listar todos los proyectos existentes y cambiar de proyecto activo',
      },
      {
        command: '/switch',
        description: 'Cambiar al proyecto indicado por nombre o ID (/switch <nombre>)',
      },
      {
        command: '/architect',
        description: 'Cambiar interlocutor activo al Arquitecto de Software',
      },
      {
        command: '/developer',
        description: 'Cambiar interlocutor activo al Desarrollador Experto',
      },
      {
        command: '/tree',
        description: 'Explorador del repositorio de código en barra lateral (Shift-T)',
      },
      {
        command: '/qa',
        description: 'Cambiar interlocutor activo al Ingeniero de QA Independiente',
      },
      {
        command: '/pm',
        description: 'Cambiar al Project Manager o lanzar consulta paralela/secuencial',
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
        command: '/compact',
        description:
          'Compactar context window (estilo Pi) del agente activo o todos (/compact [all])',
      },
      {
        command: '/models',
        description:
          'Selector de modelos estilo OpenCode para configurar el LLM por agente (/models [agente] [proveedor/modelo])',
      },
      {
        command: '/auth',
        description:
          'Modal estilo OpenCode y Pi para gestionar claves de proveedores LLM en ~/.pocli/auth.json',
      },
      {
        command: '/db',
        description:
          'Inspeccionar base de datos SQLite o ejecutar SQL (/db [.stats|.tables|<sql>])',
      },
      {
        command: '/logs',
        description:
          'Inspeccionar registros de diagnóstico en tiempo de ejecución (/logs [clear|path])',
      },
      {
        command: '/settings',
        description:
          'Abrir ajustes o cambiar idioma/tema/directorio de trabajo (/settings lang en|es · /settings theme system|solarized-light|solarized-dark · /settings dir <ruta>)',
      },
      {
        command: '/workers',
        description:
          'Inspeccionar, reiniciar o gestionar trabajadores concurrentes persistentes (/workers [status|restart|stop])',
      },
      {
        command: '/view',
        description: 'Alternar entre vista limpia (OpenCode) y Multipanel (Tab)',
      },
      {
        command: '/clear',
        description: 'Limpiar el registro de notificaciones en pantalla',
      },
      {
        command: '/howto',
        description: 'Muestra la guía completa del proceso y flujo de trabajo con POCLI',
        phaseHint: 'Guía de Trabajo',
      },
      {
        command: '/help',
        description: 'Mostrar todos los comandos disponibles y atajos de teclado',
      },
      {
        command: '/exit',
        description: 'Salir de Product Owner CLI (alias: /quit, /q)',
      },
      {
        command: '/quit',
        description: 'Salir de Product Owner CLI (alias de /exit)',
      },
      {
        command: '/q',
        description: 'Salida rápida de Product Owner CLI (alias de /exit)',
      },
    ],
  },
};

export function getRoleDisplayName(role: ActorRole, lang: SupportedLanguage): string {
  return I18N_DICTIONARY[lang].roleNames[role] ?? role;
}

