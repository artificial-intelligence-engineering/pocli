import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ActorRole,
  Artifact,
  CoordinatorAuthorityError,
  InterAgentMessage,
  PoCliCoordinator,
  PoCliDatabase,
  PoCliOrchestrator,
  StaleArtifactVersionError,
} from '../src/index.js';

describe('Issue #10 — Persistent Concurrent Agent Runtime with Autonomous Inter-Agent Communication', () => {
  let tmpDir: string;
  let dbPath: string;
  let workspaceDir: string;
  let storage: PoCliDatabase;
  let orchestrator: PoCliOrchestrator;
  let projectId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-issue10-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    workspaceDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });

    storage = new PoCliDatabase(dbPath);
    orchestrator = new PoCliOrchestrator(storage);

    const project = orchestrator.createProject({
      name: 'Test Persistent Project',
      description: 'Validation project for persistent agent runtime',
      workspaceDir,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    try {
      await orchestrator.stopAllWorkers();
    } catch {
      // ignore
    }
    try {
      storage.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('1. Worker Reuse: keeps worker alive across multiple turns instead of spawning anew', async () => {
    // First turn to Lead Architect
    const res1 = await orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'architect',
      message: 'Propose initial microservices architecture for user authentication.',
    });
    expect(res1.workerPid).toBeGreaterThan(0);
    expect(res1.reply).toBeTruthy();

    const initialPid = res1.workerPid;

    // Second turn to Lead Architect
    const res2 = await orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'architect',
      message: 'Explain trade-offs between JWT vs session cookies in this proposal.',
    });

    // In a persistent concurrent runtime, the exact same worker PID is retained across turns!
    expect(res2.workerPid).toBe(initialPid);

    // Verify worker status inspection
    const status = orchestrator.getWorkerStatus(projectId, 'architect');
    expect(status).toBeDefined();
    expect(status?.workerPid).toBe(initialPid);
    expect(status?.status).toBe('idle');
    expect(status?.turnsCompleted).toBe(2);
  });

  it('2. Concurrent Execution: allows independent agents to execute turns in parallel', async () => {
    // Run turns for Developer and QA concurrently
    const [devTurn, qaTurn] = await Promise.all([
      orchestrator.chatWithProfessional({
        projectId,
        targetRole: 'developer',
        message: 'Prepare boilerplate setup for the persistence layer.',
      }),
      orchestrator.chatWithProfessional({
        projectId,
        targetRole: 'qa',
        message: 'Prepare test matrix for authentication scenarios.',
      }),
    ]);

    expect(devTurn.workerPid).toBeGreaterThan(0);
    expect(qaTurn.workerPid).toBeGreaterThan(0);
    // Developer and QA run in separate concurrent worker processes
    expect(devTurn.workerPid).not.toBe(qaTurn.workerPid);

    const workers = orchestrator.listWorkers(projectId);
    expect(workers.length).toBeGreaterThanOrEqual(2);
    const roles = workers.map((w) => w.role);
    expect(roles).toContain('developer');
    expect(roles).toContain('qa');
  });

  it('3. Autonomous Inter-Agent Communication: agents exchange structured updates, blockers & handoffs', async () => {
    // Advance project to Implementation phase so Developer <-> QA communication is authorized
    orchestrator.coordinator.transitionPhase({
      projectId,
      role: 'product_owner',
      targetPhase: 'PHASE_3_ARCHITECTURE_APPROVAL',
    });
    orchestrator.coordinator.transitionPhase({
      projectId,
      role: 'product_owner',
      targetPhase: 'PHASE_4_DEVELOPER_HANDOFF',
    });
    orchestrator.coordinator.transitionPhase({
      projectId,
      role: 'product_owner',
      targetPhase: 'PHASE_5_IMPLEMENTATION',
    });

    const receivedEvents: InterAgentMessage[] = [];
    orchestrator.on('inter-agent-message', (msg: InterAgentMessage) => {
      receivedEvents.push(msg);
    });

    // Developer sends a structured BLOCKER / CONSULTATION to Architect
    const blockerMsg = await orchestrator.sendInterAgentMessage({
      projectId,
      fromRole: 'developer',
      toRole: 'architect',
      type: 'BLOCKER',
      payload: {
        issue: 'Database connection pool size is insufficient for peak burst requirements.',
        component: 'DB_POOL',
      },
    });

    expect(blockerMsg.id).toMatch(/^iam_/);
    expect(blockerMsg.type).toBe('BLOCKER');
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0].id).toBe(blockerMsg.id);

    // QA sends status update to Developer
    const statusMsg = await orchestrator.sendInterAgentMessage({
      projectId,
      fromRole: 'qa',
      toRole: 'developer',
      type: 'STATUS_UPDATE',
      payload: {
        testsReady: 15,
        targetDelivery: 'CODE-001',
      },
    });
    expect(statusMsg.type).toBe('STATUS_UPDATE');

    // Verify all messages are durable in SQLite and queryable through coordinator
    const messages = orchestrator.coordinator.listInterAgentMessages(projectId);
    expect(messages.length).toBe(2);
    expect(messages[0].fromRole).toBe('developer');
    expect(messages[0].toRole).toBe('architect');
    expect(messages[1].fromRole).toBe('qa');
    expect(messages[1].toRole).toBe('developer');
  });

  it('4. Centralized SQLite Write Ownership: coordinator validates authority and logs audit trail', async () => {
    // 1. Authorized write by Architect
    const archDoc = await orchestrator.coordinator.saveArtifact({
      projectId,
      role: 'architect',
      code: 'ARCH-001',
      type: 'ARCHITECTURE',
      title: 'Persistent Runtime Architecture',
      content: '# Microservices and Worker Pool Design',
    });
    expect(archDoc.version).toBe(1);

    // 2. Unauthorized write attempt: Developer trying to create ARCHITECTURE directly without consult_architect
    await expect(
      orchestrator.coordinator.saveArtifact({
        projectId,
        role: 'developer',
        code: 'ARCH-002',
        type: 'ARCHITECTURE',
        title: 'Developer Architecture Override',
        content: '# Unilateral Architectural Change',
      }),
    ).rejects.toThrow(/Authority Violation/);

    // 3. Verify audit log captures both ACCEPTED and REJECTED operations
    const auditLog = orchestrator.getAuditLog(projectId);
    expect(auditLog.length).toBeGreaterThanOrEqual(2);

    const acceptedWrite = auditLog.find(
      (e) => e.action === 'saveArtifact' && e.status === 'ACCEPTED',
    );
    expect(acceptedWrite).toBeDefined();
    expect(acceptedWrite?.agentRole).toBe('architect');

    const rejectedWrite = auditLog.find(
      (e) => e.action === 'saveArtifact' && e.status === 'REJECTED',
    );
    expect(rejectedWrite).toBeDefined();
    expect(rejectedWrite?.agentRole).toBe('developer');

    // 4. Verify typed read snapshot logs operationType: 'READ'
    const snapshot = orchestrator.coordinator.readContextSnapshot({
      projectId,
      role: 'architect',
    });
    expect(snapshot.project.id).toBe(projectId);
    expect(snapshot.normativeArtifacts.length).toBeGreaterThan(0);

    const readAudit = orchestrator.getAuditLog(projectId).find((e) => e.operationType === 'READ');
    expect(readAudit).toBeDefined();
    expect(readAudit?.action).toBe('readContextSnapshot');
  });

  it('5. Optimistic Concurrency: rejects stale artifact updates with StaleArtifactVersionError', async () => {
    // Create initial architecture version 1
    const v1 = await orchestrator.coordinator.saveArtifact({
      projectId,
      role: 'architect',
      code: 'ARCH-001',
      type: 'ARCHITECTURE',
      title: 'Base Architecture',
      content: 'Version 1 content',
    });
    expect(v1.version).toBe(1);

    // Attempt update with mismatched expectedVersion (e.g. expected 99 instead of 1)
    await expect(
      orchestrator.coordinator.saveArtifact({
        projectId,
        role: 'architect',
        code: 'ARCH-001',
        type: 'ARCHITECTURE',
        title: 'Conflicting Architecture Update',
        content: 'Conflict content',
        expectedVersion: 99,
      }),
    ).rejects.toThrow(StaleArtifactVersionError);

    // Attempt update with correct expectedVersion: 1 -> succeeds and increments to 2
    const v2 = await orchestrator.coordinator.saveArtifact({
      projectId,
      role: 'architect',
      code: 'ARCH-001',
      type: 'ARCHITECTURE',
      title: 'Updated Architecture',
      content: 'Version 2 updated content',
      expectedVersion: 1,
    });
    expect(v2.version).toBe(2);
  });

  it('6. Idempotent Retries: duplicate requestIds return cached result without duplicating records', async () => {
    const reqId = `req_idempotent_${Date.now()}`;

    // First write request
    const art1 = await orchestrator.coordinator.saveArtifact({
      projectId,
      role: 'architect',
      code: 'REQ-001',
      type: 'REQUIREMENT',
      title: 'Functional Requirements',
      content: 'Must support concurrent agent workers.',
      requestId: reqId,
    });
    expect(art1.version).toBe(1);

    // Retrying with the same requestId returns the identical cached artifact
    const art2 = await orchestrator.coordinator.saveArtifact({
      projectId,
      role: 'architect',
      code: 'REQ-001',
      type: 'REQUIREMENT',
      title: 'Functional Requirements',
      content: 'Must support concurrent agent workers.',
      requestId: reqId,
    });

    expect(art2.id).toBe(art1.id);
    expect(art2.version).toBe(1);

    // Ensure only 1 version exists in SQLite, no duplicate artifact was inserted
    const allReqs = orchestrator.coordinator
      .listArtifacts(projectId, false)
      .filter((a) => a.code === 'REQ-001');
    expect(allReqs.length).toBe(1);

    // Verify audit log has recorded the DUPLICATE check
    const auditEntries = orchestrator.getAuditLog(projectId);
    const dupEntry = auditEntries.find((e) => e.status === 'DUPLICATE');
    expect(dupEntry).toBeDefined();
    expect(dupEntry?.requestId).toBe(reqId);
  });

  it('7. Failure Detection & State Recovery: crashed worker is detected and recovered from SQLite state', async () => {
    // 1. Start worker and complete a turn
    const res1 = await orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'developer',
      message: 'Initial build preparation.',
    });
    const deadPid = res1.workerPid;
    expect(deadPid).toBeGreaterThan(0);

    const workerStatusBefore = orchestrator.getWorkerStatus(projectId, 'developer');
    expect(workerStatusBefore?.status).toBe('idle');

    // 2. Simulate worker failure by sending SIGKILL to the child process
    try {
      process.kill(deadPid, 'SIGKILL');
    } catch {
      // process might take ms to exit
    }

    // Allow process exit handler to fire
    await new Promise((resolve) => setTimeout(resolve, 250));

    // 3. Worker is detected as failed
    const workerStatusAfterCrash = orchestrator.getWorkerStatus(projectId, 'developer');
    expect(workerStatusAfterCrash?.status).toBe('failed');

    // 4. Executing another turn recovers automatically: spawns a fresh worker and resumes
    const res2 = await orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'developer',
      message: 'Resume implementation after restart.',
    });

    expect(res2.workerPid).toBeGreaterThan(0);
    expect(res2.workerPid).not.toBe(deadPid);

    const recoveredStatus = orchestrator.getWorkerStatus(projectId, 'developer');
    expect(recoveredStatus?.status).toBe('idle');
    expect(recoveredStatus?.workerPid).toBe(res2.workerPid);

    // Verify SQLite state remained completely durable
    const project = storage.getProject(projectId);
    expect(project).toBeDefined();
  });

  it('8. Product Owner Inspection & Control: can list, stop, and restart persistent workers', async () => {
    // Pre-warm Architect
    await orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'architect',
      message: 'Health check prompt.',
    });

    // Inspect workers
    const workers = orchestrator.listWorkers(projectId);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    const archWorker = workers.find((w) => w.role === 'architect');
    expect(archWorker).toBeDefined();
    expect(archWorker?.status).toBe('idle');

    // Manually restart worker
    const oldPid = archWorker?.workerPid;
    const restarted = await orchestrator.restartWorker(projectId, 'architect');
    expect(restarted.workerPid).toBeGreaterThan(0);
    expect(restarted.workerPid).not.toBe(oldPid);
    expect(restarted.status).toBe('idle');

    // Manually stop worker
    await orchestrator.stopWorker(projectId, 'architect');
    const stoppedStatus = orchestrator.getWorkerStatus(projectId, 'architect');
    expect(stoppedStatus).toBeUndefined();
  });

  it('9. Project Manager (PM): autonomous parallel inquiry without mutating engineering artifacts', async () => {
    const res = await orchestrator.executePmInquiry({
      projectId,
      topic: 'Evaluate readiness of authentication modules across active agents',
      modality: 'PARALLEL',
    });

    expect(res.report.modality).toBe('PARALLEL');
    expect(res.report.consultedAgents).toContain('architect');
    expect(res.report.consultedAgents).toContain('developer');
    expect(res.report.consultedAgents).toContain('qa');
    expect(res.report.individualResponses.length).toBe(3);

    // PM report is created and approved
    expect(res.artifact.type).toBe('PM_REPORT');
    expect(res.artifact.authorRole).toBe('pm');

    // Verify PM did NOT alter or create any engineering artifacts (ARCHITECTURE, CODE, etc.)
    const codeArtifacts = storage.listArtifacts(projectId, false).filter((a) => a.type === 'SOURCE_CODE');
    expect(codeArtifacts.length).toBe(0);
  });
});

