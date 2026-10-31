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
  'IMPLEMENTATION_PLAN',
  'SOURCE_CODE',
  'TEST_CASE',
  'QA_REPORT',
  'DEFECT',
  'PM_REPORT',
  'DOCUMENTATION',
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

export const QaDefectSchema = z.object({
  id: z.string(),
  code: z.string(), // e.g., DEF-001
  title: z.string(),
  severity: DefectSeveritySchema,
  violatedCriteria: z.string(),
  evidence: z.string(),
  status: z.enum(['OPEN', 'FIXED', 'VERIFIED']),
});
export type QaDefect = z.infer<typeof QaDefectSchema>;

export const QaReportPayloadSchema = z.object({
  executedTests: z.array(z.string()),
  passedTests: z.array(z.string()),
  failedTests: z.array(z.string()),
  evidences: z.array(z.string()),
  defects: z.array(QaDefectSchema),
  unmetCriteria: z.array(z.string()),
  recommendation: z.enum(['ACCEPT', 'REJECT']),
  summary: z.string(),
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
// 6. MULTI-MODEL ROUTING, EXECUTION MODALITIES & MEMORY (AGENTS.MD 10-12)
// ============================================================================

export const ExecutionModalitySchema = z.enum([
  'LOCAL_PROCESS',
  'LINUX_BWRAP',
  'OCI_CONTAINER',
]);
export type ExecutionModality = z.infer<typeof ExecutionModalitySchema>;

export const LlmProviderTypeSchema = z.enum([
  'deterministic',
  'openai',
  'anthropic',
  'gemini',
  'ollama',
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

