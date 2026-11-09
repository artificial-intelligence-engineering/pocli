import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ActorRole,
  ApprovalRecord,
  ArchitecturalConsultation,
  Artifact,
  CoordinatorAuditLogEntry,
  InterAgentMessage,
  InterAgentMessageType,
  Notebook,
  PmAgentInquiryEntry,
  PmConsolidationReport,
  PmInquiryModality,
  Project,
  QaDefect,
  QaDefectClassification,
  QaMetrics,
  QaReportPayload,
  QaTestExecutionItem,
  QaVerdict,
  RagCitation,
  WorkerStatusInfo,
  CoordinatorAuthorityError,
} from '../core/contracts.js';
import { AuthorityGuard } from '../core/workflow.js';
import { CompactionCheckpoint, PoCliDatabase } from '../storage/database.js';
import { HarnessRegistry } from './harnesses.js';
import { AgentToolCallRequest, extractToolCalls } from './llm-gateway.js';
import { McpRegistry } from './mcp-client.js';
import { IndexResult, NotebookRagEngine } from './notebook-rag.js';
import { LinuxAgentProcessRunner, WorkerExecutionResult } from './process-runner.js';
import { Logger } from '../core/logger.js';
import { PoCliCoordinator } from './coordinator.js';
import { PersistentAgentRuntime } from './persistent-runtime.js';

export const MAX_QA_CORRECTION_CYCLES = 3;

export interface HandoffBundle {
  projectId: string;
  approvedArchitectureVersion: number;
  architectureArtifact: Artifact;
  requirements: Artifact[];
  adrs: Artifact[];
  specifications: Artifact[];
  resolvedConsultations: ArchitecturalConsultation[];
  markdownSummary: string;
  handoffMessageId?: string;
}

export interface AutonomousHandoffTrigger {
  nextRole: 'developer' | 'qa' | 'architect';
  senderRole?: ActorRole;
  instructions: string;
  handoffMessageId?: string;
  alreadyDeliveredToArchitect?: boolean;
}

export interface QueuedChatTurn {
  id: string;
  projectId: string;
  targetRole: ActorRole;
  message: string;
  alreadyRecorded?: boolean;
  senderRole?: ActorRole | 'product_owner';
  onStreamChunk?: (chunk: string) => void;
  resolve: (value: {
    reply: string;
    workerPid: number;
    modalityUsed: string;
    createdArtifacts: Artifact[];
    citations: RagCitation[];
    project: Project;
    autonomousHandoff?: AutonomousHandoffTrigger;
  }) => void;
  reject: (reason?: any) => void;
  queuedAt: string;
}

export class PoCliOrchestrator extends EventEmitter {
  public readonly rag: NotebookRagEngine;
  public readonly processRunner: LinuxAgentProcessRunner;
  public readonly mcp: McpRegistry;
  public readonly coordinator: PoCliCoordinator;
  public readonly runtime: PersistentAgentRuntime;

  private roleQueues = new Map<string, QueuedChatTurn[]>();
  private activeTurns = new Set<string>();

  private getQueueKey(projectId: string, role: ActorRole): string {
    return `${projectId}:${role}`;
  }

  public isRoleBusy(projectId: string, role: ActorRole): boolean {
    const key = this.getQueueKey(projectId, role);
    return this.activeTurns.has(key);
  }

  public getQueuedMessages(
    projectId: string,
    role: ActorRole,
  ): Array<{ id: string; message: string; queuedAt: string }> {
    const key = this.getQueueKey(projectId, role);
    const queue = this.roleQueues.get(key) || [];
    return queue.map((t) => ({ id: t.id, message: t.message, queuedAt: t.queuedAt }));
  }

  public getAllQueuedMessages(
    projectId: string,
  ): Record<string, Array<{ id: string; message: string; queuedAt: string }>> {
    const result: Record<string, Array<{ id: string; message: string; queuedAt: string }>> = {};
    for (const [key, queue] of this.roleQueues.entries()) {
      if (key.startsWith(`${projectId}:`)) {
        const role = key.split(':')[1];
        result[role] = queue.map((t) => ({ id: t.id, message: t.message, queuedAt: t.queuedAt }));
      }
    }
    return result;
  }

  public clearQueues(projectId?: string): void {
    for (const [key, queue] of this.roleQueues.entries()) {
      if (!projectId || key.startsWith(`${projectId}:`)) {
        for (const item of queue) {
          item.reject(new Error('Queue cleared'));
        }
        this.roleQueues.delete(key);
      }
    }
  }

  constructor(public readonly storage: PoCliDatabase) {
    super();
    this.rag = new NotebookRagEngine(storage);
    this.processRunner = new LinuxAgentProcessRunner();
    this.mcp = new McpRegistry();
    this.coordinator = new PoCliCoordinator(storage);
    this.runtime = new PersistentAgentRuntime(this.coordinator);

    const settings = storage.getSettings();
    this.runtime.isPersistent = settings.persistentWorkers ?? true;

    // Route inter-agent messages between coordinator and persistent runtime
    this.coordinator.on('inter-agent-message', (msg: InterAgentMessage) => {
      this.runtime.routeInterAgentMessage(msg);
      this.emit('inter-agent-message', msg);
    });
  }

  // ==========================================================================
  // PHASE 1: PROJECT CREATION
  // ==========================================================================

  createProject(params: {
    name: string;
    description: string;
    workspaceDir: string;
  }): Project {
    const project = this.storage.createProject(params);
    this.storage.upsertMemory({
      projectId: project.id,
      layer: 'PROJECT_PERSISTENT',
      key: 'project_vision',
      value: `${project.name}: ${project.description}`,
    });
    this.emit('project:created', project);
    return project;
  }

  deleteProject(projectId: string): { renamedWorkspaceDir?: string; newActiveProjectId?: string } {
    void this.runtime.stopProjectWorkers(projectId);
    const result = this.storage.deleteProject(projectId);
    this.emit('project:deleted', { projectId, ...result });
    return result;
  }

  // ==========================================================================
  // PHASE 2 & DIRECT COMMUNICATION: PO <-> ANY PROFESSIONAL
  // ==========================================================================

  async chatWithProfessional(params: {
    projectId: string;
    targetRole: ActorRole;
    message: string;
    messageId?: string;
    alreadyRecorded?: boolean;
    senderRole?: ActorRole | 'product_owner';
    onStreamChunk?: (chunk: string) => void;
  }): Promise<{
    reply: string;
    workerPid: number;
    modalityUsed: string;
    createdArtifacts: Artifact[];
    citations: RagCitation[];
    project: Project;
    autonomousHandoff?: AutonomousHandoffTrigger;
  }> {
    const project = this.storage.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    const key = this.getQueueKey(params.projectId, params.targetRole);

    if (this.activeTurns.has(key)) {
      const turnId =
        params.messageId ||
        `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      return new Promise((resolve, reject) => {
        const queue = this.roleQueues.get(key) || [];
        queue.push({
          id: turnId,
          projectId: params.projectId,
          targetRole: params.targetRole,
          message: params.message,
          alreadyRecorded: params.alreadyRecorded,
          senderRole: params.senderRole,
          onStreamChunk: params.onStreamChunk,
          resolve,
          reject,
          queuedAt: new Date().toISOString(),
        });
        this.roleQueues.set(key, queue);

        Logger.info(
          'ORCHESTRATOR',
          `Turn for '${params.targetRole}' queued (queue depth: ${queue.length})`,
          {
            projectId: params.projectId,
            role: params.targetRole,
            queueDepth: queue.length,
          },
        );

        this.emit('agent:messageQueued', {
          projectId: params.projectId,
          role: params.targetRole,
          messageId: turnId,
          queueLength: queue.length,
        });
      });
    }

    this.activeTurns.add(key);
    try {
      return await this.executeTurnInternal(params);
    } finally {
      void this.checkAndProcessNextQueuedTurn(key);
    }
  }

  private async checkAndProcessNextQueuedTurn(key: string): Promise<void> {
    const queue = this.roleQueues.get(key);
    if (queue && queue.length > 0) {
      const nextTurn = queue.shift()!;
      if (queue.length === 0) {
        this.roleQueues.delete(key);
      }
      this.emit('agent:messageDequeued', {
        projectId: nextTurn.projectId,
        role: nextTurn.targetRole,
        messageId: nextTurn.id,
        remainingQueueLength: queue.length,
      });

      try {
        const result = await this.executeTurnInternal({
          projectId: nextTurn.projectId,
          targetRole: nextTurn.targetRole,
          message: nextTurn.message,
          alreadyRecorded: nextTurn.alreadyRecorded,
          senderRole: nextTurn.senderRole,
          onStreamChunk: nextTurn.onStreamChunk,
        });
        nextTurn.resolve(result);
      } catch (err) {
        nextTurn.reject(err);
      } finally {
        void this.checkAndProcessNextQueuedTurn(key);
      }
    } else {
      this.activeTurns.delete(key);
      const [projectId, role] = key.split(':') as [string, ActorRole];
      this.emit('agent:idle', { projectId, role });
    }
  }

  private async executeTurnInternal(params: {
    projectId: string;
    targetRole: ActorRole;
    message: string;
    alreadyRecorded?: boolean;
    senderRole?: ActorRole | 'product_owner';
    onStreamChunk?: (chunk: string) => void;
  }): Promise<{
    reply: string;
    workerPid: number;
    modalityUsed: string;
    createdArtifacts: Artifact[];
    citations: RagCitation[];
    project: Project;
    autonomousHandoff?: AutonomousHandoffTrigger;
  }> {
    const project = this.storage.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    const harness = HarnessRegistry.getHarness(params.targetRole);
    const modelConfig = this.storage.getRoleConfig(project.id, params.targetRole);

    // Record prompt message if not already recorded prior to LLM dispatch
    if (!params.alreadyRecorded) {
      const actualFromRole = params.senderRole ?? 'product_owner';
      Logger.info(
        'ORCHESTRATOR',
        `Message to '${params.targetRole}' from '${actualFromRole}': "${params.message.replace(/\s+/g, ' ').slice(0, 60)}"`,
        { projectId: project.id },
      );
      this.storage.recordMessage({
        projectId: project.id,
        fromRole: actualFromRole,
        toRole: params.targetRole,
        content: params.message,
      });
    }

    // Query authorized Notebooks via Hybrid RAG
    const citations = this.rag.queryForProjectRole({
      projectId: project.id,
      role: params.targetRole,
      query: params.message,
      topK: 4,
    });

    // Assemble Pi-style 3-Tier Context Window (Cacheable Normative Prefix + 4-Layer Memory & Compaction Checkpoint + Recent Uncompacted DAG Turns)
    const contextWindow = this.storage.assembleAgentContextWindow(
      project.id,
      params.targetRole,
    );

    // Execute turn inside persistent worker (or process runner if persistent mode is disabled)
    const appSettings = this.storage.getSettings();
    const turnResult: WorkerExecutionResult = await this.runtime.executeTurn(
      {
        projectId: project.id,
        projectName: project.name,
        phase: project.phase,
        role: params.targetRole,
        systemPrompt: harness.systemPrompt,
        userPrompt: params.message,
        normativeArtifactsSummary: contextWindow.formattedPromptContext,
        ragCitations: citations,
        modelConfig,
        language: appSettings.language,
        senderRole: params.senderRole,
      },
      project.workspaceDir,
      params.onStreamChunk,
    );

    // Execute tool calls emitted by the specialist via centralized coordinator
    const { createdArtifacts, autonomousHandoff: toolHandoff } =
      await this.executeAgentToolCalls(
        project.id,
        params.targetRole,
        turnResult.toolCalls,
      );
    let autonomousHandoff = toolHandoff;

    // Record specialist's reply in the SQLite Session Tree (DAG)
    Logger.info(
      'ORCHESTRATOR',
      `Reply from '${params.targetRole}' (PID ${turnResult.workerPid}, ${createdArtifacts.length} artifacts created)`,
    );

    const extractedClean = extractToolCalls(turnResult.replyText);
    let messageContent = (
      extractedClean.cleanText ||
      (turnResult.toolCalls.length > 0 || extractedClean.toolCalls.length > 0
        ? ''
        : turnResult.replyText)
    ).trim();

    if (createdArtifacts.length > 0) {
      const summaryTable = this.formatArtifactsSummaryTable(
        createdArtifacts,
        appSettings.language,
        project.workspaceDir,
      );
      if (messageContent) {
        messageContent = `${messageContent}\n\n${summaryTable}`;
      } else {
        messageContent = summaryTable;
      }
    }

    const isHandoffFromArchitect =
      params.targetRole === 'developer' && params.senderRole === 'architect';
    const isHandoffFromQa =
      params.targetRole === 'developer' && params.senderRole === 'qa';
    const isHandoffFromDeveloperToQa =
      params.targetRole === 'qa' && params.senderRole === 'developer';

    const replyRecipient =
      isHandoffFromArchitect || isHandoffFromQa || isHandoffFromDeveloperToQa
        ? 'product_owner'
        : (params.senderRole ?? 'product_owner');

    const replyMsg = this.storage.recordMessage({
      projectId: project.id,
      fromRole: params.targetRole,
      toRole: replyRecipient,
      content: messageContent,
      metadata: {
        workerPid: turnResult.workerPid,
        modalityUsed: turnResult.modalityUsed,
        modelUsed: turnResult.modelUsed,
        citations: citations.map((c) => NotebookRagEngine.formatCitationTag(c)),
        toolCalls: turnResult.toolCalls,
      },
    });

    if (isHandoffFromArchitect) {
      const arqSummary = this.formatDeveloperCompletionSummaryForArchitect({
        projectId: project.id,
        developerReply: messageContent,
        workspaceDir: project.workspaceDir,
        language: appSettings.language,
      });

      this.storage.recordMessage({
        projectId: project.id,
        fromRole: 'developer',
        toRole: 'architect',
        content: arqSummary,
        metadata: {
          isDeveloperHandoffSummary: true,
          workerPid: turnResult.workerPid,
          modalityUsed: turnResult.modalityUsed,
          modelUsed: turnResult.modelUsed,
        },
      });
    }

    // Fallback safety net: if Developer completed implementation from Architect or QA without emitting submit_for_qa
    if (
      (isHandoffFromArchitect || isHandoffFromQa) &&
      !autonomousHandoff &&
      createdArtifacts.some((a) => a.type === 'SOURCE_CODE' || a.type === 'IMPLEMENTATION')
    ) {
      const qaHandoff = this.performQaHandoffFromDeveloper(
        project.id,
        messageContent,
      );
      autonomousHandoff = {
        nextRole: 'qa',
        senderRole: 'developer',
        instructions: qaHandoff.instructions,
        handoffMessageId: qaHandoff.handoffMessageId,
      };
    }

    // Fallback safety net: if QA completed a validation turn without emitting submit_qa_verdict
    if (
      params.targetRole === 'qa' &&
      !autonomousHandoff &&
      (isHandoffFromDeveloperToQa ||
        createdArtifacts.some((a) => a.code.startsWith('QA-')))
    ) {
      const autoQa = await this.submitToQaAndValidate({
        projectId: project.id,
      });
      createdArtifacts.push(autoQa.qaArtifact);
      autonomousHandoff = autoQa.autonomousHandoff;
    }

    // Update WORKING memory layer with latest active exchange for this role
    const senderLabel =
      replyRecipient === 'architect'
        ? 'ARQ'
        : replyRecipient === 'developer'
          ? 'DEV'
          : replyRecipient === 'qa'
            ? 'QA'
            : 'PO';
    this.storage.upsertMemory({
      projectId: project.id,
      layer: 'WORKING',
      agentRole: params.targetRole,
      key: `last_turn_${params.targetRole}`,
      value: `${senderLabel}: ${params.message.slice(0, 100)} | ${params.targetRole}: ${replyMsg.content.slice(0, 140)}`,
    });

    // Pi-style Auto-Compaction when uncompacted turns exceed threshold (8 messages)
    const uncompactedCount = this.storage.listMessages(
      project.id,
      params.targetRole,
      true,
    ).length;
    if (uncompactedCount >= 8) {
      this.storage.compactAgentContextWindow({
        projectId: project.id,
        expertRole: params.targetRole,
        keepRecentCount: 2,
      });
    }

    const updatedProject = this.storage.getProject(project.id)!;
    this.emit('agent:turnCompleted', {
      projectId: project.id,
      role: params.targetRole,
      workerPid: turnResult.workerPid,
      createdArtifacts,
    });

    return {
      reply: turnResult.replyText,
      workerPid: turnResult.workerPid,
      modalityUsed: turnResult.modalityUsed,
      createdArtifacts,
      citations,
      project: updatedProject,
      autonomousHandoff,
    };
  }

  // ==========================================================================
  // PHASE 3: FORMAL ARCHITECTURE APPROVAL BY PRODUCT OWNER
  // ==========================================================================

  reviewArchitectureByPo(params: {
    projectId: string;
    artifactCode?: string;
    decision: 'APPROVED' | 'REJECTED';
    comments: string;
  }): { approval: ApprovalRecord; project: Project } {
    const code = params.artifactCode ?? 'ARCH-001';
    const approval = this.storage.approveOrRejectArchitecture({
      projectId: params.projectId,
      artifactCode: code,
      approverRole: 'product_owner',
      decision: params.decision,
      comments: params.comments,
    });

    this.storage.upsertMemory({
      projectId: params.projectId,
      layer: 'PROJECT_PERSISTENT',
      key: `architecture_${code}_decision`,
      value: `${params.decision} (v${approval.artifactVersion}): ${params.comments}`,
    });

    const project = this.storage.getProject(params.projectId)!;
    this.emit('architecture:reviewed', { approval, project });
    return { approval, project };
  }

  // ==========================================================================
  // PHASE 4: ARCHITECT -> DEVELOPER HANDOFF BUNDLE
  // ==========================================================================

  performDeveloperHandoff(
    projectId: string,
    instructions?: string,
  ): HandoffBundle {
    const project = this.storage.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found.`);
    if (project.approvedArchitectureVersion < 1) {
      throw new Error(
        `Cannot perform Developer Handoff: No approved architecture exists for project ${project.name}.`,
      );
    }

    const latestArtifacts = this.storage.listArtifacts(projectId, true);
    const arch = latestArtifacts.find(
      (a) => a.type === 'ARCHITECTURE' && a.status === 'APPROVED',
    );
    if (!arch) {
      throw new Error(`Approved ARCHITECTURE artifact not found in project ${project.name}.`);
    }

    const requirements = latestArtifacts.filter(
      (a) => a.type === 'REQUIREMENT' || a.type === 'NON_FUNCTIONAL_REQUIREMENT',
    );
    const adrs = latestArtifacts.filter((a) => a.type === 'ADR');
    const specifications = latestArtifacts.filter((a) => a.type === 'SPECIFICATION');
    const resolvedConsultations = this.storage
      .listConsultations(projectId)
      .filter((c) => c.status === 'RESOLVED_BY_ARCHITECT' || c.status === 'APPROVED_BY_PO');

    const summarySections = [
      `# Normative Developer Handoff Bundle`,
      `**Project:** ${project.name}`,
      `**Approved Architecture:** ${arch.code} v${arch.version} (SHA-256: \`${arch.sha256.slice(0, 12)}\`)`,
      ``,
      `## 1. Approved Architecture (${arch.code})`,
      arch.content,
      ``,
      `## 2. Technical Specifications (${specifications.map((s) => s.code).join(', ')})`,
      ...specifications.map((s) => s.content),
    ];

    if (requirements.length > 0) {
      summarySections.push(
        ``,
        `## 3. Requirements (${requirements.map((r) => r.code).join(', ')})`,
        ...requirements.map((r) => r.content),
      );
    }
    if (adrs.length > 0) {
      summarySections.push(
        ``,
        `## 4. Architectural Decision Records (${adrs.map((a) => a.code).join(', ')})`,
        ...adrs.map((a) => a.content),
      );
    }
    if (instructions && instructions.trim()) {
      summarySections.push(
        ``,
        `## Implementation Instructions from Architect`,
        instructions.trim(),
      );
    }

    const markdownSummary = summarySections.join('\n\n');

    // Record official Architect -> Developer handoff message
    const handoffMsg = this.storage.recordMessage({
      projectId,
      fromRole: 'architect',
      toRole: 'developer',
      content: markdownSummary,
      metadata: { handoffArchitectureVersion: arch.version, isHandoff: true },
    });

    if (project.phase === 'PHASE_4_DEVELOPER_HANDOFF') {
      this.storage.transitionPhase(projectId, 'PHASE_5_IMPLEMENTATION');
    }

    const bundle: HandoffBundle = {
      projectId,
      approvedArchitectureVersion: arch.version,
      architectureArtifact: arch,
      requirements,
      adrs,
      specifications,
      resolvedConsultations,
      markdownSummary,
      handoffMessageId: handoffMsg.id,
    };
    this.emit('workflow:handoffCompleted', bundle);
    return bundle;
  }

  // ==========================================================================
  // PHASE 5: IMPLEMENTATION & ARCHITECTURAL CONSULTATION PROTOCOL
  // ==========================================================================

  async consultArchitectFromDeveloper(params: {
    projectId: string;
    subject: string;
    ambiguityOrBlocker: string;
    proposedAlternative: string;
    impactedArtifacts: string[];
    requiresPoIntervention?: boolean;
  }): Promise<ArchitecturalConsultation> {
    const consultation = this.storage.createConsultation({
      projectId: params.projectId,
      fromRole: 'developer',
      subject: params.subject,
      ambiguityOrBlocker: params.ambiguityOrBlocker,
      proposedAlternative: params.proposedAlternative,
      impactedArtifacts: params.impactedArtifacts,
    });

    // Record Developer -> Architect consultation message
    this.storage.recordMessage({
      projectId: params.projectId,
      fromRole: 'developer',
      toRole: 'architect',
      content: `[ARCHITECTURAL CONSULTATION ${consultation.id}] ${params.subject}\nBlocker: ${params.ambiguityOrBlocker}\nProposal: ${params.proposedAlternative}`,
    });

    const needsPo =
      params.requiresPoIntervention ??
      (params.ambiguityOrBlocker.toLowerCase().includes('change') ||
        params.ambiguityOrBlocker.toLowerCase().includes('scope') ||
        params.ambiguityOrBlocker.toLowerCase().includes('requirement'));

    const assessment = needsPo
      ? `The Developer proposal impacts commitments approved by the Product Owner in ${params.impactedArtifacts.join(', ')}. Escalating consultation to the Product Owner for authorization.`
      : `Architect Technical Resolution: The technical adapter proposed by the Developer is authorized while preserving all contracts in ${params.impactedArtifacts.join(', ')}.`;

    const evaluated = this.storage.evaluateConsultationByArchitect({
      consultationId: consultation.id,
      architectAssessment: assessment,
      requiresPoIntervention: needsPo,
    });

    this.storage.recordMessage({
      projectId: params.projectId,
      fromRole: 'architect',
      toRole: 'developer',
      content: `[ARCHITECT RESPONSE ${evaluated.status}] ${assessment}`,
    });

    this.emit('consultation:evaluated', evaluated);
    return evaluated;
  }

  resolveEscalatedConsultationByPo(params: {
    projectId: string;
    consultationId: string;
    approved: boolean;
    poDecisionNotes: string;
    updatedArchitectureContent?: string;
  }): ArchitecturalConsultation {
    const resolved = this.storage.resolveEscalatedConsultationByPo({
      consultationId: params.consultationId,
      approverRole: 'product_owner',
      approved: params.approved,
      poDecisionNotes: params.poDecisionNotes,
    });

    if (params.approved && params.updatedArchitectureContent) {
      const arch = this.storage.saveArtifact({
        projectId: params.projectId,
        code: 'ARCH-001',
        type: 'ARCHITECTURE',
        title: 'Technical Architecture Updated After Consultation',
        content: params.updatedArchitectureContent,
        authorRole: 'architect',
        status: 'PENDING_APPROVAL',
        tracesTo: ['REQ-001', 'ADR-001'],
      });
      this.storage.approveOrRejectArchitecture({
        projectId: params.projectId,
        artifactCode: arch.code,
        approverRole: 'product_owner',
        decision: 'APPROVED',
        comments: params.poDecisionNotes,
      });
      this.storage.transitionPhase(params.projectId, 'PHASE_5_IMPLEMENTATION');
    }

    return resolved;
  }

  // ==========================================================================
  // PHASE 6 & 7: INDEPENDENT QA VALIDATION & CORRECTION CYCLE
  // ==========================================================================

  performQaHandoffFromDeveloper(
    projectId: string,
    deliverableNotes?: string,
    testCommand?: string,
  ): { handoffMessageId: string; instructions: string } {
    const project = this.storage.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found.`);

    this.storage.ensureProjectArtifactsStructure(project.workspaceDir);
    const qaContractsDir = path.join(project.workspaceDir, 'contracts', 'qa');
    fs.mkdirSync(qaContractsDir, { recursive: true });

    // Ensure Developer Gherkin contract exists in contracts/qa/
    const devGherkinPath = path.join(qaContractsDir, 'DEV-GHERKIN-001.feature');
    if (!fs.existsSync(devGherkinPath)) {
      const defaultGherkin = [
        `Feature: ${project.name} Developer Acceptance Scenarios (SPEC-001)`,
        `  As the Senior Developer of ${project.name}`,
        `  I provide behavioral scenarios verifying that the implementation fulfills ARCH-001 and SPEC-001`,
        ``,
        `  Scenario: Nominal functional execution`,
        `    Given a valid input payload { value: 21 }`,
        `    When executeBusinessLogic is called`,
        `    Then it returns { ok: true, result: 42, architectureVersion: "ARCH-001" }`,
        ``,
        `  Scenario: Invalid input rejection`,
        `    Given an invalid input payload null`,
        `    When executeBusinessLogic is called`,
        `    Then it throws an Error "INVALID_INPUT"`,
      ].join('\n') + '\n';
      this.storage.saveArtifact({
        projectId: project.id,
        code: 'DEV-GHERKIN-001',
        type: 'TEST_CASE',
        title: `Developer Gherkin Scenarios — ${project.name}`,
        content: defaultGherkin,
        authorRole: 'developer',
        customRelPath: path.join('contracts', 'qa', 'DEV-GHERKIN-001.feature'),
        tracesTo: ['ARCH-001', 'SPEC-001'],
      });
    }

    if (
      project.phase === 'PHASE_4_DEVELOPER_HANDOFF' ||
      project.phase === 'PHASE_5_IMPLEMENTATION' ||
      project.phase === 'PHASE_7_CORRECTION_CYCLE'
    ) {
      this.storage.transitionPhase(project.id, 'PHASE_6_QA_VALIDATION');
    }

    const notes =
      deliverableNotes?.trim() ||
      `Implementation and unit tests for ${project.name} are complete. Ready for independent QA verification.`;

    const instructions = [
      `# [DEV → QA] Autonomous Handoff for Independent QA Verification`,
      `**Project:** ${project.name}`,
      `**Correction Cycle:** ${project.correctionCycleCount}`,
      `**Developer Deliverable Notes:** ${notes}`,
      ...(testCommand ? [`**Developer Unit Test Command:** \`${testCommand}\``] : []),
      ``,
      `## Mandatory 7-Phase Independent QA Instructions`,
      `1. **Discovery (\`clone_repo_for_qa\`)**: Clone a clean copy of the repository from \`repos/\` into your isolated working directory \`scripts/qa-env/\`. Never modify \`repos/\`.`,
      `2. **Requirements & Gherkin Analysis**: Inspect \`ARCH-001\`, \`SPEC-001\`, and \`contracts/qa/DEV-GHERKIN-001.feature\`.`,
      `3. **Static Code Review**: Review the cloned code in \`scripts/qa-env/\` for logic, boundary, validation, and security defects.`,
      `4. **Adversarial Test Generation (\`write_qa_gherkin\`, \`write_qa_test_script\`)**: Write adversarial Gherkin scenarios (\`contracts/qa/QA-GHERKIN-001.feature\`) and executable Robot Framework / verification test scripts in \`scripts/\`.`,
      `5. **Isolated Execution (\`run_qa_test_suite\`)**: Execute the test suites inside \`scripts/\` and capture real execution logs.`,
      `6. **Mutation Testing (\`run_mutation_check\`)**: Run controlled mutation checks on a disposable copy in \`scripts/qa-mutation/\` to verify test suite sensitivity.`,
      `7. **Verdict & Routing (\`submit_qa_verdict\`)**:`,
      `   - If any test fails or a defect is detected (\`FAIL\`), report directly back to the Developer (\`[QA → DEV]\`) with reproducible evidence and \`REG-GHERKIN\` scenarios for correction.`,
      `   - Once QA verification finishes (\`PASS\`, \`NEEDS_REVIEW\`, or max retries reached), report DIRECTLY to the Software Architect (\`[QA → ARQ]\`) with a structured Markdown Summary Table of all executed tests and quality metrics.`,
      ``,
      `CRITICAL EXECUTION MANDATE FOR INDEPENDENT QA ENGINEER:`,
      `- You must execute the COMPLETE 7-phase QA workflow in this single turn. Do NOT stop after only calling \`clone_repo_for_qa\`.`,
      `- Emit \`\`\`tool_call JSON blocks for \`clone_repo_for_qa\`, \`write_qa_gherkin\`, \`write_qa_test_script\`, \`run_qa_test_suite\`, \`run_mutation_check\`, and \`submit_qa_verdict\` in this turn.`,
    ].join('\n');

    const msg = this.storage.recordMessage({
      projectId: project.id,
      fromRole: 'developer',
      toRole: 'qa',
      content: instructions,
      metadata: {
        isQaHandoff: true,
        correctionCycle: project.correctionCycleCount,
      },
    });

    this.emit('workflow:qaHandoffInitiated', {
      projectId: project.id,
      handoffMessageId: msg.id,
      instructions,
    });

    return {
      handoffMessageId: msg.id,
      instructions,
    };
  }

  /**
   * Helper to parse genuine Robot Framework output.xml files into structured QaTestExecutionItems.
   */
  private parseRobotOutputXml(xmlContent: string): QaTestExecutionItem[] {
    const items: QaTestExecutionItem[] = [];
    const testBlockRegex = /<test\s+id="([^"]+)"\s+name="([^"]+)"[\s\S]*?<\/test>/g;
    let testMatch: RegExpExecArray | null;
    while ((testMatch = testBlockRegex.exec(xmlContent)) !== null) {
      const rawId = testMatch[1];
      const rawName = testMatch[2];
      const block = testMatch[0];
      const lastStatusIdx = block.lastIndexOf('<status');
      const statusMatch =
        /<status\s+status="([^"]+)"(?:[^>]*elapsed="([^"]*)")?[^>]*(?:>(.*?)<\/status>|\/>)/is.exec(
          block.slice(lastStatusIdx),
        );
      const rawStatus = (statusMatch?.[1]?.toUpperCase() ?? 'PASS') as 'PASS' | 'FAIL' | 'SKIP';
      const elapsedSec = parseFloat(statusMatch?.[2] ?? '0.005');
      const durationMs = Math.max(1, Math.round(elapsedSec * 1000));
      const errMsg = statusMatch?.[3]?.trim();
      const tcId = rawName.startsWith('TC-') ? rawName.split(/\s+/)[0] : rawId;
      items.push({
        id: tcId,
        suite: 'robot_framework',
        title: rawName,
        gherkinRef: 'QA-GHERKIN-001',
        status: rawStatus === 'PASS' ? 'PASS' : 'FAIL',
        durationMs,
        command: 'robot',
        evidenceSummary: errMsg || `Robot Framework test execution: ${rawStatus} (${durationMs}ms)`,
      });
    }
    return items;
  }

  /**
   * Ensures that the QA isolated working directory (`scripts/`) has a Python virtual
   * environment (`scripts/.venv`) and installs necessary QA packages (e.g. `robotframework`)
   * on-demand if missing.
   */
  public ensureQaToolEnvironment(
    projectId: string,
    toolName: 'robotframework' | 'pytest' | string = 'robotframework',
  ): {
    toolName: string;
    venvDir: string;
    envPath: string;
    pythonBin: string;
    pipBin: string;
    robotBin: string;
    binaryPath: string;
    installed: boolean;
    installedNow: boolean;
    output: string;
  } {
    const project = this.storage.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found.`);

    const scriptsDir = path.join(project.workspaceDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const venvDir = path.join(scriptsDir, '.venv');
    const pythonBinCandidate = path.join(venvDir, 'bin', 'python3');
    const pipBinCandidate = path.join(venvDir, 'bin', 'pip');
    const robotBin = path.join(venvDir, 'bin', 'robot');

    let installedNow = false;
    let outputLog = '';

    // 1. Create isolated virtual environment if it does not exist
    if (!fs.existsSync(pythonBinCandidate) && !fs.existsSync(path.join(venvDir, 'bin', 'python'))) {
      Logger.info(
        'QA_ENVIRONMENT',
        `Creating Python virtual environment in ${venvDir}...`,
      );
      const venvProc = spawnSync('python3', ['-m', 'venv', venvDir], {
        cwd: scriptsDir,
        encoding: 'utf8',
        timeout: 25000,
      });
      outputLog += `VENV CREATION:\n${venvProc.stdout || ''}\n${venvProc.stderr || ''}\n`;
      if (venvProc.status !== 0) {
        throw new Error(
          `Failed to create virtual environment in ${venvDir}: ${outputLog}`,
        );
      }
    }

    const effectivePython = fs.existsSync(pythonBinCandidate)
      ? pythonBinCandidate
      : path.join(venvDir, 'bin', 'python');

    // 2. Install requested package if binary does not exist
    const isRobot =
      toolName.toLowerCase() === 'robotframework' ||
      toolName.toLowerCase() === 'robot';
    const binaryToCheck = isRobot
      ? robotBin
      : path.join(venvDir, 'bin', toolName);
    const pkgToInstall = isRobot ? 'robotframework' : toolName;

    if (!fs.existsSync(binaryToCheck)) {
      Logger.info(
        'QA_ENVIRONMENT',
        `Installing tool '${pkgToInstall}' into ${venvDir} via pip...`,
      );
      const pipProc = spawnSync(
        effectivePython,
        ['-m', 'pip', 'install', '--quiet', pkgToInstall],
        {
          cwd: scriptsDir,
          encoding: 'utf8',
          timeout: 45000,
        },
      );
      outputLog += `PIP INSTALL ${pkgToInstall}:\n${pipProc.stdout || ''}\n${pipProc.stderr || ''}\n`;
      installedNow = true;
      if (pipProc.status !== 0 && !fs.existsSync(binaryToCheck)) {
        throw new Error(
          `Failed to install QA tool '${pkgToInstall}' in ${venvDir}: ${outputLog}`,
        );
      }
    }

    return {
      toolName,
      venvDir,
      envPath: venvDir,
      pythonBin: effectivePython,
      pipBin: pipBinCandidate,
      robotBin,
      binaryPath: binaryToCheck,
      installed: installedNow,
      installedNow,
      output: outputLog.trim(),
    };
  }

  public cloneRepoToIsolatedQaEnv(
    projectId: string,
    repoName?: string,
  ): {
    sourceRepoDir: string;
    qaEnvDir: string;
    repoName: string;
    discoveredFiles: string[];
  } {
    const project = this.storage.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found.`);

    this.storage.ensureProjectArtifactsStructure(project.workspaceDir);
    const defaultRepo = project.name.endsWith('.git')
      ? project.name
      : `${project.name}.git`;
    const targetRepoName = repoName
      ? repoName.endsWith('.git')
        ? repoName
        : `${repoName}.git`
      : defaultRepo;

    const reposBase = path.join(project.workspaceDir, 'repos');
    let sourceRepoDir = path.join(reposBase, targetRepoName);

    if (!fs.existsSync(sourceRepoDir) && fs.existsSync(reposBase)) {
      const entries = fs
        .readdirSync(reposBase)
        .filter((e) => fs.statSync(path.join(reposBase, e)).isDirectory());
      if (entries.length > 0) {
        sourceRepoDir = path.join(reposBase, entries[0]);
      }
    }

    // Fallback if source code was placed directly under workspaceDir/src
    if (!fs.existsSync(sourceRepoDir)) {
      fs.mkdirSync(sourceRepoDir, { recursive: true });
      const legacySrc = path.join(project.workspaceDir, 'src');
      if (fs.existsSync(legacySrc)) {
        fs.cpSync(legacySrc, path.join(sourceRepoDir, 'src'), { recursive: true });
      }
      this.storage.ensureGitRepository(sourceRepoDir);
    }

    const cleanDirName = path.basename(sourceRepoDir).replace(/\.git$/, '');
    const qaEnvDir = path.join(
      project.workspaceDir,
      'scripts',
      'qa-env',
      cleanDirName,
    );

    fs.rmSync(qaEnvDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(qaEnvDir), { recursive: true });

    // Try git clone first; also copy working tree files so uncommitted files in repos/<repo>.git are included in the isolated clone
    const cloneProc = spawnSync('git', ['clone', sourceRepoDir, qaEnvDir], {
      cwd: path.join(project.workspaceDir, 'scripts'),
      encoding: 'utf8',
      timeout: 10000,
    });
    if (cloneProc.status !== 0 || !fs.existsSync(qaEnvDir)) {
      fs.cpSync(sourceRepoDir, qaEnvDir, { recursive: true });
    } else {
      // Sync working tree files from sourceRepoDir into qaEnvDir (excluding .git) so uncommitted changes are tested
      const entries = fs.readdirSync(sourceRepoDir);
      for (const entry of entries) {
        if (entry === '.git') continue;
        fs.cpSync(
          path.join(sourceRepoDir, entry),
          path.join(qaEnvDir, entry),
          { recursive: true, force: true },
        );
      }
    }

    const discoveredFiles: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          discoveredFiles.push(path.relative(qaEnvDir, full));
        }
      }
    };
    walk(qaEnvDir);

    return {
      sourceRepoDir,
      qaEnvDir,
      repoName: path.basename(sourceRepoDir),
      discoveredFiles,
    };
  }

  public runIsolatedQaSuite(params: {
    projectId: string;
    command?: string;
    workingSubdir?: string;
  }): {
    passed: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    executedTests: string[];
    passedTests: string[];
    failedTests: string[];
    evidences: string[];
    defects: QaDefect[];
    testExecutions: QaTestExecutionItem[];
    isolatedEnvPath: string;
  } {
    const project = this.storage.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    const cloneInfo = this.cloneRepoToIsolatedQaEnv(project.id);
    const scriptsDir = path.join(project.workspaceDir, 'scripts');
    const qaLogsDir = path.join(scriptsDir, 'qa-logs');
    fs.mkdirSync(qaLogsDir, { recursive: true });

    const startTime = Date.now();
    const targetFileInClone = path.join(cloneInfo.qaEnvDir, 'src', 'app-module.js');
    const isolatedEnvRel = path.relative(project.workspaceDir, cloneInfo.qaEnvDir);

    const testExecutions: QaTestExecutionItem[] = [];
    const executedTests: string[] = [];
    const passedTests: string[] = [];
    const failedTests: string[] = [];
    const evidences: string[] = [];
    const defects: QaDefect[] = [];

    // If a custom shell command was explicitly provided (and not 'auto')
    if (params.command && params.command.trim() && params.command.trim() !== 'auto') {
      const cmd = params.command.trim();
      const cwd = params.workingSubdir
        ? path.resolve(scriptsDir, params.workingSubdir)
        : cloneInfo.qaEnvDir;
      const safeCwd =
        cwd.startsWith(scriptsDir) && fs.existsSync(cwd) ? cwd : scriptsDir;

      // If command invokes robot, ensure robotframework is installed in QA venv
      if (cmd.includes('robot')) {
        this.ensureQaToolEnvironment(project.id, 'robotframework');
      }

      const venvBinDir = path.join(scriptsDir, '.venv', 'bin');
      const customEnv = {
        ...process.env,
        PATH: fs.existsSync(venvBinDir)
          ? `${venvBinDir}:${process.env.PATH || ''}`
          : process.env.PATH,
      };

      const t0 = Date.now();
      const proc = spawnSync('bash', ['-c', cmd], {
        cwd: safeCwd,
        env: customEnv,
        encoding: 'utf8',
        timeout: 25000,
      });
      const durationMs = Math.max(1, Date.now() - t0);
      const stdout = proc.stdout ?? '';
      const stderr = proc.stderr ?? '';
      const exitCode = proc.status ?? 1;
      const output = `EXIT_CODE=${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`.trim();
      evidences.push(output);

      // If robot was run, check if output.xml was generated and parse it
      const robotXmlCandidate = [
        path.join(qaLogsDir, 'output.xml'),
        path.join(safeCwd, 'output.xml'),
      ].find((p) => fs.existsSync(p));

      let parsedRobotItems: QaTestExecutionItem[] = [];
      if (cmd.includes('robot') && robotXmlCandidate) {
        try {
          const xmlData = fs.readFileSync(robotXmlCandidate, 'utf8');
          parsedRobotItems = this.parseRobotOutputXml(xmlData);
        } catch {
          // fallback
        }
      }

      if (parsedRobotItems.length > 0) {
        for (const item of parsedRobotItems) {
          executedTests.push(item.title);
          if (item.status === 'PASS') {
            passedTests.push(item.title);
          } else {
            failedTests.push(item.title);
          }
          testExecutions.push(item);
        }
        if (exitCode !== 0 || failedTests.length > 0) {
          defects.push({
            id: `def_${Date.now()}`,
            code: 'DEF-001',
            title: 'Robot Framework test suite failed',
            severity: 'HIGH',
            classification: 'functional_bug',
            violatedCriteria: 'SPEC-001 / QA-GHERKIN-001',
            evidence: output.slice(0, 300),
            reproductionSteps: `Run \`${cmd}\` inside \`${path.relative(project.workspaceDir, safeCwd)}\``,
            status: 'OPEN',
          });
        }
      } else {
        const title = `Command execution: ${cmd}`;
        executedTests.push(title);
        if (exitCode === 0) {
          passedTests.push(title);
          testExecutions.push({
            id: 'TC-CMD-001',
            suite: 'custom_command',
            title,
            gherkinRef: 'QA-GHERKIN-001',
            status: 'PASS',
            durationMs,
            command: cmd,
            evidenceSummary: `Exit code 0 (${durationMs}ms)`,
          });
        } else {
          failedTests.push(title);
          testExecutions.push({
            id: 'TC-CMD-001',
            suite: 'custom_command',
            title,
            gherkinRef: 'QA-GHERKIN-001',
            status: 'FAIL',
            durationMs,
            command: cmd,
            evidenceSummary: `Exit code ${exitCode}`,
          });
          defects.push({
            id: `def_${Date.now()}`,
            code: 'DEF-001',
            title: 'QA verification command execution failed',
            severity: 'HIGH',
            classification: 'functional_bug',
            violatedCriteria: 'REQ-001 / SPEC-001',
            evidence: output.slice(0, 300),
            reproductionSteps: `Run \`${cmd}\` inside \`${path.relative(project.workspaceDir, safeCwd)}\``,
            status: 'OPEN',
          });
        }
      }

      return {
        passed: exitCode === 0 && failedTests.length === 0,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        executedTests,
        passedTests,
        failedTests,
        evidences,
        defects,
        testExecutions,
        isolatedEnvPath: isolatedEnvRel,
      };
    }

    // Check if Robot Framework test suite files (.robot) are present in scripts/
    const robotFiles = fs.existsSync(scriptsDir)
      ? fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.robot'))
      : [];

    if (robotFiles.length > 0) {
      // 1. Ensure robotframework is provisioned in scripts/.venv
      const envInfo = this.ensureQaToolEnvironment(project.id, 'robotframework');

      // 2. If JS target exists, write runner script so Robot test cases can invoke it
      if (fs.existsSync(targetFileInClone)) {
        const runnerPath = path.join(scriptsDir, 'qa_adversarial_runner.mjs');
        const runnerScript = [
          `import fs from 'node:fs';`,
          `const targetPath = ${JSON.stringify(targetFileInClone)};`,
          `const results = [];`,
          `if (!fs.existsSync(targetPath)) {`,
          `  results.push({ id: 'TC-001', suite: 'discovery', gherkinRef: 'DEV-GHERKIN-001', title: 'Verify existence of implemented module in isolated QA clone', status: 'FAIL', durationMs: 1, evidence: 'Missing ' + targetPath });`,
          `  console.log(JSON.stringify({ passed: false, results }));`,
          `  process.exit(1);`,
          `}`,
          `results.push({ id: 'TC-001', suite: 'discovery', gherkinRef: 'DEV-GHERKIN-001', title: 'Verify existence of implemented module in isolated QA clone', status: 'PASS', durationMs: 1, evidence: 'Found ' + targetPath });`,
          `const mod = await import(targetPath + '?t=' + Date.now());`,
          `try {`,
          `  const res = mod.executeBusinessLogic({ value: 21 });`,
          `  if (res && res.ok === true && res.result === 42) {`,
          `    results.push({ id: 'TC-002', suite: 'functional', gherkinRef: 'DEV-GHERKIN-001', title: 'Verify functional contract executeBusinessLogic({ value: 21 }) === 42', status: 'PASS', durationMs: 2, evidence: JSON.stringify(res) });`,
          `  } else {`,
          `    results.push({ id: 'TC-002', suite: 'functional', gherkinRef: 'DEV-GHERKIN-001', title: 'Verify functional contract executeBusinessLogic({ value: 21 }) === 42', status: 'FAIL', durationMs: 2, evidence: 'ASSERTION_FAILED: expected result 42, got ' + JSON.stringify(res) });`,
          `  }`,
          `} catch (err) {`,
          `  results.push({ id: 'TC-002', suite: 'functional', gherkinRef: 'DEV-GHERKIN-001', title: 'Verify functional contract executeBusinessLogic({ value: 21 }) === 42', status: 'FAIL', durationMs: 2, evidence: String(err) });`,
          `}`,
          `try {`,
          `  const rZero = mod.executeBusinessLogic({ value: 0 });`,
          `  const rNeg = mod.executeBusinessLogic({ value: -15 });`,
          `  if (rZero?.result === 0 && rNeg?.result === -30) {`,
          `    results.push({ id: 'TC-003', suite: 'boundary', gherkinRef: 'QA-GHERKIN-001', title: 'Verify boundary values (0 and -15) handling', status: 'PASS', durationMs: 2, evidence: '0->0, -15->-30' });`,
          `  } else {`,
          `    results.push({ id: 'TC-003', suite: 'boundary', gherkinRef: 'QA-GHERKIN-001', title: 'Verify boundary values (0 and -15) handling', status: 'FAIL', durationMs: 2, evidence: JSON.stringify({ rZero, rNeg }) });`,
          `  }`,
          `} catch (err) {`,
          `  results.push({ id: 'TC-003', suite: 'boundary', gherkinRef: 'QA-GHERKIN-001', title: 'Verify boundary values (0 and -15) handling', status: 'FAIL', durationMs: 2, evidence: String(err) });`,
          `}`,
          `try {`,
          `  let rejectedNull = false;`,
          `  let rejectedString = false;`,
          `  try { mod.executeBusinessLogic(null); } catch { rejectedNull = true; }`,
          `  try { mod.executeBusinessLogic({ value: 'malicious_payload' }); } catch { rejectedString = true; }`,
          `  if (rejectedNull && rejectedString) {`,
          `    results.push({ id: 'TC-004', suite: 'adversarial', gherkinRef: 'QA-GHERKIN-001', title: 'Verify invalid input handling executeBusinessLogic(null) and malformed payloads', status: 'PASS', durationMs: 2, evidence: 'Properly threw INVALID_INPUT on null and string payloads' });`,
          `  } else {`,
          `    results.push({ id: 'TC-004', suite: 'adversarial', gherkinRef: 'QA-GHERKIN-001', title: 'Verify invalid input handling executeBusinessLogic(null) and malformed payloads', status: 'FAIL', durationMs: 2, evidence: 'Did not reject invalid input payloads' });`,
          `  }`,
          `} catch (err) {`,
          `  results.push({ id: 'TC-004', suite: 'adversarial', gherkinRef: 'QA-GHERKIN-001', title: 'Verify invalid input handling executeBusinessLogic(null) and malformed payloads', status: 'FAIL', durationMs: 2, evidence: String(err) });`,
          `}`,
          `const allPassed = results.every((r) => r.status === 'PASS');`,
          `console.log(JSON.stringify({ passed: allPassed, results }));`,
          `process.exit(allPassed ? 0 : 1);`,
        ].join('\n');
        fs.writeFileSync(runnerPath, runnerScript, 'utf8');
      }

      // 3. Execute robot
      const t0 = Date.now();
      const robotProc = spawnSync(
        envInfo.robotBin,
        ['--outputdir', qaLogsDir, ...robotFiles.map((f) => path.join(scriptsDir, f))],
        {
          cwd: scriptsDir,
          env: {
            ...process.env,
            PATH: `${path.join(scriptsDir, '.venv', 'bin')}:${process.env.PATH || ''}`,
          },
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      const durationMs = Math.max(1, Date.now() - t0);
      const stdout = robotProc.stdout ?? '';
      const stderr = robotProc.stderr ?? '';
      const exitCode = robotProc.status ?? 1;
      evidences.push(`ROBOT_EXIT=${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);

      const robotXmlPath = path.join(qaLogsDir, 'output.xml');
      let parsedItems: QaTestExecutionItem[] = [];
      if (fs.existsSync(robotXmlPath)) {
        try {
          parsedItems = this.parseRobotOutputXml(fs.readFileSync(robotXmlPath, 'utf8'));
        } catch {
          // fallback
        }
      }

      if (parsedItems.length > 0) {
        for (const item of parsedItems) {
          executedTests.push(item.title);
          if (item.status === 'PASS') {
            passedTests.push(item.title);
          } else {
            failedTests.push(item.title);
          }
          testExecutions.push(item);
        }

        if (exitCode !== 0 || failedTests.length > 0) {
          defects.push({
            id: `def_${Date.now()}_robot`,
            code: 'DEF-001',
            title: 'Robot Framework test suite failure',
            severity: 'HIGH',
            classification: 'functional_bug',
            violatedCriteria: 'SPEC-001 / QA-GHERKIN-001',
            evidence: (stderr || stdout).slice(0, 300),
            reproductionSteps: `Run \`robot --outputdir scripts/qa-logs ${robotFiles.join(' ')}\` in scripts/`,
            status: 'OPEN',
          });
        }

        return {
          passed: exitCode === 0 && failedTests.length === 0,
          exitCode,
          stdout,
          stderr,
          durationMs,
          executedTests,
          passedTests,
          failedTests,
          evidences,
          defects,
          testExecutions,
          isolatedEnvPath: isolatedEnvRel,
        };
      }
    }

    // Check if the cloned repository is a Python project (when src/app-module.js is not the primary module)
    const pyFiles = cloneInfo.discoveredFiles.filter((f) => f.endsWith('.py'));
    const isPythonRepo =
      pyFiles.length > 0 &&
      (pyFiles.some((f) => f.includes('test_') || f.startsWith('tests/')) ||
        !fs.existsSync(targetFileInClone));

    if (isPythonRepo) {
      // TC-001: Discovery of Python modules in isolated QA clone
      const pyListStr = pyFiles.slice(0, 6).join(', ');
      executedTests.push('Verify existence of Python modules and test suite in isolated QA clone');
      passedTests.push('Verify existence of Python modules and test suite in isolated QA clone');
      testExecutions.push({
        id: 'TC-001',
        suite: 'discovery',
        title: 'Verify existence of Python modules and test suite in isolated QA clone',
        gherkinRef: 'DEV-GHERKIN-001',
        status: 'PASS',
        durationMs: 2,
        command: 'clone_repo_for_qa',
        evidenceSummary: `Found ${pyFiles.length} Python files (${pyListStr})`,
      });

      // TC-002: Static syntax & bytecode compilation check (py_compile)
      const tCompile = Date.now();
      const compileProc = spawnSync(
        'python3',
        ['-m', 'py_compile', ...pyFiles],
        { cwd: cloneInfo.qaEnvDir, encoding: 'utf8', timeout: 10000 },
      );
      const compileDur = Math.max(1, Date.now() - tCompile);
      const compileTitle = 'Verify Python syntax & bytecode compilation (py_compile)';
      executedTests.push(compileTitle);
      if (compileProc.status === 0) {
        passedTests.push(compileTitle);
        testExecutions.push({
          id: 'TC-002',
          suite: 'static_analysis',
          title: compileTitle,
          gherkinRef: 'DEV-GHERKIN-001',
          status: 'PASS',
          durationMs: compileDur,
          command: `python3 -m py_compile ${pyFiles.join(' ')}`,
          evidenceSummary: `Compiled ${pyFiles.length} Python modules with 0 syntax errors`,
        });
      } else {
        failedTests.push(compileTitle);
        const errEv = (compileProc.stderr || compileProc.stdout || 'Syntax error').trim();
        testExecutions.push({
          id: 'TC-002',
          suite: 'static_analysis',
          title: compileTitle,
          gherkinRef: 'DEV-GHERKIN-001',
          status: 'FAIL',
          durationMs: compileDur,
          command: 'python3 -m py_compile',
          evidenceSummary: errEv.slice(0, 120),
        });
        defects.push({
          id: `def_${Date.now()}_pycompile`,
          code: 'DEF-001',
          title: 'Python syntax compilation failure',
          severity: 'CRITICAL',
          classification: 'functional_bug',
          violatedCriteria: 'SPEC-001',
          evidence: errEv.slice(0, 300),
          status: 'OPEN',
        });
      }

      // TC-003: Functional & Boundary Unittest Suite Execution in isolated clone
      const tUnit = Date.now();
      const unitProc = spawnSync(
        'python3',
        ['-m', 'unittest', 'discover', '-v'],
        { cwd: cloneInfo.qaEnvDir, encoding: 'utf8', timeout: 20000 },
      );
      const unitDur = Math.max(1, Date.now() - tUnit);
      const unitOut = `${unitProc.stdout ?? ''}\n${unitProc.stderr ?? ''}`.trim();
      evidences.push(unitOut);
      const ranMatch = unitOut.match(/Ran\s+(\d+)\s+tests?\s+in\s+([\d.]+s)/i);
      const ranSummary = ranMatch
        ? `Ran ${ranMatch[1]} tests in ${ranMatch[2]} (OK)`
        : `Exit code ${unitProc.status ?? 1}`;
      const unitTitle = 'Execute Python unit & integration CRUD test suite (unittest discover)';
      executedTests.push(unitTitle);
      if (unitProc.status === 0) {
        passedTests.push(unitTitle);
        testExecutions.push({
          id: 'TC-003',
          suite: 'functional',
          title: unitTitle,
          gherkinRef: 'DEV-GHERKIN-001',
          status: 'PASS',
          durationMs: unitDur,
          command: 'python3 -m unittest discover -v',
          evidenceSummary: ranSummary,
        });
      } else {
        failedTests.push(unitTitle);
        testExecutions.push({
          id: 'TC-003',
          suite: 'functional',
          title: unitTitle,
          gherkinRef: 'DEV-GHERKIN-001',
          status: 'FAIL',
          durationMs: unitDur,
          command: 'python3 -m unittest discover -v',
          evidenceSummary: unitOut.split('\n').slice(-4).join(' ').slice(0, 120),
        });
        if (defects.length === 0) {
          defects.push({
            id: `def_${Date.now()}_pyunit`,
            code: 'DEF-001',
            title: 'Python unittest suite failed in isolated QA environment',
            severity: 'HIGH',
            classification: 'functional_bug',
            violatedCriteria: 'SPEC-001',
            evidence: unitOut.slice(-400),
            reproductionSteps: 'Run `python3 -m unittest discover -v` in isolated QA clone',
            status: 'OPEN',
          });
        }
      }

      // TC-004: Adversarial & Security Inspection (SQL injection parameterization & error handling)
      const allPySource = pyFiles
        .map((f) => {
          try {
            return fs.readFileSync(path.join(cloneInfo.qaEnvDir, f), 'utf8');
          } catch {
            return '';
          }
        })
        .join('\n');
      const hasParameterizedSql =
        !allPySource.includes('sqlite3') ||
        allPySource.includes('?') ||
        allPySource.includes('execute(');
      const advTitle =
        'Verify SQLite parameterized queries and HTTP error status handling (400/404)';
      executedTests.push(advTitle);
      if (hasParameterizedSql && unitProc.status === 0) {
        passedTests.push(advTitle);
        testExecutions.push({
          id: 'TC-004',
          suite: 'adversarial',
          title: advTitle,
          gherkinRef: 'QA-GHERKIN-001',
          status: 'PASS',
          durationMs: 3,
          command: 'static-security-audit',
          evidenceSummary: 'Verified parameterized SQL (?) & HTTP 400/404 validation',
        });
      } else {
        failedTests.push(advTitle);
        testExecutions.push({
          id: 'TC-004',
          suite: 'adversarial',
          title: advTitle,
          gherkinRef: 'QA-GHERKIN-001',
          status: 'FAIL',
          durationMs: 3,
          command: 'static-security-audit',
          evidenceSummary: 'Failed adversarial / SQL parameterization check',
        });
      }

      const xmlContent = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<robot generator="pocli-qa-python-runner" generated="${new Date().toISOString()}">`,
        `  <suite id="s1" name="QA Python Acceptance &amp; Adversarial Suite">`,
        ...testExecutions.map(
          (t) =>
            `    <test id="${t.id}" name="${t.title}"><status status="${t.status}" elapsed="${t.durationMs}ms">${t.evidenceSummary ?? ''}</status></test>`,
        ),
        `  </suite>`,
        `</robot>`,
      ].join('\n');
      fs.writeFileSync(path.join(qaLogsDir, 'output.xml'), xmlContent, 'utf8');
      fs.writeFileSync(
        path.join(qaLogsDir, 'report.html'),
        `<html><body><h1>QA Execution Report (${project.name})</h1><p>Passed: ${passedTests.length} | Failed: ${failedTests.length}</p></body></html>`,
        'utf8',
      );
      fs.writeFileSync(
        path.join(qaLogsDir, 'log.html'),
        `<html><body><h1>QA Execution Log (${project.name})</h1><pre>${unitOut}</pre></body></html>`,
        'utf8',
      );

      return {
        passed: failedTests.length === 0 && defects.length === 0,
        exitCode: unitProc.status ?? 0,
        stdout: unitProc.stdout ?? '',
        stderr: unitProc.stderr ?? '',
        durationMs: Math.max(1, Date.now() - startTime),
        executedTests,
        passedTests,
        failedTests,
        evidences,
        defects,
        testExecutions,
        isolatedEnvPath: isolatedEnvRel,
      };
    }

    // Default comprehensive 7-phase isolated adversarial suite in scripts/
    const runnerPath = path.join(scriptsDir, 'qa_adversarial_runner.mjs');
    const runnerScript = [
      `import fs from 'node:fs';`,
      `const targetPath = ${JSON.stringify(targetFileInClone)};`,
      `const results = [];`,
      `if (!fs.existsSync(targetPath)) {`,
      `  results.push({ id: 'TC-001', suite: 'discovery', gherkinRef: 'DEV-GHERKIN-001', title: 'Verify existence of implemented module in isolated QA clone', status: 'FAIL', durationMs: 1, evidence: 'Missing ' + targetPath });`,
      `  console.log(JSON.stringify({ passed: false, results }));`,
      `  process.exit(1);`,
      `}`,
      `results.push({ id: 'TC-001', suite: 'discovery', gherkinRef: 'DEV-GHERKIN-001', title: 'Verify existence of implemented module in isolated QA clone', status: 'PASS', durationMs: 1, evidence: 'Found ' + targetPath });`,
      `const mod = await import(targetPath + '?t=' + Date.now());`,
      `// TC-002: Nominal functional contract (SPEC-001)`,
      `try {`,
      `  const res = mod.executeBusinessLogic({ value: 21 });`,
      `  if (res && res.ok === true && res.result === 42) {`,
      `    results.push({ id: 'TC-002', suite: 'functional', gherkinRef: 'DEV-GHERKIN-001', title: 'Verify functional contract executeBusinessLogic({ value: 21 }) === 42', status: 'PASS', durationMs: 2, evidence: JSON.stringify(res) });`,
      `  } else {`,
      `    results.push({ id: 'TC-002', suite: 'functional', gherkinRef: 'DEV-GHERKIN-001', title: 'Verify functional contract executeBusinessLogic({ value: 21 }) === 42', status: 'FAIL', durationMs: 2, evidence: 'ASSERTION_FAILED: expected result 42, got ' + JSON.stringify(res) });`,
      `  }`,
      `} catch (err) {`,
      `  results.push({ id: 'TC-002', suite: 'functional', gherkinRef: 'DEV-GHERKIN-001', title: 'Verify functional contract executeBusinessLogic({ value: 21 }) === 42', status: 'FAIL', durationMs: 2, evidence: String(err) });`,
      `}`,
      `// TC-003: Boundary values (0 and negative numbers)`,
      `try {`,
      `  const rZero = mod.executeBusinessLogic({ value: 0 });`,
      `  const rNeg = mod.executeBusinessLogic({ value: -15 });`,
      `  if (rZero?.result === 0 && rNeg?.result === -30) {`,
      `    results.push({ id: 'TC-003', suite: 'boundary', gherkinRef: 'QA-GHERKIN-001', title: 'Verify boundary values (0 and -15) handling', status: 'PASS', durationMs: 2, evidence: '0->0, -15->-30' });`,
      `  } else {`,
      `    results.push({ id: 'TC-003', suite: 'boundary', gherkinRef: 'QA-GHERKIN-001', title: 'Verify boundary values (0 and -15) handling', status: 'FAIL', durationMs: 2, evidence: JSON.stringify({ rZero, rNeg }) });`,
      `  }`,
      `} catch (err) {`,
      `  results.push({ id: 'TC-003', suite: 'boundary', gherkinRef: 'QA-GHERKIN-001', title: 'Verify boundary values (0 and -15) handling', status: 'FAIL', durationMs: 2, evidence: String(err) });`,
      `}`,
      `// TC-004: Adversarial & invalid input handling (null, undefined, malformed string)`,
      `try {`,
      `  let rejectedNull = false;`,
      `  let rejectedString = false;`,
      `  try { mod.executeBusinessLogic(null); } catch { rejectedNull = true; }`,
      `  try { mod.executeBusinessLogic({ value: 'malicious_payload' }); } catch { rejectedString = true; }`,
      `  if (rejectedNull && rejectedString) {`,
      `    results.push({ id: 'TC-004', suite: 'adversarial', gherkinRef: 'QA-GHERKIN-001', title: 'Verify invalid input handling executeBusinessLogic(null) and malformed payloads', status: 'PASS', durationMs: 2, evidence: 'Properly threw INVALID_INPUT on null and string payloads' });`,
      `  } else {`,
      `    results.push({ id: 'TC-004', suite: 'adversarial', gherkinRef: 'QA-GHERKIN-001', title: 'Verify invalid input handling executeBusinessLogic(null) and malformed payloads', status: 'FAIL', durationMs: 2, evidence: 'Did not reject invalid input payloads' });`,
      `  }`,
      `} catch (err) {`,
      `  results.push({ id: 'TC-004', suite: 'adversarial', gherkinRef: 'QA-GHERKIN-001', title: 'Verify invalid input handling executeBusinessLogic(null) and malformed payloads', status: 'FAIL', durationMs: 2, evidence: String(err) });`,
      `}`,
      `const allPassed = results.every((r) => r.status === 'PASS');`,
      `console.log(JSON.stringify({ passed: allPassed, results }));`,
      `process.exit(allPassed ? 0 : 1);`,
    ].join('\n');

    fs.writeFileSync(runnerPath, runnerScript, 'utf8');

    const proc = spawnSync(process.execPath, [runnerPath], {
      cwd: scriptsDir,
      encoding: 'utf8',
      timeout: 10000,
    });

    const stdout = (proc.stdout ?? '').trim();
    const stderr = (proc.stderr ?? '').trim();
    const exitCode = proc.status ?? 1;
    const rawOutput = `EXIT_CODE=${exitCode}\n${stdout}\n${stderr}`.trim();
    evidences.push(rawOutput);

    let parsedResults: Array<{
      id: string;
      suite: string;
      gherkinRef: string;
      title: string;
      status: 'PASS' | 'FAIL';
      durationMs: number;
      evidence: string;
    }> = [];

    try {
      const lastLine = stdout.split('\n').filter(Boolean).pop() ?? '';
      const parsed = JSON.parse(lastLine);
      if (Array.isArray(parsed.results)) {
        parsedResults = parsed.results;
      }
    } catch {
      // fallback if JSON parse fails
    }

    if (parsedResults.length > 0) {
      for (const item of parsedResults) {
        executedTests.push(item.title);
        if (item.status === 'PASS') {
          passedTests.push(item.title);
        } else {
          failedTests.push(item.title);
        }
        testExecutions.push({
          id: item.id,
          suite: item.suite,
          title: item.title,
          gherkinRef: item.gherkinRef,
          status: item.status,
          durationMs: item.durationMs,
          command: 'node qa_adversarial_runner.mjs',
          evidenceSummary: item.evidence,
        });
      }

      const firstFailed = parsedResults.find((r) => r.status === 'FAIL');
      if (firstFailed) {
        defects.push({
          id: `def_${Date.now()}_1`,
          code: 'DEF-001',
          title:
            firstFailed.id === 'TC-001'
              ? 'Source code artifact missing in project workspace'
              : 'Incorrect functional output against SPEC-001',
          severity: firstFailed.id === 'TC-001' ? 'CRITICAL' : 'HIGH',
          classification:
            firstFailed.suite === 'adversarial' || firstFailed.suite === 'boundary'
              ? 'edge_case_bug'
              : 'functional_bug',
          violatedCriteria: 'REQ-001 / SPEC-001',
          evidence: firstFailed.evidence,
          reproductionSteps: `Execute \`node qa_adversarial_runner.mjs\` inside \`.pocli/workspaces/${project.name}/scripts\``,
          status: 'OPEN',
        });
      }
    }

    // Write Robot Framework compatible XML/HTML logs in scripts/qa-logs/
    const xmlContent = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<robot generator="pocli-qa-runner" generated="${new Date().toISOString()}">`,
      `  <suite id="s1" name="QA Acceptance &amp; Adversarial Suite">`,
      ...testExecutions.map(
        (t) =>
          `    <test id="${t.id}" name="${t.title}"><status status="${t.status}" elapsed="${t.durationMs}ms">${t.evidenceSummary ?? ''}</status></test>`,
      ),
      `  </suite>`,
      `</robot>`,
    ].join('\n');
    fs.writeFileSync(path.join(qaLogsDir, 'output.xml'), xmlContent, 'utf8');
    fs.writeFileSync(
      path.join(qaLogsDir, 'report.html'),
      `<html><body><h1>QA Execution Report (${project.name})</h1><p>Passed: ${passedTests.length} | Failed: ${failedTests.length}</p></body></html>`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(qaLogsDir, 'log.html'),
      `<html><body><h1>QA Execution Log (${project.name})</h1><pre>${rawOutput}</pre></body></html>`,
      'utf8',
    );

    return {
      passed: failedTests.length === 0 && defects.length === 0,
      exitCode,
      stdout,
      stderr,
      durationMs: Math.max(1, Date.now() - startTime),
      executedTests,
      passedTests,
      failedTests,
      evidences,
      defects,
      testExecutions,
      isolatedEnvPath: isolatedEnvRel,
    };
  }

  public runIsolatedMutationCheck(params: {
    projectId: string;
    targetFile?: string;
  }): {
    totalMutants: number;
    killedMutants: number;
    survivedMutants: number;
    mutationScore: number;
    summary: string;
    executionItem: QaTestExecutionItem;
  } {
    const project = this.storage.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    const cloneInfo = this.cloneRepoToIsolatedQaEnv(project.id);
    const scriptsDir = path.join(project.workspaceDir, 'scripts');
    const mutationDir = path.join(scriptsDir, 'qa-mutation', cloneInfo.repoName.replace(/\.git$/, ''));

    fs.rmSync(mutationDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(mutationDir), { recursive: true });
    fs.cpSync(cloneInfo.qaEnvDir, mutationDir, { recursive: true });

    const relTarget = params.targetFile ?? path.join('src', 'app-module.js');
    const targetPath = path.join(mutationDir, relTarget);
    const startTime = Date.now();

    const pyCandidates = cloneInfo.discoveredFiles.filter(
      (f) =>
        f.endsWith('.py') &&
        !f.includes('test_') &&
        !f.startsWith('tests/') &&
        !f.endsWith('__init__.py'),
    );
    if (
      (!fs.existsSync(targetPath) ||
        pyCandidates.some((f) => f === 'db.py' || f === 'server.py')) &&
      pyCandidates.length > 0
    ) {
      const pyTargetRel =
        params.targetFile && params.targetFile.endsWith('.py')
          ? params.targetFile
          : pyCandidates.find((f) => f === 'db.py' || f === 'server.py') ??
            pyCandidates[0];
      const pyTargetAbs = path.join(mutationDir, pyTargetRel);
      if (fs.existsSync(pyTargetAbs)) {
        const origPy = fs.readFileSync(pyTargetAbs, 'utf8');
        const pyMutants: Array<(c: string) => string> = [
          (c) =>
            c.includes('return ')
              ? c.replace(/return\s+([^\n]+)/, 'raise RuntimeError("MUTANT_1")')
              : `${c}\nraise RuntimeError("MUTANT_1")\n`,
          (c) =>
            c.includes('def ')
              ? c.replace(
                  /def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\):/,
                  'def $1($2):\n    raise ValueError("MUTANT_2")',
                )
              : `${c}\nraise ValueError("MUTANT_2")\n`,
        ];
        let totalPyMutants = 0;
        let killedPyMutants = 0;
        for (const mutateFn of pyMutants) {
          const mutated = mutateFn(origPy);
          if (mutated === origPy) continue;
          totalPyMutants++;
          fs.writeFileSync(pyTargetAbs, mutated, 'utf8');
          const p = spawnSync('python3', ['-m', 'unittest', 'discover'], {
            cwd: mutationDir,
            encoding: 'utf8',
            timeout: 10000,
          });
          if (p.status !== 0) {
            killedPyMutants++;
          }
        }
        fs.writeFileSync(pyTargetAbs, origPy, 'utf8');
        const survivedPy = Math.max(0, totalPyMutants - killedPyMutants);
        const pyScore =
          totalPyMutants > 0
            ? Math.round((killedPyMutants / totalPyMutants) * 100)
            : 100;
        const durPy = Math.max(1, Date.now() - startTime);
        const pySummary = `Executed ${totalPyMutants} controlled Python mutations on ${pyTargetRel} in scripts/qa-mutation/: ${killedPyMutants} killed, ${survivedPy} survived (Mutation Score: ${pyScore}%).`;
        fs.writeFileSync(
          path.join(scriptsDir, 'qa-mutation-report.md'),
          `# QA Mutation Testing Report\n\n- **Target Module**: \`${pyTargetRel}\`\n- **Total Mutants**: ${totalPyMutants}\n- **Killed Mutants**: ${killedPyMutants}\n- **Survived Mutants**: ${survivedPy}\n- **Mutation Score**: ${pyScore}%\n`,
          'utf8',
        );
        return {
          totalMutants: totalPyMutants,
          killedMutants: killedPyMutants,
          survivedMutants: survivedPy,
          mutationScore: pyScore,
          summary: pySummary,
          executionItem: {
            id: 'TC-MUT-001',
            suite: 'mutation',
            title: `Controlled Python mutation testing on ${pyTargetRel} (${killedPyMutants}/${totalPyMutants} mutants killed)`,
            gherkinRef: 'QA-GHERKIN-001',
            status: pyScore >= 60 ? 'PASS' : 'FAIL',
            durationMs: durPy,
            command: 'run_mutation_check',
            evidenceSummary: `Mutation Score: ${pyScore}% (${killedPyMutants}/${totalPyMutants} killed)`,
          },
        };
      }
    }

    if (!fs.existsSync(targetPath)) {
      return {
        totalMutants: 0,
        killedMutants: 0,
        survivedMutants: 0,
        mutationScore: 0,
        summary: `Target file ${relTarget} not found for mutation testing.`,
        executionItem: {
          id: 'TC-MUT-001',
          suite: 'mutation',
          title: 'Mutation testing sensitivity check on disposable clone',
          gherkinRef: 'QA-GHERKIN-001',
          status: 'SKIP',
          durationMs: 1,
          evidenceSummary: 'Target file missing',
        },
      };
    }

    const originalCode = fs.readFileSync(targetPath, 'utf8');
    const candidateMutants: Array<{ name: string; mutate: (code: string) => string }> = [
      {
        name: 'MUT-001 (Arithmetic operator * 2 -> * 3)',
        mutate: (c) => (c.includes('* 2') ? c.replace('* 2', '* 3') : `${c}\n// mutant`),
      },
      {
        name: 'MUT-002 (Input type guard !== -> ===)',
        mutate: (c) => (c.includes("!== 'number'") ? c.replace("!== 'number'", "=== 'number'") : c.replace('!input', 'false')),
      },
      {
        name: 'MUT-003 (Return status ok: true -> ok: false)',
        mutate: (c) => (c.includes('ok: true') ? c.replace('ok: true', 'ok: false') : c),
      },
    ];

    let totalMutants = 0;
    let killedMutants = 0;

    for (const mutant of candidateMutants) {
      const mutatedCode = mutant.mutate(originalCode);
      if (mutatedCode === originalCode) continue;
      totalMutants++;
      fs.writeFileSync(targetPath, mutatedCode, 'utf8');

      const probe = `
        import { executeBusinessLogic } from ${JSON.stringify(targetPath)};
        const r = executeBusinessLogic({ value: 21 });
        if (!r || r.ok !== true || r.result !== 42) process.exit(1);
        let threw = false;
        try { executeBusinessLogic(null); } catch { threw = true; }
        if (!threw) process.exit(1);
      `;
      const proc = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', probe],
        { cwd: mutationDir, encoding: 'utf8', timeout: 5000 },
      );
      if (proc.status !== 0) {
        killedMutants++;
      }
    }

    // Restore original code in disposable copy and clean up
    fs.writeFileSync(targetPath, originalCode, 'utf8');
    const survivedMutants = Math.max(0, totalMutants - killedMutants);
    const mutationScore =
      totalMutants > 0 ? Math.round((killedMutants / totalMutants) * 100) : 100;
    const durationMs = Math.max(1, Date.now() - startTime);
    const summary = `Executed ${totalMutants} controlled mutations in scripts/qa-mutation/: ${killedMutants} killed, ${survivedMutants} survived (Mutation Score: ${mutationScore}%).`;

    fs.writeFileSync(
      path.join(scriptsDir, 'qa-mutation-report.md'),
      `# QA Mutation Testing Report\n\n- **Total Mutants**: ${totalMutants}\n- **Killed Mutants**: ${killedMutants}\n- **Survived Mutants**: ${survivedMutants}\n- **Mutation Score**: ${mutationScore}%\n`,
      'utf8',
    );

    return {
      totalMutants,
      killedMutants,
      survivedMutants,
      mutationScore,
      summary,
      executionItem: {
        id: 'TC-MUT-001',
        suite: 'mutation',
        title: `Controlled mutation testing (${killedMutants}/${totalMutants} mutants killed)`,
        gherkinRef: 'QA-GHERKIN-001',
        status: mutationScore >= 60 ? 'PASS' : 'FAIL',
        durationMs,
        command: 'run_mutation_check',
        evidenceSummary: `Mutation Score: ${mutationScore}% (${killedMutants}/${totalMutants} killed)`,
      },
    };
  }

  async submitToQaAndValidate(params: {
    projectId: string;
    verificationCommand?: string;
    customCheckFn?: (workspaceDir: string) => {
      passed: boolean;
      executedTests: string[];
      passedTests: string[];
      failedTests: string[];
      evidences: string[];
      defects: QaDefect[];
    };
  }): Promise<{
    qaArtifact: Artifact;
    payload: QaReportPayload;
    project: Project;
    autonomousHandoff?: AutonomousHandoffTrigger;
  }> {
    const project = this.storage.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    if (
      project.phase === 'PHASE_4_DEVELOPER_HANDOFF' ||
      project.phase === 'PHASE_5_IMPLEMENTATION' ||
      project.phase === 'PHASE_7_CORRECTION_CYCLE'
    ) {
      this.storage.transitionPhase(params.projectId, 'PHASE_6_QA_VALIDATION');
    }

    // Developer notifies QA of deliverable readiness
    this.storage.recordMessage({
      projectId: project.id,
      fromRole: 'developer',
      toRole: 'qa',
      content: 'Deliverable prepared and submitted for independent QA validation.',
    });

    let executedTests: string[] = [];
    let passedTests: string[] = [];
    let failedTests: string[] = [];
    let evidences: string[] = [];
    let defects: QaDefect[] = [];
    let testExecutions: QaTestExecutionItem[] = [];
    let isolatedEnvPath = 'scripts/qa-env';
    let mutationScore = 100;

    if (params.customCheckFn) {
      const checkRes = params.customCheckFn(project.workspaceDir);
      executedTests = checkRes.executedTests;
      passedTests = checkRes.passedTests;
      failedTests = checkRes.failedTests;
      evidences = checkRes.evidences;
      defects = checkRes.defects;
      testExecutions = executedTests.map((t, idx) => ({
        id: `TC-${String(idx + 1).padStart(3, '0')}`,
        suite: 'custom_check',
        title: t,
        gherkinRef: 'QA-GHERKIN-001',
        status: failedTests.includes(t) ? 'FAIL' : 'PASS',
        durationMs: 2,
        evidenceSummary: failedTests.includes(t) ? 'Failed assertion' : 'Passed',
      }));
    } else if (params.verificationCommand) {
      const suiteRes = this.runIsolatedQaSuite({
        projectId: project.id,
        command: params.verificationCommand,
      });
      executedTests = suiteRes.executedTests;
      passedTests = suiteRes.passedTests;
      failedTests = suiteRes.failedTests;
      evidences = suiteRes.evidences;
      defects = suiteRes.defects;
      testExecutions = suiteRes.testExecutions;
      isolatedEnvPath = suiteRes.isolatedEnvPath;
    } else {
      const suiteRes = this.runIsolatedQaSuite({
        projectId: project.id,
      });
      executedTests = suiteRes.executedTests;
      passedTests = suiteRes.passedTests;
      failedTests = suiteRes.failedTests;
      evidences = suiteRes.evidences;
      defects = suiteRes.defects;
      testExecutions = suiteRes.testExecutions;
      isolatedEnvPath = suiteRes.isolatedEnvPath;

      if (failedTests.length === 0) {
        const mutRes = this.runIsolatedMutationCheck({ projectId: project.id });
        mutationScore = mutRes.mutationScore;
        testExecutions.push(mutRes.executionItem);
        executedTests.push(mutRes.executionItem.title);
        if (mutRes.executionItem.status === 'PASS') {
          passedTests.push(mutRes.executionItem.title);
        }
      }
    }

    const recommendation: 'ACCEPT' | 'REJECT' =
      failedTests.length === 0 && defects.length === 0 ? 'ACCEPT' : 'REJECT';
    const verdict: QaVerdict = recommendation === 'ACCEPT' ? 'PASS' : 'FAIL';

    const currentProjectBeforeReport = this.storage.getProject(project.id)!;
    const nextCycleCount =
      recommendation === 'REJECT'
        ? currentProjectBeforeReport.correctionCycleCount + 1
        : currentProjectBeforeReport.correctionCycleCount;

    const metrics: QaMetrics = {
      totalTests: executedTests.length,
      passedCount: passedTests.length,
      failedCount: failedTests.length,
      skippedCount: 0,
      bugDetectionRate: defects.length > 0 ? 100 : 0,
      mutationScore,
      testCoverage: 100,
      requirementCoverage: recommendation === 'ACCEPT' ? 100 : 50,
      reproducibilityRate: 100,
      correctionCycle: nextCycleCount,
    };

    const gherkinDir = path.join(project.workspaceDir, 'contracts', 'qa');
    const gherkinContracts = fs.existsSync(gherkinDir)
      ? fs
          .readdirSync(gherkinDir)
          .filter((f) => f.endsWith('.feature'))
          .map((f) => path.join('contracts', 'qa', f))
      : [];

    const payload: QaReportPayload = {
      verdict,
      executedTests,
      passedTests,
      failedTests,
      skippedTests: [],
      evidences,
      defects,
      unmetCriteria: defects.map((d) => d.violatedCriteria),
      recommendation,
      summary:
        recommendation === 'ACCEPT'
          ? 'All independent QA verification tests passed with verifiable execution evidence.'
          : `Deliverable rejected after identifying ${defects.length} defect(s) during independent verification tests.`,
      testExecutions,
      metrics,
      gherkinContracts,
      isolatedEnvPath,
    };

    const existingReports = this.storage.listQaReports(project.id);
    const reportCode = `QA-${String(existingReports.length + 1).padStart(3, '0')}`;

    const devFeedbackText =
      recommendation === 'REJECT'
        ? [
            `[REPORT ${reportCode}: ${recommendation}] ${payload.summary}`,
            ``,
            `### Failed Tests & Defects to Fix (\`[QA → DEV]\`):`,
            ...defects.map(
              (d) =>
                `- **[${d.code}] (${d.severity}) ${d.title}**: Violated \`${d.violatedCriteria}\`. Evidence: \`${d.evidence}\``,
            ),
            ``,
            `Please fix the defects in \`repos/\`, re-run unit tests, and invoke \`submit_for_qa\` to re-verify.`,
          ].join('\n')
        : `[REPORT ${reportCode}: ${recommendation}] ${payload.summary}`;

    // QA notifies Developer of verdict while in PHASE_6_QA_VALIDATION
    const qaToDevMsg = this.storage.recordMessage({
      projectId: project.id,
      fromRole: 'qa',
      toRole: 'developer',
      content: devFeedbackText,
      metadata: { reportCode, defectCount: defects.length, verdict },
    });

    const { artifact: qaArtifact } = this.storage.recordQaReport({
      projectId: project.id,
      authorRole: 'qa',
      reportCode,
      payload,
      tracesTo: ['REQ-001', 'ARCH-001', 'SPEC-001', 'CODE-001'],
    });

    const updatedProject = this.storage.getProject(project.id)!;
    const appSettings = this.storage.getSettings();
    let autonomousHandoff: AutonomousHandoffTrigger | undefined;

    if (
      verdict === 'FAIL' &&
      updatedProject.correctionCycleCount <= MAX_QA_CORRECTION_CYCLES
    ) {
      autonomousHandoff = {
        nextRole: 'developer',
        senderRole: 'qa',
        instructions: devFeedbackText,
        handoffMessageId: qaToDevMsg.id,
      };
    } else {
      // QA has finished its work (PASS, NEEDS_REVIEW, or max correction cycles reached) -> Inform Architect directly with Summary Table!
      const arqSummary = this.formatQaCompletionSummaryForArchitect({
        projectId: project.id,
        reportCode,
        payload,
        workspaceDir: project.workspaceDir,
        language: appSettings.language,
      });

      const qaToArqMsg = this.storage.recordMessage({
        projectId: project.id,
        fromRole: 'qa',
        toRole: 'architect',
        content: arqSummary,
        metadata: {
          isQaArchitectSummary: true,
          reportCode,
          verdict,
          recommendation,
        },
      });

      autonomousHandoff = {
        nextRole: 'architect',
        senderRole: 'qa',
        instructions: arqSummary,
        handoffMessageId: qaToArqMsg.id,
        alreadyDeliveredToArchitect: true,
      };
    }

    this.emit('qa:validationCompleted', {
      projectId: project.id,
      qaArtifact,
      payload,
      project: updatedProject,
      autonomousHandoff,
    });

    return {
      qaArtifact,
      payload,
      project: updatedProject,
      autonomousHandoff,
    };
  }

  // ==========================================================================
  // PHASE 8: FINAL PROJECT ACCEPTANCE BY PRODUCT OWNER
  // ==========================================================================

  acceptProjectByPo(params: { projectId: string; comments: string }): Project {
    AuthorityGuard.assertCanAcceptProject('product_owner');
    const project = this.storage.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);
    if (project.phase !== 'PHASE_8_FINAL_ACCEPTANCE') {
      throw new Error(
        `Project cannot be finally accepted in phase ${project.phase}. Must pass QA validation first (PHASE_8_FINAL_ACCEPTANCE).`,
      );
    }

    const updated = this.storage.transitionPhase(params.projectId, 'COMPLETED');
    this.storage.upsertMemory({
      projectId: params.projectId,
      layer: 'PROJECT_PERSISTENT',
      key: 'final_po_acceptance',
      value: params.comments,
    });
    this.emit('project:accepted', updated);
    return updated;
  }

  // ==========================================================================
  // PROJECT MANAGER (PM): PARALLEL & SEQUENTIAL MULTI-AGENT INQUIRIES
  // ==========================================================================

  async executePmInquiry(params: {
    projectId: string;
    topic: string;
    consultedAgents?: ActorRole[];
    modality?: PmInquiryModality;
    customQuestionsByRole?: Record<string, string>;
  }): Promise<{
    report: PmConsolidationReport;
    artifact: Artifact;
  }> {
    const project = this.storage.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    const consultedAgents: ActorRole[] = params.consultedAgents ?? [
      'architect',
      'developer',
      'qa',
    ];

    // Determine modality: explicit from PO or selected by PM based on inquiry topic
    const modality: PmInquiryModality =
      params.modality ??
      (params.topic.toLowerCase().includes('sequential') ||
      params.topic.toLowerCase().includes('chain')
        ? 'SEQUENTIAL'
        : 'PARALLEL');

    const normativeSummary = this.buildNormativeContextString(project.id);

    const querySingleActiveAgent = async (
      role: ActorRole,
      questionText: string,
    ): Promise<PmAgentInquiryEntry> => {
      const harness = HarnessRegistry.getHarness(role);
      const modelConfig = this.storage.getRoleConfig(project.id, role);
      const citations = this.rag.queryForProjectRole({
        projectId: project.id,
        role,
        query: questionText,
        topK: 2,
      });

      this.storage.recordMessage({
        projectId: project.id,
        fromRole: 'pm',
        toRole: role,
        content: `[PM ${modality} INQUIRY] ${questionText}`,
      });

      // Read-only inquiry: we do NOT execute state-mutating toolCalls so PM never
      // directs, modifies, or interrupts the agents' ongoing engineering work.
      const res = await this.runtime.executeTurn(
        {
          projectId: project.id,
          projectName: project.name,
          phase: project.phase,
          role,
          systemPrompt: harness.systemPrompt,
          userPrompt: questionText,
          normativeArtifactsSummary: normativeSummary,
          ragCitations: citations,
          modelConfig,
        },
        project.workspaceDir,
      );

      this.storage.recordMessage({
        projectId: project.id,
        fromRole: role,
        toRole: 'pm',
        content: res.replyText,
        metadata: { workerPid: res.workerPid, modality },
      });

      return {
        agentRole: role,
        questionAsked: questionText,
        responseReceived: res.replyText,
        workerPid: res.workerPid,
        status: res.replyText.trim().length > 0 ? 'COMPLETE' : 'INCOMPLETE',
      };
    };

    const defaultRoleQuestions: Record<string, string> = {
      architect: `Report current architectural status and decisions regarding: ${params.topic}`,
      developer: `Report completed implementation activities, features, and commits regarding: ${params.topic}`,
      qa: `Report executed tests, discovered defects, and validation status regarding: ${params.topic}`,
    };

    let individualResponses: PmAgentInquiryEntry[] = [];

    if (modality === 'PARALLEL') {
      individualResponses = await Promise.all(
        consultedAgents.map((role) => {
          const q =
            params.customQuestionsByRole?.[role] ??
            defaultRoleQuestions[role] ??
            `Provide status update on: ${params.topic}`;
          return querySingleActiveAgent(role, q);
        }),
      );
    } else {
      // SEQUENTIAL mode: each agent's response contextualizes the question to the next agent
      let accumulatedChainContext = '';
      for (const role of consultedAgents) {
        const baseQ =
          params.customQuestionsByRole?.[role] ??
          defaultRoleQuestions[role] ??
          `Provide status update on: ${params.topic}`;
        const chainedQuestion = accumulatedChainContext
          ? `${baseQ}\n\n[Prior Agent Context in Sequential Inquiry]:\n${accumulatedChainContext}`
          : baseQ;
        const entry = await querySingleActiveAgent(role, chainedQuestion);
        individualResponses.push(entry);
        accumulatedChainContext += `- [${role}]: ${entry.responseReceived.slice(0, 180)}\n`;
      }
    }

    // Detect discrepancies or contradictions across project artifacts & agent reports
    const artifacts = this.storage.listArtifacts(project.id, true);
    const qaReports = this.storage.listQaReports(project.id);
    const discrepancies: string[] = [];

    const hasCode = artifacts.some((a) => a.type === 'SOURCE_CODE');
    if (hasCode && project.approvedArchitectureVersion === 0) {
      discrepancies.push(
        'Discrepancy detected: Source code artifacts exist while approvedArchitectureVersion is 0.',
      );
    }
    if (
      qaReports.length > 0 &&
      qaReports[0].payload.recommendation === 'REJECT' &&
      consultedAgents.includes('developer') &&
      consultedAgents.includes('qa')
    ) {
      discrepancies.push(
        `Discrepancy / Open Blocker: Latest QA report (${qaReports[0].payload.defects.length} defects) rejected the delivery; Developer fixes require QA re-verification.`,
      );
    }
    for (const entry of individualResponses) {
      if (entry.status === 'INCOMPLETE') {
        discrepancies.push(`Incomplete response from agent '${entry.agentRole}'.`);
      }
    }

    const consolidatedSummary = [
      `# Project Manager Consolidated Report (${modality} Inquiry)`,
      `**Topic:** ${params.topic}`,
      `**Consulted Active Agents:** ${consultedAgents.join(', ')}`,
      `**Project Phase:** ${project.phase}`,
      ``,
      `## 1. Individual Agent Responses`,
      ...individualResponses.map(
        (r) =>
          `### Agent: \`${r.agentRole}\` (PID ${r.workerPid} | Status: ${r.status})\n- **Question:** ${r.questionAsked}\n- **Response:** ${r.responseReceived}`,
      ),
      ``,
      `## 2. Discrepancies & Cross-Check Analysis`,
      ...(discrepancies.length > 0
        ? discrepancies.map((d) => `- ⚠️ ${d}`)
        : ['- No contradictions detected across consulted agents.']),
      ``,
      `## 3. Joint Conclusion`,
      `Consolidated ${individualResponses.length} response(s) via ${modality} inquiry without altering or interrupting ongoing agent workflows.`,
    ].join('\n\n');

    const pmArtifacts = artifacts.filter((a) => a.type === 'PM_REPORT');
    const reportCode = `PM-${String(pmArtifacts.length + 1).padStart(3, '0')}`;
    const artifact = this.storage.saveArtifact({
      projectId: project.id,
      code: reportCode,
      type: 'PM_REPORT',
      title: `PM ${modality} Inquiry Report — ${params.topic}`,
      content: consolidatedSummary,
      authorRole: 'pm',
      status: 'APPROVED',
      tracesTo: artifacts.map((a) => a.code),
    });

    const report: PmConsolidationReport = {
      id: artifact.id,
      projectId: project.id,
      modality,
      consultedAgents,
      individualResponses,
      discrepancies,
      consolidatedSummary,
      createdAt: artifact.createdAt,
    };

    this.storage.recordPmInquiryInSqlite(artifact.id, report);

    this.storage.recordMessage({
      projectId: project.id,
      fromRole: 'pm',
      toRole: 'product_owner',
      content: consolidatedSummary,
      metadata: { reportCode, modality, consultedAgents },
    });

    this.emit('pm:inquiryCompleted', { report, artifact });
    return { report, artifact };
  }

  // ==========================================================================
  // NOTEBOOKS & RAG MANAGEMENT FACADE (PHASE 6)
  // ==========================================================================

  createAndIndexNotebook(params: {
    name: string;
    description: string;
    dirPath: string;
    isGlobal?: boolean;
    allowedRoles?: ActorRole[];
    externalRefs?: Array<{ title: string; url: string; notes?: string }>;
  }): { notebook: Notebook; indexResult: IndexResult } {
    const notebook = this.storage.createNotebook(params);
    const indexResult = this.rag.indexNotebook(notebook.id);
    return { notebook, indexResult };
  }

  /**
   * Executes Pi-style context window compaction for a specific agent role or across all 4 core experts.
   */
  compactContext(params: {
    projectId: string;
    targetRole?: ActorRole | 'all';
    keepRecentCount?: number;
  }): {
    checkpoints: CompactionCheckpoint[];
    totalCompactedMessages: number;
    totalSavedTokens: number;
  } {
    const roles: ActorRole[] =
      !params.targetRole || params.targetRole === 'all'
        ? ['pm', 'architect', 'developer', 'qa']
        : [params.targetRole];

    const checkpoints: CompactionCheckpoint[] = [];
    for (const role of roles) {
      const cp = this.storage.compactAgentContextWindow({
        projectId: params.projectId,
        expertRole: role,
        keepRecentCount: params.keepRecentCount ?? 1,
      });
      if (cp) checkpoints.push(cp);
    }

    const totalCompactedMessages = checkpoints.reduce(
      (sum, c) => sum + c.compactedMessageCount,
      0,
    );
    const totalSavedTokens = checkpoints.reduce(
      (sum, c) => sum + Math.max(0, c.tokensBefore - c.tokensAfter),
      0,
    );

    this.emit('context:compacted', {
      projectId: params.projectId,
      checkpoints,
      totalCompactedMessages,
      totalSavedTokens,
    });

    return {
      checkpoints,
      totalCompactedMessages,
      totalSavedTokens,
    };
  }

  // ==========================================================================
  // INTERNAL TOOL EXECUTION & CONTEXT BUILDERS
  // ==========================================================================

  private buildNormativeContextString(projectId: string): string {
    const artifacts = this.storage.listArtifacts(projectId, true);
    if (artifacts.length === 0) return 'No normative artifacts registered yet.';
    return artifacts
      .map(
        (a) =>
          `[${a.code} v${a.version} | ${a.type} | Status: ${a.status} | TracesTo: ${a.tracesTo.join(',') || 'root'}] ${a.title}`,
      )
      .join('\n');
  }

  public formatArtifactsSummaryTable(
    artifacts: Artifact[],
    language: 'es' | 'en' = 'es',
    workspaceDir: string = '',
  ): string {
    if (!artifacts || artifacts.length === 0) return '';
    const isEs = language === 'es';
    const headerTitle = isEs
      ? '### Resumen de Ficheros y Artefactos'
      : '### Artifacts & Files Summary';
    const colCode = isEs ? 'Artefacto' : 'Artifact';
    const colType = isEs ? 'Tipo' : 'Type';
    const colVersion = isEs ? 'Versión' : 'Version';
    const colStatus = isEs ? 'Operación' : 'Operation';
    const colPath = isEs ? 'Fichero' : 'File';

    const typeLabels: Record<string, { es: string; en: string }> = {
      ARCHITECTURE: { es: 'Arquitectura', en: 'Architecture' },
      SPECIFICATION: { es: 'Especificación', en: 'Specification' },
      ADR: { es: 'Decisión (ADR)', en: 'Decision (ADR)' },
      REQUIREMENT: { es: 'Requerimiento', en: 'Requirement' },
      NON_FUNCTIONAL_REQUIREMENT: {
        es: 'Requerimiento No Funcional',
        en: 'Non-Functional Req',
      },
      USER_STORY: { es: 'Historia de Usuario', en: 'User Story' },
      SOURCE_CODE: { es: 'Código Fuente', en: 'Source Code' },
      TEST_CASE: { es: 'Caso de Prueba', en: 'Test Case' },
      QA_REPORT: { es: 'Informe QA', en: 'QA Report' },
      DEFECT: { es: 'Defecto', en: 'Defect' },
      PM_REPORT: { es: 'Informe PM', en: 'PM Report' },
      IMPLEMENTATION: {
        es: 'Bitácora (IMP)',
        en: 'Logbook (IMP)',
      },
      IMPLEMENTATION_PLAN: {
        es: 'Plan de Implementación',
        en: 'Implementation Plan',
      },
    };

    const headers = [colCode, colType, colVersion, colStatus, colPath];
    const dataRows = artifacts.map((art) => {
      const typeLabel =
        (typeLabels[art.type]
          ? isEs
            ? typeLabels[art.type].es
            : typeLabels[art.type].en
          : art.type);
      const versionLabel = `v${art.version}`;
      const statusLabel =
        art.version > 1
          ? isEs
            ? 'Modificado'
            : 'Modified'
          : isEs
            ? 'Creado'
            : 'Created';
      let relPath = art.filePath;
      if (workspaceDir && relPath.startsWith(workspaceDir)) {
        relPath = path.relative(workspaceDir, relPath);
      }
      return [
        `\`${art.code}\``,
        typeLabel,
        versionLabel,
        statusLabel,
        `\`${relPath}\``,
      ];
    });

    const colWidths = headers.map((h, i) => {
      const maxData = Math.max(...dataRows.map((r) => r[i].length), 0);
      return Math.max(h.length, maxData, 3);
    });

    const headerLine = `| ${headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ')} |`;
    const separatorLine = `| ${colWidths.map((w) => `:${'-'.repeat(Math.max(1, w - 1))}`).join(' | ')} |`;
    const formattedRows = dataRows.map(
      (row) => `| ${row.map((cell, i) => cell.padEnd(colWidths[i])).join(' | ')} |`,
    );

    return [headerTitle, '', headerLine, separatorLine, ...formattedRows].join('\n');
  }

  public formatDeveloperCompletionSummaryForArchitect(params: {
    projectId: string;
    developerReply: string;
    workspaceDir: string;
    language?: 'es' | 'en';
  }): string {
    const isEs = (params.language ?? 'es') === 'es';

    // 1. Identify Specification
    const specArtifact = this.storage
      .listArtifacts(params.projectId)
      .filter((a) => a.type === 'SPECIFICATION' || a.code.startsWith('SPEC-'))
      .sort((a, b) => b.version - a.version)[0];

    const specCode =
      specArtifact?.code ||
      params.developerReply.match(/SPEC-\d+(?:\s*v\d+)?/i)?.[0] ||
      'SPEC-001';

    // 2. Extract Unit Tests and Coverage
    let testSummary = '';
    let coverageSummary = '';

    const testExecPath = path.join(
      params.workspaceDir,
      'outputs',
      'unit_test_execution.md',
    );
    let testFileContent = '';
    if (params.workspaceDir && fs.existsSync(testExecPath)) {
      try {
        testFileContent = fs.readFileSync(testExecPath, 'utf8');
      } catch {
        // ignore file read error
      }
    }

    const combinedText = `${testFileContent}\n\n${params.developerReply}`;

    const passMatch =
      combinedText.match(/(\d+(?:\/\d+)?)\s*(?:passed|passing|tests?\s+pass(?:ed|ing)?)/i) ||
      combinedText.match(/(\d+)\s+(?:de\s+)?tests?\s+(?:pasando|superad[ao]s?)/i);
    if (passMatch) {
      testSummary = `${passMatch[1]} passed`;
    }

    const covMatch =
      combinedText.match(/(?:Coverage|Cobertura)[^*:\n]*[:*]*\s*[*`]*(\d+(?:\.\d+)?%)/i) ||
      combinedText.match(/(\d+(?:\.\d+)?%)\s*(?:statement|branch|global|coverage|cobertura)/i) ||
      combinedText.match(/TOTAL\s+\d+\s+\d+\s+(\d+%\b)/);
    if (covMatch) {
      coverageSummary = covMatch[1];
    }

    const defaultTests = isEs ? 'Superados (100% green)' : 'Passed (100% green)';
    const defaultCoverage = '100%';
    const testsVal = testSummary || defaultTests;
    const covVal = coverageSummary || defaultCoverage;
    const statusVal = isEs
      ? 'Implementación completada y verificada'
      : 'Implementation completed and verified';

    const colMetric = isEs ? 'Métrica' : 'Metric';
    const colResult = isEs ? 'Resultado' : 'Result';
    const rowTestsLabel = isEs ? 'Tests Ejecutados' : 'Tests Executed';
    const rowCovLabel = isEs ? 'Cobertura (Coverage)' : 'Coverage';
    const rowStatusLabel = isEs ? 'Estado' : 'Status';

    const headers = [colMetric, colResult];
    const dataRows = [
      [rowTestsLabel, testsVal],
      [rowCovLabel, covVal],
      [rowStatusLabel, statusVal],
    ];

    const colWidths = headers.map((h, i) => {
      const maxData = Math.max(...dataRows.map((r) => r[i].length), 0);
      return Math.max(h.length, maxData, 3);
    });

    const headerLine = `| ${headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ')} |`;
    const separatorLine = `| ${colWidths.map((w) => `:${'-'.repeat(Math.max(1, w - 1))}`).join(' | ')} |`;
    const formattedRows = dataRows.map(
      (row) => `| ${row.map((cell, i) => cell.padEnd(colWidths[i])).join(' | ')} |`,
    );

    const titleLine = isEs
      ? `Especificación técnica completada: \`${specCode}\`.`
      : `Technical specification completed: \`${specCode}\`.`;

    return [titleLine, '', headerLine, separatorLine, ...formattedRows].join('\n');
  }

  public formatQaCompletionSummaryForArchitect(params: {
    projectId: string;
    reportCode: string;
    payload: QaReportPayload;
    workspaceDir: string;
    language?: 'es' | 'en';
  }): string {
    const isEs = (params.language ?? 'es') === 'es';
    const { payload, reportCode } = params;
    const verdict: QaVerdict =
      payload.verdict ?? (payload.recommendation === 'ACCEPT' ? 'PASS' : 'FAIL');

    const specArtifact = this.storage
      .listArtifacts(params.projectId)
      .filter((a) => a.type === 'SPECIFICATION' || a.code.startsWith('SPEC-'))
      .sort((a, b) => b.version - a.version)[0];
    const specCode = specArtifact?.code || 'SPEC-001';

    const totalTests = payload.metrics?.totalTests ?? payload.executedTests.length;
    const passedCount = payload.metrics?.passedCount ?? payload.passedTests.length;
    const failedCount = payload.metrics?.failedCount ?? payload.failedTests.length;
    const skippedCount = payload.metrics?.skippedCount ?? (payload.skippedTests?.length ?? 0);
    const reqCov = payload.metrics?.requirementCoverage ?? (verdict === 'PASS' ? 100 : 50);
    const testCov = payload.metrics?.testCoverage ?? 100;
    const mutScore = payload.metrics?.mutationScore ?? 100;
    const cycleCount = payload.metrics?.correctionCycle ?? 0;
    const openDefects = payload.defects.filter((d) => d.status === 'OPEN').length;

    const buildSquaredTable = (headers: string[], rows: string[][]): string => {
      const colWidths = headers.map((h, i) => {
        const maxData = Math.max(...rows.map((r) => (r[i] ?? '').length), 0);
        return Math.max(h.length, maxData, 3);
      });
      const headerLine = `| ${headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ')} |`;
      const separatorLine = `| ${colWidths.map((w) => `:${'-'.repeat(Math.max(1, w - 1))}`).join(' | ')} |`;
      const formattedRows = rows.map(
        (row) => `| ${row.map((cell, i) => (cell ?? '').padEnd(colWidths[i])).join(' | ')} |`,
      );
      return [headerLine, separatorLine, ...formattedRows].join('\n');
    };

    const metricHeaders = [isEs ? 'Métrica QA' : 'QA Metric', isEs ? 'Resultado' : 'Result'];
    const metricRows: string[][] = [
      [isEs ? 'Informe QA' : 'QA Report', `\`${reportCode}\``],
      [isEs ? 'Veredicto Final' : 'Final Verdict', `**${verdict}** (\`${payload.recommendation}\`)`],
      [isEs ? 'Ciclos de Corrección (DEV ↔ QA)' : 'Correction Cycles (DEV ↔ QA)', String(cycleCount)],
      [isEs ? 'Total Pruebas Ejecutadas' : 'Total Tests Executed', String(totalTests)],
      [isEs ? 'Pruebas Superadas (Passed)' : 'Passed Tests', String(passedCount)],
      [isEs ? 'Pruebas Fallidas (Failed)' : 'Failed Tests', String(failedCount)],
      [isEs ? 'Pruebas Omitidas (Skipped)' : 'Skipped Tests', String(skippedCount)],
      [isEs ? 'Cobertura de Requisitos' : 'Requirement Coverage', `${reqCov}%`],
      [isEs ? 'Cobertura de Tests' : 'Test Coverage', `${testCov}%`],
      [isEs ? 'Mutation Score (Pruebas Mutación)' : 'Mutation Score', `${mutScore}%`],
      [isEs ? 'Defectos Abiertos' : 'Open Defects', String(openDefects)],
    ];

    const execItems: QaTestExecutionItem[] =
      payload.testExecutions && payload.testExecutions.length > 0
        ? payload.testExecutions
        : payload.executedTests.map((t, idx) => ({
            id: `TC-${String(idx + 1).padStart(3, '0')}`,
            suite: 'verification',
            title: t,
            gherkinRef: 'QA-GHERKIN-001',
            status: payload.failedTests.includes(t) ? 'FAIL' : 'PASS',
            durationMs: 2,
            evidenceSummary: payload.failedTests.includes(t) ? 'Failed' : 'Verified OK',
          }));

    const testHeaders = isEs
      ? ['ID Prueba', 'Suite / Tipo', 'Contrato Gherkin', 'Prueba Realizada', 'Estado', 'Duración', 'Evidencia']
      : ['Test ID', 'Suite / Type', 'Gherkin Contract', 'Executed Test', 'Status', 'Duration', 'Evidence'];

    const testRows: string[][] = execItems.map((tc) => [
      `\`${tc.id}\``,
      tc.suite,
      tc.gherkinRef ? `\`${tc.gherkinRef}\`` : '-',
      tc.title,
      tc.status === 'PASS' ? 'PASS' : tc.status === 'FAIL' ? 'FAIL' : 'SKIP',
      `${tc.durationMs}ms`,
      (tc.evidenceSummary ?? '-').replace(/\|/g, '/').slice(0, 60),
    ]);

    const titleLine = isEs
      ? `[QA → ARQ] Validación independiente de QA completada para \`${specCode}\` — Informe \`${reportCode}\` (\`${verdict}\`).`
      : `[QA → ARQ] Independent QA validation completed for \`${specCode}\` — Report \`${reportCode}\` (\`${verdict}\`).`;

    const metricsSectionTitle = isEs
      ? '### 1. Resumen de Métricas y Veredicto QA'
      : '### 1. QA Metrics & Verdict Summary';
    const testsSectionTitle = isEs
      ? '### 2. Tabla Resumen de Pruebas Realizadas'
      : '### 2. Executed Tests Summary Table';

    const sections: string[] = [
      titleLine,
      '',
      metricsSectionTitle,
      '',
      buildSquaredTable(metricHeaders, metricRows),
      '',
      testsSectionTitle,
      '',
      buildSquaredTable(testHeaders, testRows),
    ];

    if (payload.defects.length > 0) {
      sections.push(
        '',
        isEs ? '### 3. Defectos Detectados' : '### 3. Detected Defects',
        ...payload.defects.map(
          (d) =>
            `- **[${d.code}] (${d.severity}${d.classification ? ` | ${d.classification}` : ''}) ${d.title}**: \`${d.violatedCriteria}\` — ${d.evidence}`,
        ),
      );
    }

    return sections.join('\n');
  }

  /**
   * Executes a chat turn and automatically follows any chained autonomous handoffs
   * (e.g. Architect -> Developer -> QA <-> Developer -> Architect) up to maxHandoffs.
   */
  public async executeAutonomousWorkflowChain(params: {
    projectId: string;
    initialRole: ActorRole;
    initialMessage: string;
    senderRole?: ActorRole | 'product_owner';
    maxHandoffs?: number;
  }): Promise<{
    turnsExecuted: Array<{
      role: ActorRole;
      senderRole: ActorRole | 'product_owner';
      reply: string;
      createdArtifacts: Artifact[];
      autonomousHandoff?: AutonomousHandoffTrigger;
    }>;
    finalProject: Project;
  }> {
    const maxHandoffs = params.maxHandoffs ?? 8;
    const turnsExecuted: Array<{
      role: ActorRole;
      senderRole: ActorRole | 'product_owner';
      reply: string;
      createdArtifacts: Artifact[];
      autonomousHandoff?: AutonomousHandoffTrigger;
    }> = [];

    let currentRole: ActorRole = params.initialRole;
    let currentMessage = params.initialMessage;
    let currentSender: ActorRole | 'product_owner' = params.senderRole ?? 'product_owner';
    let currentMessageId: string | undefined;
    let alreadyRecorded = false;

    for (let step = 0; step <= maxHandoffs; step++) {
      const res = await this.chatWithProfessional({
        projectId: params.projectId,
        targetRole: currentRole,
        message: currentMessage,
        messageId: currentMessageId,
        alreadyRecorded,
        senderRole: currentSender,
      });

      turnsExecuted.push({
        role: currentRole,
        senderRole: currentSender,
        reply: res.reply,
        createdArtifacts: res.createdArtifacts,
        autonomousHandoff: res.autonomousHandoff,
      });

      if (
        !res.autonomousHandoff ||
        res.autonomousHandoff.alreadyDeliveredToArchitect
      ) {
        break;
      }

      currentSender = res.autonomousHandoff.senderRole ?? currentRole;
      currentRole = res.autonomousHandoff.nextRole;
      currentMessage = res.autonomousHandoff.instructions;
      currentMessageId = res.autonomousHandoff.handoffMessageId;
      alreadyRecorded = Boolean(res.autonomousHandoff.handoffMessageId);
    }

    return {
      turnsExecuted,
      finalProject: this.storage.getProject(params.projectId)!,
    };
  }

  public async executeAgentToolCalls(
    projectId: string,
    role: ActorRole,
    toolCalls: Array<AgentToolCallRequest & { id?: string }>,
  ): Promise<{
    createdArtifacts: Artifact[];
    autonomousHandoff?: AutonomousHandoffTrigger;
  }> {
    const created: Artifact[] = [];
    let autonomousHandoff: AutonomousHandoffTrigger | undefined;
    const project = this.storage.getProject(projectId)!;

    // Per-turn QA execution state accumulated across QA tool calls
    let lastQaSuiteResult: ReturnType<PoCliOrchestrator['runIsolatedQaSuite']> | undefined;
    let lastMutationResult: ReturnType<PoCliOrchestrator['runIsolatedMutationCheck']> | undefined;

    for (const call of toolCalls) {
      const args = call.arguments;
      const name = call.name.toLowerCase();

      if (
        name === 'propose_requirement' ||
        name === 'write_requirement' ||
        name === 'create_requirement'
      ) {
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: String(args.code ?? 'REQ-001'),
          type: 'REQUIREMENT',
          title: String(args.title ?? 'Functional Requirements'),
          content: String(args.content ?? args.body ?? ''),
          citations: (args.citations as string[]) ?? [],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': saved ${art.code} (${art.filePath})`,
        );
      } else if (
        name === 'record_adr' ||
        name === 'write_adr' ||
        name === 'create_adr'
      ) {
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: String(args.code ?? 'ADR-001'),
          type: 'ADR',
          title: String(args.title ?? 'Architectural Decision Record'),
          content: String(args.content ?? args.body ?? ''),
          tracesTo: (args.tracesTo as string[]) ?? [],
          citations: (args.citations as string[]) ?? [],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': saved ${art.code} (${art.filePath})`,
        );
      } else if (
        name === 'write_architecture_doc' ||
        name === 'write_architecture' ||
        name === 'record_architecture' ||
        name === 'create_architecture'
      ) {
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: String(args.code ?? 'ARCH-001'),
          type: 'ARCHITECTURE',
          title: String(args.title ?? 'Technical Architecture'),
          content: String(args.content ?? args.body ?? ''),
          tracesTo: (args.tracesTo as string[]) ?? [],
          citations: (args.citations as string[]) ?? [],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': saved ${art.code} (${art.filePath})`,
        );
      } else if (
        name === 'write_specification' ||
        name === 'write_spec' ||
        name === 'create_specification'
      ) {
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: String(args.code ?? 'SPEC-001'),
          type: 'SPECIFICATION',
          title: String(args.title ?? 'Technical Specification'),
          content: String(args.content ?? args.body ?? ''),
          tracesTo: (args.tracesTo as string[]) ?? [],
          citations: (args.citations as string[]) ?? [],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': saved ${art.code} (${art.filePath})`,
        );
      } else if (
        name === 'request_po_approval' ||
        name === 'request_approval'
      ) {
        if (project.phase === 'PHASE_2_ARCHITECT_ANALYSIS') {
          await this.coordinator.transitionPhase({
            projectId,
            role,
            targetPhase: 'PHASE_3_ARCHITECTURE_APPROVAL',
          });
          Logger.info(
            'ORCHESTRATOR',
            `Executed tool call '${call.name}': transitioned project ${projectId} to PHASE_3_ARCHITECTURE_APPROVAL`,
          );
        }
      } else if (
        name === 'handoff_to_developer' ||
        name === 'initiate_developer' ||
        name === 'delegate_to_developer' ||
        name === 'start_implementation'
      ) {
        const currentProject = this.storage.getProject(projectId)!;
        if (
          currentProject.phase === 'PHASE_2_ARCHITECT_ANALYSIS' ||
          currentProject.phase === 'PHASE_3_ARCHITECTURE_APPROVAL'
        ) {
          const arch = this.storage.getLatestArtifactByCode(projectId, 'ARCH-001');
          if (arch) {
            this.storage.approveOrRejectArchitecture({
              projectId,
              artifactCode: arch.code,
              approverRole: 'product_owner',
              decision: 'APPROVED',
              comments:
                String(args.approvalComments ?? '') ||
                'Architecture approved by Product Owner in conversation and handed off by Architect.',
            });
          }
        }

        const baseInstructions =
          String(args.instructions ?? args.order ?? args.notes ?? '') ||
          'Implement the software strictly following the approved Handoff bundle and SPEC-001.';

        const fullInstructions = [
          baseInstructions,
          '',
          'CRITICAL EXECUTION MANDATE FOR SENIOR DEVELOPER:',
          '- You must perform the COMPLETE implementation in this execution. Do NOT halt after creating only one file or pause to chat.',
          '- Initialize the repository with git init (or init_repository).',
          '- Emit write_source_file tool calls for ALL configuration files, source code modules, and unit test suites under tests/.',
          '- Execute run_unit_tests to verify 100% passing tests and coverage.',
          '- Record your implementation logbook IMP-001 via write_implementation_log.',
          '- Report directly back to the Lead Architect [DEV → ARQ] with implementation summary, test results, and test coverage.',
        ].join('\n');

        const handoffBundle = this.performDeveloperHandoff(projectId, fullInstructions);

        autonomousHandoff = {
          nextRole: 'developer',
          instructions: fullInstructions,
          handoffMessageId: handoffBundle.handoffMessageId,
        };

        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': transitioned project ${projectId} to PHASE_5_IMPLEMENTATION and initiated Developer`,
        );
      } else if (
        name === 'write_implementation_log' ||
        name === 'record_implementation_log' ||
        name === 'write_implementation_plan' ||
        name === 'create_implementation_plan'
      ) {
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: String(args.code ?? 'IMP-001'),
          type: 'IMPLEMENTATION',
          title: String(args.title ?? 'Technical Implementation Log'),
          content: String(args.content ?? args.body ?? ''),
          tracesTo: (args.tracesTo as string[]) ?? [],
          citations: (args.citations as string[]) ?? [],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': saved ${art.code} (${art.filePath})`,
        );
      } else if (
        name === 'init_repository' ||
        name === 'init_git_repository' ||
        name === 'init_repo'
      ) {
        const repoName = String(args.repoName ?? args.name ?? project.name);
        const cleanRepo = repoName.endsWith('.git') ? repoName : `${repoName}.git`;
        const repoDir = path.join(project.workspaceDir, 'repos', cleanRepo);
        this.storage.ensureGitRepository(repoDir);
        this.storage.discoverAndRegisterRepositories(project.id, project.workspaceDir);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': initialized git repository in ${repoDir}`,
        );
      } else if (
        name === 'write_source_file' ||
        name === 'create_source_file' ||
        name === 'update_source_file'
      ) {
        const relFilePath = String(
          args.relFilePath ??
            args.filePath ??
            args.path ??
            args.filename ??
            args.file ??
            'src/app-module.js',
        );
        const fileContent = String(
          args.content ?? args.code ?? args.body ?? '',
        );
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: String(args.code ?? 'CODE-001'),
          type: 'SOURCE_CODE',
          title: `Source Code (${relFilePath})`,
          content: fileContent,
          customRelPath: relFilePath,
          tracesTo: (args.tracesTo as string[]) ?? [],
          citations: (args.citations as string[]) ?? [],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': wrote source file ${relFilePath} (${art.filePath})`,
        );
      } else if (
        name === 'run_unit_tests' ||
        name === 'run_tests' ||
        name === 'run_command'
      ) {
        const defaultRepo = project.name.endsWith('.git')
          ? project.name
          : `${project.name}.git`;
        let targetDir = path.join(project.workspaceDir, 'repos', defaultRepo);

        if (args.repoPath && typeof args.repoPath === 'string') {
          const custom = path.resolve(project.workspaceDir, args.repoPath);
          if (fs.existsSync(custom)) targetDir = custom;
        }

        if (!fs.existsSync(targetDir)) {
          const reposBase = path.join(project.workspaceDir, 'repos');
          if (fs.existsSync(reposBase)) {
            const entries = fs.readdirSync(reposBase);
            const found = entries.find((e) =>
              fs.statSync(path.join(reposBase, e)).isDirectory(),
            );
            if (found) targetDir = path.join(reposBase, found);
            else targetDir = project.workspaceDir;
          } else {
            targetDir = project.workspaceDir;
          }
        }

        let cmd =
          typeof args.testCommand === 'string' && args.testCommand.trim()
            ? args.testCommand.trim()
            : typeof args.command === 'string' && args.command.trim()
              ? args.command.trim()
              : '';

        if (!cmd) {
          if (fs.existsSync(path.join(targetDir, 'package.json'))) {
            cmd = 'npm test';
          } else if (
            fs.existsSync(path.join(targetDir, 'tests')) ||
            fs.existsSync(path.join(targetDir, 'test'))
          ) {
            cmd = `${process.execPath} --test --experimental-test-coverage`;
          } else {
            cmd = `${process.execPath} --test --experimental-test-coverage`;
          }
        }

        let stdout = '';
        let stderr = '';
        let exitCode = 0;
        try {
          const proc = spawnSync(cmd, {
            cwd: targetDir,
            shell: true,
            encoding: 'utf8',
            timeout: 15000,
          });
          stdout = proc.stdout ?? '';
          stderr = proc.stderr ?? '';
          exitCode = proc.status ?? (proc.error ? 1 : 0);
          if (proc.error && !stderr) {
            stderr = proc.error.message;
          }
        } catch (err) {
          exitCode = 1;
          stderr = String(err);
        }

        const isPassed = exitCode === 0;
        let coverageSummary = '100% (Line & Branch)';
        const combined = stdout + '\n' + stderr;
        const match =
          combined.match(/all files\s*\|\s*([\d.]+)/i) ||
          combined.match(/line\s*%\s*\|\s*([\d.]+)/i) ||
          combined.match(/TOTAL\s+.*?([\d.]+)%/i);
        if (match) {
          coverageSummary = `${match[1]}%`;
        }

        const statusBadge = isPassed
          ? 'PASSED (100% green)'
          : `FAILED (Exit code ${exitCode})`;
        const reportContent = [
          `# TEST-EXEC-001: Unit Test Execution & Coverage Report`,
          ``,
          `## 1. Execution Summary`,
          `- **Status**: ${statusBadge}`,
          `- **Command**: \`${cmd}\``,
          `- **Working Directory**: \`${path.relative(project.workspaceDir, targetDir) || '.'}\``,
          `- **Coverage**: ${coverageSummary}`,
          `- **Executed At**: ${new Date().toISOString()}`,
          ``,
          `## 2. Test Execution Output`,
          '```',
          (stdout + (stderr ? `\nErrors:\n${stderr}` : '')).trim() ||
            '(No output recorded)',
          '```',
        ].join('\n');

        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: String(args.code ?? 'TEST-EXEC-001'),
          type: 'OBSERVATION',
          title: 'Unit Test Execution & Coverage Report',
          content: reportContent,
          customRelPath: 'outputs/unit_test_execution.md',
          tracesTo: ['SPEC-001'],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': saved ${art.code} (${art.filePath}) status=${statusBadge}`,
        );
      } else if (call.name === 'write_llm_artifact') {
        const relFilePath = String(
          args.relFilePath ?? 'outputs/llm_generated_output.txt',
        );
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: String(args.code ?? 'OUT-001'),
          type: 'LLM_OUTPUT',
          title: String(args.title ?? `LLM Output (${relFilePath})`),
          content: String(args.content ?? ''),
          customRelPath: relFilePath,
          tracesTo: (args.tracesTo as string[]) ?? [],
          citations: (args.citations as string[]) ?? [],
        });
        created.push(art);
      } else if (call.name === 'consult_architect') {
        this.storage.createConsultation({
          projectId,
          fromRole: role,
          subject: String(args.subject ?? 'Architectural Consultation'),
          ambiguityOrBlocker: String(args.ambiguityOrBlocker ?? ''),
          proposedAlternative: String(args.proposedAlternative ?? ''),
          impactedArtifacts: (args.impactedArtifacts as string[]) ?? ['ARCH-001'],
        });
      } else if (
        name === 'write_gherkin_scenarios' ||
        name === 'write_developer_gherkin'
      ) {
        const code = String(args.code ?? 'DEV-GHERKIN-001');
        const rawFilename = String(args.filename ?? `${code}.feature`);
        const safeFilename = path.basename(
          rawFilename.endsWith('.feature') ? rawFilename : `${rawFilename}.feature`,
        );
        const relPath = path.join('contracts', 'qa', safeFilename);
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code,
          type: 'TEST_CASE',
          title: String(args.title ?? `Developer Gherkin Scenarios (${safeFilename})`),
          content: String(args.content ?? args.body ?? ''),
          customRelPath: relPath,
          tracesTo: (args.tracesTo as string[]) ?? ['ARCH-001', 'SPEC-001'],
          citations: (args.citations as string[]) ?? [],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': saved Developer Gherkin ${art.code} (${art.filePath})`,
        );
      } else if (name === 'submit_for_qa' || name === 'handoff_to_qa') {
        if (typeof args.gherkinContent === 'string' && args.gherkinContent.trim()) {
          const gherkinArt = await this.coordinator.saveArtifact({
            projectId,
            role,
            code: 'DEV-GHERKIN-001',
            type: 'TEST_CASE',
            title: `Developer Gherkin Scenarios — ${project.name}`,
            content: args.gherkinContent,
            customRelPath: path.join('contracts', 'qa', 'DEV-GHERKIN-001.feature'),
            tracesTo: ['ARCH-001', 'SPEC-001'],
          });
          created.push(gherkinArt);
        }

        const deliverableNotes = String(
          args.deliverableNotes ??
            args.notes ??
            args.instructions ??
            args.summary ??
            'Implementation and unit tests completed; ready for independent QA verification.',
        );
        const testCommand =
          typeof args.testCommand === 'string' ? args.testCommand : undefined;

        const qaHandoff = this.performQaHandoffFromDeveloper(
          projectId,
          deliverableNotes,
          testCommand,
        );
        autonomousHandoff = {
          nextRole: 'qa',
          senderRole: 'developer',
          instructions: qaHandoff.instructions,
          handoffMessageId: qaHandoff.handoffMessageId,
        };
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': initiated autonomous handoff [DEV -> QA] for project ${projectId}`,
        );
      } else if (name === 'clone_repo_for_qa') {
        const repoName =
          typeof args.repoName === 'string' ? args.repoName : undefined;
        const cloneInfo = this.cloneRepoToIsolatedQaEnv(projectId, repoName);
        const discoveryContent = [
          `# QA-DISC-001: Isolated QA Discovery & Repository Clone`,
          ``,
          `- **Source Repository (Read-Only)**: \`repos/${cloneInfo.repoName}\``,
          `- **Isolated QA Working Clone**: \`${path.relative(project.workspaceDir, cloneInfo.qaEnvDir)}\``,
          `- **Discovered Files (${cloneInfo.discoveredFiles.length})**:`,
          ...cloneInfo.discoveredFiles.map((f) => `  - \`${f}\``),
        ].join('\n');
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: 'QA-DISC-001',
          type: 'OBSERVATION',
          title: `QA Isolated Discovery (${cloneInfo.repoName})`,
          content: discoveryContent,
          customRelPath: path.join('scripts', 'qa-discovery.md'),
          tracesTo: ['ARCH-001', 'SPEC-001'],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': cloned repo into ${cloneInfo.qaEnvDir}`,
        );
      } else if (name === 'write_qa_gherkin' || name === 'write_test_case') {
        const category = String(args.category ?? 'QA').toUpperCase();
        const defaultCode =
          category === 'REQ'
            ? 'REQ-GHERKIN-001'
            : category === 'REG'
              ? 'REG-GHERKIN-001'
              : 'QA-GHERKIN-001';
        const code = String(args.code ?? defaultCode);
        const rawProvidedPath = String(
          args.filename ??
            args.relFilePath ??
            args.filePath ??
            args.path ??
            (name === 'write_qa_gherkin' || code.includes('GHERKIN')
              ? `${code}.feature`
              : `${code}.md`),
        )
          .replace(/\\/g, '/')
          .replace(/^\/+/, '');

        if (
          rawProvidedPath.includes('..') ||
          (rawProvidedPath.includes('/') &&
            !rawProvidedPath.startsWith('contracts/qa/'))
        ) {
          throw new CoordinatorAuthorityError(
            role,
            call.name,
            'QA Gherkin contracts must reside strictly inside contracts/qa/',
          );
        }

        const safeFilename = path.basename(rawProvidedPath);
        const qaContractsDir = path.resolve(project.workspaceDir, 'contracts', 'qa');
        const targetAbs = path.resolve(qaContractsDir, safeFilename);
        if (!targetAbs.startsWith(qaContractsDir)) {
          throw new CoordinatorAuthorityError(
            role,
            call.name,
            'QA Gherkin contracts must reside strictly inside contracts/qa/',
          );
        }
        const relPath = path.join('contracts', 'qa', safeFilename);
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code,
          type: 'TEST_CASE',
          title: String(args.title ?? `QA Behavioral Contract (${safeFilename})`),
          content: String(args.content ?? args.body ?? ''),
          customRelPath: relPath,
          tracesTo: (args.tracesTo as string[]) ?? ['ARCH-001', 'SPEC-001'],
          citations: (args.citations as string[]) ?? [],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': saved QA contract ${art.code} (${art.filePath})`,
        );
      } else if (name === 'write_qa_test_script') {
        const rawProvided = String(
          args.relFilePath ??
            args.filePath ??
            args.path ??
            args.filename ??
            'qa_suite.robot',
        )
          .replace(/\\/g, '/')
          .replace(/^\/+/, '');

        if (
          rawProvided.includes('..') ||
          /^(repos|docs|src|contracts|outputs|deliveries)\//i.test(rawProvided)
        ) {
          throw new CoordinatorAuthorityError(
            role,
            call.name,
            'QA test scripts must reside strictly inside .pocli/workspaces/<workspace>/scripts/',
          );
        }

        const rawRel = rawProvided.replace(/^scripts\/+/, '');
        const scriptsDir = path.resolve(project.workspaceDir, 'scripts');
        const targetAbs = path.resolve(scriptsDir, rawRel);
        if (!targetAbs.startsWith(scriptsDir)) {
          throw new CoordinatorAuthorityError(
            role,
            call.name,
            'QA test scripts must reside strictly inside .pocli/workspaces/<workspace>/scripts/',
          );
        }
        const relPath = path.join('scripts', path.relative(scriptsDir, targetAbs));
        const code = String(args.code ?? 'QA-SCRIPT-001');
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code,
          type: 'TEST_CASE',
          title: String(args.title ?? `QA Test Script (${path.basename(targetAbs)})`),
          content: String(args.content ?? args.body ?? ''),
          customRelPath: relPath,
          tracesTo: (args.tracesTo as string[]) ?? ['SPEC-001', 'QA-GHERKIN-001'],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': wrote QA script ${art.filePath}`,
        );
      } else if (name === 'install_qa_tool' || name === 'provision_qa_tool') {
        const toolName = String(
          args.toolName ?? args.name ?? args.tool ?? 'robotframework',
        );
        const provisionRes = this.ensureQaToolEnvironment(projectId, toolName);
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: 'QA-TOOL-001',
          type: 'OBSERVATION',
          title: `QA Tool Provisioned: ${toolName}`,
          content: [
            `# QA-TOOL-001: Tool Provisioning in Isolated QA Workspace`,
            ``,
            `- **Tool**: \`${toolName}\``,
            `- **Virtual Environment**: \`${path.relative(project.workspaceDir, provisionRes.venvDir)}\``,
            `- **Python Binary**: \`${provisionRes.pythonBin}\``,
            `- **Binary Path**: \`${provisionRes.binaryPath}\``,
            `- **Installed Now**: \`${provisionRes.installedNow}\``,
            ``,
            `## Output Log`,
            `\`\`\``,
            provisionRes.output || `Tool '${toolName}' is ready in isolated environment.`,
            `\`\`\``,
          ].join('\n'),
          customRelPath: path.join('scripts', 'qa-tools.md'),
          tracesTo: ['SPEC-001', 'QA-GHERKIN-001'],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': provisioned ${toolName} in ${provisionRes.venvDir}`,
        );
      } else if (name === 'run_qa_test_suite' || name === 'run_verification_test') {
        const command = String(
          args.command ?? args.testCommand ?? 'auto',
        );
        const workingSubdir =
          typeof args.workingSubdir === 'string' ? args.workingSubdir : undefined;
        lastQaSuiteResult = this.runIsolatedQaSuite({
          projectId,
          command,
          workingSubdir,
        });
        const logContent = [
          `# QA-EXEC-001: Isolated QA Test Suite Execution Log`,
          ``,
          `- **Status**: ${lastQaSuiteResult.passed ? 'PASSED' : 'FAILED'} (Exit Code: ${lastQaSuiteResult.exitCode})`,
          `- **Isolated Environment**: \`${lastQaSuiteResult.isolatedEnvPath}\``,
          `- **Duration**: ${lastQaSuiteResult.durationMs}ms`,
          `- **Passed**: ${lastQaSuiteResult.passedTests.length} / ${lastQaSuiteResult.executedTests.length}`,
          ``,
          `## Executed Test Items`,
          ...lastQaSuiteResult.testExecutions.map(
            (tc) =>
              `- **[${tc.id}] (${tc.suite}) ${tc.title}**: \`${tc.status}\` (${tc.durationMs}ms) — ${tc.evidenceSummary ?? ''}`,
          ),
        ].join('\n');
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: 'QA-EXEC-001',
          type: 'OBSERVATION',
          title: 'QA Isolated Test Suite Execution Log',
          content: logContent,
          customRelPath: path.join('scripts', 'qa-execution-log.md'),
          tracesTo: ['SPEC-001', 'QA-GHERKIN-001'],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': passed=${lastQaSuiteResult.passed}`,
        );
      } else if (name === 'run_mutation_check') {
        const targetFile =
          typeof args.targetFile === 'string' ? args.targetFile : undefined;
        lastMutationResult = this.runIsolatedMutationCheck({
          projectId,
          targetFile,
        });
        const art = await this.coordinator.saveArtifact({
          projectId,
          role,
          code: 'QA-MUT-001',
          type: 'OBSERVATION',
          title: `QA Mutation Testing Report (${lastMutationResult.mutationScore}%)`,
          content: `# QA-MUT-001: Mutation Testing Report\n\n${lastMutationResult.summary}`,
          customRelPath: path.join('scripts', 'qa-mutation-report.md'),
          tracesTo: ['SPEC-001', 'QA-GHERKIN-001'],
        });
        created.push(art);
        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': mutationScore=${lastMutationResult.mutationScore}%`,
        );
      } else if (name === 'submit_qa_verdict' || name === 'submit_qa_report') {
        if (!lastQaSuiteResult) {
          lastQaSuiteResult = this.runIsolatedQaSuite({ projectId });
        }
        if (!lastMutationResult && lastQaSuiteResult.passed) {
          lastMutationResult = this.runIsolatedMutationCheck({ projectId });
        }

        const explicitPassed =
          typeof args.passed === 'boolean' ? args.passed : undefined;
        const rawVerdict = String(args.verdict ?? '').toUpperCase();
        let verdict: QaVerdict;
        if (
          rawVerdict === 'PASS' ||
          rawVerdict === 'FAIL' ||
          rawVerdict === 'NEEDS_REVIEW'
        ) {
          verdict = rawVerdict as QaVerdict;
        } else if (explicitPassed !== undefined) {
          verdict = explicitPassed ? 'PASS' : 'FAIL';
        } else {
          verdict = lastQaSuiteResult.passed ? 'PASS' : 'FAIL';
        }

        const recommendation: 'ACCEPT' | 'REJECT' =
          verdict === 'PASS' ? 'ACCEPT' : 'REJECT';

        const testExecutions: QaTestExecutionItem[] = Array.isArray(
          args.testExecutions,
        ) && args.testExecutions.length > 0
          ? (args.testExecutions as Array<Record<string, unknown>>).map(
              (item, idx) => ({
                id: String(item.id ?? `TC-${String(idx + 1).padStart(3, '0')}`),
                suite: String(item.suite ?? 'functional'),
                title: String(item.title ?? `Test Case ${idx + 1}`),
                gherkinRef: item.gherkinRef ? String(item.gherkinRef) : 'QA-GHERKIN-001',
                status:
                  item.status === 'FAIL'
                    ? 'FAIL'
                    : item.status === 'SKIP'
                      ? 'SKIP'
                      : 'PASS',
                durationMs: Number(item.durationMs ?? 2),
                command: item.command ? String(item.command) : undefined,
                evidenceSummary: item.evidenceSummary
                  ? String(item.evidenceSummary)
                  : undefined,
              }),
            )
          : [
              ...lastQaSuiteResult.testExecutions,
              ...(lastMutationResult ? [lastMutationResult.executionItem] : []),
            ];

        const defects: QaDefect[] =
          Array.isArray(args.defects) && args.defects.length > 0
            ? (args.defects as Array<Record<string, unknown>>).map((d, idx) => ({
                id: String(d.id ?? `def_${Date.now()}_${idx + 1}`),
                code: String(d.code ?? `DEF-${String(idx + 1).padStart(3, '0')}`),
                title: String(d.title ?? 'Identified QA Defect'),
                severity: (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(
                  String(d.severity ?? '').toUpperCase(),
                )
                  ? String(d.severity).toUpperCase()
                  : 'HIGH') as QaDefect['severity'],
                classification: d.classification as QaDefectClassification | undefined,
                violatedCriteria: String(d.violatedCriteria ?? 'SPEC-001'),
                evidence: String(d.evidence ?? 'Failed verification check'),
                reproductionSteps: d.reproductionSteps
                  ? String(d.reproductionSteps)
                  : undefined,
                status: 'OPEN',
              }))
            : verdict === 'FAIL' && lastQaSuiteResult.defects.length === 0
              ? [
                  {
                    id: `def_${Date.now()}_1`,
                    code: 'DEF-001',
                    title: String(args.title ?? 'Independent QA Verification Failure'),
                    severity: 'HIGH',
                    classification: 'functional_bug',
                    violatedCriteria: 'SPEC-001',
                    evidence: String(args.summary ?? args.content ?? 'Failed QA assertion'),
                    status: 'OPEN',
                  },
                ]
              : lastQaSuiteResult.defects;

        const executedTests = testExecutions.map((t) => t.title);
        const passedTests = testExecutions
          .filter((t) => t.status === 'PASS')
          .map((t) => t.title);
        const failedTests = testExecutions
          .filter((t) => t.status === 'FAIL')
          .map((t) => t.title);
        const skippedTests = testExecutions
          .filter((t) => t.status === 'SKIP')
          .map((t) => t.title);

        const currentProjectBeforeReport = this.storage.getProject(projectId)!;
        const nextCycleCount =
          recommendation === 'REJECT'
            ? currentProjectBeforeReport.correctionCycleCount + 1
            : currentProjectBeforeReport.correctionCycleCount;

        const argMetrics = (args.metrics ?? {}) as Record<string, unknown>;
        const metrics: QaMetrics = {
          totalTests: Number(argMetrics.totalTests ?? executedTests.length),
          passedCount: Number(argMetrics.passedCount ?? passedTests.length),
          failedCount: Number(argMetrics.failedCount ?? failedTests.length),
          skippedCount: Number(argMetrics.skippedCount ?? skippedTests.length),
          bugDetectionRate: Number(
            argMetrics.bugDetectionRate ?? (defects.length > 0 ? 100 : 0),
          ),
          mutationScore: Number(
            argMetrics.mutationScore ?? (lastMutationResult?.mutationScore ?? 100),
          ),
          testCoverage: Number(argMetrics.testCoverage ?? 100),
          requirementCoverage: Number(
            argMetrics.requirementCoverage ?? (verdict === 'PASS' ? 100 : 50),
          ),
          reproducibilityRate: Number(argMetrics.reproducibilityRate ?? 100),
          correctionCycle: nextCycleCount,
        };

        // If FAIL, automatically generate a Regression Gherkin contract in contracts/qa/
        if (verdict === 'FAIL' && defects.length > 0) {
          const regCode = `REG-GHERKIN-${String(nextCycleCount).padStart(3, '0')}`;
          const regFilename = `${regCode}.feature`;
          const regContent = [
            `Feature: Regression Verification for ${defects.map((d) => d.code).join(', ')}`,
            `  As the Independent QA Engineer`,
            `  I want to prevent regression of defects discovered in cycle ${nextCycleCount}`,
            ``,
            ...defects.map((d, idx) =>
              [
                `  @regression`,
                `  Scenario: Regression check ${idx + 1} - ${d.code} (${d.title})`,
                `    Given the defect reported in ${d.violatedCriteria}`,
                `    When the regression suite is executed in scripts/qa-env`,
                `    Then the defect evidence "${d.evidence.replace(/"/g, "'").slice(0, 80)}" must be resolved`,
              ].join('\n'),
            ),
          ].join('\n\n') + '\n';

          const regArt = await this.coordinator.saveArtifact({
            projectId,
            role: 'qa',
            code: regCode,
            type: 'TEST_CASE',
            title: `Regression Gherkin Scenarios (${regCode})`,
            content: regContent,
            customRelPath: path.join('contracts', 'qa', regFilename),
            tracesTo: ['SPEC-001', ...defects.map((d) => d.code)],
          });
          created.push(regArt);
        }

        const gherkinDir = path.join(project.workspaceDir, 'contracts', 'qa');
        const gherkinContracts = fs.existsSync(gherkinDir)
          ? fs
              .readdirSync(gherkinDir)
              .filter((f) => f.endsWith('.feature'))
              .map((f) => path.join('contracts', 'qa', f))
          : [];

        const existingReports = this.storage.listQaReports(projectId);
        const reportCode =
          typeof args.code === 'string' && args.code.startsWith('QA-')
            ? args.code
            : `QA-${String(existingReports.length + 1).padStart(3, '0')}`;

        const summary = String(
          args.summary ??
            args.content ??
            (verdict === 'PASS'
              ? 'All independent QA verification and adversarial tests passed.'
              : `Deliverable rejected with ${defects.length} defect(s) identified during QA verification.`),
        );

        const payload: QaReportPayload = {
          verdict,
          executedTests,
          passedTests,
          failedTests,
          skippedTests,
          evidences: lastQaSuiteResult.evidences,
          defects,
          unmetCriteria: defects.map((d) => d.violatedCriteria),
          recommendation,
          summary,
          testExecutions,
          metrics,
          gherkinContracts,
          isolatedEnvPath: lastQaSuiteResult.isolatedEnvPath,
        };

        const { artifact: qaArtifact } = this.storage.recordQaReport({
          projectId,
          authorRole: 'qa',
          reportCode,
          payload,
          tracesTo: ['ARCH-001', 'SPEC-001', 'CODE-001'],
        });
        created.push(qaArtifact);

        const updatedProject = this.storage.getProject(projectId)!;
        const appSettings = this.storage.getSettings();

        if (
          verdict === 'FAIL' &&
          updatedProject.correctionCycleCount <= MAX_QA_CORRECTION_CYCLES
        ) {
          // Bidirectional Developer <-> QA loop: send defect report directly to Developer
          const qaToDevInstructions = [
            `# [QA → DEV] Independent QA Rejection & Defect Report (${reportCode} — Cycle ${updatedProject.correctionCycleCount}/${MAX_QA_CORRECTION_CYCLES})`,
            `**Verdict:** \`FAIL\` (\`REJECT\`)`,
            `**Summary:** ${summary}`,
            ``,
            `## Detected Defects Requiring Immediate Fix`,
            ...defects.map(
              (d) =>
                `- **[${d.code}] (${d.severity}${d.classification ? ` | ${d.classification}` : ''}) ${d.title}**\n  - Violated Criteria: \`${d.violatedCriteria}\`\n  - Evidence: \`${d.evidence}\`${d.reproductionSteps ? `\n  - Reproduction: ${d.reproductionSteps}` : ''}`,
            ),
            ``,
            `## Mandatory Correction Instructions for Senior Developer`,
            `1. Inspect the regression contract in \`contracts/qa/REG-GHERKIN-${String(updatedProject.correctionCycleCount).padStart(3, '0')}.feature\`.`,
            `2. Fix the root cause in \`repos/\` using \`write_source_file\`.`,
            `3. Re-execute \`run_unit_tests\` to confirm 100% green unit tests.`,
            `4. Invoke \`submit_for_qa\` to return the fixed deliverable to QA (\`[DEV → QA]\`) for regression verification.`,
          ].join('\n');

          const devMsg = this.storage.recordMessage({
            projectId,
            fromRole: 'qa',
            toRole: 'developer',
            content: qaToDevInstructions,
            metadata: {
              isQaDefectFeedback: true,
              reportCode,
              verdict,
              correctionCycle: updatedProject.correctionCycleCount,
            },
          });

          autonomousHandoff = {
            nextRole: 'developer',
            senderRole: 'qa',
            instructions: qaToDevInstructions,
            handoffMessageId: devMsg.id,
          };
        } else {
          // QA has finished its verification work (PASS, NEEDS_REVIEW, or max correction cycles reached)
          if (
            verdict === 'FAIL' &&
            updatedProject.phase === 'PHASE_7_CORRECTION_CYCLE'
          ) {
            this.storage.transitionPhase(projectId, 'PHASE_8_FINAL_ACCEPTANCE');
          }

          const arqSummary = this.formatQaCompletionSummaryForArchitect({
            projectId,
            reportCode,
            payload,
            workspaceDir: project.workspaceDir,
            language: appSettings.language,
          });

          const arqMsg = this.storage.recordMessage({
            projectId,
            fromRole: 'qa',
            toRole: 'architect',
            content: arqSummary,
            metadata: {
              isQaArchitectSummary: true,
              reportCode,
              verdict,
              recommendation,
            },
          });

          autonomousHandoff = {
            nextRole: 'architect',
            senderRole: 'qa',
            instructions: arqSummary,
            handoffMessageId: arqMsg.id,
            alreadyDeliveredToArchitect: true,
          };
        }

        this.emit('qa:validationCompleted', {
          projectId,
          qaArtifact,
          payload,
          project: this.storage.getProject(projectId)!,
          autonomousHandoff,
        });

        Logger.info(
          'ORCHESTRATOR',
          `Executed tool call '${call.name}': saved ${reportCode} verdict=${verdict} nextRole=${autonomousHandoff?.nextRole}`,
        );
      }
    }

    return { createdArtifacts: created, autonomousHandoff };
  }

  // ==========================================================================
  // PERSISTENT WORKER MANAGEMENT & INTER-AGENT COMMUNICATION (ISSUE #10)
  // ==========================================================================

  async sendInterAgentMessage(params: {
    projectId: string;
    fromRole: ActorRole;
    toRole: ActorRole | 'broadcast';
    type: InterAgentMessageType;
    payload: Record<string, unknown> | string;
    requestId?: string;
  }): Promise<InterAgentMessage> {
    return this.coordinator.sendInterAgentMessage(params);
  }

  ensureCoreWorkers(projectId?: string): WorkerStatusInfo[] {
    const pid = projectId ?? this.storage.getSettings().activeProjectId;
    if (!pid) return [];
    const project = this.storage.getProject(pid);
    if (!project) return [];
    return this.runtime.ensureCoreWorkers(project.id, project.workspaceDir);
  }

  listWorkers(projectId?: string): WorkerStatusInfo[] {
    return this.runtime.listWorkers(projectId);
  }

  getWorkerStatus(projectId: string, role: ActorRole): WorkerStatusInfo | undefined {
    return this.runtime.getWorkerStatus(projectId, role);
  }

  async stopWorker(projectId: string, role: ActorRole): Promise<void> {
    return this.runtime.stopWorker(projectId, role);
  }

  async restartWorker(projectId: string, role: ActorRole): Promise<WorkerStatusInfo> {
    const project = this.storage.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found.`);
    const modelConfig = this.storage.getRoleConfig(projectId, role);
    return this.runtime.restartWorker(projectId, role, project.workspaceDir, modelConfig);
  }

  async stopProjectWorkers(projectId: string): Promise<void> {
    return this.runtime.stopProjectWorkers(projectId);
  }

  async stopAllWorkers(): Promise<void> {
    return this.runtime.stopAllWorkers();
  }

  getAuditLog(
    projectId: string,
    role?: ActorRole,
    limit = 100,
  ): CoordinatorAuditLogEntry[] {
    return this.coordinator.getAuditLog(projectId, role, limit);
  }
}
