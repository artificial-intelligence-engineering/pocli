#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import path from 'node:path';
import fs from 'node:fs';
import { resolveDefaultWorkDir } from './core/i18n.js';
import { PoCliDatabase } from './storage/database.js';
import {
  DbOutputFormat,
  executeDbCommandOrQuery,
  runInteractiveDbRepl,
} from './storage/db-repl.js';
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

  // Central CLI folder defaults to $HOME/.pocli/ so pocli can run from anywhere
  const dataDir = resolveDefaultWorkDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'pocli.sqlite');

  const storage = new PoCliDatabase(dbPath);
  const orchestrator = new PoCliOrchestrator(storage);
  const centralWorkDir = storage.getSettings().workDir;

  // OpenCode-style `pocli db` command:
  //   - `pocli db` -> opens interactive SQLite REPL
  //   - `pocli db path` -> prints active SQLite database path ($HOME/.pocli/pocli.sqlite)
  //   - `pocli db "<sql-or-dot-cmd>" [--format table|json|tsv]` -> runs one-shot query
  if (subcommand === 'db') {
    const dbArgs = args.slice(1);
    if (dbArgs[0] === 'path') {
      console.log(dbPath);
      storage.close();
      return;
    }

    let format: DbOutputFormat = 'table';
    const queryParts: string[] = [];
    for (let i = 0; i < dbArgs.length; i++) {
      const token = dbArgs[i];
      if ((token === '--format' || token === '-f') && dbArgs[i + 1]) {
        const fmt = dbArgs[i + 1].toLowerCase();
        if (fmt === 'table' || fmt === 'json' || fmt === 'tsv') {
          format = fmt;
        }
        i++;
      } else if (token.startsWith('--format=')) {
        const fmt = token.split('=')[1]?.toLowerCase();
        if (fmt === 'table' || fmt === 'json' || fmt === 'tsv') {
          format = fmt;
        }
      } else {
        queryParts.push(token);
      }
    }

    const inlineQuery = queryParts.join(' ').trim();
    if (inlineQuery.length > 0) {
      try {
        const out = executeDbCommandOrQuery(storage, inlineQuery, format);
        if (out) console.log(out);
      } catch (err) {
        console.error(`SQL Error: ${(err as Error).message}`);
        storage.close();
        process.exit(1);
      }
      storage.close();
      return;
    }

    try {
      await runInteractiveDbRepl(storage, dbPath);
    } finally {
      storage.close();
    }
    return;
  }

  if (subcommand === 'tui' || subcommand === 'pocli') {
    let project = storage.getActiveProject();
    if (!project) {
      project = orchestrator.createProject({
        name: 'Demo-Service-Linux',
        description: 'Processing service designed and validated with the PO CLI virtual engineering team',
        workspaceDir: path.join(centralWorkDir, 'workspaces', 'demo-service'),
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
    const workspaceDir = path.join(centralWorkDir, 'workspaces', `walkthrough-${Date.now()}`);
    const kbDir = path.join(centralWorkDir, 'notebooks', 'clean-architecture');
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
      'Product Owner CLI (pocli) — Available commands:',
      '  pocli / npm run pocli               Launch the fullscreen Command Center (Ink TUI)',
      '  pocli db                            Open interactive SQLite REPL ($HOME/.pocli/pocli.sqlite)',
      '  pocli db path                       Print the active SQLite database file path',
      '  pocli db "<sql>" [--format json]    Execute a SQL query or dot-command (.tables, .stats)',
      '  pocli demo                          Run a full 8-phase workflow demonstration on Linux',
      '  npm test                            Run the integration test suite',
    ].join('\n'),
  );
  storage.close();
}

main().catch((err) => {
  exitFullscreenTerminal();
  console.error(err);
  process.exit(1);
});
