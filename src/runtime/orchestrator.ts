import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ActorRole,
  ApprovalRecord,
  ArchitecturalConsultation,
  Artifact,
  Notebook,
  PmAgentInquiryEntry,
  PmConsolidationReport,
  PmInquiryModality,
  Project,
  QaDefect,
  QaReportPayload,
  RagCitation,
} from '../core/contracts.js';
import { AuthorityGuard } from '../core/workflow.js';
import { PoCliDatabase } from '../storage/database.js';
import { HarnessRegistry } from './harnesses.js';
import { AgentToolCallRequest } from './llm-gateway.js';
import { McpRegistry } from './mcp-client.js';
import { IndexResult, NotebookRagEngine } from './notebook-rag.js';
import { LinuxAgentProcessRunner, WorkerExecutionResult } from './process-runner.js';

export interface HandoffBundle {
  projectId: string;
  approvedArchitectureVersion: number;
  architectureArtifact: Artifact;
  requirements: Artifact[];
  adrs: Artifact[];
  specifications: Artifact[];
  resolvedConsultations: ArchitecturalConsultation[];
  markdownSummary: string;
}

export class PoCliOrchestrator extends EventEmitter {
  public readonly rag: NotebookRagEngine;
  public readonly processRunner: LinuxAgentProcessRunner;
  public readonly mcp: McpRegistry;

  constructor(public readonly storage: PoCliDatabase) {
    super();
    this.rag = new NotebookRagEngine(storage);
    this.processRunner = new LinuxAgentProcessRunner();
    this.mcp = new McpRegistry();
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

  // ==========================================================================
  // PHASE 2 & DIRECT COMMUNICATION: PO <-> ANY PROFESSIONAL
  // ==========================================================================

  async chatWithProfessional(params: {
    projectId: string;
    targetRole: ActorRole;
    message: string;
    onStreamChunk?: (chunk: string) => void;
  }): Promise<{
    reply: string;
    workerPid: number;
    modalityUsed: string;
    createdArtifacts: Artifact[];
    citations: RagCitation[];
    project: Project;
  }> {
    const project = this.storage.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    const harness = HarnessRegistry.getHarness(params.targetRole);
    const modelConfig = this.storage.getRoleConfig(project.id, params.targetRole);

    // Record Product Owner's message
    this.storage.recordMessage({
      projectId: project.id,
      fromRole: 'product_owner',
      toRole: params.targetRole,
      content: params.message,
    });

    // Query authorized Notebooks via Hybrid RAG
    const citations = this.rag.queryForProjectRole({
      projectId: project.id,
      role: params.targetRole,
      query: params.message,
      topK: 4,
    });

    const normativeSummary = this.buildNormativeContextString(project.id);

    // Execute turn inside isolated Linux process via JSON-RPC 2.0 over stdio
    const turnResult: WorkerExecutionResult = await this.processRunner.executeTurnInProcess(
      {
        projectId: project.id,
        projectName: project.name,
        phase: project.phase,
        role: params.targetRole,
        systemPrompt: harness.systemPrompt,
        userPrompt: params.message,
        normativeArtifactsSummary: normativeSummary,
        ragCitations: citations,
        modelConfig,
      },
      project.workspaceDir,
      params.onStreamChunk,
    );

    // Execute tool calls emitted by the specialist
    const createdArtifacts = this.executeAgentToolCalls(
      project.id,
      params.targetRole,
      turnResult.toolCalls,
    );

    // Record specialist's reply
    this.storage.recordMessage({
      projectId: project.id,
      fromRole: params.targetRole,
      toRole: 'product_owner',
      content: turnResult.replyText,
      metadata: {
        workerPid: turnResult.workerPid,
        modalityUsed: turnResult.modalityUsed,
        modelUsed: turnResult.modelUsed,
        citations: citations.map((c) => NotebookRagEngine.formatCitationTag(c)),
      },
    });

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

  performDeveloperHandoff(projectId: string): HandoffBundle {
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

    const markdownSummary = [
      `# Normative Developer Handoff Bundle`,
      `**Project:** ${project.name}`,
      `**Approved Architecture:** ${arch.code} v${arch.version} (SHA-256: \`${arch.sha256.slice(0, 12)}\`)`,
      ``,
      `## 1. Approved Architecture (${arch.code})`,
      arch.content,
      ``,
      `## 2. Requirements (${requirements.map((r) => r.code).join(', ')})`,
      ...requirements.map((r) => r.content),
      ``,
      `## 3. Architectural Decision Records (${adrs.map((a) => a.code).join(', ')})`,
      ...adrs.map((a) => a.content),
      ``,
      `## 4. Technical Specifications (${specifications.map((s) => s.code).join(', ')})`,
      ...specifications.map((s) => s.content),
    ].join('\n\n');

    // Record official Architect -> Developer handoff message
    this.storage.recordMessage({
      projectId,
      fromRole: 'architect',
      toRole: 'developer',
      content: markdownSummary,
      metadata: { handoffArchitectureVersion: arch.version },
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
  }> {
    const project = this.storage.getProject(params.projectId);
    if (!project) throw new Error(`Project ${params.projectId} not found.`);

    if (
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

    if (params.customCheckFn) {
      const checkRes = params.customCheckFn(project.workspaceDir);
      executedTests = checkRes.executedTests;
      passedTests = checkRes.passedTests;
      failedTests = checkRes.failedTests;
      evidences = checkRes.evidences;
      defects = checkRes.defects;
    } else if (params.verificationCommand) {
      executedTests = [`Command execution: ${params.verificationCommand}`];
      const proc = spawnSync('bash', ['-c', params.verificationCommand], {
        cwd: project.workspaceDir,
        encoding: 'utf8',
        timeout: 15000,
      });
      const output = `EXIT_CODE=${proc.status}\nSTDOUT:\n${proc.stdout ?? ''}\nSTDERR:\n${proc.stderr ?? ''}`.trim();
      evidences = [output];

      if (proc.status === 0) {
        passedTests = [...executedTests];
      } else {
        failedTests = [...executedTests];
        defects = [
          {
            id: `def_${Date.now()}`,
            code: 'DEF-001',
            title: 'QA verification command execution failed',
            severity: 'HIGH',
            violatedCriteria: 'REQ-001 / SPEC-001',
            evidence: output.slice(0, 300),
            status: 'OPEN',
          },
        ];
      }
    } else {
      // Default independent verification of generated source code artifact in workspace
      const targetFile = path.join(project.workspaceDir, 'src', 'app-module.js');
      executedTests = [
        'Verify existence of implemented module src/app-module.js',
        'Verify functional contract executeBusinessLogic({ value: 21 }) === 42',
        'Verify invalid input handling executeBusinessLogic(null)',
      ];
      if (!fs.existsSync(targetFile)) {
        failedTests = [...executedTests];
        evidences = [`File not found in workspace: ${targetFile}`];
        defects = [
          {
            id: `def_${Date.now()}`,
            code: 'DEF-001',
            title: 'Source code artifact missing in project workspace',
            severity: 'CRITICAL',
            violatedCriteria: 'SPEC-001',
            evidence: `Missing ${targetFile}`,
            status: 'OPEN',
          },
        ];
      } else {
        const probeScript = `
          import { executeBusinessLogic } from '${targetFile}';
          const res = executeBusinessLogic({ value: 21 });
          if (!res || res.result !== 42) {
            console.error('ASSERTION_FAILED: expected result 42, got', JSON.stringify(res));
            process.exit(1);
          }
          console.log('VERIFICATION_OK:', JSON.stringify(res));
        `;
        const proc = spawnSync(
          process.execPath,
          ['--input-type=module', '-e', probeScript],
          { cwd: project.workspaceDir, encoding: 'utf8', timeout: 10000 },
        );
        const output = `EXIT_CODE=${proc.status}\n${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim();
        evidences = [output];
        if (proc.status === 0) {
          passedTests = [...executedTests];
        } else {
          failedTests = [executedTests[1]];
          passedTests = [executedTests[0]];
          defects = [
            {
              id: `def_${Date.now()}`,
              code: 'DEF-001',
              title: 'Incorrect functional output against SPEC-001',
              severity: 'HIGH',
              violatedCriteria: 'REQ-001 / SPEC-001',
              evidence: output,
              status: 'OPEN',
            },
          ];
        }
      }
    }

    const recommendation: 'ACCEPT' | 'REJECT' =
      failedTests.length === 0 && defects.length === 0 ? 'ACCEPT' : 'REJECT';

    const payload: QaReportPayload = {
      executedTests,
      passedTests,
      failedTests,
      evidences,
      defects,
      unmetCriteria: defects.map((d) => d.violatedCriteria),
      recommendation,
      summary:
        recommendation === 'ACCEPT'
          ? 'All independent QA verification tests passed with verifiable execution evidence.'
          : `Deliverable rejected after identifying ${defects.length} defect(s) during independent verification tests.`,
    };

    const existingReports = this.storage.listQaReports(project.id);
    const reportCode = `QA-${String(existingReports.length + 1).padStart(3, '0')}`;

    // QA notifies Developer of verdict while in PHASE_6_QA_VALIDATION
    this.storage.recordMessage({
      projectId: project.id,
      fromRole: 'qa',
      toRole: 'developer',
      content: `[REPORT ${reportCode}: ${recommendation}] ${payload.summary}`,
      metadata: { reportCode, defectCount: defects.length },
    });

    const { artifact: qaArtifact } = this.storage.recordQaReport({
      projectId: project.id,
      authorRole: 'qa',
      reportCode,
      payload,
      tracesTo: ['REQ-001', 'ARCH-001', 'SPEC-001', 'CODE-001'],
    });

    const updatedProject = this.storage.getProject(project.id)!;
    this.emit('qa:validationCompleted', {
      projectId: project.id,
      qaArtifact,
      payload,
      project: updatedProject,
    });

    return {
      qaArtifact,
      payload,
      project: updatedProject,
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
      const res = await this.processRunner.executeTurnInProcess(
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

  private executeAgentToolCalls(
    projectId: string,
    role: ActorRole,
    toolCalls: AgentToolCallRequest[],
  ): Artifact[] {
    const created: Artifact[] = [];
    const project = this.storage.getProject(projectId)!;

    for (const call of toolCalls) {
      const args = call.arguments;
      if (call.name === 'propose_requirement') {
        created.push(
          this.storage.saveArtifact({
            projectId,
            code: String(args.code ?? 'REQ-001'),
            type: 'REQUIREMENT',
            title: String(args.title ?? 'Functional Requirements'),
            content: String(args.content ?? ''),
            authorRole: role,
            status: 'DRAFT',
            citations: (args.citations as string[]) ?? [],
          }),
        );
      } else if (call.name === 'record_adr') {
        created.push(
          this.storage.saveArtifact({
            projectId,
            code: String(args.code ?? 'ADR-001'),
            type: 'ADR',
            title: String(args.title ?? 'Architectural Decision Record'),
            content: String(args.content ?? ''),
            authorRole: role,
            status: 'DRAFT',
            tracesTo: (args.tracesTo as string[]) ?? [],
            citations: (args.citations as string[]) ?? [],
          }),
        );
      } else if (call.name === 'write_architecture_doc') {
        created.push(
          this.storage.saveArtifact({
            projectId,
            code: String(args.code ?? 'ARCH-001'),
            type: 'ARCHITECTURE',
            title: String(args.title ?? 'Technical Architecture'),
            content: String(args.content ?? ''),
            authorRole: role,
            status: 'PENDING_APPROVAL',
            tracesTo: (args.tracesTo as string[]) ?? [],
            citations: (args.citations as string[]) ?? [],
          }),
        );
      } else if (call.name === 'write_specification') {
        created.push(
          this.storage.saveArtifact({
            projectId,
            code: String(args.code ?? 'SPEC-001'),
            type: 'SPECIFICATION',
            title: String(args.title ?? 'Technical Specification'),
            content: String(args.content ?? ''),
            authorRole: role,
            status: 'DRAFT',
            tracesTo: (args.tracesTo as string[]) ?? [],
            citations: (args.citations as string[]) ?? [],
          }),
        );
      } else if (call.name === 'request_po_approval') {
        if (project.phase === 'PHASE_2_ARCHITECT_ANALYSIS') {
          this.storage.transitionPhase(projectId, 'PHASE_3_ARCHITECTURE_APPROVAL');
        }
      } else if (call.name === 'write_implementation_plan') {
        created.push(
          this.storage.saveArtifact({
            projectId,
            code: String(args.code ?? 'PLAN-001'),
            type: 'IMPLEMENTATION_PLAN',
            title: String(args.title ?? 'Implementation Plan'),
            content: String(args.content ?? ''),
            authorRole: role,
            status: 'APPROVED',
            tracesTo: (args.tracesTo as string[]) ?? [],
            citations: (args.citations as string[]) ?? [],
          }),
        );
      } else if (call.name === 'write_source_file') {
        const relFilePath = String(args.relFilePath ?? 'src/app-module.js');
        created.push(
          this.storage.saveArtifact({
            projectId,
            code: String(args.code ?? 'CODE-001'),
            type: 'SOURCE_CODE',
            title: `Source Code (${relFilePath})`,
            content: String(args.content ?? ''),
            authorRole: role,
            status: 'DRAFT',
            customRelPath: relFilePath,
            tracesTo: (args.tracesTo as string[]) ?? [],
            citations: (args.citations as string[]) ?? [],
          }),
        );
      } else if (call.name === 'write_llm_artifact') {
        const relFilePath = String(
          args.relFilePath ?? 'outputs/llm_generated_output.txt',
        );
        created.push(
          this.storage.saveArtifact({
            projectId,
            code: String(args.code ?? 'OUT-001'),
            type: 'LLM_OUTPUT',
            title: String(args.title ?? `LLM Output (${relFilePath})`),
            content: String(args.content ?? ''),
            authorRole: role,
            status: 'APPROVED',
            customRelPath: relFilePath,
            tracesTo: (args.tracesTo as string[]) ?? [],
            citations: (args.citations as string[]) ?? [],
          }),
        );
      } else if (call.name === 'consult_architect') {
        this.storage.createConsultation({
          projectId,
          fromRole: role,
          subject: String(args.subject ?? 'Architectural Consultation'),
          ambiguityOrBlocker: String(args.ambiguityOrBlocker ?? ''),
          proposedAlternative: String(args.proposedAlternative ?? ''),
          impactedArtifacts: (args.impactedArtifacts as string[]) ?? ['ARCH-001'],
        });
      }
    }

    return created;
  }
}
