import { PoCliDatabase } from '../storage/database.js';
import { getLlamaCppInstallDir } from './adapters/llamacpp.js';
import {
  evaluateModelCompatibility,
  recommendModelsForHardware,
} from './compatibility.js';
import { formatBytes } from './hardware.js';
import { LocalModelManager } from './local-manager.js';

export interface LocalTuiReport {
  banner: string;
  detail: string;
}

export async function buildLocalTuiReport(
  args: string[],
  storage: PoCliDatabase,
): Promise<LocalTuiReport> {
  const action = (args[0] ?? 'status').toLowerCase();
  const manager = new LocalModelManager(storage);

  if (action === 'help' || action === '--help' || action === '-h') {
    const detail = [
      '=== /local — Local LLM Inspector (TUI) ===',
      '  /local status              Overview (hardware, llama.cpp, models, running)',
      '  /local hardware            Host OS, CPU, RAM, GPU/VRAM, backend',
      '  /local engine              llama.cpp installation & binary path',
      '  /local list                Locally installed GGUF models',
      '  /local ps                  Currently running llama-server processes',
      '  /local info <model-id>     GGUF metadata & hardware fit for an installed model',
      '',
      'CLI management (downloads/install): pocli local pull | engine install | run | stop',
    ].join('\n');
    return {
      banner: 'ℹ /local [status|hardware|engine|list|ps|info <id>|help]',
      detail,
    };
  }

  if (action === 'hardware' || action === 'hw') {
    const hw = await manager.getHardware();
    const lines = [
      '=== Host Hardware Profile ===',
      `  • OS / Arch : ${hw.platform} (${hw.arch})`,
      `  • CPU       : ${hw.cpuModel} (${hw.cpuCores} cores)`,
      `  • RAM       : ${formatBytes(hw.totalRamBytes)} total (${formatBytes(hw.freeRamBytes)} free)`,
    ];
    if (hw.gpus.length === 0) {
      lines.push('  • GPU       : None detected (CPU mode)');
    } else {
      for (const gpu of hw.gpus) {
        lines.push(
          `  • GPU       : ${gpu.vendor} ${gpu.name} (${formatBytes(gpu.vramTotalBytes)} VRAM, ${gpu.backend})`,
        );
      }
    }
    lines.push(`  • Backend   : ${hw.recommendedBackend.toUpperCase()}`);
    const recs = recommendModelsForHardware(hw, 5);
    if (recs.length > 0) {
      lines.push('');
      lines.push('=== Recommended Models for This Machine ===');
      for (const rec of recs) {
        lines.push(
          `  • ${rec.repoId} (${rec.quant}, ~${formatBytes(rec.approxSizeBytes)}, ${rec.compatibility.tier}) — ${rec.description}`,
        );
      }
    }
    return {
      banner: `✔ Hardware: ${hw.cpuCores} cores, ${formatBytes(hw.totalRamBytes)} RAM, backend=${hw.recommendedBackend.toUpperCase()}`,
      detail: lines.join('\n'),
    };
  }

  if (action === 'engine' || action === 'engines') {
    const st = await manager.engine.status();
    const lines = [
      '=== Local Engine (llama.cpp) ===',
      `  • Installed : ${st.installed ? 'yes' : 'no'}`,
      `  • Version   : ${st.version ?? '-'}`,
      `  • Binary    : ${st.binaryPath ?? getLlamaCppInstallDir()}`,
    ];
    if (!st.installed) {
      lines.push('  • Tip       : Run "pocli local engine install" in terminal');
    }
    return {
      banner: st.installed
        ? `✔ llama.cpp installed (${st.version ?? 'ready'}) at ${st.binaryPath}`
        : `ℹ llama.cpp not installed (run "pocli local engine install" in CLI)`,
      detail: lines.join('\n'),
    };
  }

  if (action === 'list' || action === 'ls') {
    const models = manager.listInstalledModels();
    const lines = [`=== Installed Local GGUF Models (${models.length}) ===`];
    if (models.length === 0) {
      lines.push('  (none installed — run "pocli local pull <repo>" in terminal)');
    } else {
      for (const m of models) {
        lines.push(
          `  • local/${m.id} | ${m.quantization ?? '-'} | ${m.architecture ?? '-'} | ${formatBytes(m.sizeBytes)} | ${m.repoId}`,
        );
      }
    }
    return {
      banner: `ℹ Local models: ${models.length} installed`,
      detail: lines.join('\n'),
    };
  }

  if (action === 'ps') {
    const active = manager.listActiveRuntimes();
    const lines = [`=== Running Local Servers (${active.length}) ===`];
    if (active.length === 0) {
      lines.push('  (none running — run "pocli local run <id>" or assign local/<id> to an agent)');
    } else {
      for (const rt of active) {
        lines.push(
          `  • ${rt.modelId} | pid=${rt.pid} | http://127.0.0.1:${rt.port} | ctx=${rt.ctxSize} | ngl=${rt.gpuLayers}`,
        );
      }
    }
    return {
      banner: `ℹ Running local servers: ${active.length}`,
      detail: lines.join('\n'),
    };
  }

  if (action === 'info') {
    const target = args[1];
    if (!target) {
      return {
        banner: '✖ Usage: /local info <model-id>',
        detail: 'Usage: /local info <model-id>',
      };
    }
    const model = manager.resolveInstalledModel(target);
    if (!model) {
      return {
        banner: `✖ Local model "${target}" is not installed.`,
        detail: `Local model "${target}" is not installed. Run "/local list" to inspect installed models.`,
      };
    }
    const hw = await manager.getHardware();
    const compat = evaluateModelCompatibility({
      sizeBytes: model.sizeBytes,
      gguf: {
        contextLength: model.contextLength,
        blockCount: model.blockCount,
        embeddingLength: model.embeddingLength,
      },
      hardware: hw,
    });
    const rt = manager.listActiveRuntimes().find((r) => r.modelId === model.id);
    const lines = [
      `=== Local Model: local/${model.id} ===`,
      `  • Repo         : ${model.repoId} (${model.fileName})`,
      `  • Format/Arch  : ${model.format.toUpperCase()} / ${model.architecture ?? 'unknown'}`,
      `  • Quantization : ${model.quantization ?? 'unknown'}`,
      `  • Size         : ${formatBytes(model.sizeBytes)}`,
      `  • Context Max  : ${model.contextLength ?? 'unknown'}`,
      `  • Hardware Fit : ${compat.tier.toUpperCase()} (${compat.reasons[0] ?? ''})`,
      `  • Recommended  : --ctx ${compat.recommendedCtxSize} --ngl ${compat.recommendedGpuLayers}`,
      `  • Runtime      : ${rt ? `running (pid=${rt.pid}, port=${rt.port})` : 'stopped'}`,
    ];
    return {
      banner: `✔ local/${model.id}: ${compat.tier} fit, ${formatBytes(model.sizeBytes)} (${rt ? `port ${rt.port}` : 'stopped'})`,
      detail: lines.join('\n'),
    };
  }

  if (action === 'status' || action === 'overview') {
    const [hw, engineSt] = await Promise.all([
      manager.getHardware(),
      manager.engine.status(),
    ]);
    const models = manager.listInstalledModels();
    const active = manager.listActiveRuntimes();
    const lines = [
      '=== Local LLM System Status ===',
      `  • Hardware : ${hw.platform}/${hw.arch}, ${hw.cpuCores} cores, ${formatBytes(hw.totalRamBytes)} RAM, backend=${hw.recommendedBackend.toUpperCase()}`,
      `  • Engine   : llama.cpp ${engineSt.installed ? `installed (${engineSt.version ?? 'ready'})` : 'not installed'}`,
      `  • Models   : ${models.length} installed`,
      `  • Running  : ${active.length} active server(s)`,
    ];
    return {
      banner: `ℹ Local LLM: llama.cpp=${engineSt.installed ? 'ready' : 'missing'}, models=${models.length}, running=${active.length}, backend=${hw.recommendedBackend.toUpperCase()}`,
      detail: lines.join('\n'),
    };
  }

  return {
    banner: `✖ Unknown /local subcommand "${action}". Try /local help.`,
    detail: `Unknown /local subcommand "${action}". Available: status, hardware, engine, list, ps, info <id>, help.`,
  };
}
