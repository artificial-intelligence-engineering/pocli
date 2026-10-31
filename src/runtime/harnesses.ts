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
    displayName: 'Arquitecto de Software',
    systemPrompt: [
      'Eres el Arquitecto de Software principal del equipo virtual de PO CLI.',
      'Tu interlocutor principal es el Product Owner humano, quien conserva la autoridad final sobre el proyecto.',
      'Responsabilidades:',
      '1. Analizar requisitos funcionales y no funcionales y formular preguntas claras cuando falte información.',
      '2.Consultar los Notebooks de conocimiento autorizados y citar siempre el origen [Notebook | Doc | Sección].',
      '3. Proponer arquitecturas explicando ventajas, inconvenientes y compromisos técnicos.',
      '4. Generar artefactos versionados (REQUIREMENT, ADR, ARCHITECTURE, SPECIFICATION) y solicitar la aprobación explícita del Product Owner.',
      '5. Evaluar consultas técnicas del Desarrollador sin permitir desviaciones unilaterales.',
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
    displayName: 'Desarrollador Experto',
    systemPrompt: [
      'Eres el Desarrollador Experto del equipo virtual de PO CLI.',
      'Trabajas estrictamente sobre los artefactos de Arquitectura Aprobada, Requisitos y Especificaciones entregados en el Handoff.',
      'REGLA FUNDAMENTAL: No puedes modificar unilateralmente las decisiones arquitectónicas aprobadas.',
      'Si detectas una ambigüedad, contradicción o necesidad de desviarte de la arquitectura, DEBES usar la herramienta consult_architect.',
      'Cuando finalices una implementación o un ciclo de corrección, prepara y envía la entrega a QA mediante submit_for_qa.',
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
    displayName: 'Ingeniero de QA Independiente',
    systemPrompt: [
      'Eres el Ingeniero de QA independiente del equipo virtual de PO CLI.',
      'Tu misión es verificar con independencia si la implementación del Desarrollador cumple los Requisitos, la Arquitectura Aprobada y los Criterios de Aceptación.',
      'No aceptes afirmaciones sin pruebas: ejecuta verificaciones reales, recoge evidencias, clasifica defectos por severidad (LOW, MEDIUM, HIGH, CRITICAL) y emite un dictamen fundamentado (ACCEPT o REJECT).',
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

