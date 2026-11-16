import {
  CompatibilityReport,
  CompatibilityTier,
  GgufMetadata,
  HardwareProfile,
} from './contracts.js';
import { formatBytes } from './hardware.js';

const MIB = 1024 * 1024;
const RUNTIME_OVERHEAD_BYTES = 512 * MIB;

/**
 * Estimates KV cache memory in bytes for FP16 KV cache at the given context length.
 * Formula: 2 (K+V) * n_layers * n_kv_heads * head_dim * ctx_size * 2 bytes (fp16)
 */
export function estimateKvCacheBytes(
  ctxSize: number,
  gguf?: Partial<GgufMetadata>,
  weightsBytes = 0,
): number {
  const layers = gguf?.blockCount;
  const emb = gguf?.embeddingLength;
  const heads = gguf?.headCount;
  const kvHeads = gguf?.headCountKv ?? heads;

  if (layers && emb && heads && kvHeads && heads > 0) {
    const headDim = Math.floor(emb / heads);
    return Math.round(2 * layers * kvHeads * headDim * ctxSize * 2);
  }

  // Conservative heuristic when GGUF metadata is not yet available (pre-download):
  // ~128 MiB per 1K context for ~7B-14B, scaled gently by weights size.
  const scale = Math.max(0.5, Math.min(4, weightsBytes / (4 * 1024 * MIB) || 1));
  return Math.round((ctxSize / 1024) * 96 * MIB * scale);
}

/**
 * Evaluates whether a GGUF model fits in GPU VRAM (preferred) or system RAM,
 * accounting for weights, KV cache at target context length, and runtime overhead.
 */
export function evaluateModelCompatibility(params: {
  sizeBytes: number;
  gguf?: Partial<GgufMetadata>;
  hardware: HardwareProfile;
  ctxSize?: number;
}): CompatibilityReport {
  const { sizeBytes, gguf, hardware } = params;
  const ctxSize = Math.min(
    params.ctxSize ?? 8192,
    gguf?.contextLength ?? params.ctxSize ?? 8192,
  );

  const weightsBytes = Math.max(0, sizeBytes);
  const kvCacheBytes = estimateKvCacheBytes(ctxSize, gguf, weightsBytes);
  const overheadBytes = RUNTIME_OVERHEAD_BYTES;
  const totalRequiredBytes = weightsBytes + kvCacheBytes + overheadBytes;

  const primaryGpu = hardware.gpus[0];
  const totalVram = hardware.gpus.reduce((sum, g) => sum + g.vramTotalBytes, 0);
  const reasons: string[] = [];

  if (primaryGpu && totalVram > 0) {
    if (totalRequiredBytes <= totalVram * 0.9) {
      reasons.push(
        `Fits comfortably in GPU VRAM (${formatBytes(totalRequiredBytes)} required vs ${formatBytes(totalVram)} VRAM).`,
      );
      return {
        compatible: true,
        tier: 'optimal',
        weightsBytes,
        kvCacheBytes,
        overheadBytes,
        totalRequiredBytes,
        availableMemoryBytes: totalVram,
        targetMemory: 'vram',
        recommendedGpuLayers: 999,
        recommendedCtxSize: ctxSize,
        reasons,
      };
    }

    // Partial GPU offload + RAM spillover
    if (totalRequiredBytes <= hardware.totalRamBytes * 0.85) {
      const totalLayers = gguf?.blockCount ?? 32;
      const vramForWeights = Math.max(0, totalVram - kvCacheBytes - overheadBytes);
      const ratio = weightsBytes > 0 ? Math.min(1, vramForWeights / weightsBytes) : 0;
      const gpuLayers = Math.max(0, Math.floor(totalLayers * ratio));
      reasons.push(
        `Exceeds GPU VRAM (${formatBytes(totalVram)}); partial offload (${gpuLayers} GPU layers) + system RAM.`,
      );
      return {
        compatible: true,
        tier: 'tight',
        weightsBytes,
        kvCacheBytes,
        overheadBytes,
        totalRequiredBytes,
        availableMemoryBytes: hardware.totalRamBytes,
        targetMemory: 'ram',
        recommendedGpuLayers: gpuLayers,
        recommendedCtxSize: ctxSize,
        reasons,
      };
    }
  }

  // CPU / System RAM evaluation
  const usableRam = hardware.totalRamBytes * 0.82;
  let tier: CompatibilityTier = 'incompatible';
  let compatible = false;

  if (totalRequiredBytes <= hardware.totalRamBytes * 0.65) {
    tier = 'optimal';
    compatible = true;
    reasons.push(
      `Fits in system RAM for CPU execution (${formatBytes(totalRequiredBytes)} required vs ${formatBytes(hardware.totalRamBytes)} RAM).`,
    );
  } else if (totalRequiredBytes <= usableRam) {
    tier = 'tight';
    compatible = true;
    reasons.push(
      `Tight fit in system RAM (${formatBytes(totalRequiredBytes)} required vs ${formatBytes(hardware.totalRamBytes)} RAM); consider a smaller quant or lower --ctx.`,
    );
  } else {
    reasons.push(
      `Insufficient memory: requires ${formatBytes(totalRequiredBytes)} (weights + KV cache + overhead), system has ${formatBytes(hardware.totalRamBytes)} RAM.`,
    );
  }

  return {
    compatible,
    tier,
    weightsBytes,
    kvCacheBytes,
    overheadBytes,
    totalRequiredBytes,
    availableMemoryBytes: hardware.totalRamBytes,
    targetMemory: 'ram',
    recommendedGpuLayers: 0,
    recommendedCtxSize: ctxSize,
    reasons,
  };
}

export interface RecommendedModelCandidate {
  repoId: string;
  quant: string;
  approxSizeBytes: number;
  description: string;
}

export interface HardwareModelRecommendation extends RecommendedModelCandidate {
  compatibility: CompatibilityReport;
}

const GIB = 1024 ** 3;

const POPULAR_GGUF_CANDIDATES: RecommendedModelCandidate[] = [
  {
    repoId: 'unsloth/Qwen3.8-27B-GGUF',
    quant: 'Q4_K_M',
    approxSizeBytes: Math.round(16.5 * GIB),
    description: 'Frontier 27B reasoning & coding',
  },
  {
    repoId: 'unsloth/gemma-4-12b-it-GGUF',
    quant: 'Q4_K_M',
    approxSizeBytes: Math.round(7.4 * GIB),
    description: 'Strong 12B general & instruction model',
  },
  {
    repoId: 'Qwen/Qwen3-8B-GGUF',
    quant: 'Q4_K_M',
    approxSizeBytes: Math.round(5.0 * GIB),
    description: 'Balanced 8B reasoning & tool use',
  },
  {
    repoId: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    quant: 'Q4_K_M',
    approxSizeBytes: Math.round(4.7 * GIB),
    description: 'Dedicated 7B coding specialist',
  },
  {
    repoId: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    quant: 'Q4_K_M',
    approxSizeBytes: Math.round(4.9 * GIB),
    description: 'Fast 8B general-purpose assistant',
  },
  {
    repoId: 'unsloth/Qwen3.5-4B-GGUF',
    quant: 'Q4_K_M',
    approxSizeBytes: Math.round(2.7 * GIB),
    description: 'Lightweight 4B fast CPU/laptop model',
  },
  {
    repoId: 'Qwen/Qwen3-4B-GGUF',
    quant: 'Q4_K_M',
    approxSizeBytes: Math.round(2.5 * GIB),
    description: 'Compact 4B general reasoning',
  },
  {
    repoId: 'Qwen/Qwen2.5-Coder-3B-Instruct-GGUF',
    quant: 'Q4_K_M',
    approxSizeBytes: Math.round(2.1 * GIB),
    description: 'Ultra-light 3B coding model',
  },
];

/**
 * Recommends up to `count` popular GGUF models that fit the detected hardware.
 */
export function recommendModelsForHardware(
  hardware: HardwareProfile,
  count = 5,
): HardwareModelRecommendation[] {
  const evaluated = POPULAR_GGUF_CANDIDATES.map((cand) => ({
    ...cand,
    compatibility: evaluateModelCompatibility({
      sizeBytes: cand.approxSizeBytes,
      hardware,
      ctxSize: 4096,
    }),
  })).filter((item) => item.compatibility.compatible);

  evaluated.sort((a, b) => {
    if (a.compatibility.tier !== b.compatibility.tier) {
      return a.compatibility.tier === 'optimal' ? -1 : 1;
    }
    return b.approxSizeBytes - a.approxSizeBytes;
  });

  return evaluated.slice(0, count);
}
