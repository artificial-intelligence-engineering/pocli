import { z } from 'zod';

// ============================================================================
// 1. ROLES & ACTORS
// ============================================================================

export const CoreRoleSchema = z.enum(['architect', 'developer', 'qa', 'pm']);
export type CoreRole = z.infer<typeof CoreRoleSchema>;

export const ActorRoleSchema = z.union([
  z.literal('product_owner'),
  CoreRoleSchema,
  z.string().min(2), // Extensible custom specialist roles (Phase 7)
]);
export type ActorRole = z.infer<typeof ActorRoleSchema>;

// ============================================================================
// 2. WORKFLOW PHASES (8 PHASES OF AGENTS.MD SECTION 6)
// ============================================================================

export const WorkflowPhaseSchema = z.enum([
  'PHASE_1_PROJECT_CREATION',
  'PHASE_2_ARCHITECT_ANALYSIS',
  'PHASE_3_ARCHITECTURE_APPROVAL',
  'PHASE_4_DEVELOPER_HANDOFF',
  'PHASE_5_IMPLEMENTATION',
  'PHASE_6_QA_VALIDATION',
  'PHASE_7_CORRECTION_CYCLE',
  'PHASE_8_FINAL_ACCEPTANCE',
  'COMPLETED',
]);
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;

// ============================================================================
// 3. ARTIFACTS & TRACEABILITY (AGENTS.MD SECTION 7)
// ============================================================================

export const ArtifactTypeSchema = z.enum([
  'REQUIREMENT',
  'NON_FUNCTIONAL_REQUIREMENT',
  'USER_STORY',
  'ARCHITECTURE',
  'ADR',
  'SPECIFICATION',
  'IMPLEMENTATION',
  'IMPLEMENTATION_PLAN',
  'SOURCE_CODE',
  'TEST_CASE',
  'QA_REPORT',
  'DEFECT',
  'PM_REPORT',
  'LLM_OUTPUT',
  'DOCUMENTATION',
  'EXPERIMENT',
  'OBSERVATION',
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  code: z.string(), // e.g., REQ-001, ARCH-001, ADR-001, QA-001
  type: ArtifactTypeSchema,
  title: z.string(),
  content: z.string(),
  version: z.number().int().positive(),
  status: ArtifactStatusSchema,
  authorRole: ActorRoleSchema,
  filePath: z.string(),
  sha256: z.string(),
  tracesTo: z.array(z.string()).default([]), // Artifact codes this traces to
  citations: z.array(z.string()).default([]), // Notebook citations used
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ApprovalRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  artifactId: z.string(),
  artifactCode: z.string(),
  artifactVersion: z.number().int().positive(),
  approverRole: ActorRoleSchema,
  decision: z.enum(['APPROVED', 'REJECTED']),
  comments: z.string(),
  createdAt: z.string(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

// ============================================================================
// 3.1 GOVERNED AGENTIC DEVELOPMENT: ODD ARTIFACT PAYLOADS (AGENTS.MD 6, 7)
// ============================================================================

export const ExecutionModalitySchema = z.enum([
  'LOCAL_PROCESS',
  'LINUX_BWRAP',
  'OCI_CONTAINER',
]);
export type ExecutionModality = z.infer<typeof ExecutionModalitySchema>;

export const ExperimentVerdictSchema = z.enum([
  'DISCARD',                       // Hypothesis invalidated/infeasible; discarded without polluting main architecture
  'PROMOTE_TO_ADR',                // Strategic architectural discovery to be formalized as ADR-*
  'PROMOTE_TO_SPEC',               // Technical implementation pattern to be formalized as SPEC-*
  'NEEDS_FURTHER_EXPERIMENTATION', // Inconclusive; requires additional spikes or testing
]);
export type ExperimentVerdict = z.infer<typeof ExperimentVerdictSchema>;

export const ExperimentExecutionStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  commandOrSnippet: z.string(),
  exitCode: z.number().int().optional(),
  observedOutput: z.string(),
  executionTimeMs: z.number().optional(),
});
export type ExperimentExecutionStep = z.infer<typeof ExperimentExecutionStepSchema>;

export const ExperimentArtifactPayloadSchema = z.object({
  hypothesis: z.string().min(10),
  context: z.object({
    environment: ExecutionModalitySchema,
    branchOrCommit: z.string().optional(),
    targetDependencies: z.array(z.string()).default([]),
  }),
  steps: z.array(ExperimentExecutionStepSchema).min(1),
  rawEvidenceSnippet: z.string().optional(),
  findings: z.array(z.string()).min(1),
  openQuestionsForPo: z.array(z.string()).default([]),
  verdict: ExperimentVerdictSchema,
  justification: z.string().min(10),
  promotedTo: z.object({
    artifactCode: z.string(), // e.g., ADR-002 or SPEC-003
    promotedAt: z.string(),   // ISO 8601
  }).optional(),
});
export type ExperimentArtifactPayload = z.infer<typeof ExperimentArtifactPayloadSchema>;

export const ObservationArtifactPayloadSchema = z.object({
  targetEntity: z.string().min(3), // e.g. "legacy/auth/session_manager.py" or "Stripe Webhook API v2024-10"
  environment: z.union([ExecutionModalitySchema, z.literal('EXTERNAL_SYSTEM')]),
  summary: z.string().min(10),
  findings: z.array(z.string()).min(1),
  relatedFiles: z.array(z.string()).default([]),
  tracesToArtifacts: z.array(z.string()).default([]),
  potentialRisks: z.array(z.string()).default([]),
});
export type ObservationArtifactPayload = z.infer<typeof ObservationArtifactPayloadSchema>;

// ============================================================================
// 4. AUTHORITY CONSULTATIONS & QA REPORTS (AGENTS.MD SECTIONS 4, 5, 6)
// ============================================================================

export const ConsultationStatusSchema = z.enum([
  'OPEN',
  'ESCALATED_TO_PO',
  'RESOLVED_BY_ARCHITECT',
  'APPROVED_BY_PO',
  'REJECTED_BY_PO',
]);
export type ConsultationStatus = z.infer<typeof ConsultationStatusSchema>;

export const ArchitecturalConsultationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  fromRole: ActorRoleSchema,
  toRole: z.literal('architect'),
  subject: z.string(),
  ambiguityOrBlocker: z.string(),
  proposedAlternative: z.string(),
  impactedArtifacts: z.array(z.string()).default([]),
  requiresPoIntervention: z.boolean().default(false),
  architectAssessment: z.string().optional(),
  poDecisionNotes: z.string().optional(),
  status: ConsultationStatusSchema,
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
});
export type ArchitecturalConsultation = z.infer<typeof ArchitecturalConsultationSchema>;

export const DefectSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type DefectSeverity = z.infer<typeof DefectSeveritySchema>;

export const QaVerdictSchema = z.enum(['PASS', 'FAIL', 'NEEDS_REVIEW']);
export type QaVerdict = z.infer<typeof QaVerdictSchema>;

export const QaDefectClassificationSchema = z.enum([
  'functional_bug',
  'edge_case_bug',
  'performance_issue',
  'security_issue',
  'specification_issue',
  'missing_requirement',
]);
export type QaDefectClassification = z.infer<typeof QaDefectClassificationSchema>;

export const QaDefectSchema = z.object({
  id: z.string(),
  code: z.string(), // e.g., DEF-001
  title: z.string(),
  severity: DefectSeveritySchema,
  classification: QaDefectClassificationSchema.optional(),
  violatedCriteria: z.string(),
  evidence: z.string(),
  reproductionSteps: z.string().optional(),
  regressionGherkin: z.string().optional(),
  status: z.enum(['OPEN', 'FIXED', 'VERIFIED']),
});
export type QaDefect = z.infer<typeof QaDefectSchema>;

export const QaTestExecutionItemSchema = z.object({
  id: z.string(),
  suite: z.string().default('functional'),
  title: z.string(),
  gherkinRef: z.string().optional(),
  status: z.enum(['PASS', 'FAIL', 'SKIP']),
  durationMs: z.number().nonnegative().default(0),
  command: z.string().optional(),
  evidenceSummary: z.string().optional(),
});
export type QaTestExecutionItem = z.infer<typeof QaTestExecutionItemSchema>;

export const QaToolProvisionResultSchema = z.object({
  toolName: z.string(),
  installed: z.boolean(),
  envPath: z.string(),
  binaryPath: z.string(),
  output: z.string(),
});
export type QaToolProvisionResult = z.infer<typeof QaToolProvisionResultSchema>;

export const QaMetricsSchema = z.object({
  totalTests: z.number().int().nonnegative(),
  passedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative().default(0),
  bugDetectionRate: z.number().min(0).max(100).optional(),
  mutationScore: z.number().min(0).max(100).optional(),
  testCoverage: z.number().min(0).max(100).optional(),
  requirementCoverage: z.number().min(0).max(100).optional(),
  reproducibilityRate: z.number().min(0).max(100).default(100),
  correctionCycle: z.number().int().nonnegative().default(0),
});
export type QaMetrics = z.infer<typeof QaMetricsSchema>;

export const QaReportPayloadSchema = z.object({
  verdict: QaVerdictSchema.optional(),
  executedTests: z.array(z.string()),
  passedTests: z.array(z.string()),
  failedTests: z.array(z.string()),
  skippedTests: z.array(z.string()).optional(),
  evidences: z.array(z.string()),
  defects: z.array(QaDefectSchema),
  unmetCriteria: z.array(z.string()),
  recommendation: z.enum(['ACCEPT', 'REJECT']),
  summary: z.string(),
  testExecutions: z.array(QaTestExecutionItemSchema).optional(),
  metrics: QaMetricsSchema.optional(),
  gherkinContracts: z.array(z.string()).optional(),
  isolatedEnvPath: z.string().optional(),
});
export type QaReportPayload = z.infer<typeof QaReportPayloadSchema>;

export const PmInquiryModalitySchema = z.enum(['PARALLEL', 'SEQUENTIAL']);
export type PmInquiryModality = z.infer<typeof PmInquiryModalitySchema>;

export const PmAgentInquiryEntrySchema = z.object({
  agentRole: ActorRoleSchema,
  questionAsked: z.string(),
  responseReceived: z.string(),
  workerPid: z.number().int(),
  status: z.enum(['COMPLETE', 'INCOMPLETE']),
});
export type PmAgentInquiryEntry = z.infer<typeof PmAgentInquiryEntrySchema>;

export const PmConsolidationReportSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  modality: PmInquiryModalitySchema,
  consultedAgents: z.array(ActorRoleSchema),
  individualResponses: z.array(PmAgentInquiryEntrySchema),
  discrepancies: z.array(z.string()),
  consolidatedSummary: z.string(),
  createdAt: z.string(),
});
export type PmConsolidationReport = z.infer<typeof PmConsolidationReportSchema>;

// ============================================================================
// 5. NOTEBOOKS & RAG CITATIONS (AGENTS.MD SECTION 8)
// ============================================================================

export const NotebookSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  dirPath: z.string(),
  isGlobal: z.boolean().default(true),
  active: z.boolean().default(true),
  allowedRoles: z.array(ActorRoleSchema).default(['architect', 'developer', 'qa']),
  externalRefs: z.array(z.object({
    title: z.string(),
    url: z.string(),
    notes: z.string().optional(),
  })).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Notebook = z.infer<typeof NotebookSchema>;

export const RagCitationSchema = z.object({
  chunkId: z.string(),
  notebookId: z.string(),
  notebookName: z.string(),
  documentPath: z.string(),
  section: z.string(),
  lineRange: z.string(),
  externalRef: z.string().optional(),
  snippet: z.string(),
  score: z.number(),
});
export type RagCitation = z.infer<typeof RagCitationSchema>;

// ============================================================================
// 6. MULTI-MODEL ROUTING & MEMORY (AGENTS.MD 10-12)
// ============================================================================

export const LlmProviderTypeSchema = z.enum([
  'deterministic',
  'openai',
  'anthropic',
  'gemini',
  'ollama',
  'opencode',
  'openrouter',
  'groq',
  'freellm',
]);
export type LlmProviderType = z.infer<typeof LlmProviderTypeSchema>;

export const RoleModelConfigSchema = z.object({
  role: ActorRoleSchema,
  provider: LlmProviderTypeSchema,
  modelId: z.string(),
  temperature: z.number().min(0).max(2).default(0.2),
  executionModality: ExecutionModalitySchema.default('LOCAL_PROCESS'),
});
export type RoleModelConfig = z.infer<typeof RoleModelConfigSchema>;

export const MemoryLayerSchema = z.enum([
  'CONVERSATIONAL',
  'WORKING',
  'PROJECT_PERSISTENT',
  'AGENT_SPECIFIC',
]);
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;

export const MemoryEntrySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  layer: MemoryLayerSchema,
  agentRole: ActorRoleSchema.optional(),
  key: z.string(),
  value: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  workspaceDir: z.string(),
  repositories: z.array(z.string()).default([]),
  phase: WorkflowPhaseSchema,
  approvedArchitectureVersion: z.number().int().nonnegative().default(0),
  correctionCycleCount: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

// ============================================================================
// 7. JSON-RPC 2.0 IPC PROTOCOL OVER STDIO (LINUX PROCESS COMMUNICATION)
// ============================================================================

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
});
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

// ============================================================================
// 8. PERSISTENT CONCURRENT RUNTIME & INTER-AGENT COMMUNICATION (ISSUE #10)
// ============================================================================

export const InterAgentMessageTypeSchema = z.enum([
  'STATUS_UPDATE',
  'BLOCKER',
  'TASK_REQUEST',
  'TASK_HANDOFF',
  'CONSULTATION',
  'QA_VERDICT',
  'INQUIRY',
]);
export type InterAgentMessageType = z.infer<typeof InterAgentMessageTypeSchema>;

export const InterAgentMessageSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  requestId: z.string().optional(),
  fromRole: ActorRoleSchema,
  toRole: z.union([ActorRoleSchema, z.literal('broadcast')]),
  type: InterAgentMessageTypeSchema,
  payload: z.union([z.record(z.unknown()), z.string()]),
  status: z.enum(['DELIVERED', 'PROCESSED', 'ACKNOWLEDGED']).default('DELIVERED'),
  createdAt: z.string(),
});
export type InterAgentMessage = z.infer<typeof InterAgentMessageSchema>;

export const CoordinatorAuditLogEntrySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  agentRole: ActorRoleSchema,
  operationType: z.enum(['READ', 'WRITE']),
  action: z.string(),
  requestId: z.string().optional(),
  status: z.enum(['ACCEPTED', 'REJECTED', 'DUPLICATE']),
  details: z.record(z.unknown()).default({}),
  createdAt: z.string(),
});
export type CoordinatorAuditLogEntry = z.infer<typeof CoordinatorAuditLogEntrySchema>;

export const WorkerLifecycleStatusSchema = z.enum([
  'idle',
  'busy',
  'stopped',
  'failed',
]);
export type WorkerLifecycleStatus = z.infer<typeof WorkerLifecycleStatusSchema>;

export const WorkerStatusInfoSchema = z.object({
  projectId: z.string(),
  role: ActorRoleSchema,
  status: WorkerLifecycleStatusSchema,
  workerPid: z.number().int().optional(),
  startedAt: z.string().optional(),
  lastActiveAt: z.string().optional(),
  turnsCompleted: z.number().int().nonnegative().default(0),
  tasksCompleted: z.number().int().nonnegative().default(0),
  modality: ExecutionModalitySchema.default('LOCAL_PROCESS'),
  error: z.string().optional(),
});
export type WorkerStatusInfo = z.infer<typeof WorkerStatusInfoSchema>;

export class StaleArtifactVersionError extends Error {
  constructor(
    public readonly artifactCode: string,
    public readonly expectedVersion: number,
    public readonly currentVersion: number,
  ) {
    super(
      `Optimistic Concurrency Conflict: Artifact '${artifactCode}' has version ${currentVersion}, but expected version was ${expectedVersion}.`,
    );
    this.name = 'StaleArtifactVersionError';
  }
}

export class CoordinatorAuthorityError extends Error {
  constructor(
    public readonly role: ActorRole,
    public readonly operation: string,
    reason: string,
  ) {
    super(`Coordinator Authority Violation for '${role}' on '${operation}': ${reason}`);
    this.name = 'CoordinatorAuthorityError';
  }
}


