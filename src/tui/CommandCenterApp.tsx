import React, { useState, useEffect, useMemo, useRef } from 'react';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Box, Text, useInput, useApp, useStdout, useStdin } from 'ink';
import { ActorRole, Artifact, Notebook, Project } from '../core/contracts.js';
import {
  getRoleDisplayName,
  I18N_DICTIONARY,
  SupportedLanguage,
} from '../core/i18n.js';
import { ExpertChatSummary } from '../storage/database.js';
import { executeDbCommandOrQuery } from '../storage/db-repl.js';
import { PoCliOrchestrator } from '../runtime/orchestrator.js';
import { HarnessRegistry } from '../runtime/harnesses.js';
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

export interface CommandCenterProps {
  orchestrator: PoCliOrchestrator;
  initialProject: Project;
}

const ASCII_LOGO = [
  '██████╗  ██████╗      ██████╗██╗     ██╗',
  '██╔══██╗██╔═══██╗    ██╔════╝██║     ██║',
  '██████╔╝██║   ██║    ██║     ██║     ██║',
  '██╔═══╝ ██║   ██║    ██║     ██║     ██║',
  '██║     ╚██████╔╝    ╚██████╗███████╗██║',
  '╚═╝      ╚═════╝      ╚═════╝╚══════╝╚═╝',
];

export interface RoleColorTheme {
  bgColor: 'magenta' | 'blue' | 'green' | 'yellow' | 'cyan';
  fgColor: 'white' | 'black';
  accentColor: 'magenta' | 'blue' | 'green' | 'yellow' | 'cyan';
}

export const ROLE_COLOR_THEMES: Record<string, RoleColorTheme> = {
  pm: {
    bgColor: 'magenta',
    fgColor: 'white',
    accentColor: 'magenta',
  },
  architect: {
    bgColor: 'blue',
    fgColor: 'white',
    accentColor: 'blue',
  },
  developer: {
    bgColor: 'green',
    fgColor: 'black',
    accentColor: 'green',
  },
  qa: {
    bgColor: 'yellow',
    fgColor: 'black',
    accentColor: 'yellow',
  },
};

export function getRoleTheme(role: ActorRole): RoleColorTheme {
  return (
    ROLE_COLOR_THEMES[role] ?? {
      bgColor: 'cyan',
      fgColor: 'black',
      accentColor: 'cyan',
    }
  );
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
      es: 'Diseño de arquitectura, especificaciones (ARCH-001/SPEC-001) y contratos',
      en: 'Architecture design, specifications (ARCH-001/SPEC-001) and contracts',
    },
    icon: '🏛',
  },
  {
    role: 'developer',
    title: 'Senior Developer',
    description: {
      es: 'Implementación sobre especificaciones aprobadas dentro de sandbox Linux',
      en: 'Software implementation on approved specs inside isolated Linux sandbox',
    },
    icon: '💻',
  },
  {
    role: 'qa',
    title: 'Independent QA Engineer',
    description: {
      es: 'Validación independiente, ejecución de tests y control de calidad',
      en: 'Independent validation, automated test execution and quality verdicts',
    },
    icon: '🧪',
  },
  {
    role: 'pm',
    title: 'Project Manager (PM)',
    description: {
      es: 'Coordinación del equipo, consultas paralelas/secuenciales y reportes',
      en: 'Team coordination, parallel/sequential cross-agent inquiries & status',
    },
    icon: '📋',
  },
];

function fitAndPadLine(text: string, width: number): string {
  const safeWidth = Math.max(10, width);
  const oneLine = text.replace(/\s+/g, ' ');
  if (oneLine.length > safeWidth) {
    return `${oneLine.slice(0, safeWidth - 2)}..`;
  }
  return oneLine.padEnd(safeWidth, ' ');
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
  const [workDir, setWorkDir] = useState<string>(initialSettings.workDir);
  const [settingsRowIdx, setSettingsRowIdx] = useState<number>(0);
  const [isEditingWorkDir, setIsEditingWorkDir] = useState<boolean>(false);
  const [workDirDraft, setWorkDirDraft] = useState<string>(
    initialSettings.workDir,
  );
  const t = I18N_DICTIONARY[language];

  const [dimensions, setDimensions] = useState<{ columns: number; rows: number }>({
    columns: stdout?.columns ?? 120,
    rows: stdout?.rows ?? 36,
  });
  const safeViewportHeight = Math.max(18, dimensions.rows - 1);

  // View mode: 'startup' (OpenCode-like centered logo + prompt), 'chat' (2-column chat + info sidebar), 'multipanel'
  const [viewMode, setViewMode] = useState<'startup' | 'chat' | 'multipanel'>('startup');
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isHelpOpen, setIsHelpOpen] = useState<boolean>(false);
  const [isExitConfirmOpen, setIsExitConfirmOpen] = useState<boolean>(false);
  const [dbModalOutput, setDbModalOutput] = useState<string>('');

  // Active project & repository / artifact / SQLite summary state
  const [project, setProject] = useState<Project>(initialProject);
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

  // Interactive Active Agent Selector Modal (/agents)
  const [isAgentsModalOpen, setIsAgentsModalOpen] = useState<boolean>(false);
  const [selectedAgentIdx, setSelectedAgentIdx] = useState<number>(0);

  // Interactive OpenCode-style Per-Agent Model Picker Modal (/models)
  const [isModelsModalOpen, setIsModelsModalOpen] = useState<boolean>(false);
  const [modelsTargetRole, setModelsTargetRole] = useState<ActorRole | 'all'>(
    'architect',
  );
  const [modelsFilterQuery, setModelsFilterQuery] = useState<string>('');
  const [selectedModelIdx, setSelectedModelIdx] = useState<number>(0);
  const [roleConfigVersion, setRoleConfigVersion] = useState<number>(0);

  // Prompt input, slash command menu & mouse scroll state
  const [inputValue, setInputValue] = useState<string>('');
  const [selectedSlashIdx, setSelectedSlashIdx] = useState<number>(0);
  const [messageScrollOffset, setMessageScrollOffset] = useState<number>(0);
  const [busy, setBusy] = useState<boolean>(false);
  const [streamingText, setStreamingText] = useState<string>('');
  const [statusBanner, setStatusBanner] = useState<string>(t.initialStatusBanner);

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
    const pid = targetProjectId ?? project.id;
    const updated = orchestrator.storage.getProject(pid);
    if (updated) setProject(updated);
    const listed = orchestrator.storage.listProjects();
    setAllProjects(listed);
    setArtifacts(orchestrator.storage.listArtifacts(pid, true));
    setNotebooks(orchestrator.storage.getProjectNotebooks(pid));
    setExpertSummaries(orchestrator.storage.listExpertChatSummaries(pid));
  };

  useEffect(() => {
    refreshState(project.id);
    setMessageScrollOffset(0);
  }, [project.id, activeRole]);

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

  // Listen for raw CSI-u / xterm modifyOtherKeys Ctrl+Tab sequences via Ink's internal_eventEmitter
  // (avoids attaching a competing 'data' listener on stdin that conflicts with Ink's 'readable' loop)
  useEffect(() => {
    const emitter = internal_eventEmitter ?? stdin;
    if (!emitter) return;
    const eventName = internal_eventEmitter ? 'input' : 'data';
    const onRawData = (data: Buffer | string) => {
      const seq = typeof data === 'string' ? data : data.toString('utf8');
      if (
        seq === '\x1b[27;5;9~' || // xterm modifyOtherKeys Ctrl+Tab
        seq === '\x1b[9;5u' ||    // Kitty / CSI-u Ctrl+Tab
        seq === '\x1b[1;5I' ||    // VTE / GNOME Terminal Ctrl+Tab
        seq === '\x1b[Z'          // Shift+Tab / Backtab fallback in standard Linux terminals
      ) {
        setViewMode((prev) => (prev === 'multipanel' ? 'chat' : 'multipanel'));
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
    setIsSettingsOpen(false);
    setIsEditingWorkDir(false);
    setIsProjectsModalOpen(false);
    setIsAgentsModalOpen(false);
    setIsModelsModalOpen(false);
    setIsExitConfirmOpen(false);
    setModelsFilterQuery('');
    setDbModalOutput('');
    setProjectWizardStep('CLOSED');
  };

  const openModelsModal = (targetRole?: ActorRole | 'all') => {
    const resolvedTarget = targetRole ?? activeRole;
    closeAllModals();
    setModelsTargetRole(resolvedTarget);
    setModelsFilterQuery('');
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
    const q = modelsFilterQuery.trim().toLowerCase();
    if (!q) return AVAILABLE_MODELS_CATALOG;
    return AVAILABLE_MODELS_CATALOG.filter(
      (m) =>
        m.modelId.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        m.providerLabel.toLowerCase().includes(q) ||
        m.recommendedFor.toLowerCase().includes(q) ||
        `${m.provider}/${m.modelId}`.toLowerCase().includes(q),
    );
  }, [modelsFilterQuery]);

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
    setProject(created);
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
      setProject(switched);
      refreshState(switched.id);

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
    inputValue.startsWith('/') &&
    projectWizardStep === 'CLOSED' &&
    !isProjectsModalOpen &&
    !isAgentsModalOpen &&
    !isModelsModalOpen &&
    !isHelpOpen &&
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
    if (!trimmed || busy) return;

    // Handle slash commands starting with "/"
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const cmdToken = parts[0].toLowerCase();
      setInputValue('');

      if (cmdToken === '/exit' || cmdToken === '/quit' || cmdToken === '/q') {
        exit();
        return;
      }
      if (cmdToken === '/help' || cmdToken === '/h' || cmdToken === '/?') {
        const nextState = !isHelpOpen;
        closeAllModals();
        setIsHelpOpen(nextState);
        setStatusBanner(t.helpOpenedMsg);
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
        const nextState = !isProjectsModalOpen;
        closeAllModals();
        const listed = orchestrator.storage.listProjects();
        setAllProjects(listed);
        const currentIdx = Math.max(
          0,
          listed.findIndex((p) => p.id === project.id),
        );
        setSelectedProjectIdx(currentIdx);
        setIsProjectsModalOpen(nextState);
        return;
      }
      if (cmdToken === '/switch') {
        closeAllModals();
        const query = parts.slice(1).join(' ').trim();
        if (query) {
          switchProjectTo(query);
          return;
        }
        const listed = orchestrator.storage.listProjects();
        setAllProjects(listed);
        const currentIdx = Math.max(
          0,
          listed.findIndex((p) => p.id === project.id),
        );
        setSelectedProjectIdx(currentIdx);
        setIsProjectsModalOpen(true);
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
          setActiveRole(found.role);
          setViewMode('chat');
          setStatusBanner(
            t.activeInterlocutorMsg(
              getRoleDisplayName(found.role, language),
            ),
          );
          return;
        }
        closeAllModals();
        const currIdx = AVAILABLE_AGENTS.findIndex((a) => a.role === activeRole);
        setSelectedAgentIdx(currIdx >= 0 ? currIdx : 0);
        setIsAgentsModalOpen(true);
        return;
      }
      if (cmdToken === '/clear') {
        setStreamingText('');
        setStatusBanner(t.statusClearedMsg);
        return;
      }
      if (cmdToken === '/architect') {
        setActiveRole('architect');
        setStatusBanner(
          t.activeInterlocutorMsg(getRoleDisplayName('architect', language)),
        );
        return;
      }
      if (cmdToken === '/developer') {
        setActiveRole('developer');
        setStatusBanner(
          t.activeInterlocutorMsg(getRoleDisplayName('developer', language)),
        );
        return;
      }
      if (cmdToken === '/qa') {
        setActiveRole('qa');
        setStatusBanner(
          t.activeInterlocutorMsg(getRoleDisplayName('qa', language)),
        );
        return;
      }
      if (cmdToken === '/pm') {
        setActiveRole('pm');
        const modeArg = parts[1]?.toLowerCase();
        if (modeArg === 'parallel' || modeArg === 'sequential') {
          setBusy(true);
          const modality = modeArg === 'sequential' ? 'SEQUENTIAL' : 'PARALLEL';
          setStatusBanner(
            `⏳ PM running ${modality} inquiry across active agents...`,
          );
          try {
            const res = await orchestrator.executePmInquiry({
              projectId: project.id,
              topic: parts.slice(2).join(' ') || 'Project status across all roles',
              modality,
            });
            setStatusBanner(
              `✔ PM emitted ${res.artifact.code} (${modality}): ${res.report.individualResponses.length} agents consulted.`,
            );
            refreshState();
          } catch (err) {
            setStatusBanner(`✖ Error: ${(err as Error).message}`);
          } finally {
            setBusy(false);
          }
          return;
        }
        setStatusBanner(
          t.activeInterlocutorMsg(getRoleDisplayName('pm', language)),
        );
        return;
      }
      if (cmdToken === '/propose') {
        setActiveRole('architect');
        await sendChatMessage(
          'architect',
          'Design and propose the formal architecture and requirements for this project.',
        );
        return;
      }
      if (cmdToken === '/approve') {
        try {
          const { approval } = orchestrator.reviewArchitectureByPo({
            projectId: project.id,
            artifactCode: 'ARCH-001',
            decision: 'APPROVED',
            comments: 'Architecture formally approved by the Product Owner.',
          });
          setStatusBanner(t.archApprovedMsg(approval.artifactVersion));
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error: ${(err as Error).message}`);
        }
        return;
      }
      if (cmdToken === '/reject') {
        try {
          orchestrator.reviewArchitectureByPo({
            projectId: project.id,
            artifactCode: 'ARCH-001',
            decision: 'REJECTED',
            comments: 'Product Owner requested architectural revisions.',
          });
          setStatusBanner(t.archRejectedMsg);
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error: ${(err as Error).message}`);
        }
        return;
      }
      if (cmdToken === '/handoff') {
        try {
          const bundle = orchestrator.performDeveloperHandoff(project.id);
          setActiveRole('developer');
          setStatusBanner(
            t.handoffCompletedMsg(bundle.approvedArchitectureVersion),
          );
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error: ${(err as Error).message}`);
        }
        return;
      }
      if (cmdToken === '/implement') {
        setActiveRole('developer');
        await sendChatMessage(
          'developer',
          'Implement the software strictly following the approved Handoff bundle.',
        );
        return;
      }
      if (cmdToken === '/consult') {
        setBusy(true);
        try {
          const cons = await orchestrator.consultArchitectFromDeveloper({
            projectId: project.id,
            subject: 'Consultation regarding contract validation during implementation',
            ambiguityOrBlocker: 'Detected ambiguity in invalid input error handling',
            proposedAlternative: 'Throw typed Error compliant with SPEC-001',
            impactedArtifacts: ['ARCH-001', 'SPEC-001'],
          });
          setStatusBanner(t.consultationEvaluatedMsg(cons.status));
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error: ${(err as Error).message}`);
        } finally {
          setBusy(false);
        }
        return;
      }
      if (cmdToken === '/validate') {
        setBusy(true);
        setActiveRole('qa');
        setStatusBanner(t.qaRunningMsg);
        try {
          const res = await orchestrator.submitToQaAndValidate({
            projectId: project.id,
          });
          setStatusBanner(
            t.qaCompletedMsg(
              res.qaArtifact.code,
              res.payload.recommendation,
              res.payload.passedTests.length,
              res.payload.executedTests.length,
            ),
          );
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error: ${(err as Error).message}`);
        } finally {
          setBusy(false);
        }
        return;
      }
      if (cmdToken === '/accept') {
        try {
          orchestrator.acceptProjectByPo({
            projectId: project.id,
            comments: 'Project finally accepted by the Product Owner.',
          });
          setStatusBanner(t.projectAcceptedMsg);
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error: ${(err as Error).message}`);
        }
        return;
      }
      if (cmdToken === '/notebooks') {
        const nbs = orchestrator.storage.getProjectNotebooks(project.id);
        for (const nb of nbs) {
          orchestrator.rag.indexNotebook(nb.id);
        }
        refreshState();
        setStatusBanner(
          t.notebooksIndexedMsg(
            nbs.length,
            nbs.map((n) => n.name).join(', '),
          ),
        );
        return;
      }
      if (cmdToken === '/compact') {
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
          projectId: project.id,
          targetRole,
          keepRecentCount: 1,
        });
        refreshState();
        setStatusBanner(
          t.compactedMsg(
            String(targetRole),
            res.totalCompactedMessages,
            res.totalSavedTokens,
          ),
        );
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

    // Normal conversation message sent to the currently active professional
    setInputValue('');
    if (viewMode === 'startup') {
      setViewMode('chat');
    }
    await sendChatMessage(activeRole, trimmed);
  };

  const sendChatMessage = async (targetRole: ActorRole, messageText: string) => {
    setBusy(true);
    setStreamingText('');
    setStatusBanner(t.consultingAgentMsg(targetRole));
    try {
      const res = await orchestrator.chatWithProfessional({
        projectId: project.id,
        targetRole,
        message: messageText,
        onStreamChunk: (chunk) => {
          setStreamingText((prev) => prev + chunk);
        },
      });
      setStreamingText('');
      setStatusBanner(
        t.agentRepliedMsg(
          targetRole,
          res.workerPid,
          res.createdArtifacts.length,
        ),
      );
      setMessageScrollOffset(0);
      refreshState();
    } catch (err) {
      setStatusBanner(`✖ Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const selectRoleByMouse = (role: ActorRole) => {
    setActiveRole(role);
    setMessageScrollOffset(0);
    setStatusBanner(
      t.activeInterlocutorMsg(getRoleDisplayName(role, language)),
    );
  };

  const handleMouseEvent = (ev: ParsedMouseEvent) => {
    // 1. Handle Mouse Wheel Scrolling
    if (ev.action === 'wheel') {
      const isUp = ev.button === 'wheel-up';
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
      if (isSettingsOpen && !isEditingWorkDir) {
        setSettingsRowIdx((prev) => (prev === 0 ? 1 : 0));
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
      const allMsgs = orchestrator.storage.listMessages(project.id, activeRole);
      const winSize = viewMode === 'multipanel' ? 4 : 3;
      const maxOffset = Math.max(0, allMsgs.length - winSize);
      setMessageScrollOffset((prev) =>
        isUp ? Math.min(maxOffset, prev + 1) : Math.max(0, prev - 1),
      );
      return;
    }

    // 2. Handle Left Mouse Button Click
    if (ev.button === 'left' && ev.action === 'press') {
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

      // Interactive Help, DB, or Exit Confirm modal: click closes modal
      if (isHelpOpen || dbModalOutput.length > 0 || isExitConfirmOpen) {
        setIsHelpOpen(false);
        setDbModalOutput('');
        setIsExitConfirmOpen(false);
        return;
      }

      // Interactive Models modal: click applies selected model to current target
      if (isModelsModalOpen && filteredModels.length > 0) {
        const chosen =
          filteredModels[selectedModelIdx] ?? filteredModels[0];
        if (chosen) {
          applyModelSelection(modelsTargetRole, chosen);
        }
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

      // Interactive Settings modal: click toggles language or opens workDir editor
      if (isSettingsOpen && !isEditingWorkDir) {
        if (settingsRowIdx === 0) {
          const nextLang: SupportedLanguage = language === 'en' ? 'es' : 'en';
          applyLanguageChange(nextLang);
        } else {
          setWorkDirDraft(workDir);
          setIsEditingWorkDir(true);
        }
        return;
      }

      // Slash Command Popover: click executes selected slash command
      if (isSlashMenuOpen && filteredSlashCommands.length > 0 && !busy) {
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
      if (key.escape || input === 'q') {
        setIsProjectsModalOpen(false);
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
      if (key.return && allProjects.length > 0) {
        const chosen = allProjects[selectedProjectIdx] ?? allProjects[0];
        if (chosen) {
          setIsProjectsModalOpen(false);
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
          setActiveRole(chosen.role);
          setViewMode('chat');
          setStatusBanner(
            t.activeInterlocutorMsg(getRoleDisplayName(chosen.role, language)),
          );
          return;
        }
      }
      if (key.return && AVAILABLE_AGENTS.length > 0) {
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
      return;
    }

    // 2b. Handle OpenCode-style Per-Agent Model Picker Modal (/models or Ctrl+O)
    if (isModelsModalOpen) {
      if (key.escape) {
        setIsModelsModalOpen(false);
        setModelsFilterQuery('');
        return;
      }

      const targetOptions = ['pm', 'architect', 'developer', 'qa', 'all'] as const;
      if (key.leftArrow || key.rightArrow || key.tab) {
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
        if (!modelsFilterQuery) {
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

    // 3. Handle interactive Help or DB modal when open
    if (isHelpOpen || dbModalOutput.length > 0) {
      if (key.escape || key.return || input === 'q') {
        setIsHelpOpen(false);
        setDbModalOutput('');
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
      if (key.upArrow || key.downArrow) {
        setSettingsRowIdx((prev) => (prev === 0 ? 1 : 0));
        return;
      }
      if (settingsRowIdx === 0) {
        if (key.leftArrow || key.rightArrow || key.return || input === ' ') {
          const nextLang: SupportedLanguage = language === 'en' ? 'es' : 'en';
          applyLanguageChange(nextLang);
          return;
        }
      } else if (settingsRowIdx === 1) {
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
        exit();
        return;
      }
      return;
    }

    // OpenCode Ctrl+O shortcut to open the Per-Agent Model Picker (/models)
    if (key.ctrl && input === 'o') {
      openModelsModal(activeRole);
      return;
    }

    // OpenCode Ctrl+P shortcut to toggle slash command popover menu
    if (key.ctrl && input === 'p') {
      setInputValue((prev) => (prev.startsWith('/') ? '' : '/'));
      return;
    }

    // ESC key navigation: clears input, goes to previous screen, or asks to exit on startup screen
    if (key.escape) {
      if (inputValue.length > 0) {
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

    // Toggle between OpenCode chat view and Multipanel Command Center on Tab/Ctrl+Tab
    if (key.tab) {
      if (
        isSlashMenuOpen &&
        filteredSlashCommands.length > 0 &&
        !key.shift &&
        !key.ctrl
      ) {
        const chosen =
          filteredSlashCommands[selectedSlashIdx] ?? filteredSlashCommands[0];
        if (chosen) {
          setInputValue(`${chosen.command} `);
        }
        return;
      }
      setViewMode((prev) => (prev === 'multipanel' ? 'chat' : 'multipanel'));
      return;
    }

    if (busy) return;

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
      setInputValue((prev) => prev.slice(0, -1));
      if (selectedSlashIdx !== 0) setSelectedSlashIdx(0);
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      setInputValue((prev) => prev + input);
      if (selectedSlashIdx !== 0) setSelectedSlashIdx(0);
    }
  });

  const harnesses = useMemo(() => HarnessRegistry.listHarnesses(), []);
  const activeRoleDisplayName = getRoleDisplayName(activeRole, language);
  const activeTheme = getRoleTheme(activeRole);
  const activeModelCfg = useMemo(
    () => orchestrator.storage.getRoleConfig(project.id, activeRole),
    [
      orchestrator.storage,
      project.id,
      activeRole,
      expertSummaries,
      roleConfigVersion,
    ],
  );
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
  const messages = useMemo(
    () => orchestrator.storage.listMessages(project.id, activeRole),
    [orchestrator.storage, project.id, activeRole, expertSummaries],
  );
  const sliceWindowedMessages = (winSize: number) => {
    if (messages.length <= winSize) return messages;
    const maxOffset = Math.max(0, messages.length - winSize);
    const clamped = Math.min(messageScrollOffset, maxOffset);
    const endIdx = messages.length - clamped;
    return messages.slice(Math.max(0, endIdx - winSize), endIdx);
  };
  const lastMessages = sliceWindowedMessages(3);
  const multipanelMessages = sliceWindowedMessages(4);
  const openCodeMessages = useMemo(() => {
    const maxVisible = Math.max(4, Math.floor((safeViewportHeight - 10) / 3));
    if (messages.length <= maxVisible) return messages;
    const maxOffset = Math.max(0, messages.length - maxVisible);
    const clamped = Math.min(messageScrollOffset, maxOffset);
    const endIdx = messages.length - clamped;
    return messages.slice(Math.max(0, endIdx - maxVisible), endIdx);
  }, [messages, safeViewportHeight, messageScrollOffset]);

  const gitBranch = useMemo(() => {
    try {
      const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: project.workspaceDir || process.cwd(),
        encoding: 'utf8',
        timeout: 1000,
      });
      return res.stdout.trim() || 'main';
    } catch {
      return 'main';
    }
  }, [project.workspaceDir]);

  const shortWorkdir = useMemo(() => {
    const target = project.workspaceDir || process.cwd();
    const home = os.homedir();
    return target.startsWith(home) ? `~${target.slice(home.length)}` : target;
  }, [project.workspaceDir]);

  const estimatedTokens = useMemo(() => {
    let chars = 0;
    for (const m of messages) {
      chars += m.content.length;
    }
    chars += 12180;
    return Math.round(chars / 4);
  }, [messages]);
  const roleConfigs = useMemo(
    () => orchestrator.storage.listRoleConfigs(project.id),
    [orchestrator.storage, project.id, expertSummaries, roleConfigVersion],
  );

  const renderTopColorBanner = (barWidth: number) => {
    const vendorLabel = getModelVendorLabel(
      activeModelCfg.provider,
      activeModelCfg.modelId,
    );
    const bannerText = ` ${project.name}  │  ${activeRoleDisplayName}  │  ${vendorLabel}/${activeModelCfg.modelId} `;
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
      {allProjects.map((proj, idx) => {
        const isCurrentActive = proj.id === project.id;
        const isRowSelected = idx === selectedProjectIdx;
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
                color={isRowSelected ? 'cyan' : isCurrentActive ? 'green' : 'white'}
              >
                {isRowSelected ? '❯ ' : '  '}
                {proj.name}{' '}
                {isCurrentActive && (
                  <Text color="green" bold>
                    [{t.activeBadge}]
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
      })}
    </Box>
  );

  // Interactive Active Agent Selector Modal (/agents)
  const renderAgentsModal = () => (
    <Box
      flexDirection="column"
      width={Math.min(84, dimensions.columns - 6)}
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">
          👥 {language === 'es' ? 'Seleccionar Agente Interlocutor' : 'Select Active Interlocutor Agent'}
        </Text>
        <Text dimColor>
          {language === 'es'
            ? '↑/↓ o 1-4 para seleccionar · Enter confirmar · Esc volver'
            : '↑/↓ or 1-4 to select · Enter confirm · Esc back'}
        </Text>
      </Box>

      {AVAILABLE_AGENTS.map((item, idx) => {
        const isSelected = idx === selectedAgentIdx;
        const isCurrentActive = item.role === activeRole;
        const roleTheme = getRoleTheme(item.role);
        const roleCfg = orchestrator.storage.getRoleConfig(project.id, item.role);
        const modelLabel = `${roleCfg.provider}/${roleCfg.modelId}`;

        return (
          <Box
            key={item.role}
            flexDirection="column"
            borderStyle={isSelected ? 'single' : undefined}
            borderColor={isSelected ? roleTheme.accentColor : undefined}
            paddingX={1}
            paddingY={0}
            marginY={0}
          >
            <Box justifyContent="space-between">
              <Box flexDirection="row">
                <Text
                  bold
                  color={isSelected ? roleTheme.accentColor : 'white'}
                >
                  {isSelected ? '❯ ' : '  '}
                  {item.icon} {item.title}{' '}
                </Text>
                {isCurrentActive && (
                  <Text color="green" bold>
                    [{language === 'es' ? 'Activo' : 'Active'}]
                  </Text>
                )}
              </Box>
              <Text dimColor>
                {modelLabel}
              </Text>
            </Box>
            <Box paddingLeft={4}>
              <Text dimColor={!isSelected} color={isSelected ? 'white' : undefined}>
                {item.description[language === 'es' ? 'es' : 'en']}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );

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

  // Settings Modal Component
  const renderSettingsModal = () => (
    <Box
      flexDirection="column"
      width={Math.min(92, dimensions.columns - 8)}
      borderStyle="double"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Text bold color="yellow">
        ⚙ {t.settingsTitle}
      </Text>
      <Text dimColor>{t.settingsSubtitle}</Text>

      {/* Row 0: Interface Language */}
      <Box marginTop={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Text
            bold={settingsRowIdx === 0}
            color={settingsRowIdx === 0 ? 'cyan' : 'white'}
          >
            {settingsRowIdx === 0 ? '❯ ' : '  '}
            {t.settingLanguageLabel}
          </Text>
          <Text dimColor>  {t.settingLanguageDesc}</Text>
        </Box>
        <Box>
          <Text
            bold={language === 'en'}
            color={language === 'en' ? 'green' : 'gray'}
          >
            [ English (en) ]
          </Text>
          <Text> </Text>
          <Text
            bold={language === 'es'}
            color={language === 'es' ? 'green' : 'gray'}
          >
            [ Español (es) ]
          </Text>
        </Box>
      </Box>

      {/* Row 1: Central Working & Artifacts Directory (default $HOME/.pocli/) */}
      <Box marginTop={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text
            bold={settingsRowIdx === 1}
            color={settingsRowIdx === 1 ? 'cyan' : 'white'}
          >
            {settingsRowIdx === 1 ? '❯ ' : '  '}
            {t.settingWorkDirLabel}
          </Text>
          <Text bold color="green">
            [{workDir}]
          </Text>
        </Box>
        <Text dimColor>  {t.settingWorkDirDesc}</Text>
        {isEditingWorkDir && (
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="round"
            borderColor="green"
            paddingX={1}
          >
            <Text color="yellow">{t.settingWorkDirEditPrompt}</Text>
            <Box>
              <Text bold color="green">
                ❯{' '}
              </Text>
              <Text color="white">{workDirDraft}</Text>
              <Text color="green">█</Text>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );

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
        : getRoleTheme(modelsTargetRole);

    // Larger, strictly fixed modal dimensions so moving left/right/up/down or
    // typing in the filter never changes the dialog width or height.
    const modalWidth = Math.max(82, Math.min(128, dimensions.columns - 6));
    const tabWidth = 14;
    const centerInBox = (label: string, width: number): string => {
      if (label.length >= width) return label.slice(0, width);
      const leftPad = Math.floor((width - label.length) / 2);
      const rightPad = width - label.length - leftPad;
      return `${' '.repeat(leftPad)}${label}${' '.repeat(rightPad)}`;
    };
    const windowSize = Math.max(
      6,
      Math.min(12, Math.max(22, dimensions.rows - 1) - 16),
    );
    const modalHeight = windowSize + 12;

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
                  : getRoleTheme(opt);
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

        {/* OpenCode-style Live Search / Filter Input (fixed 3 rows) */}
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

        {/* Scrollable Model Catalog List with strictly fixed height (windowSize rows) */}
        <Box flexDirection="column" marginTop={1} height={windowSize}>
          {visibleModels.length === 0 ? (
            <Text dimColor wrap="truncate-end">
              {t.noCommandMatches} "{modelsFilterQuery}"
            </Text>
          ) : (
            visibleModels.map((m, localIdx) => {
              const realIdx = startIdx + localIdx;
              const isRowSelected = realIdx === selectedModelIdx;
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
                      [{m.vendor.padEnd(10, ' ')}]
                    </Text>{' '}
                    <Text color={m.isFree ? 'green' : 'gray'}>
                      [{m.isFree ? 'Free' : 'Paid'}]
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
                      const rTheme = getRoleTheme(rKey);
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
    isSettingsOpen ||
    isProjectsModalOpen ||
    isAgentsModalOpen ||
    isModelsModalOpen ||
    isExitConfirmOpen ||
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
    if (!text.includes('```')) {
      return (
        <Text
          color="white"
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
            {isModelsModalOpen && renderModelsModal()}
            {dbModalOutput.length > 0 && renderDbModal()}
            {isHelpOpen && renderHelpModal()}
            {isSettingsOpen && renderSettingsModal()}
            {isExitConfirmOpen && renderExitConfirmModal()}
          </Box>
        ) : (
          <Box
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            flexGrow={1}
            width="100%"
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
                /projects {language === 'es' ? 'para seleccionar proyecto' : 'to switch project'}  ·  /help {language === 'es' ? 'ayuda' : 'help'}
              </Text>
            </Box>

            {isSlashMenuOpen && (
              <Box width={promptBoxWidth} marginBottom={0}>
                {renderSlashPopoverMenu(promptBoxWidth)}
              </Box>
            )}

            <Box
              flexDirection="column"
              width={promptBoxWidth}
              borderStyle="round"
              borderColor={isSlashMenuOpen ? 'blue' : 'cyan'}
              paddingX={1}
              paddingY={0}
            >
              <Box flexDirection="row">
                <Text color="cyan" bold>
                  │{' '}
                </Text>
                {inputValue.length === 0 ? (
                  <Text dimColor>
                    {language === 'es'
                      ? 'Pregunta cualquier cosa... "/projects para cambiar de proyecto"'
                      : 'Ask anything... "/projects to switch project"'}
                  </Text>
                ) : (
                  <>
                    <Text color="white">{inputValue}</Text>
                    <Text color="cyan">█</Text>
                  </>
                )}
              </Box>
              <Box height={1} />
              <Box flexDirection="row">
                <Text color="cyan" bold>
                  │{' '}
                </Text>
                <Text dimColor>Current session: </Text>
                <Text color="white" bold>
                  {project.name}
                </Text>
                <Text dimColor> · </Text>
                <Text bold color="cyan">
                  {activeRoleDisplayName}
                </Text>
                <Text dimColor> · </Text>
                <Text color="white">{activeModelEntry.displayName}</Text>
                <Text dimColor>
                  {' '}{activeModelEntry.isFree ? 'Default' : 'Pro'} / {activeModelEntry.vendor}
                </Text>
              </Box>
            </Box>
          </Box>
        )}

        {/* Bottom Footer Bar matching OpenCode screenshot:
            ~/HACK/dev/ai.github.io.git:master     shift+tab agents   ctrl+p commands              1.0.0 */}
        <Box width="100%" justifyContent="space-between" height={1}>
          <Box flexDirection="row">
            <Text color="gray">
              {shortWorkdir}:{gitBranch}
            </Text>
          </Box>
          <Box flexDirection="row">
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
    const sidebarWidth = Math.max(26, Math.min(34, Math.floor(dimensions.columns * 0.25)));
    const chatAreaWidth = Math.max(30, dimensions.columns - sidebarWidth - 4);
    const contentHeight = Math.max(8, safeViewportHeight - 3);

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
            {isModelsModalOpen && renderModelsModal()}
            {dbModalOutput.length > 0 && renderDbModal()}
            {isHelpOpen && renderHelpModal()}
            {isSettingsOpen && renderSettingsModal()}
            {isExitConfirmOpen && renderExitConfirmModal()}
          </Box>
        ) : (
          <Box flexDirection="row" width="100%" height={contentHeight}>
            {/* Left Column: Chat Area */}
            <Box
              flexDirection="column"
              width={chatAreaWidth}
              height="100%"
              justifyContent="space-between"
              paddingRight={2}
            >
              {/* Scrollable Conversation messages */}
              <Box flexDirection="column" flexGrow={1} overflowY="hidden">
                {openCodeMessages.length === 0 && !streamingText ? (
                  <Box flexDirection="column" marginY={1}>
                    <Text dimColor>
                      {language === 'es'
                        ? `→ Sesión iniciada con ${activeRoleDisplayName}. Escribe una consulta para comenzar.`
                        : `→ Active session with ${activeRoleDisplayName}. Enter a prompt to start.`}
                    </Text>
                  </Box>
                ) : (
                  openCodeMessages.map((m, mIdx) => {
                    const isUser = m.fromRole === 'product_owner';
                    const baseRow = 4 + mIdx * 3;
                    const minCol = 4;
                    const maxCol = chatAreaWidth;

                    // Register rendered line coordinates for mouse click/drag selection
                    if (
                      !renderedConversationLinesRef.current.some(
                        (l) => l.y === baseRow && l.text === m.content,
                      )
                    ) {
                      renderedConversationLinesRef.current.push({
                        y: baseRow,
                        minX: minCol,
                        maxX: maxCol,
                        text: m.content,
                        fullContent: m.content,
                      });
                    }

                    const isLineSelected =
                      selectionRange !== null &&
                      selectionRange.startY <= baseRow &&
                      selectionRange.endY >= baseRow;

                    return (
                      <Box key={m.id} flexDirection="column" marginY={0}>
                        {isUser ? (
                          // User message with left vertical cyan bar
                          <Box flexDirection="row" marginY={1}>
                            <Text color="cyan" bold>
                              │{'  '}
                            </Text>
                            <Text
                              color="cyan"
                              backgroundColor={isLineSelected ? 'yellow' : undefined}
                            >
                              {m.content}
                            </Text>
                          </Box>
                        ) : (
                          // Assistant message + optional tool/RAG step
                          (() => {
                            let citations: string[] = [];
                            let toolCalls: any[] = [];
                            try {
                              const meta = JSON.parse(m.metadataJson || '{}') as {
                                citations?: string[];
                                toolCalls?: any[];
                              };
                              if (Array.isArray(meta.citations)) citations = meta.citations;
                              if (Array.isArray(meta.toolCalls)) toolCalls = meta.toolCalls;
                            } catch {
                              // ignore
                            }

                            return (
                              <Box flexDirection="column" marginY={1}>
                                {citations.length > 0 && (
                                  <>
                                    <Box flexDirection="row" paddingLeft={1}>
                                      <Text dimColor>
                                        → Explored: {citations.length} reads
                                      </Text>
                                    </Box>
                                    <Box
                                      borderStyle="round"
                                      borderColor="gray"
                                      paddingX={1}
                                      flexDirection="column"
                                      marginY={0}
                                    >
                                      <Text dimColor>
                                        $ Notebook Citations: {citations.slice(0, 3).join(' ')}
                                      </Text>
                                    </Box>
                                  </>
                                )}
                                {toolCalls.map((tc, tcIdx) => (
                                  <Box key={tcIdx} flexDirection="column" marginY={0}>
                                    <Box flexDirection="row" paddingLeft={1}>
                                      <Text dimColor>
                                        → Tool call: {tc.name}
                                      </Text>
                                    </Box>
                                    <Box
                                      borderStyle="round"
                                      borderColor="gray"
                                      paddingX={1}
                                      flexDirection="column"
                                      marginY={0}
                                    >
                                      <Text color="cyan">$ {tc.name} {JSON.stringify(tc.arguments ?? {})}</Text>
                                    </Box>
                                  </Box>
                                ))}
                                <Box flexDirection="column" marginTop={0} paddingLeft={1}>
                                  {renderFormattedContent(m.content, isLineSelected)}
                                </Box>
                              </Box>
                            );
                          })()
                        )}
                      </Box>
                    );
                  })
                )}

                {/* Streaming response */}
                {streamingText && (
                  <Box flexDirection="column" marginY={1} paddingLeft={1}>
                    <Text color="green">{streamingText}█</Text>
                  </Box>
                )}
              </Box>

              {/* Slash Command Popover Menu when user types "/" */}
              {isSlashMenuOpen && renderSlashPopoverMenu('100%')}

              {/* Bottom Prompt / Input Box matching OpenCode screenshot:
                  │ [input text]█
                  │
                  │ Build · Claude Sonnet 5.5 Default / OpenCode */}
              <Box
                flexDirection="column"
                borderStyle="round"
                borderColor={isSlashMenuOpen ? 'blue' : 'cyan'}
                paddingX={1}
                paddingY={0}
                marginTop={0}
              >
                <Box flexDirection="row">
                  <Text color="cyan" bold>
                    │{' '}
                  </Text>
                  <Text color="white">{inputValue}</Text>
                  <Text color="cyan">█</Text>
                </Box>
                <Box height={1} />
                <Box flexDirection="row">
                  <Text color="cyan" bold>
                    │{' '}
                  </Text>
                  <Text bold color="cyan">
                    {activeRoleDisplayName}
                  </Text>
                  <Text dimColor> · </Text>
                  <Text color="white">{activeModelEntry.displayName}</Text>
                  <Text dimColor>
                    {' '}{activeModelEntry.isFree ? 'Default' : 'Pro'} / {activeModelEntry.vendor}
                  </Text>
                </Box>
              </Box>
            </Box>

            {/* Right Column: Project Info & Context Sidebar */}
            <Box
              flexDirection="column"
              width={sidebarWidth}
              paddingLeft={2}
              borderStyle="single"
              borderLeft
              borderRight={false}
              borderTop={false}
              borderBottom={false}
              borderColor="gray"
            >
              <Text bold color="cyan">
                {language === 'es' ? 'Información del proyecto' : 'Project Information'}
              </Text>
              <Box height={1} />
              <Text bold color="white">
                Context
              </Text>
              <Text dimColor>
                {estimatedTokens.toLocaleString()} tokens
              </Text>
              <Text dimColor>
                {Math.max(1, Math.round((estimatedTokens / 200000) * 100))}% used
              </Text>
              <Text dimColor>
                {activeModelEntry.isFree ? '$0.00 spent' : '$0.02 spent'}
              </Text>

              <Box height={1} />
              <Text bold color="white">
                {language === 'es' ? 'Proyecto' : 'Project'}
              </Text>
              <Text color="white">{project.name}</Text>
              <Text dimColor>
                v{project.approvedArchitectureVersion} ({project.phase.replace('PHASE_', '')})
              </Text>

              <Box height={1} />
              <Text bold color="white">
                {language === 'es' ? 'Especialista' : 'Specialist'}
              </Text>
              <Text color={activeTheme.accentColor}>
                {activeRoleDisplayName}
              </Text>
              <Text dimColor>{activeModelEntry.displayName}</Text>

              <Box height={1} />
              <Text bold color="white">
                {language === 'es' ? 'Artefactos' : 'Artifacts'}
              </Text>
              <Text dimColor>
                {artifacts.length} {language === 'es' ? 'activos' : 'active'}
              </Text>
            </Box>
          </Box>
        )}

        {/* Bottom Footer Bar matching OpenCode screenshot:
            ■■■···· esc interrupt          12.2K (1%) · $0.02  ctrl+p commands     ~/HACK/dev/ai.github.io.git:master */}
        <Box width="100%" justifyContent="space-between" height={1}>
          <Box flexDirection="row">
            <Text color={busy ? 'cyan' : 'gray'}>
              {busy ? '■■■···· ' : '■······ '}
            </Text>
            <Text color="gray">esc interrupt</Text>
          </Box>
          <Box flexDirection="row">
            <Text color="gray">
              {(estimatedTokens / 1000).toFixed(1)}K ({Math.max(1, Math.round((estimatedTokens / 200000) * 100))}%) · {activeModelEntry.isFree ? '$0.00' : '$0.02'}{'  '}
            </Text>
            <Text bold color="white">
              ctrl+p{' '}
            </Text>
            <Text color="gray">commands</Text>
          </Box>
          <Box flexDirection="row">
            <Text color="gray">
              {shortWorkdir}:{gitBranch}
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
          {isModelsModalOpen && renderModelsModal()}
          {dbModalOutput.length > 0 && renderDbModal()}
          {isHelpOpen && renderHelpModal()}
          {isSettingsOpen && renderSettingsModal()}
          {isExitConfirmOpen && renderExitConfirmModal()}
        </Box>
      ) : (
        <>
          {/* Top Row: 4 Expert Chat Summary Boxes loaded from SQLite.
              All 4 boxes have strictly fixed height (6 rows) and width (25%) with
              single-line truncated records so selecting an agent never resizes boxes. */}
          <Box flexDirection="row" width="100%" height={6} marginTop={1}>
            {(['pm', 'architect', 'developer', 'qa'] as const).map((roleKey) => {
              const summary = expertSummaries.find(
                (s) => s.expertRole === roleKey,
              ) ?? {
                projectId: project.id,
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
              };
              const roleTheme = getRoleTheme(roleKey);
              const boxTitle = t.expertBoxTitles[roleKey];
              const isSelected = activeRole === roleKey;
              const statsBadge = `(${summary.totalMessages}m·${summary.activeContextTokens}t${
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
              const line2 =
                summary.totalMessages === 0
                  ? fitAndPadLine(` ${t.expertBoxNoChatsYet}`, expertBoxInnerWidth)
                  : fitAndPadLine(
                      ` ${t.expertBoxSummaryLabel} ${summary.summaryText}`,
                      expertBoxInnerWidth,
                    );
              const ex1 = summary.recentExchanges.slice(-2)[0];
              const ex2 = summary.recentExchanges.slice(-2)[1];
              const line3 = ex1
                ? fitAndPadLine(
                    ` • [${ex1.fromRole === 'product_owner' ? 'PO' : ex1.fromRole}]: ${ex1.snippet}`,
                    expertBoxInnerWidth,
                  )
                : fitAndPadLine(' ', expertBoxInnerWidth);
              const line4 = ex2
                ? fitAndPadLine(
                    ` • [${ex2.fromRole === 'product_owner' ? 'PO' : ex2.fromRole}]: ${ex2.snippet}`,
                    expertBoxInnerWidth,
                  )
                : fitAndPadLine(' ', expertBoxInnerWidth);

              return (
                <Box
                  key={roleKey}
                  flexDirection="column"
                  width="25%"
                  height={6}
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
                    bold={isSelected}
                    wrap="truncate-end"
                    backgroundColor={isSelected ? roleTheme.bgColor : undefined}
                    color={isSelected ? roleTheme.fgColor : 'white'}
                    dimColor={!isSelected && summary.totalMessages === 0}
                  >
                    {line2}
                  </Text>
                  <Text
                    wrap="truncate-end"
                    backgroundColor={isSelected ? roleTheme.bgColor : undefined}
                    color={isSelected ? roleTheme.fgColor : undefined}
                    dimColor={!isSelected}
                  >
                    {line3}
                  </Text>
                  <Text
                    wrap="truncate-end"
                    backgroundColor={isSelected ? roleTheme.bgColor : undefined}
                    color={isSelected ? roleTheme.fgColor : undefined}
                    dimColor={!isSelected}
                  >
                    {line4}
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

            {/* Right Panel: Conversation & Activity */}
            <Box
              flexDirection="column"
              width="58%"
              borderStyle="single"
              borderColor="gray"
              paddingX={1}
            >
              <Text bold color="yellow">
                {t.directChannelHeader(activeRoleDisplayName)}
              </Text>
              {messages.length === 0 ? (
                <Text dimColor>{t.noMessagesInChannel}</Text>
              ) : (
                multipanelMessages.map((m, mIdx) => {
                  const contentText =
                    m.content.slice(0, 200) + (m.content.length > 200 ? '...' : '');
                  const baseRow = 15 + mIdx * 3;
                  const minCol = Math.floor(dimensions.columns * 0.44);
                  const maxCol = dimensions.columns - 4;

                  if (
                    !renderedConversationLinesRef.current.some(
                      (l) => l.y === baseRow + 1 && l.text === contentText,
                    )
                  ) {
                    renderedConversationLinesRef.current.push(
                      {
                        y: baseRow,
                        minX: minCol,
                        maxX: maxCol,
                        text: `[${m.fromRole} → ${m.toRole}]:`,
                        fullContent: m.content,
                      },
                      {
                        y: baseRow + 1,
                        minX: minCol,
                        maxX: maxCol,
                        text: contentText,
                        fullContent: m.content,
                      },
                    );
                  }

                  const isLineSelected =
                    selectionRange !== null &&
                    ((selectionRange.startY <= baseRow + 1 &&
                      selectionRange.endY >= baseRow + 1) ||
                      (selectionRange.startY <= baseRow &&
                        selectionRange.endY >= baseRow));

                  return (
                    <Box key={m.id} flexDirection="column" marginTop={1}>
                      <Text
                        bold
                        color={m.fromRole === 'product_owner' ? 'cyan' : 'green'}
                      >
                        [{m.fromRole} → {m.toRole}]:
                      </Text>
                      <Text
                        backgroundColor={isLineSelected ? 'yellow' : undefined}
                        color={isLineSelected ? 'black' : undefined}
                      >
                        {contentText}
                      </Text>
                    </Box>
                  );
                })
              )}
            </Box>
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
                  [{project.name}]
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
                dir: {project.workspaceDir} · {t.returnToCleanViewHint}
              </Text>
            </Box>
            <Text color={busy ? 'yellow' : 'gray'}>{statusBanner}</Text>
          </Box>
        </>
      )}
    </Box>
  );
};
