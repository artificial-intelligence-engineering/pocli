import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PoCliDatabase,
  PoCliOrchestrator,
  Project,
} from '../src/index.js';

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
    expect(arqSummary.interactions.developer).toBe(1);

    // 5. Verify Developer interactions (Issue #72 fix)
    const devSummary = storage.getExpertChatSummary(projectA.id, 'developer');
    expect(devSummary.interactions.po).toBe(0); // PO has not spoken to Developer
    expect(devSummary.interactions.architect).toBe(1); // Architect initiated handoff to Developer

    // 6. Verify SQLite message attribution
    const devMsgs = storage.listMessages(projectA.id, 'developer');
    expect(devMsgs.some((m) => m.fromRole === 'product_owner')).toBe(false);
    expect(devMsgs.some((m) => m.fromRole === 'architect' && m.toRole === 'developer')).toBe(true);
  });
});
