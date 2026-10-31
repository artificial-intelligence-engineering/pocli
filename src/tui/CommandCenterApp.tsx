import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp, useStdout, useStdin } from 'ink';
import { ActorRole, Artifact, Notebook, Project } from '../core/contracts.js';
import {
  getRoleDisplayName,
  I18N_DICTIONARY,
  SupportedLanguage,
} from '../core/i18n.js';
import { PoCliOrchestrator } from '../runtime/orchestrator.js';
import { HarnessRegistry } from '../runtime/harnesses.js';

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

export const CommandCenterApp: React.FC<CommandCenterProps> = ({
  orchestrator,
  initialProject,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();

  const initialSettings = orchestrator.storage.getSettings();
  const [language, setLanguage] = useState<SupportedLanguage>(
    initialSettings.language,
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
  const [project, setProject] = useState<Project>(initialProject);
  const [activeRole, setActiveRole] = useState<ActorRole>('architect');
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);

  // Prompt input & slash command menu state
  const [inputValue, setInputValue] = useState<string>('');
  const [selectedSlashIdx, setSelectedSlashIdx] = useState<number>(0);
  const [busy, setBusy] = useState<boolean>(false);
  const [streamingText, setStreamingText] = useState<string>('');
  const [statusBanner, setStatusBanner] = useState<string>(t.initialStatusBanner);

  const refreshState = () => {
    const updated = orchestrator.storage.getProject(project.id);
    if (updated) setProject(updated);
    setArtifacts(orchestrator.storage.listArtifacts(project.id, true));
    setNotebooks(orchestrator.storage.getProjectNotebooks(project.id));
  };

  useEffect(() => {
    refreshState();
  }, []);

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

  // Listen for raw CSI-u / xterm modifyOtherKeys Ctrl+Tab sequences on Linux terminals
  useEffect(() => {
    if (!stdin) return;
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
    stdin.on('data', onRawData);
    return () => {
      stdin.off('data', onRawData);
    };
  }, [stdin]);

  const applyLanguageChange = (nextLang: SupportedLanguage) => {
    orchestrator.storage.updateSettings({ language: nextLang });
    setLanguage(nextLang);
    setStatusBanner(I18N_DICTIONARY[nextLang].settingsSavedMsg(nextLang));
  };

  const isSlashMenuOpen = inputValue.startsWith('/');
  const slashToken = inputValue.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const filteredSlashCommands = isSlashMenuOpen
    ? t.slashCommands.filter((cmd) =>
        cmd.command.toLowerCase().startsWith(slashToken),
      )
    : [];

  useEffect(() => {
    setSelectedSlashIdx(0);
  }, [inputValue]);

  const executeCommandOrMessage = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || busy) return;

    // Handle slash commands starting with "/"
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const cmdToken = parts[0].toLowerCase();
      setInputValue('');

      if (cmdToken === '/exit' || cmdToken === '/quit') {
        exit();
        return;
      }
      if (cmdToken === '/help' || cmdToken === '/h' || cmdToken === '/?') {
        setIsSettingsOpen(false);
        setIsHelpOpen((prev) => !prev);
        setStatusBanner(t.helpOpenedMsg);
        return;
      }
      if (cmdToken === '/settings') {
        setIsHelpOpen(false);
        const arg1 = parts[1]?.toLowerCase();
        const arg2 = parts[2]?.toLowerCase();
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
        setIsSettingsOpen((prev) => !prev);
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
      refreshState();
    } catch (err) {
      setStatusBanner(`✖ Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    // Handle interactive Help modal when open
    if (isHelpOpen) {
      if (key.escape || key.return || input === 'q') {
        setIsHelpOpen(false);
        return;
      }
      return;
    }

    // Handle interactive Settings modal when open
    if (isSettingsOpen) {
      if (key.escape || input === 'q') {
        setIsSettingsOpen(false);
        return;
      }
      if (key.leftArrow || key.rightArrow || key.return || input === ' ') {
        const nextLang: SupportedLanguage = language === 'en' ? 'es' : 'en';
        applyLanguageChange(nextLang);
        return;
      }
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
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      setInputValue((prev) => prev + input);
    }
  });

  const harnesses = HarnessRegistry.listHarnesses();
  const activeRoleDisplayName = getRoleDisplayName(activeRole, language);
  const activeModelCfg = orchestrator.storage.getRoleConfig(
    project.id,
    activeRole,
  );
  const messages = orchestrator.storage.listMessages(project.id, activeRole);
  const lastMessages = messages.slice(-3);
  const roleConfigs = orchestrator.storage.listRoleConfigs(project.id);

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
      width={Math.min(82, dimensions.columns - 8)}
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
      <Box marginTop={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Text bold color="white">
            ❯ {t.settingLanguageLabel}
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
    </Box>
  );

  // ==========================================================================
  // RENDER MODE 1: OPENCODE-STYLE CLEAN FULLSCREEN VIEW (DEFAULT ON STARTUP)
  // ==========================================================================
  if (viewMode === 'simple') {
    return (
      <Box
        flexDirection="column"
        width={dimensions.columns}
        height={dimensions.rows}
        justifyContent="space-between"
        paddingX={2}
        paddingY={1}
      >
        {/* Top subtle bar */}
        <Box justifyContent="space-between" width="100%">
          <Text dimColor>
            pocli v1.0.0 · {t.projectLabel}:{' '}
            <Text color="white">{project.name}</Text> · {t.phaseLabel}:{' '}
            <Text color="cyan">{project.phase}</Text> · lang:{' '}
            <Text color="yellow">{language.toUpperCase()}</Text>
          </Text>
          <Text dimColor>
            {t.viewLabel}: <Text color="green">{t.cleanViewName}</Text> (
            {t.toggleViewHint})
          </Text>
        </Box>

        {/* Center Area: OpenCode-style centered banner + latest conversation + input box */}
        <Box
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          flexGrow={1}
          width="100%"
        >
          {/* Centered ASCII Banner */}
          <Box flexDirection="column" alignItems="center" marginBottom={1}>
            {ASCII_LOGO.map((line, i) => (
              <Text key={i} bold color="cyan">
                {line}
              </Text>
            ))}
            <Box marginTop={1}>
              <Text dimColor>
                {t.virtualEngineeringTeam} ·{' '}
                <Text color="white" bold>
                  {activeRoleDisplayName}
                </Text>{' '}
                ({activeModelCfg.modelId}) · {t.archVersionShort} v
                {project.approvedArchitectureVersion}
              </Text>
            </Box>
          </Box>

          {/* Interactive Help Panel when /help is active */}
          {isHelpOpen && renderHelpModal()}

          {/* Interactive Settings Panel when /settings is active */}
          {isSettingsOpen && renderSettingsModal()}

          {/* Recent conversation snippet if any */}
          {!isSettingsOpen && !isHelpOpen && (lastMessages.length > 0 || streamingText) && (
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
          {!isSettingsOpen && !isHelpOpen && isSlashMenuOpen && (
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

          {/* Centered OpenCode-style Prompt Box */}
          <Box
            flexDirection="column"
            width={Math.min(92, dimensions.columns - 8)}
            borderStyle="round"
            borderColor={isSlashMenuOpen ? 'magenta' : 'cyan'}
            paddingX={2}
            paddingY={0}
          >
            <Box justifyContent="space-between">
              <Text>
                <Text bold color="cyan">
                  ❯{' '}
                </Text>
                <Text>{inputValue}</Text>
                <Text color="cyan">█</Text>
              </Text>
              <Text dimColor>[{activeRole}]</Text>
            </Box>
            <Box justifyContent="space-between" marginTop={0}>
              <Text dimColor>{t.inputPlaceholderHint}</Text>
              <Text dimColor>Enter ↵</Text>
            </Box>
          </Box>
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
  return (
    <Box
      flexDirection="column"
      width={dimensions.columns}
      height={dimensions.rows}
      justifyContent="space-between"
      paddingX={1}
      borderStyle="round"
      borderColor="cyan"
    >
      {/* Header Bar */}
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {t.multipanelHeaderTitle}
        </Text>
        <Text>
          {t.projectLabel}: <Text bold color="yellow">{project.name}</Text> |{' '}
          {t.phaseLabel}: <Text bold color="green">{project.phase}</Text> |{' '}
          {t.archVersionShort}:{' '}
          <Text bold>v{project.approvedArchitectureVersion}</Text> |{' '}
          {t.qaCyclesShort}: <Text bold>{project.correctionCycleCount}</Text> |
          Lang: <Text bold color="yellow">{language.toUpperCase()}</Text>
        </Text>
      </Box>

      {isHelpOpen && (
        <Box marginTop={1} justifyContent="center">
          {renderHelpModal()}
        </Box>
      )}

      {isSettingsOpen && (
        <Box marginTop={1} justifyContent="center">
          {renderSettingsModal()}
        </Box>
      )}

      {/* Main Split Body */}
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
              artifacts.slice(0, 8).map((art) => (
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
            messages.slice(-5).map((m) => (
              <Box key={m.id} flexDirection="column" marginTop={1}>
                <Text
                  bold
                  color={m.fromRole === 'product_owner' ? 'cyan' : 'green'}
                >
                  [{m.fromRole} → {m.toRole}]:
                </Text>
                <Text>
                  {m.content.slice(0, 220)}
                  {m.content.length > 220 ? '...' : ''}
                </Text>
              </Box>
            ))
          )}
        </Box>
      </Box>

      {/* Slash Menu Popover inside Multipanel mode */}
      {!isSettingsOpen && !isHelpOpen && isSlashMenuOpen && (
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

      {/* Bottom Input Box + Status Footer */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
      >
        <Box justifyContent="space-between">
          <Text>
            <Text bold color="cyan">
              [{activeRole}] ❯{' '}
            </Text>
            <Text>{inputValue}</Text>
            <Text color="cyan">█</Text>
          </Text>
          <Text dimColor>{t.returnToCleanViewHint}</Text>
        </Box>
        <Text color={busy ? 'yellow' : 'gray'}>{statusBanner}</Text>
      </Box>
    </Box>
  );
};
