import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PoCliDatabase,
  PoCliOrchestrator,
  Project,
} from '../src/index.js';
import {
  HarnessRegistry,
  buildRoleToolsInstruction,
} from '../src/runtime/harnesses.js';

describe('Feature #66 — Cross-Project Task and Autonomous Handoff Isolation', () => {
  let tmpDir: string;
  let storage: PoCliDatabase;
  let orchestrator: PoCliOrchestrator;
  let projectA: Project;
  let projectB: Project;
  let wsA: string;
  let wsB: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-crossproj-'));
    storage = new PoCliDatabase(path.join(tmpDir, 'pocli.sqlite'));
    orchestrator = new PoCliOrchestrator(storage);

    wsA = path.join(tmpDir, 'ws-project-a');
    wsB = path.join(tmpDir, 'ws-project-b');

    projectA = orchestrator.createProject({
      name: 'Project-A',
      description: 'First project workspace',
      workspaceDir: wsA,
    });

    projectB = orchestrator.createProject({
      name: 'Project-B',
      description: 'Second project workspace',
      workspaceDir: wsB,
    });
  });

  afterEach(() => {
    orchestrator.rag.stopWatchers();
    orchestrator.runtime.stopAllWorkers();
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. isRoleBusy isolates busy status strictly per (projectId, role)', async () => {
    expect(orchestrator.isRoleBusy(projectA.id, 'architect')).toBe(false);
    expect(orchestrator.isRoleBusy(projectB.id, 'architect')).toBe(false);

    // Start a chat turn in Project A without awaiting immediately
    const turnPromiseA = orchestrator.chatWithProfessional({
      projectId: projectA.id,
      targetRole: 'architect',
      message: 'Analyze requirements for Project A',
    });

    // Verify Project A is busy, but Project B is NOT busy
    expect(orchestrator.isRoleBusy(projectA.id, 'architect')).toBe(true);
    expect(orchestrator.isRoleBusy(projectB.id, 'architect')).toBe(false);

    await turnPromiseA;

    expect(orchestrator.isRoleBusy(projectA.id, 'architect')).toBe(false);
    expect(orchestrator.isRoleBusy(projectB.id, 'architect')).toBe(false);
  });

  it('2. Autonomous handoff executes strictly within the origin project even when active project is switched', async () => {
    // 1. Architect creates architecture contracts in Project A
    await orchestrator.chatWithProfessional({
      projectId: projectA.id,
      targetRole: 'architect',
      message: 'Design and propose the formal architecture and requirements for the system.',
    });

    // 2. PO approves architecture in Project A
    orchestrator.reviewArchitectureByPo({
      projectId: projectA.id,
      artifactCode: 'ARCH-001',
      decision: 'APPROVED',
      comments: 'Approved v1 by Product Owner',
    });

    // 3. Perform Handoff to Developer for Project A
    const handoff = orchestrator.performDeveloperHandoff(projectA.id);
    expect(handoff.approvedArchitectureVersion).toBe(1);

    // 4. While Developer implementation is queued/dispatched, switch active project in storage to Project B
    storage.switchActiveProject(projectB.id);
    expect(storage.getActiveProject()?.id).toBe(projectB.id);

    // 5. Dispatch Developer implementation with bound Project A ID
    const devTurnResult = await orchestrator.chatWithProfessional({
      projectId: projectA.id,
      targetRole: 'developer',
      message: 'Implement the authorized architecture contracts for Project A',
    });

    expect(devTurnResult).toBeDefined();
    expect(devTurnResult.project.id).toBe(projectA.id);

    // 6. Verify Project A database contains all developer messages and artifacts
    const msgsA = storage.listMessages(projectA.id);
    expect(msgsA.some((m) => m.fromRole === 'developer')).toBe(true);
    expect(msgsA.some((m) => m.fromRole === 'architect' && m.toRole === 'developer')).toBe(true);
    expect(msgsA.some((m) => m.content.includes('Normative Developer Handoff Bundle'))).toBe(true);

    const artifactsA = storage.listArtifacts(projectA.id);
    expect(artifactsA.some((a) => a.code === 'ARCH-001')).toBe(true);
    expect(artifactsA.some((a) => a.code === 'SPEC-001')).toBe(true);
    expect(artifactsA.some((a) => a.code === 'IMP-001')).toBe(true);

    // Verify simplified contracts directory structure
    expect(fs.existsSync(path.join(wsA, 'contracts', 'architecture', 'ARCH-001_v1.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsA, 'contracts', 'specification', 'SPEC-001_v1.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsA, 'contracts', 'implementation', 'IMP-001_v1.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsA, 'contracts', 'adr'))).toBe(false);
    expect(fs.existsSync(path.join(wsA, 'contracts', 'requirement'))).toBe(false);

    // 7. Verify Project B database and workspace remain completely untouched
    const msgsB = storage.listMessages(projectB.id);
    expect(msgsB.length).toBe(0);

    const artifactsB = storage.listArtifacts(projectB.id);
    expect(artifactsB.length).toBe(0);

    // Ensure no artifact files leaked into Project B workspace directory
    expect(fs.readdirSync(path.join(wsB, 'contracts', 'architecture'))).toHaveLength(0);
    expect(fs.readdirSync(path.join(wsB, 'contracts', 'specification'))).toHaveLength(0);
    expect(fs.readdirSync(path.join(wsB, 'contracts', 'implementation'))).toHaveLength(0);
  });

  it('3. Message queuing remains isolated between projects under concurrent load', async () => {
    // Dispatch multiple turns to both projects concurrently
    const [resA, resB] = await Promise.all([
      orchestrator.chatWithProfessional({
        projectId: projectA.id,
        targetRole: 'architect',
        message: 'Message 1 for Project A',
      }),
      orchestrator.chatWithProfessional({
        projectId: projectB.id,
        targetRole: 'architect',
        message: 'Message 1 for Project B',
      }),
    ]);

    expect(resA.project.id).toBe(projectA.id);
    expect(resB.project.id).toBe(projectB.id);

    const msgsA = storage.listMessages(projectA.id);
    const msgsB = storage.listMessages(projectB.id);

    expect(msgsA.some((m) => m.content.includes('Message 1 for Project A'))).toBe(true);
    expect(msgsA.some((m) => m.content.includes('Message 1 for Project B'))).toBe(false);

    expect(msgsB.some((m) => m.content.includes('Message 1 for Project B'))).toBe(true);
    expect(msgsB.some((m) => m.content.includes('Message 1 for Project A'))).toBe(false);
  });

  it('4. Issue #72 — attributes autonomous handoff interactions to Architect (ARQ) instead of Product Owner (PO)', async () => {
    // 1. PO chats 2 times with the Architect in Project A
    await orchestrator.chatWithProfessional({
      projectId: projectA.id,
      targetRole: 'architect',
      message: 'Hello Architect, please define the architecture for our project.',
    });
    await orchestrator.chatWithProfessional({
      projectId: projectA.id,
      targetRole: 'architect',
      message: 'I agree with the architecture. Please proceed with handoff to Developer.',
    });

    // PO approves architecture
    orchestrator.reviewArchitectureByPo({
      projectId: projectA.id,
      artifactCode: 'ARCH-001',
      decision: 'APPROVED',
      comments: 'PO approves ARCH-001',
    });

    // 2. Perform official handoff from Architect to Developer with instructions
    const handoff = orchestrator.performDeveloperHandoff(
      projectA.id,
      'Implement the backend module per SPEC-001.',
    );
    expect(handoff.handoffMessageId).toBeDefined();

    // 3. Developer executes the turn with senderRole: 'architect' and alreadyRecorded: true
    await orchestrator.chatWithProfessional({
      projectId: projectA.id,
      targetRole: 'developer',
      message: 'Implement the backend module per SPEC-001.',
      messageId: handoff.handoffMessageId,
      alreadyRecorded: true,
      senderRole: 'architect',
    });

    // 4. Verify Architect interactions
    const arqSummary = storage.getExpertChatSummary(projectA.id, 'architect');
    expect(arqSummary.interactions.po).toBe(2);
    expect(arqSummary.interactions.developer).toBe(2);

    // 5. Verify Developer interactions (Issue #72 fix)
    const devSummary = storage.getExpertChatSummary(projectA.id, 'developer');
    expect(devSummary.interactions.po).toBe(0); // PO has not spoken to Developer
    expect(devSummary.interactions.architect).toBe(2); // Exchanged handoff and completion report

    // 6. Verify SQLite message attribution
    const devMsgs = storage.listMessages(projectA.id, 'developer');
    expect(devMsgs.some((m) => m.fromRole === 'product_owner')).toBe(false);
    expect(devMsgs.some((m) => m.fromRole === 'architect' && m.toRole === 'developer')).toBe(true);
    expect(devMsgs.some((m) => m.fromRole === 'developer' && m.toRole === 'architect')).toBe(true);
  });

  it('5. Issue #74 — Developer mandatory unit test creation, execution, coverage and Architect report', async () => {
    const projectDir = path.join(tmpDir, 'ws-issue-74');
    fs.mkdirSync(projectDir, { recursive: true });

    const project = orchestrator.createProject({
      name: 'unit-test-verification-proj',
      description: 'Unit test verification project',
      workspaceDir: projectDir,
    });

    // 1. Verify Developer harness tools and instructions
    const devHarness = HarnessRegistry.getHarness('developer');
    expect(devHarness.allowedTools).toContain('run_unit_tests');
    expect(devHarness.allowedTools).toContain('run_tests');
    expect(devHarness.systemPrompt).toContain('MANDATORY UNIT TESTING');
    expect(devHarness.systemPrompt).toContain('ARCHITECT REPORTING PROTOCOL');

    const devToolInstructions = buildRoleToolsInstruction('developer');
    expect(devToolInstructions).toContain('run_unit_tests');
    expect(devToolInstructions).toContain('Mandatory Unit Testing');
    expect(devToolInstructions).toContain('Definition of Done');

    // 2. Setup Architect contracts and handoff
    await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'architect',
      message: 'Design system architecture for unit-test-verification-proj',
    });

    orchestrator.reviewArchitectureByPo({
      projectId: project.id,
      artifactCode: 'ARCH-001',
      decision: 'APPROVED',
      comments: 'PO approves ARCH-001',
    });

    const handoff = orchestrator.performDeveloperHandoff(
      project.id,
      'Implement features per SPEC-001 and ARCH-001. Unit tests and coverage are mandatory.',
    );

    // 3. Developer executes implementation turn with senderRole: 'architect'
    const devTurn = await orchestrator.chatWithProfessional({
      projectId: project.id,
      targetRole: 'developer',
      message: 'Implement features per SPEC-001 and ARCH-001. Unit tests and coverage are mandatory.',
      messageId: handoff.handoffMessageId,
      alreadyRecorded: true,
      senderRole: 'architect',
    });

    // 4. Verify Developer reply text reports to Architect
    expect(devTurn.reply).toContain('Reporting back to the Software Architect');
    expect(devTurn.reply).toContain('Unit Tests Executed');
    expect(devTurn.reply).toContain('Test Coverage');

    // 5. Verify created artifacts include source code, unit tests, execution report, and IMP-001
    const artifacts = storage.listArtifacts(project.id);
    const codeArt = artifacts.find((a) => a.code === 'CODE-001');
    const testArt = artifacts.find((a) => a.code === 'TEST-001');
    const testExecArt = artifacts.find((a) => a.code === 'TEST-EXEC-001');
    const impArt = artifacts.find((a) => a.code === 'IMP-001');

    expect(codeArt).toBeDefined();
    expect(testArt).toBeDefined();
    expect(testExecArt).toBeDefined();
    expect(impArt).toBeDefined();

    // Verify source and test files on disk under repos/<project>.git/
    const defaultRepo = `${project.name}.git`;
    const repoSrc = path.join(projectDir, 'repos', defaultRepo, 'src', 'app-module.js');
    const repoTest = path.join(projectDir, 'repos', defaultRepo, 'tests', 'app-module.test.js');
    expect(fs.existsSync(repoSrc)).toBe(true);
    expect(fs.existsSync(repoTest)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'repos', defaultRepo, '.git'))).toBe(true);

    // Verify unit test execution artifact
    expect(testExecArt!.content).toContain('TEST-EXEC-001');
    expect(testExecArt!.content).toContain('PASSED (100% green)');
    expect(testExecArt!.content).toContain('Coverage');

    // Verify IMP-001 content
    expect(impArt!.content).toContain('Mandatory Unit Testing & Execution');
    expect(impArt!.content).toContain('100% green');
    expect(impArt!.content).toContain('100% statement and branch coverage');

    // 6. Verify messages in SQLite: Developer implementation in dev chat, concise summary to Architect
    const devMessages = storage.listMessages(project.id, 'developer');
    const fullDevMsg = devMessages.find(
      (m) => m.fromRole === 'developer' && m.toRole === 'product_owner',
    );
    expect(fullDevMsg).toBeDefined();
    expect(fullDevMsg!.content).toContain('Reporting back to the Software Architect');

    const summaryMsg = devMessages.find(
      (m) => m.fromRole === 'developer' && m.toRole === 'architect',
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toContain('SPEC-001');
    expect(summaryMsg!.content).toContain('Coverage');

    // 7. Verify Architect chat receives ONLY the concise summary, not the full dev implementation
    const archMessages = storage.listMessages(project.id, 'architect');
    const archDevMsg = archMessages.find((m) => m.fromRole === 'developer');
    expect(archDevMsg).toBeDefined();
    expect(archDevMsg!.id).toBe(summaryMsg!.id);
    expect(archDevMsg!.content).not.toContain(codeArt!.content);
  });

  it('Issue #76 — init_repository tool and automatic git init in repos', async () => {
    const ws = path.join(tmpDir, 'ws-git-test');
    const proj = orchestrator.createProject({
      name: 'Git-Service',
      description: 'Git test service',
      workspaceDir: ws,
    });

    // 1. Explicitly execute init_repository tool
    await (orchestrator as any).executeAgentToolCalls(
      proj.id,
      'developer',
      [{ name: 'init_repository', arguments: { repoName: 'custom-subservice.git' } }],
    );

    const customGitDir = path.join(ws, 'repos', 'custom-subservice.git', '.git');
    expect(fs.existsSync(customGitDir)).toBe(true);
    expect(storage.getProject(proj.id)!.repositories).toContain('custom-subservice.git');

    // 2. Implicit git init on write_source_file
    storage.saveArtifact({
      projectId: proj.id,
      code: 'CODE-001',
      type: 'SOURCE_CODE',
      title: 'Source Code',
      content: 'print("hello")',
      authorRole: 'developer',
      customRelPath: 'repos/auto-init.git/src/main.py',
    });

    const autoGitDir = path.join(ws, 'repos', 'auto-init.git', '.git');
    expect(fs.existsSync(autoGitDir)).toBe(true);
    expect(storage.getProject(proj.id)!.repositories).toContain('auto-init.git');
  });

  it('Issue #82 — formatDeveloperCompletionSummaryForArchitect extracts metrics and squares table', () => {
    const ws = path.join(tmpDir, 'ws-issue-82');
    fs.mkdirSync(path.join(ws, 'outputs'), { recursive: true });

    const proj = orchestrator.createProject({
      name: 'Summary-Service',
      description: 'Summary test service',
      workspaceDir: ws,
    });

    // Write unit_test_execution.md
    fs.writeFileSync(
      path.join(ws, 'outputs', 'unit_test_execution.md'),
      '# TEST-EXEC-001\n\n- **Status**: PASSED (100% green)\n- **Coverage**: 94%\n\n25 passed in 0.3s\n',
    );

    const summaryEs = orchestrator.formatDeveloperCompletionSummaryForArchitect({
      projectId: proj.id,
      developerReply: 'Se han ejecutado 25 passed con 94% de cobertura.',
      workspaceDir: ws,
      language: 'es',
    });

    expect(summaryEs).toContain('Especificación técnica completada: `SPEC-001`.');
    expect(summaryEs).toContain('Tests Ejecutados');
    expect(summaryEs).toContain('25 passed');
    expect(summaryEs).toContain('94%');
    expect(summaryEs).toContain('Implementación completada y verificada');

    const summaryEn = orchestrator.formatDeveloperCompletionSummaryForArchitect({
      projectId: proj.id,
      developerReply: 'Completed 25 passed tests with 94% coverage.',
      workspaceDir: ws,
      language: 'en',
    });

    expect(summaryEn).toContain('Technical specification completed: `SPEC-001`.');
    expect(summaryEn).toContain('Tests Executed');
    expect(summaryEn).toContain('25 passed');
    expect(summaryEn).toContain('94%');
    expect(summaryEn).toContain('Implementation completed and verified');
  });
});
