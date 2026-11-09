import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PoCliDatabase } from '../src/storage/database.js';
import { PoCliOrchestrator } from '../src/runtime/orchestrator.js';
import { HeadlessCliRunner } from '../src/runtime/headless-runner.js';

describe('PM Agent: Project Status Report in deliveries/ (100% HTML)', () => {
  let tmpDir: string;
  let storage: PoCliDatabase;
  let orchestrator: PoCliOrchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-pm-report-test-'));
    const dbPath = path.join(tmpDir, 'pocli.sqlite');
    storage = new PoCliDatabase(dbPath);
    orchestrator = new PoCliOrchestrator(storage);
  });

  afterEach(async () => {
    try {
      orchestrator.rag.stopWatchers();
    } catch {}
    try {
      await orchestrator.stopAllWorkers();
    } catch {}
    try {
      storage.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('detects when project is UNDER CONSTRUCTION and renders the warning banner, active phase, and metrics', async () => {
    const wsDir = path.join(tmpDir, 'ws-under-construction');
    const project = orchestrator.createProject({
      name: 'InProgressApp',
      description: 'App actively under construction',
      workspaceDir: wsDir,
    });

    // Simulate active construction in PHASE_5_DEV_IMPLEMENTATION
    storage.db.prepare('UPDATE projects SET phase = ? WHERE id = ?').run('PHASE_5_DEV_IMPLEMENTATION', project.id);

    // Record inter-agent interactions
    storage.recordMessage({
      projectId: project.id,
      fromRole: 'product_owner',
      toRole: 'architect',
      content: 'I need a secure payment service',
    });
    storage.recordMessage({
      projectId: project.id,
      fromRole: 'architect',
      toRole: 'developer',
      content: 'Handoff: implement payment service per SPEC-001',
    });
    storage.recordMessage({
      projectId: project.id,
      fromRole: 'developer',
      toRole: 'qa',
      content: 'Implementation done, ready for verification',
    });

    // Save ARCH-001, SPEC-001, IMP-001, DEV-GHERKIN-001
    await orchestrator.coordinator.saveArtifact({
      projectId: project.id,
      role: 'architect',
      code: 'ARCH-001',
      type: 'ARCHITECTURE',
      title: 'Payment Gateway Reference Architecture',
      content: '# ARCH-001: Payment Gateway\nMicroservice design for payment processing.\n',
    });

    await orchestrator.coordinator.saveArtifact({
      projectId: project.id,
      role: 'architect',
      code: 'SPEC-001',
      type: 'SPECIFICATION',
      title: 'Payment API Specification',
      content: '# SPEC-001: Technical Specification\nEndpoints: /charge, /refund.\n',
    });

    await orchestrator.coordinator.saveArtifact({
      projectId: project.id,
      role: 'developer',
      code: 'IMP-001',
      type: 'IMPLEMENTATION',
      title: 'Developer Implementation Log',
      content: '# IMP-001: Payment Service Implementation\nCreated payment modules and tests.\n',
    });

    // Developer executes unit tests (100% green)
    const unitTestContent = [
      '# TEST-EXEC-001: Unit Test Execution & Coverage Report',
      '',
      '## 1. Execution Summary',
      '- **Status**: PASSED (100% green)',
      '- **Command**: `npm test`',
      '- **Working Directory**: `repos/payment-service.git`',
      '- **Coverage**: 100% (Line & Branch)',
      '- **Executed At**: ' + new Date().toISOString(),
      '',
      '## 2. Test Execution Output',
      '```',
      'All 8 unit tests passed successfully.',
      '```',
    ].join('\n');

    await orchestrator.coordinator.saveArtifact({
      projectId: project.id,
      role: 'developer',
      code: 'TEST-EXEC-001',
      type: 'OBSERVATION',
      title: 'Unit Test Execution Report',
      content: unitTestContent,
      customRelPath: 'outputs/unit_test_execution.md',
    });

    // Developer Gherkin scenarios
    await orchestrator.coordinator.saveArtifact({
      projectId: project.id,
      role: 'developer',
      code: 'DEV-GHERKIN-001',
      type: 'TEST_CASE',
      title: 'Developer Payment Gherkin Scenarios',
      content: [
        'Feature: Payment Processing',
        '  Scenario: Successful Credit Card Charge',
        '    Given valid credit card details',
        '    When the charge endpoint is invoked',
        '    Then a successful receipt is returned',
      ].join('\n'),
      customRelPath: 'contracts/qa/DEV-GHERKIN-001.feature',
    });

    // Generate PM HTML report
    const rep = await orchestrator.generateProjectHtmlReport(project.id);

    expect(rep.isUnderConstruction).toBe(true);
    expect(fs.existsSync(rep.reportPath)).toBe(true);
    expect(rep.reportPath).toContain(path.join('deliveries', 'project-status-report.html'));
    expect(rep.artifact.type).toBe('PM_REPORT');
    expect(rep.artifact.code).toBe('PM-001');

    const html = fs.readFileSync(rep.reportPath, 'utf8');

    // 1. Verify prominent construction banner
    expect(html).toContain('PROYECTO EN CONSTRUCCIÓN / EN PROGRESO');
    expect(html).toContain('banner-construction');
    expect(html).toContain('Fase 5: Implementación de Código y Pruebas Unitarias');

    // 2. Verify Developer Unit Tests (100% green)
    expect(html).toContain('PASSED (100% green)');
    expect(html).toContain('$ npm test');
    expect(html).toContain('outputs/unit_test_execution.md');

    // 3. Verify Architectures and Specifications
    expect(html).toContain('ARCH-001');
    expect(html).toContain('SPEC-001');
    expect(html).toContain('IMP-001');
    expect(html).toContain('DEV-GHERKIN-001');

    // 4. Verify Inter-agent interaction matrix
    expect(html).toContain('Matriz de Interacción Entre Agentes');
    expect(html).toContain('product_owner');
    expect(html).toContain('architect');
    expect(html).toContain('developer');
    expect(html).toContain('qa');

    // 5. Verify system prompts were mirrored and linked
    const promptsDir = path.join(wsDir, 'deliveries', 'system-prompts');
    expect(fs.existsSync(promptsDir)).toBe(true);
    expect(fs.existsSync(path.join(promptsDir, 'architect.md'))).toBe(true);
    expect(fs.existsSync(path.join(promptsDir, 'developer.md'))).toBe(true);
    expect(fs.existsSync(path.join(promptsDir, 'qa.md'))).toBe(true);
    expect(fs.existsSync(path.join(promptsDir, 'pm.md'))).toBe(true);
    expect(html).toContain('system-prompts/architect.md');
    expect(html).toContain('system-prompts/developer.md');
    expect(html).toContain('system-prompts/qa.md');
    expect(html).toContain('system-prompts/pm.md');
  });

  it('detects when project is COMPLETED and includes Robot Framework HTML links and QA verification metrics', async () => {
    const wsDir = path.join(tmpDir, 'ws-completed');
    const project = orchestrator.createProject({
      name: 'CompletedApiServer',
      description: 'API Server fully implemented and verified',
      workspaceDir: wsDir,
    });

    // Set phase to PHASE_6_QA_VALIDATION so recordQaReport can transition
    storage.db.prepare('UPDATE projects SET phase = ? WHERE id = ?').run('PHASE_6_QA_VALIDATION', project.id);

    // Create fake Robot Framework files in scripts/qa-logs/
    const qaLogsDir = path.join(wsDir, 'scripts', 'qa-logs');
    fs.mkdirSync(qaLogsDir, { recursive: true });
    fs.writeFileSync(path.join(qaLogsDir, 'log.html'), '<html><body>Robot Framework Log</body></html>', 'utf8');
    fs.writeFileSync(path.join(qaLogsDir, 'report.html'), '<html><body>Robot Framework Report</body></html>', 'utf8');
    fs.writeFileSync(path.join(qaLogsDir, 'output.xml'), '<robot generator="Robot 7.0"></robot>', 'utf8');

    // Register QA Report in SQLite
    storage.recordQaReport({
      projectId: project.id,
      authorRole: 'qa',
      reportCode: 'QA-001',
      tracesTo: ['SPEC-001'],
      payload: {
        recommendation: 'ACCEPT',
        summary: 'All endpoints verified via Robot Framework. Zero regressions.',
        verdict: 'PASS',
        isolatedEnvPath: 'scripts/qa-env/api-server',
        metrics: {
          totalTests: 12,
          passedCount: 12,
          failedCount: 0,
          skippedCount: 0,
          mutationScore: 100,
          requirementCoverage: 100,
          testCoverage: 100,
        },
        testExecutions: [
          { id: 'TC-001', suite: 'crud', title: 'Create Resource', gherkinRef: 'QA-GHERKIN-001', status: 'PASS', durationMs: 15 },
          { id: 'TC-002', suite: 'crud', title: 'Read Resource', gherkinRef: 'QA-GHERKIN-001', status: 'PASS', durationMs: 8 },
          { id: 'TC-003', suite: 'crud', title: 'Delete Resource', gherkinRef: 'QA-GHERKIN-001', status: 'PASS', durationMs: 10 },
        ],
        executedTests: [
          'TC-001: Create Resource',
          'TC-002: Read Resource',
          'TC-003: Delete Resource',
        ],
        passedTests: [
          'TC-001: Create Resource',
          'TC-002: Read Resource',
          'TC-003: Delete Resource',
        ],
        failedTests: [],
        evidences: ['scripts/qa-logs/log.html', 'scripts/qa-logs/report.html'],
        unmetCriteria: [],
        defects: [],
      },
    });

    // Mark project as fully completed
    storage.db.prepare('UPDATE projects SET phase = ? WHERE id = ?').run('COMPLETED', project.id);

    // Generate PM HTML report
    const rep = await orchestrator.generateProjectHtmlReport(project.id);

    expect(rep.isUnderConstruction).toBe(false);
    expect(fs.existsSync(rep.reportPath)).toBe(true);

    const html = fs.readFileSync(rep.reportPath, 'utf8');

    // 1. Verify Completed banner
    expect(html).toContain('PROYECTO FINALIZADO / VERIFICADO Y ACEPTADO');
    expect(html).toContain('banner-completed');

    // 2. Verify Robot Framework HTML links
    expect(html).toContain('log.html');
    expect(html).toContain('report.html');
    expect(html).toContain('output.xml');
    expect(html).toContain('../scripts/qa-logs/log.html');
    expect(html).toContain('../scripts/qa-logs/report.html');
    expect(html).toContain('../scripts/qa-logs/output.xml');

    // 3. Verify QA Test executions table
    expect(html).toContain('TC-001');
    expect(html).toContain('Create Resource');
    expect(html).toContain('12/12 tests OK');
    expect(html).toContain('Mutación Adversarial');
    expect(html).toContain('100%');
  });

  it('PM Agent generates report in deliveries/ when requested by Product Owner in chat', async () => {
    const wsDir = path.join(tmpDir, 'ws-pm-chat');
    const project = orchestrator.createProject({
      name: 'ChatRequestedReportApp',
      description: 'Project where PO requests PM report via chat',
      workspaceDir: wsDir,
    });

    const turnRes = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'pm',
      message: 'Hola PM, por favor dame un informe completo del proyecto',
    });

    expect(turnRes.reply).toContain('deliveries/project-status-report.html');

    // Check artifact was saved in deliveries/
    const reportPath = path.join(wsDir, 'deliveries', 'project-status-report.html');
    expect(fs.existsSync(reportPath)).toBe(true);

    const html = fs.readFileSync(reportPath, 'utf8');
    expect(html).toContain('PO CLI');
    expect(html).toContain('Project Status Report');
    expect(html).toContain('ChatRequestedReportApp');
  });

  it('Headless CLI runner executes /report command and outputs report details', async () => {
    const wsDir = path.join(tmpDir, 'ws-headless-report');
    const project = orchestrator.createProject({
      name: 'HeadlessReportApp',
      description: 'Project to test /report slash command',
      workspaceDir: wsDir,
    });

    const runner = new HeadlessCliRunner(orchestrator);

    const res = await runner.executeCommand({
      projectName: project.name,
      commandOrPrompt: '/report',
    });

    expect(res.ok).toBe(true);
    expect(res.action).toBe('pm:report');
    expect(res.outputText).toContain('deliveries/project-status-report.html');

    const expectedReportFile = path.join(wsDir, 'deliveries', 'project-status-report.html');
    expect(fs.existsSync(expectedReportFile)).toBe(true);
  });
});
