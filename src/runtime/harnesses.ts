import { ActorRole, ArtifactType } from '../core/contracts.js';
import { AuthorityGuard } from '../core/workflow.js';

export interface AgentHarness {
  role: ActorRole;
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  allowedArtifactTypes: ArtifactType[];
}

const BUILTIN_HARNESSES: Record<string, AgentHarness> = {
  architect: {
    role: 'architect',
    displayName: 'Software Architect',
    systemPrompt: [
      'You are the Lead Software Architect of the PO CLI virtual engineering team.',
      'Your primary interlocutor is the human Product Owner, who holds final authority over the project.',
      'Responsibilities:',
      '1. Analyze functional and non-functional requirements and ask clarifying questions when information is missing.',
      '2. Query authorized knowledge Notebooks and always cite the source [Notebook | Doc | Section].',
      '3. Propose architectures explaining advantages, drawbacks, and technical trade-offs.',
      '4. Produce versioned artifacts (REQUIREMENT, ADR, ARCHITECTURE, SPECIFICATION) and request explicit Product Owner approval.',
      '5. Evaluate technical consultations from the Developer without allowing unilateral deviations.',
    ].join('\n'),
    allowedTools: [
      'query_notebooks',
      'propose_requirement',
      'record_adr',
      'write_architecture_doc',
      'write_specification',
      'evaluate_consultation',
      'request_po_approval',
    ],
    allowedArtifactTypes: [
      'REQUIREMENT',
      'NON_FUNCTIONAL_REQUIREMENT',
      'USER_STORY',
      'ARCHITECTURE',
      'ADR',
      'SPECIFICATION',
      'DOCUMENTATION',
    ],
  },
  developer: {
    role: 'developer',
    displayName: 'Senior Developer',
    systemPrompt: [
      'You are the Senior Developer of the PO CLI virtual engineering team.',
      'You work strictly on the Approved Architecture, Requirements, and Specifications delivered in the Handoff bundle.',
      'FUNDAMENTAL RULE: You cannot unilaterally modify approved architectural decisions.',
      'If you encounter an ambiguity, contradiction, or need to deviate from the architecture, you MUST use the consult_architect tool.',
      'When you finish an implementation or a correction cycle, prepare and submit the deliverable to QA via submit_for_qa.',
    ].join('\n'),
    allowedTools: [
      'query_notebooks',
      'write_implementation_plan',
      'write_source_file',
      'run_command',
      'consult_architect',
      'submit_for_qa',
    ],
    allowedArtifactTypes: [
      'IMPLEMENTATION_PLAN',
      'SOURCE_CODE',
      'TEST_CASE',
      'DOCUMENTATION',
    ],
  },
  qa: {
    role: 'qa',
    displayName: 'Independent QA Engineer',
    systemPrompt: [
      'You are the Independent QA Engineer of the PO CLI virtual engineering team.',
      'Your mission is to independently verify whether the Developer implementation fulfills Requirements, Approved Architecture, and Acceptance Criteria.',
      'Never accept claims without proof: execute real verification checks, collect evidence, classify defects by severity (LOW, MEDIUM, HIGH, CRITICAL), and emit a grounded verdict (ACCEPT or REJECT).',
    ].join('\n'),
    allowedTools: [
      'query_notebooks',
      'write_test_case',
      'run_verification_test',
      'submit_qa_report',
    ],
    allowedArtifactTypes: ['TEST_CASE', 'QA_REPORT', 'DEFECT', 'DOCUMENTATION'],
  },
};

export class HarnessRegistry {
  private static customHarnesses = new Map<string, AgentHarness>();

  static getHarness(role: ActorRole): AgentHarness {
    const builtin = BUILTIN_HARNESSES[role];
    if (builtin) return builtin;
    const custom = this.customHarnesses.get(role);
    if (custom) return custom;
    throw new Error(`No AgentHarness registered for role '${role}'.`);
  }

  static listHarnesses(): AgentHarness[] {
    return [
      ...Object.values(BUILTIN_HARNESSES),
      ...Array.from(this.customHarnesses.values()),
    ];
  }

  static registerCustomHarness(harness: AgentHarness): void {
    this.customHarnesses.set(harness.role, harness);
    AuthorityGuard.registerCustomRolePermissions(
      harness.role,
      harness.allowedArtifactTypes,
    );
  }
}
