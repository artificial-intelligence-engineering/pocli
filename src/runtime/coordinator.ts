import { EventEmitter } from 'node:events';
import {
  ActorRole,
  Artifact,
  ArtifactType,
  CoordinatorAuditLogEntry,
  CoordinatorAuthorityError,
  InterAgentMessage,
  InterAgentMessageType,
  Project,
  QaReportPayload,
  StaleArtifactVersionError,
  WorkflowPhase,
} from '../core/contracts.js';
import { AuthorityGuard } from '../core/workflow.js';
import { PoCliDatabase, StoredMessage } from '../storage/database.js';
import { Logger } from '../core/logger.js';

/**
 * Sequential asynchronous write queue to ensure SQLite writes are serialized
 * into short, atomic transactions without database locks or deadlocks.
 */
class CoordinatorWriteQueue {
  private chain: Promise<unknown> = Promise.resolve();

  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.chain = this.chain
        .catch(() => {}) // Prevent previous rejections from breaking the queue
        .then(async () => {
          try {
            const res = await task();
            resolve(res);
          } catch (err) {
            reject(err);
          }
        });
    });
  }
}

/**
 * PoCliCoordinator — Sole Write Owner for Project State in SQLite.
 *
 * Agents are NOT permitted to open the SQLite database or issue arbitrary SQL.
 * All mutations pass through this Coordinator, which:
 * 1. Validates agent role authority and workflow phase constraints via AuthorityGuard.
 * 2. Enforces optimistic concurrency on artifact updates via expectedVersion.
 * 3. Enforces idempotency via requestId to avoid duplicate messages or artifacts.
 * 4. Serializes all writes through short atomic transactions.
 * 5. Logs every read, write, and inter-agent communication in coordinator_audit_log.
 * 6. Dispatches structured inter-agent messages through the autonomous event bus.
 */
export class PoCliCoordinator extends EventEmitter {
  private readonly writeQueue = new CoordinatorWriteQueue();

  constructor(public readonly storage: PoCliDatabase) {
    super();
  }

  // ==========================================================================
  // CENTRALIZED WRITE OPERATIONS (SOLE WRITE OWNER)
  // ==========================================================================

  /**
   * Persists a versioned artifact on behalf of an agent role.
   * Validates author authority, checks optimistic concurrency, and audits the operation.
   */
  async saveArtifact(params: {
    projectId: string;
    role: ActorRole;
    code: string;
    type: ArtifactType;
    title: string;
    content: string;
    expectedVersion?: number;
    requestId?: string;
    tracesTo?: string[];
    citations?: string[];
    customRelPath?: string;
  }): Promise<Artifact> {
    return this.writeQueue.enqueue(async () => {
      // 1. Check idempotency
      if (params.requestId) {
        const cached = this.storage.getIdempotentResult<Artifact>(params.requestId);
        if (cached) {
          this.storage.recordAuditLogEntry({
            projectId: params.projectId,
            agentRole: params.role,
            operationType: 'WRITE',
            action: 'saveArtifact',
            requestId: params.requestId,
            status: 'DUPLICATE',
            details: { code: params.code, version: cached.version, cached: true },
          });
          return cached;
        }
      }

      // 2. Validate author authority
      if (!AuthorityGuard.canWriteArtifact(params.role, params.type)) {
        this.storage.recordAuditLogEntry({
          projectId: params.projectId,
          agentRole: params.role,
          operationType: 'WRITE',
          action: 'saveArtifact',
          requestId: params.requestId,
          status: 'REJECTED',
          details: {
            code: params.code,
            type: params.type,
            reason: `Role '${params.role}' is not authorized to create or modify '${params.type}'.`,
          },
        });
        AuthorityGuard.assertCanWriteArtifact(params.role, params.type);
      }

      // 3. Save artifact with optimistic concurrency verification
      try {
        const artifact = this.storage.saveArtifact({
          projectId: params.projectId,
          code: params.code,
          type: params.type,
          title: params.title,
          content: params.content,
          authorRole: params.role,
          expectedVersion: params.expectedVersion,
          requestId: params.requestId,
          tracesTo: params.tracesTo,
          citations: params.citations,
          customRelPath: params.customRelPath,
        });

        this.storage.recordAuditLogEntry({
          projectId: params.projectId,
          agentRole: params.role,
          operationType: 'WRITE',
          action: 'saveArtifact',
          requestId: params.requestId,
          status: 'ACCEPTED',
          details: {
            code: artifact.code,
            version: artifact.version,
            type: artifact.type,
            status: artifact.status,
          },
        });

        this.emit('artifact:saved', { artifact, role: params.role });
        return artifact;
      } catch (err) {
        if (err instanceof StaleArtifactVersionError) {
          this.storage.recordAuditLogEntry({
            projectId: params.projectId,
            agentRole: params.role,
            operationType: 'WRITE',
            action: 'saveArtifact',
            requestId: params.requestId,
            status: 'REJECTED',
            details: {
              code: params.code,
              expectedVersion: params.expectedVersion,
              conflict: (err as Error).message,
            },
          });
        }
        throw err;
      }
    });
  }

  /**
   * Records a dialogue or inter-agent turn in the SQLite Session Tree DAG.
   */
  async recordMessage(params: {
    projectId: string;
    fromRole: ActorRole;
    toRole: ActorRole;
    content: string;
    requestId?: string;
    parentId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<StoredMessage> {
    return this.writeQueue.enqueue(async () => {
      // 1. Check idempotency
      if (params.requestId) {
        const cached = this.storage.getIdempotentResult<StoredMessage>(params.requestId);
        if (cached) {
          this.storage.recordAuditLogEntry({
            projectId: params.projectId,
            agentRole: params.fromRole,
            operationType: 'WRITE',
            action: 'recordMessage',
            requestId: params.requestId,
            status: 'DUPLICATE',
            details: { messageId: cached.id, cached: true },
          });
          return cached;
        }
      }

      // 2. Validate communication channel authority
      const project = this.storage.getProject(params.projectId);
      if (!project) throw new Error(`Project ${params.projectId} not found.`);

      if (!AuthorityGuard.canCommunicate(params.fromRole, params.toRole, project.phase)) {
        this.storage.recordAuditLogEntry({
          projectId: params.projectId,
          agentRole: params.fromRole,
          operationType: 'WRITE',
          action: 'recordMessage',
          requestId: params.requestId,
          status: 'REJECTED',
          details: {
            fromRole: params.fromRole,
            toRole: params.toRole,
            phase: project.phase,
            reason: 'Communication not permitted between roles in current phase.',
          },
        });
        throw new CoordinatorAuthorityError(
          params.fromRole,
          'recordMessage',
          `Cannot communicate with '${params.toRole}' in phase '${project.phase}'.`,
        );
      }

      // 3. Record message
      const msg = this.storage.recordMessage({
        projectId: params.projectId,
        fromRole: params.fromRole,
        toRole: params.toRole,
        content: params.content,
        parentId: params.parentId,
        metadata: params.metadata,
        requestId: params.requestId,
      });

      this.storage.recordAuditLogEntry({
        projectId: params.projectId,
        agentRole: params.fromRole,
        operationType: 'WRITE',
        action: 'recordMessage',
        requestId: params.requestId,
        status: 'ACCEPTED',
        details: { messageId: msg.id, toRole: params.toRole },
      });

      this.emit('message:recorded', msg);
      return msg;
    });
  }

  /**
   * Routes an autonomous structured message between active agents.
   */
  async sendInterAgentMessage(params: {
    projectId: string;
    fromRole: ActorRole;
    toRole: ActorRole | 'broadcast';
    type: InterAgentMessageType;
    payload: Record<string, unknown> | string;
    requestId?: string;
  }): Promise<InterAgentMessage> {
    return this.writeQueue.enqueue(async () => {
      // 1. Check idempotency
      if (params.requestId) {
        const cached = this.storage.getIdempotentResult<InterAgentMessage>(params.requestId);
        if (cached) {
          this.storage.recordAuditLogEntry({
            projectId: params.projectId,
            agentRole: params.fromRole,
            operationType: 'WRITE',
            action: 'sendInterAgentMessage',
            requestId: params.requestId,
            status: 'DUPLICATE',
            details: { messageId: cached.id, cached: true },
          });
          return cached;
        }
      }

      // 2. Validate authority
      const project = this.storage.getProject(params.projectId);
      if (!project) throw new Error(`Project ${params.projectId} not found.`);

      if (params.toRole !== 'broadcast') {
        if (!AuthorityGuard.canCommunicate(params.fromRole, params.toRole, project.phase)) {
          this.storage.recordAuditLogEntry({
            projectId: params.projectId,
            agentRole: params.fromRole,
            operationType: 'WRITE',
            action: 'sendInterAgentMessage',
            requestId: params.requestId,
            status: 'REJECTED',
            details: {
              fromRole: params.fromRole,
              toRole: params.toRole,
              type: params.type,
              phase: project.phase,
            },
          });
          throw new CoordinatorAuthorityError(
            params.fromRole,
            'sendInterAgentMessage',
            `Cannot send inter-agent message to '${params.toRole}' in phase '${project.phase}'.`,
          );
        }
      }

      // 3. Persist inter-agent message
      const iam = this.storage.saveInterAgentMessage({
        projectId: params.projectId,
        requestId: params.requestId,
        fromRole: params.fromRole,
        toRole: params.toRole,
        type: params.type,
        payload: params.payload,
        status: 'DELIVERED',
      });

      if (params.requestId) {
        this.storage.saveIdempotentResult(
          params.requestId,
          params.projectId,
          params.fromRole,
          'sendInterAgentMessage',
          iam,
        );
      }

      this.storage.recordAuditLogEntry({
        projectId: params.projectId,
        agentRole: params.fromRole,
        operationType: 'WRITE',
        action: 'sendInterAgentMessage',
        requestId: params.requestId,
        status: 'ACCEPTED',
        details: { messageId: iam.id, toRole: params.toRole, type: params.type },
      });

      Logger.info(
        'COORDINATOR',
        `Inter-agent message: [${params.fromRole} -> ${params.toRole}] (${params.type})`,
      );

      this.emit('inter-agent-message', iam);
      return iam;
    });
  }

  /**
   * Submits a formal QA validation report and verdict.
   */
  async submitQaReport(params: {
    projectId: string;
    role: ActorRole;
    artifactId: string;
    payload: QaReportPayload;
    recommendation: 'ACCEPT' | 'REJECT';
    requestId?: string;
  }): Promise<{ reportId: string; artifact: Artifact }> {
    return this.writeQueue.enqueue(async () => {
      // 1. Authority: Only QA can emit a QA report and validation verdict
      AuthorityGuard.assertCanEmitQaVerdict(params.role);

      // 2. Check idempotency
      if (params.requestId) {
        const cached = this.storage.getIdempotentResult<{ reportId: string; artifact: Artifact }>(
          params.requestId,
        );
        if (cached) return cached;
      }

      // 3. Save report and update project workflow phase
      const project = this.storage.getProject(params.projectId);
      if (!project) throw new Error(`Project ${params.projectId} not found.`);

      const artifacts = this.storage.listArtifacts(project.id, true);
      const qaArtifacts = artifacts.filter((a) => a.type === 'QA_REPORT');
      const reportCode = `QA-${String(qaArtifacts.length + 1).padStart(3, '0')}`;

      const reportContent = [
        `# Independent QA Validation Report (${reportCode})`,
        `**Recommendation:** **${params.recommendation}**`,
        `**PassedTests:** ${params.payload.passedTests.length} / ${params.payload.executedTests.length}`,
        `**Defects:** ${params.payload.defects.length}`,
        ``,
        `## Summary`,
        params.payload.summary,
      ].join('\n\n');

      const artifact = this.storage.saveArtifact({
        projectId: project.id,
        code: reportCode,
        type: 'QA_REPORT',
        title: `QA Validation Report — ${params.recommendation}`,
        content: reportContent,
        authorRole: 'qa',
        status: params.recommendation === 'ACCEPT' ? 'APPROVED' : 'REJECTED',
        tracesTo: [params.artifactId],
      });

      const reportId = `qar_${Date.now()}`;
      this.storage.db
        .prepare(
          `INSERT INTO qa_reports (id, project_id, artifact_id, payload_json, recommendation, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reportId,
          project.id,
          artifact.id,
          JSON.stringify(params.payload),
          params.recommendation,
          new Date().toISOString(),
        );

      const result = { reportId, artifact };
      if (params.requestId) {
        this.storage.saveIdempotentResult(
          params.requestId,
          project.id,
          params.role,
          'submitQaReport',
          result,
        );
      }

      this.storage.recordAuditLogEntry({
        projectId: project.id,
        agentRole: params.role,
        operationType: 'WRITE',
        action: 'submitQaReport',
        requestId: params.requestId,
        status: 'ACCEPTED',
        details: {
          reportId,
          code: reportCode,
          recommendation: params.recommendation,
          defects: params.payload.defects.length,
        },
      });

      return result;
    });
  }

  /**
   * Transitions the project phase under authority validation.
   */
  async transitionPhase(params: {
    projectId: string;
    role: ActorRole;
    targetPhase: WorkflowPhase;
    requestId?: string;
  }): Promise<Project> {
    return this.writeQueue.enqueue(async () => {
      const project = this.storage.getProject(params.projectId);
      if (!project) throw new Error(`Project ${params.projectId} not found.`);

      AuthorityGuard.assertTransition(project.phase, params.targetPhase);

      const updated = this.storage.transitionPhase(project.id, params.targetPhase);

      this.storage.recordAuditLogEntry({
        projectId: project.id,
        agentRole: params.role,
        operationType: 'WRITE',
        action: 'transitionPhase',
        requestId: params.requestId,
        status: 'ACCEPTED',
        details: { from: project.phase, to: params.targetPhase },
      });

      this.emit('phase:transitioned', { from: project.phase, to: params.targetPhase, project: updated });
      return updated;
    });
  }

  // ==========================================================================
  // TYPED READ OPERATIONS (AGENTS DO NOT ISSUE DIRECT SQL)
  // ==========================================================================

  /**
   * Returns an authorized context snapshot for a specialist role without allowing arbitrary SQL.
   */
  readContextSnapshot(params: {
    projectId: string;
    role: ActorRole;
    recentLimit?: number;
  }): {
    project: Project;
    normativeArtifacts: Artifact[];
    recentMessages: StoredMessage[];
    interAgentMessages: InterAgentMessage[];
    workingMemory: Record<string, string>;
  } {
    const project = this.storage.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    const normativeArtifacts = this.storage.listArtifacts(params.projectId, true);
    const recentMessages = this.storage
      .listMessages(params.projectId, params.role, true)
      .slice(-(params.recentLimit ?? 10));
    const interAgentMessages = this.storage.listInterAgentMessages(params.projectId, {
      role: params.role,
    });

    const memoryEntries = this.storage.listMemories(params.projectId, 'WORKING', params.role);
    const workingMemory: Record<string, string> = {};
    for (const m of memoryEntries) {
      workingMemory[m.key] = m.value;
    }

    this.storage.recordAuditLogEntry({
      projectId: params.projectId,
      agentRole: params.role,
      operationType: 'READ',
      action: 'readContextSnapshot',
      status: 'ACCEPTED',
      details: {
        artifactsCount: normativeArtifacts.length,
        messagesCount: recentMessages.length,
        interAgentCount: interAgentMessages.length,
      },
    });

    return {
      project,
      normativeArtifacts,
      recentMessages,
      interAgentMessages,
      workingMemory,
    };
  }

  getArtifact(projectId: string, code: string): Artifact | null {
    return this.storage.getLatestArtifactByCode(projectId, code);
  }

  listArtifacts(projectId: string, onlyLatest = true): Artifact[] {
    return this.storage.listArtifacts(projectId, onlyLatest);
  }

  listInterAgentMessages(
    projectId: string,
    filter?: { role?: ActorRole; type?: InterAgentMessageType },
  ): InterAgentMessage[] {
    return this.storage.listInterAgentMessages(projectId, filter);
  }

  getAuditLog(
    projectId: string,
    role?: ActorRole,
    limit = 100,
  ): CoordinatorAuditLogEntry[] {
    return this.storage.listAuditLogEntries(projectId, role, limit);
  }
}
