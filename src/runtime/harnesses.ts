import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ActorRole, ArtifactType } from '../core/contracts.js';
import { AuthorityGuard } from '../core/workflow.js';

export interface AgentHarness {
  role: ActorRole;
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  allowedArtifactTypes: ArtifactType[];
}

export interface PromptResolutionInfo {
  role: ActorRole;
  displayName: string;
  sourceType: 'user_override' | 'bundle' | 'repo_default' | 'cwd' | 'fallback';
  statusLabel: { es: string; en: string };
  resolvedPath?: string;
  isOverride: boolean;
  isFallback: boolean;
  content: string;
}

const promptCache = new Map<string, string>();

export function getProjectRoot(): string {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const candidate = path.resolve(path.dirname(currentFile), '..', '..');
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  } catch {
    // ignore
  }
  return process.cwd();
}

export function inspectRolePromptResolution(role: ActorRole): PromptResolutionInfo {
  const displayNames: Record<string, string> = {
    architect: 'Software Architect',
    developer: 'Senior Developer',
    qa: 'Independent QA Engineer',
    pm: 'Project Manager (PM)',
  };
  const displayName = displayNames[role] ?? role;
  const fallback = FALLBACK_PROMPTS[role] ?? '';

  // 1. User global override: $HOME/.pocli/behavior/system/<role>.md
  const userOverride = path.join(os.homedir(), '.pocli', 'behavior', 'system', `${role}.md`);
  if (fs.existsSync(userOverride)) {
    try {
      const content = fs.readFileSync(userOverride, 'utf8').trim();
      if (content) {
        return {
          role,
          displayName,
          sourceType: 'user_override',
          statusLabel: { es: 'Override de Usuario', en: 'User Override' },
          resolvedPath: userOverride,
          isOverride: true,
          isFallback: false,
          content,
        };
      }
    } catch {
      // ignore
    }
  }

  // 2. Co-located bundle path (dist/behavior/system/<role>.md in standalone distributions)
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const coLocatedPath = path.resolve(path.dirname(currentFile), '..', 'behavior', 'system', `${role}.md`);
    if (fs.existsSync(coLocatedPath)) {
      const content = fs.readFileSync(coLocatedPath, 'utf8').trim();
      if (content) {
        return {
          role,
          displayName,
          sourceType: 'bundle',
          statusLabel: { es: 'Paquete Compilado', en: 'Bundled Package' },
          resolvedPath: coLocatedPath,
          isOverride: false,
          isFallback: false,
          content,
        };
      }
    }
  } catch {
    // ignore
  }

  // 3. Repository/package default: behavior/system/<role>.md
  const projectRoot = getProjectRoot();
  const repoFile = path.join(projectRoot, 'behavior', 'system', `${role}.md`);
  if (fs.existsSync(repoFile)) {
    try {
      const content = fs.readFileSync(repoFile, 'utf8').trim();
      if (content) {
        return {
          role,
          displayName,
          sourceType: 'repo_default',
          statusLabel: { es: 'Predeterminado (Repo)', en: 'Repository Default' },
          resolvedPath: repoFile,
          isOverride: false,
          isFallback: false,
          content,
        };
      }
    } catch {
      // ignore
    }
  }

  // 4. Fallback to process.cwd() / behavior/system/<role>.md
  const cwdFile = path.join(process.cwd(), 'behavior', 'system', `${role}.md`);
  if (fs.existsSync(cwdFile)) {
    try {
      const content = fs.readFileSync(cwdFile, 'utf8').trim();
      if (content) {
        return {
          role,
          displayName,
          sourceType: 'cwd',
          statusLabel: { es: 'Directorio de Trabajo', en: 'Working Directory' },
          resolvedPath: cwdFile,
          isOverride: false,
          isFallback: false,
          content,
        };
      }
    } catch {
      // ignore
    }
  }

  // 5. Fallback to built-in in-memory string (resilience in bundled single binaries)
  return {
    role,
    displayName,
    sourceType: 'fallback',
    statusLabel: { es: 'In-Memory Fallback', en: 'In-Memory Fallback' },
    resolvedPath: undefined,
    isOverride: false,
    isFallback: true,
    content: fallback,
  };
}

export function loadRoleSystemPrompt(role: string, fallbackPrompt: string): string {
  if (promptCache.has(role)) {
    return promptCache.get(role)!;
  }

  const info = inspectRolePromptResolution(role as ActorRole);
  const resolved = info.content || fallbackPrompt;
  promptCache.set(role, resolved);
  return resolved;
}

export function clearPromptCache(): void {
  promptCache.clear();
}

const FALLBACK_PROMPTS: Record<string, string> = {
  architect: [
    'You are the Lead Software Architect of the PO CLI virtual engineering team.',
    'Your primary interlocutor is the human Product Owner, who holds final authority over the project.',
    'Responsibilities:',
    '1. Analyze functional and non-functional requirements and ask clarifying questions when information is missing.',
    '2. Query authorized knowledge Notebooks and always cite the source [Notebook | Doc | Section].',
    '3. Propose architectures explaining advantages, drawbacks, and technical trade-offs.',
    '4. Discuss and recommend the programming language(s) and technology stack suited to the software the Product Owner wants to build.',
    '5. Discuss and advise whether the codebase should be organized as a single repository (monorepo) or multiple repositories (multi-repo).',
    '6. Inquire where the repository or repositories should reside in the filesystem workspace, or if they already exist on disk and their exact paths, noting that all repositories reside under the `repos/` directory and their folder names MUST strictly end with the `.git` extension (e.g. `repos/<project-name>.git` for single repository or `repos/<repo-name>.git` for multi-repo), and that repository creation and initialization will be performed by the Senior Developer.',
    '7. Include the agreed programming language(s), repository architecture (single/multi-repo under `repos/<repo-name>.git`), and filesystem paths in the Technical Specification (SPEC-*) for Developer handoff. The specification must designate `repos/<repo-name>.git/` as the destination for all source code and project configuration files.',
    '8. Produce and maintain only two versioned contract artifacts: the Reference Architecture (contracts/architecture/ARCH-00x_vy.md via write_architecture_doc) reflecting agreements with the Product Owner, and the Developer Specification (contracts/specification/SPEC-00x_vy.md via write_specification) as the contract for the Developer. Requirements and ADR documents are eliminated; all context is consolidated into ARCH-* and SPEC-*.',
    '9. Proactive Autonomous Handoff Protocol: Once technical specifications and architecture are presented, ask the Product Owner if they are satisfied with the design and whether you should communicate and hand off the project to the Senior Developer to initiate implementation. When the Product Owner gives verbal approval or authorizes proceeding to implementation (e.g. "ok", "aprobado", "adelante", "comunícalo al desarrollador", "que empiece a implementar", "procede"): do NOT require manual slash commands like /approve, /handoff, or /implement. You MUST give the formal order to the Senior Developer yourself by emitting the `handoff_to_developer` tool call with clear instructions referencing SPEC-001.',
    '10. Evaluate technical consultations from the Developer without allowing unilateral deviations.',
  ].join('\n'),
  developer: [
    'You are the Senior Developer of the PO CLI virtual engineering team.',
    'You work strictly on the Approved Architecture, Requirements, and Specifications delivered in the Handoff bundle.',
    'Responsibilities:',
    '1. Work strictly on the Approved Architecture, Requirements, and Specifications delivered in the Handoff bundle.',
    '2. Initialize and manage code repositories under `repos/<repo-name>.git` within the workspace. Every repository folder name MUST strictly end with the `.git` extension (e.g. `repos/<project-name>.git` for default single repository or `repos/<repo-name>.git` for multi-repo topologies specified by the Architect).',
    '3. Write, create, and maintain source code and configuration files inside their corresponding repository directory (`repos/<repo-name>.git/...`) using `write_source_file`. Never place code files bare at the root of the workspace.',
    '4. MANDATORY UNIT TESTING AND COVERAGE:',
    '   - Creating and executing unit tests is strictly YOUR responsibility as Senior Developer. Whenever you write or modify production code, you MUST always create corresponding unit test files under `tests/` in the repository.',
    '   - You MUST ALWAYS execute the unit tests using `run_unit_tests` and verify that all unit tests pass before considering any task completed.',
    '   - You MUST measure and verify code coverage. You only consider an implementation task finished when all unit tests pass (100% green).',
    '5. ARCHITECT REPORTING PROTOCOL:',
    '   - When the Lead Software Architect hands off an architectural specification (SPEC-*) to you, upon completing the implementation you MUST report directly back to the Architect.',
    '   - In your response and in your technical logbook (`IMP-001`), you MUST explicitly report: (a) the feature implemented according to SPEC-001 and ARCH-001, (b) the unit tests created and executed, confirming they all passed, and (c) the test coverage achieved on the implemented code.',
    '6. FUNDAMENTAL RULE: You cannot unilaterally modify approved architectural decisions.',
    'If you encounter an ambiguity, contradiction, or need to deviate from the architecture, you MUST use the consult_architect tool.',
    '7. Maintain a technical implementation logbook in contracts/implementation/ (e.g. IMP-00x_vy.md via write_implementation_log) detailing the implementation, source files, unit tests executed, test results, and coverage metrics.',
    '8. When the implementation and unit test verification are completed and green, prepare and notify QA via submit_for_qa for independent validation.',
  ].join('\n'),
  qa: [
    'You are the Independent QA Engineer of the PO CLI virtual engineering team.',
    'Your mission is to independently verify whether the Developer implementation fulfills Requirements, Approved Architecture, and Acceptance Criteria.',
    'Never accept claims without proof: execute real verification checks, collect evidence, classify defects by severity (LOW, MEDIUM, HIGH, CRITICAL), and emit a grounded verdict (ACCEPT or REJECT).',
  ].join('\n'),
  pm: [
    'You are the Project Manager (PM) of the PO CLI virtual engineering team.',
    'The Software Architect, Senior Developer, and Independent QA Engineer remain permanently active in the runtime.',
    'Responsibilities:',
    '1. Query active agents in PARALLEL (simultaneously) or SEQUENTIALLY (chained context) as requested by the Product Owner or as best fits the inquiry.',
    '2. Record all questions asked and responses received, identify incomplete replies, distinguish each agent contribution, and detect discrepancies or contradictions.',
    '3. Deliver both individual agent responses and a consolidated summary to the Product Owner without attributing unexpressed agreements.',
    '4. STRICT AUTHORITY BOUNDARY: You have NO authority to direct, modify, or interrupt the work of the engineering agents.',
  ].join('\n'),
};

export function buildRoleToolsInstruction(role: ActorRole): string {
  switch (role) {
    case 'architect':
      return [
        '## [AVAILABLE TOOLS AND PROTOCOL]',
        'You have authority to produce authoritative architecture artifacts and request PO approval.',
        'You MUST maintain only two primary contract artifacts on the project filesystem under contracts/:',
        '',
        '- `write_architecture_doc(code: string, title: string, content: string, tracesTo?: string[])`: Creates or updates the Reference Architecture in `contracts/architecture/ARCH-00x_vy.md` (e.g. `ARCH-001`). This is the foundation of the conversation and technical agreements with the Product Owner.',
        '- `write_specification(code: string, title: string, content: string, tracesTo?: string[])`: Creates or updates the Developer Specification in `contracts/specification/SPEC-00x_vy.md` (e.g. `SPEC-001`). This is the formal technical contract handed over to the Senior Developer, detailing programming languages, directory structure under `repos/<repo-name>.git`, data models, and API interfaces. Repositories must always reside in `repos/` and their names must end with `.git`.',
        '- `request_po_approval(artifactCode: string)`: Formally requests the Product Owner to review and approve the proposal before Developer handoff.',
        '- `handoff_to_developer(instructions: string, approvalComments?: string)`: Formally delivers the approved normative bundle to the Senior Developer and orders the initiation of software implementation. Call this tool when the Product Owner gives verbal approval or authorizes proceeding to implementation in dialogue (eliminating any need for manual slash commands).',
        '',
        'Note: Requirement documents (REQ) and Architecture Decision Records (ADR) are eliminated; all functional, technical, and architectural agreements are consolidated into ARCH-* and SPEC-*.',
        '',
        'Format each tool call strictly as:',
        '```tool_call',
        '{',
        '  "name": "write_specification",',
        '  "arguments": {',
        '    "code": "SPEC-001",',
        '    "title": "Developer Technical Specification",',
        '    "content": "# SPEC-001: Technical Specification\\n\\n..."',
        '  }',
        '}',
        '```',
        'Always accompany tool calls with conversational, professional explanations to the Product Owner.',
      ].join('\n');

    case 'developer':
      return [
        '## [AVAILABLE TOOLS AND PROTOCOL]',
        'You are the Senior Developer. You build the software based on approved normative contracts (ARCH-001 and SPEC-001) in [NORMATIVE ARTIFACTS].',
        'When you implement files, execute unit tests, record your logbook, or consult the architect, emit ```tool_call blocks:',
        '',
        '- `write_source_file(relFilePath: string, content: string)`: Writes or updates a source code or config file inside the repository directory (e.g. `repos/<project-name>.git/src/index.ts`). Every repository folder must reside under `repos/` and end with `.git`. Also use this to create unit test files under `repos/<repo-name>.git/tests/`.',
        '- `run_unit_tests(testCommand?: string, repoPath?: string)`: Executes the unit test suite inside the target repository directory (e.g. `pytest`, `npm test`, `cargo test`, `go test`), capturing exit status, stdout, and coverage metrics. You MUST execute this and ensure 100% green tests before finishing any implementation task.',
        '- `write_implementation_log(code: string, title: string, content: string, tracesTo?: string[])`: Creates or updates your technical implementation logbook in `contracts/implementation/IMP-00x_vy.md` (e.g. `IMP-001`). It must provide a technical explanation of the implementation work performed, citing the input SPEC-* contract, source files created, unit tests executed, test results, and code coverage achieved.',
        '- `consult_architect(subject: string, ambiguityOrBlocker: string, proposedAlternative: string, impactedArtifacts: string[])`: Submits a formal consultation if you detect architectural ambiguities or blockers.',
        '- `submit_for_qa(deliverableNotes: string)`: Notifies QA that the deliverable is ready for independent verification.',
        '',
        'CRITICAL RULES FOR DEVELOPER:',
        '1. Mandatory Unit Testing: You MUST create unit tests for all implemented logic and run them using `run_unit_tests`.',
        '2. Definition of Done: Your task is ONLY finished when all unit tests pass (100% green) and coverage is verified.',
        '3. Architect Reporting Protocol: When instructed by the Lead Architect via handoff, you MUST report directly back to the Architect, informing them of (a) the feature implemented per SPEC-001/ARCH-001, (b) the unit tests executed and their pass status, and (c) the unit test coverage percentage achieved.',
        '',
        'Format each tool call strictly as:',
        '```tool_call',
        '{',
        '  "name": "run_unit_tests",',
        '  "arguments": {',
        '    "testCommand": "npm test"',
        '  }',
        '}',
        '```',
        'Always accompany tool calls with conversational, professional explanations to the recipient.',
      ].join('\n');

    case 'qa':
      return [
        '## [AVAILABLE TOOLS AND PROTOCOL]',
        'You are the Independent QA Engineer. You verify that the implementation satisfies the normative contracts.',
        'When you create test cases or verification reports, emit ```tool_call blocks:',
        '- `write_test_case(code: string, title: string, content: string, tracesTo?: string[])`: Records a QA test case in `contracts/`.',
        '- `run_verification_test(testCommand: string)`: Runs an automated test command.',
        '- `submit_qa_report(code: string, title: string, content: string, passed: boolean)`: Submits the verification report.',
      ].join('\n');

    default:
      return '';
  }
}

const BUILTIN_HARNESSES: Record<string, AgentHarness> = {
  architect: {
    role: 'architect',
    displayName: 'Software Architect',
    get systemPrompt(): string {
      return loadRoleSystemPrompt('architect', FALLBACK_PROMPTS.architect);
    },
    allowedTools: [
      'query_notebooks',
      'write_architecture_doc',
      'write_specification',
      'evaluate_consultation',
      'request_po_approval',
      'handoff_to_developer',
    ],
    allowedArtifactTypes: [
      'ARCHITECTURE',
      'SPECIFICATION',
      'EXPERIMENT',
      'OBSERVATION',
      'DOCUMENTATION',
    ],
  },
  developer: {
    role: 'developer',
    displayName: 'Senior Developer',
    get systemPrompt(): string {
      return loadRoleSystemPrompt('developer', FALLBACK_PROMPTS.developer);
    },
    allowedTools: [
      'query_notebooks',
      'write_implementation_log',
      'record_implementation_log',
      'write_implementation_plan',
      'write_source_file',
      'run_unit_tests',
      'run_tests',
      'run_command',
      'consult_architect',
      'submit_for_qa',
    ],
    allowedArtifactTypes: [
      'IMPLEMENTATION',
      'IMPLEMENTATION_PLAN',
      'SOURCE_CODE',
      'TEST_CASE',
      'EXPERIMENT',
      'OBSERVATION',
      'DOCUMENTATION',
    ],
  },
  qa: {
    role: 'qa',
    displayName: 'Independent QA Engineer',
    get systemPrompt(): string {
      return loadRoleSystemPrompt('qa', FALLBACK_PROMPTS.qa);
    },
    allowedTools: [
      'query_notebooks',
      'write_test_case',
      'run_verification_test',
      'submit_qa_report',
    ],
    allowedArtifactTypes: ['TEST_CASE', 'QA_REPORT', 'DEFECT', 'OBSERVATION', 'DOCUMENTATION'],
  },
  pm: {
    role: 'pm',
    displayName: 'Project Manager (PM)',
    get systemPrompt(): string {
      return loadRoleSystemPrompt('pm', FALLBACK_PROMPTS.pm);
    },
    allowedTools: [
      'query_notebooks',
      'query_agents_parallel',
      'query_agents_sequential',
      'write_pm_report',
    ],
    allowedArtifactTypes: ['PM_REPORT', 'DOCUMENTATION'],
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

  static reloadPrompts(): void {
    clearPromptCache();
  }

  static inspectResolutions(): PromptResolutionInfo[] {
    const roles: ActorRole[] = ['architect', 'developer', 'qa', 'pm'];
    return roles.map((r) => inspectRolePromptResolution(r));
  }

  static inspectResolution(role: ActorRole): PromptResolutionInfo {
    return inspectRolePromptResolution(role);
  }
}
