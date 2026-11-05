import { EventEmitter } from 'node:events';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import {
  ActorRole,
  ExecutionModality,
  InterAgentMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  RoleModelConfig,
  WorkerLifecycleStatus,
  WorkerStatusInfo,
} from '../core/contracts.js';
import { AgentTurnInput } from './llm-gateway.js';
import { LinuxAgentProcessRunner, WorkerExecutionResult } from './process-runner.js';
import { Logger } from '../core/logger.js';
import { PoCliCoordinator } from './coordinator.js';

interface PendingTurn {
  reqId: string;
  resolve: (res: WorkerExecutionResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onStreamChunk?: (chunk: string) => void;
}

class ManagedWorker {
  public status: WorkerLifecycleStatus = 'idle';
  public turnsCompleted = 0;
  public tasksCompleted = 0;
  public startedAt: string;
  public lastActiveAt: string;
  public lastError?: string;
  public activeTurnReqId?: string;
  private pendingTurn?: PendingTurn;
  private stderrBuffer = '';
  private turnQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;

  constructor(
    public readonly projectId: string,
    public readonly role: ActorRole,
    public readonly child: ChildProcessWithoutNullStreams,
    public readonly effectiveModality: ExecutionModality,
    private readonly onExitCallback: (worker: ManagedWorker, code: number | null, signal: string | null) => void,
  ) {
    this.startedAt = new Date().toISOString();
    this.lastActiveAt = this.startedAt;
    this.setupListeners();
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  private setupListeners(): void {
    const rl = readline.createInterface({
      input: this.child.stdout,
      terminal: false,
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString('utf8');
      if (this.stderrBuffer.length > 8192) {
        this.stderrBuffer = this.stderrBuffer.slice(-4096);
      }
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }

      // Handle streaming token chunks
      if (msg.method === 'agent.streamChunk') {
        const params = msg.params as { chunk?: string } | undefined;
        if (params?.chunk && this.pendingTurn?.onStreamChunk) {
          this.pendingTurn.onStreamChunk(params.chunk);
        }
        return;
      }

      // Handle JSON-RPC response
      if (this.pendingTurn && msg.id === this.pendingTurn.reqId) {
        const pending = this.pendingTurn;
        this.pendingTurn = undefined;
        this.activeTurnReqId = undefined;
        this.status = 'idle';
        this.lastActiveAt = new Date().toISOString();
        this.turnsCompleted++;
        clearTimeout(pending.timer);

        const rpcRes = msg as unknown as JsonRpcResponse;
        if (rpcRes.error) {
          this.lastError = rpcRes.error.message;
          Logger.error(
            'PERSISTENT_RUNTIME',
            `Worker PID ${this.pid} [${this.role}] error: ${rpcRes.error.message}`,
          );
          pending.reject(
            new Error(`Worker JSON-RPC Error (${rpcRes.error.code}): ${rpcRes.error.message}`),
          );
          return;
        }

        const resObj = rpcRes.result as WorkerExecutionResult;
        pending.resolve({
          ...resObj,
          workerPid: this.pid,
          modalityUsed: this.effectiveModality,
        });
      }
    });

    this.child.on('error', (err) => {
      this.status = 'failed';
      this.lastError = err.message;
      if (this.pendingTurn) {
        clearTimeout(this.pendingTurn.timer);
        this.pendingTurn.reject(err);
        this.pendingTurn = undefined;
      }
    });

    this.child.on('exit', (code, signal) => {
      const isExpected = this.status === 'stopped';
      if (!isExpected) {
        this.status = 'failed';
        this.lastError = `Worker process exited prematurely (code: ${code}, signal: ${signal}). Stderr: ${this.stderrBuffer.slice(-300)}`;
      }
      if (this.pendingTurn) {
        clearTimeout(this.pendingTurn.timer);
        this.pendingTurn.reject(
          new Error(
            this.lastError || `Worker process exited prematurely with code ${code}`,
          ),
        );
        this.pendingTurn = undefined;
      }
      this.onExitCallback(this, code, signal);
    });
  }

  public enqueueTurn(
    input: AgentTurnInput,
    onStreamChunk?: (chunk: string) => void,
  ): Promise<WorkerExecutionResult> {
    return new Promise<WorkerExecutionResult>((resolve, reject) => {
      const task = async () => {
        try {
          const res = await this.executeTurnDirect(input, onStreamChunk);
          resolve(res);
        } catch (err) {
          reject(err);
        }
      };
      this.turnQueue.push(task);
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.turnQueue.length === 0) return;
    this.isProcessingQueue = true;
    while (this.turnQueue.length > 0) {
      const nextTask = this.turnQueue.shift();
      if (nextTask) {
        try {
          await nextTask();
        } catch {
          // Handled inside task
        }
      }
    }
    this.isProcessingQueue = false;
  }

  private executeTurnDirect(
    input: AgentTurnInput,
    onStreamChunk?: (chunk: string) => void,
  ): Promise<WorkerExecutionResult> {
    if (this.status === 'failed' || this.status === 'stopped') {
      return Promise.reject(
        new Error(
          `Worker for role '${this.role}' is ${this.status}: ${this.lastError ?? 'inactive'}`,
        ),
      );
    }

    this.status = 'busy';
    this.lastActiveAt = new Date().toISOString();
    const reqId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.activeTurnReqId = reqId;

    return new Promise<WorkerExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingTurn?.reqId === reqId) {
          this.pendingTurn = undefined;
          this.status = 'failed';
          this.lastError = `Agent turn timed out after 120s for role ${this.role}`;
          try {
            this.child.kill('SIGTERM');
          } catch {
            // ignore
          }
          reject(new Error(`Agent worker process timed out for role ${this.role}`));
        }
      }, 120000);

      this.pendingTurn = {
        reqId,
        resolve,
        reject,
        timer,
        onStreamChunk,
      };

      const rpcRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: reqId,
        method: 'agent.executeTurn',
        params: input as unknown as Record<string, unknown>,
      };

      try {
        this.child.stdin.write(`${JSON.stringify(rpcRequest)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pendingTurn = undefined;
        this.status = 'failed';
        this.lastError = (err as Error).message;
        reject(err);
      }
    });
  }

  public sendInterAgentNotification(msg: InterAgentMessage): void {
    if (this.status === 'failed' || this.status === 'stopped') return;
    const rpcReq: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: `iam_${Date.now()}`,
      method: 'agent.interAgentMessage',
      params: msg as unknown as Record<string, unknown>,
    };
    try {
      this.child.stdin.write(`${JSON.stringify(rpcReq)}\n`);
    } catch {
      // ignore
    }
  }

  public async stop(): Promise<void> {
    this.status = 'stopped';
    if (this.child.killed || this.child.exitCode !== null) return;

    return new Promise<void>((resolve) => {
      let resolved = false;
      const doResolve = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(shutdownTimer);
          resolve();
        }
      };

      const shutdownTimer = setTimeout(() => {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // ignore
        }
        doResolve();
      }, 1000);
      shutdownTimer.unref();

      this.child.once('exit', doResolve);

      const shutdownReq: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: `shutdown_${Date.now()}`,
        method: 'agent.shutdown',
      };

      try {
        if (this.child.stdin && !this.child.stdin.destroyed) {
          this.child.stdin.write(`${JSON.stringify(shutdownReq)}\n`);
          this.child.stdin.end();
        } else {
          this.child.kill('SIGTERM');
        }
      } catch {
        try {
          this.child.kill('SIGTERM');
        } catch {
          // ignore
        }
        doResolve();
      }
    });
  }

  public toStatusInfo(): WorkerStatusInfo {
    return {
      projectId: this.projectId,
      role: this.role,
      status: this.status,
      workerPid: this.pid,
      startedAt: this.startedAt,
      lastActiveAt: this.lastActiveAt,
      turnsCompleted: this.turnsCompleted,
      tasksCompleted: this.tasksCompleted,
      modality: this.effectiveModality,
      error: this.lastError,
    };
  }
}

/**
 * PersistentAgentRuntime — Managed Worker Pool for Concurrent Long-Lived Agents.
 *
 * Keeps active workers alive across multiple chat turns without restarting child processes.
 * Supports concurrent execution across distinct roles, inter-agent communication,
 * and automatic failure recovery backed by SQLite durability.
 */
export class PersistentAgentRuntime extends EventEmitter {
  private workers = new Map<string, ManagedWorker>();
  public isPersistent = true;

  constructor(public readonly coordinator?: PoCliCoordinator) {
    super();
  }

  private makeKey(projectId: string, role: ActorRole): string {
    return `${projectId}:${role}`;
  }

  /**
   * Retrieves an existing running worker or spawns a fresh persistent worker.
   */
  public getOrCreateWorker(
    projectId: string,
    role: ActorRole,
    workspaceDir: string,
    modelConfig: RoleModelConfig,
  ): ManagedWorker {
    const key = this.makeKey(projectId, role);
    const existing = this.workers.get(key);

    if (
      existing &&
      existing.status !== 'stopped' &&
      existing.status !== 'failed' &&
      !existing.child.killed &&
      existing.child.exitCode === null
    ) {
      return existing;
    }

    // Clean up dead/failed worker if present
    if (existing) {
      this.workers.delete(key);
    }

    const { child, effectiveModality } = LinuxAgentProcessRunner.spawnWorkerProcess(
      modelConfig.executionModality,
      workspaceDir,
    );

    const worker = new ManagedWorker(
      projectId,
      role,
      child,
      effectiveModality,
      (deadWorker, code, signal) => {
        Logger.warn(
          'PERSISTENT_RUNTIME',
          `Worker PID ${deadWorker.pid} [${deadWorker.role}] died (code: ${code}, signal: ${signal})`,
        );
        this.emit('worker:failed', {
          projectId: deadWorker.projectId,
          role: deadWorker.role,
          code,
          signal,
          lastError: deadWorker.lastError,
        });

        if (this.coordinator && deadWorker.status !== 'stopped') {
          try {
            if (this.coordinator.storage.getProject(deadWorker.projectId)) {
              this.coordinator.storage.recordAuditLogEntry({
                projectId: deadWorker.projectId,
                agentRole: deadWorker.role,
                operationType: 'WRITE',
                action: 'worker_crashed',
                status: 'REJECTED',
                details: { pid: deadWorker.pid, code, signal, error: deadWorker.lastError },
              });
            }
          } catch {
            // Ignore audit log error if project was deleted
          }
        }
      },
    );

    this.workers.set(key, worker);

    Logger.info(
      'PERSISTENT_RUNTIME',
      `Initialized long-lived worker PID ${worker.pid} for role='${role}' in project '${projectId}' (modality: ${effectiveModality})`,
    );

    if (this.coordinator) {
      this.coordinator.storage.recordAuditLogEntry({
        projectId,
        agentRole: role,
        operationType: 'WRITE',
        action: 'worker_started',
        status: 'ACCEPTED',
        details: { pid: worker.pid, modality: effectiveModality },
      });
    }

    this.emit('worker:started', worker.toStatusInfo());
    return worker;
  }

  /**
   * Executes an agent turn. If persistent execution is enabled (default), reuses the
   * long-lived worker process. If disabled, executes and stops the worker.
   */
  public async executeTurn(
    input: AgentTurnInput,
    workspaceDir: string,
    onStreamChunk?: (chunk: string) => void,
  ): Promise<WorkerExecutionResult> {
    if (!this.isPersistent) {
      // Legacy single-turn behavior: spawn child process, run turn, shutdown
      const runner = new LinuxAgentProcessRunner();
      return runner.executeTurnInProcess(input, workspaceDir, onStreamChunk);
    }

    const worker = this.getOrCreateWorker(
      input.projectId,
      input.role,
      workspaceDir,
      input.modelConfig,
    );

    return worker.enqueueTurn(input, onStreamChunk);
  }

  /**
   * Delivers an autonomous inter-agent message to the target worker if active.
   */
  public routeInterAgentMessage(msg: InterAgentMessage): void {
    if (msg.toRole === 'broadcast') {
      for (const worker of this.workers.values()) {
        if (worker.projectId === msg.projectId && worker.role !== msg.fromRole) {
          worker.sendInterAgentNotification(msg);
        }
      }
    } else {
      const key = this.makeKey(msg.projectId, msg.toRole);
      const worker = this.workers.get(key);
      if (worker) {
        worker.sendInterAgentNotification(msg);
      }
    }
  }

  /**
   * Pre-warms or ensures all 4 core agents (architect, developer, qa, pm)
   * are actively initialized in the persistent pool for a project.
   */
  public ensureCoreWorkers(projectId: string, workspaceDir: string): WorkerStatusInfo[] {
    const coreRoles: ActorRole[] = ['architect', 'developer', 'qa', 'pm'];
    for (const role of coreRoles) {
      const cfg = this.coordinator?.storage.getRoleConfig(projectId, role) ?? {
        role,
        provider: 'anthropic',
        modelId: 'claude-3-7-sonnet',
        temperature: 0.2,
        executionModality: 'LOCAL_PROCESS',
      };
      this.getOrCreateWorker(projectId, role, workspaceDir, cfg);
    }
    return this.listWorkers(projectId);
  }

  /**
   * Returns inspection status for all managed workers.
   */
  public listWorkers(projectId?: string): WorkerStatusInfo[] {
    const list: WorkerStatusInfo[] = [];
    const foundRoles = new Set<string>();

    for (const worker of this.workers.values()) {
      if (!projectId || worker.projectId === projectId) {
        list.push(worker.toStatusInfo());
        foundRoles.add(worker.role);
      }
    }

    if (projectId) {
      const coreRoles: ActorRole[] = ['architect', 'developer', 'qa', 'pm'];
      for (const role of coreRoles) {
        if (!foundRoles.has(role)) {
          list.push({
            projectId,
            role,
            status: 'stopped',
            turnsCompleted: 0,
            tasksCompleted: 0,
            modality: 'LOCAL_PROCESS',
          });
        }
      }
    }

    return list;
  }

  /**
   * Returns inspection status for a specific role in a project.
   */
  public getWorkerStatus(projectId: string, role: ActorRole): WorkerStatusInfo | undefined {
    const key = this.makeKey(projectId, role);
    return this.workers.get(key)?.toStatusInfo();
  }

  /**
   * Manually stops an active worker.
   */
  public async stopWorker(projectId: string, role: ActorRole): Promise<void> {
    const key = this.makeKey(projectId, role);
    const worker = this.workers.get(key);
    if (worker) {
      await worker.stop();
      this.workers.delete(key);
      if (this.coordinator) {
        this.coordinator.storage.recordAuditLogEntry({
          projectId,
          agentRole: role,
          operationType: 'WRITE',
          action: 'worker_stopped',
          status: 'ACCEPTED',
          details: { pid: worker.pid },
        });
      }
      this.emit('worker:stopped', { projectId, role, pid: worker.pid });
    }
  }

  /**
   * Restarts a worker safely, re-initializing from durable SQLite state.
   */
  public async restartWorker(
    projectId: string,
    role: ActorRole,
    workspaceDir: string,
    modelConfig: RoleModelConfig,
  ): Promise<WorkerStatusInfo> {
    await this.stopWorker(projectId, role);
    const freshWorker = this.getOrCreateWorker(projectId, role, workspaceDir, modelConfig);
    if (this.coordinator) {
      this.coordinator.storage.recordAuditLogEntry({
        projectId,
        agentRole: role,
        operationType: 'WRITE',
        action: 'worker_restarted',
        status: 'ACCEPTED',
        details: { pid: freshWorker.pid },
      });
    }
    return freshWorker.toStatusInfo();
  }

  /**
   * Gracefully shuts down all active workers belonging to a specific project.
   */
  public async stopProjectWorkers(projectId: string): Promise<void> {
    const toStop: ManagedWorker[] = [];
    for (const [key, worker] of this.workers.entries()) {
      if (worker.projectId === projectId || key.startsWith(`${projectId}:`)) {
        toStop.push(worker);
        this.workers.delete(key);
      }
    }
    await Promise.all(toStop.map((w) => w.stop()));
  }

  /**
   * Gracefully shuts down all workers across projects (e.g. on exit or project switch).
   */
  public async stopAllWorkers(): Promise<void> {
    const workers = Array.from(this.workers.values());
    this.workers.clear();
    await Promise.all(workers.map((w) => w.stop()));
  }
}

