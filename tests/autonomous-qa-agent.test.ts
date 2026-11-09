import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CoordinatorAuthorityError,
  PoCliDatabase,
  PoCliOrchestrator,
} from '../src/index.js';

describe('Autonomous Independent QA Agent System (Issue #90)', () => {
  let tmpDir: string;
  let storage: PoCliDatabase;
  let orchestrator: PoCliOrchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-qa-agent-test-'));
    storage = new PoCliDatabase(path.join(tmpDir, 'pocli.sqlite'));
    orchestrator = new PoCliOrchestrator(storage);
  });

  afterEach(() => {
    orchestrator.rag.stopWatchers();
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Developer autonomously writes Gherkin scenarios and hands off directly to QA ([DEV → QA])', async () => {
    const wsDir = path.join(tmpDir, 'ws-dev-handoff');
    const project = orchestrator.createProject({
      name: 'DevToQaApp',
      description: 'Test autonomous Developer -> QA handoff',
      workspaceDir: wsDir,
    });

    // Architect creates architecture & PO approves
    await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Propose formal architecture and specifications.',
    });
    orchestrator.reviewArchitectureByPo({
      projectId: project.id,
      artifactCode: 'ARCH-001',
      decision: 'APPROVED',
      comments: 'Approved v1',
    });
    orchestrator.performDeveloperHandoff(project.id);

    // Developer implements and calls write_gherkin_scenarios + submit_for_qa
    const devTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'developer',
      senderRole: 'architect',
      message: 'Implement the approved architecture and notify QA.',
    });

    // Verify Developer wrote DEV-GHERKIN-001.feature in contracts/qa/
    const devGherkinPath = path.join(wsDir, 'contracts', 'qa', 'DEV-GHERKIN-001.feature');
    expect(fs.existsSync(devGherkinPath)).toBe(true);
    const gherkinContent = fs.readFileSync(devGherkinPath, 'utf8');
    expect(gherkinContent).toContain('Feature:');
    expect(gherkinContent).toContain('Scenario:');

    // Verify phase transitioned to PHASE_6_QA_VALIDATION and autonomousHandoff targets QA
    expect(devTurn.project.phase).toBe('PHASE_6_QA_VALIDATION');
    expect(devTurn.autonomousHandoff).toBeDefined();
    expect(devTurn.autonomousHandoff?.nextRole).toBe('qa');
    expect(devTurn.autonomousHandoff?.senderRole).toBe('developer');

    // Verify [DEV → QA] message persisted in SQLite
    const qaMessages = storage.listMessages(project.id, 'qa');
    const devToQaMsg = qaMessages.find(
      (m) => m.fromRole === 'developer' && m.toRole === 'qa' && m.content.includes('[DEV → QA]'),
    );
    expect(devToQaMsg).toBeDefined();
  });

  it('2. Independent QA Agent executes 7-Phase verification in isolated scripts/ and reports Summary Table directly to Architect ([QA → ARQ])', async () => {
    const wsDir = path.join(tmpDir, 'ws-qa-isolated');
    const project = orchestrator.createProject({
      name: 'QaIsolatedApp',
      description: 'Test QA 7-Phase isolated execution and Architect table report',
      workspaceDir: wsDir,
    });

    await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Propose formal architecture and specifications.',
    });
    orchestrator.reviewArchitectureByPo({
      projectId: project.id,
      artifactCode: 'ARCH-001',
      decision: 'APPROVED',
      comments: 'Approved v1',
    });
    orchestrator.performDeveloperHandoff(project.id);

    const devTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'developer',
      senderRole: 'architect',
      message: 'Implement the approved architecture and notify QA.',
    });

    expect(devTurn.autonomousHandoff?.nextRole).toBe('qa');

    // Execute QA turn triggered by Developer
    const qaTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'qa',
      senderRole: 'developer',
      message: devTurn.autonomousHandoff!.instructions,
    });

    // Verify isolated QA workspace directories and files in scripts/ and contracts/qa/
    const qaGherkinPath = path.join(wsDir, 'contracts', 'qa', 'QA-GHERKIN-001.feature');
    expect(fs.existsSync(qaGherkinPath)).toBe(true);
    expect(fs.readFileSync(qaGherkinPath, 'utf8')).toContain('@adversarial');

    const robotSuitePath = path.join(wsDir, 'scripts', 'qa_acceptance.robot');
    expect(fs.existsSync(robotSuitePath)).toBe(true);

    const robotOutputXml = path.join(wsDir, 'scripts', 'qa-logs', 'output.xml');
    expect(fs.existsSync(robotOutputXml)).toBe(true);

    const mutationReport = path.join(wsDir, 'scripts', 'qa-mutation-report.md');
    expect(fs.existsSync(mutationReport)).toBe(true);
    expect(fs.readFileSync(mutationReport, 'utf8')).toContain('Mutation Score');

    // Verify cloned repo exists in scripts/qa-env/ and original repos/ was untouched by QA
    const qaEnvDir = path.join(wsDir, 'scripts', 'qa-env');
    expect(fs.existsSync(qaEnvDir)).toBe(true);

    // Verify QA transitioned project to PHASE_8_FINAL_ACCEPTANCE and sent Summary Table directly to Architect
    expect(qaTurn.project.phase).toBe('PHASE_8_FINAL_ACCEPTANCE');
    expect(qaTurn.autonomousHandoff).toBeDefined();
    expect(qaTurn.autonomousHandoff?.nextRole).toBe('architect');
    expect(qaTurn.autonomousHandoff?.alreadyDeliveredToArchitect).toBe(true);
    expect(qaTurn.autonomousHandoff?.instructions).toContain('[QA → ARQ]');
    expect(qaTurn.autonomousHandoff?.instructions).toContain('### 1.');
    expect(qaTurn.autonomousHandoff?.instructions).toContain('### 2.');
    expect(qaTurn.autonomousHandoff?.instructions).toContain('TC-001');
    expect(qaTurn.autonomousHandoff?.instructions).toContain('TC-MUT-001');

    // Verify [QA → ARQ] message is stored in Architect's message history
    const archMessages = storage.listMessages(project.id, 'architect');
    const qaToArchMsg = archMessages.find(
      (m) => m.fromRole === 'qa' && m.toRole === 'architect' && m.content.includes('[QA → ARQ]'),
    );
    expect(qaToArchMsg).toBeDefined();
    expect(qaToArchMsg!.content).toContain('PASS');
  });

  it('3. Enforces strict QA workspace isolation: blocks QA from writing outside scripts/ or contracts/qa/', async () => {
    const wsDir = path.join(tmpDir, 'ws-qa-security');
    const project = orchestrator.createProject({
      name: 'QaSecurityBoundary',
      description: 'Ensure QA cannot write outside scripts/ or contracts/qa/',
      workspaceDir: wsDir,
    });

    await expect(
      orchestrator.executeAgentToolCalls(project.id, 'qa', [
        {
          id: 'tc-illegal-write',
          name: 'write_qa_test_script',
          arguments: {
            path: 'repos/hack.py',
            content: 'print("illegal write to repos")',
          },
        },
      ]),
    ).rejects.toThrow(CoordinatorAuthorityError);

    await expect(
      orchestrator.executeAgentToolCalls(project.id, 'qa', [
        {
          id: 'tc-illegal-gherkin',
          name: 'write_qa_gherkin',
          arguments: {
            path: 'docs/architecture/hack.feature',
            content: 'Feature: Illegal path',
          },
        },
      ]),
    ).rejects.toThrow(CoordinatorAuthorityError);
  });

  it('4. Bidirectional Developer <-> QA Correction Loop: QA FAIL triggers Developer fix and re-verification until PASS', async () => {
    const wsDir = path.join(tmpDir, 'ws-qa-dev-loop');
    const project = orchestrator.createProject({
      name: 'BidirectionalLoopApp',
      description: 'Test QA FAIL -> Developer Correction -> QA PASS -> Architect',
      workspaceDir: wsDir,
    });

    await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Propose formal architecture and specifications.',
    });
    orchestrator.reviewArchitectureByPo({
      projectId: project.id,
      artifactCode: 'ARCH-001',
      decision: 'APPROVED',
      comments: 'Approved v1',
    });
    orchestrator.performDeveloperHandoff(project.id);

    // Developer introduces a deliberate failure on first pass
    const devTurn1 = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'developer',
      senderRole: 'architect',
      message: 'Implement the module with FORCE_TEST_FAILURE for initial QA adversarial catch.',
    });
    expect(devTurn1.project.phase).toBe('PHASE_6_QA_VALIDATION');

    // QA runs 7-Phase verification and detects the failure
    const qaTurn1 = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'qa',
      senderRole: 'developer',
      message: devTurn1.autonomousHandoff!.instructions,
    });

    // Verify QA transitioned project to PHASE_7_CORRECTION_CYCLE and routed back to Developer ([QA → DEV])
    expect(qaTurn1.project.phase).toBe('PHASE_7_CORRECTION_CYCLE');
    expect(qaTurn1.project.correctionCycleCount).toBe(1);
    expect(qaTurn1.autonomousHandoff).toBeDefined();
    expect(qaTurn1.autonomousHandoff?.nextRole).toBe('developer');
    expect(qaTurn1.autonomousHandoff?.senderRole).toBe('qa');
    expect(qaTurn1.autonomousHandoff?.instructions).toContain('[QA → DEV]');

    // Verify QA generated regression Gherkin contract REG-GHERKIN-001.feature
    const regGherkinPath = path.join(wsDir, 'contracts', 'qa', 'REG-GHERKIN-001.feature');
    expect(fs.existsSync(regGherkinPath)).toBe(true);
    expect(fs.readFileSync(regGherkinPath, 'utf8')).toContain('@regression');

    // Developer receives [QA → DEV] defect report, fixes the issue, and re-submits to QA ([DEV → QA])
    const devTurn2 = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'developer',
      senderRole: 'qa',
      message: 'Apply fix for DEF-001 and resubmit to QA.',
    });
    expect(devTurn2.project.phase).toBe('PHASE_6_QA_VALIDATION');
    expect(devTurn2.autonomousHandoff?.nextRole).toBe('qa');

    // QA re-runs verification and now passes, reporting directly to Architect ([QA → ARQ])
    const qaTurn2 = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'qa',
      senderRole: 'developer',
      message: devTurn2.autonomousHandoff!.instructions,
    });
    expect(qaTurn2.project.phase).toBe('PHASE_8_FINAL_ACCEPTANCE');
    expect(qaTurn2.autonomousHandoff?.nextRole).toBe('architect');
    expect(qaTurn2.autonomousHandoff?.alreadyDeliveredToArchitect).toBe(true);
    expect(qaTurn2.autonomousHandoff?.instructions).toContain('[QA → ARQ]');
    expect(qaTurn2.autonomousHandoff?.instructions).toContain('PASS');
  });

  it('5. End-to-End executeAutonomousWorkflowChain runs Architect -> Developer -> QA -> Architect seamlessly', async () => {
    const wsDir = path.join(tmpDir, 'ws-full-chain');
    const project = orchestrator.createProject({
      name: 'FullChainApp',
      description: 'End-to-end autonomous chain test',
      workspaceDir: wsDir,
    });

    await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Design and propose the formal architecture and requirements.',
    });

    // Execute full autonomous chain (Architect -> Developer -> QA -> Architect Summary Table)
    const chainResult = await orchestrator.executeAutonomousWorkflowChain({
      projectId: project.id,
      initialRole: 'architect',
      initialMessage: 'Procede con la arquitectura propuesta y delega al desarrollador.',
    });

    expect(chainResult.turnsExecuted.map((t) => t.role)).toEqual([
      'architect',
      'developer',
      'qa',
    ]);
    expect(chainResult.finalProject.phase).toBe('PHASE_8_FINAL_ACCEPTANCE');

    const archMessages = storage.listMessages(project.id, 'architect');
    const qaSummaryMsg = archMessages.find(
      (m) => m.fromRole === 'qa' && m.toRole === 'architect' && m.content.includes('[QA → ARQ]'),
    );
    expect(qaSummaryMsg).toBeDefined();
  });
});
