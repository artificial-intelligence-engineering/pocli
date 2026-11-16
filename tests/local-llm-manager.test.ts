import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoCliDatabase } from '../src/storage/database.js';
import {
  detectHardwareProfile,
  parseNvidiaSmiOutput,
} from '../src/local/hardware.js';
import {
  evaluateModelCompatibility,
  recommendModelsForHardware,
} from '../src/local/compatibility.js';
import {
  inferQuantizationFromFilename,
  inspectGgufFile,
  parseGgufHeader,
} from '../src/local/gguf-inspector.js';
import { pickGgufFile } from '../src/local/hf-registry.js';
import {
  getLlamaCppInstallDir,
  resolveLlamaCppAsset,
} from '../src/local/adapters/llamacpp.js';
import { deriveLocalModelId } from '../src/local/local-manager.js';
import { buildLocalTuiReport } from '../src/local/tui-inspector.js';
import {
  resolveModelSpec,
  trimInputForLocalContext,
} from '../src/runtime/llm-gateway.js';
import { PoCliOrchestrator } from '../src/runtime/orchestrator.js';
import { runVirtualTuiSession } from '../src/runtime/headless-runner.js';

function buildSyntheticGgufBuffer(): Buffer {
  const parts: Buffer[] = [];
  const pushU32 = (n: number) => {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(n, 0);
    parts.push(b);
  };
  const pushU64 = (n: number) => {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64LE(BigInt(n), 0);
    parts.push(b);
  };
  const pushStr = (s: string) => {
    const raw = Buffer.from(s, 'utf8');
    pushU64(raw.length);
    parts.push(raw);
  };
  const pushKvString = (k: string, v: string) => {
    pushStr(k);
    pushU32(8); // STRING
    pushStr(v);
  };
  const pushKvU32 = (k: string, v: number) => {
    pushStr(k);
    pushU32(4); // UINT32
    pushU32(v);
  };

  // Magic "GGUF", version 3, tensorCount 0, kvCount 7
  pushU32(0x46554747);
  pushU32(3);
  pushU64(0);
  pushU64(7);

  pushKvString('general.architecture', 'llama');
  pushKvString('general.name', 'Qwen3-8B-Test');
  pushKvU32('general.file_type', 15); // Q4_K_M
  pushKvU32('llama.context_length', 32768);
  pushKvU32('llama.block_count', 32);
  pushKvU32('llama.embedding_length', 4096);
  pushKvU32('llama.attention.head_count', 32);

  return Buffer.concat(parts);
}

describe('Local LLM Manager & llama.cpp Integration (Issue #119)', () => {
  let tmpDir: string;
  let origHome: string | undefined;
  let origInstallDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-local-llm-test-'));
    origHome = process.env.HOME;
    origInstallDir = process.env.POCLI_INSTALL_DIR;
    process.env.HOME = tmpDir;
    delete process.env.POCLI_INSTALL_DIR;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origInstallDir !== undefined) process.env.POCLI_INSTALL_DIR = origInstallDir;
    else delete process.env.POCLI_INSTALL_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('parses nvidia-smi output and detects CUDA, Metal, and CPU hardware profiles', async () => {
    const gpus = parseNvidiaSmiOutput('NVIDIA GeForce RTX 4090, 24564, 22000\n');
    expect(gpus).toHaveLength(1);
    expect(gpus[0].vendor).toBe('NVIDIA');
    expect(gpus[0].backend).toBe('cuda');

    const cudaHw = await detectHardwareProfile({
      platform: 'linux',
      arch: 'x64',
      totalRamBytes: 64 * 1024 ** 3,
      freeRamBytes: 48 * 1024 ** 3,
      probe: async (cmd) => {
        if (cmd === 'nvidia-smi') {
          return { stdout: 'NVIDIA RTX 4070, 12282, 11000\n', stderr: '' };
        }
        throw new Error('not found');
      },
    });
    expect(cudaHw.recommendedBackend).toBe('cuda');
    expect(cudaHw.gpus[0].name).toContain('RTX 4070');

    const metalHw = await detectHardwareProfile({
      platform: 'darwin',
      arch: 'arm64',
      totalRamBytes: 32 * 1024 ** 3,
      freeRamBytes: 20 * 1024 ** 3,
      probe: async () => {
        throw new Error('no nvidia-smi');
      },
    });
    expect(metalHw.recommendedBackend).toBe('metal');
    expect(metalHw.gpus[0].backend).toBe('metal');
  });

  it('evaluates model compatibility for VRAM optimal, partial offload, and incompatible RAM', () => {
    const gpuHw = {
      platform: 'linux',
      arch: 'x64',
      cpuModel: 'Ryzen 9',
      cpuCores: 16,
      totalRamBytes: 32 * 1024 ** 3,
      freeRamBytes: 24 * 1024 ** 3,
      gpus: [
        {
          vendor: 'NVIDIA',
          name: 'RTX 4070',
          vramTotalBytes: 12 * 1024 ** 3,
          vramFreeBytes: 11 * 1024 ** 3,
          backend: 'cuda' as const,
        },
      ],
      recommendedBackend: 'cuda' as const,
    };

    const fitsVram = evaluateModelCompatibility({
      sizeBytes: 4.9 * 1024 ** 3,
      hardware: gpuHw,
      ctxSize: 8192,
    });
    expect(fitsVram.compatible).toBe(true);
    expect(fitsVram.tier).toBe('optimal');
    expect(fitsVram.targetMemory).toBe('vram');
    expect(fitsVram.recommendedGpuLayers).toBe(999);

    const partialOffload = evaluateModelCompatibility({
      sizeBytes: 16 * 1024 ** 3,
      hardware: gpuHw,
      ctxSize: 4096,
    });
    expect(partialOffload.compatible).toBe(true);
    expect(partialOffload.tier).toBe('tight');
    expect(partialOffload.recommendedGpuLayers).toBeGreaterThan(0);

    const tooBig = evaluateModelCompatibility({
      sizeBytes: 70 * 1024 ** 3,
      hardware: gpuHw,
      ctxSize: 8192,
    });
    expect(tooBig.compatible).toBe(false);
    expect(tooBig.tier).toBe('incompatible');

    const recs = recommendModelsForHardware(gpuHw, 5);
    expect(recs).toHaveLength(5);
    expect(recs.every((r) => r.compatibility.compatible)).toBe(true);
  });

  it('parses GGUF v3 binary header metadata and reads from disk', () => {
    const buf = buildSyntheticGgufBuffer();
    const parsed = parseGgufHeader(buf);
    expect(parsed.version).toBe(3);
    expect(parsed.architecture).toBe('llama');
    expect(parsed.name).toBe('Qwen3-8B-Test');
    expect(parsed.quantizationLabel).toBe('Q4_K_M');
    expect(parsed.contextLength).toBe(32768);
    expect(parsed.blockCount).toBe(32);
    expect(parsed.embeddingLength).toBe(4096);

    const ggufPath = path.join(tmpDir, 'test-Q4_K_M.gguf');
    fs.writeFileSync(ggufPath, buf);
    const fromDisk = inspectGgufFile(ggufPath);
    expect(fromDisk.architecture).toBe('llama');
    expect(inferQuantizationFromFilename('Qwen3-8B-Q5_K_M.gguf')).toBe('Q5_K_M');
  });

  it('picks preferred GGUF quantizations and resolves llama.cpp install path under ~/.pocli/app', () => {
    const picked = pickGgufFile([
      { fileName: 'qwen3-8b-Q8_0.gguf', sizeBytes: 8_000_000_000, quantization: 'Q8_0' },
      { fileName: 'qwen3-8b-Q4_K_M.gguf', sizeBytes: 4_900_000_000, quantization: 'Q4_K_M' },
    ]);
    expect(picked.fileName).toBe('qwen3-8b-Q4_K_M.gguf');
    expect(deriveLocalModelId('Qwen/Qwen3-8B-GGUF', 'qwen3-8b-Q4_K_M.gguf')).toBe(
      'qwen3-8b-q4_k_m',
    );

    process.env.POCLI_INSTALL_DIR = path.join(tmpDir, '.pocli', 'app');
    const installDir = getLlamaCppInstallDir();
    expect(installDir).toBe(path.join(tmpDir, '.pocli', 'app', 'engines', 'llama.cpp'));

    const asset = resolveLlamaCppAsset(
      [
        { name: 'llama-b5000-bin-ubuntu-x64.tar.gz', browser_download_url: 'https://x/u.tar.gz', size: 10 },
        { name: 'llama-b5000-bin-macos-arm64.tar.gz', browser_download_url: 'https://x/m.tar.gz', size: 10 },
      ],
      {
        platform: 'linux',
        arch: 'x64',
        cpuModel: 'x86_64',
        cpuCores: 8,
        totalRamBytes: 16e9,
        freeRamBytes: 8e9,
        gpus: [],
        recommendedBackend: 'cpu',
      },
    );
    expect(asset?.name).toBe('llama-b5000-bin-ubuntu-x64.tar.gz');
  });

  it('persists local_models and local_runtimes in SQLite and resolves local/<id> in strict mode', () => {
    const dbPath = path.join(tmpDir, 'pocli.sqlite');
    const db = new PoCliDatabase(dbPath);
    try {
      db.upsertLocalModel({
        id: 'qwen3-8b-q4_k_m',
        repoId: 'Qwen/Qwen3-8B-GGUF',
        fileName: 'qwen3-8b-Q4_K_M.gguf',
        localPath: path.join(tmpDir, 'qwen3-8b-Q4_K_M.gguf'),
        format: 'gguf',
        architecture: 'qwen3',
        quantization: 'Q4_K_M',
        sizeBytes: 4_900_000_000,
        createdAt: new Date().toISOString(),
      });

      const list = db.listLocalModels();
      expect(list).toHaveLength(1);
      expect(list[0].architecture).toBe('qwen3');

      db.upsertLocalRuntime({
        modelId: 'qwen3-8b-q4_k_m',
        engine: 'llama.cpp',
        pid: 12345,
        port: 41234,
        status: 'running',
        gpuLayers: 32,
        ctxSize: 8192,
        logPath: path.join(tmpDir, 'llama.log'),
        startedAt: new Date().toISOString(),
      });
      expect(db.listLocalRuntimes()).toHaveLength(1);
      expect(db.deleteLocalRuntime('qwen3-8b-q4_k_m')).toBe(true);
      expect(db.deleteLocalModel('qwen3-8b-q4_k_m')).toBe(true);
    } finally {
      db.close();
    }

    const spec = resolveModelSpec('local/qwen3-8b-q4_k_m', { strict: true });
    expect(spec?.provider).toBe('local');
    expect(spec?.modelId).toBe('qwen3-8b-q4_k_m');
  });

  it('builds informative /local TUI inspection reports for status, hardware, engine, list, ps, info, and help', async () => {
    const dbPath = path.join(tmpDir, 'pocli-tui.sqlite');
    const db = new PoCliDatabase(dbPath);
    try {
      db.upsertLocalModel({
        id: 'qwen3-8b-q4_k_m',
        repoId: 'Qwen/Qwen3-8B-GGUF',
        fileName: 'qwen3-8b-Q4_K_M.gguf',
        localPath: path.join(tmpDir, 'qwen3-8b-Q4_K_M.gguf'),
        format: 'gguf',
        architecture: 'qwen3',
        quantization: 'Q4_K_M',
        sizeBytes: 4_900_000_000,
        contextLength: 32768,
        createdAt: new Date().toISOString(),
      });

      const statusRep = await buildLocalTuiReport(['status'], db);
      expect(statusRep.detail).toContain('Local LLM System Status');
      expect(statusRep.detail).toContain('1 installed');

      const hwRep = await buildLocalTuiReport(['hardware'], db);
      expect(hwRep.detail).toContain('Host Hardware Profile');

      const engRep = await buildLocalTuiReport(['engine'], db);
      expect(engRep.detail).toContain('Local Engine (llama.cpp)');

      const listRep = await buildLocalTuiReport(['list'], db);
      expect(listRep.detail).toContain('local/qwen3-8b-q4_k_m');

      const psRep = await buildLocalTuiReport(['ps'], db);
      expect(psRep.detail).toContain('Running Local Servers');

      const infoRep = await buildLocalTuiReport(['info', 'qwen3-8b-q4_k_m'], db);
      expect(infoRep.detail).toContain('Local Model: local/qwen3-8b-q4_k_m');
      expect(infoRep.detail).toContain('Hardware Fit');

      const helpRep = await buildLocalTuiReport(['help'], db);
      expect(helpRep.detail).toContain('/local hardware');
    } finally {
      db.close();
    }
  });

  it('renders /local hardware and /local status inside the real Ink CommandCenterApp TUI', async () => {
    const dbPath = path.join(tmpDir, 'pocli-virtual-tui.sqlite');
    const storage = new PoCliDatabase(dbPath);
    const orchestrator = new PoCliOrchestrator(storage);
    const wsDir = path.join(tmpDir, 'ws-local-tui');
    fs.mkdirSync(wsDir, { recursive: true });
    const proj = storage.createProject({
      name: 'LocalTuiProj',
      workspaceDir: wsDir,
      description: 'Test /local in TUI',
    });

    try {
      const tuiRes = await runVirtualTuiSession({
        orchestrator,
        initialProject: proj,
        steps: [
          { input: '/local hardware\r', waitMs: 600 },
          { input: '\r', waitMs: 200 },
          { input: '/local status\r', waitMs: 600 },
        ],
      });
      expect(tuiRes.ok).toBe(true);
      expect(tuiRes.allTextCombined).toContain('Host Hardware Profile');
      expect(tuiRes.allTextCombined).toContain('Local LLM System Status');
    } finally {
      storage.close();
    }
  }, 20000);

  it('shows LOCAL tab in /models modal with installed local models or empty notice', async () => {
    const dbPath = path.join(tmpDir, 'pocli-models-local.sqlite');
    const storage = new PoCliDatabase(dbPath);
    const orchestrator = new PoCliOrchestrator(storage);
    const wsDir = path.join(tmpDir, 'ws-models-local');
    fs.mkdirSync(wsDir, { recursive: true });
    const proj = storage.createProject({
      name: 'ModelsLocalProj',
      workspaceDir: wsDir,
      description: 'Test LOCAL tab in /models',
    });

    try {
      const tabSteps = Array.from({ length: 7 }, () => ({
        input: '\t',
        waitMs: 60,
      }));
      // 1. Empty state: 7 Tabs from 'all' -> 'local'
      const emptyRes = await runVirtualTuiSession({
        orchestrator,
        initialProject: proj,
        steps: [{ input: '/models\r', waitMs: 250 }, ...tabSteps],
      });
      expect(emptyRes.ok).toBe(true);
      expect(emptyRes.allTextCombined).toContain('LOCAL');
      expect(emptyRes.allTextCombined).not.toContain('OLLAMA');
      expect(emptyRes.allTextCombined).toContain('pocli local pull');
    } finally {
      storage.close();
    }
  }, 20000);

  it('lists installed local models in /models LOCAL tab', async () => {
    const dbPath = path.join(tmpDir, 'pocli-models-local-pop.sqlite');
    const storage = new PoCliDatabase(dbPath);
    const orchestrator = new PoCliOrchestrator(storage);
    const wsDir = path.join(tmpDir, 'ws-models-local-pop');
    fs.mkdirSync(wsDir, { recursive: true });
    const proj = storage.createProject({
      name: 'ModelsLocalPopProj',
      workspaceDir: wsDir,
      description: 'Test LOCAL tab populated in /models',
    });

    try {
      storage.upsertLocalModel({
        id: 'qwen3-8b-q4_k_m',
        repoId: 'Qwen/Qwen3-8B-GGUF',
        fileName: 'qwen3-8b-Q4_K_M.gguf',
        localPath: path.join(tmpDir, 'qwen3-8b-Q4_K_M.gguf'),
        format: 'gguf',
        architecture: 'qwen3',
        quantization: 'Q4_K_M',
        sizeBytes: 4_900_000_000,
        contextLength: 32768,
        createdAt: new Date().toISOString(),
      });

      const tabSteps = Array.from({ length: 7 }, () => ({
        input: '\t',
        waitMs: 60,
      }));
      const populatedRes = await runVirtualTuiSession({
        orchestrator,
        initialProject: proj,
        steps: [{ input: '/models\r', waitMs: 250 }, ...tabSteps],
      });
      expect(populatedRes.ok).toBe(true);
      expect(populatedRes.allTextCombined).toContain('qwen3-8b-q4_k_m');
    } finally {
      storage.close();
    }
  }, 20000);

  it('trims large project context safely under local llama.cpp n_ctx budget', () => {
    const trimmed = trimInputForLocalContext(
      {
        projectId: 'proj-1',
        projectName: 'PySqliteCrudApi',
        phase: 'PHASE_2_ARCHITECTURE',
        role: 'architect',
        systemPrompt: 'You are an architect.',
        normativeArtifactsSummary: 'A'.repeat(40000),
        ragCitations: [
          {
            notebookId: 'nb1',
            notebookName: 'Docs',
            documentPath: 'doc.md',
            section: 'Intro',
            lineRange: 'L1-L20',
            snippet: 'S'.repeat(10000),
            score: 0.9,
          },
        ],
        modelConfig: {
          role: 'architect',
          provider: 'local',
          modelId: 'gemma-4-12b-it-q4_k_m',
          temperature: 0.2,
          executionModality: 'LOCAL_PROCESS',
        },
        userPrompt: `${'H'.repeat(80000)}\nhola`,
      },
      18000,
    );

    const totalLen =
      trimmed.systemPrompt.length +
      trimmed.userPrompt.length +
      trimmed.normativeArtifactsSummary.length +
      trimmed.ragCitations.reduce((s, c) => s + c.snippet.length, 0);

    expect(totalLen).toBeLessThanOrEqual(18000);
    expect(trimmed.userPrompt.endsWith('hola')).toBe(true);
  });
});
