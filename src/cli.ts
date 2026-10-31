#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import path from 'node:path';
import fs from 'node:fs';
import { PoCliDatabase } from './storage/database.js';
import { PoCliOrchestrator } from './runtime/orchestrator.js';
import { CommandCenterApp } from './tui/CommandCenterApp.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0] ?? 'help';

  const dataDir = process.env.POCLI_DATA_DIR ?? path.resolve(process.cwd(), '.pocli-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'pocli.sqlite');

  const storage = new PoCliDatabase(dbPath);
  const orchestrator = new PoCliOrchestrator(storage);

  if (subcommand === 'tui') {
    let projects = storage.listProjects();
    let project = projects[0];
    if (!project) {
      project = orchestrator.createProject({
        name: 'Demo-Service-Linux',
        description: 'Servicio de procesamiento diseñado y validado con el equipo virtual de PO CLI',
        workspaceDir: path.join(dataDir, 'workspaces', 'demo-service'),
      });
    }
    const { waitUntilExit } = render(
      React.createElement(CommandCenterApp, {
        orchestrator,
        initialProject: project,
      }),
    );
    await waitUntilExit();
    orchestrator.rag.stopWatchers();
    storage.close();
    return;
  }

  if (subcommand === 'demo') {
    console.log('=== PO CLI — Ejecución Demostrativa del Workflow Completo (8 Fases) ===\n');
    const workspaceDir = path.join(dataDir, 'workspaces', `walkthrough-${Date.now()}`);
    const kbDir = path.join(dataDir, 'notebooks', 'arquitectura-clean');
    fs.mkdirSync(kbDir, { recursive: true });
    fs.writeFileSync(
      path.join(kbDir, 'guidelines.md'),
      `# Principios de Arquitectura Hexagonal\nToda lógica de negocio debe residir en módulos puros desacoplados de la infraestructura.\n\n## Contrato de Salida\nLas funciones del dominio deben retornar objetos con propiedad \`ok: true\` y resultado numérico validado.\n`,
      'utf8',
    );

    // 1. Crear e indexar Notebook de Conocimiento
    const { notebook, indexResult } = orchestrator.createAndIndexNotebook({
      name: `Arquitectura-Hexagonal-${Date.now()}`,
      description: 'Guía corporativa de arquitectura y contratos de dominio',
      dirPath: kbDir,
      allowedRoles: ['architect', 'developer', 'qa'],
    });
    console.log(
      `[Fase 6 / Notebooks] Notebook '${notebook.name}' indexado (${indexResult.totalChunks} chunks).`,
    );

    // 2. Fase 1: Crear Proyecto y vincular Notebook
    const project = orchestrator.createProject({
      name: 'CoreBillingEngine',
      description: 'Motor de cálculo de facturación con validación estricta',
      workspaceDir,
    });
    storage.linkNotebookToProject(project.id, notebook.id);
    console.log(`[Fase 1] Proyecto creado: ${project.name} (${project.id}) — Fase: ${project.phase}`);

    // 3. Fase 2: Conversación con el Arquitecto
    const archTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Diseña y propón la arquitectura hexagonal y requisitos para CoreBillingEngine.',
    });
    console.log(
      `[Fase 2] Arquitecto (Worker PID ${archTurn.workerPid}, Modalidad ${archTurn.modalityUsed}) generó ${archTurn.createdArtifacts.map((a) => a.code).join(', ')}.`,
    );
    console.log(`         Citas RAG utilizadas: ${archTurn.citations.length}`);

    // 4. Fase 3: Aprobación formal del Product Owner
    const { approval, project: afterApproval } = orchestrator.reviewArchitectureByPo({
      projectId: project.id,
      artifactCode: 'ARCH-001',
      decision: 'APPROVED',
      comments: 'Aprobada la arquitectura v1 tras revisar contratos y trazabilidad.',
    });
    console.log(
      `[Fase 3] Arquitectura ${approval.artifactCode} v${approval.artifactVersion} ${approval.decision} por Product Owner — Fase: ${afterApproval.phase}`,
    );

    // 5. Fase 4: Handoff al Desarrollador
    const handoff = orchestrator.performDeveloperHandoff(project.id);
    console.log(
      `[Fase 4] Handoff transferido al Desarrollador (ARCH v${handoff.approvedArchitectureVersion}, ${handoff.requirements.length} reqs, ${handoff.specifications.length} specs).`,
    );

    // 6. Fase 5: Implementación y Consulta Arquitectónica
    const consultation = await orchestrator.consultArchitectFromDeveloper({
      projectId: project.id,
      subject: 'Validación de entradas nulas en executeBusinessLogic',
      ambiguityOrBlocker: '¿Se debe lanzar excepción explícita INVALID_INPUT ante payload nulo?',
      proposedAlternative: 'Lanzar Error("INVALID_INPUT") manteniendo firma pura.',
      impactedArtifacts: ['ARCH-001', 'SPEC-001'],
      requiresPoIntervention: false,
    });
    console.log(
      `[Fase 5] Consulta Desarrollador -> Arquitecto resuelta: ${consultation.status}`,
    );

    const devTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'developer',
      message: 'Procede con la implementación del módulo conforme a la arquitectura aprobada.',
    });
    console.log(
      `[Fase 5] Desarrollador (Worker PID ${devTurn.workerPid}) implementó: ${devTurn.createdArtifacts.map((a) => a.code).join(', ')}`,
    );

    // 7. Fase 6: Validación Independiente de QA
    const qaRes = await orchestrator.submitToQaAndValidate({
      projectId: project.id,
    });
    console.log(
      `[Fase 6] Ingeniero de QA emitió ${qaRes.qaArtifact.code}: ${qaRes.payload.recommendation} (${qaRes.payload.passedTests.length}/${qaRes.payload.executedTests.length} pruebas superadas) — Fase: ${qaRes.project.phase}`,
    );

    // 8. Fase 8: Aceptación Final del Product Owner
    const completed = orchestrator.acceptProjectByPo({
      projectId: project.id,
      comments: 'Entrega verificada por QA y aceptada formalmente por el Product Owner.',
    });
    console.log(`[Fase 8] Estado final del proyecto: ${completed.phase}\n`);

    storage.close();
    return;
  }

  console.log(
    [
      'Product Owner CLI (PO CLI) — Comandos disponibles:',
      '  npm run tui            Inicia el Centro de Mando interactivo en terminal (Ink TUI)',
      '  npx tsx src/cli.ts demo Ejecuta una demostración completa de las 8 fases en Linux',
      '  npm test               Ejecuta la suite de pruebas de integración de las 7 fases',
    ].join('\n'),
  );
  storage.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

