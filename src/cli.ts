#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import path from 'node:path';
import fs from 'node:fs';
import { PoCliDatabase } from './storage/database.js';
import { PoCliOrchestrator } from './runtime/orchestrator.js';
import { CommandCenterApp } from './tui/CommandCenterApp.js';

function enterFullscreenTerminal(): void {
  if (process.stdout.isTTY) {
    // Enter alternate screen buffer, clear screen, move cursor to home (1,1),
    // and enable xterm modifyOtherKeys so Ctrl+Tab sends a distinct escape sequence
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[>4;1m');
  } else {
    process.stdout.write('\x1b[2J\x1b[H');
  }
}

function exitFullscreenTerminal(): void {
  if (process.stdout.isTTY) {
    // Disable modifyOtherKeys and restore primary screen buffer
    process.stdout.write('\x1b[>4;0m\x1b[?1049l');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0] ?? 'tui';

  const dataDir = process.env.POCLI_DATA_DIR ?? path.resolve(process.cwd(), '.pocli-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'pocli.sqlite');

  const storage = new PoCliDatabase(dbPath);
  const orchestrator = new PoCliOrchestrator(storage);

  if (subcommand === 'tui') {
    const projects = storage.listProjects();
    let project = projects[0];
    if (!project) {
      project = orchestrator.createProject({
        name: 'Demo-Service-Linux',
        description: 'Processing service designed and validated with the PO CLI virtual engineering team',
        workspaceDir: path.join(dataDir, 'workspaces', 'demo-service'),
      });
    }

    enterFullscreenTerminal();
    try {
      const { waitUntilExit } = render(
        React.createElement(CommandCenterApp, {
          orchestrator,
          initialProject: project,
        }),
        { exitOnCtrlC: true },
      );
      await waitUntilExit();
    } finally {
      exitFullscreenTerminal();
      orchestrator.rag.stopWatchers();
      storage.close();
    }
    return;
  }

  if (subcommand === 'demo') {
    console.log('=== PO CLI — Full 8-Phase Engineering Workflow Demonstration ===\n');
    const workspaceDir = path.join(dataDir, 'workspaces', `walkthrough-${Date.now()}`);
    const kbDir = path.join(dataDir, 'notebooks', 'clean-architecture');
    fs.mkdirSync(kbDir, { recursive: true });
    fs.writeFileSync(
      path.join(kbDir, 'guidelines.md'),
      `# Hexagonal Architecture Principles\nAll core business logic must reside in pure modules decoupled from infrastructure.\n\n## Output Contract\nDomain functions must return objects with property \`ok: true\` and a validated numeric result.\n`,
      'utf8',
    );

    // 1. Create and index Knowledge Notebook
    const { notebook, indexResult } = orchestrator.createAndIndexNotebook({
      name: `Hexagonal-Architecture-${Date.now()}`,
      description: 'Corporate architecture guidelines and domain contracts',
      dirPath: kbDir,
      allowedRoles: ['architect', 'developer', 'qa'],
    });
    console.log(
      `[Phase 6 / Notebooks] Notebook '${notebook.name}' indexed (${indexResult.totalChunks} chunks).`,
    );

    // 2. Phase 1: Create Project and link Notebook
    const project = orchestrator.createProject({
      name: 'CoreBillingEngine',
      description: 'Billing calculation engine with strict contract validation',
      workspaceDir,
    });
    storage.linkNotebookToProject(project.id, notebook.id);
    console.log(`[Phase 1] Project created: ${project.name} (${project.id}) — Phase: ${project.phase}`);

    // 3. Phase 2: Conversation with the Software Architect
    const archTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Design and propose the hexagonal architecture and requirements for CoreBillingEngine.',
    });
    console.log(
      `[Phase 2] Architect (Worker PID ${archTurn.workerPid}, Modality ${archTurn.modalityUsed}) generated ${archTurn.createdArtifacts.map((a) => a.code).join(', ')}.`,
    );
    console.log(`          RAG citations used: ${archTurn.citations.length}`);

    // 4. Phase 3: Formal Approval by the Product Owner
    const { approval, project: afterApproval } = orchestrator.reviewArchitectureByPo({
      projectId: project.id,
      artifactCode: 'ARCH-001',
      decision: 'APPROVED',
      comments: 'Approved architecture v1 after reviewing contracts and traceability.',
    });
    console.log(
      `[Phase 3] Architecture ${approval.artifactCode} v${approval.artifactVersion} ${approval.decision} by Product Owner — Phase: ${afterApproval.phase}`,
    );

    // 5. Phase 4: Developer Handoff
    const handoff = orchestrator.performDeveloperHandoff(project.id);
    console.log(
      `[Phase 4] Handoff transferred to Developer (ARCH v${handoff.approvedArchitectureVersion}, ${handoff.requirements.length} reqs, ${handoff.specifications.length} specs).`,
    );

    // 6. Phase 5: Implementation and Architectural Consultation
    const consultation = await orchestrator.consultArchitectFromDeveloper({
      projectId: project.id,
      subject: 'Null input validation in executeBusinessLogic',
      ambiguityOrBlocker: 'Should an explicit INVALID_INPUT exception be thrown on null payload?',
      proposedAlternative: 'Throw Error("INVALID_INPUT") while preserving pure signature.',
      impactedArtifacts: ['ARCH-001', 'SPEC-001'],
      requiresPoIntervention: false,
    });
    console.log(
      `[Phase 5] Developer -> Architect consultation resolved: ${consultation.status}`,
    );

    const devTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'developer',
      message: 'Proceed with implementing the module in compliance with the approved architecture.',
    });
    console.log(
      `[Phase 5] Developer (Worker PID ${devTurn.workerPid}) implemented: ${devTurn.createdArtifacts.map((a) => a.code).join(', ')}`,
    );

    // 7. Phase 6: Independent QA Validation
    const qaRes = await orchestrator.submitToQaAndValidate({
      projectId: project.id,
    });
    console.log(
      `[Phase 6] QA Engineer emitted ${qaRes.qaArtifact.code}: ${qaRes.payload.recommendation} (${qaRes.payload.passedTests.length}/${qaRes.payload.executedTests.length} tests passed) — Phase: ${qaRes.project.phase}`,
    );

    // 8. Phase 8: Final Acceptance by the Product Owner
    const completed = orchestrator.acceptProjectByPo({
      projectId: project.id,
      comments: 'Deliverable verified by QA and formally accepted by the Product Owner.',
    });
    console.log(`[Phase 8] Final project state: ${completed.phase}\n`);

    storage.close();
    return;
  }

  console.log(
    [
      'Product Owner CLI (PO CLI) — Available commands:',
      '  npm start / npm run tui Launch the fullscreen Command Center (Ink TUI)',
      '  npx tsx src/cli.ts demo Run a full 8-phase workflow demonstration on Linux',
      '  npm test                Run the integration test suite across all 7 phases',
    ].join('\n'),
  );
  storage.close();
}

main().catch((err) => {
  exitFullscreenTerminal();
  console.error(err);
  process.exit(1);
});
