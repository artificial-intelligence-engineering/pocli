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
  HeadlessCliRunner,
  runVirtualTuiSession,
} from './runtime/headless-runner.js';
import { ActorRole } from './core/contracts.js';
import {
  AVAILABLE_MODELS_CATALOG,
  resolveModelSpec,
} from './runtime/llm-gateway.js';
import { Logger } from './core/logger.js';
import { AuthStorage } from './core/auth.js';
import {
  getModelsCatalogStatus,
  refreshModelsCatalog,
} from './core/models-refresh.js';
import {
  resolveLifecyclePaths,
  uninstallPocli,
  updatePocli,
} from './core/lifecycle.js';
import readline from 'node:readline/promises';
import { CommandCenterApp } from './tui/CommandCenterApp.js';
import { fileURLToPath } from 'node:url';
import { c, formatLogLineForTerminal } from './core/colors.js';

function getCliVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgCandidates = [
      path.resolve(dir, '..', 'package.json'),
      path.resolve(dir, '..', '..', 'package.json'),
    ];
    for (const p of pkgCandidates) {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string };
        if (parsed.version) return parsed.version;
      }
    }
  } catch {}
  return '1.0.0';
}

function printCliHelp(): void {
  console.log(
    [
      c.cyanBold(`Product Owner CLI (pocli v${getCliVersion()}) — Available commands:`),
      `  ${c.cyan('pocli')}                                ${c.dim('Launch fullscreen Ink Command Center TUI')}`,
      `  ${c.cyan('pocli headless exec')} ${c.yellow('"<cmd>"')}        ${c.dim('Execute a slash command or agent prompt headlessly (--isolated, --role)')}`,
      `  ${c.cyan('pocli headless e2e')} ${c.yellow('[--isolated]')}    ${c.dim('Run a full start-to-finish E2E lifecycle (ARQ -> DEV -> QA -> ARQ -> PO)')}`,
      `  ${c.cyan('pocli headless tui-test')} ${c.yellow('[--isolated]')} ${c.dim('Run a scripted virtual-TTY Ink TUI session without blocking stdin')}`,
      `  ${c.cyan('pocli auth')} ${c.yellow('[status|set|remove|path]')} ${c.dim('Manage LLM provider API keys ($HOME/.pocli/auth.json)')}`,
      `  ${c.cyan('pocli models list')}                  ${c.dim('List all available LLM models in catalog')}`,
      `  ${c.cyan('pocli models agents')}                ${c.dim('List active project agents and their configured models')}`,
      `  ${c.cyan('pocli models')} ${c.yellow('<agent> <model>')}       ${c.dim('Assign an LLM model to a role (or all)')}`,
      `  ${c.cyan('pocli models refresh')} ${c.yellow('[--force]')}     ${c.dim('Download latest models.json catalog from GitHub')}`,
      `  ${c.cyan('pocli models status')}                ${c.dim('Show active models catalog source and sync metadata')}`,
      `  ${c.cyan('pocli db')}                           ${c.dim('Open interactive SQLite REPL ($HOME/.pocli/pocli.sqlite)')}`,
      `  ${c.cyan('pocli db path')}                      ${c.dim('Print the active SQLite database file path')}`,
      `  ${c.cyan('pocli db')} ${c.yellow('"<sql>"')} ${c.dim('[--format json]')}   ${c.dim('Execute a SQL query or dot-command (.tables, .stats)')}`,
      `  ${c.cyan('pocli logs')} ${c.yellow('[-n 50|path|clear]')}      ${c.dim('Inspect or clear runtime diagnostic logs ($HOME/.pocli/logs/)')}`,
      `  ${c.cyan('pocli update')} ${c.yellow('[--force]')}             ${c.dim('Update pocli to the latest available release')}`,
      `  ${c.cyan('pocli uninstall')} ${c.yellow('[--purge] [--yes]')}  ${c.dim('Remove pocli binary and app installation')}`,
      `  ${c.cyan('pocli --version | --help')}           ${c.dim('Show version or this help message')}`,
    ].join('\n'),
  );
}

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

  if (subcommand === '--version' || subcommand === '-v') {
    console.log(getCliVersion());
    return;
  }

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printCliHelp();
    return;
  }

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
  //   - `pocli models refresh [--force]` -> downloads latest models.json from GitHub
  //   - `pocli models status` -> prints active catalog source & sync metadata
  //   - `pocli models <agent|all> <provider/model>` -> assigns model to agent in SQLite
  if (subcommand === 'models' || subcommand === 'model') {
    const project = storage.getActiveProject();
    const arg1 = args[1];
    const arg2 = args[2];
    const arg1Lower = arg1?.toLowerCase();

    if (arg1Lower === 'refresh' || arg1Lower === 'update') {
      const force = args.includes('--force') || args.includes('-f');
      console.log(`${c.cyan('↻')} Checking remote models catalog...`);
      try {
        const result = await refreshModelsCatalog({ force });
        storage.syncModelsCatalogFromJson(result.localPath);
        if (result.status === 'up_to_date') {
          console.log(
            `${c.green('✔')} Models catalog is already up to date (${result.total} models, sha256=${result.sha256.slice(0, 8)}).`,
          );
        } else {
          console.log(
            `${c.green('✔')} Models catalog updated (${result.total} models, sha256=${result.sha256.slice(0, 8)}).`,
          );
          console.log(
            `  ${c.dim('Saved to:')} ${result.localPath}`,
          );
          if (result.diff.added.length > 0) {
            console.log(
              `  ${c.green(`+ Added (${result.diff.added.length}):`)} ${result.diff.added.map((m) => `${m.provider}/${m.modelId}`).join(', ')}`,
            );
          }
          if (result.diff.updated.length > 0) {
            console.log(
              `  ${c.yellow(`~ Updated (${result.diff.updated.length}):`)} ${result.diff.updated.map((m) => `${m.provider}/${m.modelId}`).join(', ')}`,
            );
          }
          if (result.diff.removed.length > 0) {
            console.log(
              `  ${c.red(`- Removed (${result.diff.removed.length}):`)} ${result.diff.removed.map((m) => `${m.provider}/${m.modelId}`).join(', ')}`,
            );
          }
        }
      } catch (err) {
        console.error(
          `${c.red('✖')} Failed to refresh models catalog: ${(err as Error).message}`,
        );
        storage.close();
        process.exit(1);
      }
      storage.close();
      return;
    }

    if (arg1Lower === 'status') {
      const status = getModelsCatalogStatus();
      console.log(`\n${c.cyanBold('=== Models Catalog Status ===')}`);
      console.log(`  • Loaded models : ${c.bold(String(status.total))}`);
      console.log(`  • Active source : ${c.cyan(status.sourcePath)}`);
      console.log(`  • Local cache   : ${status.hasLocalCache ? c.green(status.localCachePath) : c.dim(`${status.localCachePath} (not refreshed yet)`)}`);
      if (status.meta) {
        console.log(`  • Remote URL    : ${c.dim(status.meta.sourceUrl)}`);
        console.log(`  • Last updated  : ${status.meta.updatedAt}`);
        console.log(`  • Last checked  : ${status.meta.checkedAt}`);
        console.log(`  • SHA-256       : ${status.meta.sha256.slice(0, 12)}`);
      }
      storage.close();
      return;
    }

    if (arg1 && arg2) {
      const targetRole = arg1.toLowerCase();
      const allowedRoles = ['architect', 'developer', 'pm', 'qa', 'all'];
      if (!allowedRoles.includes(targetRole)) {
        console.error(
          `${c.red('✖')} Invalid agent "${arg1}". Allowed agents: ${allowedRoles.join(', ')}.`,
        );
        storage.close();
        process.exit(1);
      }
      if (!project) {
        console.error(
          c.red('No active project found. Create a project first using "pocli" and "/project".'),
        );
        storage.close();
        process.exit(1);
      }
      const resolved = resolveModelSpec(arg2, { strict: true });
      if (!resolved) {
        console.error(
          `${c.red('✖')} Model "${arg2}" does not exist in the catalog. Run "pocli models list" to see valid models.`,
        );
        storage.close();
        process.exit(1);
      }
      storage.assignModelToRole({
        projectId: project.id,
        role: targetRole as 'pm' | 'architect' | 'developer' | 'qa' | 'all',
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

    if (arg1Lower === 'agents') {
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
      storage.close();
      return;
    }

    if (arg1Lower === 'list' || !arg1) {
      console.log(`\n${c.cyanBold('=== Available Models Catalog (pocli models list / /models) ===')}`);
      for (const m of AVAILABLE_MODELS_CATALOG) {
        console.log(
          `  • ${c.bold((m.provider + '/' + m.modelId).padEnd(36, ' '))} ${m.displayName.padEnd(32, ' ')} ${c.yellow(`[${m.contextWindow} · ${m.recommendedFor}]`)}`,
        );
      }
      storage.close();
      return;
    }

    console.error(`Unknown models subcommand: ${arg1}`);
    console.error('Usage: pocli models [list|agents|refresh|status|<agent> <model>]');
    storage.close();
    process.exit(1);
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

  if (subcommand === 'update') {
    const updateArgs = args.slice(1);
    const force = updateArgs.includes('--force') || updateArgs.includes('-f');
    let targetVersion: string | undefined;
    for (let i = 0; i < updateArgs.length; i += 1) {
      if (
        (updateArgs[i] === '--version' || updateArgs[i] === '-v') &&
        updateArgs[i + 1]
      ) {
        targetVersion = updateArgs[i + 1];
      }
    }
    const currentVersion = getCliVersion();
    console.log(
      `${c.cyan('↻')} Checking for updates (current: v${currentVersion})...`,
    );
    storage.close();
    try {
      const res = await updatePocli({
        currentVersion,
        force,
        targetVersion,
      });
      if (res.status === 'up_to_date') {
        console.log(
          `${c.green('✔')} pocli is already up to date (v${res.currentVersion}).`,
        );
      } else {
        console.log(
          `${c.green('✔')} Updated pocli from v${res.currentVersion} to ${res.tagName}.`,
        );
      }
    } catch (err) {
      console.error(
        `${c.red('✖')} Update failed: ${(err as Error).message}`,
      );
      process.exit(1);
    }
    return;
  }

  if (subcommand === 'uninstall') {
    const uninstallArgs = args.slice(1);
    const purgeData = uninstallArgs.includes('--purge');
    const skipConfirm =
      uninstallArgs.includes('--yes') || uninstallArgs.includes('-y');
    const paths = resolveLifecyclePaths();

    storage.close();

    if (!skipConfirm && process.stdin.isTTY) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const scope = purgeData
          ? `${paths.binPath}, ${paths.appDir}, and ${paths.dataDir} (ALL data/keys/projects)`
          : `${paths.binPath} and ${paths.appDir} (preserving ${paths.dataDir} data)`;
        const answer = await rl.question(
          `Remove ${scope}? [y/N] `,
        );
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log(`${c.yellow('ℹ')} Uninstall cancelled.`);
          return;
        }
      } finally {
        rl.close();
      }
    }

    const res = uninstallPocli({ purgeData, paths });
    if (res.nothingToRemove) {
      console.log(
        `${c.yellow('ℹ')} No pocli installation found at ${paths.binPath} or ${paths.appDir}.`,
      );
      return;
    }
    for (const removed of res.removedPaths) {
      console.log(`${c.green('✔')} Removed ${removed}`);
    }
    if (res.preservedDataDir) {
      console.log(
        `${c.dim('ℹ')} Preserved user data directory: ${res.preservedDataDir} (use --purge to remove everything)`,
      );
    }
    return;
  }

  // Headless CLI commands (`pocli headless exec`, `pocli headless e2e`, `pocli headless tui-test`)
  if (subcommand === 'headless') {
    const headlessAction = args[1]?.toLowerCase();
    if (
      headlessAction !== 'exec' &&
      headlessAction !== 'run' &&
      headlessAction !== 'e2e' &&
      headlessAction !== 'tui-test'
    ) {
      console.error(
        headlessAction
          ? `Unknown headless subcommand: ${headlessAction}`
          : 'Missing headless subcommand.',
      );
      console.error(
        'Usage: pocli headless <exec "<cmd-or-prompt>" | e2e [--isolated] | tui-test [--isolated]>',
      );
      storage.close();
      process.exit(1);
    }

    const restArgs = args.slice(2);
    let isIsolated = false;
    let projectName: string | undefined;
    let workspaceDir: string | undefined;
    let role: ActorRole = 'architect';
    let modelSpec: string | undefined;
    let followHandoffs = true;
    let simulateDefect = false;
    let format: 'text' | 'json' = 'text';
    const promptTokens: string[] = [];

    for (let i = 0; i < restArgs.length; i++) {
      const token = restArgs[i];
      if (token === '--isolated') {
        isIsolated = true;
      } else if ((token === '--project' || token === '-p') && restArgs[i + 1]) {
        projectName = restArgs[++i];
      } else if ((token === '--workspace' || token === '-w') && restArgs[i + 1]) {
        workspaceDir = restArgs[++i];
      } else if ((token === '--role' || token === '-r') && restArgs[i + 1]) {
        const candidate = restArgs[++i].toLowerCase();
        if (
          candidate === 'architect' ||
          candidate === 'developer' ||
          candidate === 'qa' ||
          candidate === 'pm'
        ) {
          role = candidate;
        }
      } else if ((token === '--model' || token === '-m') && restArgs[i + 1]) {
        modelSpec = restArgs[++i];
      } else if (token === '--no-follow') {
        followHandoffs = false;
      } else if (token === '--simulate-defect') {
        simulateDefect = true;
      } else if ((token === '--format' || token === '-f') && restArgs[i + 1]) {
        const fmt = restArgs[++i].toLowerCase();
        if (fmt === 'json' || fmt === 'text') format = fmt;
      } else {
        promptTokens.push(token);
      }
    }

    let isolatedTmpDir: string | undefined;
    let activeStorage = storage;
    let activeOrchestrator = orchestrator;

    if (isIsolated) {
      isolatedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-headless-'));
      activeStorage = new PoCliDatabase(path.join(isolatedTmpDir, 'pocli.sqlite'));
      activeOrchestrator = new PoCliOrchestrator(activeStorage);
      if (!workspaceDir) {
        workspaceDir = path.join(isolatedTmpDir, 'workspace');
      }
    }

    const cleanupHeadless = async () => {
      try {
        activeOrchestrator.rag.stopWatchers();
      } catch {}
      try {
        await activeOrchestrator.stopAllWorkers();
      } catch {}
      try {
        activeStorage.close();
      } catch {}
      if (isIsolated && activeStorage !== storage) {
        try {
          storage.close();
        } catch {}
      }
      if (isolatedTmpDir) {
        try {
          fs.rmSync(isolatedTmpDir, { recursive: true, force: true });
        } catch {}
      }
    };

    try {
      const runner = new HeadlessCliRunner(activeOrchestrator);

      if (headlessAction === 'e2e') {
        const res = await runner.runFullE2eLifecycle({
          projectName: projectName ?? 'HeadlessE2EApp',
          workspaceDir,
          architectPrompt: promptTokens.join(' ').trim() || undefined,
          simulateDefectCycle: simulateDefect,
          useDeterministicModel: !modelSpec,
        });
        if (format === 'json') {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(res.outputText);
        }
        await cleanupHeadless();
        process.exit(res.ok ? 0 : 1);
      }

      if (headlessAction === 'tui-test') {
        const pName = projectName ?? 'VirtualTuiDemo';
        const proj = runner.ensureProject({
          projectName: pName,
          workspaceDir,
          useDeterministicModel: true,
        });
        const tuiRes = await runVirtualTuiSession({
          orchestrator: activeOrchestrator,
          initialProject: proj,
          steps: [
            { input: '/agents architect\r', waitMs: 200 },
            {
              input: 'Design and propose the formal architecture and requirements.\r',
              waitMs: 900,
            },
            {
              input:
                'Procede con la arquitectura propuesta y delega al desarrollador.\r',
              waitMs: 2500,
            },
          ],
        });
        if (format === 'json') {
          console.log(
            JSON.stringify(
              {
                ok: tuiRes.ok,
                framesCount: tuiRes.framesCount,
                finalProject: tuiRes.finalProject,
                lastFrameText: tuiRes.lastFrameText,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(
            [
              `=== PO CLI — VIRTUAL TUI E2E SESSION (${pName}) ===`,
              `Frames Captured : ${tuiRes.framesCount}`,
              `Final Phase     : ${tuiRes.finalProject?.phase ?? 'UNKNOWN'}`,
              `--- Last Rendered TUI Frame ---`,
              tuiRes.lastFrameText,
            ].join('\n'),
          );
        }
        await cleanupHeadless();
        process.exit(tuiRes.ok ? 0 : 1);
      }

      // `pocli exec` / `pocli run`
      const commandOrPrompt = promptTokens.join(' ').trim();
      if (!commandOrPrompt) {
        console.error(
          'Usage: pocli exec [--isolated] [--project <name>] [--role <architect|developer|qa|pm>] "<command-or-prompt>"',
        );
        await cleanupHeadless();
        process.exit(1);
      }
      const res = await runner.executeCommand({
        commandOrPrompt,
        projectName,
        workspaceDir,
        role,
        modelSpec: modelSpec ?? (isIsolated ? 'deterministic/pocli-specialist-v1' : undefined),
        followHandoffs,
      });
      if (format === 'json') {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(res.outputText);
      }
      await cleanupHeadless();
      process.exit(res.ok ? 0 : 1);
    } catch (err) {
      await cleanupHeadless();
      console.error(`Headless execution error: ${(err as Error).message}`);
      process.exit(1);
    }
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

  printCliHelp();
  storage.close();
}

main().catch((err) => {
  exitFullscreenTerminal();
  console.error(err);
  process.exit(1);
});
