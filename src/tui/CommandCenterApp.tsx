import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { ActorRole, Artifact, Notebook, Project } from '../core/contracts.js';
import { PoCliOrchestrator } from '../runtime/orchestrator.js';
import { HarnessRegistry } from '../runtime/harnesses.js';

export interface CommandCenterProps {
  orchestrator: PoCliOrchestrator;
  initialProject: Project;
}

export const CommandCenterApp: React.FC<CommandCenterProps> = ({
  orchestrator,
  initialProject,
}) => {
  const { exit } = useApp();
  const [project, setProject] = useState<Project>(initialProject);
  const [activeRole, setActiveRole] = useState<ActorRole>('architect');
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [statusLog, setStatusLog] = useState<string>(
    'Centro de Mando iniciado. Usa [1/2/3] para cambiar profesional, [p] Proponer Arq, [a] Aprobar Arq, [h] Handoff, [d] Implementar, [v] Validar QA, [f] Aceptar Proyecto, [q] Salir.',
  );
  const [busy, setBusy] = useState<boolean>(false);

  const refreshState = () => {
    const updated = orchestrator.storage.getProject(project.id);
    if (updated) setProject(updated);
    setArtifacts(orchestrator.storage.listArtifacts(project.id, true));
    setNotebooks(orchestrator.storage.getProjectNotebooks(project.id));
  };

  useEffect(() => {
    refreshState();
  }, []);

  useInput((input, key) => {
    if (busy) return;
    if (input === 'q' || key.escape) {
      exit();
      return;
    }
    if (input === '1') {
      setActiveRole('architect');
      setStatusLog('Interlocutor activo: Arquitecto de Software');
    } else if (input === '2') {
      setActiveRole('developer');
      setStatusLog('Interlocutor activo: Desarrollador Experto');
    } else if (input === '3') {
      setActiveRole('qa');
      setStatusLog('Interlocutor activo: Ingeniero de QA');
    } else if (input === 'p') {
      setBusy(true);
      setStatusLog('Solicitando propuesta formal de arquitectura al Arquitecto...');
      orchestrator
        .chatWithProfessional({
          projectId: project.id,
          targetRole: 'architect',
          message: 'Diseña y propón la arquitectura formal y requisitos del proyecto.',
        })
        .then((res) => {
          setStatusLog(`Arquitecto respondió (PID ${res.workerPid}): ${res.createdArtifacts.length} artefactos generados.`);
          refreshState();
        })
        .catch((err: Error) => setStatusLog(`Error: ${err.message}`))
        .finally(() => setBusy(false));
    } else if (input === 'a') {
      try {
        const { approval } = orchestrator.reviewArchitectureByPo({
          projectId: project.id,
          artifactCode: 'ARCH-001',
          decision: 'APPROVED',
          comments: 'Arquitectura aprobada por el Product Owner desde el Centro de Mando TUI.',
        });
        setStatusLog(`Arquitectura ARCH-001 v${approval.artifactVersion} APROBADA formalmente.`);
        refreshState();
      } catch (err) {
        setStatusLog(`Error al aprobar arquitectura: ${(err as Error).message}`);
      }
    } else if (input === 'h') {
      try {
        const bundle = orchestrator.performDeveloperHandoff(project.id);
        setStatusLog(
          `Handoff completado al Desarrollador (ARCH v${bundle.approvedArchitectureVersion}).`,
        );
        refreshState();
      } catch (err) {
        setStatusLog(`Error en Handoff: ${(err as Error).message}`);
      }
    } else if (input === 'd') {
      setBusy(true);
      setStatusLog('Desarrollador implementando conforme a arquitectura aprobada...');
      orchestrator
        .chatWithProfessional({
          projectId: project.id,
          targetRole: 'developer',
          message: 'Implementa el software siguiendo el paquete de Handoff aprobado.',
        })
        .then((res) => {
          setStatusLog(`Desarrollador completó implementación (PID ${res.workerPid}).`);
          refreshState();
        })
        .catch((err: Error) => setStatusLog(`Error: ${err.message}`))
        .finally(() => setBusy(false));
    } else if (input === 'v') {
      setBusy(true);
      setStatusLog('Ingeniero de QA ejecutando pruebas independientes...');
      orchestrator
        .submitToQaAndValidate({ projectId: project.id })
        .then((res) => {
          setStatusLog(
            `QA emitió ${res.qaArtifact.code}: ${res.payload.recommendation} (${res.payload.passedTests.length}/${res.payload.executedTests.length} tests OK).`,
          );
          refreshState();
        })
        .catch((err: Error) => setStatusLog(`Error en QA: ${err.message}`))
        .finally(() => setBusy(false));
    } else if (input === 'f') {
      try {
        orchestrator.acceptProjectByPo({
          projectId: project.id,
          comments: 'Proyecto aceptado finalmente por el Product Owner.',
        });
        setStatusLog('¡Proyecto ACEPTADO y COMPLETADO por el Product Owner!');
        refreshState();
      } catch (err) {
        setStatusLog(`No se puede aceptar aún: ${(err as Error).message}`);
      }
    }
  });

  const messages = orchestrator.storage.listMessages(project.id, activeRole).slice(-6);
  const harnesses = HarnessRegistry.listHarnesses();
  const roleConfigs = orchestrator.storage.listRoleConfigs(project.id);

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      {/* Header Bar */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">
          PO CLI — Product Owner Command Center (Linux)
        </Text>
        <Text>
          Proyecto: <Text bold color="yellow">{project.name}</Text> | Fase:{' '}
          <Text bold color="green">{project.phase}</Text> | Arq Aprobada:{' '}
          <Text bold>v{project.approvedArchitectureVersion}</Text> | Ciclos QA:{' '}
          <Text bold>{project.correctionCycleCount}</Text>
        </Text>
      </Box>

      {/* Main Split View */}
      <Box flexDirection="row">
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
              artifacts.map((art) => (
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
        <Box flexDirection="column" width="58%" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold color="yellow">
            Canal Directo PO ↔ {activeRole.toUpperCase()}
          </Text>
          {messages.length === 0 ? (
            <Text dimColor>No hay mensajes en este canal todavía.</Text>
          ) : (
            messages.map((m) => (
              <Box key={m.id} flexDirection="column" marginTop={1}>
                <Text bold color={m.fromRole === 'product_owner' ? 'cyan' : 'green'}>
                  [{m.fromRole} → {m.toRole}]:
                </Text>
                <Text>{m.content.slice(0, 260)}{m.content.length > 260 ? '...' : ''}</Text>
              </Box>
            ))
          )}
        </Box>
      </Box>

      {/* Footer Status & Controls */}
      <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text color={busy ? 'yellow' : 'white'}>
          Estado: {busy ? '⏳ Procesando en worker Linux...' : statusLog}
        </Text>
        <Text dimColor>
          Atajos: [1/2/3] Rol | [p] Pedir Arq | [a] Aprobar Arq | [h] Handoff Dev | [d] Implementar | [v] Validar QA | [f] Aceptar Proyecto | [q] Salir
        </Text>
      </Box>
    </Box>
  );
};

