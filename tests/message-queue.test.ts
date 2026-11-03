import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ActorRole,
  PoCliDatabase,
  PoCliOrchestrator,
} from '../src/index.js';

describe('Issue #8 — Support FIFO message queuing for busy agents while model is thinking', () => {
  let tmpDir: string;
  let dbPath: string;
  let workspaceDir: string;
  let storage: PoCliDatabase;
  let orchestrator: PoCliOrchestrator;
  let projectId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-issue8-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    workspaceDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });

    storage = new PoCliDatabase(dbPath);
    orchestrator = new PoCliOrchestrator(storage);

    const project = orchestrator.createProject({
      name: 'Test Queue Project',
      description: 'Project verifying FIFO message queuing for busy agents',
      workspaceDir,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    try {
      orchestrator.clearQueues();
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

  it('1. FIFO Execution Order: sub-turns submitted while agent is busy execute in strict FIFO sequence', async () => {
    const executionOrder: string[] = [];

    // Dispatch 3 turns simultaneously to the developer
    const p1 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'developer',
      message: 'Turn 1: Setup project structure and package.json',
    }).then((res) => {
      executionOrder.push('Turn 1');
      return res;
    });

    // Check that Developer is busy immediately
    expect(orchestrator.isRoleBusy(projectId, 'developer')).toBe(true);

    const p2 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'developer',
      message: 'Turn 2: Implement core algorithm',
    }).then((res) => {
      executionOrder.push('Turn 2');
      return res;
    });

    const p3 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'developer',
      message: 'Turn 3: Write comprehensive unit tests',
    }).then((res) => {
      executionOrder.push('Turn 3');
      return res;
    });

    // Verify queue depth while Turn 1 is executing
    const queued = orchestrator.getQueuedMessages(projectId, 'developer');
    expect(queued.length).toBe(2);
    expect(queued[0].message).toContain('Turn 2');
    expect(queued[1].message).toContain('Turn 3');

    // Wait for all 3 turns to complete
    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    expect(res1.reply).toBeTruthy();
    expect(res2.reply).toBeTruthy();
    expect(res3.reply).toBeTruthy();

    // Verify strict FIFO order execution
    expect(executionOrder).toEqual(['Turn 1', 'Turn 2', 'Turn 3']);

    // Once finished, agent is no longer busy and queue is empty
    expect(orchestrator.isRoleBusy(projectId, 'developer')).toBe(false);
    expect(orchestrator.getQueuedMessages(projectId, 'developer')).toHaveLength(0);
  });

  it('2. Queue Inspection & Status: reports queued messages per role and globally', async () => {
    // Start active turn
    const p1 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'architect',
      message: 'Architect Turn 1: High level diagram',
    });

    // Enqueue 2 follow-up turns
    const p2 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'architect',
      message: 'Architect Turn 2: Database schema ADR',
      messageId: 'custom-turn-2',
    });

    const p3 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'architect',
      message: 'Architect Turn 3: Security model ADR',
      messageId: 'custom-turn-3',
    });

    const roleQueue = orchestrator.getQueuedMessages(projectId, 'architect');
    expect(roleQueue).toHaveLength(2);
    expect(roleQueue[0].id).toBe('custom-turn-2');
    expect(roleQueue[1].id).toBe('custom-turn-3');

    const allQueued = orchestrator.getAllQueuedMessages(projectId);
    expect(allQueued['architect']).toBeDefined();
    expect(allQueued['architect']).toHaveLength(2);

    await Promise.all([p1, p2, p3]);

    expect(orchestrator.isRoleBusy(projectId, 'architect')).toBe(false);
    expect(orchestrator.getQueuedMessages(projectId, 'architect')).toHaveLength(0);
  });

  it('3. Independent Per-Agent Queues: queuing on developer does NOT block or delay architect or QA', async () => {
    const completions: string[] = [];

    // Start long Developer turn + queue another developer turn
    const devTurn1 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'developer',
      message: 'Dev Turn 1: Build complex backend service',
    }).then((res) => {
      completions.push('Dev 1');
      return res;
    });

    const devTurn2 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'developer',
      message: 'Dev Turn 2: Add integration endpoints',
    }).then((res) => {
      completions.push('Dev 2');
      return res;
    });

    // Developer should be busy with 1 queued turn
    expect(orchestrator.isRoleBusy(projectId, 'developer')).toBe(true);
    expect(orchestrator.getQueuedMessages(projectId, 'developer')).toHaveLength(1);

    // Architect and QA are NOT busy
    expect(orchestrator.isRoleBusy(projectId, 'architect')).toBe(false);
    expect(orchestrator.isRoleBusy(projectId, 'qa')).toBe(false);

    // QA can execute immediately without waiting for developer queue!
    const qaTurn = await orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'qa',
      message: 'QA Turn 1: Run fast sanity checks',
    });
    completions.push('QA 1');

    expect(qaTurn.reply).toBeTruthy();
    expect(completions).toContain('QA 1');

    await Promise.all([devTurn1, devTurn2]);
    expect(completions).toContain('Dev 1');
    expect(completions).toContain('Dev 2');
  });

  it('4. Event Lifecycle: emits agent:messageQueued, agent:messageDequeued, and agent:idle in sequence', async () => {
    const events: Array<{ event: string; payload: any }> = [];

    orchestrator.on('agent:messageQueued', (payload) => {
      events.push({ event: 'agent:messageQueued', payload });
    });
    orchestrator.on('agent:messageDequeued', (payload) => {
      events.push({ event: 'agent:messageDequeued', payload });
    });
    orchestrator.on('agent:idle', (payload) => {
      events.push({ event: 'agent:idle', payload });
    });

    const p1 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'pm',
      message: 'PM 1: Sprint status report',
    });

    const p2 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'pm',
      message: 'PM 2: Risk register update',
      messageId: 'pm-msg-2',
    });

    await Promise.all([p1, p2]);

    const queuedEvents = events.filter((e) => e.event === 'agent:messageQueued');
    const dequeuedEvents = events.filter((e) => e.event === 'agent:messageDequeued');
    const idleEvents = events.filter((e) => e.event === 'agent:idle');

    expect(queuedEvents).toHaveLength(1);
    expect(queuedEvents[0].payload.role).toBe('pm');
    expect(queuedEvents[0].payload.messageId).toBe('pm-msg-2');

    expect(dequeuedEvents).toHaveLength(1);
    expect(dequeuedEvents[0].payload.role).toBe('pm');
    expect(dequeuedEvents[0].payload.messageId).toBe('pm-msg-2');

    expect(idleEvents.length).toBeGreaterThanOrEqual(1);
    expect(idleEvents[idleEvents.length - 1].payload.role).toBe('pm');
  });

  it('5. Resilient Dequeuing: continues dequeuing subsequent turns even if an intermediate turn errors', async () => {
    let callCount = 0;
    // Temporarily spy on runtime.executeTurn to make second turn fail
    const originalExecuteTurn = orchestrator.runtime.executeTurn.bind(orchestrator.runtime);
    orchestrator.runtime.executeTurn = async (params, workspaceDir, onStreamChunk) => {
      callCount++;
      if (params.userPrompt.includes('FailTurn')) {
        throw new Error('Simulated model failure');
      }
      return originalExecuteTurn(params, workspaceDir, onStreamChunk);
    };

    const p1 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'developer',
      message: 'Turn 1: Initial setup',
    });

    const p2 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'developer',
      message: 'Turn 2: FailTurn trigger',
    });

    const p3 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'developer',
      message: 'Turn 3: Recovery turn',
    });

    const r1 = await p1;
    expect(r1.reply).toBeTruthy();

    await expect(p2).rejects.toThrow('Simulated model failure');

    const r3 = await p3;
    expect(r3.reply).toBeTruthy();

    expect(orchestrator.isRoleBusy(projectId, 'developer')).toBe(false);
  });

  it('6. clearQueues: cancels and rejects all pending turns in the queue', async () => {
    const p1 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'architect',
      message: 'Architect Turn 1: Long analysis',
    });

    const p2 = orchestrator.chatWithProfessional({
      projectId,
      targetRole: 'architect',
      message: 'Architect Turn 2: To be cleared',
    });

    expect(orchestrator.getQueuedMessages(projectId, 'architect')).toHaveLength(1);

    orchestrator.clearQueues(projectId);
    expect(orchestrator.getQueuedMessages(projectId, 'architect')).toHaveLength(0);

    await expect(p2).rejects.toThrow('Queue cleared');
    await p1; // p1 was already active, so it finishes normally
  });
});
