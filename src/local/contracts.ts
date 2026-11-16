import { z } from 'zod';

export const AccelerationBackendSchema = z.enum([
  'cuda',
  'vulkan',
  'metal',
  'rocm',
  'cpu',
]);
export type AccelerationBackend = z.infer<typeof AccelerationBackendSchema>;

export const GpuDeviceSchema = z.object({
  vendor: z.string(),
  name: z.string(),
  vramTotalBytes: z.number().nonnegative(),
  vramFreeBytes: z.number().nonnegative(),
  backend: AccelerationBackendSchema,
});
export type GpuDevice = z.infer<typeof GpuDeviceSchema>;

export const HardwareProfileSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  cpuModel: z.string(),
  cpuCores: z.number().int().positive(),
  totalRamBytes: z.number().positive(),
  freeRamBytes: z.number().nonnegative(),
  gpus: z.array(GpuDeviceSchema),
  recommendedBackend: AccelerationBackendSchema,
});
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;

export const GgufMetadataSchema = z.object({
  version: z.number().int().positive(),
  tensorCount: z.number().int().nonnegative(),
  kvCount: z.number().int().nonnegative(),
  architecture: z.string().optional(),
  name: z.string().optional(),
  contextLength: z.number().int().positive().optional(),
  blockCount: z.number().int().positive().optional(),
  embeddingLength: z.number().int().positive().optional(),
  headCount: z.number().int().positive().optional(),
  headCountKv: z.number().int().positive().optional(),
  fileType: z.number().int().nonnegative().optional(),
  quantizationLabel: z.string().optional(),
});
export type GgufMetadata = z.infer<typeof GgufMetadataSchema>;

export const CompatibilityTierSchema = z.enum([
  'optimal',
  'tight',
  'incompatible',
]);
export type CompatibilityTier = z.infer<typeof CompatibilityTierSchema>;

export const CompatibilityReportSchema = z.object({
  compatible: z.boolean(),
  tier: CompatibilityTierSchema,
  weightsBytes: z.number().nonnegative(),
  kvCacheBytes: z.number().nonnegative(),
  overheadBytes: z.number().nonnegative(),
  totalRequiredBytes: z.number().nonnegative(),
  availableMemoryBytes: z.number().nonnegative(),
  targetMemory: z.enum(['vram', 'ram']),
  recommendedGpuLayers: z.number().int().nonnegative(),
  recommendedCtxSize: z.number().int().positive(),
  reasons: z.array(z.string()),
});
export type CompatibilityReport = z.infer<typeof CompatibilityReportSchema>;

export interface LocalModelRecord {
  id: string;
  repoId: string;
  fileName: string;
  localPath: string;
  format: 'gguf' | 'safetensors' | 'onnx';
  architecture?: string;
  quantization?: string;
  sizeBytes: number;
  sha256?: string;
  contextLength?: number;
  blockCount?: number;
  embeddingLength?: number;
  createdAt: string;
}

export interface LocalRuntimeRecord {
  modelId: string;
  engine: 'llama.cpp';
  pid: number;
  port: number;
  status: 'running' | 'stopped' | 'error';
  gpuLayers: number;
  ctxSize: number;
  logPath: string;
  startedAt: string;
}

export interface HfModelSummary {
  repoId: string;
  downloads: number;
  likes: number;
  tags: string[];
  lastModified?: string;
}

export interface HfModelFile {
  fileName: string;
  sizeBytes?: number;
  quantization?: string;
}

export interface RuntimeConfig {
  modelId: string;
  modelPath: string;
  port?: number;
  ctxSize?: number;
  gpuLayers?: number;
  threads?: number;
}

export interface RuntimeStatus {
  engine: 'llama.cpp';
  installed: boolean;
  version?: string;
  binaryPath?: string;
  running: boolean;
  pid?: number;
  port?: number;
  modelId?: string;
  healthy?: boolean;
}

export interface GenerateRequest {
  modelId: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  onToken?: (token: string) => void;
}

export interface GenerateResponse {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
}

export interface InferenceEngineAdapter {
  readonly id: 'llama.cpp';
  isInstalled(): Promise<boolean>;
  getVersion(): Promise<string | undefined>;
  install(options?: { force?: boolean; hardware?: HardwareProfile }): Promise<{
    binaryPath: string;
    version: string;
  }>;
  start(config: RuntimeConfig): Promise<LocalRuntimeRecord>;
  stop(modelId: string): Promise<boolean>;
  status(modelId?: string): Promise<RuntimeStatus>;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}
