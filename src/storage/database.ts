import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ActorRole,
  ApprovalRecord,
  ArchitecturalConsultation,
  Artifact,
  ArtifactStatus,
  ArtifactType,
  ConsultationStatus,
  ExecutionModality,
  LlmProviderType,
  MemoryEntry,
  MemoryLayer,
  Notebook,
  PmConsolidationReport,
  Project,
  QaReportPayload,
  RagCitation,
  RoleModelConfig,
  WorkflowPhase,
} from '../core/contracts.js';
import { AppSettings, SupportedLanguage } from '../core/i18n.js';
import { AuthorityGuard } from '../core/workflow.js';

export interface StoredMessage {
  id: string;
  projectId: string;
  sessionId: string;
  fromRole: ActorRole;
  toRole: ActorRole;
  content: string;
  metadataJson: string;
  createdAt: string;
}

export interface ExpertChatExchangeSnippet {
  fromRole: ActorRole;
  toRole: ActorRole;
  snippet: string;
  createdAt: string;
}

export interface ExpertChatSummary {
  projectId: string;
  expertRole: ActorRole;
  totalMessages: number;
  lastUserPrompt: string;
  lastExpertReply: string;
  summaryText: string;
  recentExchanges: ExpertChatExchangeSnippet[];
  updatedAt: string;
}

export class PoCliDatabase {
  public readonly db: DatabaseSync;

  constructor(dbFilePath: string) {
    const dir = path.dirname(dbFilePath);
    if (dbFilePath !== ':memory:' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbFilePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
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
        from_role TEXT NOT NULL,
        to_role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
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
    `);
  }

  // ==========================================================================
  // APPLICATION SETTINGS (MULTI-LANGUAGE & FUTURE PREFERENCES)
  // ==========================================================================

  getSettings(): AppSettings {
    const langRow = this.db
      .prepare(`SELECT value FROM settings WHERE key = 'language'`)
      .get() as { value: string } | undefined;
    const lang: SupportedLanguage =
      langRow?.value === 'es' ? 'es' : 'en';
    return {
      language: lang,
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
    return this.getSettings();
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
    fs.mkdirSync(path.join(workspaceDir, '.pocli', 'artifacts'), { recursive: true });

    const phase: WorkflowPhase = 'PHASE_2_ARCHITECT_ANALYSIS';
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, workspace_dir, phase, approved_architecture_version, correction_cycle_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(id, params.name, params.description, workspaceDir, phase, now, now);

    // Initialize default multi-model role configs for the 3 core specialists
    this.setRoleConfig(id, {
      role: 'architect',
      provider: 'deterministic',
      modelId: 'claude-3-7-sonnet-architect',
      temperature: 0.2,
      executionModality: 'LOCAL_PROCESS',
    });
    this.setRoleConfig(id, {
      role: 'developer',
      provider: 'deterministic',
      modelId: 'claude-3-7-sonnet-coder',
      temperature: 0.1,
      executionModality: 'LOCAL_PROCESS',
    });
    this.setRoleConfig(id, {
      role: 'qa',
      provider: 'deterministic',
      modelId: 'gpt-4o-qa-verifier',
      temperature: 0.0,
      executionModality: 'LOCAL_PROCESS',
    });
    this.setRoleConfig(id, {
      role: 'pm',
      provider: 'deterministic',
      modelId: 'gemini-2.5-pro-pm',
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

    return this.getProject(id)!;
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
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapProjectRow(r));
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
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      workspaceDir: String(row.workspace_dir),
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

  recordMessage(params: {
    projectId: string;
    fromRole: ActorRole;
    toRole: ActorRole;
    content: string;
    metadata?: Record<string, unknown>;
  }): StoredMessage {
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

    const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;
    const metadataJson = JSON.stringify(params.metadata ?? {});
    this.db
      .prepare(
        `INSERT INTO messages (id, project_id, session_id, from_role, to_role, content, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msgId,
        params.projectId,
        sessionRow.id,
        params.fromRole,
        params.toRole,
        params.content,
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

    return {
      id: msgId,
      projectId: params.projectId,
      sessionId: sessionRow.id,
      fromRole: params.fromRole,
      toRole: params.toRole,
      content: params.content,
      metadataJson,
      createdAt: now,
    };
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

    if (!row) {
      return {
        projectId,
        expertRole,
        totalMessages: 0,
        lastUserPrompt: '',
        lastExpertReply: '',
        summaryText: '',
        recentExchanges: [],
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      projectId: String(row.project_id),
      expertRole: String(row.expert_role),
      totalMessages: Number(row.total_messages),
      lastUserPrompt: String(row.last_user_prompt),
      lastExpertReply: String(row.last_expert_reply),
      summaryText: String(row.summary_text),
      recentExchanges: JSON.parse(
        String(row.recent_exchanges_json || '[]'),
      ) as ExpertChatExchangeSnippet[],
      updatedAt: String(row.updated_at),
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

  listMessages(projectId: string, roleFilter?: ActorRole): StoredMessage[] {
    const rows = roleFilter
      ? (this.db
          .prepare(
            `SELECT * FROM messages WHERE project_id = ? AND (from_role = ? OR to_role = ?) ORDER BY created_at ASC`,
          )
          .all(projectId, roleFilter, roleFilter) as Record<string, unknown>[])
      : (this.db
          .prepare(`SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC`)
          .all(projectId) as Record<string, unknown>[]);

    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      sessionId: String(r.session_id),
      fromRole: String(r.from_role),
      toRole: String(r.to_role),
      content: String(r.content),
      metadataJson: String(r.metadata_json),
      createdAt: String(r.created_at),
    }));
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
  }): Artifact {
    AuthorityGuard.assertCanWriteArtifact(params.authorRole, params.type);
    const project = this.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    const latest = this.db
      .prepare(
        `SELECT id, version FROM artifacts WHERE project_id = ? AND code = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(params.projectId, params.code) as { id: string; version: number } | undefined;

    const nextVersion = latest ? latest.version + 1 : 1;
    if (latest) {
      this.db
        .prepare(`UPDATE artifacts SET status = 'SUPERSEDED' WHERE id = ? AND status != 'APPROVED'`)
        .run(latest.id);
    }

    const sha256 = crypto.createHash('sha256').update(params.content, 'utf8').digest('hex');
    const relPath =
      params.customRelPath ??
      path.join('.pocli', 'artifacts', params.type.toLowerCase(), `${params.code}_v${nextVersion}.md`);
    const absPath = path.join(project.workspaceDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, params.content, 'utf8');

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

    return this.getArtifactById(id)!;
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
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      code: String(row.code),
      type: row.type as ArtifactType,
      title: String(row.title),
      content: String(row.content),
      version: Number(row.version),
      status: row.status as ArtifactStatus,
      authorRole: String(row.author_role),
      filePath: String(row.file_path),
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

  close(): void {
    this.db.close();
  }
}

