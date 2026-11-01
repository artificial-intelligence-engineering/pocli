import React, { useState, useEffect, useMemo } from 'react';
import path from 'node:path';
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

  // View mode: 'simple' (OpenCode-like centered clean view) vs 'multipanel' (Full Command Center)
  const [viewMode, setViewMode] = useState<'simple' | 'multipanel'>('simple');
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isHelpOpen, setIsHelpOpen] = useState<boolean>(false);
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
        setViewMode((prev) => (prev === 'simple' ? 'multipanel' : 'simple'));
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
    setIsModelsModalOpen(false);
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
      setSelectedModelIdx(0);
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
    !isModelsModalOpen &&
    !isHelpOpen &&
    !isSettingsOpen;
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
        setViewMode((prev) => (prev === 'simple' ? 'multipanel' : 'simple'));
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
      const winSize = viewMode === 'simple' ? 3 : 4;
      const maxOffset = Math.max(0, allMsgs.length - winSize);
      setMessageScrollOffset((prev) =>
        isUp ? Math.min(maxOffset, prev + 1) : Math.max(0, prev - 1),
      );
      return;
    }

    // 2. Handle Left Mouse Button Click
    if (ev.button === 'left' && ev.action === 'press') {
      const rolesOrder = ['pm', 'architect', 'developer', 'qa'] as const;

      // Top Color Banner & Agent Tab Bar (rows 1..4)
      if (ev.y >= 1 && ev.y <= 4) {
        // Clicking on the right side of the top banner toggles Clean View <-> Multipanel View
        if (ev.x >= dimensions.columns - 34) {
          setViewMode((prev) => (prev === 'simple' ? 'multipanel' : 'simple'));
          return;
        }
        // Check if click landed on one of the 4 agent tabs: [/pm ...] [/architect ...] [/developer ...] [/qa ...]
        let cursorCol = 3;
        for (const rKey of rolesOrder) {
          const isCurrent = activeRole === rKey;
          const label = ` /${rKey} ${t.expertBoxTitles[rKey]} `;
          const renderedTab = isCurrent ? `▶${label}` : `[${label.trim()}]`;
          const tabEnd = cursorCol + renderedTab.length;
          if (ev.x >= cursorCol && ev.x <= tabEnd) {
            selectRoleByMouse(rKey);
            return;
          }
          cursorCol = tabEnd + 1;
        }
        // Clicking elsewhere on the top color banner cycles to the next agent
        const currIdx = rolesOrder.indexOf(
          activeRole as (typeof rolesOrder)[number],
        );
        const nextRole =
          rolesOrder[(Math.max(0, currIdx) + 1) % rolesOrder.length];
        selectRoleByMouse(nextRole);
        return;
      }

      // Interactive Help or DB modal: click closes modal
      if (isHelpOpen || dbModalOutput.length > 0) {
        setIsHelpOpen(false);
        setDbModalOutput('');
        return;
      }

      // Interactive Models modal: click applies selected model
      if (isModelsModalOpen && filteredModels.length > 0) {
        const chosen =
          filteredModels[selectedModelIdx] ?? filteredModels[0];
        if (chosen) {
          applyModelSelection(modelsTargetRole, chosen);
          setIsModelsModalOpen(false);
          setModelsFilterQuery('');
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
        if (nextTarget !== 'all' && !modelsFilterQuery) {
          const cfg = orchestrator.storage.getRoleConfig(
            project.id,
            nextTarget,
          );
          const foundIdx = AVAILABLE_MODELS_CATALOG.findIndex(
            (m) => m.provider === cfg.provider && m.modelId === cfg.modelId,
          );
          if (foundIdx >= 0) setSelectedModelIdx(foundIdx);
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
          setIsModelsModalOpen(false);
          setModelsFilterQuery('');
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

    // OpenCode Ctrl+O shortcut to open the Per-Agent Model Picker (/models)
    if (key.ctrl && input === 'o') {
      openModelsModal(activeRole);
      return;
    }

    if (key.escape) {
      if (inputValue.length > 0) {
        setInputValue('');
        return;
      }
      exit();
      return;
    }

    // Toggle between OpenCode simple view and Multipanel Command Center on Tab/Ctrl+Tab
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
      setViewMode((prev) => (prev === 'simple' ? 'multipanel' : 'simple'));
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
  const roleConfigs = useMemo(
    () => orchestrator.storage.listRoleConfigs(project.id),
    [orchestrator.storage, project.id, expertSummaries, roleConfigVersion],
  );
  const repoSummary =
    project.repositories.length > 0
      ? `${project.repositories.length} (${project.repositories.join(', ')})`
      : '0';

  const renderTopColorBanner = (barWidth: number, currentViewName: string) => {
    const leftPart = ` ● ${activeRoleDisplayName.toUpperCase()} (/${activeRole}) │ [${t.activeBadge}: ${project.name}] │ dir: ${project.workspaceDir} │ ${t.reposLabel}: ${repoSummary} │ ${t.phaseLabel}: ${project.phase}`;
    const rightPart = `lang: ${language.toUpperCase()} │ ${t.viewLabel}: ${currentViewName} `;
    const gap = Math.max(1, barWidth - leftPart.length - rightPart.length);
    const fullBannerLine = fitAndPadLine(
      `${leftPart}${' '.repeat(gap)}${rightPart}`,
      barWidth,
    );

    return (
      <Box flexDirection="column" width="100%">
        <Text
          bold
          backgroundColor={activeTheme.bgColor}
          color={activeTheme.fgColor}
        >
          {fullBannerLine}
        </Text>
        <Box justifyContent="space-between" width="100%" marginTop={0}>
          <Box>
            {(['pm', 'architect', 'developer', 'qa'] as const).map((rKey) => {
              const rTheme = getRoleTheme(rKey);
              const isCurrent = activeRole === rKey;
              const label = ` /${rKey} ${t.expertBoxTitles[rKey]} `;
              return (
                <Box key={rKey} marginRight={1}>
                  <Text
                    bold={isCurrent}
                    backgroundColor={isCurrent ? rTheme.bgColor : undefined}
                    color={isCurrent ? rTheme.fgColor : rTheme.accentColor}
                  >
                    {isCurrent ? `▶${label}` : `[${label.trim()}]`}
                  </Text>
                </Box>
              );
            })}
          </Box>
          <Text dimColor>({t.toggleViewHint})</Text>
        </Box>
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
    const modalWidth = Math.max(76, Math.min(128, dimensions.columns - 6));
    const innerWidth = Math.max(68, modalWidth - 6);
    const tabWidth = Math.max(12, Math.floor((innerWidth - 4) / 5));
    const windowSize = Math.max(
      6,
      Math.min(12, Math.max(22, dimensions.rows - 1) - 19),
    );
    const modalHeight = windowSize + 15;

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
    const selectedTargetSummary =
      modelsTargetRole === 'all'
        ? `${t.modelsAllAgentsLabel} — ${roleConfigs
            .map((rc) => `${rc.role.toUpperCase()}: ${rc.modelId}`)
            .join(' · ')}`
        : `${getRoleDisplayName(modelsTargetRole, language)} — [${
            selectedTargetCfg?.provider ?? 'anthropic'
          }] ${selectedTargetCfg?.modelId ?? 'default'}`;

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
        <Box justifyContent="space-between" height={1}>
          <Text bold color={targetTheme.accentColor} wrap="truncate-end">
            🤖 {t.modelsTitle}
          </Text>
          <Text dimColor wrap="truncate-end">
            [{project.name}]
          </Text>
        </Box>
        <Box height={1}>
          <Text dimColor wrap="truncate-end">
            {t.modelsSubtitle}
          </Text>
        </Box>

        {/* Per-Agent Target Selector Bar: strictly fixed 1-line tabs + 1-line summary */}
        <Box marginTop={1} flexDirection="column" height={3}>
          <Box justifyContent="space-between" height={1}>
            <Text bold color="white" wrap="truncate-end">
              {t.modelsTargetAgentLabel}
            </Text>
            <Text color={targetTheme.accentColor} wrap="truncate-end">
              {selectedTargetSummary}
            </Text>
          </Box>
          <Box
            flexDirection="row"
            width="100%"
            height={1}
            marginTop={1}
            justifyContent="space-between"
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
              const cfg =
                opt === 'all'
                  ? undefined
                  : roleConfigs.find((rc) => rc.role === opt);
              const rawLabel =
                opt === 'all'
                  ? t.modelsAllAgentsLabel
                  : `${t.expertBoxTitles[opt]} (${cfg?.modelId ?? 'default'})`;
              const formattedTab = fitAndPadLine(
                isSelectedTarget ? ` ▶ ${rawLabel}` : `   ${rawLabel}`,
                tabWidth,
              );

              return (
                <Box key={opt} width={tabWidth} height={1}>
                  <Text
                    bold={isSelectedTarget}
                    wrap="truncate-end"
                    backgroundColor={
                      isSelectedTarget ? optTheme.bgColor : undefined
                    }
                    color={
                      isSelectedTarget ? optTheme.fgColor : optTheme.accentColor
                    }
                  >
                    {formattedTab}
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
                      [{m.provider.toUpperCase().padEnd(13, ' ')}]
                    </Text>{' '}
                    {m.displayName.padEnd(28, ' ')}{' '}
                    <Text dimColor>
                      ({m.modelId}) · {m.contextWindow} · {m.recommendedFor}
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
                            {` ${rKey.toUpperCase()} `}
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
    isModelsModalOpen ||
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

  // Keep root Box height strictly < stdout.rows (rows - 1) so Ink never hits
  // its `outputHeight >= stdout.rows` branch in ink.js:121 which executes a
  // full `ansiEscapes.clearTerminal` (\x1b[2J\x1b[3J\x1b[H) on every keystroke.
  const safeViewportHeight = Math.max(18, dimensions.rows - 1);

  // ==========================================================================
  // RENDER MODE 1: OPENCODE-STYLE CLEAN FULLSCREEN VIEW (DEFAULT ON STARTUP)
  // ==========================================================================
  if (viewMode === 'simple') {
    const simpleBarWidth = Math.max(40, dimensions.columns - 4);
    return (
      <Box
        flexDirection="column"
        width={dimensions.columns}
        height={safeViewportHeight}
        justifyContent="space-between"
        paddingX={2}
        paddingY={1}
      >
        {/* Top bar with solid color-coded background banner for the active agent */}
        {renderTopColorBanner(simpleBarWidth, t.cleanViewName)}

        {/* Center Area: When a modal is open, render ONLY the centered modal cleanly
            without the PO CLI logo or any text/prompt boxes underneath. */}
        <Box
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          flexGrow={1}
          width="100%"
        >
          {anyModalOpen ? (
            <>
              {projectWizardStep !== 'CLOSED' && renderProjectWizardModal()}
              {isProjectsModalOpen && renderProjectsListModal()}
              {isModelsModalOpen && renderModelsModal()}
              {dbModalOutput.length > 0 && renderDbModal()}
              {isHelpOpen && renderHelpModal()}
              {isSettingsOpen && renderSettingsModal()}
            </>
          ) : (
            <>
              {/* Centered ASCII Banner (always fixed grayscale) */}
              <Box flexDirection="column" alignItems="center" marginBottom={1}>
                {ASCII_LOGO.map((line, i) => (
                  <Text
                    key={i}
                    bold
                    color={i < 2 ? 'white' : 'gray'}
                    dimColor={i >= 4}
                  >
                    {line}
                  </Text>
                ))}
                <Box marginTop={1}>
                  <Text dimColor>
                    {t.virtualEngineeringTeam} · {t.projectLabel}:{' '}
                    <Text color="green" bold>
                      {project.name}
                    </Text>{' '}
                    · {activeRoleDisplayName.toUpperCase()} ({activeModelCfg.modelId}) ·{' '}
                    {t.archVersionShort} v{project.approvedArchitectureVersion}
                  </Text>
                </Box>
              </Box>

              {/* Recent conversation snippet if any */}
              {(lastMessages.length > 0 || streamingText) && (
                <Box
                  flexDirection="column"
                  width={Math.min(92, dimensions.columns - 8)}
                  borderStyle="round"
                  borderColor="gray"
                  paddingX={2}
                  paddingY={0}
                  marginBottom={1}
                >
                  {lastMessages.map((m) => (
                    <Box key={m.id} flexDirection="column" marginY={0}>
                      <Text
                        bold
                        color={m.fromRole === 'product_owner' ? 'cyan' : 'green'}
                      >
                        {m.fromRole === 'product_owner'
                          ? getRoleDisplayName('product_owner', language)
                          : activeRoleDisplayName}
                        :
                      </Text>
                      <Text>
                        {m.content.length > 220
                          ? `${m.content.slice(0, 220)}...`
                          : m.content}
                      </Text>
                    </Box>
                  ))}
                  {streamingText && (
                    <Box flexDirection="column">
                      <Text bold color="green">
                        {activeRoleDisplayName} (streaming):
                      </Text>
                      <Text>{streamingText}</Text>
                    </Box>
                  )}
                </Box>
              )}

              {/* Slash Command Popover Menu when user types "/" */}
              {isSlashMenuOpen && (
                <Box
                  flexDirection="column"
                  width={Math.min(92, dimensions.columns - 8)}
                  borderStyle="round"
                  borderColor="magenta"
                  paddingX={2}
                  marginBottom={1}
                >
                  <Text bold color="magenta">
                    {t.availableCommandsHeader}
                  </Text>
                  {filteredSlashCommands.length === 0 ? (
                    <Text dimColor>
                      {t.noCommandMatches} "{inputValue}"
                    </Text>
                  ) : (
                    (() => {
                      const windowSize = 8;
                      const start = Math.max(
                        0,
                        Math.min(
                          selectedSlashIdx - Math.floor(windowSize / 2),
                          Math.max(0, filteredSlashCommands.length - windowSize),
                        ),
                      );
                      const visible = filteredSlashCommands.slice(
                        start,
                        start + windowSize,
                      );
                      return visible.map((item, localIdx) => {
                        const realIdx = start + localIdx;
                        const isSelected = realIdx === selectedSlashIdx;
                        return (
                          <Box key={item.command} justifyContent="space-between">
                            <Text
                              color={isSelected ? 'cyan' : 'white'}
                              bold={isSelected}
                            >
                              {isSelected ? '❯ ' : '  '}
                              {item.command.padEnd(14, ' ')}
                              <Text
                                dimColor={!isSelected}
                                color={isSelected ? 'white' : undefined}
                              >
                                {item.description}
                              </Text>
                            </Text>
                            {item.phaseHint && (
                              <Text color="yellow" dimColor={!isSelected}>
                                [{item.phaseHint}]
                              </Text>
                            )}
                          </Box>
                        );
                      });
                    })()
                  )}
                </Box>
              )}

              {/* Centered OpenCode-style Prompt Box showing active project & active role */}
              <Box
                flexDirection="column"
                width={Math.min(92, dimensions.columns - 8)}
                borderStyle="round"
                borderColor={
                  isSlashMenuOpen ? 'magenta' : activeTheme.accentColor
                }
                paddingX={2}
                paddingY={0}
              >
                <Box justifyContent="space-between">
                  <Text>
                    <Text bold color="green">
                      [{project.name}]
                    </Text>{' '}
                    <Text bold color={activeTheme.accentColor}>
                      ❯{' '}
                    </Text>
                    <Text>{inputValue}</Text>
                    <Text color={activeTheme.accentColor}>█</Text>
                  </Text>
                  <Text dimColor>
                    {project.name} · {activeRoleDisplayName}
                  </Text>
                </Box>
                <Box justifyContent="space-between" marginTop={0}>
                  <Text dimColor>{t.inputPlaceholderHint}</Text>
                  <Text dimColor>Enter ↵</Text>
                </Box>
              </Box>
            </>
          )}
        </Box>

        {/* Bottom Status Bar */}
        <Box justifyContent="space-between" width="100%">
          <Text color={busy ? 'yellow' : 'gray'}>{statusBanner}</Text>
          <Text dimColor>{t.bottomShortcutsHint}</Text>
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
      {renderTopColorBanner(multipanelBarWidth, t.multipanelViewName)}

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
          {isModelsModalOpen && renderModelsModal()}
          {dbModalOutput.length > 0 && renderDbModal()}
          {isHelpOpen && renderHelpModal()}
          {isSettingsOpen && renderSettingsModal()}
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
                multipanelMessages.map((m) => (
                  <Box key={m.id} flexDirection="column" marginTop={1}>
                    <Text
                      bold
                      color={m.fromRole === 'product_owner' ? 'cyan' : 'green'}
                    >
                      [{m.fromRole} → {m.toRole}]:
                    </Text>
                    <Text>
                      {m.content.slice(0, 200)}
                      {m.content.length > 200 ? '...' : ''}
                    </Text>
                  </Box>
                ))
              )}
            </Box>
          </Box>

          {/* Slash Menu Popover inside Multipanel mode */}
          {isSlashMenuOpen && (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="magenta"
              paddingX={1}
            >
              {filteredSlashCommands.slice(0, 6).map((item, idx) => {
                const isSelected = idx === selectedSlashIdx;
                return (
                  <Text
                    key={item.command}
                    color={isSelected ? 'cyan' : 'white'}
                    bold={isSelected}
                  >
                    {isSelected ? '❯ ' : '  '}
                    {item.command.padEnd(14, ' ')} — {item.description}
                  </Text>
                );
              })}
            </Box>
          )}

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
