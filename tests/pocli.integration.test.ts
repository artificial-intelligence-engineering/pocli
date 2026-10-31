import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AuthorityGuard,
  HarnessRegistry,
  I18N_DICTIONARY,
  LinuxAgentProcessRunner,
  NotebookRagEngine,
  PoCliDatabase,
  PoCliOrchestrator,
} from '../src/index.js';

describe('PO CLI — End-to-End Implementation Plan Verification (Phases 0 to 7)', () => {
  let tmpDir: string;
  let storage: PoCliDatabase;
  let orchestrator: PoCliOrchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-test-'));
    storage = new PoCliDatabase(path.join(tmpDir, 'pocli.sqlite'));
    orchestrator = new PoCliOrchestrator(storage);
  });

  afterEach(() => {
    orchestrator.rag.stopWatchers();
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Phase 0 & 1: executes agent turn in isolated Linux child_process via JSON-RPC 2.0 over stdio and persists in SQLite', async () => {
    const project = orchestrator.createProject({
      name: 'SkeletonApp',
      description: 'Walking skeleton test project',
      workspaceDir: path.join(tmpDir, 'ws-skeleton'),
    });

    expect(project.phase).toBe('PHASE_2_ARCHITECT_ANALYSIS');

    const streamedChunks: string[] = [];
    const res = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Hello Architect, let us review the initial scope.',
      onStreamChunk: (chunk) => streamedChunks.push(chunk),
    });

    expect(res.workerPid).toBeGreaterThan(0);
    expect(res.workerPid).not.toBe(process.pid);
    expect(streamedChunks.length).toBeGreaterThan(0);

    const messages = storage.listMessages(project.id, 'architect');
    expect(messages).toHaveLength(2);
    expect(messages[0].fromRole).toBe('product_owner');
    expect(messages[1].fromRole).toBe('architect');
  });

  it('Phase 2 & 3: enforces authority rules, versions artifacts on disk, blocks unilateral Developer changes, and handles Architect/PO consultations', async () => {
    const project = orchestrator.createProject({
      name: 'AuthoritySystem',
      description: 'Project testing authority boundaries',
      workspaceDir: path.join(tmpDir, 'ws-authority'),
    });

    // Architect proposes formal architecture
    const archTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Design and propose the formal architecture and requirements for the system.',
    });

    expect(archTurn.createdArtifacts.map((a) => a.code)).toEqual([
      'REQ-001',
      'ADR-001',
      'ARCH-001',
      'SPEC-001',
    ]);
    expect(archTurn.project.phase).toBe('PHASE_3_ARCHITECTURE_APPROVAL');

    // Verify Architect or Developer CANNOT approve architecture (Only Product Owner can)
    expect(() =>
      storage.approveOrRejectArchitecture({
        projectId: project.id,
        artifactCode: 'ARCH-001',
        approverRole: 'architect',
        decision: 'APPROVED',
        comments: 'Self-approval attempt',
      }),
    ).toThrow(/Authority Violation/);

    // Product Owner approves architecture v1
    const { approval, project: afterPoApproval } = orchestrator.reviewArchitectureByPo({
      projectId: project.id,
      artifactCode: 'ARCH-001',
      decision: 'APPROVED',
      comments: 'Approved v1 by Product Owner',
    });
    expect(approval.artifactVersion).toBe(1);
    expect(afterPoApproval.approvedArchitectureVersion).toBe(1);
    expect(afterPoApproval.phase).toBe('PHASE_4_DEVELOPER_HANDOFF');

    // Perform Handoff to Developer
    const handoff = orchestrator.performDeveloperHandoff(project.id);
    expect(handoff.approvedArchitectureVersion).toBe(1);
    expect(storage.getProject(project.id)!.phase).toBe('PHASE_5_IMPLEMENTATION');

    // Rule 4: Developer CANNOT unilaterally modify ARCHITECTURE or ADR
    expect(() =>
      storage.saveArtifact({
        projectId: project.id,
        code: 'ARCH-001',
        type: 'ARCHITECTURE',
        title: 'Unilateral Developer Change',
        content: 'Modified architecture without Architect/PO',
        authorRole: 'developer',
      }),
    ).toThrow(/Authority Violation: Developer cannot unilaterally modify ARCHITECTURE/);

    // Developer consults Architect on an issue that requires PO intervention
    const escalated = await orchestrator.consultArchitectFromDeveloper({
      projectId: project.id,
      subject: 'Scope change in persistence requirement',
      ambiguityOrBlocker: 'We need to change the primary functional requirement',
      proposedAlternative: 'Use temporary in-memory storage',
      impactedArtifacts: ['REQ-001', 'ARCH-001'],
      requiresPoIntervention: true,
    });
    expect(escalated.status).toBe('ESCALATED_TO_PO');

    // PO resolves the escalated consultation and approves Architecture v2
    const resolvedByPo = orchestrator.resolveEscalatedConsultationByPo({
      projectId: project.id,
      consultationId: escalated.id,
      approved: true,
      poDecisionNotes: 'Approved update to ARCH-001 v2.',
      updatedArchitectureContent: '# ARCH-001 v2: Architecture updated with PO authorization',
    });
    expect(resolvedByPo.status).toBe('APPROVED_BY_PO');
    expect(storage.getProject(project.id)!.approvedArchitectureVersion).toBe(2);
  });

  it('Phase 4: executes independent QA validation, rejects defective delivery into Phase 7 Correction Cycle, re-validates fix, and completes in Phase 8', async () => {
    const wsDir = path.join(tmpDir, 'ws-qa-cycle');
    const project = orchestrator.createProject({
      name: 'PaymentGateway',
      description: 'Service with strict QA verification cycle',
      workspaceDir: wsDir,
    });

    await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Propose the formal architecture for PaymentGateway.',
    });
    orchestrator.reviewArchitectureByPo({
      projectId: project.id,
      decision: 'APPROVED',
      comments: 'Approved v1',
    });
    orchestrator.performDeveloperHandoff(project.id);

    // Developer writes a defective implementation first (returns value * 3 instead of value * 2)
    storage.saveArtifact({
      projectId: project.id,
      code: 'CODE-001',
      type: 'SOURCE_CODE',
      title: 'Defective Implementation v1',
      content: `export function executeBusinessLogic(input) { return { ok: true, result: input.value * 3 }; }\n`,
      authorRole: 'developer',
      customRelPath: 'src/app-module.js',
      tracesTo: ['REQ-001', 'ARCH-001', 'SPEC-001'],
    });

    // QA runs independent verification -> MUST REJECT and transition to PHASE_7_CORRECTION_CYCLE
    const firstQa = await orchestrator.submitToQaAndValidate({
      projectId: project.id,
    });
    expect(firstQa.payload.recommendation).toBe('REJECT');
    expect(firstQa.payload.defects).toHaveLength(1);
    expect(firstQa.payload.defects[0].code).toBe('DEF-001');
    expect(firstQa.project.phase).toBe('PHASE_7_CORRECTION_CYCLE');
    expect(firstQa.project.correctionCycleCount).toBe(1);

    // PO cannot accept project while in correction cycle
    expect(() =>
      orchestrator.acceptProjectByPo({
        projectId: project.id,
        comments: 'Premature acceptance attempt',
      }),
    ).toThrow(/Must pass QA validation first/);

    // Developer fixes the defect in Phase 7 Correction Cycle (producing CODE-001 v2)
    await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'developer',
      message: 'Fix and implement the module fulfilling SPEC-001.',
    });

    // QA re-validates -> MUST ACCEPT and transition to PHASE_8_FINAL_ACCEPTANCE
    const secondQa = await orchestrator.submitToQaAndValidate({
      projectId: project.id,
    });
    expect(secondQa.qaArtifact.code).toBe('QA-002');
    expect(secondQa.payload.recommendation).toBe('ACCEPT');
    expect(secondQa.payload.failedTests).toHaveLength(0);
    expect(secondQa.project.phase).toBe('PHASE_8_FINAL_ACCEPTANCE');

    // Final PO Acceptance -> COMPLETED
    const finalProject = orchestrator.acceptProjectByPo({
      projectId: project.id,
      comments: 'All evidence in QA-002 is satisfactory.',
    });
    expect(finalProject.phase).toBe('COMPLETED');
  });

  it('Phase 6: manages filesystem Notebooks, performs incremental SHA-256 indexing, enforces role access, and returns traceable RAG citations', () => {
    const archKbDir = path.join(tmpDir, 'nb-arch');
    const devKbDir = path.join(tmpDir, 'nb-typescript');
    fs.mkdirSync(archKbDir, { recursive: true });
    fs.mkdirSync(devKbDir, { recursive: true });

    fs.writeFileSync(
      path.join(archKbDir, 'microservices.md'),
      `# Microservices Patterns\n\n## Transactional Outbox\nTo guarantee eventual consistency between database and event bus, use the Transactional Outbox pattern.\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(devKbDir, 'strict-ts.md'),
      `# Strict TypeScript Guide\n\n## Zod Validation\nUse safeParse at all IPC boundaries and validate JSON-RPC schemas.\n`,
      'utf8',
    );

    const { notebook: archNb, indexResult: idx1 } = orchestrator.createAndIndexNotebook({
      name: 'Notebook-Architecture',
      description: 'Distributed architecture patterns',
      dirPath: archKbDir,
      allowedRoles: ['architect'], // Exclusive to Architect
      externalRefs: [
        {
          title: 'Microservices.io Outbox Pattern',
          url: 'https://microservices.io/patterns/data/transactional-outbox.html',
          notes: 'Canonical Outbox reference',
        },
      ],
    });
    expect(idx1.indexedFiles).toBe(1);
    expect(idx1.totalChunks).toBeGreaterThanOrEqual(2);

    // Re-indexing without file changes should skip unchanged files (incremental SHA-256 check)
    const idx2 = orchestrator.rag.indexNotebook(archNb.id);
    expect(idx2.indexedFiles).toBe(0);
    expect(idx2.unchangedFiles).toBe(1);

    const { notebook: devNb } = orchestrator.createAndIndexNotebook({
      name: 'Notebook-TypeScript',
      description: 'TypeScript implementation guidelines',
      dirPath: devKbDir,
      allowedRoles: ['developer'], // Exclusive to Developer
    });

    const project = orchestrator.createProject({
      name: 'RagProject',
      description: 'Testing multi-notebook N:M association and role filtering',
      workspaceDir: path.join(tmpDir, 'ws-rag'),
    });
    storage.linkNotebookToProject(project.id, archNb.id);
    storage.linkNotebookToProject(project.id, devNb.id);

    // Architect queries RAG -> can see Notebook-Architecture, cannot see Notebook-TypeScript
    const archCitations = orchestrator.rag.queryForProjectRole({
      projectId: project.id,
      role: 'architect',
      query: 'eventual consistency Transactional Outbox',
    });
    expect(archCitations.length).toBeGreaterThan(0);
    expect(archCitations.every((c) => c.notebookName === 'Notebook-Architecture')).toBe(true);
    const formatted = NotebookRagEngine.formatCitationTag(archCitations[0]);
    expect(formatted).toContain('Notebook: Notebook-Architecture');
    expect(formatted).toContain('Section: Transactional Outbox');

    // Developer queries RAG -> can see Notebook-TypeScript, cannot see Notebook-Architecture
    const devCitations = orchestrator.rag.queryForProjectRole({
      projectId: project.id,
      role: 'developer',
      query: 'Zod Validation at JSON-RPC boundaries',
    });
    expect(devCitations.length).toBeGreaterThan(0);
    expect(devCitations.every((c) => c.notebookName === 'Notebook-TypeScript')).toBe(true);
  });

  it('Phase 5 & 7: supports multi-language settings (/settings en|es), MCP stdio servers, 4-layer memory, Linux bwrap sandboxing, and extensible specialist roles', async () => {
    // 0. Test Multi-Language Settings persistence (default 'en', switchable to 'es')
    expect(storage.getSettings().language).toBe('en');
    expect(
      I18N_DICTIONARY.en.slashCommands.some((c) => c.command === '/settings'),
    ).toBe(true);
    expect(
      I18N_DICTIONARY.en.slashCommands.some((c) => c.command === '/help'),
    ).toBe(true);
    expect(
      I18N_DICTIONARY.es.slashCommands.some((c) => c.command === '/settings'),
    ).toBe(true);
    expect(
      I18N_DICTIONARY.es.slashCommands.some((c) => c.command === '/help'),
    ).toBe(true);

    const updatedEs = storage.updateSettings({ language: 'es' });
    expect(updatedEs.language).toBe('es');
    expect(storage.getSettings().language).toBe('es');

    const updatedEn = storage.updateSettings({ language: 'en' });
    expect(updatedEn.language).toBe('en');

    const project = orchestrator.createProject({
      name: 'PlatformAdvanced',
      description: 'Testing MCP, 4-layer memory, bwrap and custom specialists',
      workspaceDir: path.join(tmpDir, 'ws-advanced'),
    });

    // 1. Test 4-Layer Memory System
    storage.upsertMemory({
      projectId: project.id,
      layer: 'WORKING',
      agentRole: 'developer',
      key: 'current_module',
      value: 'auth-guard.ts',
    });
    storage.upsertMemory({
      projectId: project.id,
      layer: 'AGENT_SPECIFIC',
      agentRole: 'qa',
      key: 'preferred_assertion_style',
      value: 'strict-exit-code-check',
    });
    expect(storage.listMemories(project.id, 'WORKING', 'developer')).toHaveLength(1);
    expect(storage.listMemories(project.id, 'AGENT_SPECIFIC', 'qa')).toHaveLength(1);

    // 2. Test Extensible Specialist Role (e.g., security_auditor)
    HarnessRegistry.registerCustomHarness({
      role: 'security_auditor',
      displayName: 'DevSecOps Security Auditor',
      systemPrompt: 'Audits vulnerabilities and emits security reports.',
      allowedTools: ['query_notebooks'],
      allowedArtifactTypes: ['QA_REPORT', 'DEFECT', 'DOCUMENTATION'],
    });
    expect(AuthorityGuard.canWriteArtifact('security_auditor', 'DEFECT')).toBe(true);
    expect(AuthorityGuard.canWriteArtifact('security_auditor', 'ARCHITECTURE')).toBe(false);

    // 3. Test MCP Server over JSON-RPC stdio with role permissions
    const mcpServerScript = path.join(tmpDir, 'mock-mcp-server.mjs');
    fs.writeFileSync(
      mcpServerScript,
      `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'tools/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { tools: [{ name: 'lint_openapi', description: 'Lints OpenAPI spec' }] }
          }) + '\\n');
        } else if (req.method === 'tools/call') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { valid: true, checkedSpec: req.params.arguments.specPath }
          }) + '\\n');
        }
      });
      `,
      'utf8',
    );

    orchestrator.mcp.registerServer({
      id: 'openapi-linter',
      name: 'OpenAPI Linter MCP',
      command: process.execPath,
      args: [mcpServerScript],
      allowedRoles: ['architect', 'qa'],
    });

    const tools = await orchestrator.mcp.discoverTools('openapi-linter');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('lint_openapi');

    const mcpResult = await orchestrator.mcp.callToolForRole({
      role: 'architect',
      serverId: 'openapi-linter',
      toolName: 'lint_openapi',
      args: { specPath: 'api/v1.yaml' },
    });
    expect(mcpResult).toEqual({ valid: true, checkedSpec: 'api/v1.yaml' });

    // Developer is not in allowedRoles for openapi-linter MCP server
    await expect(
      orchestrator.mcp.callToolForRole({
        role: 'developer',
        serverId: 'openapi-linter',
        toolName: 'lint_openapi',
        args: { specPath: 'api/v1.yaml' },
      }),
    ).rejects.toThrow(/MCP Permission Denied/);

    // 4. Test Multi-Model & Execution Modality configuration (including LINUX_BWRAP if supported by host)
    storage.setRoleConfig(project.id, {
      role: 'security_auditor',
      provider: 'deterministic',
      modelId: 'sec-audit-v1',
      temperature: 0.1,
      executionModality: LinuxAgentProcessRunner.canUseBwrap()
        ? 'LINUX_BWRAP'
        : 'LOCAL_PROCESS',
    });

    const secTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'security_auditor',
      message: 'Execute preliminary security audit for the project.',
    });
    expect(secTurn.reply).toContain('security_auditor');
  });

  it('Project Manager (PM): executes both PARALLEL and SEQUENTIAL inquiries across active agents, detects discrepancies, and cannot alter engineering artifacts', async () => {
    const project = orchestrator.createProject({
      name: 'PmOrchestrationApp',
      description: 'Testing PM parallel and sequential agent inquiries',
      workspaceDir: path.join(tmpDir, 'ws-pm'),
    });

    // 1. Verify PM has NO authority to modify ARCHITECTURE, SOURCE_CODE, or QA_REPORT
    expect(() =>
      storage.saveArtifact({
        projectId: project.id,
        code: 'ARCH-001',
        type: 'ARCHITECTURE',
        title: 'Unauthorized PM Architecture Edit',
        content: 'PM cannot direct or modify architecture',
        authorRole: 'pm',
      }),
    ).toThrow(/Authority Violation/);

    expect(() =>
      storage.saveArtifact({
        projectId: project.id,
        code: 'CODE-001',
        type: 'SOURCE_CODE',
        title: 'Unauthorized PM Code Edit',
        content: 'PM cannot modify code',
        authorRole: 'pm',
      }),
    ).toThrow(/Authority Violation/);

    // 2. Execute PARALLEL PM inquiry across Architect, Developer, and QA
    const parallelRes = await orchestrator.executePmInquiry({
      projectId: project.id,
      topic: 'Initial sprint readiness and architecture alignment',
      consultedAgents: ['architect', 'developer', 'qa'],
      modality: 'PARALLEL',
    });

    expect(parallelRes.report.modality).toBe('PARALLEL');
    expect(parallelRes.report.consultedAgents).toEqual([
      'architect',
      'developer',
      'qa',
    ]);
    expect(parallelRes.report.individualResponses).toHaveLength(3);
    expect(
      parallelRes.report.individualResponses.every(
        (r) => r.status === 'COMPLETE' && r.workerPid > 0,
      ),
    ).toBe(true);
    expect(parallelRes.artifact.code).toBe('PM-001');

    // 3. Execute SEQUENTIAL (chained) PM inquiry across Architect -> Developer -> QA
    const sequentialRes = await orchestrator.executePmInquiry({
      projectId: project.id,
      topic: 'Sequential dependency check from design to QA verification',
      consultedAgents: ['architect', 'developer', 'qa'],
      modality: 'SEQUENTIAL',
    });

    expect(sequentialRes.report.modality).toBe('SEQUENTIAL');
    expect(sequentialRes.report.individualResponses).toHaveLength(3);
    // In SEQUENTIAL mode, Developer and QA questions receive prior agent context
    expect(sequentialRes.report.individualResponses[1].questionAsked).toContain(
      '[Prior Agent Context in Sequential Inquiry]',
    );
    expect(sequentialRes.report.individualResponses[2].questionAsked).toContain(
      '[architect]:',
    );
    expect(sequentialRes.report.individualResponses[2].questionAsked).toContain(
      '[developer]:',
    );
    expect(sequentialRes.artifact.code).toBe('PM-002');

    // 4. Verify all 4 expert chat summaries and PM inquiries are centralized in SQLite
    const summaries = storage.listExpertChatSummaries(project.id);
    expect(summaries.map((s) => s.expertRole)).toEqual([
      'pm',
      'architect',
      'developer',
      'qa',
    ]);
    for (const summary of summaries) {
      expect(summary.totalMessages).toBeGreaterThan(0);
      expect(summary.summaryText.length).toBeGreaterThan(0);
      expect(summary.recentExchanges.length).toBeGreaterThan(0);
    }

    const storedPmInquiries = storage.listPmInquiries(project.id);
    expect(storedPmInquiries).toHaveLength(2);
  });

  it('creates multi-repository projects, discovers existing repositories, lists projects, and switches the active project in SQLite', () => {
    const multiRepoDir = path.join(tmpDir, 'multi-repo-workspace');
    const backendRepo = path.join(multiRepoDir, 'backend-api');
    const frontendRepo = path.join(multiRepoDir, 'frontend-web');
    const workerServiceRepo = path.join(multiRepoDir, 'packages', 'worker-rust');

    // Pre-populate existing repositories before creating the project
    fs.mkdirSync(path.join(backendRepo, '.git'), { recursive: true });
    fs.mkdirSync(frontendRepo, { recursive: true });
    fs.writeFileSync(
      path.join(frontendRepo, 'package.json'),
      JSON.stringify({ name: 'frontend-web' }),
      'utf8',
    );
    fs.mkdirSync(workerServiceRepo, { recursive: true });
    fs.writeFileSync(
      path.join(workerServiceRepo, 'Cargo.toml'),
      '[package]\nname = "worker-rust"\n',
      'utf8',
    );

    const p1 = orchestrator.createProject({
      name: 'EnterprisePlatform',
      description: 'Multi-repository enterprise platform',
      workspaceDir: multiRepoDir,
    });

    // Verify filesystem artifacts directory was created and existing repositories were discovered
    expect(fs.existsSync(path.join(multiRepoDir, '.pocli', 'artifacts'))).toBe(
      true,
    );
    expect(p1.repositories).toEqual([
      'backend-api',
      'frontend-web',
      'packages/worker-rust',
    ]);
    expect(storage.getActiveProject()?.id).toBe(p1.id);

    // Create a second project and verify active project automatically switches to it
    const secondDir = path.join(tmpDir, 'analytics-workspace');
    const p2 = orchestrator.createProject({
      name: 'AnalyticsEngine',
      description: 'Standalone analytics engine',
      workspaceDir: secondDir,
    });
    expect(storage.getActiveProject()?.id).toBe(p2.id);

    // List all existing projects (/projects)
    const allProjects = storage.listProjects();
    expect(allProjects.map((p) => p.name)).toContain('EnterprisePlatform');
    expect(allProjects.map((p) => p.name)).toContain('AnalyticsEngine');

    // Switch back to EnterprisePlatform by name (/switch EnterprisePlatform)
    const switched = storage.switchActiveProject('EnterprisePlatform');
    expect(switched.id).toBe(p1.id);
    expect(switched.repositories).toEqual([
      'backend-api',
      'frontend-web',
      'packages/worker-rust',
    ]);
    expect(storage.getActiveProject()?.name).toBe('EnterprisePlatform');
  });
});
