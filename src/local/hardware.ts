import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import {
  AccelerationBackend,
  GpuDevice,
  HardwareProfile,
} from './contracts.js';

const execFileAsync = promisify(execFile);

export type CommandProbe = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

async function defaultCommandProbe(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { timeout: 2500, encoding: 'utf8' });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const val = bytes / 1024 ** exp;
  return `${val >= 100 || exp === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[exp]}`;
}

export function parseNvidiaSmiOutput(stdout: string): GpuDevice[] {
  const gpus: GpuDevice[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 3) continue;
    const name = parts[0];
    const totalMiB = Number(parts[1]);
    const freeMiB = Number(parts[2]);
    if (!Number.isFinite(totalMiB) || totalMiB <= 0) continue;
    gpus.push({
      vendor: 'NVIDIA',
      name,
      vramTotalBytes: Math.round(totalMiB * 1024 * 1024),
      vramFreeBytes: Number.isFinite(freeMiB)
        ? Math.round(freeMiB * 1024 * 1024)
        : Math.round(totalMiB * 1024 * 1024),
      backend: 'cuda',
    });
  }
  return gpus;
}

/**
 * Detects host OS, CPU, RAM, GPUs, and recommended llama.cpp acceleration backend.
 */
export async function detectHardwareProfile(options?: {
  probe?: CommandProbe;
  platform?: string;
  arch?: string;
  cpus?: os.CpuInfo[];
  totalRamBytes?: number;
  freeRamBytes?: number;
}): Promise<HardwareProfile> {
  const probe = options?.probe ?? defaultCommandProbe;
  const platform = options?.platform ?? os.platform();
  const arch = options?.arch ?? os.arch();
  const cpus = options?.cpus ?? os.cpus();
  const totalRamBytes = options?.totalRamBytes ?? os.totalmem();
  const freeRamBytes = options?.freeRamBytes ?? os.freemem();

  const cpuModel = cpus[0]?.model?.trim() || 'Unknown CPU';
  const cpuCores = Math.max(1, cpus.length);
  const gpus: GpuDevice[] = [];

  // 1. Apple Silicon unified memory (Metal)
  if (platform === 'darwin' && arch === 'arm64') {
    const usableMetal = Math.round(totalRamBytes * 0.75);
    gpus.push({
      vendor: 'Apple',
      name: `${cpuModel} (Apple Silicon GPU)`,
      vramTotalBytes: usableMetal,
      vramFreeBytes: Math.min(usableMetal, freeRamBytes),
      backend: 'metal',
    });
  }

  // 2. NVIDIA CUDA GPUs via nvidia-smi
  try {
    const { stdout } = await probe('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.free',
      '--format=csv,noheader,nounits',
    ]);
    gpus.push(...parseNvidiaSmiOutput(stdout));
  } catch {
    // No NVIDIA driver / nvidia-smi available
  }

  // 3. Fallback Vulkan check on Linux/Windows when no CUDA GPU found
  let hasVulkan = false;
  if (gpus.length === 0 && (platform === 'linux' || platform === 'win32')) {
    try {
      const { stdout } = await probe('vulkaninfo', ['--summary']);
      if (/GPU\d+|deviceName/i.test(stdout)) {
        hasVulkan = true;
      }
    } catch {
      // vulkaninfo not installed
    }
  }

  let recommendedBackend: AccelerationBackend = 'cpu';
  if (gpus.some((g) => g.backend === 'cuda')) {
    recommendedBackend = 'cuda';
  } else if (gpus.some((g) => g.backend === 'metal')) {
    recommendedBackend = 'metal';
  } else if (hasVulkan) {
    recommendedBackend = 'vulkan';
  }

  return {
    platform,
    arch,
    cpuModel,
    cpuCores,
    totalRamBytes,
    freeRamBytes,
    gpus,
    recommendedBackend,
  };
}
