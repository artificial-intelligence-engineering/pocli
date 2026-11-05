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
import { c, formatLogLineForTerminal } from './core/colors.js';

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
    // Reset OSC background/foreground colors, disable modifyOtherKeys, and restore primary screen buffer
    process.stdout.write('\x1b]111\x07\x1b]110\x07\x1b[>4;0m\x1b[?1049l');
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
    const project = storage.getActiveProject();
    const arg1 = args[1];
    const arg2 = args[2];
    if (arg1 && arg2) {
      if (!project) {
        console.error(
          c.red('No active project found. Create a project first using "pocli" and "/project".'),
        );
        storage.close();
        process.exit(1);
      }
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
        `${c.green('✔')} Assigned ${c.cyanBold(`${resolved.provider}/${resolved.modelId}`)} to ${c.bold(targetRole)} in project "${project.name}".`,
      );
      storage.close();
      return;
    }

    if (project) {
      const roleConfigs = storage.listRoleConfigs(project.id);
      console.log(
        `\n${c.cyanBold(`=== Active Project "${project.name}" — Per-Agent Model Assignments ===`)}`,
      );
      for (const rc of roleConfigs) {
        console.log(
          `  • ${c.cyanBold(rc.role.padEnd(12, ' '))} -> ${c.green(`${rc.provider}/${rc.modelId}`)} ${c.dim(`(temp=${rc.temperature}, mode=${rc.executionModality})`)}`,
        );
      }
    } else {
      console.log(
        `\n${c.yellow('No active project found.')} ${c.dim('Run "pocli" to create or select a project.')}`,
      );
    }
    console.log(`\n${c.cyanBold('=== Available Models Catalog (pocli models / /models) ===')}`);
    for (const m of AVAILABLE_MODELS_CATALOG) {
      console.log(
        `  • ${c.bold((m.provider + '/' + m.modelId).padEnd(36, ' '))} ${m.displayName.padEnd(32, ' ')} ${c.yellow(`[${m.contextWindow} · ${m.recommendedFor}]`)}`,
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
      console.log(`${c.green('✔')} Logs cleared.`);
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
      console.log(c.dim(`(No logs found at ${Logger.getLogFilePath()})`));
    } else {
      console.log(
        `\n${c.cyanBold(`=== Last ${lines.length} log lines`)} ${c.dim(`(${Logger.getLogFilePath()})`)} ${c.cyanBold('===')}\n`,
      );
      for (const line of lines) {
        console.log(formatLogLineForTerminal(line));
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
        console.log(`${c.green('✔')} API key for '${c.bold(provider.toLowerCase())}' securely saved to ${AuthStorage.getAuthFilePath()} (mode 0600).`);
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
        console.log(`${c.green('✔')} Removed persisted API key for '${c.bold(provider.toLowerCase())}'.`);
      } else {
        console.log(`${c.yellow('ℹ')} No persisted API key found for '${c.bold(provider.toLowerCase())}' in ${AuthStorage.getAuthFilePath()}.`);
      }
      storage.close();
      return;
    }

    if (action === 'status' || action === 'list') {
      const providers = AuthStorage.listProviders();
      console.log(
        `\n${c.cyanBold('=== PO CLI — LLM Provider Authentication Status ===')} ${c.dim(`(${AuthStorage.getAuthFilePath()})`)}\n`,
      );
      for (const p of providers) {
        const idCol = p.id.padEnd(12, ' ');
        const nameCol = p.name.padEnd(30, ' ');
        if (p.status === 'CONFIGURED') {
          const sourceTag = p.source === 'env' ? `(env: ${p.envVar})` : `(file: ${AuthStorage.getAuthFilePath().replace(os.homedir(), '~')})`;
          console.log(`  • ${c.bold(idCol)} ${nameCol} ${c.greenBold('✔ [CONFIGURED]')}     ${c.cyan(p.maskedKey)} ${c.dim(sourceTag)}`);
        } else {
          console.log(`  • ${c.bold(idCol)} ${nameCol} ${c.gray('✖ [NOT CONFIGURED]')} ${c.dim(`(env: ${p.envVar})`)}`);
        }
      }
      console.log(`\n${c.bold('Commands:')}`);
      console.log(`  ${c.cyan('pocli auth set')} ${c.yellow('<provider> <key>')}    Save API key securely to disk`);
      console.log(`  ${c.cyan('pocli auth remove')} ${c.yellow('<provider>')}       Remove persisted API key`);
      console.log(`  ${c.cyan('pocli auth path')}                    Print credentials file path`);
      storage.close();
      return;
    }

    console.error(`Unknown auth action: ${action}`);
    console.error('Usage: pocli auth [status|set|remove|path]');
    storage.close();
    process.exit(1);
  }

  if (subcommand === 'tui' || subcommand === 'pocli') {
    const project = storage.getActiveProject() || null;

    enterFullscreenTerminal();

    let isCleaningUp = false;
    const cleanupAndExit = async (code = 0) => {
      if (isCleaningUp) return;
      isCleaningUp = true;
      exitFullscreenTerminal();
      try {
        orchestrator.rag.stopWatchers();
      } catch {}
      try {
        await orchestrator.stopAllWorkers();
      } catch {}
      try {
        storage.close();
      } catch {}
      process.exit(code);
    };

    process.once('SIGINT', () => void cleanupAndExit(0));
    process.once('SIGTERM', () => void cleanupAndExit(0));

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
      await cleanupAndExit(0);
    }
    return;
  }

  console.log(
    [
      c.cyanBold('Product Owner CLI (pocli) — Available commands:'),
      `  ${c.cyan('pocli auth')} ${c.yellow('[status|set|remove|path]')} ${c.dim('Manage LLM provider API keys ($HOME/.pocli/auth.json)')}`,
      `  ${c.cyan('pocli models')} ${c.yellow('[agent] [model]')}        ${c.dim('List or assign LLM models for roles')}`,
      `  ${c.cyan('pocli db')}                            ${c.dim('Open interactive SQLite REPL ($HOME/.pocli/pocli.sqlite)')}`,
      `  ${c.cyan('pocli db path')}                       ${c.dim('Print the active SQLite database file path')}`,
      `  ${c.cyan('pocli db')} ${c.yellow('"<sql>"')} ${c.dim('[--format json]')}    ${c.dim('Execute a SQL query or dot-command (.tables, .stats)')}`,
      `  ${c.cyan('pocli logs')} ${c.yellow('[-n 50|path|clear]')}       ${c.dim('Inspect or clear runtime diagnostic logs ($HOME/.pocli/logs/)')}`,
    ].join('\n'),
  );
  storage.close();
}

main().catch((err) => {
  exitFullscreenTerminal();
  console.error(err);
  process.exit(1);
});
