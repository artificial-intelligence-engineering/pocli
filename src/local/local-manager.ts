import fs from 'node:fs';
import path from 'node:path';
import { resolveDefaultWorkDir } from '../core/i18n.js';
import { PoCliDatabase } from '../storage/database.js';
import { LlamaCppAdapter, isProcessAlive } from './adapters/llamacpp.js';
import { evaluateModelCompatibility } from './compatibility.js';
import {
  CompatibilityReport,
  HardwareProfile,
  LocalModelRecord,
  LocalRuntimeRecord,
} from './contracts.js';
import { inspectGgufFile } from './gguf-inspector.js';
import { detectHardwareProfile } from './hardware.js';
import { downloadHfFile, getHfModelInfo, pickGgufFile } from './hf-registry.js';

export function getLocalModelsDir(): string {
  return path.join(resolveDefaultWorkDir(), 'models');
}

export function deriveLocalModelId(repoId: string, fileName: string): string {
  const base = path.basename(fileName, '.gguf');
  const repoShort = (repoId.split('/').pop() ?? repoId).replace(/-gguf$/i, '');
  const raw = base.toLowerCase().includes(repoShort.toLowerCase())
    ? base
    : `${repoShort}-${base}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class LocalModelManager {
  public readonly engine: LlamaCppAdapter;

  constructor(private readonly storage: PoCliDatabase) {
    this.engine = new LlamaCppAdapter(storage);
  }

  async getHardware(): Promise<HardwareProfile> {
    return detectHardwareProfile();
  }

  resolveInstalledModel(idOrQuery: string): LocalModelRecord | undefined {
    const exact = this.storage.getLocalModel(idOrQuery);
    if (exact) return exact;
    const lower = idOrQuery.toLowerCase();
    return this.storage
      .listLocalModels()
      .find(
        (m) =>
          m.id.toLowerCase() === lower ||
          m.repoId.toLowerCase() === lower ||
          m.fileName.toLowerCase() === lower,
      );
  }

  async pullModel(params: {
    repoId: string;
    file?: string;
    quant?: string;
    onProgress?: (downloaded: number, total?: number) => void;
  }): Promise<{
    model: LocalModelRecord;
    compatibility: CompatibilityReport;
  }> {
    const info = await getHfModelInfo(params.repoId);
    const chosen = pickGgufFile(info.ggufFiles, {
      file: params.file,
      quant: params.quant,
    });

    const id = deriveLocalModelId(info.repoId, chosen.fileName);
    const destDir = path.join(getLocalModelsDir(), info.repoId.replace(/\//g, '__'));
    const destPath = path.join(destDir, path.basename(chosen.fileName));

    const dl = await downloadHfFile({
      repoId: info.repoId,
      fileName: chosen.fileName,
      destPath,
      onProgress: params.onProgress,
    });

    let gguf;
    try {
      gguf = inspectGgufFile(dl.destPath);
    } catch {
      gguf = undefined;
    }

    const model: LocalModelRecord = {
      id,
      repoId: info.repoId,
      fileName: path.basename(chosen.fileName),
      localPath: dl.destPath,
      format: 'gguf',
      architecture: gguf?.architecture,
      quantization: gguf?.quantizationLabel ?? chosen.quantization,
      sizeBytes: dl.sizeBytes,
      sha256: dl.sha256,
      contextLength: gguf?.contextLength,
      blockCount: gguf?.blockCount,
      embeddingLength: gguf?.embeddingLength,
      createdAt: new Date().toISOString(),
    };
    this.storage.upsertLocalModel(model);

    const hardware = await detectHardwareProfile();
    const compatibility = evaluateModelCompatibility({
      sizeBytes: model.sizeBytes,
      gguf,
      hardware,
    });

    return { model, compatibility };
  }

  listInstalledModels(): LocalModelRecord[] {
    return this.storage.listLocalModels();
  }

  async removeModel(idOrQuery: string): Promise<boolean> {
    const model = this.resolveInstalledModel(idOrQuery);
    if (!model) return false;
    await this.engine.stop(model.id);
    if (fs.existsSync(model.localPath)) {
      fs.rmSync(model.localPath, { force: true });
    }
    return this.storage.deleteLocalModel(model.id);
  }

  listActiveRuntimes(): LocalRuntimeRecord[] {
    const all = this.storage.listLocalRuntimes();
    const active: LocalRuntimeRecord[] = [];
    for (const rt of all) {
      if (isProcessAlive(rt.pid)) {
        active.push(rt);
      } else {
        this.storage.deleteLocalRuntime(rt.modelId);
      }
    }
    return active;
  }

  async startModel(
    idOrQuery: string,
    options?: { ctxSize?: number; gpuLayers?: number },
  ): Promise<LocalRuntimeRecord> {
    const model = this.resolveInstalledModel(idOrQuery);
    if (!model) {
      throw new Error(
        `Local model "${idOrQuery}" is not installed. Run "pocli local pull <repo>" first.`,
      );
    }

    if (!(await this.engine.isInstalled())) {
      await this.engine.install();
    }

    const hardware = await detectHardwareProfile();
    const compat = evaluateModelCompatibility({
      sizeBytes: model.sizeBytes,
      gguf: {
        contextLength: model.contextLength,
        blockCount: model.blockCount,
        embeddingLength: model.embeddingLength,
      },
      hardware,
      ctxSize: options?.ctxSize,
    });

    return this.engine.start({
      modelId: model.id,
      modelPath: model.localPath,
      ctxSize: options?.ctxSize ?? compat.recommendedCtxSize,
      gpuLayers: options?.gpuLayers ?? compat.recommendedGpuLayers,
    });
  }

  async stopModel(idOrQuery: string): Promise<boolean> {
    const model = this.resolveInstalledModel(idOrQuery);
    return this.engine.stop(model?.id ?? idOrQuery);
  }
}
