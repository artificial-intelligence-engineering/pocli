import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveDefaultWorkDir } from '../../core/i18n.js';
import { resolveLifecyclePaths } from '../../core/lifecycle.js';
import { PoCliDatabase } from '../../storage/database.js';
import {
  GenerateRequest,
  GenerateResponse,
  HardwareProfile,
  InferenceEngineAdapter,
  LocalRuntimeRecord,
  RuntimeConfig,
  RuntimeStatus,
} from '../contracts.js';
import { detectHardwareProfile } from '../hardware.js';

const execFileAsync = promisify(execFile);

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export function getLlamaCppInstallDir(): string {
  const { appDir } = resolveLifecyclePaths();
  return path.join(appDir, 'engines', 'llama.cpp');
}

export function getLlamaServerBinaryName(platform = os.platform()): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

export function findLlamaServerInDir(dir: string, platform = os.platform()): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const target = getLlamaServerBinaryName(platform);
  const direct = path.join(dir, target);
  if (fs.existsSync(direct)) return direct;

  const queue: string[] = [dir];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && entry.name === target) {
        return full;
      }
    }
  }
  return undefined;
}

export function resolveLlamaCppAsset(
  assets: GithubReleaseAsset[],
  hardware: HardwareProfile,
): GithubReleaseAsset | undefined {
  const platform = hardware.platform;
  const arch = hardware.arch;
  const backend = hardware.recommendedBackend;

  const matchers: Array<(name: string) => boolean> = [];

  if (platform === 'linux') {
    if (arch === 'x64') {
      if (backend === 'vulkan') {
        matchers.push((n) => /bin-ubuntu-vulkan-x64\.(tar\.gz|zip)$/i.test(n));
      }
      matchers.push((n) => /bin-ubuntu-x64\.(tar\.gz|zip)$/i.test(n));
    } else if (arch === 'arm64') {
      matchers.push((n) => /bin-ubuntu-arm64\.(tar\.gz|zip)$/i.test(n));
    }
  } else if (platform === 'darwin') {
    if (arch === 'arm64') {
      matchers.push((n) => /bin-macos-arm64\.(tar\.gz|zip)$/i.test(n));
    } else {
      matchers.push((n) => /bin-macos-x64\.(tar\.gz|zip)$/i.test(n));
    }
  } else if (platform === 'win32') {
    if (arch === 'x64') {
      if (backend === 'cuda') {
        matchers.push((n) => /bin-win-cuda-.*-x64\.zip$/i.test(n));
      }
      if (backend === 'vulkan') {
        matchers.push((n) => /bin-win-vulkan-x64\.zip$/i.test(n));
      }
      matchers.push((n) => /bin-win-cpu-x64\.zip$/i.test(n));
    } else if (arch === 'arm64') {
      matchers.push((n) => /bin-win-cpu-arm64\.zip$/i.test(n));
    }
  }

  for (const matcher of matchers) {
    const hit = assets.find((a) => matcher(a.name));
    if (hit) return hit;
  }
  return undefined;
}

async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class LlamaCppAdapter implements InferenceEngineAdapter {
  public readonly id = 'llama.cpp' as const;

  constructor(private readonly storage: PoCliDatabase) {}

  resolveBinaryPath(): string | undefined {
    const installDir = getLlamaCppInstallDir();
    const localBin = findLlamaServerInDir(installDir);
    if (localBin) return localBin;

    // Fallback: check system PATH
    const pathEnv = process.env.PATH ?? '';
    const sep = os.platform() === 'win32' ? ';' : ':';
    const binName = getLlamaServerBinaryName();
    for (const dir of pathEnv.split(sep)) {
      if (!dir) continue;
      const candidate = path.join(dir, binName);
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  async isInstalled(): Promise<boolean> {
    return Boolean(this.resolveBinaryPath());
  }

  async getVersion(): Promise<string | undefined> {
    const versionFile = path.join(getLlamaCppInstallDir(), '.version');
    if (fs.existsSync(versionFile)) {
      return fs.readFileSync(versionFile, 'utf8').trim() || undefined;
    }
    const bin = this.resolveBinaryPath();
    if (!bin) return undefined;
    try {
      const { stdout, stderr } = await execFileAsync(bin, ['--version'], {
        timeout: 3000,
        encoding: 'utf8',
      });
      const out = `${stdout}\n${stderr}`.trim().split(/\r?\n/)[0];
      return out || 'installed';
    } catch {
      return 'installed';
    }
  }

  async install(options?: {
    force?: boolean;
    hardware?: HardwareProfile;
  }): Promise<{ binaryPath: string; version: string }> {
    const existing = this.resolveBinaryPath();
    if (existing && !options?.force) {
      const version = (await this.getVersion()) ?? 'installed';
      return { binaryPath: existing, version };
    }

    const hardware = options?.hardware ?? (await detectHardwareProfile());
    const releaseRes = await fetch(
      'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest',
      {
        headers: {
          'User-Agent': 'pocli-local-llm',
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!releaseRes.ok) {
      throw new Error(
        `Failed to query llama.cpp releases (${releaseRes.status} ${releaseRes.statusText})`,
      );
    }

    const release = (await releaseRes.json()) as {
      tag_name?: string;
      assets?: GithubReleaseAsset[];
    };
    const tag = release.tag_name ?? 'latest';
    const asset = resolveLlamaCppAsset(release.assets ?? [], hardware);
    if (!asset) {
      throw new Error(
        `No prebuilt llama.cpp binary found for ${hardware.platform}/${hardware.arch} (${hardware.recommendedBackend}).`,
      );
    }

    const installDir = getLlamaCppInstallDir();
    if (options?.force && fs.existsSync(installDir)) {
      fs.rmSync(installDir, { recursive: true, force: true });
    }
    fs.mkdirSync(installDir, { recursive: true });

    const archivePath = path.join(installDir, asset.name);
    const dlRes = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'pocli-local-llm' },
      redirect: 'follow',
    });
    if (!dlRes.ok) {
      throw new Error(
        `Failed to download ${asset.name} (${dlRes.status} ${dlRes.statusText})`,
      );
    }
    const buf = Buffer.from(await dlRes.arrayBuffer());
    fs.writeFileSync(archivePath, buf);

    if (asset.name.endsWith('.tar.gz') || asset.name.endsWith('.tgz')) {
      await execFileAsync('tar', ['-xzf', archivePath, '-C', installDir], {
        timeout: 60000,
      });
    } else if (asset.name.endsWith('.zip')) {
      if (os.platform() === 'win32') {
        await execFileAsync(
          'powershell',
          ['-NoProfile', '-Command', `Expand-Archive -Path "${archivePath}" -DestinationPath "${installDir}" -Force`],
          { timeout: 60000 },
        );
      } else {
        await execFileAsync('unzip', ['-o', archivePath, '-d', installDir], {
          timeout: 60000,
        });
      }
    }

    fs.rmSync(archivePath, { force: true });
    const binaryPath = findLlamaServerInDir(installDir);
    if (!binaryPath) {
      throw new Error(`Extracted ${asset.name}, but llama-server binary was not found.`);
    }
    if (os.platform() !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }
    fs.writeFileSync(path.join(installDir, '.version'), `${tag}\n`, 'utf8');

    return { binaryPath, version: tag };
  }

  async start(config: RuntimeConfig): Promise<LocalRuntimeRecord> {
    const existing = this.storage.getLocalRuntime(config.modelId);
    if (existing && isProcessAlive(existing.pid)) {
      const ok = await this.checkHealth(existing.port);
      if (ok) return existing;
    }

    const bin = this.resolveBinaryPath();
    if (!bin) {
      throw new Error(
        'llama-server is not installed. Run "pocli local engine install" first.',
      );
    }

    if (!fs.existsSync(config.modelPath)) {
      throw new Error(`Model file not found at ${config.modelPath}`);
    }

    const port = config.port ?? (await allocateFreePort());
    const ctxSize = config.ctxSize ?? 8192;
    const gpuLayers = config.gpuLayers ?? 0;

    const logsDir = path.join(resolveDefaultWorkDir(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const safeName = config.modelId.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const logPath = path.join(logsDir, `llama-${safeName}.log`);
    const logFd = fs.openSync(logPath, 'a');

    const args = [
      '-m',
      config.modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '-c',
      String(ctxSize),
      '-ngl',
      String(gpuLayers),
    ];
    if (config.threads) {
      args.push('-t', String(config.threads));
    }

    const child = spawn(bin, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [path.dirname(bin), process.env.LD_LIBRARY_PATH]
          .filter(Boolean)
          .join(':'),
      },
    });
    child.unref();
    fs.closeSync(logFd);

    const pid = child.pid;
    if (!pid) {
      throw new Error('Failed to spawn llama-server process.');
    }

    const deadline = Date.now() + 45000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        const tail = fs.existsSync(logPath)
          ? fs.readFileSync(logPath, 'utf8').slice(-800)
          : '';
        throw new Error(`llama-server exited prematurely.\n${tail}`);
      }
      if (await this.checkHealth(port)) {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    if (!healthy) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
      throw new Error(`Timed out waiting for llama-server /health on port ${port}`);
    }

    const record: LocalRuntimeRecord = {
      modelId: config.modelId,
      engine: 'llama.cpp',
      pid,
      port,
      status: 'running',
      gpuLayers,
      ctxSize,
      logPath,
      startedAt: new Date().toISOString(),
    };
    this.storage.upsertLocalRuntime(record);
    return record;
  }

  async stop(modelId: string): Promise<boolean> {
    const rt = this.storage.getLocalRuntime(modelId);
    if (!rt) return false;

    if (isProcessAlive(rt.pid)) {
      try {
        process.kill(rt.pid, 'SIGTERM');
      } catch {
        // ignore
      }
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline && isProcessAlive(rt.pid)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (isProcessAlive(rt.pid)) {
        try {
          process.kill(rt.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }

    this.storage.deleteLocalRuntime(modelId);
    return true;
  }

  async status(modelId?: string): Promise<RuntimeStatus> {
    const binaryPath = this.resolveBinaryPath();
    const installed = Boolean(binaryPath);
    const version = installed ? await this.getVersion() : undefined;

    if (!modelId) {
      return {
        engine: 'llama.cpp',
        installed,
        version,
        binaryPath,
        running: false,
      };
    }

    const rt = this.storage.getLocalRuntime(modelId);
    if (!rt || !isProcessAlive(rt.pid)) {
      if (rt) this.storage.deleteLocalRuntime(modelId);
      return {
        engine: 'llama.cpp',
        installed,
        version,
        binaryPath,
        running: false,
        modelId,
      };
    }

    const healthy = await this.checkHealth(rt.port);
    return {
      engine: 'llama.cpp',
      installed,
      version,
      binaryPath,
      running: true,
      pid: rt.pid,
      port: rt.port,
      modelId,
      healthy,
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const rt = this.storage.getLocalRuntime(request.modelId);
    if (!rt || !isProcessAlive(rt.pid)) {
      throw new Error(`Local model "${request.modelId}" is not running.`);
    }

    const startedAt = Date.now();
    const stream = Boolean(request.onToken);
    const res = await fetch(`http://127.0.0.1:${rt.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 1024,
        stream,
      }),
    });

    if (!res.ok) {
      throw new Error(`llama-server error (${res.status}): ${await res.text()}`);
    }

    if (!stream || !res.body) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? '';
      return {
        text,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        latencyMs: Date.now() - startedAt,
      };
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = parsed.choices?.[0]?.delta?.content ?? '';
          if (token) {
            fullText += token;
            request.onToken?.(token);
          }
        } catch {
          // skip partial SSE frame
        }
      }
    }

    return {
      text: fullText,
      latencyMs: Date.now() - startedAt,
    };
  }

  private async checkHealth(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1200),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
