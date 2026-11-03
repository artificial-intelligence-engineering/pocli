import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppSettingsSchema,
  applyTerminalThemeOsc,
  AuthorityGuard,
  AVAILABLE_MODELS_CATALOG,
  DEFAULT_POCLI_HOME_DIR,
  executeDbCommandOrQuery,
  getRoleTheme,
  HarnessRegistry,
  I18N_DICTIONARY,
  isMouseSequence,
  LinuxAgentProcessRunner,
  NotebookRagEngine,
  parseMouseEvents,
  PoCliDatabase,
  PoCliOrchestrator,
  resolveModelSpec,
  SOLARIZED_COLORS,
  SupportedThemeSchema,
  THEME_PALETTES,
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
      expect(summary.interactions).toBeDefined();
      expect(typeof summary.interactions.po).toBe('number');
      expect(typeof summary.interactions.pm).toBe('number');
      expect(typeof summary.interactions.architect).toBe('number');
      expect(typeof summary.interactions.developer).toBe('number');
      expect(typeof summary.interactions.qa).toBe('number');
    }

    const pmSummary = summaries.find((s) => s.expertRole === 'pm')!;
    expect(pmSummary.interactions.architect).toBeGreaterThan(0);
    expect(pmSummary.interactions.developer).toBeGreaterThan(0);
    expect(pmSummary.interactions.qa).toBeGreaterThan(0);

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

  it('defaults central CLI folder to $HOME/.pocli/, allows changing working directory via /settings, and stores LLM Python scripts & PM spreadsheets there', async () => {
    // 1. Default global CLI directory is $HOME/.pocli
    expect(DEFAULT_POCLI_HOME_DIR).toBe(path.join(os.homedir(), '.pocli'));

    // 2. Customize the Central Working & Artifacts Directory via /settings
    const customCentralDir = path.join(tmpDir, 'custom-pocli-home');
    const updatedSettings = storage.updateSettings({
      workDir: customCentralDir,
    });
    expect(updatedSettings.workDir).toBe(customCentralDir);
    expect(
      fs.existsSync(path.join(customCentralDir, 'config', 'settings.json')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(customCentralDir, 'artifacts', 'scripts')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(customCentralDir, 'artifacts', 'outputs')),
    ).toBe(true);

    const project = orchestrator.createProject({
      name: 'CentralizedArtifactsDemo',
      description: 'Verifies LLM scripts and PM outputs in central working directory',
      workspaceDir: path.join(customCentralDir, 'workspaces', 'demo'),
    });

    // 3. Request Project Manager (PM) to generate both a Python helper script and a CSV spreadsheet
    const pmTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'pm',
      message:
        'Generate a python script to summarize project status and a csv spreadsheet with team metrics.',
    });

    expect(pmTurn.createdArtifacts.map((a) => a.code)).toContain('OUT-CSV-001');
    expect(pmTurn.createdArtifacts.map((a) => a.code)).toContain('OUT-PY-001');

    // Verify both files exist inside the configured central working directory (<workDir>/artifacts/...)
    const expectedCsvPath = path.join(
      customCentralDir,
      'artifacts',
      'outputs',
      'pm_project_metrics.csv',
    );
    const expectedPyPath = path.join(
      customCentralDir,
      'artifacts',
      'scripts',
      'pocli_task_helper.py',
    );
    expect(fs.existsSync(expectedCsvPath)).toBe(true);
    expect(fs.existsSync(expectedPyPath)).toBe(true);
    expect(fs.readFileSync(expectedCsvPath, 'utf8')).toContain(
      'project,phase,role,status,notes',
    );
    expect(fs.readFileSync(expectedPyPath, 'utf8')).toContain(
      '#!/usr/bin/env python3',
    );
  });

  it('implements Pi-inspired Context Window Compaction (/compact), Session Tree DAG parent_id lineage, and 3-tier prompt assembly in SQLite', async () => {
    const project = orchestrator.createProject({
      name: 'PiContextOptimization',
      description: 'Verifies Pi-style DAG session tree and context compaction in SQLite',
      workspaceDir: path.join(tmpDir, 'pi-context-workspace'),
    });

    // Send multiple turns to Architect so a multi-node DAG session tree is built
    await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Design and propose the initial hexagonal architecture for PiContextOptimization.',
    });
    await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Evaluate trade-offs for event-driven messaging and persistence.',
    });
    await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Refine interface boundaries between domain and adapters.',
    });

    const allArchMessages = storage.listMessages(project.id, 'architect');
    expect(allArchMessages.length).toBe(6);
    // Verify Session Tree (DAG) parentId chain
    expect(allArchMessages[0].parentId).toBeUndefined();
    for (let i = 1; i < allArchMessages.length; i++) {
      expect(allArchMessages[i].parentId).toBe(allArchMessages[i - 1].id);
      expect(allArchMessages[i].tokenEstimate).toBeGreaterThan(0);
    }

    // Compact the Architect context window (/compact architect), keeping only 1 recent message uncompacted
    const compactRes = orchestrator.compactContext({
      projectId: project.id,
      targetRole: 'architect',
      keepRecentCount: 1,
    });

    expect(compactRes.checkpoints).toHaveLength(1);
    expect(compactRes.totalCompactedMessages).toBe(5);
    expect(compactRes.totalSavedTokens).toBeGreaterThan(0);

    // Full historical audit log remains intact (6 messages), while active uncompacted window has only 1 message
    expect(storage.listMessages(project.id, 'architect', false)).toHaveLength(6);
    expect(storage.listMessages(project.id, 'architect', true)).toHaveLength(1);

    // Assemble the 3-tier Pi-style Context Window
    const assembled = storage.assembleAgentContextWindow(
      project.id,
      'architect',
    );
    expect(assembled.compactionCount).toBe(1);
    expect(assembled.savedTokensByCompaction).toBeGreaterThan(0);
    expect(assembled.activeRecentMessages).toHaveLength(1);
    expect(assembled.formattedPromptContext).toContain(
      '[TIER 1 — CACHEABLE NORMATIVE ARTIFACTS',
    );
    expect(assembled.formattedPromptContext).toContain(
      '[TIER 2 — 4-LAYER PERSISTENT MEMORY & PI COMPACTION CHECKPOINT]',
    );
    expect(assembled.formattedPromptContext).toContain(
      '[Pi Context Compaction Checkpoint — Role: architect',
    );
    expect(assembled.formattedPromptContext).toContain(
      '[TIER 3 — ACTIVE RECENT CONVERSATION WINDOW',
    );
  });

  it('supports OpenCode-style pocli db REPL commands (.tables, .stats, .projects, .experts) and SQL queries in table, json, and tsv formats', () => {
    orchestrator.createProject({
      name: 'DbReplInspectionProject',
      description: 'Project for verifying pocli db REPL and SQL queries',
      workspaceDir: path.join(tmpDir, 'db-repl-workspace'),
    });

    const tablesOut = executeDbCommandOrQuery(storage, '.tables', 'table');
    expect(tablesOut).toContain('projects');
    expect(tablesOut).toContain('messages');
    expect(tablesOut).toContain('context_compactions');
    expect(tablesOut).toContain('expert_chat_summaries');

    const statsOut = executeDbCommandOrQuery(storage, '.stats', 'table');
    expect(statsOut).toContain('projects');
    expect(statsOut).toContain('expert_chat_summaries');

    const jsonRows = JSON.parse(
      executeDbCommandOrQuery(
        storage,
        'SELECT name, phase FROM projects;',
        'json',
      ),
    ) as Array<{ name: string; phase: string }>;
    expect(jsonRows).toHaveLength(1);
    expect(jsonRows[0].name).toBe('DbReplInspectionProject');

    const tsvOut = executeDbCommandOrQuery(
      storage,
      'SELECT name, phase FROM projects;',
      'tsv',
    );
    expect(tsvOut).toContain('name\tphase\nDbReplInspectionProject\tPHASE_2_ARCHITECT_ANALYSIS');
  });

  it('parses SGR (1006) terminal mouse clicks and scroll wheel sequences for Ink TUI without polluting text input', () => {
    expect(isMouseSequence('normal text')).toBe(false);
    expect(isMouseSequence('/architect')).toBe(false);
    expect(isMouseSequence('\x1b[<0;42;8M')).toBe(true);
    expect(isMouseSequence('[<64;20;10M')).toBe(true);

    const clickAndWheel = parseMouseEvents(
      '\x1b[<0;42;8M\x1b[<0;42;8m[<64;20;10M[<65;20;10M',
    );
    expect(clickAndWheel).toHaveLength(4);
    expect(clickAndWheel[0]).toMatchObject({
      button: 'left',
      action: 'press',
      x: 42,
      y: 8,
    });
    expect(clickAndWheel[1]).toMatchObject({
      button: 'left',
      action: 'release',
      x: 42,
      y: 8,
    });
    expect(clickAndWheel[2]).toMatchObject({
      button: 'wheel-up',
      action: 'wheel',
      x: 20,
      y: 10,
    });
    expect(clickAndWheel[3]).toMatchObject({
      button: 'wheel-down',
      action: 'wheel',
      x: 20,
      y: 10,
    });
  });

  it('supports OpenCode-style /models catalog resolution and independent per-agent model configuration in SQLite', () => {
    const project = orchestrator.createProject({
      name: 'PerAgentModelsProject',
      description: 'Project testing independent LLM model per specialist agent',
      workspaceDir: path.join(tmpDir, 'per-agent-models-ws'),
    });

    expect(AVAILABLE_MODELS_CATALOG.length).toBeGreaterThanOrEqual(12);

    const claudeSonnet4 = resolveModelSpec('anthropic/claude-sonnet-4-20250514');
    expect(claudeSonnet4).not.toBeNull();
    expect(claudeSonnet4?.provider).toBe('anthropic');

    const o3Mini = resolveModelSpec('o3-mini');
    expect(o3Mini).not.toBeNull();
    expect(o3Mini?.provider).toBe('openai');

    const customOllama = resolveModelSpec('ollama/mistral-small:24b');
    expect(customOllama).not.toBeNull();
    expect(customOllama?.provider).toBe('ollama');
    expect(customOllama?.modelId).toBe('mistral-small:24b');

    // Configure distinct models for each specialist agent in the same project
    storage.assignModelToRole({
      projectId: project.id,
      role: 'architect',
      provider: claudeSonnet4!.provider,
      modelId: claudeSonnet4!.modelId,
      temperature: claudeSonnet4!.defaultTemperature,
    });
    storage.assignModelToRole({
      projectId: project.id,
      role: 'qa',
      provider: o3Mini!.provider,
      modelId: o3Mini!.modelId,
      temperature: o3Mini!.defaultTemperature,
    });
    storage.assignModelToRole({
      projectId: project.id,
      role: 'developer',
      provider: customOllama!.provider,
      modelId: customOllama!.modelId,
    });

    expect(storage.getRoleConfig(project.id, 'architect')).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
    });
    expect(storage.getRoleConfig(project.id, 'qa')).toMatchObject({
      provider: 'openai',
      modelId: 'o3-mini',
    });
    expect(storage.getRoleConfig(project.id, 'developer')).toMatchObject({
      provider: 'ollama',
      modelId: 'mistral-small:24b',
    });
    // PM remains on its default model until changed
    expect(storage.getRoleConfig(project.id, 'pm').modelId).toBe(
      'gemini-2.5-pro',
    );
  });

  it('LLMRouter: executes smart bandit routing, tracks quota/cooldown, and fails over on errors', async () => {
    const { LLMRouter } = await import('../src/runtime/llm-router.js');

    const router = new LLMRouter({
      providers: [
        {
          id: 'primary-mock-fail',
          name: 'Primary Failing Mock Provider',
          endpoint: 'https://127.0.0.1:59999/v1/fail',
          defaultModel: 'fail-model',
          limits: { rpm: 10, rpd: 100 },
          intelligenceScore: 0.95,
          speedScore: 0.9,
        },
        {
          id: 'secondary-mock-pass',
          name: 'Secondary Working Mock Provider',
          endpoint: 'https://127.0.0.1:59998/v1/pass',
          defaultModel: 'pass-model',
          limits: { rpm: 20, rpd: 200 },
          intelligenceScore: 0.85,
          speedScore: 0.7,
        },
      ],
      strategy: 'auto:smart',
      fallbackEnabled: true,
    });

    // Verify initial candidate chain ordering (highest score first)
    const initialChain = router.selectCandidateChain();
    expect(initialChain.map((p) => p.id)).toEqual([
      'primary-mock-fail',
      'secondary-mock-pass',
    ]);

    // Initial quota check passes
    expect(router.canUseProvider('primary-mock-fail')).toBe(true);
    expect(router.canUseProvider('secondary-mock-pass')).toBe(true);

    // Mock global fetch to simulate failure on primary and success on secondary
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        if (urlStr.includes('59999')) {
          // Simulate 429 rate limit error
          return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('59998')) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'Architecture approved with 0 vulnerabilities.',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return origFetch(input, init);
      }) as typeof fetch;

      // Execute completion: router should catch 429 on primary, bench it into cooldown, and failover to secondary
      const result = await router.completion({
        messages: [{ role: 'user', content: 'Generate architecture specification' }],
      });

      expect(result.providerId).toBe('secondary-mock-pass');
      expect(result.text).toContain('Architecture approved with 0 vulnerabilities.');

      // Primary provider should now be on cooldown / failing state
      expect(router.canUseProvider('primary-mock-fail')).toBe(false);

      // Re-evaluating candidate chain demotes the failing provider
      const updatedChain = router.selectCandidateChain();
      expect(updatedChain[0].id).toBe('secondary-mock-pass');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('Issue #3: executes concurrent agent chats in parallel with independent streaming and DAG histories', async () => {
    const project = orchestrator.createProject({
      name: 'ConcurrentChatsApp',
      description: 'Test project for concurrent multi-agent executions',
      workspaceDir: path.join(tmpDir, 'ws-concurrent'),
    });

    const pmChunks: string[] = [];
    const devChunks: string[] = [];

    // Dispatch both turns concurrently
    const [pmRes, devRes] = await Promise.all([
      orchestrator.chatWithProfessional({
        projectId: project.id,
        targetRole: 'pm',
        message: 'PM status inquiry for sprint roadmap',
        onStreamChunk: (c) => pmChunks.push(c),
      }),
      orchestrator.chatWithProfessional({
        projectId: project.id,
        targetRole: 'developer',
        message: 'Developer implementation plan check',
        onStreamChunk: (c) => devChunks.push(c),
      }),
    ]);

    // Both should have run in distinct Linux child processes
    expect(pmRes.workerPid).toBeGreaterThan(0);
    expect(devRes.workerPid).toBeGreaterThan(0);
    expect(pmRes.workerPid).not.toBe(devRes.workerPid);

    // Both received streaming chunks independently
    expect(pmChunks.length).toBeGreaterThan(0);
    expect(devChunks.length).toBeGreaterThan(0);

    // Histories are tracked independently in SQLite
    const pmMessages = storage.listMessages(project.id, 'pm');
    const devMessages = storage.listMessages(project.id, 'developer');

    expect(pmMessages).toHaveLength(2);
    expect(devMessages).toHaveLength(2);

    expect(pmMessages[0].content).toBe('PM status inquiry for sprint roadmap');
    expect(devMessages[0].content).toBe('Developer implementation plan check');
  });

  it('Issue #4: cycles agent chats in a carousel order (pm -> architect -> developer -> qa -> pm) and updates hints', () => {
    const roles = ['pm', 'architect', 'developer', 'qa'] as const;

    // 1. Verify carousel cycling logic and wrap-around
    const getNextRole = (current: string) => {
      const idx = roles.indexOf(current as (typeof roles)[number]);
      const nextIdx = idx >= 0 ? (idx + 1) % roles.length : 0;
      return roles[nextIdx];
    };

    expect(getNextRole('pm')).toBe('architect');
    expect(getNextRole('architect')).toBe('developer');
    expect(getNextRole('developer')).toBe('qa');
    expect(getNextRole('qa')).toBe('pm');

    // 2. Verify draft input preservation per agent role
    const drafts: Partial<Record<string, string>> = {};
    let activeRole = 'pm';
    let currentInput = 'Draft prompt for PM';

    // Simulate switching from PM to Architect
    drafts[activeRole] = currentInput;
    activeRole = getNextRole(activeRole);
    currentInput = drafts[activeRole] || '';
    expect(activeRole).toBe('architect');
    expect(currentInput).toBe('');

    // Architect writes a draft
    currentInput = 'Draft prompt for Architect';
    drafts[activeRole] = currentInput;

    // Cycle through Developer and QA back to PM
    activeRole = getNextRole(activeRole); // to developer
    expect(activeRole).toBe('developer');
    activeRole = getNextRole(activeRole); // to qa
    expect(activeRole).toBe('qa');
    activeRole = getNextRole(activeRole); // back to pm
    expect(activeRole).toBe('pm');
    currentInput = drafts[activeRole] || '';
    expect(currentInput).toBe('Draft prompt for PM');

    // Cycle once more to Architect and verify preserved draft
    activeRole = getNextRole(activeRole);
    expect(activeRole).toBe('architect');
    currentInput = drafts[activeRole] || '';
    expect(currentInput).toBe('Draft prompt for Architect');

    // 3. Verify i18n shortcuts hints reflect Ctrl+N for cycle and Tab for multipanel
    expect(I18N_DICTIONARY.en.bottomShortcutsHint).toContain('Ctrl+N cycle');
    expect(I18N_DICTIONARY.en.bottomShortcutsHint).toContain('Tab multipanel');
    expect(I18N_DICTIONARY.es.bottomShortcutsHint).toContain('Ctrl+N carrusel');
    expect(I18N_DICTIONARY.es.bottomShortcutsHint).toContain('Tab multipanel');
  });

  it('Issue #9: supports theme configuration in /settings (system, solarized light, solarized dark)', () => {
    // 1. Schema validation: exactly 3 themes supported with 'system' as default
    expect(SupportedThemeSchema.safeParse('system').success).toBe(true);
    expect(SupportedThemeSchema.safeParse('solarized-light').success).toBe(true);
    expect(SupportedThemeSchema.safeParse('solarized-dark').success).toBe(true);
    expect(SupportedThemeSchema.safeParse('monokai').success).toBe(false);
    expect(SupportedThemeSchema.safeParse('dracula').success).toBe(false);

    const defaultSettings = AppSettingsSchema.parse({});
    expect(defaultSettings.theme).toBe('system');

    // 2. Initial SQLite settings default to 'system'
    const initial = storage.getSettings();
    expect(initial.theme).toBe('system');

    // 3. Update theme to solarized-dark and verify persistence
    const updatedDark = storage.updateSettings({ theme: 'solarized-dark' });
    expect(updatedDark.theme).toBe('solarized-dark');
    expect(storage.getSettings().theme).toBe('solarized-dark');

    // Verify written to settings.json
    const configPath = path.join(initial.workDir, 'config', 'settings.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(parsedConfig.theme).toBe('solarized-dark');

    // 4. Update theme to solarized-light and verify persistence
    const updatedLight = storage.updateSettings({ theme: 'solarized-light' });
    expect(updatedLight.theme).toBe('solarized-light');
    expect(storage.getSettings().theme).toBe('solarized-light');

    // 5. Update back to system
    const updatedSystem = storage.updateSettings({ theme: 'system' });
    expect(updatedSystem.theme).toBe('system');
    expect(storage.getSettings().theme).toBe('system');

    // 6. Verify canonical Solarized palette values
    expect(SOLARIZED_COLORS.base03).toBe('#002b36');
    expect(SOLARIZED_COLORS.base3).toBe('#fdf6e3');
    expect(SOLARIZED_COLORS.yellow).toBe('#b58900');
    expect(SOLARIZED_COLORS.blue).toBe('#268bd2');

    // 7. Verify THEME_PALETTES structures
    expect(THEME_PALETTES.system.theme).toBe('system');
    expect(THEME_PALETTES['solarized-dark'].bg).toBe('#002b36');
    expect(THEME_PALETTES['solarized-light'].bg).toBe('#fdf6e3');

    // 8. Verify getRoleTheme adapts to active theme
    const systemArch = getRoleTheme('architect', 'system');
    const darkArch = getRoleTheme('architect', 'solarized-dark');
    const lightArch = getRoleTheme('architect', 'solarized-light');

    expect(systemArch.bgColor).toBe('blue');
    expect(darkArch.bgColor).toBe('#268bd2');
    expect(lightArch.bgColor).toBe('#268bd2');

    // 9. Verify i18n dictionary translations in en and es
    expect(I18N_DICTIONARY.en.settingThemeLabel).toBe('Visual Theme');
    expect(I18N_DICTIONARY.es.settingThemeLabel).toBe('Tema Visual');
    expect(I18N_DICTIONARY.en.themeSavedMsg('solarized-dark')).toContain('solarized-dark');
    expect(I18N_DICTIONARY.es.themeSavedMsg('solarized-light')).toContain('solarized-light');
    expect(I18N_DICTIONARY.en.themeInvalidMsg('invalid')).toContain(
      'Available: system, solarized-light, solarized-dark',
    );
    expect(I18N_DICTIONARY.es.themeInvalidMsg('invalido')).toContain(
      'Disponibles: system, solarized-light, solarized-dark',
    );

    // 10. OSC helper behaves safely in non-TTY environments
    expect(() => applyTerminalThemeOsc('solarized-dark')).not.toThrow();
    expect(() => applyTerminalThemeOsc('solarized-light')).not.toThrow();
    expect(() => applyTerminalThemeOsc('system')).not.toThrow();
  });
});
