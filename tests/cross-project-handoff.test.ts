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

    // 7. Verify Project B database and workspace remain completely untouched
    const msgsB = storage.listMessages(projectB.id);
    expect(msgsB.length).toBe(0);

    const artifactsB = storage.listArtifacts(projectB.id);
    expect(artifactsB.length).toBe(0);

    // Ensure no files leaked into Project B workspace directory
    const bFiles = fs.existsSync(path.join(wsB, 'contracts'))
      ? fs.readdirSync(path.join(wsB, 'contracts'))
      : [];
    expect(bFiles.length).toBe(0);
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
});
