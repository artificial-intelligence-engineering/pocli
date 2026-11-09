import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ActorRole,
  Artifact,
  Project,
  WorkflowPhase,
} from '../core/contracts.js';
import { PoCliDatabase } from '../storage/database.js';
import {
  AutonomousHandoffTrigger,
  PoCliOrchestrator,
} from './orchestrator.js';
import { resolveModelSpec } from './llm-gateway.js';
import { CommandCenterApp } from '../tui/CommandCenterApp.js';

export interface HeadlessTurnRecord {
  role: ActorRole;
  senderRole: ActorRole | 'product_owner';
  reply: string;
  createdArtifacts: Array<{
    code: string;
    type: string;
    version: number;
    filePath: string;
  }>;
  autonomousHandoff?: AutonomousHandoffTrigger;
}

export interface HeadlessExecOptions {
  commandOrPrompt: string;
  projectName?: string;
  workspaceDir?: string;
  role?: ActorRole;
  modelSpec?: string;
  followHandoffs?: boolean;
}

export interface HeadlessExecResult {
  ok: boolean;
  action: string;
  project: Project | null;
  turns: HeadlessTurnRecord[];
  outputText: string;
}

export interface HeadlessE2eOptions {
  projectName?: string;
  projectDescription?: string;
  workspaceDir?: string;
  architectPrompt?: string;
  simulateDefectCycle?: boolean;
  useDeterministicModel?: boolean;
}

export interface HeadlessE2eStageResult {
  stage: string;
  phaseAfter: WorkflowPhase;
  summary: string;
  artifactsCreated: string[];
}

export interface HeadlessE2eResult {
  ok: boolean;
  projectId: string;
  projectName: string;
  workspaceDir: string;
  finalPhase: WorkflowPhase;
  correctionCycles: number;
  stages: HeadlessE2eStageResult[];
  artifacts: Array<{
    code: string;
    type: string;
    version: number;
    status: string;
    filePath: string;
  }>;
  qaSummaryTable: string;
  outputText: string;
}

export interface VirtualTuiStep {
  input: string;
  waitMs?: number;
}

export interface VirtualTuiSessionOptions {
  orchestrator: PoCliOrchestrator;
  initialProject?: Project | null;
  steps: VirtualTuiStep[];
  columns?: number;
  rows?: number;
  timeoutMs?: number;
}

export interface VirtualTuiSessionResult {
  ok: boolean;
  framesCount: number;
  lastFrameRaw: string;
  lastFrameText: string;
  allTextCombined: string;
  finalProject: Project | null;
}

/**
 * Strips ANSI escape sequences from a rendered TUI frame so assertions and CLI logs
 * can inspect the visible text cleanly.
 */
export function stripAnsiCodes(input: string): string {
  return input
    .replace(
      // eslint-disable-next-line no-control-regex
      /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g,
      '',
    )
    .replace(/\r/g, '');
}

/**
 * Headless CLI & E2E Runner for `pocli`.
 * Allows executing slash commands, multi-agent prompts, and full end-to-end engineering
 * workflows from the command line without opening an interactive TUI session.
 */
export class HeadlessCliRunner {
  constructor(public readonly orchestrator: PoCliOrchestrator) {}

  get storage(): PoCliDatabase {
    return this.orchestrator.storage;
  }

  /**
   * Ensures an active project exists (selecting by name if provided, or creating it).
   */
  ensureProject(params?: {
    projectName?: string;
    description?: string;
    workspaceDir?: string;
    useDeterministicModel?: boolean;
  }): Project {
    const requestedName = params?.projectName?.trim();
    const projects = this.storage.listProjects();

    let project: Project | undefined;
    if (requestedName) {
      project = projects.find(
        (p) =>
          p.name.toLowerCase() === requestedName.toLowerCase() ||
          p.id === requestedName,
      );
      if (project) {
        this.storage.switchActiveProject(project.id);
      } else {
        const baseWorkDir =
          params?.workspaceDir ??
          path.join(
            this.storage.getSettings().workDir,
            'workspaces',
            requestedName,
          );
        project = this.orchestrator.createProject({
          name: requestedName,
          description:
            params?.description ??
            `Project ${requestedName} created via headless CLI`,
          workspaceDir: baseWorkDir,
        });
      }
    } else {
      project = this.storage.getActiveProject() ?? projects[0];
      if (!project) {
        const defaultName = 'HeadlessProject';
        const baseWorkDir =
          params?.workspaceDir ??
          path.join(
            this.storage.getSettings().workDir,
            'workspaces',
            defaultName,
          );
        project = this.orchestrator.createProject({
          name: defaultName,
          description: 'Default project created via headless CLI',
          workspaceDir: baseWorkDir,
        });
      }
    }

    if (params?.useDeterministicModel) {
      for (const role of ['pm', 'architect', 'developer', 'qa'] as const) {
        this.storage.assignModelToRole({
          projectId: project.id,
          role,
          provider: 'deterministic',
          modelId: 'pocli-specialist-v1',
          temperature: 0,
        });
      }
    }

    return project;
  }

  /**
   * Executes a single slash command or natural-language prompt against `pocli` headlessly.
   */
  async executeCommand(options: HeadlessExecOptions): Promise<HeadlessExecResult> {
    const raw = options.commandOrPrompt.trim();
    const followHandoffs = options.followHandoffs ?? true;
    const role: ActorRole = options.role ?? 'architect';

    // Handle `/project <name> [description]` first since it creates/switches project
    if (raw.startsWith('/project ') || raw === '/project') {
      const rest = raw.slice('/project'.length).trim();
      if (!rest) {
        const active = this.storage.getActiveProject();
        return {
          ok: true,
          action: 'project:current',
          project: active ?? null,
          turns: [],
          outputText: active
            ? `Active Project: ${active.name} (${active.id}) — Phase: ${active.phase} — Workspace: ${active.workspaceDir}`
            : 'No active project.',
        };
      }
      const [name, ...descParts] = rest.split(/\s+/);
      const description =
        descParts.join(' ').trim() || `Project ${name} created via CLI`;
      const wsDir =
        options.workspaceDir ??
        path.join(this.storage.getSettings().workDir, 'workspaces', name);
      const created = this.orchestrator.createProject({
        name,
        description,
        workspaceDir: wsDir,
      });
      return {
        ok: true,
        action: 'project:create',
        project: created,
        turns: [],
        outputText: `Created and activated project "${created.name}" (${created.id}) in ${created.workspaceDir} [Phase: ${created.phase}]`,
      };
    }

    if (raw === '/projects') {
      const list = this.storage.listProjects();
      const active = this.storage.getActiveProject();
      const lines = list.map(
        (p) =>
          `${active?.id === p.id ? '*' : ' '} ${p.name} (${p.id}) | Phase: ${p.phase} | Workspace: ${p.workspaceDir}`,
      );
      return {
        ok: true,
        action: 'projects:list',
        project: active ?? null,
        turns: [],
        outputText:
          lines.length > 0 ? lines.join('\n') : 'No projects registered.',
      };
    }

    const project = this.ensureProject({
      projectName: options.projectName,
      workspaceDir: options.workspaceDir,
    });

    if (options.modelSpec) {
      const resolved = resolveModelSpec(options.modelSpec);
      if (resolved) {
        for (const r of ['pm', 'architect', 'developer', 'qa'] as const) {
          this.storage.assignModelToRole({
            projectId: project.id,
            role: r,
            provider: resolved.provider,
            modelId: resolved.modelId,
            temperature: resolved.defaultTemperature,
          });
        }
      }
    }

    if (raw === '/status') {
      const current = this.storage.getProject(project.id)!;
      const artifacts = this.storage.listArtifacts(project.id, true);
      const qaReports = this.storage.listQaReports(project.id);
      const out = [
        `Project: ${current.name} (${current.id})`,
        `Phase: ${current.phase}`,
        `Approved Architecture Version: v${current.approvedArchitectureVersion}`,
        `Correction Cycles: ${current.correctionCycleCount}`,
        `Workspace: ${current.workspaceDir}`,
        `Artifacts (${artifacts.length}): ${artifacts.map((a) => `${a.code} v${a.version} [${a.status}]`).join(', ') || 'none'}`,
        `QA Reports (${qaReports.length}): ${qaReports.map((r) => `${r.payload.verdict ?? r.payload.recommendation}`).join(', ') || 'none'}`,
      ].join('\n');
      return {
        ok: true,
        action: 'status',
        project: current,
        turns: [],
        outputText: out,
      };
    }

    if (raw === '/artifacts') {
      const artifacts = this.storage.listArtifacts(project.id, true);
      const table = this.orchestrator.formatArtifactsSummaryTable(
        artifacts,
        this.storage.getSettings().language,
        project.workspaceDir,
      );
      return {
        ok: true,
        action: 'artifacts:list',
        project,
        turns: [],
        outputText: table || 'No artifacts found.',
      };
    }

    if (raw.startsWith('/approve')) {
      const parts = raw.slice('/approve'.length).trim().split(/\s+/).filter(Boolean);
      const artifactCode =
        parts[0]?.toUpperCase().startsWith('ARCH-') ? parts[0].toUpperCase() : 'ARCH-001';
      const comments =
        (parts[0]?.toUpperCase().startsWith('ARCH-')
          ? parts.slice(1).join(' ')
          : parts.join(' ')) || 'Approved by Product Owner via headless CLI.';
      const res = this.orchestrator.reviewArchitectureByPo({
        projectId: project.id,
        artifactCode,
        decision: 'APPROVED',
        comments,
      });
      return {
        ok: true,
        action: 'architecture:approve',
        project: res.project,
        turns: [],
        outputText: `Approved ${artifactCode} v${res.approval.artifactVersion}. Project transitioned to ${res.project.phase}.`,
      };
    }

    if (raw.startsWith('/reject')) {
      const parts = raw.slice('/reject'.length).trim().split(/\s+/).filter(Boolean);
      const artifactCode =
        parts[0]?.toUpperCase().startsWith('ARCH-') ? parts[0].toUpperCase() : 'ARCH-001';
      const comments =
        (parts[0]?.toUpperCase().startsWith('ARCH-')
          ? parts.slice(1).join(' ')
          : parts.join(' ')) || 'Rejected by Product Owner via headless CLI.';
      const res = this.orchestrator.reviewArchitectureByPo({
        projectId: project.id,
        artifactCode,
        decision: 'REJECTED',
        comments,
      });
      return {
        ok: true,
        action: 'architecture:reject',
        project: res.project,
        turns: [],
        outputText: `Rejected ${artifactCode}. Project transitioned to ${res.project.phase}.`,
      };
    }

    if (raw.startsWith('/handoff')) {
      const instructions =
        raw.slice('/handoff'.length).trim() ||
        'Implement the approved architecture ARCH-001 and technical specification SPEC-001.';
      const current = this.storage.getProject(project.id)!;
      if (
        current.phase === 'PHASE_2_ARCHITECT_ANALYSIS' ||
        current.phase === 'PHASE_3_ARCHITECTURE_APPROVAL'
      ) {
        const arch = this.storage.getLatestArtifactByCode(project.id, 'ARCH-001');
        if (arch && current.approvedArchitectureVersion === 0) {
          this.orchestrator.reviewArchitectureByPo({
            projectId: project.id,
            artifactCode: 'ARCH-001',
            decision: 'APPROVED',
            comments: 'Auto-approved during headless /handoff.',
          });
        }
      }
      const bundle = this.orchestrator.performDeveloperHandoff(
        project.id,
        instructions,
      );
      if (!followHandoffs) {
        const updated = this.storage.getProject(project.id)!;
        return {
          ok: true,
          action: 'handoff:developer',
          project: updated,
          turns: [],
          outputText: `Handoff bundle prepared for Developer (ARCH v${bundle.approvedArchitectureVersion}). Phase: ${updated.phase}`,
        };
      }
      const chain = await this.orchestrator.executeAutonomousWorkflowChain({
        projectId: project.id,
        initialRole: 'developer',
        initialMessage: instructions,
        senderRole: 'architect',
      });
      return this.formatChainExecResult(
        'handoff:autonomous_chain',
        chain.finalProject,
        chain.turnsExecuted,
      );
    }

    if (raw.startsWith('/accept')) {
      const comments =
        raw.slice('/accept'.length).trim() ||
        'Final deliverable accepted by Product Owner via headless CLI.';
      const accepted = this.orchestrator.acceptProjectByPo({
        projectId: project.id,
        comments,
      });
      return {
        ok: true,
        action: 'project:accept',
        project: accepted,
        turns: [],
        outputText: `Project "${accepted.name}" formally accepted by Product Owner. Final phase: ${accepted.phase}.`,
      };
    }

    if (raw.startsWith('/compact')) {
      const compactRes = this.orchestrator.compactContext({
        projectId: project.id,
        targetRole: 'all',
      });
      return {
        ok: true,
        action: 'context:compact',
        project: this.storage.getProject(project.id)!,
        turns: [],
        outputText: `Compacted ${compactRes.totalCompactedMessages} messages across ${compactRes.checkpoints.length} checkpoints (saved ~${compactRes.totalSavedTokens} tokens).`,
      };
    }

    if (raw.startsWith('/pm ')) {
      const topic = raw.slice('/pm '.length).trim();
      const pmRes = await this.orchestrator.executePmInquiry({
        projectId: project.id,
        topic,
      });
      return {
        ok: true,
        action: 'pm:inquiry',
        project: this.storage.getProject(project.id)!,
        turns: [],
        outputText: pmRes.report.consolidatedSummary,
      };
    }

    // Standard prompt to target role (optionally chaining autonomous handoffs)
    if (followHandoffs) {
      const chain = await this.orchestrator.executeAutonomousWorkflowChain({
        projectId: project.id,
        initialRole: role,
        initialMessage: raw,
        senderRole: 'product_owner',
      });
      return this.formatChainExecResult(
        `chat:${role}`,
        chain.finalProject,
        chain.turnsExecuted,
      );
    } else {
      const turn = await this.orchestrator.chatWithProfessional({
        projectId: project.id,
        targetRole: role,
        message: raw,
      });
      return this.formatChainExecResult(`chat:${role}`, turn.project, [
        {
          role,
          senderRole: 'product_owner',
          reply: turn.reply,
          createdArtifacts: turn.createdArtifacts,
          autonomousHandoff: turn.autonomousHandoff,
        },
      ]);
    }
  }

  private formatChainExecResult(
    action: string,
    finalProject: Project,
    turnsExecuted: Array<{
      role: ActorRole;
      senderRole: ActorRole | 'product_owner';
      reply: string;
      createdArtifacts: Artifact[];
      autonomousHandoff?: AutonomousHandoffTrigger;
    }>,
  ): HeadlessExecResult {
    const turns: HeadlessTurnRecord[] = turnsExecuted.map((t) => ({
      role: t.role,
      senderRole: t.senderRole,
      reply: t.reply,
      createdArtifacts: t.createdArtifacts.map((a) => ({
        code: a.code,
        type: a.type,
        version: a.version,
        filePath: a.filePath,
      })),
      autonomousHandoff: t.autonomousHandoff,
    }));

    const sections: string[] = [];
    for (const t of turnsExecuted) {
      sections.push(
        `=== [${t.senderRole.toUpperCase()} -> ${t.role.toUpperCase()}] ===\n${t.reply}`,
      );
      if (
        t.autonomousHandoff?.alreadyDeliveredToArchitect &&
        t.autonomousHandoff.instructions
      ) {
        sections.push(
          `=== [QA -> ARCHITECT COMPLETION REPORT] ===\n${t.autonomousHandoff.instructions}`,
        );
      }
    }
    sections.push(
      `--- Project "${finalProject.name}" Phase: ${finalProject.phase} ---`,
    );

    return {
      ok: true,
      action,
      project: finalProject,
      turns,
      outputText: sections.join('\n\n'),
    };
  }

  /**
   * Executes a complete, deterministic end-to-end engineering workflow from project creation
   * through Architect design, PO approval, Developer implementation + Gherkin, Independent QA
   * 7-Phase verification (with optional FAIL -> DEV -> PASS correction loop), Architect summary
   * table report, and Final PO Acceptance (`COMPLETED`).
   */
  async runFullE2eLifecycle(
    options?: HeadlessE2eOptions,
  ): Promise<HeadlessE2eResult> {
    const projectName = options?.projectName ?? `E2EProject_${Date.now()}`;
    const useDeterministic = options?.useDeterministicModel ?? true;
    const project = this.ensureProject({
      projectName,
      description:
        options?.projectDescription ??
        'Automated End-to-End Verification Project',
      workspaceDir: options?.workspaceDir,
      useDeterministicModel: useDeterministic,
    });

    const stages: HeadlessE2eStageResult[] = [];

    // Stage 1: Architect proposes formal architecture (ARCH-001) & specification (SPEC-001)
    const archPrompt =
      options?.architectPrompt ??
      'Design and propose the formal architecture and technical requirements for the system.';
    const archTurn = await this.orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: archPrompt,
    });
    stages.push({
      stage: '1. Architect Analysis & Contract Proposal (ARCH-001, SPEC-001)',
      phaseAfter: archTurn.project.phase,
      summary: archTurn.reply.split('\n')[0] ?? 'Architecture proposed',
      artifactsCreated: archTurn.createdArtifacts.map((a) => a.code),
    });

    // Stage 2: Product Owner approves ARCH-001 -> PHASE_4_DEVELOPER_HANDOFF
    const approval = this.orchestrator.reviewArchitectureByPo({
      projectId: project.id,
      artifactCode: 'ARCH-001',
      decision: 'APPROVED',
      comments: 'Approved ARCH-001 v1 during automated E2E lifecycle.',
    });
    stages.push({
      stage: '2. Product Owner Formal Architecture Approval',
      phaseAfter: approval.project.phase,
      summary: `Approved ARCH-001 v${approval.approval.artifactVersion}`,
      artifactsCreated: [],
    });

    // Stage 3: Architect hands off to Developer -> Autonomous Chain (Developer -> QA [-> Developer -> QA] -> Architect)
    const handoffInstructions = options?.simulateDefectCycle
      ? 'Implement the module with FORCE_TEST_FAILURE on initial pass and submit to QA.'
      : 'Implement the approved architecture ARCH-001 and SPEC-001, run unit tests, write DEV-GHERKIN-001, and submit to QA.';
    this.orchestrator.performDeveloperHandoff(project.id, handoffInstructions);

    const chain = await this.orchestrator.executeAutonomousWorkflowChain({
      projectId: project.id,
      initialRole: 'developer',
      initialMessage: handoffInstructions,
      senderRole: 'architect',
    });

    for (let i = 0; i < chain.turnsExecuted.length; i++) {
      const t = chain.turnsExecuted[i];
      stages.push({
        stage: `3.${i + 1}. Autonomous Turn [${t.senderRole.toUpperCase()} -> ${t.role.toUpperCase()}]`,
        phaseAfter:
          i === chain.turnsExecuted.length - 1
            ? chain.finalProject.phase
            : 'PHASE_6_QA_VALIDATION',
        summary: t.reply.split('\n')[0] ?? `${t.role} turn completed`,
        artifactsCreated: t.createdArtifacts.map((a) => a.code),
      });
    }

    // Retrieve the [QA -> ARQ] Summary Table message delivered to the Architect
    const archMessages = this.storage.listMessages(project.id, 'architect');
    const qaToArchMsg = [...archMessages]
      .reverse()
      .find(
        (m) =>
          m.fromRole === 'qa' &&
          m.toRole === 'architect' &&
          m.content.includes('[QA → ARQ]'),
      );
    const qaSummaryTable = qaToArchMsg?.content ?? '';

    // Stage 4: Final Product Owner Acceptance -> COMPLETED
    let finalProject = this.storage.getProject(project.id)!;
    if (finalProject.phase === 'PHASE_8_FINAL_ACCEPTANCE') {
      finalProject = this.orchestrator.acceptProjectByPo({
        projectId: project.id,
        comments:
          'Accepted final deliverable after independent QA PASS and summary table review.',
      });
      stages.push({
        stage: '4. Product Owner Final Acceptance',
        phaseAfter: finalProject.phase,
        summary: 'Project transitioned to COMPLETED',
        artifactsCreated: [],
      });
    }

    const allArtifacts = this.storage.listArtifacts(project.id, true).map((a) => ({
      code: a.code,
      type: a.type,
      version: a.version,
      status: a.status,
      filePath: a.filePath,
    }));

    const outputLines: string[] = [
      `================================================================================`,
      `PO CLI — AUTOMATED END-TO-END LIFECYCLE REPORT (${finalProject.name})`,
      `================================================================================`,
      `Project ID        : ${finalProject.id}`,
      `Workspace         : ${finalProject.workspaceDir}`,
      `Final Phase       : ${finalProject.phase}`,
      `Correction Cycles : ${finalProject.correctionCycleCount}`,
      ``,
      `--- Executed Stages (${stages.length}) ---`,
      ...stages.map(
        (s) =>
          `  ✔ ${s.stage} -> [${s.phaseAfter}]${s.artifactsCreated.length > 0 ? ` (Artifacts: ${s.artifactsCreated.join(', ')})` : ''}`,
      ),
      ``,
      `--- Generated Artifacts (${allArtifacts.length}) ---`,
      ...allArtifacts.map(
        (a) =>
          `  • ${a.code.padEnd(16, ' ')} v${a.version} [${a.type.padEnd(14, ' ')}] -> ${path.relative(finalProject.workspaceDir, a.filePath)}`,
      ),
      ``,
      `--- Direct [QA -> ARQ] Completion Summary Table ---`,
      qaSummaryTable || '(No QA summary table recorded)',
      `================================================================================`,
    ];

    return {
      ok: finalProject.phase === 'COMPLETED' && qaSummaryTable.length > 0,
      projectId: finalProject.id,
      projectName: finalProject.name,
      workspaceDir: finalProject.workspaceDir,
      finalPhase: finalProject.phase,
      correctionCycles: finalProject.correctionCycleCount,
      stages,
      artifacts: allArtifacts,
      qaSummaryTable,
      outputText: outputLines.join('\n'),
    };
  }
}

/**
 * Drives the real Ink `CommandCenterApp` TUI component using virtual in-memory TTY streams,
 * allowing automated tests and CLI verification to test the full TUI without blocking on stdin.
 */
export async function runVirtualTuiSession(
  options: VirtualTuiSessionOptions,
): Promise<VirtualTuiSessionResult> {
  const columns = options.columns ?? 140;
  const rows = options.rows ?? 45;
  const timeoutMs = options.timeoutMs ?? 15000;

  const stdinStream = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
    ref?: () => void;
    unref?: () => void;
  };
  stdinStream.isTTY = true;
  stdinStream.setRawMode = () => {};
  stdinStream.ref = () => {};
  stdinStream.unref = () => {};

  const stdoutStream = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
  };
  stdoutStream.isTTY = true;
  stdoutStream.columns = columns;
  stdoutStream.rows = rows;

  const rawFrames: string[] = [];
  const textFrames: string[] = [];
  stdoutStream.on('data', (chunk: Buffer | string) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    rawFrames.push(str);
    const stripped = stripAnsiCodes(str).trim();
    if (stripped.length > 0) {
      textFrames.push(stripped);
    }
  });

  const instance = render(
    React.createElement(CommandCenterApp, {
      orchestrator: options.orchestrator,
      initialProject: options.initialProject ?? null,
    }),
    {
      stdin: stdinStream as unknown as NodeJS.ReadStream,
      stdout: stdoutStream as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const sessionPromise = (async () => {
    // Wait for initial TUI mount & render
    await sleep(120);

    for (const step of options.steps) {
      // Send characters first, then carriage return so Ink's useInput processes text + return
      if (step.input.endsWith('\r') || step.input.endsWith('\n')) {
        const textBody = step.input.replace(/[\r\n]+$/, '');
        if (textBody.length > 0) {
          stdinStream.write(textBody);
          await sleep(40);
        }
        stdinStream.write('\r');
      } else {
        stdinStream.write(step.input);
      }
      await sleep(step.waitMs ?? 200);
    }
  })();

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Virtual TUI session timed out after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );

  try {
    await Promise.race([sessionPromise, timeoutPromise]);
  } finally {
    try {
      instance.unmount();
    } catch {
      // ignore unmount errors
    }
    stdinStream.end();
    stdoutStream.end();
  }

  const lastFrameRaw = rawFrames[rawFrames.length - 1] ?? '';
  const allRaw = rawFrames.join('\n');
  const allTextCombined = stripAnsiCodes(allRaw);
  const lastFrameText =
    textFrames[textFrames.length - 1] ?? stripAnsiCodes(lastFrameRaw);
  const finalProject = options.orchestrator.storage.getActiveProject() ?? null;

  return {
    ok: rawFrames.length > 0,
    framesCount: rawFrames.length,
    lastFrameRaw,
    lastFrameText,
    allTextCombined,
    finalProject,
  };
}
