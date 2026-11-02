#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveDefaultWorkDir } from './core/i18n.js';
import { PoCliDatabase } from './storage/database.js';
import {
  DbOutputFormat,
  executeDbCommandOrQuery,
  runInteractiveDbRepl,
} from './storage/db-repl.js';
import { PoCliOrchestrator } from './runtime/orchestrator.js';
import {
  AVAILABLE_MODELS_CATALOG,
  resolveModelSpec,
} from './runtime/llm-gateway.js';
import { Logger } from './core/logger.js';
import { AuthStorage } from './core/auth.js';
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

  // OpenCode-style `pocli models` command:
  //   - `pocli models` -> lists per-agent configured models + available models catalog
  //   - `pocli models <agent|all> <provider/model>` -> assigns model to agent in SQLite
  if (subcommand === 'models' || subcommand === 'model') {
    let project = storage.getActiveProject();
    if (!project) {
      project = orchestrator.createProject({
        name: 'Demo-Service-Linux',
        description:
          'Processing service designed and validated with the PO CLI virtual engineering team',
        workspaceDir: path.join(centralWorkDir, 'workspaces', 'demo-service'),
      });
    }

    const arg1 = args[1];
    const arg2 = args[2];
    if (arg1 && arg2) {
      const resolved = resolveModelSpec(arg2);
      if (!resolved) {
        console.error(`Model "${arg2}" not found.`);
        storage.close();
        process.exit(1);
      }
      const targetRole = arg1.toLowerCase();
      storage.assignModelToRole({
        projectId: project.id,
        role: targetRole,
        provider: resolved.provider,
        modelId: resolved.modelId,
        temperature: resolved.defaultTemperature,
      });
      console.log(
        `✔ Assigned ${resolved.provider}/${resolved.modelId} to ${targetRole} in project "${project.name}".`,
      );
      storage.close();
      return;
    }

    const roleConfigs = storage.listRoleConfigs(project.id);
    console.log(
      `\n=== Active Project "${project.name}" — Per-Agent Model Assignments ===`,
    );
    for (const rc of roleConfigs) {
      console.log(
        `  • ${rc.role.padEnd(12, ' ')} -> ${rc.provider}/${rc.modelId} (temp=${rc.temperature}, mode=${rc.executionModality})`,
      );
    }
    console.log(`\n=== Available Models Catalog (pocli models / /models) ===`);
    for (const m of AVAILABLE_MODELS_CATALOG) {
      console.log(
        `  • ${(m.provider + '/' + m.modelId).padEnd(36, ' ')} ${m.displayName.padEnd(32, ' ')} [${m.contextWindow} · ${m.recommendedFor}]`,
      );
    }
    storage.close();
    return;
  }

  // OpenCode-style `pocli logs` command:
  //   - `pocli logs` -> prints the last 50 lines of logs
  //   - `pocli logs -n <num>` -> prints the last <num> lines
  //   - `pocli logs path` -> prints path to the active log file ($HOME/.pocli/logs/pocli.log)
  //   - `pocli logs clear` / `pocli logs -c` -> clears the log file
  if (subcommand === 'logs' || subcommand === 'log') {
    const logArgs = args.slice(1);
    if (logArgs[0] === 'path') {
      console.log(Logger.getLogFilePath());
      storage.close();
      return;
    }
    if (
      logArgs[0] === 'clear' ||
      logArgs[0] === '-c' ||
      logArgs[0] === '--clear'
    ) {
      Logger.clear();
      console.log('✔ Logs cleared.');
      storage.close();
      return;
    }

    let count = 50;
    const nIdx = logArgs.indexOf('-n');
    if (nIdx !== -1 && logArgs[nIdx + 1]) {
      const parsed = parseInt(logArgs[nIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0) count = parsed;
    }

    const lines = Logger.getRecentLines(count);
    if (lines.length === 0) {
      console.log(`(No logs found at ${Logger.getLogFilePath()})`);
    } else {
      console.log(`=== Last ${lines.length} log lines (${Logger.getLogFilePath()}) ===\n`);
      for (const line of lines) {
        console.log(line);
      }
    }
    storage.close();
    return;
  }

  // OpenCode & Pi-style `pocli auth` command:
  //   - `pocli auth` / `pocli auth status` -> lists configured provider keys & sources
  //   - `pocli auth set <provider> <key>` -> saves key to ~/.pocli/auth.json (mode 0600)
  //   - `pocli auth remove <provider>` -> deletes key from auth.json
  //   - `pocli auth path` -> prints path to auth.json
  if (subcommand === 'auth') {
    const authArgs = args.slice(1);
    const action = authArgs[0] ?? 'status';

    if (action === 'path') {
      console.log(AuthStorage.getAuthFilePath());
      storage.close();
      return;
    }

    if (action === 'set') {
      const provider = authArgs[1];
      const key = authArgs[2];
      if (!provider || !key) {
        console.error('Usage: pocli auth set <provider> <api-key>');
        console.error('Supported providers: anthropic, openai, gemini, groq, openrouter, cerebras, opencode (zen)');
        storage.close();
        process.exit(1);
      }
      try {
        AuthStorage.setApiKey(provider, key);
        console.log(`✔ API key for '${provider.toLowerCase()}' securely saved to ${AuthStorage.getAuthFilePath()} (mode 0600).`);
      } catch (err) {
        console.error(`Error saving API key: ${(err as Error).message}`);
        storage.close();
        process.exit(1);
      }
      storage.close();
      return;
    }

    if (action === 'remove' || action === 'delete' || action === 'logout') {
      const provider = authArgs[1];
      if (!provider) {
        console.error('Usage: pocli auth remove <provider>');
        storage.close();
        process.exit(1);
      }
      const removed = AuthStorage.removeApiKey(provider);
      if (removed) {
        console.log(`✔ Removed persisted API key for '${provider.toLowerCase()}'.`);
      } else {
        console.log(`ℹ No persisted API key found for '${provider.toLowerCase()}' in ${AuthStorage.getAuthFilePath()}.`);
      }
      storage.close();
      return;
    }

    if (action === 'status' || action === 'list') {
      const providers = AuthStorage.listProviders();
      console.log(`\n=== PO CLI — LLM Provider Authentication Status (${AuthStorage.getAuthFilePath()}) ===\n`);
      for (const p of providers) {
        const idCol = p.id.padEnd(12, ' ');
        const nameCol = p.name.padEnd(30, ' ');
        if (p.status === 'CONFIGURED') {
          const sourceTag = p.source === 'env' ? `(env: ${p.envVar})` : `(file: ${AuthStorage.getAuthFilePath().replace(os.homedir(), '~')})`;
          console.log(`  • ${idCol} ${nameCol} [CONFIGURED]     ${p.maskedKey} ${sourceTag}`);
        } else {
          console.log(`  • ${idCol} ${nameCol} [NOT CONFIGURED] (env: ${p.envVar})`);
        }
      }
      console.log('\nCommands:');
      console.log('  pocli auth set <provider> <key>    Save API key securely to disk');
      console.log('  pocli auth remove <provider>       Remove persisted API key');
      console.log('  pocli auth path                    Print credentials file path');
      storage.close();
      return;
    }

    console.error(`Unknown auth action: ${action}`);
    console.error('Usage: pocli auth [status|set|remove|path]');
    storage.close();
    process.exit(1);
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
      '  pocli auth [status|set|remove|path] Manage LLM provider API keys ($HOME/.pocli/auth.json)',
      '  pocli models [agent] [model]        List or assign LLM models for roles',
      '  pocli db                            Open interactive SQLite REPL ($HOME/.pocli/pocli.sqlite)',
      '  pocli db path                       Print the active SQLite database file path',
      '  pocli db "<sql>" [--format json]    Execute a SQL query or dot-command (.tables, .stats)',
      '  pocli logs [-n 50|path|clear]       Inspect or clear runtime diagnostic logs ($HOME/.pocli/logs/)',
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
