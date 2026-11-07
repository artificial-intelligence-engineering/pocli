import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  ActorRole,
  ApprovalRecord,
  ArchitecturalConsultation,
  Artifact,
  ArtifactStatus,
  ArtifactType,
  ConsultationStatus,
  CoordinatorAuditLogEntry,
  ExecutionModality,
  InterAgentMessage,
  InterAgentMessageType,
  LlmProviderType,
  MemoryEntry,
  MemoryLayer,
  Notebook,
  PmConsolidationReport,
  Project,
  QaReportPayload,
  RagCitation,
  RoleModelConfig,
  StaleArtifactVersionError,
  WorkerStatusInfo,
  WorkflowPhase,
} from '../core/contracts.js';
import {
  AppSettings,
  resolveDefaultWorkDir,
  SupportedLanguage,
  SupportedTheme,
} from '../core/i18n.js';
import { AuthorityGuard } from '../core/workflow.js';

export interface StoredModelCatalogEntry {
  provider: LlmProviderType;
  vendor: string;
  providerLabel: string;
  modelId: string;
  displayName: string;
  isFree: boolean;
  contextWindow: string;
  recommendedFor: string;
  defaultTemperature: number;
}

export interface StoredMessage {
  id: string;
  projectId: string;
  sessionId: string;
  parentId?: string;
  fromRole: ActorRole;
  toRole: ActorRole;
  content: string;
  tokenEstimate: number;
  compactedIntoId?: string;
  metadataJson: string;
  createdAt: string;
}

export interface CompactionCheckpoint {
  id: string;
  projectId: string;
  expertRole: ActorRole;
  upToMessageId: string;
  compactedMessageCount: number;
  tokensBefore: number;
  tokensAfter: number;
  structuredSummary: string;
  createdAt: string;
}

export interface AssembledContextWindow {
  projectId: string;
  expertRole: ActorRole;
  normativePrefix: string;
  persistentMemoryBlock: string;
  compactionCheckpointBlock: string;
  activeRecentMessages: StoredMessage[];
  activeTokens: number;
  savedTokensByCompaction: number;
  compactionCount: number;
  formattedPromptContext: string;
}

export interface ExpertChatExchangeSnippet {
  fromRole: ActorRole;
  toRole: ActorRole;
  snippet: string;
  createdAt: string;
}

export interface ExpertInteractions {
  po: number;
  pm: number;
  architect: number;
  developer: number;
  qa: number;
  [key: string]: number;
}

export interface ExpertChatSummary {
  projectId: string;
  expertRole: ActorRole;
  totalMessages: number;
  activeContextTokens: number;
  savedTokensByCompaction: number;
  compactionCount: number;
  lastUserPrompt: string;
  lastExpertReply: string;
  summaryText: string;
  recentExchanges: ExpertChatExchangeSnippet[];
  updatedAt: string;
  interactions: ExpertInteractions;
}

export class PoCliDatabase {
  public readonly db: DatabaseSync;
  public readonly defaultWorkDir: string;

  constructor(dbFilePath: string) {
    const dir = path.dirname(dbFilePath);
    if (dbFilePath !== ':memory:' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.defaultWorkDir =
      dbFilePath !== ':memory:'
        ? path.resolve(dir)
        : resolveDefaultWorkDir();
    this.db = new DatabaseSync(dbFilePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
    this.ensureWorkDirStructure(this.getSettings().workDir);
  }

  public ensureWorkDirStructure(workDir: string): void {
    const resolved = path.resolve(workDir);
    fs.mkdirSync(path.join(resolved, 'config'), { recursive: true });
    fs.mkdirSync(path.join(resolved, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(resolved, 'workspaces'), { recursive: true });
  }

  public ensureProjectArtifactsStructure(workspaceDir: string): void {
    fs.mkdirSync(path.join(workspaceDir, 'contracts', 'architecture'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'contracts', 'specification'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'contracts', 'implementation'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'deliveries'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'outputs'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'repos'), { recursive: true });
  }

  private syncSettingsFiles(settings: AppSettings): void {
    const payload = JSON.stringify(settings, null, 2);
    const targetDirs = new Set<string>([
      path.resolve(this.defaultWorkDir),
      path.resolve(settings.workDir),
    ]);
    for (const dir of targetDirs) {
      this.ensureWorkDirStructure(dir);
      fs.writeFileSync(
        path.join(dir, 'config', 'settings.json'),
        payload,
        'utf8',
      );
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        phase TEXT NOT NULL,
        approved_architecture_version INTEGER NOT NULL DEFAULT 0,
        correction_cycle_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        participant_a TEXT NOT NULL,
        participant_b TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_id TEXT,
        from_role TEXT NOT NULL,
        to_role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        compacted_into_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS context_compactions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        expert_role TEXT NOT NULL,
        up_to_message_id TEXT NOT NULL,
        compacted_message_count INTEGER NOT NULL,
        tokens_before INTEGER NOT NULL,
        tokens_after INTEGER NOT NULL,
        structured_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        code TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        author_role TEXT NOT NULL,
        file_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        traces_to_json TEXT NOT NULL DEFAULT '[]',
        citations_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_code TEXT NOT NULL,
        artifact_version INTEGER NOT NULL,
        approver_role TEXT NOT NULL,
        decision TEXT NOT NULL,
        comments TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS consultations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        from_role TEXT NOT NULL,
        to_role TEXT NOT NULL,
        subject TEXT NOT NULL,
        ambiguity_or_blocker TEXT NOT NULL,
        proposed_alternative TEXT NOT NULL,
        impacted_artifacts_json TEXT NOT NULL DEFAULT '[]',
        requires_po_intervention INTEGER NOT NULL DEFAULT 0,
        architect_assessment TEXT,
        po_decision_notes TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS qa_reports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS notebooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        dir_path TEXT NOT NULL,
        is_global INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        allowed_roles_json TEXT NOT NULL DEFAULT '["architect","developer","qa"]',
        external_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_notebooks (
        project_id TEXT NOT NULL,
        notebook_id TEXT NOT NULL,
        PRIMARY KEY (project_id, notebook_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS notebook_files (
        notebook_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (notebook_id, file_path),
        FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS notebook_chunks (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL,
        notebook_name TEXT NOT NULL,
        document_path TEXT NOT NULL,
        section TEXT NOT NULL,
        line_range TEXT NOT NULL,
        external_ref TEXT,
        content TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS notebook_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        notebook_id UNINDEXED,
        section,
        content
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        layer TEXT NOT NULL,
        agent_role TEXT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS role_configs (
        project_id TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        temperature REAL NOT NULL DEFAULT 0.2,
        execution_modality TEXT NOT NULL DEFAULT 'LOCAL_PROCESS',
        PRIMARY KEY (project_id, role),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS expert_chat_summaries (
        project_id TEXT NOT NULL,
        expert_role TEXT NOT NULL,
        total_messages INTEGER NOT NULL DEFAULT 0,
        last_user_prompt TEXT NOT NULL DEFAULT '',
        last_expert_reply TEXT NOT NULL DEFAULT '',
        summary_text TEXT NOT NULL DEFAULT '',
        recent_exchanges_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, expert_role),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pm_inquiries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        modality TEXT NOT NULL,
        consulted_agents_json TEXT NOT NULL,
        individual_responses_json TEXT NOT NULL,
        discrepancies_json TEXT NOT NULL,
        consolidated_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project_repositories (
        project_id TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        PRIMARY KEY (project_id, repo_path),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS models_catalog (
        model_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        vendor TEXT NOT NULL,
        provider_label TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_free INTEGER NOT NULL DEFAULT 0,
        context_window TEXT NOT NULL DEFAULT '128K',
        recommended_for TEXT NOT NULL DEFAULT '',
        default_temperature REAL NOT NULL DEFAULT 0.2,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS coordinator_audit_log (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_role TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        action TEXT NOT NULL,
        request_id TEXT,
        status TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS inter_agent_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        request_id TEXT,
        from_role TEXT NOT NULL,
        to_role TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'DELIVERED',
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS coordinator_idempotency (
        request_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_role TEXT NOT NULL,
        action TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED,
        project_id UNINDEXED,
        layer UNINDEXED,
        agent_role UNINDEXED,
        key,
        value
      );
    `);

    // Migrate any legacy deterministic role_configs to canonical vendor/model IDs
    this.db.exec(`
      UPDATE role_configs
      SET provider = 'anthropic', model_id = 'claude-3-7-sonnet'
      WHERE provider = 'deterministic' AND model_id LIKE 'claude%';

      UPDATE role_configs
      SET provider = 'openai', model_id = 'gpt-4o'
      WHERE provider = 'deterministic' AND model_id LIKE 'gpt%';

      UPDATE role_configs
      SET provider = 'gemini', model_id = 'gemini-2.5-pro'
      WHERE provider = 'deterministic' AND model_id LIKE 'gemini%';
    `);

    // Ensure backward-compatible schema migration for existing SQLite databases
    const msgCols = this.db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(msgCols.map((c) => c.name));
    if (!colNames.has('parent_id')) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN parent_id TEXT;`);
    }
    if (!colNames.has('token_estimate')) {
      this.db.exec(
        `ALTER TABLE messages ADD COLUMN token_estimate INTEGER NOT NULL DEFAULT 0;`,
      );
    }
    if (!colNames.has('compacted_into_id')) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN compacted_into_id TEXT;`);
    }

    // Seed or synchronize models_catalog table from data/models.json or defaults
    this.syncModelsCatalogFromJson();
  }

  // ==========================================================================
  // MODELS CATALOG STORAGE & JSON SYNC
  // ==========================================================================

  public syncModelsCatalogFromJson(customJsonPath?: string): StoredModelCatalogEntry[] {
    const candidates = [
      customJsonPath,
      path.resolve(process.cwd(), 'data', 'models.json'),
      path.resolve(this.defaultWorkDir, 'models.json'),
      path.resolve(__dirname, '..', '..', 'data', 'models.json'),
      path.resolve(__dirname, '..', 'data', 'models.json'),
    ].filter(Boolean) as string[];

    let jsonModels: StoredModelCatalogEntry[] = [];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            jsonModels = parsed;
            break;
          }
        } catch {
          // Continue to next candidate
        }
      }
    }

    if (jsonModels.length > 0) {
      const now = new Date().toISOString();
      const insert = this.db.prepare(`
        INSERT INTO models_catalog (
          model_id, provider, vendor, provider_label, display_name,
          is_free, context_window, recommended_for, default_temperature, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET
          provider = excluded.provider,
          vendor = excluded.vendor,
          provider_label = excluded.provider_label,
          display_name = excluded.display_name,
          is_free = excluded.is_free,
          context_window = excluded.context_window,
          recommended_for = excluded.recommended_for,
          default_temperature = excluded.default_temperature,
          updated_at = excluded.updated_at
      `);

      for (const m of jsonModels) {
        insert.run(
          m.modelId,
          m.provider,
          m.vendor,
          m.providerLabel,
          m.displayName,
          m.isFree ? 1 : 0,
          m.contextWindow ?? '128K',
          m.recommendedFor ?? '',
          m.defaultTemperature ?? 0.2,
          now,
        );
      }
    }

    return this.listModelsCatalog();
  }

  public listModelsCatalog(): StoredModelCatalogEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM models_catalog ORDER BY is_free DESC, vendor ASC, model_id ASC`)
      .all() as Array<{
      model_id: string;
      provider: string;
      vendor: string;
      provider_label: string;
      display_name: string;
      is_free: number;
      context_window: string;
      recommended_for: string;
      default_temperature: number;
    }>;

    return rows.map((r) => ({
      modelId: r.model_id,
      provider: r.provider as LlmProviderType,
      vendor: r.vendor,
      providerLabel: r.provider_label,
      displayName: r.display_name,
      isFree: r.is_free === 1,
      contextWindow: r.context_window,
      recommendedFor: r.recommended_for,
      defaultTemperature: r.default_temperature,
    }));
  }

  public upsertModelCatalogEntry(entry: StoredModelCatalogEntry): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO models_catalog (
          model_id, provider, vendor, provider_label, display_name,
          is_free, context_window, recommended_for, default_temperature, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET
          provider = excluded.provider,
          vendor = excluded.vendor,
          provider_label = excluded.provider_label,
          display_name = excluded.display_name,
          is_free = excluded.is_free,
          context_window = excluded.context_window,
          recommended_for = excluded.recommended_for,
          default_temperature = excluded.default_temperature,
          updated_at = excluded.updated_at`,
      )
      .run(
        entry.modelId,
        entry.provider,
        entry.vendor,
        entry.providerLabel,
        entry.displayName,
        entry.isFree ? 1 : 0,
        entry.contextWindow,
        entry.recommendedFor,
        entry.defaultTemperature,
        now,
      );
  }

  // ==========================================================================
  // APPLICATION SETTINGS (MULTI-LANGUAGE, ACTIVE PROJECT & PREFERENCES)
  // ==========================================================================

  getSettings(): AppSettings {
    const langRow = this.db
      .prepare(`SELECT value FROM settings WHERE key = 'language'`)
      .get() as { value: string } | undefined;
    const themeRow = this.db
      .prepare(`SELECT value FROM settings WHERE key = 'theme'`)
      .get() as { value: string } | undefined;
    const workDirRow = this.db
      .prepare(`SELECT value FROM settings WHERE key = 'work_dir'`)
      .get() as { value: string } | undefined;
    const activeProjRow = this.db
      .prepare(`SELECT value FROM settings WHERE key = 'active_project_id'`)
      .get() as { value: string } | undefined;
    const persistentWorkersRow = this.db
      .prepare(`SELECT value FROM settings WHERE key = 'persistent_workers'`)
      .get() as { value: string } | undefined;
    const persistentWorkers =
      persistentWorkersRow ? persistentWorkersRow.value === 'true' : true;
    const lang: SupportedLanguage =
      langRow?.value === 'es' ? 'es' : 'en';
    const theme: SupportedTheme =
      themeRow?.value === 'solarized-light' ||
      themeRow?.value === 'solarized-dark'
        ? themeRow.value
        : 'system';
    const workDir = workDirRow?.value
      ? path.resolve(workDirRow.value)
      : this.defaultWorkDir;
    return {
      language: lang,
      theme,
      workDir,
      persistentWorkers,
      activeProjectId: activeProjRow?.value,
    };
  }

  updateSettings(partial: Partial<AppSettings>): AppSettings {
    const now = new Date().toISOString();
    if (partial.language) {
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ('language', ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .run(partial.language, now);
    }
    if (partial.theme) {
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ('theme', ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .run(partial.theme, now);
    }
    if (partial.workDir !== undefined && partial.workDir.trim().length > 0) {
      const resolvedWorkDir = path.resolve(partial.workDir.trim());
      this.ensureWorkDirStructure(resolvedWorkDir);
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ('work_dir', ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .run(resolvedWorkDir, now);
    }
    if (partial.activeProjectId !== undefined) {
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ('active_project_id', ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .run(partial.activeProjectId, now);
    }
    if (partial.persistentWorkers !== undefined) {
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ('persistent_workers', ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .run(partial.persistentWorkers ? 'true' : 'false', now);
    }
    const updated = this.getSettings();
    this.syncSettingsFiles(updated);
    return updated;
  }

  // ==========================================================================
  // PROJECTS & WORKFLOW
  // ==========================================================================

  createProject(params: {
    name: string;
    description: string;
    workspaceDir: string;
  }): Project {
    const id = `proj_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const workspaceDir = path.resolve(params.workspaceDir);
    this.ensureProjectArtifactsStructure(workspaceDir);

    const phase: WorkflowPhase = 'PHASE_2_ARCHITECT_ANALYSIS';
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, workspace_dir, phase, approved_architecture_version, correction_cycle_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(id, params.name, params.description, workspaceDir, phase, now, now);

    // Initialize default multi-model role configs for the 4 core specialists
    this.setRoleConfig(id, {
      role: 'architect',
      provider: 'anthropic',
      modelId: 'claude-3-7-sonnet',
      temperature: 0.2,
      executionModality: 'LOCAL_PROCESS',
    });
    this.setRoleConfig(id, {
      role: 'developer',
      provider: 'anthropic',
      modelId: 'claude-3-7-sonnet',
      temperature: 0.1,
      executionModality: 'LOCAL_PROCESS',
    });
    this.setRoleConfig(id, {
      role: 'qa',
      provider: 'openai',
      modelId: 'gpt-4o',
      temperature: 0.0,
      executionModality: 'LOCAL_PROCESS',
    });
    this.setRoleConfig(id, {
      role: 'pm',
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      temperature: 0.1,
      executionModality: 'LOCAL_PROCESS',
    });

    // Initialize centralized SQLite chat summary rows for the 4 core experts
    for (const expertRole of ['pm', 'architect', 'developer', 'qa'] as const) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO expert_chat_summaries (
            project_id, expert_role, total_messages, last_user_prompt,
            last_expert_reply, summary_text, recent_exchanges_json, updated_at
          ) VALUES (?, ?, 0, '', '', '', '[]', ?)`,
        )
        .run(id, expertRole, now);
    }

    // Discover and register any pre-existing repositories inside workspaceDir (if any).
    // Physical repository creation is strictly delegated to the Senior Developer
    // following the architectural specification (SPEC-*) agreed with the PO.
    this.discoverAndRegisterRepositories(id, workspaceDir);

    // Set this newly created project as the currently active project in SQLite settings
    this.updateSettings({ activeProjectId: id });

    return this.getProject(id)!;
  }

  /**
   * Scans the project filesystem directory for existing repositories (either root .git
   * or multiple sub-repositories inside subdirectories) and registers them in SQLite.
   */
  discoverAndRegisterRepositories(
    projectId: string,
    workspaceDir: string,
  ): string[] {
    const absWorkspace = path.resolve(workspaceDir);
    if (!fs.existsSync(absWorkspace)) return [];

    const now = new Date().toISOString();
    const discovered: Array<{ name: string; repoPath: string }> = [];

    const isRepoRoot = (dirPath: string): boolean => {
      return (
        dirPath.endsWith('.git') ||
        fs.existsSync(path.join(dirPath, '.git')) ||
        fs.existsSync(path.join(dirPath, 'package.json')) ||
        fs.existsSync(path.join(dirPath, 'Cargo.toml')) ||
        fs.existsSync(path.join(dirPath, 'go.mod')) ||
        fs.existsSync(path.join(dirPath, 'pyproject.toml'))
      );
    };

    if (fs.existsSync(path.join(absWorkspace, '.git'))) {
      discovered.push({
        name: path.basename(absWorkspace),
        repoPath: absWorkspace,
      });
    }

    const entries = fs.readdirSync(absWorkspace, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'contracts' ||
        entry.name === 'scripts' ||
        entry.name === 'deliveries' ||
        entry.name === 'outputs'
      ) {
        continue;
      }
      const subDir = path.join(absWorkspace, entry.name);
      if (entry.name !== 'repos' && isRepoRoot(subDir)) {
        discovered.push({
          name: entry.name,
          repoPath: subDir,
        });
      } else {
        // Also check one level deeper for grouped multi-repo layouts (e.g., repos/* or packages/*)
        const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (
            !subEntry.isDirectory() ||
            subEntry.name.startsWith('.') ||
            subEntry.name === 'node_modules'
          ) {
            continue;
          }
          const nestedDir = path.join(subDir, subEntry.name);
          if (isRepoRoot(nestedDir)) {
            discovered.push({
              name: entry.name === 'repos' ? subEntry.name : `${entry.name}/${subEntry.name}`,
              repoPath: nestedDir,
            });
          }
        }
      }
    }

    this.db
      .prepare(`DELETE FROM project_repositories WHERE project_id = ?`)
      .run(projectId);

    for (const repo of discovered) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO project_repositories (
            project_id, repo_name, repo_path, discovered_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(projectId, repo.name, repo.repoPath, now);
    }

    return discovered.map((d) => d.name);
  }

  findProjectByNameOrId(query: string): Project | null {
    const trimmed = query.trim();
    if (!trimmed) return null;
    const byId = this.getProject(trimmed);
    if (byId && !byId.name.startsWith('DELETED_')) return byId;

    const row = this.db
      .prepare(
        `SELECT * FROM projects WHERE LOWER(name) = LOWER(?) AND name NOT LIKE 'DELETED_%' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(trimmed) as Record<string, unknown> | undefined;
    return row ? this.mapProjectRow(row) : null;
  }

  switchActiveProject(nameOrId: string): Project {
    const target = this.findProjectByNameOrId(nameOrId);
    if (!target) {
      throw new Error(`Project "${nameOrId}" not found.`);
    }
    this.discoverAndRegisterRepositories(target.id, target.workspaceDir);
    this.updateSettings({ activeProjectId: target.id });
    return this.getProject(target.id)!;
  }

  getActiveProject(): Project | null {
    const settings = this.getSettings();
    if (settings.activeProjectId) {
      const proj = this.getProject(settings.activeProjectId);
      if (proj && !proj.name.startsWith('DELETED_')) return proj;
    }
    const all = this.listProjects();
    if (all.length > 0) {
      this.updateSettings({ activeProjectId: all[0].id });
      return all[0];
    }
    return null;
  }

  getProject(projectId: string): Project | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(projectId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapProjectRow(row);
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare(`SELECT * FROM projects WHERE name NOT LIKE 'DELETED_%' ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapProjectRow(r));
  }

  deleteProject(projectId: string): { renamedWorkspaceDir?: string; newActiveProjectId?: string } {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found.`);
    }

    let renamedWorkspaceDir: string | undefined;

    // 1. Rename workspace folder on filesystem if it exists (preserves historical files)
    if (project.workspaceDir && fs.existsSync(project.workspaceDir)) {
      const parentDir = path.dirname(project.workspaceDir);
      const baseName = path.basename(project.workspaceDir);
      const prefix = 'DELETED_';
      const cleanBaseName = baseName.startsWith(prefix) ? baseName : `${prefix}${baseName}`;
      let targetDir = path.join(parentDir, cleanBaseName);

      if (fs.existsSync(targetDir) && targetDir !== project.workspaceDir) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        targetDir = path.join(parentDir, `${cleanBaseName}_${timestamp}`);
      }

      try {
        fs.renameSync(project.workspaceDir, targetDir);
        renamedWorkspaceDir = targetDir;
      } catch {
        // Proceed with database cleanup even if rename fails (e.g. cross-device permissions)
      }
    }

    // 2. Clean up memories_fts virtual table for this project
    try {
      this.db.prepare(`DELETE FROM memories_fts WHERE project_id = ?`).run(projectId);
    } catch {
      // ignore
    }

    // 3. Delete from projects table (foreign keys cascade all other tables)
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);

    // 4. Update active project in settings if the deleted project was active
    let newActiveProjectId: string | undefined;
    const currentActiveId = this.getSettings().activeProjectId;
    if (currentActiveId === projectId) {
      const remaining = this.listProjects();
      if (remaining.length > 0) {
        newActiveProjectId = remaining[0].id;
        this.updateSettings({ activeProjectId: newActiveProjectId });
      } else {
        this.updateSettings({ activeProjectId: undefined });
      }
    }

    return { renamedWorkspaceDir, newActiveProjectId };
  }

  transitionPhase(projectId: string, targetPhase: WorkflowPhase): Project {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found.`);
    AuthorityGuard.assertTransition(project.phase, targetPhase);

    const now = new Date().toISOString();
    const extraCycles = targetPhase === 'PHASE_7_CORRECTION_CYCLE' ? 1 : 0;
    this.db
      .prepare(
        `UPDATE projects
         SET phase = ?, correction_cycle_count = correction_cycle_count + ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(targetPhase, extraCycles, now, projectId);

    return this.getProject(projectId)!;
  }

  private mapProjectRow(row: Record<string, unknown>): Project {
    const projectId = String(row.id);
    const repoRows = this.db
      .prepare(
        `SELECT repo_name FROM project_repositories WHERE project_id = ? ORDER BY repo_name ASC`,
      )
      .all(projectId) as Array<{ repo_name: string }>;

    return {
      id: projectId,
      name: String(row.name),
      description: String(row.description),
      workspaceDir: String(row.workspace_dir),
      repositories: repoRows.map((r) => String(r.repo_name)),
      phase: row.phase as WorkflowPhase,
      approvedArchitectureVersion: Number(row.approved_architecture_version),
      correctionCycleCount: Number(row.correction_cycle_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // ==========================================================================
  // SESSIONS & MESSAGES
  // ==========================================================================

  public static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  recordMessage(params: {
    projectId: string;
    fromRole: ActorRole;
    toRole: ActorRole;
    content: string;
    parentId?: string;
    metadata?: Record<string, unknown>;
    requestId?: string;
  }): StoredMessage {
    if (params.requestId) {
      const cached = this.getIdempotentResult<StoredMessage>(params.requestId);
      if (cached) {
        return cached;
      }
    }

    const project = this.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);
    if (!AuthorityGuard.canCommunicate(params.fromRole, params.toRole, project.phase)) {
      throw new Error(
        `Communication not permitted between ${params.fromRole} and ${params.toRole} during phase ${project.phase}.`,
      );
    }

    const participants = [params.fromRole, params.toRole].sort();
    let sessionRow = this.db
      .prepare(
        `SELECT id FROM sessions WHERE project_id = ? AND participant_a = ? AND participant_b = ?`,
      )
      .get(params.projectId, participants[0], participants[1]) as { id: string } | undefined;

    const now = new Date().toISOString();
    if (!sessionRow) {
      const sessionId = `sess_${crypto.randomUUID().slice(0, 8)}`;
      this.db
        .prepare(
          `INSERT INTO sessions (id, project_id, participant_a, participant_b, status, created_at)
           VALUES (?, ?, ?, ?, 'ACTIVE', ?)`,
        )
        .run(sessionId, params.projectId, participants[0], participants[1], now);
      sessionRow = { id: sessionId };
    }

    // Resolve parent_id in the Pi-style Session Tree (DAG) if not explicitly specified
    let parentId = params.parentId;
    if (!parentId) {
      const prevRow = this.db
        .prepare(
          `SELECT id FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(sessionRow.id) as { id: string } | undefined;
      parentId = prevRow?.id;
    }

    const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;
    const tokenEstimate = PoCliDatabase.estimateTokens(params.content);
    const metadataJson = JSON.stringify(params.metadata ?? {});
    this.db
      .prepare(
        `INSERT INTO messages (
          id, project_id, session_id, parent_id, from_role, to_role,
          content, token_estimate, compacted_into_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        msgId,
        params.projectId,
        sessionRow.id,
        parentId ?? null,
        params.fromRole,
        params.toRole,
        params.content,
        tokenEstimate,
        metadataJson,
        now,
      );

    // Centralize & update per-expert chat summaries in SQLite for any involved expert
    const involvedExperts = new Set<ActorRole>();
    if (params.fromRole !== 'product_owner') involvedExperts.add(params.fromRole);
    if (params.toRole !== 'product_owner') involvedExperts.add(params.toRole);
    for (const expertRole of involvedExperts) {
      this.refreshExpertChatSummaryInSqlite(params.projectId, expertRole);
    }

    const stored: StoredMessage = {
      id: msgId,
      projectId: params.projectId,
      sessionId: sessionRow.id,
      parentId,
      fromRole: params.fromRole,
      toRole: params.toRole,
      content: params.content,
      tokenEstimate,
      metadataJson,
      createdAt: now,
    };

    if (params.requestId) {
      this.saveIdempotentResult(
        params.requestId,
        params.projectId,
        params.fromRole,
        'recordMessage',
        stored,
      );
    }

    return stored;
  }

  private refreshExpertChatSummaryInSqlite(
    projectId: string,
    expertRole: ActorRole,
  ): void {
    const allRoleMessages = this.listMessages(projectId, expertRole);
    const totalMessages = allRoleMessages.length;
    const now = new Date().toISOString();

    let lastUserPrompt = '';
    let lastExpertReply = '';
    for (const msg of allRoleMessages) {
      if (msg.toRole === expertRole) {
        lastUserPrompt = this.cleanOneLineSnippet(msg.content, 90);
      }
      if (msg.fromRole === expertRole) {
        lastExpertReply = this.cleanOneLineSnippet(msg.content, 110);
      }
    }

    const recentExchanges: ExpertChatExchangeSnippet[] = allRoleMessages
      .slice(-4)
      .map((m) => ({
        fromRole: m.fromRole,
        toRole: m.toRole,
        snippet: this.cleanOneLineSnippet(m.content, 85),
        createdAt: m.createdAt,
      }));

    const summaryText =
      totalMessages === 0
        ? ''
        : lastExpertReply
          ? `${lastExpertReply}`
          : `${lastUserPrompt}`;

    this.db
      .prepare(
        `INSERT INTO expert_chat_summaries (
          project_id, expert_role, total_messages, last_user_prompt,
          last_expert_reply, summary_text, recent_exchanges_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, expert_role) DO UPDATE SET
          total_messages = excluded.total_messages,
          last_user_prompt = excluded.last_user_prompt,
          last_expert_reply = excluded.last_expert_reply,
          summary_text = excluded.summary_text,
          recent_exchanges_json = excluded.recent_exchanges_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        projectId,
        expertRole,
        totalMessages,
        lastUserPrompt,
        lastExpertReply,
        summaryText,
        JSON.stringify(recentExchanges),
        now,
      );
  }

  private cleanOneLineSnippet(text: string, maxLen: number): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= maxLen) return oneLine;
    return `${oneLine.slice(0, maxLen - 3)}...`;
  }

  getExpertChatSummary(
    projectId: string,
    expertRole: ActorRole,
  ): ExpertChatSummary {
    const row = this.db
      .prepare(
        `SELECT * FROM expert_chat_summaries WHERE project_id = ? AND expert_role = ?`,
      )
      .get(projectId, expertRole) as Record<string, unknown> | undefined;

    const activeTokenRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(token_estimate), 0) AS active_tokens
         FROM messages
         WHERE project_id = ? AND (from_role = ? OR to_role = ?) AND compacted_into_id IS NULL`,
      )
      .get(projectId, expertRole, expertRole) as { active_tokens: number };

    const compactionStatsRow = this.db
      .prepare(
        `SELECT COUNT(*) AS comp_count,
                COALESCE(SUM(MAX(0, tokens_before - tokens_after)), 0) AS saved_tokens,
                COALESCE((
                  SELECT tokens_after FROM context_compactions
                  WHERE project_id = ? AND expert_role = ?
                  ORDER BY created_at DESC, rowid DESC LIMIT 1
                ), 0) AS latest_comp_tokens
         FROM context_compactions
         WHERE project_id = ? AND expert_role = ?`,
      )
      .get(projectId, expertRole, projectId, expertRole) as {
      comp_count: number;
      saved_tokens: number;
      latest_comp_tokens: number;
    };

    const activeContextTokens =
      Number(activeTokenRow?.active_tokens ?? 0) +
      Number(compactionStatsRow?.latest_comp_tokens ?? 0);
    const savedTokensByCompaction = Number(compactionStatsRow?.saved_tokens ?? 0);
    const compactionCount = Number(compactionStatsRow?.comp_count ?? 0);

    const interactionRow = this.db
      .prepare(
        `SELECT 
          COALESCE(SUM(CASE WHEN from_role = 'product_owner' AND to_role = ? THEN 1 ELSE 0 END), 0) AS po_count,
          COALESCE(SUM(CASE WHEN (from_role = ? AND to_role = 'architect') OR (from_role = 'architect' AND to_role = ?) THEN 1 ELSE 0 END), 0) AS arq_count,
          COALESCE(SUM(CASE WHEN (from_role = ? AND to_role = 'developer') OR (from_role = 'developer' AND to_role = ?) THEN 1 ELSE 0 END), 0) AS dev_count,
          COALESCE(SUM(CASE WHEN (from_role = ? AND to_role = 'qa') OR (from_role = 'qa' AND to_role = ?) THEN 1 ELSE 0 END), 0) AS qa_count,
          COALESCE(SUM(CASE WHEN (from_role = ? AND to_role = 'pm') OR (from_role = 'pm' AND to_role = ?) THEN 1 ELSE 0 END), 0) AS pm_count
        FROM messages
        WHERE project_id = ?`,
      )
      .get(
        expertRole,
        expertRole,
        expertRole,
        expertRole,
        expertRole,
        expertRole,
        expertRole,
        expertRole,
        expertRole,
        projectId,
      ) as {
        po_count: number;
        arq_count: number;
        dev_count: number;
        qa_count: number;
        pm_count: number;
      } | undefined;

    const interactions: ExpertInteractions = {
      po: Number(interactionRow?.po_count ?? 0),
      architect: Number(interactionRow?.arq_count ?? 0),
      developer: Number(interactionRow?.dev_count ?? 0),
      qa: Number(interactionRow?.qa_count ?? 0),
      pm: Number(interactionRow?.pm_count ?? 0),
    };

    if (!row) {
      return {
        projectId,
        expertRole,
        totalMessages: 0,
        activeContextTokens: 0,
        savedTokensByCompaction: 0,
        compactionCount: 0,
        lastUserPrompt: '',
        lastExpertReply: '',
        summaryText: '',
        recentExchanges: [],
        updatedAt: new Date().toISOString(),
        interactions,
      };
    }

    return {
      projectId: String(row.project_id),
      expertRole: String(row.expert_role),
      totalMessages: Number(row.total_messages),
      activeContextTokens,
      savedTokensByCompaction,
      compactionCount,
      lastUserPrompt: String(row.last_user_prompt),
      lastExpertReply: String(row.last_expert_reply),
      summaryText: String(row.summary_text),
      recentExchanges: JSON.parse(
        String(row.recent_exchanges_json || '[]'),
      ) as ExpertChatExchangeSnippet[],
      updatedAt: String(row.updated_at),
      interactions,
    };
  }

  listExpertChatSummaries(projectId: string): ExpertChatSummary[] {
    const orderedRoles: ActorRole[] = ['pm', 'architect', 'developer', 'qa'];
    return orderedRoles.map((role) =>
      this.getExpertChatSummary(projectId, role),
    );
  }

  recordPmInquiryInSqlite(
    artifactId: string,
    report: PmConsolidationReport,
  ): void {
    this.db
      .prepare(
        `INSERT INTO pm_inquiries (
          id, project_id, artifact_id, modality, consulted_agents_json,
          individual_responses_json, discrepancies_json, consolidated_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.projectId,
        artifactId,
        report.modality,
        JSON.stringify(report.consultedAgents),
        JSON.stringify(report.individualResponses),
        JSON.stringify(report.discrepancies),
        report.consolidatedSummary,
        report.createdAt,
      );
  }

  listPmInquiries(projectId: string): PmConsolidationReport[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pm_inquiries WHERE project_id = ? ORDER BY created_at DESC`,
      )
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      modality: r.modality as 'PARALLEL' | 'SEQUENTIAL',
      consultedAgents: JSON.parse(String(r.consulted_agents_json || '[]')),
      individualResponses: JSON.parse(
        String(r.individual_responses_json || '[]'),
      ),
      discrepancies: JSON.parse(String(r.discrepancies_json || '[]')),
      consolidatedSummary: String(r.consolidated_summary),
      createdAt: String(r.created_at),
    }));
  }

  listMessages(
    projectId: string,
    roleFilter?: ActorRole,
    onlyUncompacted = false,
  ): StoredMessage[] {
    const uncompactedClause = onlyUncompacted
      ? ` AND compacted_into_id IS NULL`
      : '';
    const rows = roleFilter
      ? (this.db
          .prepare(
            `SELECT * FROM messages WHERE project_id = ? AND (from_role = ? OR to_role = ?)${uncompactedClause} ORDER BY created_at ASC, rowid ASC`,
          )
          .all(projectId, roleFilter, roleFilter) as Record<string, unknown>[])
      : (this.db
          .prepare(
            `SELECT * FROM messages WHERE project_id = ?${uncompactedClause} ORDER BY created_at ASC, rowid ASC`,
          )
          .all(projectId) as Record<string, unknown>[]);

    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      sessionId: String(r.session_id),
      parentId: r.parent_id ? String(r.parent_id) : undefined,
      fromRole: String(r.from_role),
      toRole: String(r.to_role),
      content: String(r.content),
      tokenEstimate: Number(
        r.token_estimate || PoCliDatabase.estimateTokens(String(r.content)),
      ),
      compactedIntoId: r.compacted_into_id
        ? String(r.compacted_into_id)
        : undefined,
      metadataJson: String(r.metadata_json),
      createdAt: String(r.created_at),
    }));
  }

  // ==========================================================================
  // PI-STYLE CONTEXT WINDOW COMPACTION & 4-LAYER MEMORY ASSEMBLY
  // ==========================================================================

  /**
   * Condenses uncompacted conversation messages for an expert into a structured
   * Pi-style Compaction Checkpoint in SQLite while preserving full historical audit rows.
   */
  compactAgentContextWindow(params: {
    projectId: string;
    expertRole: ActorRole;
    keepRecentCount?: number;
  }): CompactionCheckpoint | null {
    const project = this.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    const uncompacted = this.listMessages(
      params.projectId,
      params.expertRole,
      true,
    );
    if (uncompacted.length === 0) return null;

    const keepCount = params.keepRecentCount ?? 2;
    const toCompact =
      uncompacted.length > keepCount
        ? uncompacted.slice(0, uncompacted.length - keepCount)
        : uncompacted;

    if (toCompact.length === 0) return null;

    const previousCompaction = this.getLatestCompactionCheckpoint(
      params.projectId,
      params.expertRole,
    );

    const tokensBefore =
      toCompact.reduce((acc, m) => acc + m.tokenEstimate, 0) +
      (previousCompaction?.tokensAfter ?? 0);

    const keyBullets = toCompact.map(
      (m) =>
        `- [${m.fromRole} -> ${m.toRole}]: ${this.cleanOneLineSnippet(m.content, 110)}`,
    );

    const structuredSummary = [
      `[Pi Context Compaction Checkpoint — Role: ${params.expertRole} | Phase: ${project.phase}]`,
      ...(previousCompaction
        ? [`Prior Compacted Trajectory: ${this.cleanOneLineSnippet(previousCompaction.structuredSummary, 180)}`]
        : []),
      `Condensed ${toCompact.length} turn(s):`,
      ...keyBullets.slice(-6),
    ].join('\n');

    const tokensAfter = Math.min(
      tokensBefore,
      PoCliDatabase.estimateTokens(structuredSummary),
    );
    const checkpointId = `cmp_${crypto.randomUUID().slice(0, 8)}`;
    const upToMessageId = toCompact[toCompact.length - 1].id;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO context_compactions (
          id, project_id, expert_role, up_to_message_id, compacted_message_count,
          tokens_before, tokens_after, structured_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpointId,
        params.projectId,
        params.expertRole,
        upToMessageId,
        toCompact.length,
        tokensBefore,
        tokensAfter,
        structuredSummary,
        now,
      );

    const markStmt = this.db.prepare(
      `UPDATE messages SET compacted_into_id = ? WHERE id = ?`,
    );
    for (const msg of toCompact) {
      markStmt.run(checkpointId, msg.id);
    }

    // Store compacted checkpoint in the 4-layer memory system (AGENT_SPECIFIC layer)
    this.upsertMemory({
      projectId: params.projectId,
      layer: 'AGENT_SPECIFIC',
      agentRole: params.expertRole,
      key: `pi_compaction_checkpoint_${params.expertRole}`,
      value: structuredSummary,
    });

    // Update SQLite expert chat summary box so Ctrl+Tab shows the compacted summary
    this.refreshExpertChatSummaryInSqlite(params.projectId, params.expertRole);
    this.db
      .prepare(
        `UPDATE expert_chat_summaries SET summary_text = ?, updated_at = ?
         WHERE project_id = ? AND expert_role = ?`,
      )
      .run(
        this.cleanOneLineSnippet(structuredSummary, 110),
        now,
        params.projectId,
        params.expertRole,
      );

    return {
      id: checkpointId,
      projectId: params.projectId,
      expertRole: params.expertRole,
      upToMessageId,
      compactedMessageCount: toCompact.length,
      tokensBefore,
      tokensAfter,
      structuredSummary,
      createdAt: now,
    };
  }

  getLatestCompactionCheckpoint(
    projectId: string,
    expertRole: ActorRole,
  ): CompactionCheckpoint | null {
    const row = this.db
      .prepare(
        `SELECT * FROM context_compactions
         WHERE project_id = ? AND expert_role = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId, expertRole) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      expertRole: String(row.expert_role),
      upToMessageId: String(row.up_to_message_id),
      compactedMessageCount: Number(row.compacted_message_count),
      tokensBefore: Number(row.tokens_before),
      tokensAfter: Number(row.tokens_after),
      structuredSummary: String(row.structured_summary),
      createdAt: String(row.created_at),
    };
  }

  listCompactionCheckpoints(
    projectId: string,
    expertRole?: ActorRole,
  ): CompactionCheckpoint[] {
    const rows = expertRole
      ? (this.db
          .prepare(
            `SELECT * FROM context_compactions WHERE project_id = ? AND expert_role = ? ORDER BY created_at DESC, rowid DESC`,
          )
          .all(projectId, expertRole) as Record<string, unknown>[])
      : (this.db
          .prepare(
            `SELECT * FROM context_compactions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`,
          )
          .all(projectId) as Record<string, unknown>[]);
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      expertRole: String(row.expert_role),
      upToMessageId: String(row.up_to_message_id),
      compactedMessageCount: Number(row.compacted_message_count),
      tokensBefore: Number(row.tokens_before),
      tokensAfter: Number(row.tokens_after),
      structuredSummary: String(row.structured_summary),
      createdAt: String(row.created_at),
    }));
  }

  /**
   * Assembles the agent's Context Window using Pi's prompt-caching-friendly 3-tier order:
   * 1. Tier 1 (Static Cacheable Prefix): Authoritative Normative Artifacts (ARCH-*, REQ-*, ADR-*, SPEC-*)
   * 2. Tier 2 (4-Layer Persistent & Agent Memory + Latest Pi Compaction Checkpoint)
   * 3. Tier 3 (Active Recent Uncompacted Conversation DAG Window)
   */
  assembleAgentContextWindow(
    projectId: string,
    expertRole: ActorRole,
  ): AssembledContextWindow {
    const project = this.getProject(projectId);
    const artifacts = this.listArtifacts(projectId, true);
    const normativePrefix =
      artifacts.length === 0
        ? 'No normative artifacts registered yet.'
        : artifacts
            .map((a) => {
              const relPath =
                project?.workspaceDir && a.filePath.startsWith(project.workspaceDir)
                  ? path.relative(project.workspaceDir, a.filePath)
                  : a.filePath;
              return [
                `### [${a.code} v${a.version} | ${a.type} | Status: ${a.status} | File: ${relPath}]`,
                `**Title**: ${a.title}`,
                `**Traces To**: ${a.tracesTo.join(', ') || 'root'}`,
                `\n${a.content}`,
              ].join('\n');
            })
            .join('\n\n---\n\n');

    const persistentMems = this.listMemories(projectId, undefined, expertRole);
    const persistentMemoryBlock =
      persistentMems.length === 0
        ? 'No persistent memory entries recorded yet.'
        : persistentMems
            .slice(0, 8)
            .map((m) => `- [${m.layer}] ${m.key}: ${this.cleanOneLineSnippet(m.value, 140)}`)
            .join('\n');

    const latestCheckpoint = this.getLatestCompactionCheckpoint(
      projectId,
      expertRole,
    );
    const compactionCheckpointBlock = latestCheckpoint
      ? latestCheckpoint.structuredSummary
      : 'No compaction checkpoints yet (active window within token budget).';

    const activeRecentMessages = this.listMessages(
      projectId,
      expertRole,
      true,
    ).slice(-6);

    const summaryStats = this.getExpertChatSummary(projectId, expertRole);

    const formattedPromptContext = [
      `## [TIER 1 — CACHEABLE NORMATIVE ARTIFACTS (AUTHORITATIVE — CANNOT BE OVERRIDDEN BY MEMORY)]`,
      normativePrefix,
      ``,
      `## [TIER 2 — 4-LAYER PERSISTENT MEMORY & PI COMPACTION CHECKPOINT]`,
      persistentMemoryBlock,
      compactionCheckpointBlock,
      ``,
      `## [TIER 3 — ACTIVE RECENT CONVERSATION WINDOW (UNCOMPACTED DAG LEAF TURNS)]`,
      ...(activeRecentMessages.length === 0
        ? ['(No uncompacted recent turns)']
        : activeRecentMessages.map(
            (m) =>
              `[${m.id}${m.parentId ? ` <- ${m.parentId}` : ''} | ${m.fromRole} -> ${m.toRole}]: ${this.cleanOneLineSnippet(m.content, 160)}`,
          )),
    ].join('\n');

    return {
      projectId,
      expertRole,
      normativePrefix,
      persistentMemoryBlock,
      compactionCheckpointBlock,
      activeRecentMessages,
      activeTokens: summaryStats.activeContextTokens,
      savedTokensByCompaction: summaryStats.savedTokensByCompaction,
      compactionCount: summaryStats.compactionCount,
      formattedPromptContext,
    };
  }

  public normalizeSourceRelPath(
    projectName: string,
    customRelPath?: string,
    fallbackFile?: string,
  ): string {
    const defaultRepo = projectName.endsWith('.git')
      ? projectName
      : `${projectName}.git`;
    if (!customRelPath || !customRelPath.trim()) {
      return path.join('repos', defaultRepo, fallbackFile ?? 'src/index.txt');
    }

    const cleanPath = customRelPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = cleanPath.split('/').filter(Boolean);
    if (parts.length === 0) {
      return path.join('repos', defaultRepo, fallbackFile ?? 'src/index.txt');
    }

    if (parts[0] === 'repos') {
      if (parts.length === 1) {
        return path.join('repos', defaultRepo, fallbackFile ?? 'src/index.txt');
      }
      const repoDir = parts[1].endsWith('.git') ? parts[1] : `${parts[1]}.git`;
      return path.join('repos', repoDir, ...parts.slice(2));
    }

    if (parts[0].endsWith('.git')) {
      return path.join('repos', parts[0], ...parts.slice(1));
    }

    if (parts[0] === projectName) {
      return path.join('repos', defaultRepo, ...parts.slice(1));
    }

    return path.join('repos', defaultRepo, ...parts);
  }

  // ==========================================================================
  // VERSIONED ARTIFACTS & APPROVALS (PHASE 2)
  // ==========================================================================

  saveArtifact(params: {
    projectId: string;
    code: string;
    type: ArtifactType;
    title: string;
    content: string;
    authorRole: ActorRole;
    status?: ArtifactStatus;
    tracesTo?: string[];
    citations?: string[];
    customRelPath?: string;
    expectedVersion?: number;
    requestId?: string;
  }): Artifact {
    if (params.requestId) {
      const cached = this.getIdempotentResult<Artifact>(params.requestId);
      if (cached) {
        return cached;
      }
    }

    AuthorityGuard.assertCanWriteArtifact(params.authorRole, params.type);
    const project = this.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    const latest = this.db
      .prepare(
        `SELECT id, version FROM artifacts WHERE project_id = ? AND code = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(params.projectId, params.code) as { id: string; version: number } | undefined;

    const currentVersion = latest ? latest.version : 0;
    if (params.expectedVersion !== undefined && params.expectedVersion !== currentVersion) {
      throw new StaleArtifactVersionError(
        params.code,
        params.expectedVersion,
        currentVersion,
      );
    }

    const nextVersion = latest ? latest.version + 1 : 1;
    if (latest) {
      this.db
        .prepare(`UPDATE artifacts SET status = 'SUPERSEDED' WHERE id = ? AND status != 'APPROVED'`)
        .run(latest.id);
    }

    const sha256 = crypto.createHash('sha256').update(params.content, 'utf8').digest('hex');
    this.ensureProjectArtifactsStructure(project.workspaceDir);

    let absPath: string;
    if (params.type === 'SOURCE_CODE') {
      const relPath = this.normalizeSourceRelPath(
        project.name,
        params.customRelPath,
        `${params.code}_v${nextVersion}.txt`,
      );
      absPath = path.join(project.workspaceDir, relPath);
    } else {
      let relPath: string;
      if (params.customRelPath) {
        relPath = params.customRelPath;
      } else if (params.type === 'PM_REPORT') {
        relPath = path.join('deliveries', `${params.code}_v${nextVersion}.md`);
      } else if (params.type === 'LLM_OUTPUT') {
        relPath = path.join('outputs', `${params.code}_v${nextVersion}.md`);
      } else if (params.type === 'IMPLEMENTATION' || params.type === 'IMPLEMENTATION_PLAN') {
        relPath = path.join('contracts', 'implementation', `${params.code}_v${nextVersion}.md`);
      } else {
        relPath = path.join(
          'contracts',
          params.type.toLowerCase(),
          `${params.code}_v${nextVersion}.md`,
        );
      }
      absPath = path.join(project.workspaceDir, relPath);
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, params.content, 'utf8');

    if (params.type === 'SOURCE_CODE') {
      this.discoverAndRegisterRepositories(project.id, project.workspaceDir);
    }

    const id = `art_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const status: ArtifactStatus =
      params.status ?? (params.type === 'ARCHITECTURE' ? 'PENDING_APPROVAL' : 'DRAFT');
    const tracesTo = params.tracesTo ?? [];
    const citations = params.citations ?? [];

    this.db
      .prepare(
        `INSERT INTO artifacts (
          id, project_id, code, type, title, content, version, status,
          author_role, file_path, sha256, traces_to_json, citations_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.projectId,
        params.code,
        params.type,
        params.title,
        params.content,
        nextVersion,
        status,
        params.authorRole,
        absPath,
        sha256,
        JSON.stringify(tracesTo),
        JSON.stringify(citations),
        now,
        now,
      );

    const saved = this.getArtifactById(id)!;
    if (params.requestId) {
      this.saveIdempotentResult(
        params.requestId,
        params.projectId,
        params.authorRole,
        'saveArtifact',
        saved,
      );
    }
    return saved;
  }

  getArtifactById(id: string): Artifact | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapArtifactRow(row) : null;
  }

  getLatestArtifactByCode(projectId: string, code: string): Artifact | null {
    const row = this.db
      .prepare(
        `SELECT * FROM artifacts WHERE project_id = ? AND code = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(projectId, code) as Record<string, unknown> | undefined;
    return row ? this.mapArtifactRow(row) : null;
  }

  listArtifacts(projectId: string, onlyLatest = true): Artifact[] {
    const rows = this.db
      .prepare(`SELECT * FROM artifacts WHERE project_id = ? ORDER BY code ASC, version DESC`)
      .all(projectId) as Record<string, unknown>[];
    const all = rows.map((r) => this.mapArtifactRow(r));
    if (!onlyLatest) return all;

    const seen = new Set<string>();
    const latest: Artifact[] = [];
    for (const art of all) {
      if (!seen.has(art.code)) {
        seen.add(art.code);
        latest.push(art);
      }
    }
    return latest;
  }

  approveOrRejectArchitecture(params: {
    projectId: string;
    artifactCode: string;
    approverRole: ActorRole;
    decision: 'APPROVED' | 'REJECTED';
    comments: string;
  }): ApprovalRecord {
    AuthorityGuard.assertCanApproveArchitecture(params.approverRole);
    const artifact = this.getLatestArtifactByCode(params.projectId, params.artifactCode);
    if (!artifact) {
      throw new Error(`Artifact ${params.artifactCode} not found in project ${params.projectId}.`);
    }

    const now = new Date().toISOString();
    const newStatus: ArtifactStatus = params.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    this.db
      .prepare(`UPDATE artifacts SET status = ?, updated_at = ? WHERE id = ?`)
      .run(newStatus, now, artifact.id);

    if (params.decision === 'APPROVED' && artifact.type === 'ARCHITECTURE') {
      // Supersede any older approved architecture versions
      this.db
        .prepare(
          `UPDATE artifacts SET status = 'SUPERSEDED'
           WHERE project_id = ? AND code = ? AND id != ? AND status = 'APPROVED'`,
        )
        .run(params.projectId, params.artifactCode, artifact.id);

      // Also mark associated REQUIREMENTS, ADRs and SPECIFICATIONS as APPROVED
      this.db
        .prepare(
          `UPDATE artifacts SET status = 'APPROVED', updated_at = ?
           WHERE project_id = ? AND type IN ('REQUIREMENT', 'NON_FUNCTIONAL_REQUIREMENT', 'ADR', 'SPECIFICATION') AND status = 'DRAFT'`,
        )
        .run(now, params.projectId);

      this.db
        .prepare(
          `UPDATE projects SET approved_architecture_version = ?, phase = 'PHASE_4_DEVELOPER_HANDOFF', updated_at = ?
           WHERE id = ?`,
        )
        .run(artifact.version, now, params.projectId);
    } else if (params.decision === 'REJECTED') {
      this.db
        .prepare(`UPDATE projects SET phase = 'PHASE_2_ARCHITECT_ANALYSIS', updated_at = ? WHERE id = ?`)
        .run(now, params.projectId);
    }

    const approvalId = `appr_${crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO approvals (id, project_id, artifact_id, artifact_code, artifact_version, approver_role, decision, comments, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approvalId,
        params.projectId,
        artifact.id,
        artifact.code,
        artifact.version,
        params.approverRole,
        params.decision,
        params.comments,
        now,
      );

    return {
      id: approvalId,
      projectId: params.projectId,
      artifactId: artifact.id,
      artifactCode: artifact.code,
      artifactVersion: artifact.version,
      approverRole: params.approverRole,
      decision: params.decision,
      comments: params.comments,
      createdAt: now,
    };
  }

  listApprovals(projectId: string): ApprovalRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC`)
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      artifactId: String(r.artifact_id),
      artifactCode: String(r.artifact_code),
      artifactVersion: Number(r.artifact_version),
      approverRole: String(r.approver_role),
      decision: r.decision as 'APPROVED' | 'REJECTED',
      comments: String(r.comments),
      createdAt: String(r.created_at),
    }));
  }

  private mapArtifactRow(row: Record<string, unknown>): Artifact {
    const filePath = String(row.file_path);
    // Filesystem as Single Source of Truth: load live content from disk
    let liveContent = String(row.content);
    if (filePath && fs.existsSync(filePath)) {
      try {
        liveContent = fs.readFileSync(filePath, 'utf8');
      } catch {
        // fallback to stored row content
      }
    }

    return {
      id: String(row.id),
      projectId: String(row.project_id),
      code: String(row.code),
      type: row.type as ArtifactType,
      title: String(row.title),
      content: liveContent,
      version: Number(row.version),
      status: row.status as ArtifactStatus,
      authorRole: String(row.author_role),
      filePath,
      sha256: String(row.sha256),
      tracesTo: JSON.parse(String(row.traces_to_json || '[]')),
      citations: JSON.parse(String(row.citations_json || '[]')),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // ==========================================================================
  // ARCHITECTURAL CONSULTATIONS (PHASE 3)
  // ==========================================================================

  createConsultation(params: {
    projectId: string;
    fromRole: ActorRole;
    subject: string;
    ambiguityOrBlocker: string;
    proposedAlternative: string;
    impactedArtifacts: string[];
  }): ArchitecturalConsultation {
    const id = `cons_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO consultations (
          id, project_id, from_role, to_role, subject, ambiguity_or_blocker,
          proposed_alternative, impacted_artifacts_json, requires_po_intervention, status, created_at
        ) VALUES (?, ?, ?, 'architect', ?, ?, ?, ?, 0, 'OPEN', ?)`,
      )
      .run(
        id,
        params.projectId,
        params.fromRole,
        params.subject,
        params.ambiguityOrBlocker,
        params.proposedAlternative,
        JSON.stringify(params.impactedArtifacts),
        now,
      );

    return this.getConsultation(id)!;
  }

  evaluateConsultationByArchitect(params: {
    consultationId: string;
    architectAssessment: string;
    requiresPoIntervention: boolean;
  }): ArchitecturalConsultation {
    const now = new Date().toISOString();
    const status: ConsultationStatus = params.requiresPoIntervention
      ? 'ESCALATED_TO_PO'
      : 'RESOLVED_BY_ARCHITECT';
    const resolvedAt = params.requiresPoIntervention ? null : now;

    this.db
      .prepare(
        `UPDATE consultations
         SET architect_assessment = ?, requires_po_intervention = ?, status = ?, resolved_at = ?
         WHERE id = ?`,
      )
      .run(
        params.architectAssessment,
        params.requiresPoIntervention ? 1 : 0,
        status,
        resolvedAt,
        params.consultationId,
      );

    return this.getConsultation(params.consultationId)!;
  }

  resolveEscalatedConsultationByPo(params: {
    consultationId: string;
    approverRole: ActorRole;
    approved: boolean;
    poDecisionNotes: string;
  }): ArchitecturalConsultation {
    AuthorityGuard.assertCanApproveArchitecture(params.approverRole);
    const now = new Date().toISOString();
    const status: ConsultationStatus = params.approved ? 'APPROVED_BY_PO' : 'REJECTED_BY_PO';
    this.db
      .prepare(
        `UPDATE consultations SET po_decision_notes = ?, status = ?, resolved_at = ? WHERE id = ?`,
      )
      .run(params.poDecisionNotes, status, now, params.consultationId);

    return this.getConsultation(params.consultationId)!;
  }

  getConsultation(id: string): ArchitecturalConsultation | null {
    const row = this.db.prepare('SELECT * FROM consultations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.mapConsultationRow(row);
  }

  listConsultations(projectId: string): ArchitecturalConsultation[] {
    const rows = this.db
      .prepare('SELECT * FROM consultations WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapConsultationRow(r));
  }

  private mapConsultationRow(row: Record<string, unknown>): ArchitecturalConsultation {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      fromRole: String(row.from_role),
      toRole: 'architect',
      subject: String(row.subject),
      ambiguityOrBlocker: String(row.ambiguity_or_blocker),
      proposedAlternative: String(row.proposed_alternative),
      impactedArtifacts: JSON.parse(String(row.impacted_artifacts_json || '[]')),
      requiresPoIntervention: Boolean(row.requires_po_intervention),
      architectAssessment: row.architect_assessment ? String(row.architect_assessment) : undefined,
      poDecisionNotes: row.po_decision_notes ? String(row.po_decision_notes) : undefined,
      status: row.status as ConsultationStatus,
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    };
  }

  // ==========================================================================
  // QA REPORTS & VALIDATION (PHASE 4)
  // ==========================================================================

  recordQaReport(params: {
    projectId: string;
    authorRole: ActorRole;
    reportCode: string;
    payload: QaReportPayload;
    tracesTo: string[];
  }): { artifact: Artifact; reportId: string } {
    AuthorityGuard.assertCanEmitQaVerdict(params.authorRole);
    const markdown = this.formatQaReportMarkdown(params.reportCode, params.payload);
    const artifact = this.saveArtifact({
      projectId: params.projectId,
      code: params.reportCode,
      type: 'QA_REPORT',
      title: `QA Validation Report (${params.payload.recommendation})`,
      content: markdown,
      authorRole: params.authorRole,
      status: params.payload.recommendation === 'ACCEPT' ? 'APPROVED' : 'REJECTED',
      tracesTo: params.tracesTo,
    });

    const reportId = `qarep_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO qa_reports (id, project_id, artifact_id, payload_json, recommendation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reportId,
        params.projectId,
        artifact.id,
        JSON.stringify(params.payload),
        params.payload.recommendation,
        now,
      );

    // Transition project workflow phase based on QA verdict
    const nextPhase: WorkflowPhase =
      params.payload.recommendation === 'ACCEPT'
        ? 'PHASE_8_FINAL_ACCEPTANCE'
        : 'PHASE_7_CORRECTION_CYCLE';
    this.transitionPhase(params.projectId, nextPhase);

    return { artifact, reportId };
  }

  listQaReports(projectId: string): Array<{ id: string; artifactId: string; payload: QaReportPayload; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT * FROM qa_reports WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      artifactId: String(r.artifact_id),
      payload: JSON.parse(String(r.payload_json)) as QaReportPayload,
      createdAt: String(r.created_at),
    }));
  }

  private formatQaReportMarkdown(code: string, payload: QaReportPayload): string {
    return [
      `# ${code} — Independent QA Validation Report`,
      ``,
      `**Recommendation:** \`${payload.recommendation}\``,
      `**Summary:** ${payload.summary}`,
      ``,
      `## 1. Executed Tests (${payload.executedTests.length})`,
      ...payload.executedTests.map((t) => `- ${t}`),
      ``,
      `## 2. Passed Tests (${payload.passedTests.length})`,
      ...payload.passedTests.map((t) => `- [x] ${t}`),
      ``,
      `## 3. Failed Tests (${payload.failedTests.length})`,
      ...(payload.failedTests.length > 0
        ? payload.failedTests.map((t) => `- [ ] ${t}`)
        : ['- None']),
      ``,
      `## 4. Execution Evidence`,
      ...payload.evidences.map((e) => `\`\`\`text\n${e}\n\`\`\``),
      ``,
      `## 5. Identified Defects (${payload.defects.length})`,
      ...(payload.defects.length > 0
        ? payload.defects.map(
            (d) =>
              `- **[${d.code}] (${d.severity}) ${d.title}**: Violated criteria: ${d.violatedCriteria}. Evidence: \`${d.evidence}\``,
          )
        : ['- No open defects.']),
    ].join('\n');
  }

  // ==========================================================================
  // MULTI-MODEL ROUTING CONFIGS (PHASE 5)
  // ==========================================================================

  setRoleConfig(projectId: string, config: RoleModelConfig): void {
    this.db
      .prepare(
        `INSERT INTO role_configs (project_id, role, provider, model_id, temperature, execution_modality)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, role) DO UPDATE SET
           provider = excluded.provider,
           model_id = excluded.model_id,
           temperature = excluded.temperature,
           execution_modality = excluded.execution_modality`,
      )
      .run(
        projectId,
        config.role,
        config.provider,
        config.modelId,
        config.temperature,
        config.executionModality,
      );
  }

  assignModelToRole(params: {
    projectId: string;
    role: ActorRole | 'all';
    provider: LlmProviderType;
    modelId: string;
    temperature?: number;
  }): RoleModelConfig[] {
    const targetRoles: ActorRole[] =
      params.role === 'all'
        ? ['pm', 'architect', 'developer', 'qa']
        : [params.role];

    const updated: RoleModelConfig[] = [];
    for (const r of targetRoles) {
      const existing = this.getRoleConfig(params.projectId, r);
      const nextCfg: RoleModelConfig = {
        role: r,
        provider: params.provider,
        modelId: params.modelId,
        temperature: params.temperature ?? existing.temperature,
        executionModality: existing.executionModality,
      };
      this.setRoleConfig(params.projectId, nextCfg);
      updated.push(nextCfg);
    }
    return updated;
  }

  getRoleConfig(projectId: string, role: ActorRole): RoleModelConfig {
    const row = this.db
      .prepare(`SELECT * FROM role_configs WHERE project_id = ? AND role = ?`)
      .get(projectId, role) as Record<string, unknown> | undefined;
    if (!row) {
      return {
        role,
        provider: 'deterministic',
        modelId: 'default-specialist-model',
        temperature: 0.2,
        executionModality: 'LOCAL_PROCESS',
      };
    }
    return {
      role: String(row.role),
      provider: row.provider as LlmProviderType,
      modelId: String(row.model_id),
      temperature: Number(row.temperature),
      executionModality: row.execution_modality as ExecutionModality,
    };
  }

  listRoleConfigs(projectId: string): RoleModelConfig[] {
    const rows = this.db
      .prepare(`SELECT * FROM role_configs WHERE project_id = ? ORDER BY role ASC`)
      .all(projectId) as Record<string, unknown>[];
    return rows.map((row) => ({
      role: String(row.role),
      provider: row.provider as LlmProviderType,
      modelId: String(row.model_id),
      temperature: Number(row.temperature),
      executionModality: row.execution_modality as ExecutionModality,
    }));
  }

  // ==========================================================================
  // NOTEBOOKS & RAG STORAGE (PHASE 6)
  // ==========================================================================

  createNotebook(params: {
    name: string;
    description: string;
    dirPath: string;
    isGlobal?: boolean;
    allowedRoles?: ActorRole[];
    externalRefs?: Array<{ title: string; url: string; notes?: string }>;
  }): Notebook {
    const id = `nb_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const absDir = path.resolve(params.dirPath);
    fs.mkdirSync(absDir, { recursive: true });

    const allowedRoles = params.allowedRoles ?? ['architect', 'developer', 'qa'];
    const externalRefs = params.externalRefs ?? [];
    this.db
      .prepare(
        `INSERT INTO notebooks (
          id, name, description, dir_path, is_global, active,
          allowed_roles_json, external_refs_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.name,
        params.description,
        absDir,
        params.isGlobal ?? true ? 1 : 0,
        JSON.stringify(allowedRoles),
        JSON.stringify(externalRefs),
        now,
        now,
      );

    return this.getNotebook(id)!;
  }

  getNotebook(notebookId: string): Notebook | null {
    const row = this.db.prepare('SELECT * FROM notebooks WHERE id = ?').get(notebookId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapNotebookRow(row) : null;
  }

  listNotebooks(): Notebook[] {
    const rows = this.db.prepare('SELECT * FROM notebooks ORDER BY name ASC').all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.mapNotebookRow(r));
  }

  setNotebookActive(notebookId: string, active: boolean): Notebook {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE notebooks SET active = ?, updated_at = ? WHERE id = ?')
      .run(active ? 1 : 0, now, notebookId);
    return this.getNotebook(notebookId)!;
  }

  linkNotebookToProject(projectId: string, notebookId: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO project_notebooks (project_id, notebook_id) VALUES (?, ?)`)
      .run(projectId, notebookId);
  }

  unlinkNotebookFromProject(projectId: string, notebookId: string): void {
    this.db
      .prepare(`DELETE FROM project_notebooks WHERE project_id = ? AND notebook_id = ?`)
      .run(projectId, notebookId);
  }

  getProjectNotebooks(projectId: string, role?: ActorRole): Notebook[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM notebooks n
         INNER JOIN project_notebooks pn ON pn.notebook_id = n.id
         WHERE pn.project_id = ? AND n.active = 1`,
      )
      .all(projectId) as Record<string, unknown>[];
    const notebooks = rows.map((r) => this.mapNotebookRow(r));
    if (!role || role === 'product_owner') return notebooks;
    return notebooks.filter((nb) => nb.allowedRoles.includes(role));
  }

  private mapNotebookRow(row: Record<string, unknown>): Notebook {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      dirPath: String(row.dir_path),
      isGlobal: Boolean(row.is_global),
      active: Boolean(row.active),
      allowedRoles: JSON.parse(String(row.allowed_roles_json || '[]')),
      externalRefs: JSON.parse(String(row.external_refs_json || '[]')),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // ==========================================================================
  // 4-LAYER MEMORY SYSTEM (PHASE 7)
  // ==========================================================================

  upsertMemory(params: {
    projectId: string;
    layer: MemoryLayer;
    agentRole?: ActorRole;
    key: string;
    value: string;
  }): MemoryEntry {
    const existing = this.db
      .prepare(
        `SELECT id FROM memories WHERE project_id = ? AND layer = ? AND IFNULL(agent_role, '') = ? AND key = ?`,
      )
      .get(params.projectId, params.layer, params.agentRole ?? '', params.key) as
      | { id: string }
      | undefined;

    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(`UPDATE memories SET value = ?, updated_at = ? WHERE id = ?`)
        .run(params.value, now, existing.id);
      this.db
        .prepare(`DELETE FROM memories_fts WHERE memory_id = ?`)
        .run(existing.id);
      this.db
        .prepare(
          `INSERT INTO memories_fts (memory_id, project_id, layer, agent_role, key, value)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          existing.id,
          params.projectId,
          params.layer,
          params.agentRole ?? '',
          params.key,
          params.value,
        );
      return this.listMemories(params.projectId, params.layer, params.agentRole).find(
        (m) => m.id === existing.id,
      )!;
    }

    const id = `mem_${crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO memories (id, project_id, layer, agent_role, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.projectId,
        params.layer,
        params.agentRole ?? null,
        params.key,
        params.value,
        now,
        now,
      );
    this.db
      .prepare(
        `INSERT INTO memories_fts (memory_id, project_id, layer, agent_role, key, value)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.projectId,
        params.layer,
        params.agentRole ?? '',
        params.key,
        params.value,
      );

    return {
      id,
      projectId: params.projectId,
      layer: params.layer,
      agentRole: params.agentRole,
      key: params.key,
      value: params.value,
      createdAt: now,
      updatedAt: now,
    };
  }

  listMemories(projectId: string, layer?: MemoryLayer, agentRole?: ActorRole): MemoryEntry[] {
    let sql = `SELECT * FROM memories WHERE project_id = ?`;
    const args: Array<string> = [projectId];
    if (layer) {
      sql += ` AND layer = ?`;
      args.push(layer);
    }
    if (agentRole) {
      sql += ` AND (agent_role = ? OR agent_role IS NULL)`;
      args.push(agentRole);
    }
    sql += ` ORDER BY updated_at DESC`;
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      layer: r.layer as MemoryLayer,
      agentRole: r.agent_role ? String(r.agent_role) : undefined,
      key: String(r.key),
      value: String(r.value),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  // ==========================================================================
  // COORDINATOR AUDIT LOG, INTER-AGENT MESSAGES & IDEMPOTENCY (ISSUE #10)
  // ==========================================================================

  getIdempotentResult<T>(requestId: string): T | null {
    const row = this.db
      .prepare(`SELECT response_json FROM coordinator_idempotency WHERE request_id = ?`)
      .get(requestId) as { response_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.response_json) as T;
    } catch {
      return null;
    }
  }

  saveIdempotentResult(
    requestId: string,
    projectId: string,
    role: ActorRole,
    action: string,
    result: unknown,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO coordinator_idempotency (
          request_id, project_id, agent_role, action, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(requestId, projectId, role, action, JSON.stringify(result), now);
  }

  recordAuditLogEntry(
    entry: Omit<CoordinatorAuditLogEntry, 'id' | 'createdAt'>,
  ): CoordinatorAuditLogEntry {
    const id = `aud_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO coordinator_audit_log (
          id, project_id, agent_role, operation_type, action, request_id, status, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.projectId,
        entry.agentRole,
        entry.operationType,
        entry.action,
        entry.requestId ?? null,
        entry.status,
        JSON.stringify(entry.details ?? {}),
        now,
      );

    return {
      id,
      projectId: entry.projectId,
      agentRole: entry.agentRole,
      operationType: entry.operationType,
      action: entry.action,
      requestId: entry.requestId,
      status: entry.status,
      details: entry.details ?? {},
      createdAt: now,
    };
  }

  listAuditLogEntries(
    projectId: string,
    role?: ActorRole,
    limit = 100,
  ): CoordinatorAuditLogEntry[] {
    let sql = `SELECT * FROM coordinator_audit_log WHERE project_id = ?`;
    const args: (string | number)[] = [projectId];
    if (role) {
      sql += ` AND agent_role = ?`;
      args.push(role);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    args.push(limit);

    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      agentRole: r.agent_role as ActorRole,
      operationType: r.operation_type as 'READ' | 'WRITE',
      action: String(r.action),
      requestId: r.request_id ? String(r.request_id) : undefined,
      status: r.status as 'ACCEPTED' | 'REJECTED' | 'DUPLICATE',
      details: r.details_json ? JSON.parse(String(r.details_json)) : {},
      createdAt: String(r.created_at),
    }));
  }

  saveInterAgentMessage(
    msg: Omit<InterAgentMessage, 'id' | 'createdAt'>,
  ): InterAgentMessage {
    const id = `iam_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const payloadJson =
      typeof msg.payload === 'string'
        ? msg.payload
        : JSON.stringify(msg.payload ?? {});

    this.db
      .prepare(
        `INSERT INTO inter_agent_messages (
          id, project_id, request_id, from_role, to_role, type, payload_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        msg.projectId,
        msg.requestId ?? null,
        msg.fromRole,
        msg.toRole,
        msg.type,
        payloadJson,
        msg.status ?? 'DELIVERED',
        now,
      );

    return {
      id,
      projectId: msg.projectId,
      requestId: msg.requestId,
      fromRole: msg.fromRole,
      toRole: msg.toRole,
      type: msg.type,
      payload: msg.payload,
      status: msg.status ?? 'DELIVERED',
      createdAt: now,
    };
  }

  listInterAgentMessages(
    projectId: string,
    filter?: { role?: ActorRole; type?: InterAgentMessageType },
  ): InterAgentMessage[] {
    let sql = `SELECT * FROM inter_agent_messages WHERE project_id = ?`;
    const args: string[] = [projectId];
    if (filter?.role) {
      sql += ` AND (from_role = ? OR to_role = ? OR to_role = 'broadcast')`;
      args.push(filter.role, filter.role);
    }
    if (filter?.type) {
      sql += ` AND type = ?`;
      args.push(filter.type);
    }
    sql += ` ORDER BY created_at ASC`;

    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map((r) => {
      let payload: Record<string, unknown> | string = String(r.payload_json ?? '');
      try {
        payload = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // Keep as string
      }
      return {
        id: String(r.id),
        projectId: String(r.project_id),
        requestId: r.request_id ? String(r.request_id) : undefined,
        fromRole: r.from_role as ActorRole,
        toRole: r.to_role as ActorRole | 'broadcast',
        type: r.type as InterAgentMessageType,
        payload,
        status: (r.status as 'DELIVERED' | 'PROCESSED' | 'ACKNOWLEDGED') ?? 'DELIVERED',
        createdAt: String(r.created_at),
      };
    });
  }

  close(): void {
    this.db.close();
  }
}

