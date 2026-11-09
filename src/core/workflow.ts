import {
  ActorRole,
  ArtifactType,
  WorkflowPhase,
} from './contracts.js';

/**
 * Valid transitions across the 8 Phases of PO CLI (AGENTS.md Section 6).
 */
const ALLOWED_PHASE_TRANSITIONS: Record<WorkflowPhase, WorkflowPhase[]> = {
  PHASE_1_PROJECT_CREATION: ['PHASE_2_ARCHITECT_ANALYSIS'],
  PHASE_2_ARCHITECT_ANALYSIS: ['PHASE_3_ARCHITECTURE_APPROVAL'],
  PHASE_3_ARCHITECTURE_APPROVAL: [
    'PHASE_2_ARCHITECT_ANALYSIS', // PO requests changes to architecture proposal
    'PHASE_4_DEVELOPER_HANDOFF',   // PO approves architecture
  ],
  PHASE_4_DEVELOPER_HANDOFF: ['PHASE_5_IMPLEMENTATION', 'PHASE_6_QA_VALIDATION'],
  PHASE_5_IMPLEMENTATION: [
    'PHASE_3_ARCHITECTURE_APPROVAL', // If architectural amendment requires PO re-approval
    'PHASE_6_QA_VALIDATION',         // Developer finishes implementation and submits to QA
  ],
  PHASE_6_QA_VALIDATION: [
    'PHASE_7_CORRECTION_CYCLE', // QA rejects delivery due to failed tests/defects
    'PHASE_8_FINAL_ACCEPTANCE', // QA confirms acceptance criteria met
  ],
  PHASE_7_CORRECTION_CYCLE: [
    'PHASE_3_ARCHITECTURE_APPROVAL', // Fix impacts architecture and needs PO approval
    'PHASE_6_QA_VALIDATION',         // Developer fixes defects and resubmits to QA
    'PHASE_8_FINAL_ACCEPTANCE',      // Escalated to Architect/PO after max correction cycles
  ],
  PHASE_8_FINAL_ACCEPTANCE: [
    'PHASE_6_QA_VALIDATION',    // Re-trigger QA validation if requested
    'PHASE_7_CORRECTION_CYCLE', // PO rejects final result and requests adjustments
    'COMPLETED',                // PO accepts project delivery
  ],
  COMPLETED: ['PHASE_2_ARCHITECT_ANALYSIS'], // New iteration on existing project
};

/**
 * Artifact authoring permissions by role (AGENTS.md Sections 4, 5, 7).
 */
const ROLE_ARTIFACT_WRITE_PERMISSIONS: Record<string, ArtifactType[]> = {
  product_owner: [
    'REQUIREMENT',
    'NON_FUNCTIONAL_REQUIREMENT',
    'USER_STORY',
    'EXPERIMENT',
    'OBSERVATION',
    'LLM_OUTPUT',
    'DOCUMENTATION',
  ],
  architect: [
    'REQUIREMENT',
    'NON_FUNCTIONAL_REQUIREMENT',
    'USER_STORY',
    'ARCHITECTURE',
    'ADR',
    'SPECIFICATION',
    'EXPERIMENT',
    'OBSERVATION',
    'LLM_OUTPUT',
    'DOCUMENTATION',
  ],
  developer: [
    'IMPLEMENTATION',
    'IMPLEMENTATION_PLAN',
    'SOURCE_CODE',
    'TEST_CASE',
    'EXPERIMENT',
    'OBSERVATION',
    'LLM_OUTPUT',
    'DOCUMENTATION',
  ],
  qa: [
    'TEST_CASE',
    'QA_REPORT',
    'DEFECT',
    'OBSERVATION',
    'LLM_OUTPUT',
    'DOCUMENTATION',
  ],
  pm: [
    'PM_REPORT',
    'LLM_OUTPUT',
    'DOCUMENTATION',
  ],
};

/**
 * Allowed communication channels (AGENTS.md Section 5).
 */
export class AuthorityGuard {
  private static customRolePermissions = new Map<string, ArtifactType[]>();

  static registerCustomRolePermissions(role: string, allowedTypes: ArtifactType[]): void {
    this.customRolePermissions.set(role, allowedTypes);
  }

  static canTransition(from: WorkflowPhase, to: WorkflowPhase): boolean {
    if (from === to) return true;
    return ALLOWED_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
  }

  static assertTransition(from: WorkflowPhase, to: WorkflowPhase): void {
    if (!this.canTransition(from, to)) {
      throw new Error(
        `Invalid workflow phase transition: cannot move directly from ${from} to ${to}.`,
      );
    }
  }

  static canWriteArtifact(role: ActorRole, artifactType: ArtifactType): boolean {
    const builtIn = ROLE_ARTIFACT_WRITE_PERMISSIONS[role];
    if (builtIn) {
      return builtIn.includes(artifactType);
    }
    const custom = this.customRolePermissions.get(role);
    if (custom) {
      return custom.includes(artifactType);
    }
    return false;
  }

  static assertCanWriteArtifact(role: ActorRole, artifactType: ArtifactType): void {
    if (!this.canWriteArtifact(role, artifactType)) {
      if (role === 'developer' && (artifactType === 'ARCHITECTURE' || artifactType === 'ADR' || artifactType === 'SPECIFICATION')) {
        throw new Error(
          `Authority Violation: Developer cannot unilaterally modify ${artifactType}. Must use consult_architect tool to request architectural review.`,
        );
      }
      throw new Error(
        `Authority Violation: Role '${role}' is not authorized to create or modify artifact type '${artifactType}'.`,
      );
    }
  }

  static assertCanApproveArchitecture(role: ActorRole): void {
    if (role !== 'product_owner') {
      throw new Error(
        `Authority Violation: Only the human Product Owner ('product_owner') can approve the architecture (attempted by '${role}').`,
      );
    }
  }

  static assertCanEmitQaVerdict(role: ActorRole): void {
    if (role !== 'qa') {
      throw new Error(
        `Authority Violation: Only the independent QA Engineer ('qa') can emit a QA validation verdict (attempted by '${role}').`,
      );
    }
  }

  static assertCanAcceptProject(role: ActorRole): void {
    if (role !== 'product_owner') {
      throw new Error(
        `Authority Violation: Only the human Product Owner ('product_owner') holds final authority to accept the project (attempted by '${role}').`,
      );
    }
  }

  static canCommunicate(from: ActorRole, to: ActorRole, phase: WorkflowPhase): boolean {
    // Product Owner can always communicate directly with any professional
    if (from === 'product_owner' || to === 'product_owner') {
      return true;
    }
    // Project Manager (PM) can query any active agent at any time (parallel or sequential)
    if (from === 'pm' || to === 'pm') {
      return true;
    }
    // Architect <-> Developer is always allowed
    if (
      (from === 'architect' && to === 'developer') ||
      (from === 'developer' && to === 'architect')
    ) {
      return true;
    }
    // Architect <-> QA is always allowed
    if (
      (from === 'architect' && to === 'qa') ||
      (from === 'qa' && to === 'architect')
    ) {
      return true;
    }
    // Developer <-> QA is allowed across workflow phases for autonomous handoff and bidirectional defect resolution
    if (
      (from === 'developer' && to === 'qa') ||
      (from === 'qa' && to === 'developer')
    ) {
      return true;
    }
    // Custom specialists can communicate with Architect
    if (from === 'architect' || to === 'architect') {
      return true;
    }
    return false;
  }
}

