import readline from 'node:readline';
import { PoCliDatabase } from './database.js';

export type DbOutputFormat = 'table' | 'json' | 'tsv';

export function formatRows(
  rows: Record<string, unknown>[],
  format: DbOutputFormat,
): string {
  if (rows.length === 0) {
    return format === 'json' ? '[]' : '(0 rows)';
  }

  if (format === 'json') {
    return JSON.stringify(rows, null, 2);
  }

  const columns = Object.keys(rows[0]);

  if (format === 'tsv') {
    const header = columns.join('\t');
    const body = rows
      .map((r) =>
        columns
          .map((col) => {
            const val = r[col];
            return val === null || val === undefined
              ? ''
              : String(val).replace(/[\t\r\n]+/g, ' ');
          })
          .join('\t'),
      )
      .join('\n');
    return `${header}\n${body}`;
  }

  // Default 'table' format: aligned ASCII table
  const maxColWidth = 44;
  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col] = col.length;
  }

  const stringifiedRows = rows.map((row) => {
    const mapped: Record<string, string> = {};
    for (const col of columns) {
      const raw = row[col];
      const str =
        raw === null || raw === undefined
          ? 'NULL'
          : typeof raw === 'object'
            ? JSON.stringify(raw)
            : String(raw).replace(/\s+/g, ' ').trim();
      const clipped =
        str.length > maxColWidth ? `${str.slice(0, maxColWidth - 3)}...` : str;
      mapped[col] = clipped;
      if (clipped.length > widths[col]) {
        widths[col] = clipped.length;
      }
    }
    return mapped;
  });

  const sepLine =
    '+-' + columns.map((c) => '-'.repeat(widths[c])).join('-+-') + '-+';
  const headerLine =
    '| ' + columns.map((c) => c.padEnd(widths[c], ' ')).join(' | ') + ' |';
  const bodyLines = stringifiedRows.map(
    (r) =>
      '| ' + columns.map((c) => r[c].padEnd(widths[c], ' ')).join(' | ') + ' |',
  );

  return [
    sepLine,
    headerLine,
    sepLine,
    ...bodyLines,
    sepLine,
    `(${rows.length} row${rows.length === 1 ? '' : 's'})`,
  ].join('\n');
}

export function executeDbCommandOrQuery(
  storage: PoCliDatabase,
  rawInput: string,
  format: DbOutputFormat = 'table',
): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';

  // Handle SQLite-style dot commands (.tables, .schema, .stats, .projects, .experts, .help)
  if (trimmed.startsWith('.')) {
    const parts = trimmed.split(/\s+/);
    const dotCmd = parts[0].toLowerCase();

    if (dotCmd === '.help' || dotCmd === '.h') {
      return [
        'PO CLI Database REPL Commands (OpenCode-inspired `pocli db`):',
        '  .tables              List all tables in pocli.sqlite',
        '  .schema [table]      Show CREATE TABLE schema DDL (all or specific table)',
        '  .stats               Show row counts across all POCLI tables & active settings',
        '  .projects            List all projects with phase, directory & repository count',
        '  .experts             Show the 4 expert SQLite chat summaries & Pi context metrics',
        '  .mode table|json|tsv Switch query output format (current: ' + format + ')',
        '  .quit / .exit / .q   Exit the interactive database REPL',
        '',
        'SQL Query Examples:',
        '  SELECT id, name, phase, workspace_dir FROM projects;',
        '  SELECT expert_role, total_messages, summary_text FROM expert_chat_summaries;',
        '  SELECT id, parent_id, from_role, to_role, token_estimate, compacted_into_id FROM messages;',
        '  SELECT code, type, version, status, author_role FROM artifacts;',
      ].join('\n');
    }

    if (dotCmd === '.tables') {
      const rows = storage.db
        .prepare(
          `SELECT name AS table_name, type
           FROM sqlite_master
           WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
           ORDER BY name ASC`,
        )
        .all() as Record<string, unknown>[];
      return formatRows(rows, format);
    }

    if (dotCmd === '.schema') {
      const targetTable = parts[1];
      const rows = targetTable
        ? (storage.db
            .prepare(
              `SELECT sql FROM sqlite_master WHERE name = ? AND sql IS NOT NULL`,
            )
            .all(targetTable) as Array<{ sql: string }>)
        : (storage.db
            .prepare(
              `SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name ASC`,
            )
            .all() as Array<{ sql: string }>);
      if (rows.length === 0) {
        return targetTable
          ? `No schema found for table '${targetTable}'.`
          : 'No tables found.';
      }
      return rows.map((r) => `${r.sql};`).join('\n\n');
    }

    if (dotCmd === '.stats' || dotCmd === '.status') {
      const tableNames = [
        'projects',
        'project_repositories',
        'sessions',
        'messages',
        'context_compactions',
        'expert_chat_summaries',
        'artifacts',
        'approvals',
        'consultations',
        'qa_reports',
        'pm_inquiries',
        'notebooks',
        'memories',
        'settings',
      ];
      const statsRows: Record<string, unknown>[] = [];
      for (const tbl of tableNames) {
        try {
          const countRow = storage.db
            .prepare(`SELECT COUNT(*) AS count FROM ${tbl}`)
            .get() as { count: number };
          statsRows.push({ table_name: tbl, rows: countRow.count });
        } catch {
          // ignore if virtual/missing
        }
      }
      return formatRows(statsRows, format);
    }

    if (dotCmd === '.projects') {
      const projects = storage.listProjects();
      const activeId = storage.getSettings().activeProjectId;
      const rows = projects.map((p) => ({
        active: p.id === activeId ? '★ ACTIVE' : '',
        id: p.id,
        name: p.name,
        phase: p.phase,
        repos: p.repositories.join(', ') || '(0)',
        workspace_dir: p.workspaceDir,
      }));
      return formatRows(rows, format);
    }

    if (dotCmd === '.experts') {
      const activeProj = storage.getActiveProject();
      if (!activeProj) return 'No active project found.';
      const summaries = storage.listExpertChatSummaries(activeProj.id);
      const rows = summaries.map((s) => ({
        project: activeProj.name,
        expert_role: s.expertRole,
        messages: s.totalMessages,
        active_tokens: s.activeContextTokens,
        saved_tokens: s.savedTokensByCompaction,
        compactions: s.compactionCount,
        summary: s.summaryText,
      }));
      return formatRows(rows, format);
    }

    return `Unknown dot-command: ${dotCmd}. Type .help for available commands.`;
  }

  // Execute standard SQL query
  const stmt = storage.db.prepare(trimmed);
  const isReader = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed);
  if (isReader) {
    const rows = stmt.all() as Record<string, unknown>[];
    return formatRows(rows, format);
  } else {
    const res = stmt.run();
    return `Query OK (changes: ${res.changes}, lastInsertRowid: ${String(res.lastInsertRowid)})`;
  }
}

export async function runInteractiveDbRepl(
  storage: PoCliDatabase,
  dbFilePath: string,
): Promise<void> {
  let currentFormat: DbOutputFormat = 'table';
  const activeProject = storage.getActiveProject();

  console.log(
    [
      '╔══════════════════════════════════════════════════════════════════════╗',
      '║  PO CLI — Interactive SQLite Database REPL (`pocli db`)              ║',
      '╚══════════════════════════════════════════════════════════════════════╝',
      `  Database Path : ${dbFilePath}`,
      `  Work Dir      : ${storage.getSettings().workDir}`,
      `  Active Project: ${activeProject ? `${activeProject.name} (${activeProject.id})` : 'none'}`,
      `  Type .help for commands (.tables, .schema, .stats, .projects, .experts) or any SQL query.`,
      `  Type .quit or .q to exit.\n`,
    ].join('\n'),
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'pocli-db> ',
  });

  rl.prompt();

  return new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        rl.prompt();
        return;
      }

      if (
        trimmed === '.quit' ||
        trimmed === '.exit' ||
        trimmed === '.q' ||
        trimmed === 'exit' ||
        trimmed === 'quit'
      ) {
        rl.close();
        return;
      }

      if (trimmed.toLowerCase().startsWith('.mode')) {
        const requested = trimmed.split(/\s+/)[1]?.toLowerCase();
        if (
          requested === 'table' ||
          requested === 'json' ||
          requested === 'tsv'
        ) {
          currentFormat = requested;
          console.log(`Output mode set to: ${currentFormat}`);
        } else {
          console.log(
            `Current mode: ${currentFormat}. Usage: .mode table | json | tsv`,
          );
        }
        rl.prompt();
        return;
      }

      try {
        const output = executeDbCommandOrQuery(storage, trimmed, currentFormat);
        if (output) console.log(output);
      } catch (err) {
        console.error(`SQL Error: ${(err as Error).message}`);
      }
      rl.prompt();
    });

    rl.on('close', () => {
      resolve();
    });
  });
}

