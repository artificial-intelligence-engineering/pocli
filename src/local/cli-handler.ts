import path from 'node:path';
import { c } from '../core/colors.js';
import { resolveDefaultWorkDir } from '../core/i18n.js';
import { PoCliDatabase } from '../storage/database.js';
import { getLlamaCppInstallDir } from './adapters/llamacpp.js';
import { evaluateModelCompatibility } from './compatibility.js';
import { formatBytes } from './hardware.js';
import { getHfModelInfo, searchHfGgufModels } from './hf-registry.js';
import { LocalModelManager } from './local-manager.js';

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

export function printLocalHelp(): void {
  console.log(
    [
      c.bold('pocli local — Local AI Model & llama.cpp Manager'),
      '',
      `  ${c.cyan('pocli local hardware')}                        ${c.dim('Inspect OS, CPU, RAM, GPU/VRAM, and acceleration backend')}`,
      `  ${c.cyan('pocli local search <query> [--limit N]')}      ${c.dim('Search GGUF models on Hugging Face Hub')}`,
      `  ${c.cyan('pocli local info <repo>')}                     ${c.dim('List GGUF files, sizes, and hardware fit for a repo')}`,
      `  ${c.cyan('pocli local pull <repo> [--quant Q4_K_M]')}    ${c.dim('Download GGUF model (resumable) and inspect metadata')}`,
      `  ${c.cyan('pocli local list')}                            ${c.dim('List locally installed GGUF models')}`,
      `  ${c.cyan('pocli local remove <model-id>')}               ${c.dim('Stop if running and remove a local model')}`,
      `  ${c.cyan('pocli local engine [status|install]')}         ${c.dim('Check or install llama.cpp (llama-server) into ~/.pocli/app')}`,
      `  ${c.cyan('pocli local run <model-id> [--prompt "..."]')} ${c.dim('Start llama-server (and optionally run a prompt)')}`,
      `  ${c.cyan('pocli local stop <model-id>')}                 ${c.dim('Stop a running local model server')}`,
      `  ${c.cyan('pocli local ps')}                              ${c.dim('List currently running local model servers')}`,
    ].join('\n'),
  );
}

export async function handleLocalCliCommand(args: string[]): Promise<number> {
  const action = (args[0] ?? 'help').toLowerCase();
  if (action === 'help' || action === '--help' || action === '-h') {
    printLocalHelp();
    return 0;
  }

  const db = new PoCliDatabase(path.join(resolveDefaultWorkDir(), 'pocli.sqlite'));
  const manager = new LocalModelManager(db);

  try {
    if (action === 'hardware' || action === 'hw') {
      const hw = await manager.getHardware();
      console.log(c.bold('\n=== Host Hardware Profile ==='));
      console.log(`  • OS / Arch   : ${hw.platform} (${hw.arch})`);
      console.log(`  • CPU         : ${hw.cpuModel} (${hw.cpuCores} cores)`);
      console.log(
        `  • RAM         : ${formatBytes(hw.totalRamBytes)} total (${formatBytes(hw.freeRamBytes)} free)`,
      );
      if (hw.gpus.length === 0) {
        console.log(`  • GPU         : ${c.dim('None detected (CPU mode)')}`);
      } else {
        for (const gpu of hw.gpus) {
          console.log(
            `  • GPU         : ${gpu.vendor} ${gpu.name} (${formatBytes(gpu.vramTotalBytes)} VRAM, backend=${gpu.backend})`,
          );
        }
      }
      console.log(`  • Backend     : ${c.green(hw.recommendedBackend.toUpperCase())}\n`);
      return 0;
    }

    if (action === 'search') {
      const query = args[1];
      if (!query) {
        console.error('Usage: pocli local search <query> [--limit 10]');
        return 1;
      }
      const limit = Number(getFlagValue(args, '--limit') ?? 10) || 10;
      const results = await searchHfGgufModels(query, limit);
      console.log(c.bold(`\n=== Hugging Face GGUF Models matching "${query}" ===`));
      if (results.length === 0) {
        console.log('  (no results)');
        return 0;
      }
      for (const m of results) {
        console.log(
          `  • ${c.cyan(m.repoId.padEnd(46))} ↓ ${String(m.downloads).padStart(7)}  ★ ${m.likes}`,
        );
      }
      console.log('');
      return 0;
    }

    if (action === 'info') {
      const repoId = args[1];
      if (!repoId) {
        console.error('Usage: pocli local info <owner/repo>');
        return 1;
      }
      const [info, hw] = await Promise.all([
        getHfModelInfo(repoId),
        manager.getHardware(),
      ]);
      console.log(c.bold(`\n=== ${info.repoId} (↓ ${info.downloads}, ★ ${info.likes}) ===`));
      if (info.ggufFiles.length === 0) {
        console.log('  No .gguf files found.');
        return 0;
      }
      for (const f of info.ggufFiles) {
        const sizeStr = f.sizeBytes ? formatBytes(f.sizeBytes) : 'unknown';
        const compat = f.sizeBytes
          ? evaluateModelCompatibility({ sizeBytes: f.sizeBytes, hardware: hw })
          : undefined;
        const badge = compat
          ? compat.tier === 'optimal'
            ? c.green('[optimal]')
            : compat.tier === 'tight'
              ? c.yellow('[tight]')
              : c.red('[too large]')
          : '';
        console.log(
          `  • ${f.fileName.padEnd(45)} ${(f.quantization ?? '-').padEnd(8)} ${sizeStr.padStart(10)}  ${badge}`,
        );
      }
      console.log('');
      return 0;
    }

    if (action === 'pull') {
      const repoId = args[1];
      if (!repoId) {
        console.error('Usage: pocli local pull <owner/repo> [--quant Q4_K_M] [--file <name>]');
        return 1;
      }
      const quant = getFlagValue(args, '--quant');
      const file = getFlagValue(args, '--file');
      let lastPct = -1;
      console.log(`Downloading GGUF model from ${c.cyan(repoId)}...`);
      const { model, compatibility } = await manager.pullModel({
        repoId,
        quant,
        file,
        onProgress: (dl, total) => {
          if (!total) return;
          const pct = Math.floor((dl / total) * 100);
          if (pct >= lastPct + 10 || pct === 100) {
            lastPct = pct;
            process.stdout.write(
              `\r  Progress: ${pct}% (${formatBytes(dl)} / ${formatBytes(total)})`,
            );
          }
        },
      });
      if (lastPct >= 0) process.stdout.write('\n');
      console.log(
        `${c.green('✔')} Installed ${c.bold(model.id)} (${formatBytes(model.sizeBytes)}, quant=${model.quantization ?? 'unknown'}, arch=${model.architecture ?? 'unknown'})`,
      );
      console.log(`  • Path   : ${model.localPath}`);
      console.log(`  • Fit    : ${compatibility.tier} (${compatibility.reasons[0] ?? ''})`);
      console.log(
        `  • Assign : ${c.cyan(`pocli models developer local/${model.id}`)}`,
      );
      return 0;
    }

    if (action === 'list' || action === 'ls') {
      const models = manager.listInstalledModels();
      console.log(c.bold('\n=== Installed Local GGUF Models ==='));
      if (models.length === 0) {
        console.log('  (none installed — run "pocli local search <query>" and "pocli local pull <repo>")\n');
        return 0;
      }
      for (const m of models) {
        console.log(
          `  • ${c.cyan(m.id.padEnd(34))} ${(m.quantization ?? '-').padEnd(8)} ${(m.architecture ?? '-').padEnd(10)} ${formatBytes(m.sizeBytes).padStart(9)}  ${c.dim(m.repoId)}`,
        );
      }
      console.log('');
      return 0;
    }

    if (action === 'remove' || action === 'rm') {
      const id = args[1];
      if (!id) {
        console.error('Usage: pocli local remove <model-id>');
        return 1;
      }
      const removed = await manager.removeModel(id);
      if (!removed) {
        console.error(`${c.red('✖')} Local model "${id}" not found.`);
        return 1;
      }
      console.log(`${c.green('✔')} Removed local model "${id}".`);
      return 0;
    }

    if (action === 'engine' || action === 'engines') {
      const sub = (args[1] ?? 'status').toLowerCase();
      if (sub === 'install') {
        const force = args.includes('--force') || args.includes('-f');
        console.log(`Installing llama.cpp into ${getLlamaCppInstallDir()}...`);
        const res = await manager.engine.install({ force });
        console.log(
          `${c.green('✔')} Installed llama.cpp (${res.version}) at ${res.binaryPath}`,
        );
        return 0;
      }
      const st = await manager.engine.status();
      console.log(c.bold('\n=== Local Inference Engine (llama.cpp) ==='));
      console.log(`  • Installed : ${st.installed ? c.green('yes') : c.yellow('no')}`);
      console.log(`  • Version   : ${st.version ?? '-'}`);
      console.log(`  • Binary    : ${st.binaryPath ?? getLlamaCppInstallDir()}`);
      console.log('');
      return 0;
    }

    if (action === 'run') {
      const id = args[1];
      if (!id) {
        console.error('Usage: pocli local run <model-id> [--ctx 8192] [--ngl N] [--prompt "..."]');
        return 1;
      }
      const ctxStr = getFlagValue(args, '--ctx');
      const nglStr = getFlagValue(args, '--ngl');
      const prompt = getFlagValue(args, '--prompt') ?? getFlagValue(args, '-p');

      const rt = await manager.startModel(id, {
        ctxSize: ctxStr ? Number(ctxStr) : undefined,
        gpuLayers: nglStr !== undefined && nglStr !== 'auto' ? Number(nglStr) : undefined,
      });

      console.log(
        `${c.green('✔')} Running ${c.bold(rt.modelId)} on http://127.0.0.1:${rt.port} (pid=${rt.pid}, ctx=${rt.ctxSize}, ngl=${rt.gpuLayers})`,
      );

      if (prompt) {
        const res = await manager.engine.generate({
          modelId: rt.modelId,
          messages: [{ role: 'user', content: prompt }],
          onToken: (tok) => process.stdout.write(tok),
        });
        process.stdout.write('\n');
        console.log(c.dim(`[${res.latencyMs} ms]`));
      }
      return 0;
    }

    if (action === 'stop') {
      const id = args[1];
      if (!id) {
        console.error('Usage: pocli local stop <model-id>');
        return 1;
      }
      const stopped = await manager.stopModel(id);
      console.log(
        stopped
          ? `${c.green('✔')} Stopped "${id}".`
          : `${c.yellow('ℹ')} "${id}" was not running.`,
      );
      return 0;
    }

    if (action === 'ps') {
      const active = manager.listActiveRuntimes();
      console.log(c.bold('\n=== Running Local Model Servers ==='));
      if (active.length === 0) {
        console.log('  (none running)\n');
        return 0;
      }
      for (const rt of active) {
        console.log(
          `  • ${c.cyan(rt.modelId.padEnd(32))} pid=${rt.pid}  port=${rt.port}  ctx=${rt.ctxSize}  ngl=${rt.gpuLayers}`,
        );
      }
      console.log('');
      return 0;
    }

    console.error(`Unknown local subcommand "${action}". Run "pocli local --help".`);
    return 1;
  } finally {
    db.close();
  }
}
