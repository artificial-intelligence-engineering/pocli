import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp, useStdout, useStdin } from 'ink';
import { ActorRole, Artifact, Notebook, Project } from '../core/contracts.js';
import { PoCliOrchestrator } from '../runtime/orchestrator.js';
import { HarnessRegistry } from '../runtime/harnesses.js';

export interface CommandCenterProps {
  orchestrator: PoCliOrchestrator;
  initialProject: Project;
}

interface SlashCommandDef {
  command: string;
  description: string;
  phaseHint?: string;
}

const SLASH_COMMANDS: SlashCommandDef[] = [
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
    command: '/view',
    description: 'Alternar entre vista limpia (OpenCode) y Multipanel (Ctrl+Tab)',
  },
  {
    command: '/clear',
    description: 'Limpiar el registro de notificaciones en pantalla',
  },
  {
    command: '/exit',
    description: 'Salir de Product Owner CLI',
  },
];

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

  const [dimensions, setDimensions] = useState<{ columns: number; rows: number }>({
    columns: stdout?.columns ?? 120,
    rows: stdout?.rows ?? 36,
  });

  // View mode: 'simple' (OpenCode-like centered clean view) vs 'multipanel' (Full Command Center)
  const [viewMode, setViewMode] = useState<'simple' | 'multipanel'>('simple');
  const [project, setProject] = useState<Project>(initialProject);
  const [activeRole, setActiveRole] = useState<ActorRole>('architect');
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);

  // Prompt input & slash command menu state
  const [inputValue, setInputValue] = useState<string>('');
  const [selectedSlashIdx, setSelectedSlashIdx] = useState<number>(0);
  const [busy, setBusy] = useState<boolean>(false);
  const [streamingText, setStreamingText] = useState<string>('');
  const [statusBanner, setStatusBanner] = useState<string>(
    'Escribe un mensaje para el profesional activo o usa "/" para ver comandos. Pulsa Ctrl+Tab para alternar vista.',
  );

  const refreshState = () => {
    const updated = orchestrator.storage.getProject(project.id);
    if (updated) setProject(updated);
    setArtifacts(orchestrator.storage.listArtifacts(project.id, true));
    setNotebooks(orchestrator.storage.getProjectNotebooks(project.id));
  };

  useEffect(() => {
    refreshState();
  }, []);

  // Track terminal resize so fullscreen layout always fills 100% of terminal
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

  const isSlashMenuOpen = inputValue.startsWith('/');
  const filteredSlashCommands = isSlashMenuOpen
    ? SLASH_COMMANDS.filter((cmd) =>
        cmd.command.toLowerCase().startsWith(inputValue.trim().toLowerCase()),
      )
    : [];

  useEffect(() => {
    setSelectedSlashIdx(0);
  }, [inputValue]);

  const executeCommandOrMessage = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || busy) return;

    // If user typed a slash command
    if (trimmed.startsWith('/')) {
      const cmdToken = trimmed.split(/\s+/)[0].toLowerCase();
      setInputValue('');

      if (cmdToken === '/exit' || cmdToken === '/quit') {
        exit();
        return;
      }
      if (cmdToken === '/view') {
        setViewMode((prev) => (prev === 'simple' ? 'multipanel' : 'simple'));
        return;
      }
      if (cmdToken === '/clear') {
        setStreamingText('');
        setStatusBanner('Pantalla de estado limpiada.');
        return;
      }
      if (cmdToken === '/architect') {
        setActiveRole('architect');
        setStatusBanner('Interlocutor activo: Arquitecto de Software');
        return;
      }
      if (cmdToken === '/developer') {
        setActiveRole('developer');
        setStatusBanner('Interlocutor activo: Desarrollador Experto');
        return;
      }
      if (cmdToken === '/qa') {
        setActiveRole('qa');
        setStatusBanner('Interlocutor activo: Ingeniero de QA Independiente');
        return;
      }
      if (cmdToken === '/propose') {
        setActiveRole('architect');
        await sendChatMessage(
          'architect',
          'Diseña y propón la arquitectura formal y requisitos del proyecto.',
        );
        return;
      }
      if (cmdToken === '/approve') {
        try {
          const { approval } = orchestrator.reviewArchitectureByPo({
            projectId: project.id,
            artifactCode: 'ARCH-001',
            decision: 'APPROVED',
            comments: 'Arquitectura aprobada formalmente por el Product Owner.',
          });
          setStatusBanner(
            `✔ Arquitectura ARCH-001 v${approval.artifactVersion} APROBADA por el Product Owner.`,
          );
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error al aprobar: ${(err as Error).message}`);
        }
        return;
      }
      if (cmdToken === '/reject') {
        try {
          orchestrator.reviewArchitectureByPo({
            projectId: project.id,
            artifactCode: 'ARCH-001',
            decision: 'REJECTED',
            comments: 'El Product Owner solicita revisar la propuesta arquitectónica.',
          });
          setStatusBanner('↺ Arquitectura ARCH-001 rechazada. Devuelta a Fase 2 (Análisis).');
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error al rechazar: ${(err as Error).message}`);
        }
        return;
      }
      if (cmdToken === '/handoff') {
        try {
          const bundle = orchestrator.performDeveloperHandoff(project.id);
          setActiveRole('developer');
          setStatusBanner(
            `✔ Handoff transferido al Desarrollador (ARCH v${bundle.approvedArchitectureVersion}).`,
          );
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error en Handoff: ${(err as Error).message}`);
        }
        return;
      }
      if (cmdToken === '/implement') {
        setActiveRole('developer');
        await sendChatMessage(
          'developer',
          'Implementa el software siguiendo estrictamente el paquete de Handoff aprobado.',
        );
        return;
      }
      if (cmdToken === '/consult') {
        setBusy(true);
        try {
          const cons = await orchestrator.consultArchitectFromDeveloper({
            projectId: project.id,
            subject: 'Consulta sobre validación de contrato en implementación',
            ambiguityOrBlocker: 'Ambigüedad detectada en el tratamiento de errores de entrada',
            proposedAlternative: 'Emitir excepción tipada conforme a SPEC-001',
            impactedArtifacts: ['ARCH-001', 'SPEC-001'],
          });
          setStatusBanner(
            `✔ Consulta Desarrollador → Arquitecto registrada y evaluada: ${cons.status}`,
          );
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error en consulta: ${(err as Error).message}`);
        } finally {
          setBusy(false);
        }
        return;
      }
      if (cmdToken === '/validate') {
        setBusy(true);
        setActiveRole('qa');
        setStatusBanner('⏳ Ingeniero de QA ejecutando pruebas independientes...');
        try {
          const res = await orchestrator.submitToQaAndValidate({
            projectId: project.id,
          });
          setStatusBanner(
            `✔ QA emitió ${res.qaArtifact.code}: ${res.payload.recommendation} (${res.payload.passedTests.length}/${res.payload.executedTests.length} pruebas superadas).`,
          );
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ Error en validación QA: ${(err as Error).message}`);
        } finally {
          setBusy(false);
        }
        return;
      }
      if (cmdToken === '/accept') {
        try {
          orchestrator.acceptProjectByPo({
            projectId: project.id,
            comments: 'Proyecto aceptado finalmente por el Product Owner.',
          });
          setStatusBanner('★ ¡Proyecto ACEPTADO y COMPLETADO por el Product Owner!');
          refreshState();
        } catch (err) {
          setStatusBanner(`✖ No se puede aceptar aún: ${(err as Error).message}`);
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
          `✔ Notebooks activos asociados al proyecto: ${nbs.length} (${nbs.map((n) => n.name).join(', ') || 'ninguno'}).`,
        );
        return;
      }

      setStatusBanner(`Comando desconocido: ${cmdToken}. Escribe "/" para ver la lista.`);
      return;
    }

    // Normal conversation message sent to the currently active professional
    setInputValue('');
    await sendChatMessage(activeRole, trimmed);
  };

  const sendChatMessage = async (targetRole: ActorRole, messageText: string) => {
    setBusy(true);
    setStreamingText('');
    setStatusBanner(`⏳ Consultando a ${targetRole.toUpperCase()} en proceso Linux aislado...`);
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
        `✔ ${targetRole.toUpperCase()} respondió (Worker PID ${res.workerPid} | ${res.createdArtifacts.length} artefactos nuevos).`,
      );
      refreshState();
    } catch (err) {
      setStatusBanner(`✖ Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
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
      if (isSlashMenuOpen && filteredSlashCommands.length > 0 && !key.shift && !key.ctrl) {
        // Autocomplete selected slash command
        const chosen = filteredSlashCommands[selectedSlashIdx] ?? filteredSlashCommands[0];
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
      if (isSlashMenuOpen && filteredSlashCommands.length > 0) {
        const chosen = filteredSlashCommands[selectedSlashIdx] ?? filteredSlashCommands[0];
        if (chosen && inputValue.trim() === chosen.command) {
          void executeCommandOrMessage(chosen.command);
          return;
        } else if (chosen && !SLASH_COMMANDS.some((c) => c.command === inputValue.trim())) {
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
  const activeHarness = harnesses.find((h) => h.role === activeRole) ?? harnesses[0];
  const activeModelCfg = orchestrator.storage.getRoleConfig(project.id, activeRole);
  const messages = orchestrator.storage.listMessages(project.id, activeRole);
  const lastMessages = messages.slice(-3);
  const roleConfigs = orchestrator.storage.listRoleConfigs(project.id);

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
            pocli v1.0.0 · proyecto: <Text color="white">{project.name}</Text> · fase:{' '}
            <Text color="cyan">{project.phase}</Text>
          </Text>
          <Text dimColor>
            vista: <Text color="green">limpia</Text> (pulsa <Text color="yellow">Ctrl+Tab</Text> para Multipanel)
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
                Equipo Virtual de Ingeniería ·{' '}
                <Text color="white" bold>
                  {activeHarness.displayName}
                </Text>{' '}
                ({activeModelCfg.modelId}) · Arq v{project.approvedArchitectureVersion}
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
                    {m.fromRole === 'product_owner' ? 'Product Owner' : activeHarness.displayName}:
                  </Text>
                  <Text>
                    {m.content.length > 220 ? `${m.content.slice(0, 220)}...` : m.content}
                  </Text>
                </Box>
              ))}
              {streamingText && (
                <Box flexDirection="column">
                  <Text bold color="green">
                    {activeHarness.displayName} (streaming):
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
                Comandos disponibles (↑/↓ seleccionar · Tab autocompletar · Enter ejecutar)
              </Text>
              {filteredSlashCommands.length === 0 ? (
                <Text dimColor>Sin coincidencias para "{inputValue}"</Text>
              ) : (
                filteredSlashCommands.slice(0, 7).map((item, idx) => {
                  const isSelected = idx === selectedSlashIdx;
                  return (
                    <Box key={item.command} justifyContent="space-between">
                      <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                        {isSelected ? '❯ ' : '  '}
                        {item.command.padEnd(14, ' ')}
                        <Text dimColor={!isSelected} color={isSelected ? 'white' : undefined}>
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
                })
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
              <Text dimColor>
                [{activeRole}]
              </Text>
            </Box>
            <Box justifyContent="space-between" marginTop={0}>
              <Text dimColor>
                Escribe tu instrucción o <Text color="yellow">"/"</Text> para comandos (/propose, /approve, /handoff, /implement, /validate)
              </Text>
              <Text dimColor>Enter ↵</Text>
            </Box>
          </Box>
        </Box>

        {/* Bottom Status Bar */}
        <Box justifyContent="space-between" width="100%">
          <Text color={busy ? 'yellow' : 'gray'}>{statusBanner}</Text>
          <Text dimColor>
            <Text color="yellow">/</Text> comandos · <Text color="yellow">Ctrl+Tab</Text> multipanel · <Text color="yellow">Esc</Text> salir
          </Text>
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
          PO CLI — Centro de Mando Multipanel (Linux)
        </Text>
        <Text>
          Proyecto: <Text bold color="yellow">{project.name}</Text> | Fase:{' '}
          <Text bold color="green">{project.phase}</Text> | Arq:{' '}
          <Text bold>v{project.approvedArchitectureVersion}</Text> | Ciclos QA:{' '}
          <Text bold>{project.correctionCycleCount}</Text>
        </Text>
      </Box>

      {/* Main Split Body */}
      <Box flexDirection="row" flexGrow={1} marginTop={1}>
        {/* Left Sidebar: Team, Artifacts & Notebooks */}
        <Box flexDirection="column" width="42%" paddingRight={2}>
          <Text bold underline color="magenta">
            1. Equipo Virtual de Ingeniería
          </Text>
          {harnesses.map((h, idx) => {
            const cfg = roleConfigs.find((rc) => rc.role === h.role);
            const isSelected = h.role === activeRole;
            return (
              <Text key={h.role} color={isSelected ? 'green' : 'white'}>
                {isSelected ? '▶ ' : '  '}[{idx + 1}] {h.displayName} ({cfg?.modelId ?? 'default'} |{' '}
                {cfg?.executionModality ?? 'LOCAL'})
              </Text>
            );
          })}

          <Box marginTop={1} flexDirection="column">
            <Text bold underline color="magenta">
              2. Artefactos Versionados ({artifacts.length})
            </Text>
            {artifacts.length === 0 ? (
              <Text dimColor>  Sin artefactos generados aún.</Text>
            ) : (
              artifacts.slice(0, 8).map((art) => (
                <Text key={art.id}>
                  {'  '}• <Text bold>{art.code}</Text> v{art.version} [{art.status}] →{' '}
                  {art.tracesTo.join(',') || 'raíz'}
                </Text>
              ))
            )}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text bold underline color="magenta">
              3. Notebooks RAG Asociados ({notebooks.length})
            </Text>
            {notebooks.length === 0 ? (
              <Text dimColor>  Sin notebooks vinculados.</Text>
            ) : (
              notebooks.map((nb) => (
                <Text key={nb.id}>
                  {'  '}• <Text bold color="cyan">{nb.name}</Text> ({nb.allowedRoles.join(',')})
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
            Canal Directo PO ↔ {activeHarness.displayName.toUpperCase()}
          </Text>
          {messages.length === 0 ? (
            <Text dimColor>No hay mensajes en este canal todavía.</Text>
          ) : (
            messages.slice(-5).map((m) => (
              <Box key={m.id} flexDirection="column" marginTop={1}>
                <Text bold color={m.fromRole === 'product_owner' ? 'cyan' : 'green'}>
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
      {isSlashMenuOpen && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="magenta"
          paddingX={1}
        >
          {filteredSlashCommands.slice(0, 5).map((item, idx) => {
            const isSelected = idx === selectedSlashIdx;
            return (
              <Text key={item.command} color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                {isSelected ? '❯ ' : '  '}
                {item.command.padEnd(14, ' ')} — {item.description}
              </Text>
            );
          })}
        </Box>
      )}

      {/* Bottom Input Box + Status Footer */}
      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Box justifyContent="space-between">
          <Text>
            <Text bold color="cyan">
              [{activeRole}] ❯{' '}
            </Text>
            <Text>{inputValue}</Text>
            <Text color="cyan">█</Text>
          </Text>
          <Text dimColor>
            Pulsa <Text color="yellow">Ctrl+Tab</Text> para volver a vista limpia
          </Text>
        </Box>
        <Text color={busy ? 'yellow' : 'gray'}>{statusBanner}</Text>
      </Box>
    </Box>
  );
};
