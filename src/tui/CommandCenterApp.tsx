import React, { useState, useEffect, useMemo, useRef } from 'react';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Box, Text, useInput, useApp, useStdout, useStdin } from 'ink';
import {
  ActorRole,
  Artifact,
  Notebook,
  Project,
  WorkerStatusInfo,
} from '../core/contracts.js';
import {
  getRoleDisplayName,
  I18N_DICTIONARY,
  SupportedLanguage,
  SupportedTheme,
} from '../core/i18n.js';
import { ExpertChatSummary } from '../storage/database.js';
import { executeDbCommandOrQuery } from '../storage/db-repl.js';
import { PoCliOrchestrator } from '../runtime/orchestrator.js';
import { HarnessRegistry } from '../runtime/harnesses.js';
import { Logger } from '../core/logger.js';
import { AuthStorage } from '../core/auth.js';
import {
  openSystemBrowser,
  startGoogleOidcLogin,
  type OidcLoginSession,
} from '../core/oidc.js';
import {
  AVAILABLE_MODELS_CATALOG,
  getModelVendorLabel,
  ModelCatalogEntry,
  resolveModelSpec,
} from '../runtime/llm-gateway.js';
import {
  DISABLE_MOUSE_TRACKING_SEQ,
  ENABLE_MOUSE_TRACKING_SEQ,
  isMouseSequence,
  ParsedMouseEvent,
  parseMouseEvents,
} from './mouse.js';
import { getHowtoRenderLines } from './howtoContent.js';
import {
  wrapTextLines,
  filterToolingStream,
  computeScrollbar,
  calculateScrollJump,
  sliceChatLines,
  buildChatVisualLines,
  ChatVisualItem,
} from './chat-scrolling.js';
import { FileTreeExplorer, useFileTree } from './FileTreeExplorer.js';
export { wrapTextLines };

export interface CommandCenterProps {
  orchestrator: PoCliOrchestrator;
  initialProject?: Project | null;
}

export const MULTIPANEL_ROLES: ActorRole[] = ['pm', 'architect', 'developer', 'qa'];

export function getNextCarouselRole(
  currentRole: ActorRole,
  direction: 'next' | 'prev',
  roles: ActorRole[] = MULTIPANEL_ROLES,
): ActorRole {
  const currIdx = Math.max(0, roles.indexOf(currentRole));
  const delta = direction === 'next' ? 1 : -1;
  const nextIdx = (currIdx + delta + roles.length) % roles.length;
  return roles[nextIdx];
}

const ASCII_LOGO = [
  '██████╗  ██████╗      ██████╗██╗     ██╗',
  '██╔══██╗██╔═══██╗    ██╔════╝██║     ██║',
  '██████╔╝██║   ██║    ██║     ██║     ██║',
  '██╔═══╝ ██║   ██║    ██║     ██║     ██║',
  '██║     ╚██████╔╝    ╚██████╗███████╗██║',
  '╚═╝      ╚═════╝      ╚═════╝╚══════╝╚═╝',
];

/**
 * Canonical Solarized Palette (Ethan Schoonover)
 * https://ethanschoonover.com/solarized/
 */
export const SOLARIZED_COLORS = {
  base03: '#002b36', // darkest background
  base02: '#073642', // background highlights / secondary bg
  base01: '#586e75', // comments / secondary content
  base00: '#657b83', // primary content in light theme
  base0: '#839496',  // primary content in dark theme
  base1: '#93a1a1',  // emphasized content
  base2: '#eee8d5',  // background highlights in light theme
  base3: '#fdf6e3',  // lightest background
  yellow: '#b58900',
  orange: '#cb4b16',
  red: '#dc322f',
  magenta: '#d33682',
  violet: '#6c71c4',
  blue: '#268bd2',
  cyan: '#2aa198',
  green: '#859900',
} as const;



export interface RoleColorTheme {
  bgColor: string;
  fgColor: string;
  accentColor: string;
}

export interface ThemePalette {
  theme: SupportedTheme;
  bg?: string;
  cardBg: string;
  fg: string;
  dim: string;
  header: string;
  border: string;
  accent: string;
  cyan: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  red: string;
  orange: string;
  modalBorder: string;
  roleThemes: Record<ActorRole, RoleColorTheme>;
}

export const THEME_PALETTES: Record<SupportedTheme, ThemePalette> = {
  system: {
    theme: 'system',
    bg: undefined,
    cardBg: '#073642',
    fg: 'white',
    dim: 'gray',
    header: 'white',
    border: 'cyan',
    accent: 'cyan',
    cyan: 'cyan',
    green: 'green',
    yellow: 'yellow',
    blue: 'blue',
    magenta: 'magenta',
    red: 'red',
    orange: 'yellow',
    modalBorder: 'yellow',
    roleThemes: {
      pm: { bgColor: 'magenta', fgColor: 'white', accentColor: 'magenta' },
      architect: { bgColor: 'blue', fgColor: 'white', accentColor: 'blue' },
      developer: { bgColor: 'green', fgColor: 'black', accentColor: 'green' },
      qa: { bgColor: 'yellow', fgColor: 'black', accentColor: 'yellow' },
    },
  },
  'solarized-dark': {
    theme: 'solarized-dark',
    bg: SOLARIZED_COLORS.base03,
    cardBg: SOLARIZED_COLORS.base02,
    fg: SOLARIZED_COLORS.base0,
    dim: SOLARIZED_COLORS.base01,
    header: SOLARIZED_COLORS.base1,
    border: SOLARIZED_COLORS.cyan,
    accent: SOLARIZED_COLORS.blue,
    cyan: SOLARIZED_COLORS.cyan,
    green: SOLARIZED_COLORS.green,
    yellow: SOLARIZED_COLORS.yellow,
    blue: SOLARIZED_COLORS.blue,
    magenta: SOLARIZED_COLORS.magenta,
    red: SOLARIZED_COLORS.red,
    orange: SOLARIZED_COLORS.orange,
    modalBorder: SOLARIZED_COLORS.yellow,
    roleThemes: {
      pm: {
        bgColor: SOLARIZED_COLORS.magenta,
        fgColor: SOLARIZED_COLORS.base3,
        accentColor: SOLARIZED_COLORS.magenta,
      },
      architect: {
        bgColor: SOLARIZED_COLORS.blue,
        fgColor: SOLARIZED_COLORS.base3,
        accentColor: SOLARIZED_COLORS.blue,
      },
      developer: {
        bgColor: SOLARIZED_COLORS.green,
        fgColor: SOLARIZED_COLORS.base03,
        accentColor: SOLARIZED_COLORS.green,
      },
      qa: {
        bgColor: SOLARIZED_COLORS.yellow,
        fgColor: SOLARIZED_COLORS.base03,
        accentColor: SOLARIZED_COLORS.yellow,
      },
    },
  },
  'solarized-light': {
    theme: 'solarized-light',
    bg: SOLARIZED_COLORS.base3,
    cardBg: SOLARIZED_COLORS.base2,
    fg: SOLARIZED_COLORS.base00,
    dim: SOLARIZED_COLORS.base1,
    header: SOLARIZED_COLORS.base01,
    border: SOLARIZED_COLORS.cyan,
    accent: SOLARIZED_COLORS.blue,
    cyan: SOLARIZED_COLORS.cyan,
    green: SOLARIZED_COLORS.green,
    yellow: SOLARIZED_COLORS.yellow,
    blue: SOLARIZED_COLORS.blue,
    magenta: SOLARIZED_COLORS.magenta,
    red: SOLARIZED_COLORS.red,
    orange: SOLARIZED_COLORS.orange,
    modalBorder: SOLARIZED_COLORS.yellow,
    roleThemes: {
      pm: {
        bgColor: SOLARIZED_COLORS.magenta,
        fgColor: SOLARIZED_COLORS.base3,
        accentColor: SOLARIZED_COLORS.magenta,
      },
      architect: {
        bgColor: SOLARIZED_COLORS.blue,
        fgColor: SOLARIZED_COLORS.base3,
        accentColor: SOLARIZED_COLORS.blue,
      },
      developer: {
        bgColor: SOLARIZED_COLORS.green,
        fgColor: SOLARIZED_COLORS.base3,
        accentColor: SOLARIZED_COLORS.green,
      },
      qa: {
        bgColor: SOLARIZED_COLORS.yellow,
        fgColor: SOLARIZED_COLORS.base3,
        accentColor: SOLARIZED_COLORS.yellow,
      },
    },
  },
};

export const ROLE_COLOR_THEMES = THEME_PALETTES.system.roleThemes;

export function getRoleTheme(
  role: ActorRole,
  theme: SupportedTheme = 'system',
): RoleColorTheme {
  const palette = THEME_PALETTES[theme] ?? THEME_PALETTES.system;
  return (
    palette.roleThemes[role] ?? {
      bgColor: 'cyan',
      fgColor: 'black',
      accentColor: 'cyan',
    }
  );
}

export function applyTerminalThemeOsc(theme: SupportedTheme): void {
  if (!process.stdout.isTTY) return;
  if (theme === 'solarized-dark') {
    process.stdout.write(
      `\x1b]11;${SOLARIZED_COLORS.base03}\x07\x1b]10;${SOLARIZED_COLORS.base0}\x07`,
    );
  } else if (theme === 'solarized-light') {
    process.stdout.write(
      `\x1b]11;${SOLARIZED_COLORS.base3}\x07\x1b]10;${SOLARIZED_COLORS.base00}\x07`,
    );
  } else {
    process.stdout.write('\x1b]111\x07\x1b]110\x07');
  }
}

export interface AvailableAgentInfo {
  role: ActorRole;
  title: string;
  description: { es: string; en: string };
  icon: string;
}

export const AVAILABLE_AGENTS: AvailableAgentInfo[] = [
  {
    role: 'architect',
    title: 'Software Architect',
    description: {
      es: 'Diseño de arquitectura, especificaciones (ARCH-001) y contratos',
      en: 'Architecture design, formal specifications (ARCH-001) and contracts',
    },
    icon: '📐',
  },
  {
    role: 'developer',
    title: 'Senior Developer',
    description: {
      es: 'Implementación sobre especificaciones aprobadas en sandbox Linux',
      en: 'Software implementation on approved specs inside Linux sandbox',
    },
    icon: '💻',
  },
  {
    role: 'qa',
    title: 'Independent QA Engineer',
    description: {
      es: 'Validación independiente, ejecución de tests y control de calidad',
      en: 'Independent validation, test execution and quality verdicts',
    },
    icon: '🧪',
  },
  {
    role: 'pm',
    title: 'Project Manager (PM)',
    description: {
      es: 'Coordinación del equipo, consultas cruzadas y reportes de estado',
      en: 'Team coordination, cross-agent inquiries and status reporting',
    },
    icon: '📋',
  },
];

const PEER_ROLES_PER_EXPERT: Record<
  ActorRole,
  { role: ActorRole; label: string }[]
> = {
  pm: [
    { role: 'architect', label: 'ARQ' },
    { role: 'developer', label: 'DEV' },
    { role: 'qa', label: 'QA' },
  ],
  architect: [
    { role: 'developer', label: 'DEV' },
    { role: 'qa', label: 'QA' },
    { role: 'pm', label: 'PM' },
  ],
  developer: [
    { role: 'architect', label: 'ARQ' },
    { role: 'pm', label: 'PM' },
    { role: 'qa', label: 'QA' },
  ],
  qa: [
    { role: 'architect', label: 'ARQ' },
    { role: 'developer', label: 'DEV' },
    { role: 'pm', label: 'PM' },
  ],
};

function fitAndPadLine(text: string, width: number): string {
  const safeWidth = Math.max(10, width);
  const oneLine = text.replace(/\s+/g, ' ');
  if (oneLine.length > safeWidth) {
    return `${oneLine.slice(0, safeWidth - 2)}..`;
  }
  return oneLine.padEnd(safeWidth, ' ');
}

function formatInteractionLine(
  label: string,
  count: number,
  width: number,
): string {
  const paddedRole = label.padEnd(3, ' ');
  const fullText = ` ${paddedRole} Interactions: ${count}`;
  if (fullText.length <= width) {
    return fullText.padEnd(width, ' ');
  }
  const shortText = ` ${paddedRole} Inter.: ${count}`;
  if (shortText.length <= width) {
    return shortText.padEnd(width, ' ');
  }
  return ` ${paddedRole}: ${count}`.padEnd(width, ' ');
}

export const CommandCenterApp: React.FC<CommandCenterProps> = ({
  orchestrator,
  initialProject,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const stdinCtx = useStdin() as ReturnType<typeof useStdin> & {
    internal_eventEmitter?: NodeJS.EventEmitter;
  };
  const { stdin, internal_eventEmitter } = stdinCtx;

  const initialSettings = orchestrator.storage.getSettings();
  const [language, setLanguage] = useState<SupportedLanguage>(
    initialSettings.language,
  );
  const [theme, setTheme] = useState<SupportedTheme>(
    initialSettings.theme ?? 'system',
  );
  const [workDir, setWorkDir] = useState<string>(initialSettings.workDir);
  const [settingsRowIdx, setSettingsRowIdx] = useState<number>(0);
  const [isEditingWorkDir, setIsEditingWorkDir] = useState<boolean>(false);
  const [workDirDraft, setWorkDirDraft] = useState<string>(
    initialSettings.workDir,
  );
  const t = I18N_DICTIONARY[language];

  const themePalette = useMemo(
    () => THEME_PALETTES[theme] ?? THEME_PALETTES.system,
    [theme],
  );

  const applyThemeChange = (nextTheme: SupportedTheme) => {
    orchestrator.storage.updateSettings({ theme: nextTheme });
    setTheme(nextTheme);
    applyTerminalThemeOsc(nextTheme);
    setStatusBanner(t.themeSavedMsg(nextTheme));
  };

  useEffect(() => {
    applyTerminalThemeOsc(theme);
    return () => {
      applyTerminalThemeOsc('system');
    };
  }, [theme]);

  const [dimensions, setDimensions] = useState<{ columns: number; rows: number }>({
    columns: stdout?.columns ?? 120,
    rows: stdout?.rows ?? 36,
  });
  const safeViewportHeight = Math.max(18, dimensions.rows - 1);

  // View mode: 'startup' (OpenCode-like centered logo + prompt), 'chat' (2-column chat + info sidebar), 'multipanel'
  const [viewMode, setViewMode] = useState<'startup' | 'chat' | 'multipanel'>('startup');
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isHelpOpen, setIsHelpOpen] = useState<boolean>(false);
  const [isHowtoOpen, setIsHowtoOpen] = useState<boolean>(false);
  const [howtoScrollOffset, setHowtoScrollOffset] = useState<number>(0);
  const [isExitConfirmOpen, setIsExitConfirmOpen] = useState<boolean>(false);
  const [dbModalOutput, setDbModalOutput] = useState<string>('');

  // Active project & repository / artifact / SQLite summary state
  const [project, setProject] = useState<Project | null>(initialProject ?? null);
  const currentProjectIdRef = useRef<string | undefined>(initialProject?.id);
  useEffect(() => {
    currentProjectIdRef.current = project?.id;
  }, [project?.id]);

  // Interactive Floating Repository Code Tree Explorer Modal (Shift-T / /tree)
  const [isTreeExplorerOpen, setIsTreeExplorerOpen] = useState<boolean>(false);
  const [treeWidthAdjustment, setTreeWidthAdjustment] = useState<number>(0);
  const treeWorkspaceDir = project?.workspaceDir || workDir;
  const treeState = useFileTree(treeWorkspaceDir, Math.max(8, safeViewportHeight - 8));
  const treeExplorerWidth = Math.min(
    108,
    Math.max(68, Math.min(dimensions.columns - 6, 88 + treeWidthAdjustment)),
  );
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [activeRole, setActiveRole] = useState<ActorRole>('architect');
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [expertSummaries, setExpertSummaries] = useState<ExpertChatSummary[]>(
    [],
  );

  // Interactive New Project Creation Wizard (/project)
  const [projectWizardStep, setProjectWizardStep] = useState<
    'CLOSED' | 'ASK_NAME' | 'ASK_DIR'
  >('CLOSED');
  const [pendingProjectName, setPendingProjectName] = useState<string>('');
  const [wizardInput, setWizardInput] = useState<string>('');

  // Interactive Projects List & Switcher Modal (/projects or /switch)
  const [isProjectsModalOpen, setIsProjectsModalOpen] =
    useState<boolean>(false);
  const [selectedProjectIdx, setSelectedProjectIdx] = useState<number>(0);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  // Interactive Active Agent Selector Modal (/agents)
  const [isAgentsModalOpen, setIsAgentsModalOpen] = useState<boolean>(false);
  const [selectedAgentIdx, setSelectedAgentIdx] = useState<number>(0);

  // Interactive System Prompts Inspector Modal (/system)
  const [isSystemModalOpen, setIsSystemModalOpen] = useState<boolean>(false);
  const [selectedSystemIdx, setSelectedSystemIdx] = useState<number>(0);
  const [systemViewDetail, setSystemViewDetail] = useState<'menu' | 'prompt' | 'locations'>('menu');
  const [systemViewingRole, setSystemViewingRole] = useState<ActorRole>('architect');
  const [systemPromptScrollOffset, setSystemPromptScrollOffset] = useState<number>(0);

  // Interactive Logs Viewer Modal (/logs)
  const [isLogsModalOpen, setIsLogsModalOpen] = useState<boolean>(false);
  const [logScrollOffset, setLogScrollOffset] = useState<number>(0);

  // Interactive OpenCode-style Per-Agent Model Picker Modal (/models)
  const [isModelsModalOpen, setIsModelsModalOpen] = useState<boolean>(false);
  const [modelsTargetRole, setModelsTargetRole] = useState<ActorRole | 'all'>(
    'architect',
  );
  const [modelsProviderTab, setModelsProviderTab] = useState<string>('all');
  const [modelsFilterQuery, setModelsFilterQuery] = useState<string>('');
  const [selectedModelIdx, setSelectedModelIdx] = useState<number>(0);
  const [roleConfigVersion, setRoleConfigVersion] = useState<number>(0);

  // Interactive OpenCode & Pi-style LLM Authentication Modal (/auth)
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [selectedAuthIdx, setSelectedAuthIdx] = useState<number>(0);

  // Interactive Persistent Workers Inspector Modal (/workers)
  const [isWorkersModalOpen, setIsWorkersModalOpen] = useState<boolean>(false);
  const [workersSelectedIdx, setWorkersSelectedIdx] = useState<number>(0);
  const [workersList, setWorkersList] = useState<WorkerStatusInfo[]>([]);
  const [isEditingAuthKey, setIsEditingAuthKey] = useState<boolean>(false);
  const [authKeyDraft, setAuthKeyDraft] = useState<string>('');
  const [authSubMode, setAuthSubMode] = useState<
    'none' | 'choose_method' | 'sso_form' | 'sso_waiting'
  >('none');
  const [authMethodIdx, setAuthMethodIdx] = useState<number>(0);
  const [ssoFieldIdx, setSsoFieldIdx] = useState<number>(0);
  const [ssoClientIdDraft, setSsoClientIdDraft] = useState<string>('');
  const [ssoClientSecretDraft, setSsoClientSecretDraft] = useState<string>('');
  const [ssoAuthUrl, setSsoAuthUrl] = useState<string>('');
  const [ssoError, setSsoError] = useState<string>('');
  const ssoSessionRef = useRef<OidcLoginSession | null>(null);

  // Prompt input, slash command menu & mouse scroll state
  const [inputValue, setInputValue] = useState<string>('');
  const inputValueRef = useRef<string>('');
  const roleDraftsRef = useRef<Partial<Record<ActorRole, string>>>({});
  const activeRoleRef = useRef<ActorRole>(activeRole);
  activeRoleRef.current = activeRole;
  const [selectedSlashIdx, setSelectedSlashIdx] = useState<number>(0);
  const [messageScrollOffset, setMessageScrollOffset] = useState<number>(0);
  const [chatScrollOffset, setChatScrollOffset] = useState<number>(0);
  const chatMaxScrollRef = useRef<number>(0);
  const chatViewportHeightRef = useRef<number>(10);
  const [messagesVersion, setMessagesVersion] = useState<number>(0);
  const [busyRoles, setBusyRoles] = useState<Partial<Record<ActorRole, boolean>>>({});
  const [streamingByRole, setStreamingByRole] = useState<Partial<Record<ActorRole, string>>>({});
  const [roleDrafts, setRoleDrafts] = useState<Partial<Record<ActorRole, string>>>({});
  const [statusBanner, setStatusBanner] = useState<string>(t.initialStatusBanner);
  const [queuedMessageIds, setQueuedMessageIds] = useState<Set<string>>(new Set());

  const activeRoleQueuedCount = useMemo(() => {
    if (!project) return 0;
    return orchestrator.getQueuedMessages(project.id, activeRole).length;
  }, [orchestrator, project?.id, activeRole, queuedMessageIds, messagesVersion]);

  const isAnyRoleBusy = useMemo(
    () => Object.values(busyRoles).some(Boolean),
    [busyRoles],
  );
  const isActiveRoleBusy = Boolean(busyRoles[activeRole]);
  const activeStreamingText = streamingByRole[activeRole] || '';
  const activeStreamResult = useMemo(
    () => filterToolingStream(activeStreamingText),
    [activeStreamingText],
  );

  // Animated thinking spinner frames: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
  const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [spinnerIdx, setSpinnerIdx] = useState<number>(0);

  const hasAnyThinkingRole = useMemo(() => {
    return Object.keys(busyRoles).some((r) => {
      const role = r as ActorRole;
      return busyRoles[role] && !streamingByRole[role];
    });
  }, [busyRoles, streamingByRole]);

  useEffect(() => {
    if (!hasAnyThinkingRole) return;
    const interval = setInterval(() => {
      setSpinnerIdx((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(interval);
  }, [hasAnyThinkingRole]);

  // FIFO Queue event subscriptions
  useEffect(() => {
    const onQueued = (payload: {
      projectId: string;
      role: ActorRole;
      messageId: string;
      queueLength: number;
    }) => {
      if (currentProjectIdRef.current === payload.projectId) {
        setQueuedMessageIds((prev) => new Set(prev).add(payload.messageId));
        setBusyRoles((prev) => ({ ...prev, [payload.role]: true }));
        setMessagesVersion((prev) => prev + 1);
      }
    };
    const onDequeued = (payload: {
      projectId: string;
      role: ActorRole;
      messageId: string;
      remainingQueueLength: number;
    }) => {
      if (currentProjectIdRef.current === payload.projectId) {
        setQueuedMessageIds((prev) => {
          const next = new Set(prev);
          next.delete(payload.messageId);
          return next;
        });
        setBusyRoles((prev) => ({ ...prev, [payload.role]: true }));
        setMessagesVersion((prev) => prev + 1);
      }
    };
    const onIdle = (payload: { projectId: string; role: ActorRole }) => {
      if (currentProjectIdRef.current === payload.projectId) {
        setBusyRoles((prev) => ({ ...prev, [payload.role]: false }));
        setMessagesVersion((prev) => prev + 1);
      }
    };

    orchestrator.on('agent:messageQueued', onQueued);
    orchestrator.on('agent:messageDequeued', onDequeued);
    orchestrator.on('agent:idle', onIdle);
    return () => {
      orchestrator.off('agent:messageQueued', onQueued);
      orchestrator.off('agent:messageDequeued', onDequeued);
      orchestrator.off('agent:idle', onIdle);
    };
  }, [orchestrator]);

  const thinkingSpinner = SPINNER_FRAMES[spinnerIdx];

  // Mouse text selection state for copying conversation lines to clipboard
  const [dragAnchor, setDragAnchor] = useState<{ x: number; y: number } | null>(null);
  const [selectionRange, setSelectionRange] = useState<{
    startY: number;
    endY: number;
    startX: number;
    endX: number;
  } | null>(null);
  const renderedConversationLinesRef = useRef<
    Array<{ y: number; minX: number; maxX: number; text: string; fullContent: string }>
  >([]);

  const refreshState = (targetProjectId?: string) => {
    const pid = targetProjectId ?? project?.id;
    const listed = orchestrator.storage.listProjects();
    setAllProjects(listed);
    if (!pid) {
      setArtifacts([]);
      setNotebooks([]);
      setExpertSummaries([]);
      return;
    }
    const updated = orchestrator.storage.getProject(pid);
    if (updated) setProject(updated);
    setArtifacts(orchestrator.storage.listArtifacts(pid, true));
    setNotebooks(orchestrator.storage.getProjectNotebooks(pid));
    setExpertSummaries(orchestrator.storage.listExpertChatSummaries(pid));
  };

  useEffect(() => {
    if (project?.id) {
      refreshState(project.id);
    } else {
      refreshState();
    }
    setMessageScrollOffset(0);
    setChatScrollOffset(0);
  }, [project?.id, activeRole]);

  useEffect(() => {
    if (viewMode === 'multipanel' && project?.id) {
      orchestrator.ensureCoreWorkers(project.id);
      refreshState(project.id);
    }
  }, [viewMode, project?.id]);

  // Enable SGR (1006) terminal mouse tracking + DEC Mode 2026 Synchronized Output
  // on stdout to eliminate screen-erase flicker when Ink redraws full-screen frames.
  useEffect(() => {
    if (!stdout || !stdout.isTTY) return;
    const origWrite = stdout.write.bind(stdout);
    const syncedWrite = ((
      chunk: Uint8Array | string,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      if (
        typeof chunk === 'string' &&
        (chunk.includes('\x1b[2K') || chunk.includes('\x1b[2J'))
      ) {
        const atomicFrame = `\x1b[?2026h${chunk}\x1b[?2026l`;
        return origWrite(atomicFrame, encodingOrCb as never, cb as never);
      }
      return origWrite(chunk, encodingOrCb as never, cb as never);
    }) as typeof stdout.write;

    stdout.write = syncedWrite;
    origWrite(ENABLE_MOUSE_TRACKING_SEQ);

    const restoreTerminal = () => {
      try {
        stdout.write = origWrite;
        origWrite(`${DISABLE_MOUSE_TRACKING_SEQ}\x1b[?2026l`);
      } catch {
        // Ignore write errors during process teardown
      }
    };
    process.on('exit', restoreTerminal);
    return () => {
      process.off('exit', restoreTerminal);
      restoreTerminal();
    };
  }, [stdout]);

  // Track terminal resize so fullscreen layout always fills 100% of terminal viewport
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setDimensions({
        columns: stdout.columns || 120,
        rows: stdout.rows || 36,
      });
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const cycleNextAgentRef = useRef<() => void>(() => {});
  const goToStartupWindowRef = useRef<() => void>(() => {});
  const lastRawInputRef = useRef<string>('');

  // Listen for raw CSI-u / xterm modifyOtherKeys Ctrl+Tab, Ctrl+N, Ctrl+A, Ctrl+H sequences via Ink's internal_eventEmitter
  // (avoids attaching a competing 'data' listener on stdin that conflicts with Ink's 'readable' loop)
  useEffect(() => {
    const emitter = internal_eventEmitter ?? stdin;
    if (!emitter) return;
    const eventName = internal_eventEmitter ? 'input' : 'data';
    const onRawData = (data: Buffer | string) => {
      const seq = typeof data === 'string' ? data : data.toString('utf8');
      lastRawInputRef.current = seq;

      if (
        seq === '\x0e' ||         // Ctrl+N raw
        seq === '\x1b[27;5;9~' || // xterm modifyOtherKeys Ctrl+Tab
        seq === '\x1b[9;5u' ||    // Kitty / CSI-u Ctrl+Tab
        seq === '\x1b[1;5I'       // VTE / GNOME Terminal Ctrl+Tab
      ) {
        cycleNextAgentRef.current();
        return;
      }

      // Check Ctrl+A / Ctrl+H across all terminal encodings (supports tmux, standard Linux, Kitty, xterm):
      // - '\x01': standard ASCII SOH produced by pressing Ctrl+a
      // - '\x1b[97;5u': Kitty / CSI-u Ctrl+a (97 is lowercase 'a', 5 is Ctrl modifier)
      // - '\x1b[27;5;97~': xterm modifyOtherKeys mode 2 Ctrl+a
      // - '\x1b[65;5u': Kitty / CSI-u Ctrl+A
      // - '\x1b[27;5;65~': xterm modifyOtherKeys Ctrl+A
      // - '\x08': standard ASCII BS (^H) produced by pressing Ctrl+h in Linux terminals
      // - '\x1b[104;5u': Kitty / CSI-u Ctrl+h (104 is lowercase 'h', 5 is Ctrl modifier)
      // - '\x1b[27;5;104~': xterm modifyOtherKeys mode 2 Ctrl+h
      // - '\x1b[104;5~': xterm Ctrl+h variant
      // - '\x1b[72;5u': Kitty / CSI-u Ctrl+H
      // - '\x1b[27;5;72~': xterm modifyOtherKeys Ctrl+H
      if (
        seq === '\x01' ||
        seq === '\x1b[97;5u' ||
        seq === '\x1b[27;5;97~' ||
        seq === '\x1b[65;5u' ||
        seq === '\x1b[27;5;65~' ||
        seq === '\x08' ||
        seq === '\x1b[104;5u' ||
        seq === '\x1b[27;5;104~' ||
        seq === '\x1b[104;5~' ||
        seq === '\x1b[72;5u' ||
        seq === '\x1b[27;5;72~'
      ) {
        goToStartupWindowRef.current();
        return;
      }
    };
    emitter.on(eventName, onRawData);
    return () => {
      emitter.off(eventName, onRawData);
    };
  }, [stdin, internal_eventEmitter]);

  const applyLanguageChange = (nextLang: SupportedLanguage) => {
    orchestrator.storage.updateSettings({ language: nextLang });
    setLanguage(nextLang);
    setStatusBanner(I18N_DICTIONARY[nextLang].settingsSavedMsg(nextLang));
  };

  const applyWorkDirChange = (nextDir: string) => {
    const trimmed = nextDir.trim();
    if (!trimmed) return;
    const updated = orchestrator.storage.updateSettings({ workDir: trimmed });
    setWorkDir(updated.workDir);
    setWorkDirDraft(updated.workDir);
    setStatusBanner(t.workDirSavedMsg(updated.workDir));
  };

  const closeAllModals = () => {
    setIsHelpOpen(false);
    setIsHowtoOpen(false);
    setHowtoScrollOffset(0);
    setIsSettingsOpen(false);
    setIsEditingWorkDir(false);
    setIsProjectsModalOpen(false);
    setIsAgentsModalOpen(false);
    setIsModelsModalOpen(false);
    setIsSystemModalOpen(false);
    setIsLogsModalOpen(false);
    setIsAuthModalOpen(false);
    setIsEditingAuthKey(false);
    setAuthKeyDraft('');
    setSystemViewDetail('menu');
    setSystemPromptScrollOffset(0);
    setLogScrollOffset(0);
    setIsExitConfirmOpen(false);
    setModelsProviderTab('all');
    setModelsFilterQuery('');
    setDbModalOutput('');
    setIsWorkersModalOpen(false);
    setIsTreeExplorerOpen(false);
    setProjectToDelete(null);
    setProjectWizardStep('CLOSED');
  };

  const goToStartupWindow = () => {
    closeAllModals();
    inputValueRef.current = '';
    setInputValue('');
    setViewMode('startup');
    setStatusBanner(
      language === 'es'
        ? 'Ventana principal (ejecuta comandos con / o escribe para chatear)'
        : 'Main window (run commands with / or type to chat)',
    );
  };
  goToStartupWindowRef.current = goToStartupWindow;

  const openModelsModal = (targetRole?: ActorRole | 'all') => {
    const resolvedTarget = targetRole ?? activeRole;
    closeAllModals();
    setModelsTargetRole(resolvedTarget);
    setModelsProviderTab('all');
    setModelsFilterQuery('');
    if (!project) {
      setSelectedModelIdx(0);
      setIsModelsModalOpen(true);
      return;
    }
    if (resolvedTarget !== 'all') {
      const currentCfg = orchestrator.storage.getRoleConfig(
        project.id,
        resolvedTarget,
      );
      const foundIdx = AVAILABLE_MODELS_CATALOG.findIndex(
        (m) =>
          m.provider === currentCfg.provider &&
          m.modelId === currentCfg.modelId,
      );
      setSelectedModelIdx(foundIdx >= 0 ? foundIdx : 0);
    } else {
      const cfgs = orchestrator.storage.listRoleConfigs(project.id);
      const first = cfgs[0];
      const allSame =
        first &&
        cfgs.every(
          (c) => c.provider === first.provider && c.modelId === first.modelId,
        );
      if (allSame && first) {
        const foundIdx = AVAILABLE_MODELS_CATALOG.findIndex(
          (m) => m.provider === first.provider && m.modelId === first.modelId,
        );
        setSelectedModelIdx(foundIdx >= 0 ? foundIdx : 0);
      } else {
        setSelectedModelIdx(0);
      }
    }
    setIsModelsModalOpen(true);
  };

  const applyModelSelection = (
    targetRole: ActorRole | 'all',
    entry: ModelCatalogEntry,
  ) => {
    if (!project) {
      setStatusBanner(
        language === 'es'
          ? 'No hay ningún proyecto activo para asignar modelos.'
          : 'No active project to assign models.',
      );
      return;
    }
    orchestrator.storage.assignModelToRole({
      projectId: project.id,
      role: targetRole,
      provider: entry.provider,
      modelId: entry.modelId,
      temperature: entry.defaultTemperature,
    });
    setRoleConfigVersion((v) => v + 1);
    refreshState();
    const targetLabel =
      targetRole === 'all'
        ? t.modelsAllAgentsLabel
        : getRoleDisplayName(targetRole, language);
    setStatusBanner(
      t.modelsAssignedMsg(targetLabel, entry.provider, entry.modelId),
    );
  };

  const filteredModels = useMemo(() => {
    let list = AVAILABLE_MODELS_CATALOG;
    if (modelsProviderTab !== 'all') {
      list = list.filter((m) => m.provider === modelsProviderTab);
    }
    const q = modelsFilterQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) =>
        m.modelId.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        m.providerLabel.toLowerCase().includes(q) ||
        m.recommendedFor.toLowerCase().includes(q) ||
        `${m.provider}/${m.modelId}`.toLowerCase().includes(q),
    );
  }, [modelsProviderTab, modelsFilterQuery]);

  const copyTextToClipboard = (text: string) => {
    if (!text) return;
    try {
      if (stdout && stdout.write) {
        const b64 = Buffer.from(text, 'utf8').toString('base64');
        stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    } catch {
      // Ignore terminal write errors
    }
    try {
      spawnSync('wl-copy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      // wl-copy not installed or non-wayland session
    }
    try {
      spawnSync('xclip', ['-selection', 'clipboard'], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      // xclip not installed or non-X11 session
    }
    setStatusBanner(t.copiedToClipboardMsg(text.length));
  };

  const createAndActivateProject = (rawName: string, rawDir: string) => {
    const cleanName = rawName.trim() || `Project-${Date.now()}`;
    const resolvedDir = path.resolve(
      process.cwd(),
      rawDir.trim() || path.join(workDir, 'workspaces', cleanName),
    );
    const created = orchestrator.createProject({
      name: cleanName,
      description: `Project '${cleanName}' managed by PO CLI in ${resolvedDir}`,
      workspaceDir: resolvedDir,
    });
    currentProjectIdRef.current = created.id;
    setProject(created);
    setBusyRoles({});
    setStreamingByRole({});
    setQueuedMessageIds(new Set());
    refreshState(created.id);
    setViewMode('chat');
    setStatusBanner(
      t.projectCreatedMsg(
        created.name,
        created.workspaceDir,
        created.repositories.length,
      ),
    );
  };

  const switchProjectTo = (nameOrId: string) => {
    try {
      const switched = orchestrator.storage.switchActiveProject(nameOrId);
      currentProjectIdRef.current = switched.id;
      setProject(switched);
      refreshState(switched.id);

      // Re-hydrate busy roles specifically for the switched project
      const nextBusy: Partial<Record<ActorRole, boolean>> = {};
      for (const r of ['architect', 'developer', 'qa', 'pm'] as ActorRole[]) {
        if (orchestrator.isRoleBusy(switched.id, r)) {
          nextBusy[r] = true;
        }
      }
      setBusyRoles(nextBusy);
      setStreamingByRole({});
      setQueuedMessageIds(new Set());

      // Find the last agent who interacted in this project to restore their conversation
      const allMsgs = orchestrator.storage.listMessages(switched.id);
      if (allMsgs.length > 0) {
        const last = allMsgs[allMsgs.length - 1];
        const role =
          last.fromRole === 'product_owner' ? last.toRole : last.fromRole;
        if (
          role &&
          role !== 'product_owner' &&
          ['architect', 'developer', 'qa', 'pm'].includes(role)
        ) {
          setActiveRole(role as ActorRole);
        }
      }
      setViewMode('chat');
      setStatusBanner(
        t.projectSwitchedMsg(switched.name, switched.workspaceDir),
      );
    } catch {
      setStatusBanner(t.projectNotFoundMsg(nameOrId));
    }
  };

  const isSlashMenuOpen =
    viewMode === 'startup' &&
    inputValue.startsWith('/') &&
    projectWizardStep === 'CLOSED' &&
    !isProjectsModalOpen &&
    !isAgentsModalOpen &&
    !isModelsModalOpen &&
    !isSystemModalOpen &&
    !isLogsModalOpen &&
    !isAuthModalOpen &&
    !isWorkersModalOpen &&
    !isHelpOpen &&
    !isHowtoOpen &&
    !isSettingsOpen &&
    !isExitConfirmOpen;
  const slashToken = inputValue.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const filteredSlashCommands = isSlashMenuOpen
    ? t.slashCommands
        .filter((cmd) => cmd.command.toLowerCase().startsWith(slashToken))
        .sort((a, b) => {
          const aExact = a.command.toLowerCase() === slashToken ? 0 : 1;
          const bExact = b.command.toLowerCase() === slashToken ? 0 : 1;
          return aExact - bExact;
        })
    : [];

  const executeCommandOrMessage = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;

    // Handle slash commands starting with "/"
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const cmdToken = parts[0].toLowerCase();
      if (cmdToken === '/tree' || cmdToken === '/explorer' || cmdToken === '/files') {
        inputValueRef.current = '';
        setInputValue('');
        setIsTreeExplorerOpen((prev) => !prev);
        return;
      }

      if (viewMode !== 'startup') {
        inputValueRef.current = '';
        setInputValue('');
        setStatusBanner(
          language === 'es'
            ? 'ℹ Para ejecutar comandos ve a la ventana principal con Esc o Ctrl+A.'
            : 'ℹ Commands must be executed from the main window. Press Esc or Ctrl+A.',
        );
        return;
      }
      inputValueRef.current = '';
      setInputValue('');

      if (cmdToken === '/exit' || cmdToken === '/quit' || cmdToken === '/q') {
        orchestrator.stopAllWorkers().finally(() => exit());
        return;
      }
      if (cmdToken === '/help' || cmdToken === '/h' || cmdToken === '/?') {
        const nextState = !isHelpOpen;
        closeAllModals();
        setIsHelpOpen(nextState);
        setStatusBanner(t.helpOpenedMsg);
        return;
      }
      if (cmdToken === '/howto' || cmdToken === '/guide' || cmdToken === '/workflow') {
        const nextState = !isHowtoOpen;
        closeAllModals();
        setIsHowtoOpen(nextState);
        setHowtoScrollOffset(0);
        setStatusBanner(t.howtoOpenedMsg);
        return;
      }
      if (cmdToken === '/project') {
        closeAllModals();
        // Support inline `/project <name> <directory>` or interactive wizard `/project`
        if (parts.length >= 3) {
          const inlineName = parts[1];
          const inlineDir = parts.slice(2).join(' ');
          createAndActivateProject(inlineName, inlineDir);
          return;
        }
        setPendingProjectName(parts[1] ?? '');
        if (parts[1]) {
          setProjectWizardStep('ASK_DIR');
          setWizardInput(path.join(workDir, 'workspaces', parts[1]));
        } else {
          setProjectWizardStep('ASK_NAME');
          setWizardInput('');
        }
        return;
      }
      if (cmdToken === '/projects') {
        const query = parts.slice(1).join(' ').trim();
        if (query) {
          closeAllModals();
          switchProjectTo(query);
          return;
        }
        const nextState = !isProjectsModalOpen;
        closeAllModals();
        const listed = orchestrator.storage.listProjects();
        setAllProjects(listed);
        const currentIdx = project
          ? Math.max(0, listed.findIndex((p) => p.id === project.id))
          : 0;
        setSelectedProjectIdx(currentIdx);
        setIsProjectsModalOpen(nextState);
        return;
      }
      if (cmdToken === '/settings') {
        const nextState = !isSettingsOpen;
        closeAllModals();
        const arg1 = parts[1]?.toLowerCase();
        const arg2 = parts[2]?.toLowerCase();
        if (
          (arg1 === 'dir' ||
            arg1 === 'workdir' ||
            arg1 === 'home' ||
            arg1 === 'folder') &&
          parts.length >= 3
        ) {
          applyWorkDirChange(parts.slice(2).join(' '));
          return;
        }
        if (arg1 === 'theme') {
          if (!arg2) {
            setWorkDirDraft(workDir);
            setSettingsRowIdx(1);
            setIsSettingsOpen(true);
            return;
          }
          if (arg2 === 'system') {
            applyThemeChange('system');
            return;
          }
          if (
            arg2 === 'solarized-light' ||
            arg2 === 'solarized_light' ||
            arg2 === 'light'
          ) {
            applyThemeChange('solarized-light');
            return;
          }
          if (
            arg2 === 'solarized-dark' ||
            arg2 === 'solarized_dark' ||
            arg2 === 'dark'
          ) {
            applyThemeChange('solarized-dark');
            return;
          }
          setStatusBanner(t.themeInvalidMsg(parts[2] ?? ''));
          return;
        }
        if (
          arg1 === 'system' ||
          arg1 === 'solarized-light' ||
          arg1 === 'solarized_light' ||
          arg1 === 'solarized-dark' ||
          arg1 === 'solarized_dark'
        ) {
          const normTheme: SupportedTheme =
            arg1.includes('light')
              ? 'solarized-light'
              : arg1.includes('dark')
                ? 'solarized-dark'
                : 'system';
          applyThemeChange(normTheme);
          return;
        }
        const requestedLang = arg1 === 'lang' ? arg2 : arg1;
        if (requestedLang === 'en' || requestedLang === 'english') {
          applyLanguageChange('en');
          return;
        }
        if (
          requestedLang === 'es' ||
          requestedLang === 'spanish' ||
          requestedLang === 'espanol'
        ) {
          applyLanguageChange('es');
          return;
        }
        setWorkDirDraft(workDir);
        setSettingsRowIdx(0);
        setIsSettingsOpen(nextState);
        return;
      }
      if (cmdToken === '/workers') {
        if (!project) {
          setStatusBanner(
            language === 'es'
              ? 'No hay ningún proyecto activo.'
              : 'No active project.',
          );
          return;
        }
        const subCmd = parts[1]?.toLowerCase();
        if (subCmd === 'restart') {
          const targetRole = (parts[2]?.toLowerCase() ?? activeRole) as ActorRole;
          orchestrator
            .restartWorker(project.id, targetRole)
            .then((info) => {
              setStatusBanner(
                language === 'es'
                  ? `Trabajador '${targetRole}' reiniciado (PID ${info.workerPid})`
                  : `Worker '${targetRole}' restarted (PID ${info.workerPid})`,
              );
            })
            .catch((err) => {
              setStatusBanner(`Error: ${(err as Error).message}`);
            });
          return;
        }
        if (subCmd === 'stop') {
          const targetRole = (parts[2]?.toLowerCase() ?? activeRole) as ActorRole;
          orchestrator
            .stopWorker(project.id, targetRole)
            .then(() => {
              setStatusBanner(
                language === 'es'
                  ? `Trabajador '${targetRole}' detenido.`
                  : `Worker '${targetRole}' stopped.`,
              );
            })
            .catch((err) => {
              setStatusBanner(`Error: ${(err as Error).message}`);
            });
          return;
        }

        // Open interactive Workers Modal
        orchestrator.ensureCoreWorkers(project.id);
        const workers = orchestrator.listWorkers(project.id);
        setWorkersList(workers);
        setWorkersSelectedIdx(0);
        closeAllModals();
        setIsWorkersModalOpen(true);
        return;
      }
      if (cmdToken === '/view') {
        setViewMode((prev) => (prev === 'multipanel' ? 'chat' : 'multipanel'));
        return;
      }
      if (cmdToken === '/agents' || cmdToken === '/agent') {
        const target = parts[1]?.toLowerCase();
        const found = AVAILABLE_AGENTS.find(
          (a) => a.role === target || a.title.toLowerCase().includes(target ?? ''),
        );
        if (target && found) {
          closeAllModals();
          switchActiveRole(found.role);
          setViewMode('chat');
          return;
        }
        closeAllModals();
        const currIdx = AVAILABLE_AGENTS.findIndex((a) => a.role === activeRole);
        setSelectedAgentIdx(currIdx >= 0 ? currIdx : 0);
        setIsAgentsModalOpen(true);
        return;
      }
      if (cmdToken === '/system' || cmdToken === '/sys') {
        closeAllModals();
        const subParam = parts[1]?.toLowerCase();
        if (subParam === 'location' || subParam === 'locations' || subParam === 'loc') {
          setSelectedSystemIdx(4);
          setSystemViewDetail('locations');
          setSystemPromptScrollOffset(0);
          setIsSystemModalOpen(true);
          return;
        }
        const roleMatch = ['architect', 'developer', 'qa', 'pm'].find((r) => r.startsWith(subParam ?? ''));
        if (subParam && roleMatch) {
          setSystemViewingRole(roleMatch as ActorRole);
          setSystemViewDetail('prompt');
          setSystemPromptScrollOffset(0);
          setIsSystemModalOpen(true);
          return;
        }
        setSelectedSystemIdx(0);
        setSystemViewDetail('menu');
        setSystemPromptScrollOffset(0);
        setIsSystemModalOpen(true);
        return;
      }
      if (cmdToken === '/logs' || cmdToken === '/log') {
        closeAllModals();
        const subParam = parts[1]?.toLowerCase();
        if (subParam === 'clear' || subParam === '-c') {
          Logger.clear();
          setStatusBanner(
            language === 'es'
              ? '✔ Logs de diagnóstico borrados'
              : '✔ Diagnostic logs cleared',
          );
          return;
        }
        if (subParam === 'path') {
          setStatusBanner(`📍 Log: ${Logger.getLogFilePath().replace(os.homedir(), '~')}`);
          return;
        }
        setLogScrollOffset(0);
        setIsLogsModalOpen(true);
        return;
      }
      if (cmdToken === '/auth') {
        closeAllModals();
        setIsAuthModalOpen(true);
        setSelectedAuthIdx(0);
        setIsEditingAuthKey(false);
        setAuthKeyDraft('');
        return;
      }
      if (cmdToken === '/clear') {
        setStreamingByRole({});
        setStatusBanner(t.statusClearedMsg);
        return;
      }
      if (cmdToken === '/architect') {
        switchActiveRole('architect');
        return;
      }
      if (cmdToken === '/developer') {
        switchActiveRole('developer');
        return;
      }
      if (cmdToken === '/qa') {
        switchActiveRole('qa');
        return;
      }
      const projectRequiredCommands = [
        '/pm',
        '/validate',
        '/accept',
        '/notebooks',
        '/compact',
      ];
      if (projectRequiredCommands.includes(cmdToken) && !project) {
        setStatusBanner(
          language === 'es'
            ? 'No hay ningún proyecto activo. Usa /project para crear uno.'
            : 'No active project. Use /project to create one.',
        );
        return;
      }
      if (cmdToken === '/pm') {
        switchActiveRole('pm');
        const modeArg = parts[1]?.toLowerCase();
        if (modeArg === 'parallel' || modeArg === 'sequential') {
          const targetPid = project!.id;
          setBusyRoles((prev) => ({ ...prev, pm: true }));
          const modality = modeArg === 'sequential' ? 'SEQUENTIAL' : 'PARALLEL';
          setStatusBanner(
            `⏳ PM running ${modality} inquiry across active agents...`,
          );
          try {
            const res = await orchestrator.executePmInquiry({
              projectId: targetPid,
              topic: parts.slice(2).join(' ') || 'Project status across all roles',
              modality,
            });
            if (currentProjectIdRef.current === targetPid) {
              setStatusBanner(
                `✔ PM emitted ${res.artifact.code} (${modality}): ${res.report.individualResponses.length} agents consulted.`,
              );
              refreshState();
            }
          } catch (err) {
            if (currentProjectIdRef.current === targetPid) {
              setStatusBanner(`✖ Error: ${(err as Error).message}`);
            }
          } finally {
            if (currentProjectIdRef.current === targetPid) {
              setBusyRoles((prev) => ({ ...prev, pm: false }));
            }
          }
          return;
        }
        return;
      }
      if (cmdToken === '/validate') {
        const targetPid = project!.id;
        setBusyRoles((prev) => ({ ...prev, qa: true }));
        switchActiveRole('qa');
        setStatusBanner(t.qaRunningMsg);
        try {
          const res = await orchestrator.submitToQaAndValidate({
            projectId: targetPid,
          });
          if (currentProjectIdRef.current === targetPid) {
            setStatusBanner(
              t.qaCompletedMsg(
                res.qaArtifact.code,
                res.payload.recommendation,
                res.payload.passedTests.length,
                res.payload.executedTests.length,
              ),
            );
            refreshState();
          }
        } catch (err) {
          if (currentProjectIdRef.current === targetPid) {
            setStatusBanner(`✖ Error: ${(err as Error).message}`);
          }
        } finally {
          if (currentProjectIdRef.current === targetPid) {
            setBusyRoles((prev) => ({ ...prev, qa: false }));
          }
        }
        return;
      }
      if (cmdToken === '/accept') {
        const targetPid = project!.id;
        try {
          orchestrator.acceptProjectByPo({
            projectId: targetPid,
            comments: 'Project finally accepted by the Product Owner.',
          });
          if (currentProjectIdRef.current === targetPid) {
            setStatusBanner(t.projectAcceptedMsg);
            refreshState();
          }
        } catch (err) {
          if (currentProjectIdRef.current === targetPid) {
            setStatusBanner(`✖ Error: ${(err as Error).message}`);
          }
        }
        return;
      }
      if (cmdToken === '/notebooks') {
        const targetPid = project!.id;
        const nbs = orchestrator.storage.getProjectNotebooks(targetPid);
        for (const nb of nbs) {
          orchestrator.rag.indexNotebook(nb.id);
        }
        if (currentProjectIdRef.current === targetPid) {
          refreshState();
          setStatusBanner(
            t.notebooksIndexedMsg(
              nbs.length,
              nbs.map((n) => n.name).join(', '),
            ),
          );
        }
        return;
      }
      if (cmdToken === '/compact') {
        const targetPid = project!.id;
        const targetArg = parts[1]?.toLowerCase();
        const targetRole =
          targetArg === 'all'
            ? 'all'
            : targetArg === 'architect' ||
                targetArg === 'developer' ||
                targetArg === 'qa' ||
                targetArg === 'pm'
              ? (targetArg as ActorRole)
              : activeRole;
        const res = orchestrator.compactContext({
          projectId: targetPid,
          targetRole,
          keepRecentCount: 1,
        });
        if (currentProjectIdRef.current === targetPid) {
          refreshState();
          setStatusBanner(
            t.compactedMsg(
              String(targetRole),
              res.totalCompactedMessages,
              res.totalSavedTokens,
            ),
          );
        }
        return;
      }
      if (cmdToken === '/models' || cmdToken === '/model') {
        const arg1 = parts[1]?.trim();
        const arg2 = parts.slice(2).join(' ').trim();
        const knownTargets = ['pm', 'architect', 'developer', 'qa', 'all'];

        if (!arg1) {
          if (isModelsModalOpen) {
            closeAllModals();
          } else {
            openModelsModal(activeRole);
          }
          return;
        }

        const arg1Lower = arg1.toLowerCase();
        // `/models <agent|all> <provider/model>`
        if (knownTargets.includes(arg1Lower) && arg2) {
          const resolved = resolveModelSpec(arg2);
          if (!resolved) {
            setStatusBanner(t.modelsNotFoundMsg(arg2));
            return;
          }
          applyModelSelection(arg1Lower as ActorRole | 'all', resolved);
          return;
        }

        // `/models <agent|all>` -> opens interactive picker targeting that agent
        if (knownTargets.includes(arg1Lower) && !arg2) {
          openModelsModal(arg1Lower as ActorRole | 'all');
          return;
        }

        // `/models <provider/model>` -> assigns directly to the active agent
        const inlineSpec = parts.slice(1).join(' ').trim();
        const resolved = resolveModelSpec(inlineSpec);
        if (resolved) {
          applyModelSelection(activeRole, resolved);
          return;
        }

        setStatusBanner(t.modelsNotFoundMsg(inlineSpec));
        return;
      }
      if (cmdToken === '/db') {
        closeAllModals();
        const queryArg = parts.slice(1).join(' ').trim() || '.stats';
        try {
          const out = executeDbCommandOrQuery(
            orchestrator.storage,
            queryArg,
            'table',
          );
          setDbModalOutput(out);
          setStatusBanner(
            `✔ SQLite query executed (${queryArg}). Also available in shell via: pocli db`,
          );
        } catch (err) {
          setStatusBanner(`✖ SQL Error: ${(err as Error).message}`);
        }
        return;
      }

      setStatusBanner(t.unknownCommandMsg(cmdToken));
      return;
    }

    // Non-command input entered on the main startup screen
    if (viewMode === 'startup') {
      inputValueRef.current = '';
      setInputValue('');
      setStatusBanner(
        language === 'es'
          ? 'ℹ La pantalla principal está reservada para comandos (inician con /). Usa Ctrl+N, Shift+Tab o /architect para conversar con un agente.'
          : 'ℹ The main screen is reserved for commands (starting with /). Use Ctrl+N, Shift+Tab, or /architect to chat with an agent.',
      );
      return;
    }

    // Normal conversation message sent to the currently active professional
    inputValueRef.current = '';
    setInputValue('');
    roleDraftsRef.current[activeRole] = '';
    setRoleDrafts((prev) => ({ ...prev, [activeRole]: '' }));
    void sendChatMessage(activeRole, trimmed);
  };

  const switchActiveRole = (nextRole: ActorRole) => {
    const currentRole = activeRoleRef.current;
    if (nextRole === currentRole) return;
    const currentDraft = inputValueRef.current.trim().startsWith('/') ? '' : inputValueRef.current;
    roleDraftsRef.current[currentRole] = currentDraft;
    setRoleDrafts((prev) => ({ ...prev, [currentRole]: currentDraft }));
    const nextDraft = roleDraftsRef.current[nextRole] || '';
    inputValueRef.current = nextDraft;
    setInputValue(nextDraft);
    setActiveRole(nextRole);
    activeRoleRef.current = nextRole;
    setMessageScrollOffset(0);
    setStatusBanner(
      t.activeInterlocutorMsg(getRoleDisplayName(nextRole, language)),
    );
  };

  const lastCycleTimeRef = useRef<number>(0);
  const cycleNextAgent = () => {
    const now = Date.now();
    if (now - lastCycleTimeRef.current < 150) return;
    lastCycleTimeRef.current = now;
    closeAllModals();
    const roles: ActorRole[] = ['pm', 'architect', 'developer', 'qa'];
    const currIdx = roles.indexOf(activeRole);
    const nextIdx = currIdx >= 0 ? (currIdx + 1) % roles.length : 0;
    const nextRole = roles[nextIdx];
    switchActiveRole(nextRole);
    if (viewMode !== 'chat') {
      setViewMode('chat');
    }
  };
  cycleNextAgentRef.current = cycleNextAgent;

  const sendChatMessage = async (
    targetRole: ActorRole,
    messageText: string,
    targetProjectId?: string,
    senderRole?: ActorRole | 'product_owner',
    existingMessageId?: string,
  ) => {
    const taskProjectId = targetProjectId ?? project?.id;
    if (!taskProjectId) {
      setStatusBanner(
        language === 'es'
          ? 'No hay ningún proyecto activo. Usa /project para crear uno.'
          : 'No active project. Use /project to create one.',
      );
      return;
    }

    const actualSenderRole = senderRole ?? 'product_owner';

    // 1. If not already recorded, immediately record prompt to SQLite so it appears in the chat log without delay
    const userMsg = existingMessageId
      ? { id: existingMessageId }
      : orchestrator.storage.recordMessage({
          projectId: taskProjectId,
          fromRole: actualSenderRole,
          toRole: targetRole,
          content: messageText,
        });
    if (currentProjectIdRef.current === taskProjectId) {
      setMessageScrollOffset(0);
      setChatScrollOffset(0);
      setMessagesVersion((prev) => prev + 1);
      refreshState();
    }

    const isBusy = orchestrator.isRoleBusy(taskProjectId, targetRole);
    if (isBusy) {
      if (currentProjectIdRef.current === taskProjectId) {
        setQueuedMessageIds((prev) => new Set(prev).add(userMsg.id));
        const currentQueueLen =
          orchestrator.getQueuedMessages(taskProjectId, targetRole).length + 1;
        setStatusBanner(
          language === 'es'
            ? `⏳ ${getRoleDisplayName(targetRole, language)} está procesando. Mensaje añadido a la cola (${currentQueueLen} en cola).`
            : `⏳ ${getRoleDisplayName(targetRole, language)} is thinking. Message added to queue (${currentQueueLen} queued).`,
        );
      }
    } else {
      if (currentProjectIdRef.current === taskProjectId) {
        setBusyRoles((prev) => ({ ...prev, [targetRole]: true }));
        setStreamingByRole((prev) => ({ ...prev, [targetRole]: '' }));
        setStatusBanner(t.consultingAgentMsg(targetRole));
      }
    }

    try {
      const res = await orchestrator.chatWithProfessional({
        projectId: taskProjectId,
        targetRole,
        message: messageText,
        messageId: userMsg.id,
        alreadyRecorded: true,
        senderRole: actualSenderRole,
        onStreamChunk: (chunk) => {
          if (currentProjectIdRef.current === taskProjectId) {
            setQueuedMessageIds((prev) => {
              if (prev.has(userMsg.id)) {
                const next = new Set(prev);
                next.delete(userMsg.id);
                return next;
              }
              return prev;
            });
            setBusyRoles((prev) => ({ ...prev, [targetRole]: true }));
            setStreamingByRole((prev) => ({
              ...prev,
              [targetRole]: (prev[targetRole] || '') + chunk,
            }));
          }
        },
      });
      if (currentProjectIdRef.current === taskProjectId) {
        setQueuedMessageIds((prev) => {
          if (prev.has(userMsg.id)) {
            const next = new Set(prev);
            next.delete(userMsg.id);
            return next;
          }
          return prev;
        });
        setStreamingByRole((prev) => {
          const next = { ...prev };
          delete next[targetRole];
          return next;
        });
        setStatusBanner(
          t.agentRepliedMsg(
            targetRole,
            res.workerPid,
            res.createdArtifacts.length,
          ),
        );
        setMessageScrollOffset(0);
        setChatScrollOffset(0);
        setMessagesVersion((prev) => prev + 1);
        refreshState();
      }

      if (res.autonomousHandoff) {
        const nextRole = res.autonomousHandoff.nextRole;
        const fromRole = res.autonomousHandoff.senderRole ?? targetRole;

        if (res.autonomousHandoff.alreadyDeliveredToArchitect) {
          if (currentProjectIdRef.current === taskProjectId) {
            switchActiveRole('architect');
            setMessageScrollOffset(0);
            setChatScrollOffset(0);
            setMessagesVersion((prev) => prev + 1);
            setStatusBanner(
              language === 'es'
                ? '📋 QA ha finalizado las pruebas e informado al Arquitecto con la tabla resumen.'
                : '📋 QA finished verification and reported the summary table to the Architect.',
            );
            refreshState();
          }
        } else {
          if (currentProjectIdRef.current === taskProjectId) {
            switchActiveRole(nextRole);
            if (nextRole === 'developer' && fromRole === 'qa') {
              setStatusBanner(
                language === 'es'
                  ? '🔄 QA detectó errores en las pruebas. Devolviendo al Desarrollador para corrección...'
                  : '🔄 QA detected test failures. Returning to Developer for correction...',
              );
            } else if (nextRole === 'qa') {
              setStatusBanner(
                language === 'es'
                  ? '🧪 El Desarrollador ha finalizado y notificado a QA. Ejecutando pruebas independientes...'
                  : '🧪 Developer finished and notified QA. Running independent verification tests...',
              );
            } else {
              setStatusBanner(
                language === 'es'
                  ? '🤝 El Arquitecto ha transferido el proyecto al Desarrollador. Iniciando implementación...'
                  : '🤝 Architect handed off project to Senior Developer. Starting implementation...',
              );
            }
            refreshState();
          }
          void sendChatMessage(
            nextRole,
            res.autonomousHandoff.instructions,
            taskProjectId,
            fromRole,
            res.autonomousHandoff.handoffMessageId,
          );
        }
      }
    } catch (err) {
      if (currentProjectIdRef.current === taskProjectId) {
        setQueuedMessageIds((prev) => {
          const next = new Set(prev);
          next.delete(userMsg.id);
          return next;
        });
        setStreamingByRole((prev) => {
          const next = { ...prev };
          delete next[targetRole];
          return next;
        });
        setBusyRoles((prev) => ({ ...prev, [targetRole]: false }));

        const rawMsg = (err as Error).message || String(err);
        const cleanMsg = rawMsg.replace(
          /^Worker JSON-RPC Error \(-?\d+\):\s*/,
          '',
        );

        const cfg = orchestrator.storage.getRoleConfig(taskProjectId, targetRole);
        const bannerText = cleanMsg.includes('API key')
          ? t.llmStatusBannerError(cfg.provider)
          : `✖ Error: ${cleanMsg}`;

        setStatusBanner(bannerText);

        // Record specialist's error response directly in the chat history
        orchestrator.storage.recordMessage({
          projectId: taskProjectId,
          fromRole: targetRole,
          toRole: 'product_owner',
          content: cleanMsg,
          metadata: {
            isError: true,
            errorReason: cleanMsg,
          },
        });
        setMessageScrollOffset(0);
        setChatScrollOffset(0);
        setMessagesVersion((prev) => prev + 1);
        refreshState();
      } else {
        orchestrator.storage.recordMessage({
          projectId: taskProjectId,
          fromRole: targetRole,
          toRole: 'product_owner',
          content: ((err as Error).message || String(err)).replace(
            /^Worker JSON-RPC Error \(-?\d+\):\s*/,
            '',
          ),
          metadata: {
            isError: true,
            errorReason: String(err),
          },
        });
      }
    } finally {
      if (currentProjectIdRef.current === taskProjectId) {
        const stillBusy = orchestrator.isRoleBusy(taskProjectId, targetRole);
        setBusyRoles((prev) => ({ ...prev, [targetRole]: stillBusy }));
        if (!stillBusy) {
          setStreamingByRole((prev) => {
            const next = { ...prev };
            delete next[targetRole];
            return next;
          });
        }
      }
    }
  };

  const selectRoleByMouse = (role: ActorRole) => {
    switchActiveRole(role);
  };

  const handleMouseEvent = (ev: ParsedMouseEvent) => {
    // 1. Handle Mouse Wheel Scrolling
    if (ev.action === 'wheel') {
      const isUp = ev.button === 'wheel-up';
      if (isTreeExplorerOpen) {
        if (isUp) {
          treeState.scrollUp(2);
        } else {
          treeState.scrollDown(2);
        }
        return;
      }
      if (isModelsModalOpen && filteredModels.length > 0) {
        setSelectedModelIdx((prev) =>
          isUp
            ? prev > 0
              ? prev - 1
              : filteredModels.length - 1
            : prev < filteredModels.length - 1
              ? prev + 1
              : 0,
        );
        return;
      }
      if (isProjectsModalOpen && allProjects.length > 0) {
        setSelectedProjectIdx((prev) =>
          isUp
            ? prev > 0
              ? prev - 1
              : allProjects.length - 1
            : prev < allProjects.length - 1
              ? prev + 1
              : 0,
        );
        return;
      }
      if (isAgentsModalOpen && AVAILABLE_AGENTS.length > 0) {
        setSelectedAgentIdx((prev) =>
          isUp
            ? prev > 0
              ? prev - 1
              : AVAILABLE_AGENTS.length - 1
            : prev < AVAILABLE_AGENTS.length - 1
              ? prev + 1
              : 0,
        );
        return;
      }
      if (isSystemModalOpen) {
        if (systemViewDetail === 'menu') {
          setSelectedSystemIdx((prev) =>
            isUp ? (prev > 0 ? prev - 1 : 4) : prev < 4 ? prev + 1 : 0,
          );
        } else if (systemViewDetail === 'prompt') {
          setSystemPromptScrollOffset((prev) =>
            isUp ? Math.max(0, prev - 2) : prev + 2,
          );
        }
        return;
      }
      if (isLogsModalOpen) {
        setLogScrollOffset((prev) => (isUp ? Math.max(0, prev - 2) : prev + 2));
        return;
      }
      if (isHowtoOpen) {
        setHowtoScrollOffset((prev) => (isUp ? Math.max(0, prev - 2) : prev + 2));
        return;
      }
      if (isAuthModalOpen && !isEditingAuthKey && authSubMode === 'none') {
        const count = AuthStorage.listProviders().length;
        setSelectedAuthIdx((prev) =>
          isUp ? (prev > 0 ? prev - 1 : count - 1) : prev < count - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (isSettingsOpen && !isEditingWorkDir) {
        setSettingsRowIdx((prev) =>
          isUp ? (prev > 0 ? prev - 1 : 2) : prev < 2 ? prev + 1 : 0,
        );
        return;
      }
      if (isSlashMenuOpen && filteredSlashCommands.length > 0) {
        setSelectedSlashIdx((prev) =>
          isUp
            ? prev > 0
              ? prev - 1
              : filteredSlashCommands.length - 1
            : prev < filteredSlashCommands.length - 1
              ? prev + 1
              : 0,
        );
        return;
      }

      // Scroll through conversation history with the active agent
      if (viewMode === 'chat') {
        const step = 3;
        setChatScrollOffset((prev) =>
          isUp
            ? Math.min(chatMaxScrollRef.current, prev + step)
            : Math.max(0, prev - step),
        );
        return;
      }

      const allMsgs = project
        ? orchestrator.storage.listMessages(project.id, activeRole)
        : [];
      const winSize = viewMode === 'multipanel' ? 4 : 3;
      const maxOffset = Math.max(0, allMsgs.length - winSize);
      setMessageScrollOffset((prev) =>
        isUp ? Math.min(maxOffset, prev + 1) : Math.max(0, prev - 1),
      );
      return;
    }

    // 2. Handle Left Mouse Button Click
    if (ev.button === 'left' && ev.action === 'press') {
      if (isTreeExplorerOpen) {
        const modalLeft = Math.max(1, Math.floor((dimensions.columns - treeExplorerWidth) / 2));
        if (ev.x >= modalLeft && ev.x <= modalLeft + treeExplorerWidth) {
          if (ev.y <= 6) {
            if (ev.x < modalLeft + Math.floor(treeExplorerWidth / 2)) {
              treeState.collapseAll();
            } else {
              treeState.expandAll();
            }
            return;
          }
          const itemIdx = treeState.scrollOffset + (ev.y - 7);
          if (itemIdx >= 0 && itemIdx < treeState.flatItems.length) {
            treeState.setSelectedIndex(itemIdx);
            treeState.toggleSelected();
          }
          return;
        }
      }

      // 2a. Interactive Models Modal Click Handler
      if (isModelsModalOpen) {
        const modalWidth = Math.max(96, Math.min(136, dimensions.columns - 4));
        const windowSize = Math.max(
          6,
          Math.min(12, Math.max(22, dimensions.rows - 1) - 18),
        );
        const modalHeight = windowSize + 14;
        const modalTop = Math.max(1, Math.floor((dimensions.rows - modalHeight) / 2)) + 1;
        const modalLeft = Math.max(1, Math.floor((dimensions.columns - modalWidth) / 2)) + 1;

        const relY = ev.y - modalTop;
        const relX = ev.x - modalLeft;

        // Click outside the modal closes it
        if (relY < 0 || relY >= modalHeight || relX < 0 || relX >= modalWidth) {
          setIsModelsModalOpen(false);
          setModelsFilterQuery('');
          return;
        }

        // Line 2: Agent Selector colored boxes (PM, ARQ, DEV, QA, ALL)
        // Rows relY around 4 (allow 3..5 for click area)
        if (relY >= 3 && relY <= 5) {
          const targetOptions = ['pm', 'architect', 'developer', 'qa', 'all'] as const;
          const tabWidth = 14;
          const totalBarWidth = 5 * (tabWidth + 2); // 80 cols
          const barStartX = 2 + Math.max(0, Math.floor((modalWidth - 4 - totalBarWidth) / 2));
          const btnOffset = relX - barStartX;
          if (btnOffset >= 0 && btnOffset < totalBarWidth) {
            const btnIdx = Math.floor(btnOffset / (tabWidth + 2));
            if (btnIdx >= 0 && btnIdx < targetOptions.length) {
              setModelsTargetRole(targetOptions[btnIdx]);
              return;
            }
          }
        }

        // Line 3: Provider Filter Tabs (ALL, OPENCODE ZEN, OPENROUTER, etc.)
        // Rows relY around 6..7
        if (relY >= 6 && relY <= 7) {
          const providerTabs = [
            { id: 'all', label: language === 'es' ? 'TODOS' : 'ALL' },
            { id: 'opencode', label: 'OPENCODE ZEN' },
            { id: 'openrouter', label: 'OPENROUTER' },
            { id: 'anthropic', label: 'ANTHROPIC' },
            { id: 'openai', label: 'OPENAI' },
            { id: 'gemini', label: 'GEMINI' },
            { id: 'groq', label: 'GROQ' },
            { id: 'ollama', label: 'OLLAMA' },
            { id: 'freellm', label: 'FREE/ZERO' },
          ];
          const totalTabsWidth = providerTabs.reduce(
            (sum, pt) => sum + pt.label.length + 3,
            0,
          );
          const tabsStartX =
            2 + Math.max(0, Math.floor((modalWidth - 4 - totalTabsWidth) / 2));

          let curX = tabsStartX;
          for (const pt of providerTabs) {
            const tabW = pt.label.length + 2;
            if (relX >= curX && relX < curX + tabW) {
              setModelsProviderTab(pt.id);
              setSelectedModelIdx(0);
              return;
            }
            curX += tabW + 1;
          }
        }

        // Line 5+: Model Catalog List rows starting at listStartY = 12
        const listStartY = 12;
        const startIdx = Math.max(
          0,
          Math.min(
            selectedModelIdx - Math.floor(windowSize / 2),
            Math.max(0, filteredModels.length - windowSize),
          ),
        );
        const visibleCount = Math.min(
          windowSize,
          filteredModels.length - startIdx,
        );

        if (relY >= listStartY && relY < listStartY + visibleCount) {
          const clickedRow = relY - listStartY;
          const targetModelIdx = startIdx + clickedRow;
          if (targetModelIdx >= 0 && targetModelIdx < filteredModels.length) {
            if (selectedModelIdx === targetModelIdx) {
              applyModelSelection(
                modelsTargetRole,
                filteredModels[targetModelIdx],
              );
            } else {
              setSelectedModelIdx(targetModelIdx);
            }
            return;
          }
        }

        return;
      }

      const rolesOrder = ['pm', 'architect', 'developer', 'qa'] as const;

      // Top Color Banner (single line, rows 1..2): clicking cycles to the next agent
      if (ev.y >= 1 && ev.y <= 2) {
        const currIdx = rolesOrder.indexOf(
          activeRole as (typeof rolesOrder)[number],
        );
        const nextRole =
          rolesOrder[(Math.max(0, currIdx) + 1) % rolesOrder.length];
        selectRoleByMouse(nextRole);
        return;
      }

      // Interactive Help, Howto, DB, Auth, or Exit Confirm modal: click closes modal
      if (isHelpOpen || isHowtoOpen || dbModalOutput.length > 0 || isExitConfirmOpen || (isAuthModalOpen && !isEditingAuthKey && authSubMode === 'none')) {
        setIsHelpOpen(false);
        setIsHowtoOpen(false);
        setHowtoScrollOffset(0);
        setDbModalOutput('');
        setIsExitConfirmOpen(false);
        setIsAuthModalOpen(false);
        return;
      }

      // Interactive Projects modal: click switches to selected project
      if (isProjectsModalOpen && allProjects.length > 0) {
        const chosen = allProjects[selectedProjectIdx] ?? allProjects[0];
        if (chosen) {
          setIsProjectsModalOpen(false);
          switchProjectTo(chosen.id);
        }
        return;
      }

      // Interactive Agents modal: click selects chosen agent and enters chat
      if (isAgentsModalOpen && AVAILABLE_AGENTS.length > 0) {
        const chosen =
          AVAILABLE_AGENTS[selectedAgentIdx] ?? AVAILABLE_AGENTS[0];
        if (chosen) {
          setIsAgentsModalOpen(false);
          setActiveRole(chosen.role);
          setViewMode('chat');
          setStatusBanner(
            t.activeInterlocutorMsg(getRoleDisplayName(chosen.role, language)),
          );
        }
        return;
      }

      // Interactive System Prompts modal in startup mode
      if (isSystemModalOpen) {
        if (systemViewDetail === 'menu') {
          if (selectedSystemIdx === 4) {
            setSystemViewDetail('locations');
            setSystemPromptScrollOffset(0);
          } else {
            const chosen = AVAILABLE_AGENTS[selectedSystemIdx] ?? AVAILABLE_AGENTS[0];
            setSystemViewingRole(chosen.role);
            setSystemViewDetail('prompt');
            setSystemPromptScrollOffset(0);
          }
        } else {
          setSystemViewDetail('menu');
          setSystemPromptScrollOffset(0);
        }
        return;
      }

      // Interactive Settings modal: click toggles language, theme, or opens workDir editor
      if (isSettingsOpen && !isEditingWorkDir) {
        if (settingsRowIdx === 0) {
          const nextLang: SupportedLanguage = language === 'en' ? 'es' : 'en';
          applyLanguageChange(nextLang);
        } else if (settingsRowIdx === 1) {
          const themeList: SupportedTheme[] = [
            'system',
            'solarized-light',
            'solarized-dark',
          ];
          const currIdx = themeList.indexOf(theme);
          const nextIdx = (currIdx + 1) % themeList.length;
          applyThemeChange(themeList[nextIdx]);
        } else {
          setWorkDirDraft(workDir);
          setIsEditingWorkDir(true);
        }
        return;
      }

      // Slash Command Popover: click executes selected slash command
      if (isSlashMenuOpen && filteredSlashCommands.length > 0) {
        const chosen =
          filteredSlashCommands[selectedSlashIdx] ?? filteredSlashCommands[0];
        if (chosen) {
          void executeCommandOrMessage(chosen.command);
        }
        return;
      }

      // Multipanel Control Panel: click on any of the 4 Expert Summary Boxes or Left Sidebar Team list
      if (viewMode === 'multipanel') {
        if (ev.y >= 5 && ev.y <= 13) {
          const colIdx = Math.min(
            3,
            Math.max(
              0,
              Math.floor(((ev.x - 1) / Math.max(1, dimensions.columns)) * 4),
            ),
          );
          selectRoleByMouse(rolesOrder[colIdx]);
          return;
        }

        // Left Sidebar: 1. Virtual Engineering Team list
        if (
          ev.x <= Math.floor(dimensions.columns * 0.44) &&
          ev.y >= 14 &&
          ev.y <= 19
        ) {
          const teamList = HarnessRegistry.listHarnesses();
          const rowIdx = ev.y - 15;
          if (rowIdx >= 0 && rowIdx < teamList.length) {
            selectRoleByMouse(teamList[rowIdx].role);
            return;
          }
        }
      }

      // 2l. Chat Scrollbar Click Jump
      if (
        viewMode === 'chat' &&
        !anyModalOpen &&
        ev.x >= unifiedChatBoxWidth - 2 &&
        ev.x <= unifiedChatBoxWidth + 1 &&
        ev.y >= 2 &&
        ev.y < 2 + chatViewportHeightRef.current
      ) {
        const clickRow = ev.y - 2;
        const newOffset = calculateScrollJump(
          clickRow,
          chatViewportHeightRef.current,
          chatMaxScrollRef.current,
        );
        setChatScrollOffset(newOffset);
        return;
      }

      // 3. Conversation Text Selection / Click Tracking
      // Check if click occurred on or near any rendered conversation lines
      const clickedLine = renderedConversationLinesRef.current.find(
        (l) => ev.y === l.y && ev.x >= l.minX && ev.x <= l.maxX,
      );
      if (clickedLine) {
        setDragAnchor({ x: ev.x, y: ev.y });
        setSelectionRange({
          startY: ev.y,
          endY: ev.y,
          startX: ev.x,
          endX: ev.x,
        });
        return;
      }
    }

    // 4. Handle Mouse Drag Movement (Button 1 Held Down)
    if (ev.action === 'move' && ev.button === 'left' && dragAnchor) {
      setSelectionRange({
        startY: Math.min(dragAnchor.y, ev.y),
        endY: Math.max(dragAnchor.y, ev.y),
        startX: dragAnchor.y <= ev.y ? dragAnchor.x : ev.x,
        endX: dragAnchor.y <= ev.y ? ev.x : dragAnchor.x,
      });
      return;
    }

    // 5. Handle Mouse Button Release (Finalize Selection & Copy to Clipboard)
    if (ev.action === 'release' && dragAnchor) {
      const startY = Math.min(dragAnchor.y, ev.y);
      const endY = Math.max(dragAnchor.y, ev.y);
      const isSingleClick = startY === endY && Math.abs(dragAnchor.x - ev.x) <= 1;

      const lines = renderedConversationLinesRef.current.filter(
        (l) => l.y >= startY && l.y <= endY,
      );

      if (lines.length > 0) {
        if (isSingleClick) {
          // Single click: copy the full message line / content cleanly
          const textToCopy = lines[0].fullContent || lines[0].text;
          copyTextToClipboard(textToCopy);
        } else {
          // Drag selection: extract text within the dragged region
          const selectedParts = lines.map((l) => {
            const charOffset = Math.max(0, Math.min(l.text.length, dragAnchor.x - l.minX));
            const endOffset = Math.max(0, Math.min(l.text.length, ev.x - l.minX));
            const from = Math.min(charOffset, endOffset);
            const to = Math.max(charOffset, endOffset);
            if (from === to) return l.text;
            return l.text.slice(from, to);
          });
          const textToCopy = selectedParts.join('\n').trim();
          if (textToCopy) {
            copyTextToClipboard(textToCopy);
          }
        }
      }

      setDragAnchor(null);
      // Keep selection highlight briefly visible then clear
      setTimeout(() => {
        setSelectionRange(null);
      }, 1800);
      return;
    }
  };

  useInput((input, key) => {
    // 0. Intercept SGR/X10 terminal mouse escape sequences so they trigger UI actions
    //    and never leak raw sequences into text prompt inputs
    if (isMouseSequence(input)) {
      const mouseEvents = parseMouseEvents(input);
      for (const ev of mouseEvents) {
        handleMouseEvent(ev);
      }
      return;
    }

    // Ctrl+A / Ctrl+H (or raw \x01 / \x08 / CSI-u / modifyOtherKeys) shortcut to return immediately to the main / startup window
    const rawSeq = lastRawInputRef.current;
    const isNavigationHome =
      rawSeq === '\x01' ||
      rawSeq === '\x1b[97;5u' ||
      rawSeq === '\x1b[27;5;97~' ||
      rawSeq === '\x1b[65;5u' ||
      rawSeq === '\x1b[27;5;65~' ||
      (key.ctrl && (input === 'a' || input === 'A' || input === '\x01')) ||
      rawSeq === '\x08' ||
      rawSeq === '\x1b[104;5u' ||
      rawSeq === '\x1b[27;5;104~' ||
      rawSeq === '\x1b[104;5~' ||
      rawSeq === '\x1b[72;5u' ||
      rawSeq === '\x1b[27;5;72~' ||
      (key.ctrl && (input === 'h' || input === 'H' || input === '\x08')) ||
      (key.backspace && !key.delete) ||
      (input === '\x08');

    if (isNavigationHome) {
      lastRawInputRef.current = '';
      goToStartupWindow();
      return;
    }

    // Shift-T shortcut to toggle the Left Code Tree Explorer Sidebar
    const isShiftT =
      !key.ctrl &&
      !key.meta &&
      ((key.shift && (input === 't' || input === 'T')) ||
        (input === 'T' && (inputValueRef.current === '' || isTreeExplorerOpen)) ||
        rawSeq === '\x1b[84;2u' ||
        rawSeq === '\x1b[116;2u' ||
        rawSeq === '\x1b[27;2;84~' ||
        rawSeq === '\x1b[27;2;116~');

    // If Code Tree Explorer is currently open, handle its navigation and dismiss with Shift-T, Esc, or q
    if (isTreeExplorerOpen) {
      if (key.escape || isShiftT || input === 'q' || input === 'Q') {
        setIsTreeExplorerOpen(false);
        return;
      }
      if (key.upArrow) {
        treeState.navigateUp();
        return;
      }
      if (key.downArrow) {
        treeState.navigateDown();
        return;
      }
      if (key.leftArrow) {
        treeState.collapseOrParent();
        return;
      }
      if (key.rightArrow) {
        treeState.expandOrDescend();
        return;
      }
      if (key.return || input === ' ') {
        treeState.toggleSelected();
        return;
      }
      if (input === 'c' || input === 'C') {
        treeState.collapseAll();
        return;
      }
      if (input === 'e' || input === 'E') {
        treeState.expandAll();
        return;
      }
      if (input === 'r' || input === 'R') {
        treeState.refresh();
        return;
      }
      if (input === '+' || input === '=' || input === ']') {
        setTreeWidthAdjustment((prev) => Math.min(32, prev + 4));
        return;
      }
      if (input === '-' || input === '_' || input === '[') {
        setTreeWidthAdjustment((prev) => Math.max(-18, prev - 4));
        return;
      }
      // Consume all other keys so they do not leak into prompt while tree is focused
      return;
    }

    if (isShiftT && !anyModalOpen) {
      closeAllModals();
      setIsTreeExplorerOpen(true);
      treeState.refresh();
      return;
    }

    // 1. Handle New Project Creation Wizard (/project)
    if (projectWizardStep !== 'CLOSED') {
      if (key.escape) {
        setProjectWizardStep('CLOSED');
        setWizardInput('');
        return;
      }
      if (key.return) {
        if (projectWizardStep === 'ASK_NAME') {
          const chosenName = wizardInput.trim();
          if (!chosenName) return;
          setPendingProjectName(chosenName);
          setProjectWizardStep('ASK_DIR');
          setWizardInput(path.join(workDir, 'workspaces', chosenName));
          return;
        }
        if (projectWizardStep === 'ASK_DIR') {
          const chosenDir =
            wizardInput.trim() ||
            path.join(workDir, 'workspaces', pendingProjectName);
          setProjectWizardStep('CLOSED');
          setWizardInput('');
          createAndActivateProject(pendingProjectName, chosenDir);
          return;
        }
      }
      if (key.backspace || key.delete) {
        setWizardInput((prev) => prev.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        setWizardInput((prev) => prev + input);
      }
      return;
    }

    // 2. Handle Projects List & Switcher Modal (/projects or /switch)
    if (isProjectsModalOpen) {
      if (projectToDelete) {
        const lower = (input || '').toLowerCase();
        if (lower === 'y' || (language === 'es' && lower === 's')) {
          const target = projectToDelete;
          setProjectToDelete(null);
          try {
            const { renamedWorkspaceDir, newActiveProjectId } =
              orchestrator.deleteProject(target.id);
            const updatedProjects = orchestrator.storage.listProjects();
            setAllProjects(updatedProjects);
            if (project && project.id === target.id) {
              if (newActiveProjectId) {
                const nextActive =
                  orchestrator.storage.getProject(newActiveProjectId);
                setProject(nextActive ?? null);
              } else if (updatedProjects.length > 0) {
                setProject(updatedProjects[0]);
              } else {
                setProject(null);
              }
            }
            setSelectedProjectIdx((prev) =>
              Math.max(0, Math.min(prev, updatedProjects.length - 1)),
            );
            setStatusBanner(
              t.projectDeletedMsg(target.name, renamedWorkspaceDir),
            );
          } catch (err: any) {
            setStatusBanner(`✖ Error: ${err?.message ?? String(err)}`);
          }
          return;
        }
        if (lower === 'n' || key.escape || input === 'q') {
          setProjectToDelete(null);
          return;
        }
        return;
      }

      if (key.escape || input === 'q') {
        setIsProjectsModalOpen(false);
        setProjectToDelete(null);
        return;
      }
      if (key.upArrow && allProjects.length > 0) {
        setSelectedProjectIdx((prev) =>
          prev > 0 ? prev - 1 : allProjects.length - 1,
        );
        return;
      }
      if (key.downArrow && allProjects.length > 0) {
        setSelectedProjectIdx((prev) =>
          prev < allProjects.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (
        (input === 'd' || input === 'D' || key.delete) &&
        allProjects.length > 0
      ) {
        const target = allProjects[selectedProjectIdx] ?? allProjects[0];
        if (target) {
          setProjectToDelete(target);
        }
        return;
      }
      if (key.return && allProjects.length > 0) {
        const chosen = allProjects[selectedProjectIdx] ?? allProjects[0];
        if (chosen) {
          setIsProjectsModalOpen(false);
          setProjectToDelete(null);
          switchProjectTo(chosen.id);
        }
        return;
      }
      return;
    }

    // 2b. Handle Interactive Agent Selector Modal (/agents or Shift+Tab)
    if (isAgentsModalOpen) {
      if (key.escape || input === 'q') {
        setIsAgentsModalOpen(false);
        return;
      }
      if (key.upArrow) {
        setSelectedAgentIdx((prev) =>
          prev > 0 ? prev - 1 : AVAILABLE_AGENTS.length - 1,
        );
        return;
      }
      if (key.downArrow) {
        setSelectedAgentIdx((prev) =>
          prev < AVAILABLE_AGENTS.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (input === '1' || input === '2' || input === '3' || input === '4') {
        const numIdx = parseInt(input, 10) - 1;
        const chosen = AVAILABLE_AGENTS[numIdx];
        if (chosen) {
          setIsAgentsModalOpen(false);
          switchActiveRole(chosen.role);
          setViewMode('chat');
          return;
        }
      }
      if (key.return && AVAILABLE_AGENTS.length > 0) {
        const chosen =
          AVAILABLE_AGENTS[selectedAgentIdx] ?? AVAILABLE_AGENTS[0];
        if (chosen) {
          setIsAgentsModalOpen(false);
          switchActiveRole(chosen.role);
          setViewMode('chat');
        }
        return;
      }
      return;
    }

    // 2c. Handle Interactive System Prompts Modal (/system)
    if (isSystemModalOpen) {
      if (key.escape || input === 'q') {
        if (systemViewDetail !== 'menu') {
          setSystemViewDetail('menu');
          setSystemPromptScrollOffset(0);
        } else {
          setIsSystemModalOpen(false);
        }
        return;
      }

      if (systemViewDetail === 'menu') {
        if (key.upArrow) {
          setSelectedSystemIdx((prev) => (prev > 0 ? prev - 1 : 4));
          return;
        }
        if (key.downArrow) {
          setSelectedSystemIdx((prev) => (prev < 4 ? prev + 1 : 0));
          return;
        }
        if (input === '1' || input === '2' || input === '3' || input === '4') {
          const numIdx = parseInt(input, 10) - 1;
          const chosen = AVAILABLE_AGENTS[numIdx];
          if (chosen) {
            setSelectedSystemIdx(numIdx);
            setSystemViewingRole(chosen.role);
            setSystemViewDetail('prompt');
            setSystemPromptScrollOffset(0);
            return;
          }
        }
        if (input === '5') {
          setSelectedSystemIdx(4);
          setSystemViewDetail('locations');
          setSystemPromptScrollOffset(0);
          return;
        }
        if (key.return) {
          if (selectedSystemIdx === 4) {
            setSystemViewDetail('locations');
            setSystemPromptScrollOffset(0);
          } else {
            const chosen =
              AVAILABLE_AGENTS[selectedSystemIdx] ?? AVAILABLE_AGENTS[0];
            setSystemViewingRole(chosen.role);
            setSystemViewDetail('prompt');
            setSystemPromptScrollOffset(0);
          }
          return;
        }
      } else if (systemViewDetail === 'prompt') {
        if (key.upArrow) {
          setSystemPromptScrollOffset((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSystemPromptScrollOffset((prev) => prev + 1);
          return;
        }
        if (key.pageUp) {
          setSystemPromptScrollOffset((prev) => Math.max(0, prev - 6));
          return;
        }
        if (key.pageDown) {
          setSystemPromptScrollOffset((prev) => prev + 6);
          return;
        }
        if (input === 'g') {
          setSystemPromptScrollOffset(0);
          return;
        }
        if (key.return) {
          setSystemViewDetail('menu');
          setSystemPromptScrollOffset(0);
          return;
        }
      } else {
        if (key.return) {
          setSystemViewDetail('menu');
          setSystemPromptScrollOffset(0);
          return;
        }
      }
      return;
    }

    // 2d. Handle Interactive Logs Viewer Modal (/logs)
    if (isLogsModalOpen) {
      if (key.escape || input === 'q') {
        setIsLogsModalOpen(false);
        setLogScrollOffset(0);
        return;
      }
      if (key.upArrow) {
        setLogScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setLogScrollOffset((prev) => prev + 1);
        return;
      }
      if (key.pageUp) {
        setLogScrollOffset((prev) => Math.max(0, prev - 8));
        return;
      }
      if (key.pageDown) {
        setLogScrollOffset((prev) => prev + 8);
        return;
      }
      if (input === 'g') {
        setLogScrollOffset(0);
        return;
      }
      if (input === 'c') {
        Logger.clear();
        setLogScrollOffset(0);
        return;
      }
      if (key.return) {
        setIsLogsModalOpen(false);
        setLogScrollOffset(0);
        return;
      }
      return;
    }

    // 2e. Handle OpenCode-style Per-Agent Model Picker Modal (/models or Ctrl+O)
    if (isModelsModalOpen) {
      if (key.escape) {
        setIsModelsModalOpen(false);
        setModelsFilterQuery('');
        return;
      }

      const providerTabList = [
        'all',
        'opencode',
        'openrouter',
        'anthropic',
        'openai',
        'gemini',
        'groq',
        'ollama',
        'freellm',
      ];
      if (key.tab) {
        const currTabIdx = providerTabList.indexOf(modelsProviderTab);
        const nextTabIdx = (currTabIdx + 1) % providerTabList.length;
        setModelsProviderTab(providerTabList[nextTabIdx]);
        setSelectedModelIdx(0);
        return;
      }

      const targetOptions = ['pm', 'architect', 'developer', 'qa', 'all'] as const;
      if (key.leftArrow || key.rightArrow) {
        const currIdx = Math.max(
          0,
          targetOptions.indexOf(
            modelsTargetRole as (typeof targetOptions)[number],
          ),
        );
        const delta = key.leftArrow ? -1 : 1;
        const nextTarget =
          targetOptions[
            (currIdx + delta + targetOptions.length) % targetOptions.length
          ];
        setModelsTargetRole(nextTarget);
        if (!modelsFilterQuery && project) {
          if (nextTarget !== 'all') {
            const cfg = orchestrator.storage.getRoleConfig(
              project.id,
              nextTarget,
            );
            const foundIdx = AVAILABLE_MODELS_CATALOG.findIndex(
              (m) => m.provider === cfg.provider && m.modelId === cfg.modelId,
            );
            if (foundIdx >= 0) setSelectedModelIdx(foundIdx);
          } else {
            const cfgs = orchestrator.storage.listRoleConfigs(project.id);
            const first = cfgs[0];
            const allSame =
              first &&
              cfgs.every(
                (c) =>
                  c.provider === first.provider && c.modelId === first.modelId,
              );
            if (allSame && first) {
              const foundIdx = AVAILABLE_MODELS_CATALOG.findIndex(
                (m) =>
                  m.provider === first.provider && m.modelId === first.modelId,
              );
              if (foundIdx >= 0) setSelectedModelIdx(foundIdx);
            }
          }
        }
        return;
      }

      if (key.upArrow && filteredModels.length > 0) {
        setSelectedModelIdx((prev) =>
          prev > 0 ? prev - 1 : filteredModels.length - 1,
        );
        return;
      }
      if (key.downArrow && filteredModels.length > 0) {
        setSelectedModelIdx((prev) =>
          prev < filteredModels.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (key.return && filteredModels.length > 0) {
        const chosen =
          filteredModels[selectedModelIdx] ?? filteredModels[0];
        if (chosen) {
          applyModelSelection(modelsTargetRole, chosen);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setModelsFilterQuery((prev) => prev.slice(0, -1));
        setSelectedModelIdx(0);
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        setModelsFilterQuery((prev) => prev + input);
        setSelectedModelIdx(0);
      }
      return;
    }

    // 2f. Handle Interactive LLM Authentication Modal (/auth)
    if (isAuthModalOpen) {
      const providers = AuthStorage.listProviders();
      const count = providers.length;

      if (isEditingAuthKey) {
        if (key.escape) {
          setIsEditingAuthKey(false);
          setAuthKeyDraft('');
          return;
        }
        if (key.return) {
          const targetProv = providers[selectedAuthIdx];
          if (targetProv && authKeyDraft.trim().length > 0) {
            AuthStorage.setApiKey(targetProv.id, authKeyDraft.trim());
            setStatusBanner(
              language === 'es'
                ? `✔ Clave guardada para ${targetProv.name}`
                : `✔ Saved API key for ${targetProv.name}`,
            );
          }
          setIsEditingAuthKey(false);
          setAuthKeyDraft('');
          return;
        }
        if (key.backspace || key.delete) {
          setAuthKeyDraft((prev) => prev.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setAuthKeyDraft((prev) => prev + input);
          return;
        }
        return;
      }

      if (authSubMode === 'sso_waiting') {
        if (key.escape) {
          ssoSessionRef.current?.cancel();
          ssoSessionRef.current = null;
          setAuthSubMode('none');
          setSsoAuthUrl('');
          setStatusBanner(
            language === 'es'
              ? 'ℹ Autenticación SSO cancelada'
              : 'ℹ SSO authentication cancelled',
          );
          return;
        }
        if (input === 'o' && ssoAuthUrl) {
          openSystemBrowser(ssoAuthUrl);
          return;
        }
        return;
      }

      if (authSubMode === 'sso_form') {
        const targetProv = providers[selectedAuthIdx];
        if (key.escape) {
          setAuthSubMode('choose_method');
          setSsoError('');
          return;
        }
        if (key.tab || key.upArrow || key.downArrow) {
          setSsoFieldIdx((prev) => (prev === 0 ? 1 : 0));
          return;
        }
        if (key.return) {
          const clientId = ssoClientIdDraft.trim();
          const clientSecret = ssoClientSecretDraft.trim() || undefined;
          if (!clientId) {
            setSsoError(
              language === 'es'
                ? 'Introduce el OAuth Client ID de Google'
                : 'Enter the Google OAuth Client ID',
            );
            return;
          }
          if (targetProv) {
            AuthStorage.setOAuthClientConfig(targetProv.id, {
              clientId,
              clientSecret,
            });
            setSsoError('');
            setAuthSubMode('sso_waiting');
            const session = startGoogleOidcLogin({
              clientId,
              clientSecret,
              onAuthUrl: (url) => setSsoAuthUrl(url),
            });
            ssoSessionRef.current = session;
            session.promise
              .then((tokens) => {
                ssoSessionRef.current = null;
                AuthStorage.setOAuthCredentials(targetProv.id, {
                  clientId,
                  clientSecret,
                  accessToken: tokens.accessToken,
                  refreshToken: tokens.refreshToken,
                  idToken: tokens.idToken,
                  expiresAt: tokens.expiresAt,
                  email: tokens.email,
                  scope: tokens.scope,
                });
                setAuthSubMode('none');
                setSsoAuthUrl('');
                setStatusBanner(
                  language === 'es'
                    ? `✔ SSO autenticado para ${targetProv.name}${tokens.email ? ` (${tokens.email})` : ''}`
                    : `✔ SSO authenticated for ${targetProv.name}${tokens.email ? ` (${tokens.email})` : ''}`,
                );
              })
              .catch((err: unknown) => {
                ssoSessionRef.current = null;
                const msg = err instanceof Error ? err.message : String(err);
                if (!msg.includes('cancelled')) {
                  setSsoError(msg);
                  setAuthSubMode('sso_form');
                }
              });
          }
          return;
        }
        if (key.backspace || key.delete) {
          if (ssoFieldIdx === 0) {
            setSsoClientIdDraft((prev) => prev.slice(0, -1));
          } else {
            setSsoClientSecretDraft((prev) => prev.slice(0, -1));
          }
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          if (ssoFieldIdx === 0) {
            setSsoClientIdDraft((prev) => prev + input);
          } else {
            setSsoClientSecretDraft((prev) => prev + input);
          }
          return;
        }
        return;
      }

      if (authSubMode === 'choose_method') {
        const targetProv = providers[selectedAuthIdx];
        if (key.escape) {
          setAuthSubMode('none');
          return;
        }
        if (key.upArrow || key.downArrow || key.tab) {
          setAuthMethodIdx((prev) => (prev === 0 ? 1 : 0));
          return;
        }
        if (input === '1') {
          setAuthMethodIdx(0);
          if (targetProv) {
            setAuthKeyDraft(AuthStorage.getApiKey(targetProv.id) || '');
            setAuthSubMode('none');
            setIsEditingAuthKey(true);
          }
          return;
        }
        if (input === '2') {
          setAuthMethodIdx(1);
          if (targetProv) {
            const savedCfg = AuthStorage.getOAuthClientConfig(targetProv.id);
            setSsoClientIdDraft(savedCfg?.clientId ?? '');
            setSsoClientSecretDraft(savedCfg?.clientSecret ?? '');
            setSsoFieldIdx(0);
            setSsoError('');
            setAuthSubMode('sso_form');
          }
          return;
        }
        if (key.return) {
          if (targetProv) {
            if (authMethodIdx === 0) {
              setAuthKeyDraft(AuthStorage.getApiKey(targetProv.id) || '');
              setAuthSubMode('none');
              setIsEditingAuthKey(true);
            } else {
              const savedCfg = AuthStorage.getOAuthClientConfig(targetProv.id);
              setSsoClientIdDraft(savedCfg?.clientId ?? '');
              setSsoClientSecretDraft(savedCfg?.clientSecret ?? '');
              setSsoFieldIdx(0);
              setSsoError('');
              setAuthSubMode('sso_form');
            }
          }
          return;
        }
        return;
      }

      if (key.escape || input === 'q') {
        setIsAuthModalOpen(false);
        setIsEditingAuthKey(false);
        setAuthSubMode('none');
        setAuthKeyDraft('');
        return;
      }
      if (key.upArrow && count > 0) {
        setSelectedAuthIdx((prev) => (prev > 0 ? prev - 1 : count - 1));
        return;
      }
      if (key.downArrow && count > 0) {
        setSelectedAuthIdx((prev) => (prev < count - 1 ? prev + 1 : 0));
        return;
      }
      if (key.return || input === 'e') {
        const targetProv = providers[selectedAuthIdx];
        if (targetProv) {
          if (targetProv.supportsSso) {
            setAuthMethodIdx(targetProv.authMode === 'sso' ? 1 : 0);
            setAuthSubMode('choose_method');
          } else {
            const currentKey = AuthStorage.getApiKey(targetProv.id);
            setAuthKeyDraft(currentKey || '');
            setIsEditingAuthKey(true);
          }
        }
        return;
      }
      if (input === 'd' || input === 'x' || key.delete) {
        const targetProv = providers[selectedAuthIdx];
        if (targetProv) {
          const removed = AuthStorage.removeApiKey(targetProv.id);
          setStatusBanner(
            removed
              ? (language === 'es'
                  ? `✔ Clave eliminada para ${targetProv.name}`
                  : `✔ Removed API key for ${targetProv.name}`)
              : (language === 'es'
                  ? `ℹ No había clave guardada en disco`
                  : `ℹ No stored file key to remove`),
          );
        }
        return;
      }
      return;
    }

    // 3. Handle interactive Help or DB modal when open
    if (isHelpOpen || dbModalOutput.length > 0) {
      if (key.escape || key.return || input === 'q') {
        setIsHelpOpen(false);
        setDbModalOutput('');
        return;
      }
      return;
    }

    // 3b. Handle interactive Howto Workflow Guide modal when open
    if (isHowtoOpen) {
      if (key.escape || key.return || input === 'q') {
        setIsHowtoOpen(false);
        setHowtoScrollOffset(0);
        return;
      }
      if (key.upArrow) {
        setHowtoScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setHowtoScrollOffset((prev) => prev + 1);
        return;
      }
      if (key.pageUp) {
        setHowtoScrollOffset((prev) => Math.max(0, prev - 8));
        return;
      }
      if (key.pageDown) {
        setHowtoScrollOffset((prev) => prev + 8);
        return;
      }
      if (input === 'g') {
        setHowtoScrollOffset(0);
        return;
      }
      if (input === 'G') {
        setHowtoScrollOffset(9999);
        return;
      }
      return;
    }

    // 4. Handle interactive Settings modal when open
    if (isSettingsOpen) {
      if (isEditingWorkDir) {
        if (key.escape) {
          setIsEditingWorkDir(false);
          setWorkDirDraft(workDir);
          return;
        }
        if (key.return) {
          setIsEditingWorkDir(false);
          applyWorkDirChange(workDirDraft);
          return;
        }
        if (key.backspace || key.delete) {
          setWorkDirDraft((prev) => prev.slice(0, -1));
          return;
        }
        if (!key.ctrl && !key.meta && input) {
          setWorkDirDraft((prev) => prev + input);
        }
        return;
      }

      if (key.escape || input === 'q') {
        setIsSettingsOpen(false);
        return;
      }
      if (key.upArrow) {
        setSettingsRowIdx((prev) => (prev > 0 ? prev - 1 : 2));
        return;
      }
      if (key.downArrow) {
        setSettingsRowIdx((prev) => (prev < 2 ? prev + 1 : 0));
        return;
      }
      if (settingsRowIdx === 0) {
        if (input === '1') {
          applyLanguageChange('en');
          return;
        }
        if (input === '2') {
          applyLanguageChange('es');
          return;
        }
        if (key.leftArrow || key.rightArrow || key.return || input === ' ') {
          const nextLang: SupportedLanguage = language === 'en' ? 'es' : 'en';
          applyLanguageChange(nextLang);
          return;
        }
      } else if (settingsRowIdx === 1) {
        const themeList: SupportedTheme[] = [
          'system',
          'solarized-light',
          'solarized-dark',
        ];
        const currIdx = themeList.indexOf(theme);
        if (input === '1') {
          applyThemeChange('system');
          return;
        }
        if (input === '2') {
          applyThemeChange('solarized-light');
          return;
        }
        if (input === '3') {
          applyThemeChange('solarized-dark');
          return;
        }
        if (key.leftArrow) {
          const nextIdx = (currIdx - 1 + themeList.length) % themeList.length;
          applyThemeChange(themeList[nextIdx]);
          return;
        }
        if (key.rightArrow || key.return || input === ' ') {
          const nextIdx = (currIdx + 1) % themeList.length;
          applyThemeChange(themeList[nextIdx]);
          return;
        }
      } else if (settingsRowIdx === 2) {
        if (key.return || input === 'e' || input === ' ') {
          setWorkDirDraft(workDir);
          setIsEditingWorkDir(true);
          return;
        }
      }
      return;
    }

    // 5. Handle Exit Confirmation modal when open
    if (isExitConfirmOpen) {
      if (key.escape || input === 'n' || input === 'N') {
        setIsExitConfirmOpen(false);
        return;
      }
      if (
        key.return ||
        input === 'y' ||
        input === 'Y' ||
        input === 's' ||
        input === 'S'
      ) {
        orchestrator.stopAllWorkers().finally(() => exit());
        return;
      }
      return;
    }

    // 6. Handle interactive Persistent Workers modal (/workers)
    if (isWorkersModalOpen) {
      if (key.escape || input === 'q') {
        setIsWorkersModalOpen(false);
        return;
      }
      if (key.upArrow) {
        setWorkersSelectedIdx((prev) =>
          prev > 0 ? prev - 1 : Math.max(0, workersList.length - 1),
        );
        return;
      }
      if (key.downArrow) {
        setWorkersSelectedIdx((prev) =>
          prev < workersList.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (input === 'r' || input === 'R' || key.return) {
        const target = workersList[workersSelectedIdx];
        if (target && project) {
          orchestrator
            .restartWorker(project.id, target.role)
            .then(() => {
              setWorkersList(orchestrator.listWorkers(project.id));
              setStatusBanner(
                language === 'es'
                  ? `Trabajador '${target.role}' reiniciado.`
                  : `Worker '${target.role}' restarted.`,
              );
            })
            .catch((err) => {
              setStatusBanner(`Error: ${(err as Error).message}`);
            });
        }
        return;
      }
      if (input === 's' || input === 'S') {
        const target = workersList[workersSelectedIdx];
        if (target && project) {
          orchestrator
            .stopWorker(project.id, target.role)
            .then(() => {
              setWorkersList(orchestrator.listWorkers(project.id));
              setStatusBanner(
                language === 'es'
                  ? `Trabajador '${target.role}' detenido.`
                  : `Worker '${target.role}' stopped.`,
              );
            })
            .catch((err) => {
              setStatusBanner(`Error: ${(err as Error).message}`);
            });
        }
        return;
      }
      return;
    }

    // OpenCode Ctrl+O shortcut to open the Per-Agent Model Picker (/models)
    if (key.ctrl && input === 'o') {
      openModelsModal(activeRole);
      return;
    }

    // OpenCode Ctrl+P shortcut to toggle slash command popover menu in main window
    if (key.ctrl && input === 'p') {
      if (viewMode === 'startup') {
        setInputValue((prev) => (prev.startsWith('/') ? '' : '/'));
      } else {
        setStatusBanner(
          language === 'es'
            ? 'ℹ Para ejecutar comandos ve a la ventana principal con Esc o Ctrl+A.'
            : 'ℹ Commands must be executed from the main window. Press Esc or Ctrl+A.',
        );
      }
      return;
    }

    // Ctrl+N shortcut to cycle through agent chats in a carousel (pm -> architect -> developer -> qa -> pm)
    if (
      (key.ctrl && (input === 'n' || input === 'N' || input === '\x0e')) ||
      input === '\x0e' ||
      (key.tab && key.ctrl) ||
      input === '\x1b[27;5;9~' ||
      input === '[27;5;9~' ||
      input === '\x1b[9;5u' ||
      input === '[9;5u'
    ) {
      cycleNextAgent();
      return;
    }

    // ESC key navigation: clears input, goes to previous screen, or asks to exit on startup screen
    if (key.escape) {
      if (inputValue.length > 0) {
        inputValueRef.current = '';
        roleDraftsRef.current[activeRole] = '';
        setRoleDrafts((d) => ({ ...d, [activeRole]: '' }));
        setInputValue('');
        return;
      }
      if (viewMode === 'multipanel') {
        setViewMode('chat');
        return;
      }
      if (viewMode === 'chat') {
        setViewMode('startup');
        return;
      }
      if (viewMode === 'startup') {
        setIsExitConfirmOpen(true);
        return;
      }
      return;
    }

    // Shift+Tab opens the /agents selection dialog (matches OpenCode "shift+tab agents" footer)
    if (key.tab && key.shift) {
      closeAllModals();
      const currIdx = AVAILABLE_AGENTS.findIndex((a) => a.role === activeRole);
      setSelectedAgentIdx(currIdx >= 0 ? currIdx : 0);
      setIsAgentsModalOpen(true);
      return;
    }

    // Toggle between OpenCode chat view and Multipanel Command Center on Tab
    if (key.tab && !key.ctrl) {
      if (
        isSlashMenuOpen &&
        filteredSlashCommands.length > 0 &&
        !key.shift
      ) {
        const chosen =
          filteredSlashCommands[selectedSlashIdx] ?? filteredSlashCommands[0];
        if (chosen) {
          const next = `${chosen.command} `;
          inputValueRef.current = next;
          setInputValue(next);
        }
        return;
      }
      setViewMode((prev) => (prev === 'multipanel' ? 'chat' : 'multipanel'));
      return;
    }

    // Up / Down arrows navigate the "/" slash command popover when open
    if (key.upArrow && isSlashMenuOpen && filteredSlashCommands.length > 0) {
      setSelectedSlashIdx((prev) =>
        prev > 0 ? prev - 1 : filteredSlashCommands.length - 1,
      );
      return;
    }
    if (key.downArrow && isSlashMenuOpen && filteredSlashCommands.length > 0) {
      setSelectedSlashIdx((prev) =>
        prev < filteredSlashCommands.length - 1 ? prev + 1 : 0,
      );
      return;
    }

    // Chat view: keyboard scrolling navigation (PgUp, PgDn, Home, End, Up/Down arrows)
    if (viewMode === 'chat' && !isSlashMenuOpen && !anyModalOpen) {
      const pageStep = Math.max(1, chatViewportHeightRef.current - 2);

      if (key.pageUp || rawSeq === '\x1b[5~') {
        setChatScrollOffset((prev) =>
          Math.min(chatMaxScrollRef.current, prev + pageStep),
        );
        return;
      }
      if (key.pageDown || rawSeq === '\x1b[6~') {
        setChatScrollOffset((prev) => Math.max(0, prev - pageStep));
        return;
      }
      if (
        Boolean((key as any).home) ||
        rawSeq === '\x1b[H' ||
        rawSeq === '\x1b[1~' ||
        (key.ctrl && (input === 'u' || input === 'U'))
      ) {
        setChatScrollOffset(chatMaxScrollRef.current);
        return;
      }
      if (
        Boolean((key as any).end) ||
        rawSeq === '\x1b[F' ||
        rawSeq === '\x1b[4~' ||
        (key.ctrl && (input === 'd' || input === 'D'))
      ) {
        setChatScrollOffset(0);
        return;
      }
      if (
        key.upArrow &&
        (inputValue === '' || key.shift || chatScrollOffset > 0)
      ) {
        setChatScrollOffset((prev) =>
          Math.min(chatMaxScrollRef.current, prev + 1),
        );
        return;
      }
      if (
        key.downArrow &&
        (inputValue === '' || key.shift || chatScrollOffset > 0)
      ) {
        setChatScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
    }

    // Left / Right arrows navigate between agents in carousel mode inside Multipanel
    if (viewMode === 'multipanel' && !isSlashMenuOpen) {
      if (key.leftArrow) {
        const prevRole = getNextCarouselRole(activeRole, 'prev');
        switchActiveRole(prevRole);
        return;
      }
      if (key.rightArrow) {
        const nextRole = getNextCarouselRole(activeRole, 'next');
        switchActiveRole(nextRole);
        return;
      }
    }

    if (key.return) {
      if (
        isSlashMenuOpen &&
        filteredSlashCommands.length > 0 &&
        !inputValue.trim().includes(' ')
      ) {
        const chosen =
          filteredSlashCommands[selectedSlashIdx] ?? filteredSlashCommands[0];
        if (chosen) {
          void executeCommandOrMessage(chosen.command);
          return;
        }
      }
      void executeCommandOrMessage(inputValue);
      return;
    }

    if (key.backspace || key.delete) {
      setInputValue((prev) => {
        const next = prev.slice(0, -1);
        inputValueRef.current = next;
        roleDraftsRef.current[activeRole] = next;
        setRoleDrafts((d) => ({ ...d, [activeRole]: next }));
        return next;
      });
      if (selectedSlashIdx !== 0) setSelectedSlashIdx(0);
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      // Filter out raw unparsed escape sequences that terminals might emit
      if (
        input.startsWith('\x1b') ||
        (input.startsWith('[') &&
          (input.includes(';') ||
            input.endsWith('~') ||
            input.endsWith('u') ||
            input.endsWith('I')))
      ) {
        return;
      }
      setInputValue((prev) => {
        const next = prev + input;
        inputValueRef.current = next;
        roleDraftsRef.current[activeRole] = next;
        setRoleDrafts((d) => ({ ...d, [activeRole]: next }));
        return next;
      });
      if (selectedSlashIdx !== 0) setSelectedSlashIdx(0);
    }
  });

  const harnesses = useMemo(() => HarnessRegistry.listHarnesses(), []);
  const activeRoleDisplayName = getRoleDisplayName(activeRole, language);
  const activeTheme = getRoleTheme(activeRole, theme);
  const activeModelCfg = useMemo(() => {
    if (!project) {
      return {
        projectId: '',
        role: activeRole,
        provider: 'freellm',
        modelId: 'deepseek/deepseek-chat',
        temperature: 0.2,
        executionModality: 'LOCAL_PROCESS' as const,
      };
    }
    return orchestrator.storage.getRoleConfig(project.id, activeRole);
  }, [
    orchestrator.storage,
    project?.id,
    activeRole,
    expertSummaries,
    roleConfigVersion,
  ]);
  const activeModelEntry = useMemo(() => {
    const match = AVAILABLE_MODELS_CATALOG.find(
      (m) => m.modelId.toLowerCase() === activeModelCfg.modelId.toLowerCase(),
    );
    return {
      displayName: match?.displayName ?? activeModelCfg.modelId,
      isFree:
        match?.isFree ??
        (activeModelCfg.provider === 'ollama' ||
          activeModelCfg.provider === 'freellm'),
      vendor: getModelVendorLabel(
        activeModelCfg.provider,
        activeModelCfg.modelId,
      ),
    };
  }, [activeModelCfg]);
  const messages = useMemo(() => {
    if (!project) return [];
    return orchestrator.storage.listMessages(project.id, activeRole);
  }, [orchestrator.storage, project?.id, activeRole, expertSummaries, messagesVersion]);
  const sliceWindowedMessages = (winSize: number) => {
    if (messages.length <= winSize) return messages;
    const maxOffset = Math.max(0, messages.length - winSize);
    const clamped = Math.min(messageScrollOffset, maxOffset);
    const endIdx = messages.length - clamped;
    return messages.slice(Math.max(0, endIdx - winSize), endIdx);
  };
  const lastMessages = sliceWindowedMessages(3);
  const multipanelMessages = sliceWindowedMessages(4);
  const promptLineCount = useMemo(() => {
    const promptInnerWidth = Math.max(20, dimensions.columns - 34);
    const contentLines = inputValue
      ? wrapTextLines(inputValue, promptInnerWidth).length
      : 1;
    return Math.max(3, contentLines);
  }, [inputValue, dimensions.columns]);

  const openCodeMessages = useMemo(() => {
    const maxVisible = Math.max(2, Math.floor((safeViewportHeight - 8 - promptLineCount) / 3));
    if (messages.length <= maxVisible) return messages;
    const maxOffset = Math.max(0, messages.length - maxVisible);
    const clamped = Math.min(messageScrollOffset, maxOffset);
    const endIdx = messages.length - clamped;
    return messages.slice(Math.max(0, endIdx - maxVisible), endIdx);
  }, [messages, safeViewportHeight, messageScrollOffset, promptLineCount]);

  const estimatedTokens = useMemo(() => {
    let chars = 0;
    for (const m of messages) {
      chars += m.content.length;
    }
    chars += 12180;
    return Math.round(chars / 4);
  }, [messages]);
  const roleConfigs = useMemo(() => {
    if (!project) return [];
    return orchestrator.storage.listRoleConfigs(project.id);
  }, [orchestrator.storage, project?.id, expertSummaries, roleConfigVersion]);

  const renderTopColorBanner = (barWidth: number) => {
    const vendorLabel = getModelVendorLabel(
      activeModelCfg.provider,
      activeModelCfg.modelId,
    );
    const projLabel = project ? project.name : (language === 'es' ? 'Sin proyecto' : 'No project');
    const bannerText = ` ${projLabel}  │  ${activeRoleDisplayName}  │  ${vendorLabel}/${activeModelCfg.modelId} `;
    const fullBannerLine = fitAndPadLine(bannerText, barWidth);

    return (
      <Box width="100%" height={1}>
        <Text
          bold
          wrap="truncate-end"
          backgroundColor={activeTheme.bgColor}
          color={activeTheme.fgColor}
        >
          {fullBannerLine}
        </Text>
      </Box>
    );
  };

  // Interactive New Project Creation Wizard Modal (/project)
  const renderProjectWizardModal = () => (
    <Box
      flexDirection="column"
      width={Math.min(92, dimensions.columns - 8)}
      borderStyle="double"
      borderColor="green"
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="green">
          ✚ {t.newProjectTitle}
        </Text>
        <Text dimColor>{t.newProjectWizardSubtitle}</Text>
      </Box>
      {projectWizardStep === 'ASK_NAME' ? (
        <Box flexDirection="column">
          <Text color="white" bold>
            {t.newProjectStepNameLabel}
          </Text>
          <Box marginTop={1}>
            <Text bold color="green">
              ❯{' '}
            </Text>
            <Text color="yellow">{wizardInput}</Text>
            <Text color="green">█</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>
            {t.projectLabel}: <Text color="white">{pendingProjectName}</Text>
          </Text>
          <Text color="white" bold>
            {t.newProjectStepDirLabel(pendingProjectName)}
          </Text>
          <Box marginTop={1}>
            <Text bold color="green">
              ❯{' '}
            </Text>
            <Text color="yellow">{wizardInput}</Text>
            <Text color="green">█</Text>
          </Box>
        </Box>
      )}
    </Box>
  );

  // Interactive Projects List & Switcher Modal (/projects & /switch)
  const renderProjectsListModal = () => (
    <Box
      flexDirection="column"
      width={Math.min(96, dimensions.columns - 6)}
      borderStyle="double"
      borderColor="magenta"
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="magenta">
          📁 {t.projectsListTitle} ({allProjects.length})
        </Text>
        <Text dimColor>{t.projectsListSubtitle}</Text>
      </Box>

      {projectToDelete && (
        <Box
          flexDirection="row"
          marginBottom={1}
          paddingX={1}
          borderStyle="single"
          borderColor="red"
        >
          <Text color="red" bold>
            ⚠️ {t.confirmDeleteProject(projectToDelete.name)}
          </Text>
        </Box>
      )}

      {allProjects.length === 0 ? (
        <Box paddingY={1}>
          <Text dimColor>
            {language === 'es'
              ? 'No hay proyectos creados aún. Usa /project para crear uno.'
              : 'No projects created yet. Use /project to create one.'}
          </Text>
        </Box>
      ) : (
        allProjects.map((proj, idx) => {
          const isCurrentActive = project ? proj.id === project.id : false;
          const isRowSelected = idx === selectedProjectIdx;
          const isMarkedForDeletion = projectToDelete?.id === proj.id;
          return (
            <Box
              key={proj.id}
              flexDirection="column"
              marginBottom={0}
              paddingX={1}
            >
              <Box justifyContent="space-between">
                <Text
                  bold={isRowSelected || isCurrentActive}
                  color={
                    isMarkedForDeletion
                      ? 'red'
                      : isRowSelected
                        ? 'cyan'
                        : isCurrentActive
                          ? 'green'
                          : 'white'
                  }
                >
                  {isRowSelected ? '❯ ' : '  '}
                  {proj.name}{' '}
                  {isCurrentActive && (
                    <Text color="green" bold>
                      [{t.activeBadge}]
                    </Text>
                  )}{' '}
                  {isMarkedForDeletion && (
                    <Text color="red" bold>
                      [DELETE?]
                    </Text>
                  )}{' '}
                  <Text dimColor>({proj.phase})</Text>
                </Text>
                <Text color="yellow">
                  {t.reposLabel}:{' '}
                  {proj.repositories.length > 0
                    ? `${proj.repositories.length} [${proj.repositories.join(', ')}]`
                    : '0'}
                </Text>
              </Box>
              <Text dimColor>    dir: {proj.workspaceDir}</Text>
            </Box>
          );
        })
      )}

      <Box marginTop={1} justifyContent="flex-start">
        <Text dimColor>{t.projectsListFooterHints}</Text>
      </Box>
    </Box>
  );

  // Interactive Active Agent Selector Modal (/agents)
  const renderAgentsModal = () => {
    const modalWidth = Math.min(92, Math.max(70, dimensions.columns - 4));

    return (
      <Box
        flexDirection="column"
        width={modalWidth}
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        paddingY={1}
        marginBottom={1}
      >
        <Box
          justifyContent="space-between"
          marginBottom={1}
          width="100%"
          paddingX={1}
        >
          <Text bold color="cyan" wrap="truncate-end">
            👥{' '}
            {language === 'es'
              ? 'Seleccionar Agente Interlocutor'
              : 'Select Active Interlocutor Agent'}
          </Text>
          <Text dimColor wrap="truncate-end">
            {language === 'es'
              ? '↑/↓ o 1-4 · Enter confirmar · Esc volver'
              : '↑/↓ or 1-4 · Enter confirm · Esc back'}
          </Text>
        </Box>

        {AVAILABLE_AGENTS.map((item, idx) => {
          const isSelected = idx === selectedAgentIdx;
          const isCurrentActive = item.role === activeRole;
          const roleTheme = getRoleTheme(item.role, theme);
          const roleCfg = project
            ? orchestrator.storage.getRoleConfig(project.id, item.role)
            : {
                projectId: '',
                role: item.role,
                provider: 'freellm',
                modelId: 'deepseek/deepseek-chat',
                temperature: 0.2,
                executionModality: 'LOCAL_PROCESS' as const,
              };
          const catalogEntry = AVAILABLE_MODELS_CATALOG.find(
            (m) =>
              m.provider === roleCfg.provider &&
              m.modelId.toLowerCase() === roleCfg.modelId.toLowerCase(),
          );
          const modelName = catalogEntry?.displayName ?? roleCfg.modelId;
          const rawModelLabel = `${roleCfg.provider}/${modelName}`;
          const modelLabel =
            rawModelLabel.length > 28
              ? `${rawModelLabel.slice(0, 26)}..`
              : rawModelLabel;
          const descText = item.description[language === 'es' ? 'es' : 'en'];

          return (
            <Box
              key={item.role}
              flexDirection="column"
              paddingX={1}
              paddingY={0}
              marginBottom={idx < AVAILABLE_AGENTS.length - 1 ? 1 : 0}
            >
              <Box justifyContent="space-between" width="100%">
                <Box flexDirection="row" flexShrink={1}>
                  <Text
                    bold={isSelected || isCurrentActive}
                    color={
                      isSelected
                        ? roleTheme.accentColor
                        : isCurrentActive
                          ? 'green'
                          : 'white'
                    }
                    wrap="truncate-end"
                  >
                    {isSelected ? '❯ ' : '  '}
                    {item.icon} {item.title}{' '}
                    {isCurrentActive && (
                      <Text color="green" bold>
                        [{language === 'es' ? 'Activo' : 'Active'}]
                      </Text>
                    )}
                    {busyRoles[item.role] && (
                      <Text color="yellow" bold>
                        {' '}
                        {thinkingSpinner}{' '}
                        {language === 'es' ? '[Pensando...]' : '[Thinking...]'}
                      </Text>
                    )}
                  </Text>
                </Box>
                <Box flexShrink={0} paddingLeft={2}>
                  <Text
                    color={isSelected ? roleTheme.accentColor : 'gray'}
                    dimColor={!isSelected}
                    wrap="truncate-end"
                  >
                    {modelLabel}
                  </Text>
                </Box>
              </Box>
              <Box paddingLeft={5} width="100%">
                <Text
                  wrap="truncate-end"
                  color={isSelected ? 'white' : 'gray'}
                  dimColor={!isSelected}
                >
                  {descText}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    );
  };

  // Helper to wrap prompt text into fixed-width lines without cutting words
  const wrapPromptText = (content: string, maxWidth: number): string[] => {
    const result: string[] = [];
    const rawLines = content.split('\n');
    const safeWidth = Math.max(20, maxWidth);
    for (const raw of rawLines) {
      if (!raw.trim()) {
        result.push('');
        continue;
      }
      const words = raw.split(' ');
      let currentLine = '';
      for (const word of words) {
        if (!currentLine) {
          currentLine = word;
        } else if (currentLine.length + 1 + word.length <= safeWidth) {
          currentLine += ` ${word}`;
        } else {
          result.push(currentLine);
          let rem = word;
          while (rem.length > safeWidth) {
            result.push(rem.slice(0, safeWidth));
            rem = rem.slice(safeWidth);
          }
          currentLine = rem;
        }
      }
      if (currentLine) {
        result.push(currentLine);
      }
    }
    return result;
  };

  // Interactive System Prompts Inspector Modal (/system)
  const renderSystemModal = () => {
    const modalWidth = Math.min(92, Math.max(70, dimensions.columns - 4));
    const resolutions = HarnessRegistry.inspectResolutions();

    // 1. Detail View: Single Agent System Prompt (Read-Only) with scroll & scrollbar
    if (systemViewDetail === 'prompt') {
      const activeAgent =
        AVAILABLE_AGENTS.find((a) => a.role === systemViewingRole) ??
        AVAILABLE_AGENTS[0];
      const roleTheme = getRoleTheme(systemViewingRole, theme);
      const res = HarnessRegistry.inspectResolution(systemViewingRole);

      const windowHeight = Math.max(
        6,
        Math.min(16, Math.max(6, dimensions.rows - 14)),
      );
      const textWidth = Math.max(20, modalWidth - 10);
      const displayLines = wrapPromptText(res.content, textWidth);
      const totalLines = displayLines.length;
      const maxScroll = Math.max(0, totalLines - windowHeight);
      const currentScroll = Math.max(
        0,
        Math.min(maxScroll, systemPromptScrollOffset),
      );

      const thumbHeight = Math.max(
        1,
        Math.round((windowHeight / Math.max(1, totalLines)) * windowHeight),
      );
      const maxThumbTop = Math.max(0, windowHeight - thumbHeight);
      const thumbTop =
        maxScroll > 0
          ? Math.min(
              maxThumbTop,
              Math.round((currentScroll / maxScroll) * maxThumbTop),
            )
          : 0;

      return (
        <Box
          flexDirection="column"
          width={modalWidth}
          borderStyle="round"
          borderColor={roleTheme.accentColor}
          paddingX={1}
          paddingY={1}
          marginBottom={1}
        >
          <Box
            justifyContent="space-between"
            marginBottom={1}
            width="100%"
            paddingX={1}
          >
            <Text bold color={roleTheme.accentColor} wrap="truncate-end">
              {activeAgent.icon} {activeAgent.title} — System Prompt
            </Text>
            <Text dimColor wrap="truncate-end">
              {totalLines > windowHeight
                ? `${currentScroll + 1}-${Math.min(
                    totalLines,
                    currentScroll + windowHeight,
                  )} / ${totalLines}`
                : `${totalLines} ${language === 'es' ? 'líneas' : 'lines'}`}
            </Text>
          </Box>

          <Box
            paddingX={1}
            marginBottom={1}
            flexDirection="row"
            justifyContent="space-between"
            width="100%"
          >
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {language === 'es' ? 'Origen:' : 'Source:'}{' '}
                <Text
                  bold
                  color={
                    res.isOverride ? 'green' : res.isFallback ? 'yellow' : 'cyan'
                  }
                >
                  [{res.statusLabel[language === 'es' ? 'es' : 'en']}]
                </Text>
                {' · '}
                {res.resolvedPath
                  ? res.resolvedPath.replace(os.homedir(), '~')
                  : (language === 'es'
                    ? 'In-Memory Fallback'
                    : 'In-Memory Fallback')}
              </Text>
            </Box>
            <Box flexShrink={0} paddingLeft={2}>
              <Text color={res.isFallback ? 'yellow' : 'green'} bold>
                {res.isFallback ? '⚠ LOADED' : '✔ LOADED'}
              </Text>
            </Box>
          </Box>

          {/* Scrollable Prompt Content Box with Vertical Scrollbar */}
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            paddingY={0}
            marginBottom={1}
            height={windowHeight + 2}
          >
            {Array.from({ length: windowHeight }, (_, idx) => {
              const lineIdx = currentScroll + idx;
              const lineText =
                lineIdx < totalLines ? displayLines[lineIdx] : '';
              const isThumb =
                totalLines > windowHeight &&
                idx >= thumbTop &&
                idx < thumbTop + thumbHeight;

              return (
                <Box key={idx} justifyContent="space-between" width="100%">
                  <Box flexShrink={1}>
                    <Text color="white" wrap="truncate-end">
                      {lineText || ' '}
                    </Text>
                  </Box>
                  {totalLines > windowHeight && (
                    <Box flexShrink={0} paddingLeft={1}>
                      <Text
                        color={isThumb ? roleTheme.accentColor : 'gray'}
                        bold={isThumb}
                      >
                        {isThumb ? '█' : '░'}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>

          <Box justifyContent="space-between" paddingX={1}>
            <Text dimColor>
              {language === 'es'
                ? '↑/↓ o Rueda Ratón desplazar · Esc volver'
                : '↑/↓ or Mouse Wheel scroll · Esc back'}
            </Text>
            <Text dimColor>
              {language === 'es' ? '[Esc] Menú' : '[Esc] Menu'}
            </Text>
          </Box>
        </Box>
      );
    }

    // 2. Detail View: Locations & Resolution Hierarchy
    if (systemViewDetail === 'locations') {
      return (
        <Box
          flexDirection="column"
          width={modalWidth}
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
          marginBottom={1}
        >
          <Box
            justifyContent="space-between"
            marginBottom={1}
            width="100%"
            paddingX={1}
          >
            <Text bold color="cyan" wrap="truncate-end">
              📍 {language === 'es' ? 'Ubicación de System Prompts' : 'System Prompt Locations'}
            </Text>
            <Text dimColor wrap="truncate-end">
              {language === 'es' ? 'Esc volver al menú' : 'Esc back to menu'}
            </Text>
          </Box>

          <Box flexDirection="column" paddingX={1} marginBottom={1}>
            {resolutions.map((res) => {
              const agent = AVAILABLE_AGENTS.find((a) => a.role === res.role);
              const icon = agent?.icon ?? '🤖';
              const title = agent?.title ?? res.displayName;
              const statusColor = res.isOverride
                ? 'green'
                : res.isFallback
                  ? 'yellow'
                  : 'cyan';

              return (
                <Box key={res.role} flexDirection="column" marginBottom={1}>
                  <Box justifyContent="space-between" width="100%">
                    <Text bold color="white">
                      {icon} {title}
                    </Text>
                    <Text bold color={statusColor}>
                      [{res.statusLabel[language === 'es' ? 'es' : 'en']}]
                    </Text>
                  </Box>
                  <Box
                    paddingLeft={3}
                    flexDirection="row"
                    justifyContent="space-between"
                    width="100%"
                  >
                    <Box flexShrink={1}>
                      <Text dimColor wrap="truncate-end">
                        {res.resolvedPath
                          ? res.resolvedPath.replace(os.homedir(), '~')
                          : (language === 'es'
                            ? 'Ninguno (In-memory fallback predefinido)'
                            : 'None (Predefined in-memory fallback)')}
                      </Text>
                    </Box>
                    <Box flexShrink={0} paddingLeft={2}>
                      <Text color={res.isFallback ? 'yellow' : 'green'} bold>
                        {res.isFallback ? '⚠ LOADED' : '✔ LOADED'}
                      </Text>
                    </Box>
                  </Box>
                </Box>
              );
            })}
          </Box>

          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            paddingY={0}
            marginBottom={1}
          >
            <Text color="yellow" bold>
              {language === 'es' ? 'Jerarquía de resolución:' : 'Resolution hierarchy:'}
            </Text>
            <Text dimColor>
              1. {language === 'es' ? 'Override de usuario:' : 'User override:'} ~/.pocli/behavior/system/{'<role>'}.md
            </Text>
            <Text dimColor>
              2. {language === 'es' ? 'Paquete compilado:' : 'Bundled package:'} dist/behavior/system/{'<role>'}.md
            </Text>
            <Text dimColor>
              3. {language === 'es' ? 'Repositorio local:' : 'Repository default:'} behavior/system/{'<role>'}.md
            </Text>
            <Text dimColor>
              4. {language === 'es' ? 'Respaldo en memoria:' : 'In-memory fallback:'} FALLBACK_PROMPTS
            </Text>
          </Box>

          <Box justifyContent="flex-end" paddingX={1}>
            <Text dimColor>
              {language === 'es' ? 'Esc volver al selector' : 'Esc back to selector'}
            </Text>
          </Box>
        </Box>
      );
    }

    // 3. Main Selector Menu
    const menuItems = [
      ...AVAILABLE_AGENTS.map((item) => {
        const res = HarnessRegistry.inspectResolution(item.role);
        return {
          type: 'agent' as const,
          role: item.role,
          icon: item.icon,
          title: item.title,
          desc: item.description[language === 'es' ? 'es' : 'en'],
          statusLabel: res.statusLabel[language === 'es' ? 'es' : 'en'],
          isOverride: res.isOverride,
          isFallback: res.isFallback,
        };
      }),
      {
        type: 'locations' as const,
        role: undefined,
        icon: '📍',
        title: 'System Prompt Locations',
        desc:
          language === 'es'
            ? 'Inspeccionar rutas de archivo, overrides de usuario y fallbacks'
            : 'Inspect file paths, user overrides, and fallback statuses',
        statusLabel: language === 'es' ? 'Ubicaciones & Rutas' : 'Locations & Paths',
        isOverride: false,
        isFallback: false,
      },
    ];

    return (
      <Box
        flexDirection="column"
        width={modalWidth}
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        paddingY={1}
        marginBottom={1}
      >
        <Box
          justifyContent="space-between"
          marginBottom={1}
          width="100%"
          paddingX={1}
        >
          <Text bold color="cyan" wrap="truncate-end">
            📝 {language === 'es' ? 'System Prompts de los Agentes' : 'Agent System Prompts'}
          </Text>
          <Text dimColor wrap="truncate-end">
            {language === 'es'
              ? '↑/↓ o 1-5 · Enter ver · Esc cerrar'
              : '↑/↓ or 1-5 · Enter view · Esc close'}
          </Text>
        </Box>

        {menuItems.map((item, idx) => {
          const isSelected = idx === selectedSystemIdx;
          const statusColor = item.isOverride
            ? 'green'
            : item.isFallback
              ? 'yellow'
              : 'cyan';

          return (
            <Box
              key={item.title}
              flexDirection="column"
              paddingX={1}
              paddingY={0}
              marginBottom={idx < menuItems.length - 1 ? 1 : 0}
            >
              <Box justifyContent="space-between" width="100%">
                <Box flexDirection="row" flexShrink={1}>
                  <Text
                    bold={isSelected}
                    color={isSelected ? 'cyan' : 'white'}
                    wrap="truncate-end"
                  >
                    {isSelected ? '❯ ' : '  '}
                    {item.icon} {item.title}
                  </Text>
                </Box>
                <Box flexShrink={0} paddingLeft={2}>
                  <Text
                    bold={item.isOverride || item.isFallback}
                    color={statusColor}
                    dimColor={!isSelected && !item.isOverride && !item.isFallback}
                  >
                    [{item.statusLabel}]
                  </Text>
                </Box>
              </Box>
              <Box paddingLeft={5} width="100%">
                <Text
                  wrap="truncate-end"
                  color={isSelected ? 'white' : 'gray'}
                  dimColor={!isSelected}
                >
                  {item.desc}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    );
  };

  // Help Modal Component displaying all available slash commands
  const renderHelpModal = () => (
    <Box
      flexDirection="column"
      width={Math.min(92, dimensions.columns - 8)}
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">
          ? {t.helpTitle}
        </Text>
        <Text dimColor>{t.helpSubtitle}</Text>
      </Box>
      {t.slashCommands.map((item) => (
        <Box key={item.command} justifyContent="space-between">
          <Text>
            <Text bold color="yellow">
              {item.command.padEnd(14, ' ')}
            </Text>
            <Text color="white">{item.description}</Text>
          </Text>
          {item.phaseHint && (
            <Text color="cyan" dimColor>
              [{item.phaseHint}]
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );

  // Howto Workflow Guide Modal Component (/howto)
  const renderHowtoModal = () => {
    const modalWidth = Math.min(108, Math.max(80, dimensions.columns - 4));
    const contentWidth = modalWidth - 8;
    const lines = getHowtoRenderLines(language, contentWidth);
    const windowHeight = Math.max(
      8,
      Math.min(18, Math.max(8, dimensions.rows - 12)),
    );
    const totalLines = lines.length;
    const maxScroll = Math.max(0, totalLines - windowHeight);
    const currentScroll = Math.max(
      0,
      Math.min(maxScroll, howtoScrollOffset),
    );

    const thumbHeight = Math.max(
      1,
      Math.round((windowHeight / Math.max(1, totalLines)) * windowHeight),
    );
    const maxThumbTop = Math.max(0, windowHeight - thumbHeight);
    const thumbTop =
      maxScroll > 0
        ? Math.min(
            maxThumbTop,
            Math.round((currentScroll / maxScroll) * maxThumbTop),
          )
        : 0;

    return (
      <Box
        flexDirection="column"
        width={modalWidth}
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        marginBottom={1}
      >
        <Box justifyContent="space-between" marginBottom={1}>
          <Text bold color="cyan">
            💡 {t.howtoTitle}
          </Text>
          <Text dimColor>
            {totalLines > windowHeight
              ? `${currentScroll + 1}-${Math.min(
                  totalLines,
                  currentScroll + windowHeight,
                )} / ${totalLines} · ${t.howtoSubtitle}`
              : t.howtoSubtitle}
          </Text>
        </Box>

        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          paddingY={0}
          marginBottom={1}
          height={windowHeight + 2}
        >
          {Array.from({ length: windowHeight }, (_, idx) => {
            const lineIdx = currentScroll + idx;
            const line = lineIdx < totalLines ? lines[lineIdx] : null;
            const isThumb =
              totalLines > windowHeight &&
              idx >= thumbTop &&
              idx < thumbTop + thumbHeight;

            return (
              <Box key={idx} justifyContent="space-between" width="100%">
                <Box flexShrink={1} flexDirection="row">
                  {line?.prefix && (
                    <Text
                      color={line.prefixColor ?? 'yellow'}
                      bold={line.prefixBold ?? true}
                    >
                      {line.prefix}{' '}
                    </Text>
                  )}
                  <Text
                    color={line?.color ?? 'white'}
                    bold={line?.bold ?? false}
                    dimColor={line?.dimColor ?? false}
                    wrap="truncate-end"
                  >
                    {line?.text ?? ' '}
                  </Text>
                </Box>
                {totalLines > windowHeight && (
                  <Box flexShrink={0} paddingLeft={1}>
                    <Text color={isThumb ? 'cyan' : 'gray'} bold={isThumb}>
                      {isThumb ? '█' : '░'}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>

        <Box justifyContent="space-between">
          <Text dimColor>
            {language === 'es'
              ? '↑/↓ o Rueda Ratón desplazar · g/G inicio/fin · Esc cerrar'
              : '↑/↓ or Mouse Wheel scroll · g/G top/bottom · Esc close'}
          </Text>
          <Text bold color="yellow">
            {language === 'es'
              ? 'POCLI: Tú eres el Product Owner'
              : 'POCLI: You are the Product Owner'}
          </Text>
        </Box>
      </Box>
    );
  };

  // Settings Modal Component — Option 4: Master-Detail Split Layout with strictly fixed size
  const renderSettingsModal = () => {
    const modalWidth = Math.min(108, Math.max(88, dimensions.columns - 4));
    const modalHeight = 15;
    const leftColWidth = Math.max(38, Math.min(44, Math.floor(modalWidth * 0.38)));
    const rightColWidth = modalWidth - leftColWidth - 5;
    const bodyHeight = modalHeight - 4;

    return (
      <Box
        flexDirection="column"
        width={modalWidth}
        height={modalHeight}
        borderStyle="double"
        borderColor={themePalette.modalBorder}
        paddingX={1}
        paddingY={0}
        marginBottom={1}
      >
        {/* Header Bar */}
        <Box
          width="100%"
          height={1}
          justifyContent="space-between"
          paddingX={1}
          marginTop={0}
        >
          <Text bold color={themePalette.yellow}>
            ⚙ {t.settingsTitle}
          </Text>
          <Text dimColor>
            {language === 'es'
              ? '↑/↓ elegir categoría · Esc cerrar'
              : '↑/↓ select category · Esc close'}
          </Text>
        </Box>

        {/* Master-Detail Split Body */}
        <Box flexDirection="row" width="100%" height={bodyHeight} marginTop={1}>
          {/* Left Panel: Settings Categories (Master) */}
          <Box
            flexDirection="column"
            width={leftColWidth}
            height={bodyHeight}
            paddingRight={1}
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderLeft={false}
            borderRight={true}
            borderColor={themePalette.dim}
          >
            <Text bold color={themePalette.header} dimColor>
              {language === 'es' ? 'AJUSTES' : 'SETTINGS'}
            </Text>
            <Box height={1} />

            {/* Row 0: Language */}
            <Box
              flexDirection="row"
              justifyContent="space-between"
              paddingX={1}
            >
              <Text
                bold={settingsRowIdx === 0}
                color={settingsRowIdx === 0 ? themePalette.cyan : themePalette.fg}
              >
                {settingsRowIdx === 0 ? '❯ ' : '  '}
                {t.settingLanguageLabel}
              </Text>
              <Text color={themePalette.green} bold>
                [{language}]
              </Text>
            </Box>

            {/* Row 1: Theme */}
            <Box
              flexDirection="row"
              justifyContent="space-between"
              paddingX={1}
              marginTop={1}
            >
              <Text
                bold={settingsRowIdx === 1}
                color={settingsRowIdx === 1 ? themePalette.cyan : themePalette.fg}
              >
                {settingsRowIdx === 1 ? '❯ ' : '  '}
                {t.settingThemeLabel}
              </Text>
              <Text color={themePalette.green} bold>
                [{theme === 'solarized-dark' ? 'dark' : theme === 'solarized-light' ? 'light' : 'sys'}]
              </Text>
            </Box>

            {/* Row 2: Directory */}
            <Box
              flexDirection="row"
              justifyContent="space-between"
              paddingX={1}
              marginTop={1}
            >
              <Text
                bold={settingsRowIdx === 2}
                color={settingsRowIdx === 2 ? themePalette.cyan : themePalette.fg}
              >
                {settingsRowIdx === 2 ? '❯ ' : '  '}
                {language === 'es' ? 'Directorio' : 'Directory'}
              </Text>
              <Text color={themePalette.green} bold>
                [dir]
              </Text>
            </Box>
          </Box>

          {/* Right Panel: Active Setting Detail */}
          <Box
            flexDirection="column"
            width={rightColWidth}
            height={bodyHeight}
            paddingLeft={2}
            justifyContent="space-between"
          >
            {settingsRowIdx === 0 && (
              <Box flexDirection="column">
                <Text bold color={themePalette.header}>
                  {t.settingLanguageLabel}
                </Text>
                <Text dimColor>{t.settingLanguageDesc}</Text>
                <Box height={1} />

                <Box flexDirection="row">
                  <Text
                    color={language === 'en' ? themePalette.green : themePalette.dim}
                    bold
                  >
                    {language === 'en' ? '  [●] ' : '  [ ] '}
                  </Text>
                  <Text
                    bold={language === 'en'}
                    color={language === 'en' ? themePalette.fg : themePalette.dim}
                  >
                    English (en)
                  </Text>
                  <Text dimColor> — {language === 'es' ? 'Interfaz en idioma inglés' : 'English interface'}</Text>
                </Box>

                <Box flexDirection="row" marginTop={1}>
                  <Text
                    color={language === 'es' ? themePalette.green : themePalette.dim}
                    bold
                  >
                    {language === 'es' ? '  [●] ' : '  [ ] '}
                  </Text>
                  <Text
                    bold={language === 'es'}
                    color={language === 'es' ? themePalette.fg : themePalette.dim}
                  >
                    Español (es)
                  </Text>
                  <Text dimColor> — {language === 'es' ? 'Interfaz en idioma español' : 'Spanish interface'}</Text>
                </Box>
              </Box>
            )}

            {settingsRowIdx === 1 && (
              <Box flexDirection="column">
                <Text bold color={themePalette.header}>
                  {t.settingThemeLabel}
                </Text>
                <Text dimColor>{t.settingThemeDesc}</Text>
                <Box height={1} />

                <Box flexDirection="row">
                  <Text
                    color={theme === 'system' ? themePalette.green : themePalette.dim}
                    bold
                  >
                    {theme === 'system' ? '  [●] ' : '  [ ] '}
                  </Text>
                  <Text
                    bold={theme === 'system'}
                    color={theme === 'system' ? themePalette.fg : themePalette.dim}
                  >
                    system
                  </Text>
                  <Text dimColor>
                    {' '}— {language === 'es' ? 'Colores nativos de tu terminal' : 'Native terminal look & transparent bg'}
                  </Text>
                </Box>

                <Box flexDirection="row" marginTop={1}>
                  <Text
                    color={theme === 'solarized-light' ? themePalette.green : themePalette.dim}
                    bold
                  >
                    {theme === 'solarized-light' ? '  [●] ' : '  [ ] '}
                  </Text>
                  <Text
                    bold={theme === 'solarized-light'}
                    color={theme === 'solarized-light' ? themePalette.fg : themePalette.dim}
                  >
                    solarized-light
                  </Text>
                  <Text dimColor>
                    {' '}— {language === 'es' ? 'Paleta clara canónica (#fdf6e3)' : 'Canonical light palette (#fdf6e3)'}
                  </Text>
                </Box>

                <Box flexDirection="row" marginTop={1}>
                  <Text
                    color={theme === 'solarized-dark' ? themePalette.green : themePalette.dim}
                    bold
                  >
                    {theme === 'solarized-dark' ? '  [●] ' : '  [ ] '}
                  </Text>
                  <Text
                    bold={theme === 'solarized-dark'}
                    color={theme === 'solarized-dark' ? themePalette.fg : themePalette.dim}
                  >
                    solarized-dark
                  </Text>
                  <Text dimColor>
                    {' '}— {language === 'es' ? 'Paleta oscura canónica (#002b36)' : 'Canonical dark palette (#002b36)'}
                  </Text>
                </Box>
              </Box>
            )}

            {settingsRowIdx === 2 && (
              <Box flexDirection="column">
                <Text bold color={themePalette.header}>
                  {t.settingWorkDirLabel}
                </Text>
                <Text dimColor>{t.settingWorkDirDesc}</Text>
                <Box height={1} />

                <Box flexDirection="row">
                  <Text color={themePalette.green} bold>
                    {language === 'es' ? 'Ruta: ' : 'Path: '}
                  </Text>
                  <Text color={themePalette.fg} wrap="truncate-middle">
                    {workDir}
                  </Text>
                </Box>

                {isEditingWorkDir ? (
                  <Box
                    flexDirection="column"
                    marginTop={1}
                    borderStyle="round"
                    borderColor={themePalette.green}
                    paddingX={1}
                  >
                    <Text color={themePalette.yellow}>
                      {t.settingWorkDirEditPrompt}
                    </Text>
                    <Box>
                      <Text bold color={themePalette.green}>
                        ❯{' '}
                      </Text>
                      <Text color={themePalette.fg}>{workDirDraft}</Text>
                      <Text color={themePalette.green}>█</Text>
                    </Box>
                  </Box>
                ) : (
                  <Box marginTop={1}>
                    <Text dimColor>
                      {language === 'es'
                        ? 'Pulsa Enter o \'e\' para editar la ruta'
                        : 'Press Enter or \'e\' to edit path'}
                    </Text>
                  </Box>
                )}
              </Box>
            )}

            {/* Bottom Contextual Helper Hint */}
            <Box marginTop={1} paddingX={0}>
              <Text dimColor>
                {settingsRowIdx === 0
                  ? '←/→ o Enter · 1 (en) / 2 (es)'
                  : settingsRowIdx === 1
                    ? '←/→ o Enter · 1 (sys) / 2 (light) / 3 (dark)'
                    : isEditingWorkDir
                      ? 'Enter guardar · Esc cancelar'
                      : 'Enter / e editar ruta'}
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  };

  // Interactive Workers Modal Component (/workers)
  const renderWorkersModal = () => {
    const modalWidth = Math.min(108, Math.max(88, dimensions.columns - 4));
    const modalHeight = 16;

    const roleLabels: Record<string, string> = {
      architect: 'Lead Architect',
      developer: 'Senior Developer',
      qa: 'Independent QA',
      pm: 'Project Manager',
    };

    return (
      <Box
        flexDirection="column"
        width={modalWidth}
        height={modalHeight}
        borderStyle="double"
        borderColor={themePalette.modalBorder}
        paddingX={1}
        paddingY={0}
        marginBottom={1}
      >
        {/* Header Bar */}
        <Box width="100%" height={1} justifyContent="space-between" paddingX={1}>
          <Text bold color={themePalette.yellow}>
            ⚙ {language === 'es'
              ? 'Trabajadores Concurrentes Persistentes (/workers)'
              : 'Persistent Concurrent Agent Workers (/workers)'}
          </Text>
          <Text dimColor>
            {language === 'es'
              ? '↑/↓ elegir · r reiniciar · s detener · Esc cerrar'
              : '↑/↓ select · r restart · s stop · Esc close'}
          </Text>
        </Box>

        {/* Table Header */}
        <Box
          flexDirection="row"
          width="100%"
          paddingX={1}
          marginTop={1}
          borderStyle="single"
          borderTop={false}
          borderLeft={false}
          borderRight={false}
          borderBottom={true}
          borderColor={themePalette.dim}
        >
          <Box width="26%">
            <Text bold color={themePalette.header}>
              {language === 'es' ? 'ROL / AGENTE' : 'ROLE / AGENT'}
            </Text>
          </Box>
          <Box width="18%">
            <Text bold color={themePalette.header}>STATUS</Text>
          </Box>
          <Box width="12%">
            <Text bold color={themePalette.header}>PID</Text>
          </Box>
          <Box width="20%">
            <Text bold color={themePalette.header}>MODALITY</Text>
          </Box>
          <Box width="12%">
            <Text bold color={themePalette.header}>
              {language === 'es' ? 'TURNOS' : 'TURNS'}
            </Text>
          </Box>
          <Box width="12%">
            <Text bold color={themePalette.header}>
              {language === 'es' ? 'ACCIÓN' : 'ACTION'}
            </Text>
          </Box>
        </Box>

        {/* Worker Rows */}
        <Box flexDirection="column" width="100%" height={6} marginTop={1}>
          {workersList.map((w, idx) => {
            const isSelected = workersSelectedIdx === idx;
            const displayName = roleLabels[w.role] ?? w.role;
            const statusColor =
              w.status === 'idle'
                ? themePalette.green
                : w.status === 'busy'
                  ? themePalette.yellow
                  : w.status === 'failed'
                    ? themePalette.red
                    : 'gray';
            const statusIcon =
              w.status === 'idle'
                ? '● IDLE'
                : w.status === 'busy'
                  ? '● BUSY'
                  : w.status === 'failed'
                    ? '✖ FAILED'
                    : '○ STOPPED';

            return (
              <Box
                key={w.role}
                flexDirection="row"
                width="100%"
                paddingX={1}
                height={1}
              >
                <Box width="26%">
                  <Text
                    bold={isSelected}
                    color={isSelected ? themePalette.cyan : themePalette.fg}
                  >
                    {isSelected ? '❯ ' : '  '}
                    {displayName}
                  </Text>
                </Box>
                <Box width="18%">
                  <Text color={statusColor} bold>
                    {statusIcon}
                  </Text>
                </Box>
                <Box width="12%">
                  <Text color={w.workerPid ? themePalette.fg : 'gray'}>
                    {w.workerPid ? String(w.workerPid) : '—'}
                  </Text>
                </Box>
                <Box width="20%">
                  <Text dimColor>{w.modality}</Text>
                </Box>
                <Box width="12%">
                  <Text color={themePalette.fg}>{w.turnsCompleted} turns</Text>
                </Box>
                <Box width="12%">
                  <Text dimColor>
                    {isSelected ? '[r/s]' : ''}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* Footer / Shortcut bar */}
        <Box
          width="100%"
          justifyContent="space-between"
          paddingX={1}
          marginTop={1}
          borderStyle="single"
          borderTop={true}
          borderLeft={false}
          borderRight={false}
          borderBottom={false}
          borderColor={themePalette.dim}
        >
          <Text dimColor>
            {language === 'es'
              ? 'r/Enter: Reiniciar · s: Detener · Esc: Cerrar'
              : 'r/Enter: Restart · s: Stop · Esc: Close'}
          </Text>
          <Text color={themePalette.cyan} bold>
            {workersList.filter((w) => w.status === 'idle' || w.status === 'busy').length} active
          </Text>
        </Box>
      </Box>
    );
  };

  // OpenCode-style Interactive Per-Agent Model Picker Modal (/models or Ctrl+O)
  const renderModelsModal = () => {
    const targetOptions = [
      'pm',
      'architect',
      'developer',
      'qa',
      'all',
    ] as const;
    const roleShortLiterals: Record<string, string> = {
      pm: 'PM',
      architect: 'ARQ',
      developer: 'DEV',
      qa: 'QA',
      all: 'ALL',
    };
    const targetTheme =
      modelsTargetRole === 'all'
        ? {
            bgColor: 'cyan' as const,
            fgColor: 'black' as const,
            accentColor: 'cyan' as const,
          }
        : getRoleTheme(modelsTargetRole, theme);

    // Larger, strictly fixed modal dimensions so moving left/right/up/down or
    // typing in the filter never changes the dialog width or height.
    const modalWidth = Math.max(96, Math.min(136, dimensions.columns - 4));
    const tabWidth = 14;
    const centerInBox = (label: string, width: number): string => {
      if (label.length >= width) return label.slice(0, width);
      const leftPad = Math.floor((width - label.length) / 2);
      const rightPad = width - label.length - leftPad;
      return `${' '.repeat(leftPad)}${label}${' '.repeat(rightPad)}`;
    };
    const windowSize = Math.max(
      6,
      Math.min(12, Math.max(22, dimensions.rows - 1) - 18),
    );
    const modalHeight = windowSize + 14;

    const providerTabs = [
      { id: 'all', label: language === 'es' ? 'TODOS' : 'ALL', isConfigured: true },
      { id: 'opencode', label: 'OPENCODE ZEN', isConfigured: Boolean(AuthStorage.getApiKey('opencode')) },
      { id: 'openrouter', label: 'OPENROUTER', isConfigured: Boolean(AuthStorage.getApiKey('openrouter')) },
      { id: 'anthropic', label: 'ANTHROPIC', isConfigured: Boolean(AuthStorage.getApiKey('anthropic')) },
      { id: 'openai', label: 'OPENAI', isConfigured: Boolean(AuthStorage.getApiKey('openai')) },
      { id: 'gemini', label: 'ANTIGRAVITY', isConfigured: AuthStorage.isConfigured('gemini') },
      { id: 'groq', label: 'GROQ', isConfigured: Boolean(AuthStorage.getApiKey('groq')) },
      { id: 'ollama', label: 'OLLAMA', isConfigured: true },
      { id: 'freellm', label: 'FREE/ZERO', isConfigured: true },
    ];

    const startIdx = Math.max(
      0,
      Math.min(
        selectedModelIdx - Math.floor(windowSize / 2),
        Math.max(0, filteredModels.length - windowSize),
      ),
    );
    const visibleModels = filteredModels.slice(startIdx, startIdx + windowSize);

    const selectedTargetCfg =
      modelsTargetRole === 'all'
        ? undefined
        : roleConfigs.find((rc) => rc.role === modelsTargetRole);

    const firstRoleCfg = roleConfigs[0];
    const allAgentsShareSameModel =
      Boolean(firstRoleCfg) &&
      (['pm', 'architect', 'developer', 'qa'] as const).every((rKey) => {
        const rc = roleConfigs.find((c) => c.role === rKey);
        return (
          rc?.provider === firstRoleCfg?.provider &&
          rc?.modelId === firstRoleCfg?.modelId
        );
      });

    const selectedTargetSummary =
      modelsTargetRole === 'all'
        ? allAgentsShareSameModel && firstRoleCfg
          ? `ALL (${t.modelsAllAgentsLabel}) — [${getModelVendorLabel(
              firstRoleCfg.provider,
              firstRoleCfg.modelId,
            )}] ${firstRoleCfg.modelId}`
          : `ALL — ${(
              ['pm', 'architect', 'developer', 'qa'] as const
            )
              .map((rKey) => {
                const rc = roleConfigs.find((c) => c.role === rKey);
                return `${roleShortLiterals[rKey]}:${rc?.modelId ?? 'default'}`;
              })
              .join(' · ')}`
        : `${roleShortLiterals[modelsTargetRole]} (${getRoleDisplayName(
            modelsTargetRole,
            language,
          )}) — [${getModelVendorLabel(
            selectedTargetCfg?.provider ?? 'anthropic',
            selectedTargetCfg?.modelId,
          )}] ${selectedTargetCfg?.modelId ?? 'default'}`;

    return (
      <Box
        flexDirection="column"
        width={modalWidth}
        height={modalHeight}
        borderStyle="double"
        borderColor={targetTheme.accentColor}
        paddingX={2}
        paddingY={1}
      >
        {/* Per-Agent Target Selector Bar:
            Line 1: Target Agent + active model for the selected target
            Line 2: Only short color-coded literals PM, ARQ, DEV, QA, ALL */}
        <Box flexDirection="column" height={3}>
          <Box justifyContent="space-between" height={1}>
            <Text bold color="white" wrap="truncate-end">
              {t.modelsTargetAgentLabel}
            </Text>
            <Text bold color={targetTheme.accentColor} wrap="truncate-end">
              {selectedTargetSummary}
            </Text>
          </Box>
          <Box
            flexDirection="row"
            width="100%"
            height={1}
            marginTop={1}
            justifyContent="center"
          >
            {targetOptions.map((opt) => {
              const isSelectedTarget = modelsTargetRole === opt;
              const optTheme =
                opt === 'all'
                  ? {
                      bgColor: 'cyan' as const,
                      fgColor: 'black' as const,
                      accentColor: 'cyan' as const,
                    }
                  : getRoleTheme(opt, theme);
              const shortLabel = roleShortLiterals[opt];
              const buttonText = centerInBox(
                isSelectedTarget ? `▶ ${shortLabel} ◀` : shortLabel,
                tabWidth,
              );

              return (
                <Box key={opt} marginX={1} height={1}>
                  <Text
                    bold={isSelectedTarget}
                    backgroundColor={optTheme.bgColor}
                    color={optTheme.fgColor}
                  >
                    {buttonText}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>

        {/* Line 3: Provider / Gateway Filter Tabs */}
        <Box
          flexDirection="row"
          width="100%"
          height={1}
          marginTop={1}
          justifyContent="center"
        >
          {providerTabs.map((pt) => {
            const isSelectedTab = modelsProviderTab === pt.id;
            const buttonText = isSelectedTab ? `▶ ${pt.label} ◀` : ` ${pt.label} `;
            const hasKey = pt.isConfigured;

            return (
              <Box key={pt.id} height={1} marginX={0}>
                <Text
                  bold={isSelectedTab}
                  backgroundColor={isSelectedTab ? targetTheme.bgColor : undefined}
                  color={
                    isSelectedTab
                      ? targetTheme.fgColor
                      : hasKey
                        ? 'white'
                        : 'gray'
                  }
                >
                  {buttonText}
                </Text>
                <Text color="gray"> </Text>
              </Box>
            );
          })}
        </Box>

        {/* Line 4: Live Search / Filter Input (fixed 3 rows) */}
        <Box
          marginTop={1}
          height={3}
          borderStyle="round"
          borderColor={targetTheme.accentColor}
          paddingX={1}
          justifyContent="space-between"
        >
          <Text wrap="truncate-end">
            <Text bold color={targetTheme.accentColor}>
              {t.modelsSearchLabel} ❯{' '}
            </Text>
            {modelsFilterQuery ? (
              <Text color="white">{modelsFilterQuery}</Text>
            ) : (
              <Text dimColor>{t.modelsSearchPlaceholder}</Text>
            )}
            <Text color={targetTheme.accentColor}>█</Text>
          </Text>
          <Text dimColor>
            {filteredModels.length}/{AVAILABLE_MODELS_CATALOG.length}
          </Text>
        </Box>

        {/* Line 5+: Scrollable Model Catalog List with strictly fixed height (windowSize rows) */}
        <Box flexDirection="column" marginTop={1} height={windowSize}>
          {visibleModels.length === 0 ? (
            <Text dimColor wrap="truncate-end">
              {t.noCommandMatches} "{modelsFilterQuery}"
            </Text>
          ) : (
            visibleModels.map((m, localIdx) => {
              const realIdx = startIdx + localIdx;
              const isRowSelected = realIdx === selectedModelIdx;
              const isKeyConfigured =
                m.isFree ||
                m.provider === 'deterministic' ||
                AuthStorage.isConfigured(m.provider);

              const assignedRoles = (
                ['pm', 'architect', 'developer', 'qa'] as const
              ).filter((rKey) => {
                const rc = roleConfigs.find((c) => c.role === rKey);
                return rc?.provider === m.provider && rc?.modelId === m.modelId;
              });

              return (
                <Box
                  key={`${m.provider}/${m.modelId}`}
                  justifyContent="space-between"
                  height={1}
                >
                  <Text
                    bold={isRowSelected}
                    color={isRowSelected ? targetTheme.accentColor : 'white'}
                    wrap="truncate-end"
                  >
                    {isRowSelected ? '❯ ' : '  '}
                    <Text color="cyan">
                      [{m.vendor.padEnd(9, ' ')}]
                    </Text>{' '}
                    <Text color="yellow">
                      [{m.providerLabel.padEnd(12, ' ')}]
                    </Text>{' '}
                    <Text color={m.isFree ? 'green' : isKeyConfigured ? 'green' : 'gray'}>
                      [{m.isFree ? 'Free' : isKeyConfigured ? 'Key OK' : 'Req Key'}]
                    </Text>{' '}
                    <Text bold={isRowSelected} color={isRowSelected ? 'white' : undefined}>
                      {m.modelId.padEnd(28, ' ')}
                    </Text>{' '}
                    <Text dimColor>
                      · {m.contextWindow} · {m.recommendedFor}
                    </Text>
                  </Text>
                  <Box height={1}>
                    {assignedRoles.map((rKey) => {
                      const rTheme = getRoleTheme(rKey, theme);
                      return (
                        <Box key={rKey} marginLeft={1}>
                          <Text
                            bold
                            backgroundColor={rTheme.bgColor}
                            color={rTheme.fgColor}
                          >
                            {` ${roleShortLiterals[rKey]} `}
                          </Text>
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              );
            })
          )}
        </Box>
      </Box>
    );
  };

  const anyModalOpen =
    isHelpOpen ||
    isHowtoOpen ||
    isSettingsOpen ||
    isWorkersModalOpen ||
    isProjectsModalOpen ||
    isAgentsModalOpen ||
    isModelsModalOpen ||
    isSystemModalOpen ||
    isLogsModalOpen ||
    isAuthModalOpen ||
    isExitConfirmOpen ||
    isTreeExplorerOpen ||
    dbModalOutput.length > 0 ||
    projectWizardStep !== 'CLOSED';

  const renderDbModal = () => (
    <Box
      flexDirection="column"
      width={Math.min(96, dimensions.columns - 6)}
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">
          🗄 SQLite Database Inspector (/db · pocli db)
        </Text>
        <Text dimColor>Press Esc, Enter, or q to close</Text>
      </Box>
      <Text>{dbModalOutput}</Text>
    </Box>
  );

  // Interactive Logs Viewer Modal (/logs)
  const renderLogsModal = () => {
    const modalWidth = Math.min(108, Math.max(76, dimensions.columns - 4));
    const lines = Logger.getRecentLines(200);
    const windowHeight = Math.max(
      6,
      Math.min(16, Math.max(6, dimensions.rows - 12)),
    );
    const totalLines = lines.length;
    const maxScroll = Math.max(0, totalLines - windowHeight);
    const currentScroll = Math.max(
      0,
      Math.min(maxScroll, logScrollOffset),
    );

    const thumbHeight = Math.max(
      1,
      Math.round((windowHeight / Math.max(1, totalLines)) * windowHeight),
    );
    const maxThumbTop = Math.max(0, windowHeight - thumbHeight);
    const thumbTop =
      maxScroll > 0
        ? Math.min(
            maxThumbTop,
            Math.round((currentScroll / maxScroll) * maxThumbTop),
          )
        : 0;

    return (
      <Box
        flexDirection="column"
        width={modalWidth}
        borderStyle="round"
        borderColor="yellow"
        paddingX={1}
        paddingY={1}
        marginBottom={1}
      >
        <Box
          justifyContent="space-between"
          marginBottom={1}
          width="100%"
          paddingX={1}
        >
          <Text bold color="yellow" wrap="truncate-end">
            📋 {language === 'es' ? 'Registros de Diagnóstico (/logs)' : 'Diagnostic Logs (/logs)'}
          </Text>
          <Text dimColor wrap="truncate-end">
            {totalLines > windowHeight
              ? `${currentScroll + 1}-${Math.min(
                  totalLines,
                  currentScroll + windowHeight,
                )} / ${totalLines}`
              : `${totalLines} ${language === 'es' ? 'líneas' : 'lines'}`}
          </Text>
        </Box>

        <Box
          paddingX={1}
          marginBottom={1}
          flexDirection="row"
          justifyContent="space-between"
          width="100%"
        >
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {language === 'es' ? 'Archivo:' : 'File:'}{' '}
              {Logger.getLogFilePath().replace(os.homedir(), '~')}
            </Text>
          </Box>
          <Box flexShrink={0} paddingLeft={2}>
            <Text dimColor>
              {language === 'es' ? '[c] Borrar logs' : '[c] Clear logs'}
            </Text>
          </Box>
        </Box>

        {/* Scrollable Log Lines Box with Vertical Scrollbar */}
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          paddingY={0}
          marginBottom={1}
          height={windowHeight + 2}
        >
          {totalLines === 0 ? (
            <Text dimColor>
              {language === 'es'
                ? '(No hay registros aún en el archivo de log)'
                : '(No log entries recorded yet)'}
            </Text>
          ) : (
            Array.from({ length: windowHeight }, (_, idx) => {
              const lineIdx = currentScroll + idx;
              const rawLine = lineIdx < totalLines ? lines[lineIdx] : '';
              const isThumb =
                totalLines > windowHeight &&
                idx >= thumbTop &&
                idx < thumbTop + thumbHeight;

              const isError = rawLine.includes('[ERROR]');
              const isWarn = rawLine.includes('[WARN ]');
              const isDebug = rawLine.includes('[DEBUG]');
              const textColor = isError
                ? 'red'
                : isWarn
                  ? 'yellow'
                  : isDebug
                    ? 'gray'
                    : 'white';

              return (
                <Box key={idx} justifyContent="space-between" width="100%">
                  <Box flexShrink={1}>
                    <Text
                      color={textColor}
                      bold={isError}
                      wrap="truncate-end"
                    >
                      {rawLine || ' '}
                    </Text>
                  </Box>
                  {totalLines > windowHeight && (
                    <Box flexShrink={0} paddingLeft={1}>
                      <Text
                        color={isThumb ? 'yellow' : 'gray'}
                        bold={isThumb}
                      >
                        {isThumb ? '█' : '░'}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            })
          )}
        </Box>

        <Box justifyContent="space-between" paddingX={1}>
          <Text dimColor>
            {language === 'es'
              ? '↑/↓ o Rueda Ratón · PgUp/PgDn · [c] Limpiar · [Esc] Cerrar'
              : '↑/↓ or Mouse Wheel · PgUp/PgDn · [c] Clear · [Esc] Close'}
          </Text>
          <Text dimColor>
            [Esc] {language === 'es' ? 'Cerrar' : 'Close'}
          </Text>
        </Box>
      </Box>
    );
  };

  // Interactive LLM Authentication Modal (/auth)
  const renderAuthModal = () => {
    const modalWidth = Math.min(94, Math.max(76, dimensions.columns - 4));
    const providers = AuthStorage.listProviders();
    const activeProv = providers[selectedAuthIdx] ?? providers[0];

    return (
      <Box
        flexDirection="column"
        width={modalWidth}
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        paddingY={1}
        marginBottom={1}
      >
        <Box
          justifyContent="space-between"
          marginBottom={1}
          width="100%"
          paddingX={1}
        >
          <Text bold color="cyan" wrap="truncate-end">
            🔑 {language === 'es' ? 'Autenticación de Proveedores LLM (/auth)' : 'LLM Provider Authentication (/auth)'}
          </Text>
          <Text dimColor wrap="truncate-end">
            {AuthStorage.getAuthFilePath().replace(os.homedir(), '~')} (chmod 0600)
          </Text>
        </Box>

        <Box paddingX={1} marginBottom={1}>
          <Text dimColor wrap="truncate-end">
            {language === 'es'
              ? 'Configuración de API keys en almacenamiento persistente con permisos POSIX 0600.'
              : 'Secure persistent storage for proprietary LLM provider API keys (chmod 0600).'}
          </Text>
        </Box>

        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          {providers.map((p, idx) => {
            const isSelected = idx === selectedAuthIdx;
            const isConfigured = p.status === 'CONFIGURED';
            return (
              <Box
                key={p.id}
                flexDirection="row"
                justifyContent="space-between"
                width="100%"
              >
                <Box flexDirection="row">
                  <Text bold={isSelected} color={isSelected ? 'cyan' : undefined}>
                    {isSelected ? '❯ ' : '  '}
                    {p.name.padEnd(28, ' ')}
                  </Text>
                  <Text color={isConfigured ? 'green' : 'gray'} bold={isConfigured}>
                    {isConfigured ? '[CONFIGURED]    ' : '[NOT CONFIGURED]'}
                  </Text>
                  {p.maskedKey && (
                    <Text dimColor>  {p.maskedKey.padEnd(16, ' ')}</Text>
                  )}
                </Box>
                <Text dimColor wrap="truncate-end">
                  {p.source === 'env'
                    ? `(env: ${p.envVar})`
                    : p.source === 'sso'
                      ? `(SSO${p.ssoEmail ? `: ${p.ssoEmail}` : ''})`
                      : p.source === 'file'
                        ? '(auth.json)'
                        : p.supportsSso
                          ? '(API KEY / SSO)'
                          : `(${p.envVar})`}
                </Text>
              </Box>
            );
          })}
        </Box>

        {authSubMode === 'choose_method' ? (
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="cyan"
            paddingX={1}
            paddingY={0}
            marginBottom={1}
          >
            <Text bold color="cyan">
              {language === 'es'
                ? `Método de autenticación para ${activeProv?.name ?? 'Google Antigravity'}:`
                : `Authentication method for ${activeProv?.name ?? 'Google Antigravity'}:`}
            </Text>
            <Text bold={authMethodIdx === 0} color={authMethodIdx === 0 ? 'green' : undefined}>
              {authMethodIdx === 0 ? '❯ ' : '  '}
              {language === 'es'
                ? '1. API KEY (AIzaSy... guardada en auth.json)'
                : '1. API KEY (AIzaSy... saved in auth.json)'}
            </Text>
            <Text bold={authMethodIdx === 1} color={authMethodIdx === 1 ? 'green' : undefined}>
              {authMethodIdx === 1 ? '❯ ' : '  '}
              {language === 'es'
                ? '2. SSO (Google OpenID Connect — Abre navegador del sistema)'
                : '2. SSO (Google OpenID Connect — Opens system browser)'}
            </Text>
            <Box marginTop={0}>
              <Text dimColor>
                {language === 'es'
                  ? '↑/↓ o 1/2 para elegir · [Enter] continuar · [Esc] volver'
                  : '↑/↓ or 1/2 to choose · [Enter] continue · [Esc] back'}
              </Text>
            </Box>
          </Box>
        ) : authSubMode === 'sso_form' ? (
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="green"
            paddingX={1}
            paddingY={0}
            marginBottom={1}
          >
            <Text bold color="green">
              {language === 'es'
                ? `Google OpenID Connect SSO (${activeProv?.name ?? 'Google Antigravity'})`
                : `Google OpenID Connect SSO (${activeProv?.name ?? 'Google Antigravity'})`}
            </Text>
            <Box flexDirection="row">
              <Text color={ssoFieldIdx === 0 ? 'cyan' : 'gray'} bold={ssoFieldIdx === 0}>
                {ssoFieldIdx === 0 ? '❯ ' : '  '}Client ID:{' '}
              </Text>
              <Text bold>
                {ssoClientIdDraft.length > 0 ? (
                  ssoClientIdDraft
                ) : (
                  <Text dimColor>
                    {language === 'es'
                      ? '<pega tu xxxx.apps.googleusercontent.com>'
                      : '<paste your xxxx.apps.googleusercontent.com>'}
                  </Text>
                )}
              </Text>
            </Box>
            <Box flexDirection="row">
              <Text color={ssoFieldIdx === 1 ? 'cyan' : 'gray'} bold={ssoFieldIdx === 1}>
                {ssoFieldIdx === 1 ? '❯ ' : '  '}Client Secret (opcional):{' '}
              </Text>
              <Text bold>
                {ssoClientSecretDraft.length > 0 ? (
                  AuthStorage.maskApiKey(ssoClientSecretDraft)
                ) : (
                  <Text dimColor>
                    {language === 'es' ? '<opcional>' : '<optional>'}
                  </Text>
                )}
              </Text>
            </Box>
            {ssoError ? (
              <Text color="red" wrap="truncate-end">
                ✖ {ssoError}
              </Text>
            ) : null}
            <Box marginTop={0}>
              <Text dimColor>
                {language === 'es'
                  ? '[Tab/↑/↓] Cambiar campo · [Enter] Abrir navegador SSO · [Esc] Volver'
                  : '[Tab/↑/↓] Switch field · [Enter] Launch SSO browser · [Esc] Back'}
              </Text>
            </Box>
          </Box>
        ) : authSubMode === 'sso_waiting' ? (
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="yellow"
            paddingX={1}
            paddingY={0}
            marginBottom={1}
          >
            <Text bold color="yellow">
              {language === 'es'
                ? '🌐 Esperando inicio de sesión OpenID Connect en el navegador del sistema...'
                : '🌐 Waiting for OpenID Connect login in your system browser...'}
            </Text>
            {ssoAuthUrl ? (
              <Text dimColor>
                URL: {ssoAuthUrl}
              </Text>
            ) : null}
            <Text dimColor>
              {language === 'es'
                ? 'Completa el login en Google y volverás automáticamente · [o] Reabrir navegador · [Esc] Cancelar'
                : 'Complete the Google sign-in in your browser · [o] Reopen browser · [Esc] Cancel'}
            </Text>
          </Box>
        ) : isEditingAuthKey ? (
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="green"
            paddingX={1}
            paddingY={0}
            marginBottom={1}
          >
            <Text bold color="green">
              {language === 'es'
                ? `Ingresar API Key para ${activeProv?.name ?? 'Proveedor'}:`
                : `Enter API Key for ${activeProv?.name ?? 'Provider'}:`}
            </Text>
            <Box flexDirection="row" marginTop={0}>
              <Text color="cyan">❯ </Text>
              <Text bold>
                {authKeyDraft.length > 0 ? (
                  AuthStorage.maskApiKey(authKeyDraft)
                ) : (
                  <Text dimColor>
                    {language === 'es' ? 'Escribe o pega la clave...' : 'Type or paste API key...'}
                  </Text>
                )}
              </Text>
            </Box>
            <Box marginTop={0} justifyContent="space-between">
              <Text dimColor>
                {language === 'es'
                  ? 'Presiona [Enter] para guardar · [Esc] para cancelar'
                  : 'Press [Enter] to save · [Esc] to cancel'}
              </Text>
              <Text dimColor>({authKeyDraft.length} chars)</Text>
            </Box>
          </Box>
        ) : (
          <Box
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            justifyContent="space-between"
          >
            <Text dimColor>
              <Text bold color="cyan">↑/↓</Text> {language === 'es' ? 'Navegar' : 'Navigate'}  ·  
              <Text bold color="green"> Enter / e</Text> {language === 'es' ? 'Editar' : 'Edit'}  ·  
              <Text bold color="red"> d</Text> {language === 'es' ? 'Borrar' : 'Delete'}  ·  
              <Text bold color="yellow"> Esc / q</Text> {language === 'es' ? 'Cerrar' : 'Close'}
            </Text>
            <Text dimColor>
              {language === 'es' ? 'Prioridad: ENV > auth.json' : 'Precedence: ENV > auth.json'}
            </Text>
          </Box>
        )}
      </Box>
    );
  };

  const renderExitConfirmModal = () => (
    <Box
      flexDirection="column"
      width={Math.min(64, dimensions.columns - 8)}
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      alignItems="center"
    >
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color="yellow">
          {language === 'es'
            ? '¿Realmente desea salir de PO CLI?'
            : 'Are you sure you want to exit PO CLI?'}
        </Text>
      </Box>
      <Box justifyContent="center">
        <Text color="red" bold>
          [ {language === 'es' ? 'Sí' : 'Yes'} (y / Enter) ]
        </Text>
        <Text>{'   '}</Text>
        <Text color="green">
          [ {language === 'es' ? 'No' : 'No'} (n / Esc) ]
        </Text>
      </Box>
    </Box>
  );

  // Interactive Floating Repository Code Tree Explorer Modal (Shift-T / /tree)
  const renderTreeExplorerModal = () => {
    const modalHeight = Math.max(12, Math.min(safeViewportHeight - 4, 30));

    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        width={treeExplorerWidth}
        marginBottom={1}
      >
        <FileTreeExplorer
          state={treeState}
          width={treeExplorerWidth}
          height={modalHeight}
          language={language}
        />
      </Box>
    );
  };

  const renderSlashPopoverMenu = (menuWidth?: number | string) => {
    if (!isSlashMenuOpen) return null;
    const windowSize = 8;
    const start = Math.max(
      0,
      Math.min(
        selectedSlashIdx - Math.floor(windowSize / 2),
        Math.max(0, filteredSlashCommands.length - windowSize),
      ),
    );
    const visible = filteredSlashCommands.slice(start, start + windowSize);

    return (
      <Box
        flexDirection="column"
        width={menuWidth ?? '100%'}
        borderStyle="round"
        borderColor="blue"
        paddingX={0}
        paddingY={0}
        marginBottom={0}
      >
        {filteredSlashCommands.length === 0 ? (
          <Box paddingX={1}>
            <Text dimColor>
              {t.noCommandMatches} "{inputValue}"
            </Text>
          </Box>
        ) : (
          visible.map((item, localIdx) => {
            const realIdx = start + localIdx;
            const isSelected = realIdx === selectedSlashIdx;
            const padLen =
              typeof menuWidth === 'number'
                ? Math.max(20, menuWidth - 4)
                : Math.max(30, dimensions.columns - 36);
            const rowContent = `${item.command.padEnd(16, ' ')}${item.description}`.padEnd(
              padLen,
              ' ',
            );
            return (
              <Box
                key={item.command}
                width="100%"
                paddingX={1}
                flexDirection="row"
              >
                {isSelected ? (
                  <Text color="white" backgroundColor="blue" bold>
                    {rowContent}
                  </Text>
                ) : (
                  <>
                    <Text color="cyan">
                      {item.command.padEnd(16, ' ')}
                    </Text>
                    <Text dimColor>{item.description}</Text>
                  </>
                )}
              </Box>
            );
          })
        )}
      </Box>
    );
  };

  const renderFormattedContent = (
    text: string,
    isLineSelected: boolean,
  ) => {
    const isErrorText = text.startsWith('✖');
    if (!text.includes('```')) {
      return (
        <Text
          color={isErrorText ? 'red' : 'white'}
          bold={isErrorText}
          backgroundColor={isLineSelected ? 'yellow' : undefined}
        >
          {text}
        </Text>
      );
    }
    const parts = text.split(/(```[\s\S]*?```)/g);
    return (
      <Box flexDirection="column">
        {parts.map((part, pIdx) => {
          if (part.startsWith('```') && part.endsWith('```')) {
            const lines = part.slice(3, -3).trim().split('\n');
            const firstLine = lines[0]?.trim().toLowerCase();
            const isBash =
              firstLine === 'bash' ||
              firstLine === 'sh' ||
              firstLine === 'shell' ||
              firstLine === 'zsh';
            const codeLines = isBash ? lines.slice(1) : lines;
            return (
              <Box
                key={pIdx}
                borderStyle="round"
                borderColor="gray"
                paddingX={1}
                flexDirection="column"
                marginY={1}
              >
                {codeLines.map((line, lIdx) => (
                  <Text
                    key={lIdx}
                    color={line.startsWith('$') ? 'cyan' : 'white'}
                    dimColor={!line.startsWith('$')}
                  >
                    {line}
                  </Text>
                ))}
              </Box>
            );
          }
          if (!part.trim()) return null;
          return (
            <Text
              key={pIdx}
              color="white"
              backgroundColor={isLineSelected ? 'yellow' : undefined}
            >
              {part}
            </Text>
          );
        })}
      </Box>
    );
  };

  // Keep root Box height strictly < stdout.rows (rows - 1) so Ink never hits
  // its `outputHeight >= stdout.rows` branch in ink.js:121 which executes a
  // full `ansiEscapes.clearTerminal` (\x1b[2J\x1b[3J\x1b[H) on every keystroke.

  const sidebarWidth = Math.max(
    22,
    Math.min(30, Math.floor(dimensions.columns * 0.20)),
  );
  const unifiedChatBoxWidth = Math.max(
    30,
    dimensions.columns - sidebarWidth - 4,
  );

  const renderUnifiedPromptBox = (boxWidth: number, placeholder: string) => {
    const innerWidth = Math.max(10, boxWidth - 2);
    const rawLines =
      inputValue.length === 0
        ? [placeholder]
        : wrapTextLines(inputValue, innerWidth);

    const minPromptHeight = 3;
    const displayLines = [...rawLines];
    while (displayLines.length < minPromptHeight) {
      displayLines.push('');
    }

    return (
      <Box flexDirection="column" marginTop={1} width={boxWidth}>
        {displayLines.map((line, idx) => {
          const isPlaceholder = inputValue.length === 0 && idx === 0;
          const isLastContentLine = idx === rawLines.length - 1;
          const lineContent = isPlaceholder
            ? line
            : inputValue.length > 0 && isLastContentLine
              ? `${line}█`
              : line;

          return (
            <Box key={idx} flexDirection="row" width={boxWidth}>
              <Text
                color={themePalette.cyan}
                backgroundColor={themePalette.cardBg}
                bold
              >
                │{' '}
              </Text>
              <Text
                color={isPlaceholder ? 'cyan' : 'white'}
                bold={!isPlaceholder}
                backgroundColor={themePalette.cardBg}
              >
                {lineContent.padEnd(innerWidth, ' ')}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  };

  // ==========================================================================
  // RENDER MODE 1: OPENCODE STARTUP SCREEN (CENTERED LOGO + COMPACT PROMPT)
  // ==========================================================================
  if (viewMode === 'startup') {
    const promptBoxWidth = Math.min(86, Math.max(56, dimensions.columns - 8));

    return (
      <Box
        flexDirection="column"
        width={dimensions.columns}
        height={safeViewportHeight}
        justifyContent="space-between"
        paddingX={1}
        paddingY={0}
      >
        <Box height={1} />

        {anyModalOpen ? (
          <Box
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            flexGrow={1}
            width="100%"
          >
            {projectWizardStep !== 'CLOSED' && renderProjectWizardModal()}
            {isProjectsModalOpen && renderProjectsListModal()}
            {isAgentsModalOpen && renderAgentsModal()}
            {isSystemModalOpen && renderSystemModal()}
            {isModelsModalOpen && renderModelsModal()}
            {dbModalOutput.length > 0 && renderDbModal()}
            {isLogsModalOpen && renderLogsModal()}
            {isAuthModalOpen && renderAuthModal()}
            {isHelpOpen && renderHelpModal()}
            {isHowtoOpen && renderHowtoModal()}
            {isSettingsOpen && renderSettingsModal()}
            {isWorkersModalOpen && renderWorkersModal()}
            {isExitConfirmOpen && renderExitConfirmModal()}
            {isTreeExplorerOpen && renderTreeExplorerModal()}
          </Box>
        ) : (
          <Box
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            flexGrow={1}
            height={Math.max(8, safeViewportHeight - 3)}
          >
              <Box flexDirection="column" alignItems="center">
                {ASCII_LOGO.map((line, idx) => (
                  <Text key={idx} color="cyan" bold>
                    {line}
                  </Text>
                ))}
              </Box>

              <Box marginTop={1} marginBottom={2}>
                <Text color="cyan">
                  /projects {language === 'es' ? 'para seleccionar proyecto' : 'to switch project'}  ·  /howto {language === 'es' ? 'guía de inicio' : 'getting started'}  ·  /help {language === 'es' ? 'ayuda' : 'help'}
                </Text>
              </Box>

              {isSlashMenuOpen && (
                <Box width={promptBoxWidth} marginBottom={0}>
                  {renderSlashPopoverMenu(promptBoxWidth)}
                </Box>
              )}

              {renderUnifiedPromptBox(
                promptBoxWidth,
                project
                  ? (language === 'es'
                      ? 'Centro de comandos... "/projects para cambiar de proyecto"'
                      : 'Command center... "/projects to switch project"')
                  : (language === 'es'
                      ? 'Centro de comandos... "/project para crear un proyecto"'
                      : 'Command center... "/project to create a new project"'),
              )}
            </Box>
        )}

        {/* Bottom Footer Bar:
            Active Project: <name>     ctrl+n cycle   shift+tab agents   ctrl+p commands              1.0.0 */}
        <Box width="100%" justifyContent="space-between" height={1}>
          <Box flexDirection="row">
            <Text bold color="white" backgroundColor="blue">
              {project
                ? ` Active Project: ${project.name} `
                : ' Active project: No projects created yet '}
            </Text>
          </Box>
          <Box flexDirection="row">
            <Text color="gray">ctrl+n </Text>
            <Text color="white">cycle   </Text>
            <Text color="gray">shift+tab </Text>
            <Text color="white">agents   </Text>
            <Text color="gray">ctrl+p </Text>
            <Text color="white">commands</Text>
          </Box>
          <Box flexDirection="row">
            <Text color="gray">1.0.0</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // ==========================================================================
  // RENDER MODE 2: OPENCODE CHAT VIEW (EXACT STRUCTURE MATCHING SCREENSHOT)
  // ==========================================================================
  if (viewMode === 'chat') {
    const chatBarWidth = Math.max(40, dimensions.columns - 2);
    const chatAreaWidth = unifiedChatBoxWidth;
    const contentHeight = Math.max(8, safeViewportHeight - 3);
    // Height of the bottom prompt box (min 3 lines + 1 line marginTop)
    const promptBoxLines = Math.max(
      3,
      inputValue.length === 0
        ? 1
        : wrapTextLines(inputValue, Math.max(10, chatAreaWidth - 2)).length,
    );
    const messagesViewportHeight = Math.max(3, contentHeight - (promptBoxLines + 1));
    chatViewportHeightRef.current = messagesViewportHeight;
    const chatContentWidth = Math.max(10, chatAreaWidth - 3);

    const chatVisualLines = buildChatVisualLines({
      messages,
      activeStreamingText,
      isActiveRoleBusy,
      activeRoleQueuedCount,
      activeRoleDisplayName,
      activeModelDisplayName: activeModelEntry.displayName,
      chatContentWidth,
      language,
      thinkingSpinner,
      queuedMessageIds: queuedMessageIds as Set<string | number>,
    });

    const scrollbarState = computeScrollbar(
      chatVisualLines.length,
      messagesViewportHeight,
      chatScrollOffset,
    );
    chatMaxScrollRef.current = scrollbarState.maxScroll;

    const chatSlice = sliceChatLines(
      chatVisualLines,
      messagesViewportHeight,
      chatScrollOffset,
    );

    const renderChatVisualItem = (
      item: ChatVisualItem,
      isLineSelected: boolean,
      contentWidth: number,
    ) => {
      const textWidth = Math.max(10, contentWidth - 2);

      switch (item.kind) {
        case 'empty-state':
          return (
            <Text dimColor>
              {item.text}
            </Text>
          );

        case 'user-card-pad':
          return (
            <Box flexDirection="row" flexShrink={0} width={contentWidth}>
              <Text color="cyan" backgroundColor={themePalette.cardBg} bold>
                │{' '}
              </Text>
              <Text backgroundColor={themePalette.cardBg}>
                {' '.repeat(Math.max(0, textWidth))}
              </Text>
            </Box>
          );

        case 'user-card-line':
          return (
            <Box flexDirection="row" flexShrink={0} width={contentWidth}>
              <Text color="cyan" backgroundColor={themePalette.cardBg} bold>
                │{' '}
              </Text>
              <Text
                color="cyan"
                bold
                backgroundColor={isLineSelected ? 'yellow' : themePalette.cardBg}
              >
                {item.text}
              </Text>
              {item.queueBadge ? (
                <Text
                  color={themePalette.yellow}
                  backgroundColor={themePalette.cardBg}
                  bold
                >
                  {item.queueBadge}
                </Text>
              ) : null}
              <Text backgroundColor={themePalette.cardBg}>
                {' '.repeat(
                  Math.max(
                    0,
                    textWidth -
                      item.text.length -
                      (item.queueBadge?.length || 0),
                  ),
                )}
              </Text>
            </Box>
          );

        case 'assistant-citation-header':
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text dimColor>{item.text}</Text>
            </Box>
          );

        case 'assistant-citation-box':
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text dimColor>{item.text}</Text>
            </Box>
          );

        case 'assistant-tool-header':
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text dimColor>{item.text}</Text>
            </Box>
          );

        case 'assistant-tool-box':
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text color="cyan">{item.text}</Text>
            </Box>
          );

        case 'assistant-code-top': {
          const lang = item.text || 'code';
          const dashes = Math.max(0, contentWidth - 10 - lang.length);
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text dimColor>┌─ [{lang}] {'─'.repeat(dashes)}┐</Text>
            </Box>
          );
        }

        case 'assistant-code-line':
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text
                color={item.text.startsWith('$') ? 'cyan' : 'white'}
                dimColor={!item.text.startsWith('$')}
              >
                │ {item.text}
              </Text>
            </Box>
          );

        case 'assistant-code-bottom': {
          const dashes = Math.max(0, contentWidth - 4);
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text dimColor>└{'─'.repeat(dashes)}┘</Text>
            </Box>
          );
        }

        case 'assistant-text':
          if (item.text === '') {
            return <Box height={1} flexShrink={0} />;
          }
          const isTableLine = item.isTableLine ?? item.text.trim().startsWith('|');
          const isTableSep = item.isTableSep ?? (isTableLine && item.text.includes('---'));
          const isTableHeader =
            item.isTableHeader ??
            (isTableLine &&
              !isTableSep &&
              (item.text.includes('Artefacto') || item.text.includes('Artifact')));
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text
                color={
                  item.isError
                    ? 'red'
                    : isTableSep
                      ? 'gray'
                      : isTableHeader
                        ? 'cyan'
                        : 'white'
                }
                bold={item.isError || isTableHeader}
                dimColor={isTableSep}
                backgroundColor={isLineSelected ? 'yellow' : undefined}
              >
                {item.text}
              </Text>
            </Box>
          );

        case 'assistant-footer':
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              {item.isError ? (
                <>
                  <Text color="red" bold>
                    Error
                  </Text>
                  <Text dimColor>
                    {' '}
                    · {activeRoleDisplayName} ·{' '}
                    {language === 'es' ? 'No accesible' : 'Unreachable'}
                  </Text>
                </>
              ) : (
                <>
                  <Text color="cyan" bold>
                    Build
                  </Text>
                  <Text dimColor>
                    {' '}
                    · {activeRoleDisplayName} · {item.text}
                  </Text>
                </>
              )}
            </Box>
          );

        case 'thinking':
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text color={activeTheme.accentColor} bold>
                {activeRoleDisplayName}
              </Text>
              <Text dimColor italic>
                {' '}
                {thinkingSpinner}{' '}
                {item.text.replace(activeRoleDisplayName, '').trim()}
              </Text>
            </Box>
          );

        case 'streaming-header':
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text color={activeTheme.accentColor} bold>
                {activeRoleDisplayName}
              </Text>
              <Text dimColor> · streaming</Text>
            </Box>
          );

        case 'streaming-line':
          return (
            <Box flexDirection="row" flexShrink={0} paddingLeft={2}>
              <Text color="green">{item.text}</Text>
            </Box>
          );

        case 'separator':
        default:
          return <Box height={1} flexShrink={0} />;
      }
    };

    return (
      <Box
        flexDirection="column"
        width={dimensions.columns}
        height={safeViewportHeight}
        justifyContent="space-between"
        paddingX={1}
        paddingY={0}
      >
        {/* Top Banner with Solid Background Color of the Active Agent */}
        {renderTopColorBanner(chatBarWidth)}

        {/* Center Main Area:
            If a modal is open, render modal centered.
            Otherwise, render the two-column OpenCode Chat Layout:
            [Left: Conversation + Tool Output + Prompt Box] | [Right: Project Info & Context Sidebar] */}
        {anyModalOpen ? (
          <Box
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            flexGrow={1}
            width="100%"
          >
            {projectWizardStep !== 'CLOSED' && renderProjectWizardModal()}
            {isProjectsModalOpen && renderProjectsListModal()}
            {isAgentsModalOpen && renderAgentsModal()}
            {isSystemModalOpen && renderSystemModal()}
            {isModelsModalOpen && renderModelsModal()}
            {dbModalOutput.length > 0 && renderDbModal()}
            {isLogsModalOpen && renderLogsModal()}
            {isAuthModalOpen && renderAuthModal()}
            {isHelpOpen && renderHelpModal()}
            {isHowtoOpen && renderHowtoModal()}
            {isSettingsOpen && renderSettingsModal()}
            {isWorkersModalOpen && renderWorkersModal()}
            {isExitConfirmOpen && renderExitConfirmModal()}
            {isTreeExplorerOpen && renderTreeExplorerModal()}
          </Box>
        ) : (
          <Box flexDirection="row" width="100%" height={contentHeight}>
            {/* Main Chat Area */}
            <Box
              flexDirection="column"
              width={chatAreaWidth}
              height="100%"
              justifyContent="space-between"
              marginRight={2}
            >
              {/* Scrollable Conversation messages with vertical scrollbar */}
              <Box
                flexDirection="row"
                width={chatAreaWidth}
                height={messagesViewportHeight}
                flexShrink={0}
                overflowY="hidden"
              >
                {/* Visual Line Messages Column */}
                <Box
                  flexDirection="column"
                  width={chatContentWidth}
                  height={messagesViewportHeight}
                  flexShrink={0}
                  overflowY="hidden"
                >
                  {(() => {
                    renderedConversationLinesRef.current = [];
                    return chatSlice.visibleLines.map((item, vIdx) => {
                      const screenRow = 2 + vIdx;
                      if (item.text) {
                        renderedConversationLinesRef.current.push({
                          y: screenRow,
                          minX: 4,
                          maxX: chatContentWidth,
                          text: item.text,
                          fullContent: item.text,
                        });
                      }

                      const isLineSelected =
                        selectionRange !== null &&
                        selectionRange.startY <= screenRow &&
                        selectionRange.endY >= screenRow;

                      return (
                        <Box
                          key={item.id}
                          height={1}
                          flexShrink={0}
                          overflowX="hidden"
                        >
                          {renderChatVisualItem(
                            item,
                            isLineSelected,
                            chatContentWidth,
                          )}
                        </Box>
                      );
                    });
                  })()}
                  {chatSlice.emptyPaddingRows > 0 && (
                    <Box
                      height={chatSlice.emptyPaddingRows}
                      flexShrink={0}
                    />
                  )}
                </Box>

                {/* Vertical Scrollbar Column */}
                <Box
                  flexDirection="column"
                  width={2}
                  height={messagesViewportHeight}
                  flexShrink={0}
                  alignItems="flex-end"
                >
                  {scrollbarState.showScrollbar ? (
                    scrollbarState.trackRows.map((char, rIdx) => {
                      const isThumb = char === '█';
                      return (
                        <Box key={rIdx} height={1} flexShrink={0}>
                          <Text
                            color={isThumb ? activeTheme.accentColor : 'gray'}
                            dimColor={!isThumb}
                            bold={isThumb}
                          >
                            {char}{' '}
                          </Text>
                        </Box>
                      );
                    })
                  ) : (
                    <Box
                      width={2}
                      height={messagesViewportHeight}
                      flexShrink={0}
                    />
                  )}
                </Box>
              </Box>

              {/* Slash Command Popover Menu when user types "/" */}
              {isSlashMenuOpen && renderSlashPopoverMenu('100%')}

              {/* Bottom Prompt / Input Box with dynamic height growth matching OpenCode aesthetic */}
              {renderUnifiedPromptBox(
                unifiedChatBoxWidth,
                language === 'es'
                  ? 'Escribe un mensaje para el agente... (Esc o Ctrl+A para ventana principal)'
                  : 'Type a message for the agent... (Esc or Ctrl+A for main window)',
              )}
            </Box>

            {/* Right Column: Project Info & Context Sidebar (OpenCode shaded panel) */}
            {sidebarWidth > 0 && (() => {
              const sidebarLines: Array<{ text: string; color?: string; bold?: boolean; dimColor?: boolean }> = [
                { text: project?.name || 'pocli', bold: true, color: 'white' },
                { text: '' },
                { text: 'Context', bold: true, color: 'white' },
                { text: `${estimatedTokens.toLocaleString()} tokens`, dimColor: true },
                { text: `${Math.max(1, Math.round((estimatedTokens / 200000) * 100))}% used`, dimColor: true },
                { text: activeModelEntry.isFree ? '$0.00 spent' : '$0.02 spent', dimColor: true },
                { text: '' },
                { text: language === 'es' ? 'Proyecto' : 'Project', bold: true, color: 'white' },
                { text: project?.name || (language === 'es' ? 'Ninguno' : 'None'), color: 'white' },
                { text: project ? `v${project.approvedArchitectureVersion} (${project.phase.replace('PHASE_', '')})` : (language === 'es' ? 'Sin proyecto' : 'No project'), dimColor: true },
                { text: '' },
                { text: language === 'es' ? 'Especialista' : 'Specialist', bold: true, color: 'white' },
                { text: activeRoleDisplayName, color: activeTheme.accentColor, bold: true },
                { text: activeModelEntry.displayName, dimColor: true },
                { text: '' },
                { text: language === 'es' ? 'Artefactos' : 'Artifacts', bold: true, color: 'white' },
                { text: `${artifacts.length} ${language === 'es' ? 'activos' : 'active'}`, dimColor: true },
              ];

              if (isAnyRoleBusy) {
                sidebarLines.push({ text: '' });
                sidebarLines.push({
                  text: language === 'es' ? 'Agentes en curso' : 'Active Agents',
                  bold: true,
                  color: 'yellow',
                });
                for (const item of AVAILABLE_AGENTS) {
                  if (!busyRoles[item.role]) continue;
                  const rTheme = getRoleTheme(item.role, theme);
                  const roleStreamText = streamingByRole[item.role] || '';
                  const { isTooling } = filterToolingStream(roleStreamText);
                  const isStreamingThis = Boolean(roleStreamText);
                  const statusLabel = isTooling
                    ? (language === 'es' ? 'creando artefactos' : 'creating artifacts')
                    : isStreamingThis
                      ? 'streaming'
                      : language === 'es'
                        ? 'pensando'
                        : 'thinking';
                  sidebarLines.push({
                    text: `${thinkingSpinner} ${getRoleDisplayName(item.role, language)} (${statusLabel})`,
                    color: rTheme.accentColor,
                  });
                }
              }

              while (sidebarLines.length < contentHeight) {
                sidebarLines.push({ text: '' });
              }

              return (
                <Box flexDirection="column" width={sidebarWidth} height={contentHeight}>
                  {sidebarLines.slice(0, contentHeight).map((line, idx) => (
                    <Text
                      key={idx}
                      color={line.color ?? 'white'}
                      bold={line.bold ?? false}
                      dimColor={line.dimColor ?? false}
                      backgroundColor={themePalette.cardBg}
                    >
                      {` ${line.text}`.padEnd(sidebarWidth, ' ').slice(0, sidebarWidth)}
                    </Text>
                  ))}
                </Box>
              );
            })()}
          </Box>
        )}

        {/* Bottom Footer Bar */}
        <Box width="100%" justifyContent="space-between" height={1}>
          <Box flexDirection="row">
            <Text color={isAnyRoleBusy ? 'cyan' : 'gray'}>
              {isAnyRoleBusy ? '■■■···· ' : '■······ '}
            </Text>
            <Text color="gray">{language === 'es' ? 'esc principal' : 'esc main'} · </Text>
            <Text color={isTreeExplorerOpen ? 'cyan' : 'gray'} bold={isTreeExplorerOpen}>
              shift+t {language === 'es' ? 'árbol' : 'tree'}
            </Text>
          </Box>
          <Box flexDirection="row">
            <Text color="gray">ctrl+n </Text>
            <Text color="white">cycle   </Text>
            <Text color="gray">
              {(estimatedTokens / 1000).toFixed(1)}K ({Math.max(1, Math.round((estimatedTokens / 200000) * 100))}%) · {activeModelEntry.isFree ? '$0.00' : '$0.02'}{'  '}
            </Text>
            <Text bold color="white">
              ctrl+a{' '}
            </Text>
            <Text color="gray">{language === 'es' ? 'inicio' : 'home'}</Text>
          </Box>
          <Box flexDirection="row">
            <Text bold color="white" backgroundColor="blue">
              {project
                ? ` Active Project: ${project.name} `
                : ' Active project: No projects created yet '}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // ==========================================================================
  // RENDER MODE 2: MULTIPANEL COMMAND CENTER VIEW (TOGGLED VIA CTRL+TAB)
  // ==========================================================================
  const multipanelBarWidth = Math.max(40, dimensions.columns - 4);
  const expertBoxInnerWidth = Math.max(
    18,
    Math.floor((dimensions.columns - 4) / 4) - 2,
  );

  return (
    <Box
      flexDirection="column"
      width={dimensions.columns}
      height={safeViewportHeight}
      justifyContent="space-between"
      paddingX={1}
      borderStyle="round"
      borderColor={activeTheme.accentColor}
    >
      {/* Top Banner with Solid Background Color of the Active Agent */}
      {renderTopColorBanner(multipanelBarWidth)}

      {anyModalOpen ? (
        <Box
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          flexGrow={1}
          width="100%"
        >
          {projectWizardStep !== 'CLOSED' && renderProjectWizardModal()}
          {isProjectsModalOpen && renderProjectsListModal()}
          {isAgentsModalOpen && renderAgentsModal()}
          {isSystemModalOpen && renderSystemModal()}
          {isModelsModalOpen && renderModelsModal()}
          {dbModalOutput.length > 0 && renderDbModal()}
          {isLogsModalOpen && renderLogsModal()}
          {isAuthModalOpen && renderAuthModal()}
          {isHelpOpen && renderHelpModal()}
          {isHowtoOpen && renderHowtoModal()}
          {isSettingsOpen && renderSettingsModal()}
          {isWorkersModalOpen && renderWorkersModal()}
          {isExitConfirmOpen && renderExitConfirmModal()}
          {isTreeExplorerOpen && renderTreeExplorerModal()}
        </Box>
      ) : (
        <>
          {/* Top Row: 4 Expert Chat Summary Boxes loaded from SQLite.
              All 4 boxes have strictly fixed height (7 rows) and width (25%) with
              PO and peer specialist interaction counters. */}
          <Box flexDirection="row" width="100%" height={7} marginTop={1}>
            {(['pm', 'architect', 'developer', 'qa'] as const).map((roleKey) => {
              const summary = expertSummaries.find(
                (s) => s.expertRole === roleKey,
              ) ?? {
                projectId: project?.id ?? '',
                expertRole: roleKey,
                totalMessages: 0,
                activeContextTokens: 0,
                savedTokensByCompaction: 0,
                compactionCount: 0,
                lastUserPrompt: '',
                lastExpertReply: '',
                summaryText: '',
                recentExchanges: [],
                updatedAt: '',
                interactions: {
                  po: 0,
                  pm: 0,
                  architect: 0,
                  developer: 0,
                  qa: 0,
                },
              };
              const roleTheme = getRoleTheme(roleKey, theme);
              const boxTitle = t.expertBoxTitles[roleKey];
              const isSelected = activeRole === roleKey;
              const isCardBusy = Boolean(busyRoles[roleKey]);
              const roleStreamText = streamingByRole[roleKey] || '';
              const { isTooling } = filterToolingStream(roleStreamText);
              const isCardStreaming = Boolean(roleStreamText);
              const statsBadge = isTooling
                ? `${thinkingSpinner} [${language === 'es' ? 'creando artefactos' : 'creating artifacts'}]`
                : isCardStreaming
                  ? `[streaming]`
                  : isCardBusy
                    ? `${thinkingSpinner} [thinking]`
                    : `(${summary.totalMessages}m·${summary.activeContextTokens}t${
                        summary.savedTokensByCompaction > 0
                          ? `·-${summary.savedTokensByCompaction}t`
                          : ''
                      })`;

              const titlePrefix = isSelected ? ` ▶ ${boxTitle}` : ` ${boxTitle}`;
              const headerGap = Math.max(
                1,
                expertBoxInnerWidth - (titlePrefix.length + statsBadge.length + 1),
              );
              const line1 = fitAndPadLine(
                `${titlePrefix}${' '.repeat(headerGap)}${statsBadge} `,
                expertBoxInnerWidth,
              );

              const poCount = summary.interactions?.po ?? 0;
              const line2 = formatInteractionLine(
                'PO',
                poCount,
                expertBoxInnerWidth,
              );

              const peers = PEER_ROLES_PER_EXPERT[roleKey];
              const peer1Count = summary.interactions?.[peers[0].role] ?? 0;
              const peer2Count = summary.interactions?.[peers[1].role] ?? 0;
              const peer3Count = summary.interactions?.[peers[2].role] ?? 0;

              const line3 = formatInteractionLine(
                peers[0].label,
                peer1Count,
                expertBoxInnerWidth,
              );
              const line4 = formatInteractionLine(
                peers[1].label,
                peer2Count,
                expertBoxInnerWidth,
              );
              const line5 = formatInteractionLine(
                peers[2].label,
                peer3Count,
                expertBoxInnerWidth,
              );

              return (
                <Box
                  key={roleKey}
                  flexDirection="column"
                  width="25%"
                  height={7}
                  borderStyle="round"
                  borderColor={roleTheme.accentColor}
                  paddingX={0}
                >
                  <Text
                    bold
                    wrap="truncate-end"
                    backgroundColor={isSelected ? roleTheme.bgColor : undefined}
                    color={isSelected ? roleTheme.fgColor : roleTheme.accentColor}
                  >
                    {line1}
                  </Text>
                  <Text
                    bold={isSelected || poCount > 0}
                    wrap="truncate-end"
                    backgroundColor={isSelected ? roleTheme.bgColor : undefined}
                    color={
                      isSelected
                        ? roleTheme.fgColor
                        : poCount > 0
                          ? 'white'
                          : undefined
                    }
                    dimColor={!isSelected && poCount === 0}
                  >
                    {line2}
                  </Text>
                  <Text
                    bold={isSelected || peer1Count > 0}
                    wrap="truncate-end"
                    backgroundColor={isSelected ? roleTheme.bgColor : undefined}
                    color={
                      isSelected
                        ? roleTheme.fgColor
                        : peer1Count > 0
                          ? 'white'
                          : undefined
                    }
                    dimColor={!isSelected && peer1Count === 0}
                  >
                    {line3}
                  </Text>
                  <Text
                    bold={isSelected || peer2Count > 0}
                    wrap="truncate-end"
                    backgroundColor={isSelected ? roleTheme.bgColor : undefined}
                    color={
                      isSelected
                        ? roleTheme.fgColor
                        : peer2Count > 0
                          ? 'white'
                          : undefined
                    }
                    dimColor={!isSelected && peer2Count === 0}
                  >
                    {line4}
                  </Text>
                  <Text
                    bold={isSelected || peer3Count > 0}
                    wrap="truncate-end"
                    backgroundColor={isSelected ? roleTheme.bgColor : undefined}
                    color={
                      isSelected
                        ? roleTheme.fgColor
                        : peer3Count > 0
                          ? 'white'
                          : undefined
                    }
                    dimColor={!isSelected && peer3Count === 0}
                  >
                    {line5}
                  </Text>
                </Box>
              );
            })}
          </Box>

          {/* Lower Split Body: Artifacts/Notebooks & Active Direct Channel */}
          <Box flexDirection="row" flexGrow={1} marginTop={1}>
            {/* Left Sidebar: Team, Artifacts & Notebooks */}
            <Box flexDirection="column" width="42%" paddingRight={2}>
              <Text bold underline color="magenta">
                {t.sectionTeamTitle}
              </Text>
              {harnesses.map((h, idx) => {
                const cfg = roleConfigs.find((rc) => rc.role === h.role);
                const isSelected = h.role === activeRole;
                const roleLabel = getRoleDisplayName(h.role, language);
                return (
                  <Text key={h.role} color={isSelected ? 'green' : 'white'}>
                    {isSelected ? '▶ ' : '  '}[{idx + 1}] {roleLabel} (
                    {cfg?.modelId ?? 'default'} |{' '}
                    {cfg?.executionModality ?? 'LOCAL'})
                  </Text>
                );
              })}

              <Box marginTop={1} flexDirection="column">
                <Text bold underline color="magenta">
                  {t.sectionArtifactsTitle(artifacts.length)}
                </Text>
                {artifacts.length === 0 ? (
                  <Text dimColor>{t.noArtifactsYet}</Text>
                ) : (
                  artifacts.slice(0, 6).map((art) => (
                    <Text key={art.id}>
                      {'  '}• <Text bold>{art.code}</Text> v{art.version} [
                      {art.status}] →{' '}
                      {art.tracesTo.join(',') || t.rootTraceLabel}
                    </Text>
                  ))
                )}
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text bold underline color="magenta">
                  {t.sectionNotebooksTitle(notebooks.length)}
                </Text>
                {notebooks.length === 0 ? (
                  <Text dimColor>{t.noNotebooksLinked}</Text>
                ) : (
                  notebooks.map((nb) => (
                    <Text key={nb.id}>
                      {'  '}• <Text bold color="cyan">{nb.name}</Text> (
                      {nb.allowedRoles.join(',')})
                    </Text>
                  ))
                )}
              </Box>
            </Box>

            {/* Right Panel: Worker Runtime & Context/Memory Inspector */}
            {(() => {
              const activeWorkerInfo = project
                ? orchestrator.getWorkerStatus(project.id, activeRole)
                : undefined;
              const isCurrentRoleBusy =
                Boolean(busyRoles[activeRole]) || activeWorkerInfo?.status === 'busy';
              const resolvedWorkerStatus =
                activeWorkerInfo?.status ?? (isCurrentRoleBusy ? 'busy' : 'idle');
              const workerStatusColor = isCurrentRoleBusy
                ? themePalette.yellow
                : resolvedWorkerStatus === 'idle'
                  ? themePalette.green
                  : resolvedWorkerStatus === 'failed'
                    ? themePalette.red
                    : 'gray';
              const workerStatusBadge = isCurrentRoleBusy
                ? '● BUSY'
                : resolvedWorkerStatus === 'idle'
                  ? '● IDLE'
                  : resolvedWorkerStatus === 'failed'
                    ? '✖ FAILED'
                    : '○ STOPPED';

              const workerPidDisplay = activeWorkerInfo?.workerPid
                ? String(activeWorkerInfo.workerPid)
                : '—';
              const workerModalityDisplay =
                activeWorkerInfo?.modality ??
                activeModelCfg.executionModality ??
                'LOCAL_PROCESS';
              const workerTurnsDisplay = activeWorkerInfo?.turnsCompleted ?? 0;
              const workerModelDisplay = `${getModelVendorLabel(
                activeModelCfg.provider,
                activeModelCfg.modelId,
              )}/${activeModelCfg.modelId}`;

              const activeSummary =
                expertSummaries.find((s) => s.expertRole === activeRole) ??
                (project
                  ? orchestrator.storage.getExpertChatSummary(
                      project.id,
                      activeRole,
                    )
                  : null);
              const activeTokensCount = activeSummary?.activeContextTokens ?? 0;
              const compactionCount = activeSummary?.compactionCount ?? 0;
              const savedTokensCount =
                activeSummary?.savedTokensByCompaction ?? 0;
              const totalEncounteredTokens =
                activeTokensCount + savedTokensCount;
              const savingsRatio =
                totalEncounteredTokens > 0 && savedTokensCount > 0
                  ? Math.round((savedTokensCount / totalEncounteredTokens) * 100)
                  : 0;

              const latestCompactionCheckpoint = project
                ? orchestrator.storage.getLatestCompactionCheckpoint(
                    project.id,
                    activeRole,
                  )
                : null;

              const uncompactedMessages = project
                ? orchestrator.storage.listMessages(project.id, activeRole, true)
                : [];
              const totalRoleMessages = project
                ? orchestrator.storage.listMessages(project.id, activeRole)
                : [];

              const activeMemories = project
                ? orchestrator.storage.listMemories(
                    project.id,
                    undefined,
                    activeRole,
                  )
                : [];
              const memCounts = {
                conv: activeMemories.filter((m) => m.layer === 'CONVERSATIONAL').length,
                work: activeMemories.filter((m) => m.layer === 'WORKING').length,
                proj: activeMemories.filter((m) => m.layer === 'PROJECT_PERSISTENT').length,
                agent: activeMemories.filter((m) => m.layer === 'AGENT_SPECIFIC').length,
              };

              const lastPromptSnippet = activeSummary?.lastUserPrompt || '';
              const lastReplySnippet = activeSummary?.lastExpertReply || '';

              return (
                <Box
                  flexDirection="column"
                  width="58%"
                  borderStyle="single"
                  borderColor={activeTheme.accentColor}
                  paddingX={1}
                >
                  {/* Header */}
                  <Box justifyContent="space-between" width="100%">
                    <Text bold color={activeTheme.accentColor}>
                      📊 {t.multipanelInspectorTitle(activeRoleDisplayName)}
                    </Text>
                    <Text dimColor>
                      {project
                        ? project.name
                        : language === 'es'
                          ? 'Sin proyecto'
                          : 'No project'}
                    </Text>
                  </Box>

                  {/* SECTION 1: WORKER RUNTIME STATUS */}
                  <Box marginTop={1} flexDirection="column">
                    <Text bold color="yellow">
                      {t.multipanelWorkerHeader}
                    </Text>
                    <Box
                      flexDirection="row"
                      justifyContent="space-between"
                      width="100%"
                    >
                      <Text>
                        Status:{' '}
                        <Text bold color={workerStatusColor}>
                          {workerStatusBadge}
                        </Text>
                        {'  '}PID:{' '}
                        <Text
                          bold
                          color={workerPidDisplay !== '—' ? 'white' : 'gray'}
                        >
                          {workerPidDisplay}
                        </Text>
                        {'  '}Modality:{' '}
                        <Text bold color="cyan">
                          {workerModalityDisplay}
                        </Text>
                      </Text>
                      <Text>
                        Turns:{' '}
                        <Text bold color="white">
                          {workerTurnsDisplay}
                        </Text>
                        {activeRoleQueuedCount > 0 && (
                          <Text bold color="yellow">
                            {' '}[{activeRoleQueuedCount}{' '}
                            {language === 'es' ? 'en cola' : 'queued'}]
                          </Text>
                        )}
                      </Text>
                    </Box>
                    <Box flexDirection="row">
                      <Text dimColor>
                        Model: <Text color="cyan">{workerModelDisplay}</Text>
                        {activeModelCfg.provider !== 'deterministic' &&
                          activeModelCfg.provider !== 'ollama' &&
                          !AuthStorage.isConfigured(activeModelCfg.provider) && (
                            <Text color="red" bold>
                              {' '}[{language === 'es' ? 'Falta API Key' : 'Missing API Key'}]
                            </Text>
                          )}
                      </Text>
                    </Box>
                  </Box>

                  {/* SECTION 2: CONTEXT WINDOW & COMPACTION STATISTICS */}
                  <Box marginTop={1} flexDirection="column">
                    <Text bold color="yellow">
                      {t.multipanelContextStatsHeader}
                    </Text>
                    <Box
                      flexDirection="row"
                      justifyContent="space-between"
                      width="100%"
                    >
                      <Text>
                        {language === 'es'
                          ? 'Tamaño Contexto:'
                          : 'Context Size:'}{' '}
                        <Text bold color="yellow">
                          {activeTokensCount.toLocaleString()} tokens
                        </Text>
                      </Text>
                      <Text dimColor>
                        {language === 'es'
                          ? `${uncompactedMessages.length} turnos activos · ${totalRoleMessages.length} msgs total`
                          : `${uncompactedMessages.length} active turns · ${totalRoleMessages.length} total msgs`}
                      </Text>
                    </Box>
                    <Box
                      flexDirection="row"
                      justifyContent="space-between"
                      width="100%"
                    >
                      <Text>
                        {language === 'es'
                          ? 'Compactaciones:'
                          : 'Compactions:'}{' '}
                        <Text bold color="magenta">
                          {compactionCount}{' '}
                          {language === 'es'
                            ? compactionCount === 1
                              ? 'vez'
                              : 'veces'
                            : compactionCount === 1
                              ? 'time'
                              : 'times'}
                        </Text>
                      </Text>
                      <Text>
                        {language === 'es' ? 'Ahorro:' : 'Saved:'}{' '}
                        <Text
                          bold
                          color={savedTokensCount > 0 ? 'green' : 'gray'}
                        >
                          {savedTokensCount > 0
                            ? `-${savedTokensCount.toLocaleString()} tok (${savingsRatio}%)`
                            : '0 tok'}
                        </Text>
                      </Text>
                    </Box>
                    <Box flexDirection="row">
                      <Text dimColor wrap="truncate-end">
                        {language === 'es'
                          ? 'Último checkpoint:'
                          : 'Latest checkpoint:'}{' '}
                        {latestCompactionCheckpoint
                          ? `${latestCompactionCheckpoint.compactedMessageCount} msgs (${latestCompactionCheckpoint.tokensBefore}→${latestCompactionCheckpoint.tokensAfter} tok) · ${new Date(latestCompactionCheckpoint.createdAt).toLocaleTimeString()}`
                          : t.multipanelNoCompactionYet}
                      </Text>
                    </Box>
                  </Box>

                  {/* SECTION 3: 4-LAYER PERSISTENT MEMORY & 3-TIER ARCHITECTURE */}
                  <Box marginTop={1} flexDirection="column">
                    <Text bold color="yellow">
                      {t.multipanelMemoryHeader}
                    </Text>
                    <Box
                      flexDirection="row"
                      justifyContent="space-between"
                      width="100%"
                    >
                      <Text>
                        3-Tier:{' '}
                        <Text color="cyan">T1:{artifacts.length} art</Text>
                        {' · '}
                        <Text color="magenta">
                          T2:{activeMemories.length} mem
                        </Text>
                        {' · '}
                        <Text color="green">
                          T3:{uncompactedMessages.length} turn
                        </Text>
                      </Text>
                      <Text dimColor>
                        {activeMemories.length}{' '}
                        {language === 'es' ? 'registros' : 'records'}
                      </Text>
                    </Box>
                    <Box flexDirection="row">
                      <Text>
                        Layers:{' '}
                        <Text color="cyan">Conv:{memCounts.conv}</Text>
                        {' · '}
                        <Text color="yellow">Work:{memCounts.work}</Text>
                        {' · '}
                        <Text color="green">Proj:{memCounts.proj}</Text>
                        {' · '}
                        <Text color="magenta">Agent:{memCounts.agent}</Text>
                      </Text>
                    </Box>
                  </Box>

                  {/* SECTION 4: ACTIVE ACTIVITY & RECENT EXCHANGE */}
                  <Box marginTop={1} flexDirection="column">
                    <Text bold color="yellow">
                      {t.multipanelRecentExchangeHeader}
                    </Text>
                    {isActiveRoleBusy && !activeStreamingText ? (
                      <Box flexDirection="row" marginTop={0}>
                        <Text dimColor italic color="yellow">
                          {thinkingSpinner}{' '}
                          {language === 'es'
                            ? activeRoleQueuedCount > 0
                              ? `[Pensando respuesta... · ${activeRoleQueuedCount} en cola]`
                              : '[Pensando respuesta...]'
                            : activeRoleQueuedCount > 0
                              ? `[Thinking... · ${activeRoleQueuedCount} queued]`
                              : '[Thinking...]'}
                        </Text>
                      </Box>
                    ) : activeStreamingText && activeStreamResult.isTooling ? (
                      <Box flexDirection="row" marginTop={0}>
                        <Text dimColor italic color="yellow">
                          {thinkingSpinner}{' '}
                          {language === 'es'
                            ? '[Creando artefactos...]'
                            : '[Creating artifacts...]'}
                        </Text>
                      </Box>
                    ) : activeStreamingText ? (
                      <Box flexDirection="column" marginTop={0}>
                        <Text bold color={activeTheme.accentColor}>
                          [{activeRoleDisplayName} (streaming)]:
                        </Text>
                        <Text color="green" wrap="truncate-end">
                          {activeStreamResult.displayText.slice(-250)}█
                        </Text>
                      </Box>
                    ) : lastPromptSnippet || lastReplySnippet ? (
                      <Box flexDirection="column" marginTop={0}>
                        <Text wrap="truncate-end">
                          <Text bold color="cyan">
                            PO:{' '}
                          </Text>
                          <Text color="white">
                            {lastPromptSnippet.length > 120
                              ? `${lastPromptSnippet.slice(0, 117)}...`
                              : lastPromptSnippet || '—'}
                          </Text>
                        </Text>
                        <Text wrap="truncate-end">
                          <Text bold color={activeTheme.accentColor}>
                            {activeRoleDisplayName}:{' '}
                          </Text>
                          <Text color="gray">
                            {lastReplySnippet.length > 150
                              ? `${lastReplySnippet.slice(0, 147)}...`
                              : lastReplySnippet || '—'}
                          </Text>
                        </Text>
                      </Box>
                    ) : (
                      <Text dimColor>{t.multipanelNoExchangesYet}</Text>
                    )}
                  </Box>
                </Box>
              );
            })()}
          </Box>

          {/* Slash Menu Popover inside Multipanel mode */}
          {isSlashMenuOpen && renderSlashPopoverMenu('100%')}

          {/* Bottom Input Box + Status Footer always displaying the active project & agent color */}
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={activeTheme.accentColor}
            paddingX={1}
          >
            <Box justifyContent="space-between">
              <Text>
                <Text bold color="green">
                  {project ? `[${project.name}]` : '[No project]'}
                </Text>{' '}
                <Text dimColor>
                  {activeRoleDisplayName}
                </Text>{' '}
                <Text bold color={activeTheme.accentColor}>
                  ❯{' '}
                </Text>
                <Text>{inputValue}</Text>
                <Text color={activeTheme.accentColor}>█</Text>
              </Text>
              <Text dimColor>
                {project ? `dir: ${project.workspaceDir} · ` : ''}{t.returnToCleanViewHint}
              </Text>
            </Box>
            <Text color={isAnyRoleBusy ? 'yellow' : 'gray'}>{statusBanner}</Text>
          </Box>
        </>
      )}
    </Box>
  );
};
