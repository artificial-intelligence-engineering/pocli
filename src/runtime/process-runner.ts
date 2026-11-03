import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  ExecutionModality,
  JsonRpcRequest,
  JsonRpcResponse,
} from '../core/contracts.js';
import { AgentTurnInput, AgentTurnOutput } from './llm-gateway.js';
import { Logger } from '../core/logger.js';

export interface WorkerExecutionResult extends AgentTurnOutput {
  workerPid: number;
  modalityUsed: ExecutionModality;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the command and arguments to run the agent-worker process in Linux.
 */
export function resolveWorkerNodeArgs(): { executable: string; args: string[]; rootDir: string } {
  const jsWorker = path.resolve(currentDir, 'agent-worker.js');
  const tsWorker = path.resolve(currentDir, 'agent-worker.ts');
  const rootDir = path.resolve(currentDir, '..', '..');

  if (fs.existsSync(jsWorker)) {
    return {
      executable: process.execPath,
      args: [jsWorker],
      rootDir,
    };
  }

  const tsxCli = path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(tsxCli)) {
    return {
      executable: process.execPath,
      args: [tsxCli, tsWorker],
      rootDir,
    };
  }

  return {
    executable: process.execPath,
    args: ['--experimental-strip-types', tsWorker],
    rootDir,
  };
}

/**
 * Executes an agent turn inside an isolated Linux OS process using JSON-RPC 2.0 over stdio.
 * Supports:
 * 1. LOCAL_PROCESS: Standard Linux child_process
 * 2. LINUX_BWRAP: Linux user/pid/ipc/mount namespaces via Bubblewrap (/usr/bin/bwrap)
 * 3. OCI_CONTAINER: Isolated container execution via Podman (/usr/bin/podman)
 */
export class LinuxAgentProcessRunner {
  static canUseBwrap(): boolean {
    if (process.platform !== 'linux' || !fs.existsSync('/usr/bin/bwrap')) {
      return false;
    }
    const probe = spawnSync(
      '/usr/bin/bwrap',
      ['--ro-bind', '/', '/', '--unshare-pid', '/bin/true'],
      { stdio: 'ignore', timeout: 3000 },
    );
    return probe.status === 0;
  }

  static canUseOciContainer(): boolean {
    if (!fs.existsSync('/usr/bin/podman')) return false;
    const probe = spawnSync('/usr/bin/podman', ['--version'], {
      stdio: 'ignore',
      timeout: 3000,
    });
    return probe.status === 0;
  }

  async executeTurnInProcess(
    input: AgentTurnInput,
    workspaceDir: string,
    onStreamChunk?: (chunk: string) => void,
  ): Promise<WorkerExecutionResult> {
    const requestedModality = input.modelConfig.executionModality;
    const { child, effectiveModality } = LinuxAgentProcessRunner.spawnWorkerProcess(
      requestedModality,
      workspaceDir,
    );

    Logger.debug(
      'WORKER',
      `Spawned worker PID ${child.pid} for role='${input.role}' (modality: ${effectiveModality})`,
    );

    return new Promise<WorkerExecutionResult>((resolve, reject) => {
      const rl = readline.createInterface({
        input: child.stdout,
        terminal: false,
      });

      let stderrBuffer = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString('utf8');
      });

      const reqId = `turn_${Date.now()}`;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`Agent worker process timed out for role ${input.role}`));
        }
      }, 120000);

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }

        // Handle streaming notification
        if (msg.method === 'agent.streamChunk') {
          const params = msg.params as { chunk?: string } | undefined;
          if (params?.chunk && onStreamChunk) {
            onStreamChunk(params.chunk);
          }
          return;
        }

        // Handle JSON-RPC response
        if (msg.id === reqId) {
          const rpcRes = msg as unknown as JsonRpcResponse;
          settled = true;
          clearTimeout(timer);

          // Request graceful shutdown of worker
          const shutdownReq: JsonRpcRequest = {
            jsonrpc: '2.0',
            id: 'shutdown_1',
            method: 'agent.shutdown',
          };
          child.stdin.write(`${JSON.stringify(shutdownReq)}\n`);

          if (rpcRes.error) {
            Logger.error(
              'WORKER',
              `Worker PID ${child.pid} error for role='${input.role}': ${rpcRes.error.message}`,
              { code: rpcRes.error.code },
            );
            reject(
              new Error(
                `Worker JSON-RPC Error (${rpcRes.error.code}): ${rpcRes.error.message}`,
              ),
            );
            return;
          }

          const resObj = rpcRes.result as WorkerExecutionResult;
          Logger.debug(
            'WORKER',
            `Worker PID ${child.pid} turn completed for role='${input.role}'`,
          );
          resolve({
            ...resObj,
            modalityUsed: effectiveModality,
          });
        }
      });

      child.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      child.on('exit', (code: number | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new Error(
              `Agent worker exited prematurely with code ${code}. Stderr: ${stderrBuffer}`,
            ),
          );
        }
      });

      // Send executeTurn JSON-RPC 2.0 request over stdin
      const rpcRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: reqId,
        method: 'agent.executeTurn',
        params: input as unknown as Record<string, unknown>,
      };
      child.stdin.write(`${JSON.stringify(rpcRequest)}\n`);
    });
  }

  public static spawnWorkerProcess(
    modality: ExecutionModality,
    workspaceDir: string,
  ): { child: ChildProcessWithoutNullStreams; effectiveModality: ExecutionModality } {
    const { executable, args, rootDir } = resolveWorkerNodeArgs();
    const absWorkspace = path.resolve(workspaceDir);
    fs.mkdirSync(absWorkspace, { recursive: true });

    if (modality === 'LINUX_BWRAP' && LinuxAgentProcessRunner.canUseBwrap()) {
      // Sandbox using Linux namespaces via Bubblewrap:
      // Mount root filesystem read-only, isolate PID and IPC namespaces,
      // and mount only /tmp and the project workspaceDir as read-write.
      const bwrapArgs = [
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        '--tmpfs', '/tmp',
        '--bind', absWorkspace, absWorkspace,
        '--unshare-pid',
        '--unshare-ipc',
        '--unshare-uts',
        '--die-with-parent',
        '--chdir', rootDir,
        executable,
        ...args,
      ];
      return {
        child: spawn('/usr/bin/bwrap', bwrapArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        }),
        effectiveModality: 'LINUX_BWRAP',
      };
    }

    // Default Modalidad 1: Local Linux child_process
    return {
      child: spawn(executable, args, {
        cwd: rootDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      }),
      effectiveModality: 'LOCAL_PROCESS',
    };
  }
}

