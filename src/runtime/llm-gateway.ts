import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActorRole,
  LlmProviderType,
  RagCitation,
  RoleModelConfig,
  WorkflowPhase,
} from '../core/contracts.js';
import { AuthStorage } from '../core/auth.js';
import { I18N_DICTIONARY, SupportedLanguage } from '../core/i18n.js';
import { NotebookRagEngine } from './notebook-rag.js';
import { buildDefaultFreeProviders, DEFAULT_FREE_PROVIDERS, LLMRouter } from './llm-router.js';
import { buildRoleToolsInstruction } from './harnesses.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ModelCatalogEntry {
  provider: LlmProviderType;
  vendor: string;
  providerLabel: string;
  modelId: string;
  displayName: string;
  isFree: boolean;
  contextWindow: string;
  recommendedFor: string;
  defaultTemperature: number;
}

function loadModelsCatalogFromJson(): ModelCatalogEntry[] {
  const candidates = [
    path.resolve(process.cwd(), 'data', 'models.json'),
    path.resolve(__dirname, '..', '..', 'data', 'models.json'),
    path.resolve(__dirname, '..', 'data', 'models.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed as ModelCatalogEntry[];
        }
      } catch {
        // Fallback to built-in list below
      }
    }
  }
  return [
    // Anthropic
    {
      provider: 'anthropic',
      vendor: 'ANTHROPIC',
      providerLabel: 'Anthropic',
      modelId: 'claude-sonnet-4-20250514',
      displayName: 'Claude Sonnet 4',
      isFree: false,
      contextWindow: '200K',
      recommendedFor: 'Architecture & Deep Code',
      defaultTemperature: 0.1,
    },
    {
      provider: 'anthropic',
      vendor: 'ANTHROPIC',
      providerLabel: 'Anthropic',
      modelId: 'claude-3-7-sonnet',
      displayName: 'Claude 3.7 Sonnet',
      isFree: false,
      contextWindow: '200K',
      recommendedFor: 'Extended Thinking & Specs',
      defaultTemperature: 0.1,
    },
    {
      provider: 'anthropic',
      vendor: 'ANTHROPIC',
      providerLabel: 'Anthropic',
      modelId: 'claude-3-5-sonnet',
      displayName: 'Claude 3.5 Sonnet',
      isFree: false,
      contextWindow: '200K',
      recommendedFor: 'Fast Implementation',
      defaultTemperature: 0.2,
    },
    {
      provider: 'freellm',
      vendor: 'ANTHROPIC',
      providerLabel: 'Anthropic',
      modelId: 'claude-haiku-5-5',
      displayName: 'Claude Haiku 5.5',
      isFree: true,
      contextWindow: '200K',
      recommendedFor: 'Fast High-Quality Reasoning',
      defaultTemperature: 0.2,
    },
    // OpenAI
    {
      provider: 'openai',
      vendor: 'OPENAI',
      providerLabel: 'OpenAI',
      modelId: 'gpt-4.1',
      displayName: 'GPT-4.1',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'Full-Repo Engineering',
      defaultTemperature: 0.1,
    },
    {
      provider: 'openai',
      vendor: 'OPENAI',
      providerLabel: 'OpenAI',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      isFree: false,
      contextWindow: '128K',
      recommendedFor: 'General & QA Verification',
      defaultTemperature: 0.1,
    },
    {
      provider: 'openai',
      vendor: 'OPENAI',
      providerLabel: 'OpenAI',
      modelId: 'o3-mini',
      displayName: 'OpenAI o3-mini',
      isFree: false,
      contextWindow: '200K',
      recommendedFor: 'Strict QA & Edge Cases',
      defaultTemperature: 0.0,
    },
    {
      provider: 'freellm',
      vendor: 'OPENAI',
      providerLabel: 'OpenAI',
      modelId: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 Mini',
      isFree: true,
      contextWindow: '128K',
      recommendedFor: 'Strict QA & Fast Processing',
      defaultTemperature: 0.0,
    },
    {
      provider: 'openai',
      vendor: 'OPENAI',
      providerLabel: 'OpenAI',
      modelId: 'o1',
      displayName: 'OpenAI o1',
      isFree: false,
      contextWindow: '200K',
      recommendedFor: 'Formal Verification & ADRs',
      defaultTemperature: 0.0,
    },
    // Google Gemini
    {
      provider: 'gemini',
      vendor: 'GEMINI',
      providerLabel: 'Google Gemini',
      modelId: 'gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'PM Consolidation & Deep Context',
      defaultTemperature: 0.1,
    },
    {
      provider: 'freellm',
      vendor: 'GEMINI',
      providerLabel: 'Google Gemini',
      modelId: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      isFree: true,
      contextWindow: '1M',
      recommendedFor: 'Fast Multi-Agent Inquiries',
      defaultTemperature: 0.2,
    },
    {
      provider: 'freellm',
      vendor: 'GEMINI',
      providerLabel: 'Google Gemini',
      modelId: 'gemini-3.5-flash-lite',
      displayName: 'Gemini 3.5 Flash Lite',
      isFree: true,
      contextWindow: '1M',
      recommendedFor: 'High-Throughput Lightweight Tasks',
      defaultTemperature: 0.2,
    },
    {
      provider: 'freellm',
      vendor: 'GEMINI',
      providerLabel: 'Google Gemini',
      modelId: 'gemini-4-argon',
      displayName: 'Gemini 4 Argon',
      isFree: true,
      contextWindow: '1M',
      recommendedFor: 'Advanced Multi-Turn Reasoning',
      defaultTemperature: 0.1,
    },
    // Meta & Open-Weights
    {
      provider: 'freellm',
      vendor: 'META',
      providerLabel: 'Meta',
      modelId: 'glm-5.3-flash-free',
      displayName: 'GLM 5.3 Flash',
      isFree: true,
      contextWindow: '128K',
      recommendedFor: 'Open-Weights High-Speed Coding',
      defaultTemperature: 0.2,
    },
    {
      provider: 'freellm',
      vendor: 'META',
      providerLabel: 'Meta',
      modelId: 'deepseek-v4.1-flash-free',
      displayName: 'DeepSeek V4.1 Flash',
      isFree: true,
      contextWindow: '128K',
      recommendedFor: 'Open Reasoning & Math/Logic',
      defaultTemperature: 0.2,
    },
    {
      provider: 'freellm',
      vendor: 'META',
      providerLabel: 'Meta',
      modelId: 'beam-free',
      displayName: 'Beam Free',
      isFree: true,
      contextWindow: '128K',
      recommendedFor: 'Ultra-Fast Sub-Second Turnaround',
      defaultTemperature: 0.2,
    },
    {
      provider: 'freellm',
      vendor: 'META',
      providerLabel: 'Meta',
      modelId: 'flint-40b-free',
      displayName: 'Flint 40B Free',
      isFree: true,
      contextWindow: '128K',
      recommendedFor: 'Free Open-Weights General Tasks',
      defaultTemperature: 0.2,
    },
    {
      provider: 'ollama',
      vendor: 'META',
      providerLabel: 'Meta',
      modelId: 'llama-3.3-70b',
      displayName: 'Llama 3.3 70B',
      isFree: true,
      contextWindow: '128K',
      recommendedFor: 'Local Air-Gapped Architecture',
      defaultTemperature: 0.2,
    },
    // OpenCode Zen
    {
      provider: 'opencode',
      vendor: 'ANTHROPIC',
      providerLabel: 'OpenCode Zen',
      modelId: 'claude-sonnet-5-5',
      displayName: 'Claude Sonnet 5.5 (Zen)',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'OpenCode Zen Architecture & Complex Problem Solving',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'ANTHROPIC',
      providerLabel: 'OpenCode Zen',
      modelId: 'claude-haiku-5-5',
      displayName: 'Claude Haiku 5.5 (Zen)',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'OpenCode Zen Fast Responses & Rapid Iteration',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'ANTHROPIC',
      providerLabel: 'OpenCode Zen',
      modelId: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5 (Zen)',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'OpenCode Zen Deep Reasoning & Synthesis',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'OPENAI',
      providerLabel: 'OpenCode Zen',
      modelId: 'gpt-5.5',
      displayName: 'GPT-5.5 (Zen)',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'OpenCode Zen Frontier Engineering & Architecture',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'OPENAI',
      providerLabel: 'OpenCode Zen',
      modelId: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 Mini (Zen)',
      isFree: false,
      contextWindow: '400K',
      recommendedFor: 'OpenCode Zen Efficient Development & Fast Verification',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'OPENAI',
      providerLabel: 'OpenCode Zen',
      modelId: 'gpt-5.3-codex',
      displayName: 'GPT-5.3 Codex (Zen)',
      isFree: false,
      contextWindow: '400K',
      recommendedFor: 'OpenCode Zen Autonomous Code Specialist',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'OPENAI',
      providerLabel: 'OpenCode Zen',
      modelId: 'gpt-6-astra',
      displayName: 'GPT-6 Astra (Zen)',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'OpenCode Zen Next-Gen System Modeling',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'DEEPSEEK',
      providerLabel: 'OpenCode Zen',
      modelId: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro (Zen)',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'OpenCode Zen Native Thinking & Reasoning',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'DEEPSEEK',
      providerLabel: 'OpenCode Zen',
      modelId: 'deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash (Zen)',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'OpenCode Zen High-Speed Code Generation',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'GOOGLE',
      providerLabel: 'OpenCode Zen',
      modelId: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash (Zen)',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'OpenCode Zen Long-Context RAG & Reasoning',
      defaultTemperature: 0.2,
    },
    {
      provider: 'opencode',
      vendor: 'MISTRAL',
      providerLabel: 'OpenCode Zen',
      modelId: 'mistral-large-4',
      displayName: 'Mistral Large 4 (Zen)',
      isFree: false,
      contextWindow: '524K',
      recommendedFor: 'OpenCode Zen Open MoE Architecture',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'XAI',
      providerLabel: 'OpenCode Zen',
      modelId: 'grok-4.7',
      displayName: 'Grok 4.7 (Zen)',
      isFree: false,
      contextWindow: '500K',
      recommendedFor: 'OpenCode Zen Technical Research & Planning',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'MOONSHOT',
      providerLabel: 'OpenCode Zen',
      modelId: 'kimi-k2.7-code',
      displayName: 'Kimi K2.7 Code (Zen)',
      isFree: false,
      contextWindow: '262K',
      recommendedFor: 'OpenCode Zen Dedicated Code Engineering',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'ALIBABA',
      providerLabel: 'OpenCode Zen',
      modelId: 'qwen3.8-flash',
      displayName: 'Qwen 3.8 Flash (Zen)',
      isFree: false,
      contextWindow: '1M',
      recommendedFor: 'OpenCode Zen Visual & Document Engineering',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'OPENCODE',
      providerLabel: 'OpenCode Zen',
      modelId: 'big-pickle',
      displayName: 'Big Pickle (Zen Community)',
      isFree: true,
      contextWindow: '200K',
      recommendedFor: 'OpenCode Zen Deliberate Analysis & Tool Use',
      defaultTemperature: 0.1,
    },
    {
      provider: 'opencode',
      vendor: 'OPENCODE',
      providerLabel: 'OpenCode Zen',
      modelId: 'beam-free',
      displayName: 'Beam Free (Zen Community)',
      isFree: true,
      contextWindow: '1M',
      recommendedFor: 'OpenCode Zen Sparse MoE Agentic Workflows',
      defaultTemperature: 0.1,
    },
    // OpenRouter
    {
      provider: 'openrouter',
      vendor: 'ANTHROPIC',
      providerLabel: 'OpenRouter',
      modelId: 'anthropic/claude-3.7-sonnet',
      displayName: 'Claude 3.7 Sonnet (OpenRouter)',
      isFree: false,
      contextWindow: '200K',
      recommendedFor: 'Extended Thinking via OpenRouter',
      defaultTemperature: 0.1,
    },
    {
      provider: 'openrouter',
      vendor: 'ANTHROPIC',
      providerLabel: 'OpenRouter',
      modelId: 'anthropic/claude-3.5-sonnet',
      displayName: 'Claude 3.5 Sonnet (OpenRouter)',
      isFree: false,
      contextWindow: '200K',
      recommendedFor: 'Fast Coding via OpenRouter',
      defaultTemperature: 0.2,
    },
    {
      provider: 'openrouter',
      vendor: 'OPENAI',
      providerLabel: 'OpenRouter',
      modelId: 'openai/gpt-4o',
      displayName: 'GPT-4o (OpenRouter)',
      isFree: false,
      contextWindow: '128K',
      recommendedFor: 'General Engineering via OpenRouter',
      defaultTemperature: 0.1,
    },
    {
      provider: 'openrouter',
      vendor: 'DEEPSEEK',
      providerLabel: 'OpenRouter',
      modelId: 'deepseek/deepseek-r1',
      displayName: 'DeepSeek R1 (OpenRouter)',
      isFree: false,
      contextWindow: '64K',
      recommendedFor: 'Deep Reasoning via OpenRouter',
      defaultTemperature: 0.0,
    },
    {
      provider: 'openrouter',
      vendor: 'QWEN',
      providerLabel: 'OpenRouter',
      modelId: 'qwen/qwen-2.5-coder-32b-instruct',
      displayName: 'Qwen 2.5 Coder 32B (OpenRouter)',
      isFree: false,
      contextWindow: '128K',
      recommendedFor: 'Fast Code Generation via OpenRouter',
      defaultTemperature: 0.1,
    },
    // Groq
    {
      provider: 'groq',
      vendor: 'META',
      providerLabel: 'Groq LPU',
      modelId: 'llama-3.3-70b-versatile',
      displayName: 'Llama 3.3 70B (Groq)',
      isFree: false,
      contextWindow: '128K',
      recommendedFor: 'Ultra-Fast 300 tps Architecture',
      defaultTemperature: 0.1,
    },
    {
      provider: 'groq',
      vendor: 'META',
      providerLabel: 'Groq LPU',
      modelId: 'llama-3.1-8b-instant',
      displayName: 'Llama 3.1 8B Instant (Groq)',
      isFree: false,
      contextWindow: '128K',
      recommendedFor: 'Instant Sub-Second Inquiries',
      defaultTemperature: 0.2,
    },
    {
      provider: 'groq',
      vendor: 'MISTRAL',
      providerLabel: 'Groq LPU',
      modelId: 'mixtral-8x7b-32768',
      displayName: 'Mixtral 8x7B (Groq)',
      isFree: false,
      contextWindow: '32K',
      recommendedFor: 'MoE Fast Inference via Groq',
      defaultTemperature: 0.2,
    },
  ];
}

/**
 * Model Catalog loaded from data/models.json or SQLite database.
 * Grouped by vendor (Anthropic, OpenAI, Gemini, and Meta).
 */
export const AVAILABLE_MODELS_CATALOG: ModelCatalogEntry[] = loadModelsCatalogFromJson();

/**
 * Resolves the canonical vendor company name (ANTHROPIC, OPENAI, GEMINI, META)
 * for any provider/modelId combination.
 */
export function getModelVendorLabel(
  provider: string,
  modelId?: string,
): string {
  const lowerModel = (modelId ?? '').toLowerCase();
  const catalogMatch = AVAILABLE_MODELS_CATALOG.find(
    (m) => m.modelId.toLowerCase() === lowerModel,
  );
  if (catalogMatch) return catalogMatch.vendor;

  if (lowerModel.startsWith('claude') || provider === 'anthropic') {
    return 'ANTHROPIC';
  }
  if (
    lowerModel.startsWith('gpt') ||
    lowerModel.startsWith('o1') ||
    lowerModel.startsWith('o3') ||
    provider === 'openai'
  ) {
    return 'OPENAI';
  }
  if (lowerModel.startsWith('gemini') || provider === 'gemini') {
    return 'GEMINI';
  }
  return 'META';
}

/**
 * Resolves a model catalog entry by `provider/modelId`, `modelId`, or partial query,
 * or parses a custom `provider/modelId` specification (e.g. `meta/llama-3.3-70b`).
 */
export function resolveModelSpec(query: string): ModelCatalogEntry | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  // 1. Exact match on `provider/modelId`, `vendor/modelId`, or `modelId`
  const exact = AVAILABLE_MODELS_CATALOG.find(
    (m) =>
      `${m.provider}/${m.modelId}`.toLowerCase() === lower ||
      `${m.vendor}/${m.modelId}`.toLowerCase() === lower ||
      m.modelId.toLowerCase() === lower,
  );
  if (exact) return exact;

  // 2. Custom `provider/modelId` or `meta/modelId` syntax
  if (trimmed.includes('/')) {
    const [rawProv, ...rest] = trimmed.split('/');
    const provLower = rawProv.toLowerCase();
    const customModelId = rest.join('/').trim();
    if (
      customModelId &&
      (provLower === 'anthropic' ||
        provLower === 'openai' ||
        provLower === 'gemini' ||
        provLower === 'ollama' ||
        provLower === 'meta' ||
        provLower === 'opencode' ||
        provLower === 'openrouter' ||
        provLower === 'groq' ||
        provLower === 'deterministic')
    ) {
      const provider: LlmProviderType =
        provLower === 'meta' ? 'ollama' : (provLower as LlmProviderType);
      const vendor = getModelVendorLabel(provider, customModelId);
      return {
        provider,
        vendor,
        providerLabel: vendor,
        modelId: customModelId,
        displayName: customModelId,
        isFree: provider === 'ollama',
        contextWindow: '128K',
        recommendedFor: 'Custom Model',
        defaultTemperature: 0.2,
      };
    }
  }

  // 3. Substring match on modelId or displayName
  const partial = AVAILABLE_MODELS_CATALOG.find(
    (m) =>
      m.modelId.toLowerCase().includes(lower) ||
      m.displayName.toLowerCase().includes(lower),
  );
  return partial ?? null;
}

export interface AgentToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentTurnInput {
  projectId: string;
  projectName: string;
  phase: WorkflowPhase;
  role: ActorRole;
  systemPrompt: string;
  userPrompt: string;
  normativeArtifactsSummary: string;
  ragCitations: RagCitation[];
  modelConfig: RoleModelConfig;
  language?: SupportedLanguage;
}

export interface AgentTurnOutput {
  replyText: string;
  toolCalls: AgentToolCallRequest[];
  providerUsed: string;
  modelUsed: string;
}

/**
 * Extracts and cleans structured tool calls from LLM response text,
 * supporting ```tool_call blocks and standard JSON tool calling syntax.
 */
export function extractToolCalls(rawText: string): {
  cleanText: string;
  toolCalls: AgentToolCallRequest[];
} {
  const toolCalls: AgentToolCallRequest[] = [];
  if (!rawText) {
    return { cleanText: '', toolCalls: [] };
  }

  // 1. Match code blocks with tool_call, toolCall, or json:tool_call tag
  const blockRegex = /```(?:tool_call|toolCall|json:tool_call)\s*([\s\S]*?)```/gi;
  let cleanText = rawText.replace(blockRegex, (_match, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object') {
            const name = item.name || item.tool;
            const args = item.arguments || item.params || item.args || {};
            if (name && typeof name === 'string') {
              toolCalls.push({
                name,
                arguments: typeof args === 'string' ? JSON.parse(args) : args,
              });
            }
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        const name = parsed.name || parsed.tool;
        const args = parsed.arguments || parsed.params || parsed.args || {};
        if (name && typeof name === 'string') {
          toolCalls.push({
            name,
            arguments: typeof args === 'string' ? JSON.parse(args) : args,
          });
        }
      }
    } catch {
      // ignore parse error
    }
    return '';
  });

  // 2. Match general json blocks that explicitly contain a recognized tool call
  const knownTools =
    'propose_requirement|record_adr|write_architecture_doc|write_specification|request_po_approval|write_implementation_plan|write_source_file|consult_architect|submit_for_qa|write_test_case|run_verification_test|submit_qa_report';
  const toolJsonRegex = new RegExp(
    '```(?:json)?\\s*(\\{\\s*"(?:name|tool)"\\s*:\\s*"(?:' +
      knownTools +
      ')"\\s*,[\\s\\S]*?\\})\\s*```',
    'gi',
  );

  cleanText = cleanText.replace(toolJsonRegex, (_match, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr.trim());
      const name = parsed.name || parsed.tool;
      const args = parsed.arguments || parsed.params || parsed.args || {};
      if (name && typeof name === 'string') {
        toolCalls.push({
          name,
          arguments: typeof args === 'string' ? JSON.parse(args) : args,
        });
      }
      return '';
    } catch {
      return _match;
    }
  });

  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, toolCalls };
}

/**
 * Multi-Model LLM Gateway.
 * Decouples workflow execution from specific LLM providers and allows different
 * models for Architect, Developer, QA, and custom specialists.
 */
export class LlmGateway {
  private freeRouter: LLMRouter;

  constructor() {
    this.freeRouter = new LLMRouter({
      providers: buildDefaultFreeProviders(),
      strategy: 'auto:smart',
      fallbackEnabled: true,
      requestTimeoutMs: 90000,
    });
  }
  async generateAgentTurn(
    input: AgentTurnInput,
    onStreamToken?: (chunk: string) => void,
  ): Promise<AgentTurnOutput> {
    const { provider, modelId, temperature } = input.modelConfig;
    const lang: SupportedLanguage = input.language ?? 'en';
    const isVitest = Boolean(process.env.VITEST);
    const isStrictLlm = Boolean(process.env.POCLI_STRICT_LLM);
    const allowTestFallback =
      isVitest && !isStrictLlm && provider !== 'deterministic';

    if (provider === 'openai') {
      const openAiKey = AuthStorage.getApiKey('openai');
      if (!openAiKey) {
        if (allowTestFallback) {
          return this.runDeterministicSpecialist(input, onStreamToken);
        }
        throw new Error(I18N_DICTIONARY[lang].llmMissingApiKeyError('openai'));
      }
      return this.callOpenAiCompatible(
        'https://api.openai.com/v1/chat/completions',
        openAiKey,
        modelId,
        temperature,
        input,
        onStreamToken,
      );
    }

    if (provider === 'ollama') {
      const baseUrl = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
      try {
        return await this.callOpenAiCompatible(
          `${baseUrl}/v1/chat/completions`,
          'ollama',
          modelId,
          temperature,
          input,
          onStreamToken,
        );
      } catch (ollamaErr) {
        if (allowTestFallback) {
          return this.runDeterministicSpecialist(input, onStreamToken);
        }
        throw new Error(
          I18N_DICTIONARY[lang].llmConnectionError(
            'ollama',
            (ollamaErr as Error).message,
          ),
        );
      }
    }

    if (provider === 'anthropic') {
      const anthropicKey = AuthStorage.getApiKey('anthropic');
      if (!anthropicKey) {
        if (allowTestFallback) {
          return this.runDeterministicSpecialist(input, onStreamToken);
        }
        throw new Error(
          I18N_DICTIONARY[lang].llmMissingApiKeyError('anthropic'),
        );
      }
      return this.callAnthropic(
        anthropicKey,
        modelId,
        temperature,
        input,
        onStreamToken,
      );
    }

    if (provider === 'gemini') {
      const geminiKey = AuthStorage.getApiKey('gemini');
      if (!geminiKey) {
        if (allowTestFallback) {
          return this.runDeterministicSpecialist(input, onStreamToken);
        }
        throw new Error(I18N_DICTIONARY[lang].llmMissingApiKeyError('gemini'));
      }
      return this.callGemini(
        geminiKey,
        modelId,
        temperature,
        input,
        onStreamToken,
      );
    }

    if (provider === 'opencode' || (provider as string) === 'opencode-zen') {
      const opencodeKey = AuthStorage.getApiKey('opencode');
      if (!opencodeKey) {
        if (allowTestFallback) {
          return this.runDeterministicSpecialist(input, onStreamToken);
        }
        throw new Error(
          I18N_DICTIONARY[lang].llmMissingApiKeyError('opencode'),
        );
      }
      return this.callOpenAiCompatible(
        'https://opencode.ai/zen/v1/chat/completions',
        opencodeKey,
        modelId,
        temperature,
        input,
        onStreamToken,
      );
    }

    if (provider === 'openrouter') {
      const openrouterKey = AuthStorage.getApiKey('openrouter');
      if (!openrouterKey) {
        if (allowTestFallback) {
          return this.runDeterministicSpecialist(input, onStreamToken);
        }
        throw new Error(
          I18N_DICTIONARY[lang].llmMissingApiKeyError('openrouter'),
        );
      }
      return this.callOpenAiCompatible(
        'https://openrouter.ai/api/v1/chat/completions',
        openrouterKey,
        modelId,
        temperature,
        input,
        onStreamToken,
      );
    }

    if (provider === 'groq') {
      const groqKey = AuthStorage.getApiKey('groq');
      if (!groqKey) {
        if (allowTestFallback) {
          return this.runDeterministicSpecialist(input, onStreamToken);
        }
        throw new Error(I18N_DICTIONARY[lang].llmMissingApiKeyError('groq'));
      }
      return this.callOpenAiCompatible(
        'https://api.groq.com/openai/v1/chat/completions',
        groqKey,
        modelId,
        temperature,
        input,
        onStreamToken,
      );
    }

    // Native FreeLLM router execution with smart multi-provider failover
    // Runs zero-key public inference (Pollinations, OpenRouter Free, Local Ollama)
    // without relying on external opencode binary or subscriptions.
    if (provider === 'freellm' || this.isFreeModel(modelId)) {
      try {
        const ragBlock = input.ragCitations
          .map(
            (c) => `${NotebookRagEngine.formatCitationTag(c)}\n${c.snippet}`,
          )
          .join('\n\n');

        const systemContent = [
          `System: You are acting as the ${input.role.toUpperCase()} specialist in PO CLI.`,
          this.assembleSpecialistSystemPrompt(input, ragBlock),
        ]
          .filter(Boolean)
          .join('\n\n');

        const result = await this.freeRouter.completion({
          model: modelId,
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: input.userPrompt },
          ],
          temperature,
          onStreamChunk: onStreamToken,
        });

        const extracted = extractToolCalls(result.text);

        return {
          replyText: extracted.cleanText || result.text,
          toolCalls: extracted.toolCalls,
          providerUsed: result.providerId,
          modelUsed: result.modelUsed,
        };
      } catch (routerErr) {
        if (allowTestFallback) {
          return this.runDeterministicSpecialist(input, onStreamToken);
        }
        throw new Error(
          I18N_DICTIONARY[lang].llmConnectionError(
            'freellm',
            (routerErr as Error).message,
          ),
        );
      }
    }

    if (provider === 'deterministic') {
      return this.runDeterministicSpecialist(input, onStreamToken);
    }

    if (allowTestFallback) {
      return this.runDeterministicSpecialist(input, onStreamToken);
    }

    throw new Error(I18N_DICTIONARY[lang].llmMissingApiKeyError(provider));
  }

  private assembleSpecialistSystemPrompt(
    input: AgentTurnInput,
    ragBlock: string,
  ): string {
    const roleTools = buildRoleToolsInstruction(input.role);
    return [
      input.systemPrompt,
      roleTools,
      input.normativeArtifactsSummary
        ? `[NORMATIVE ARTIFACTS]\n${input.normativeArtifactsSummary}`
        : '',
      ragBlock ? `[RAG NOTEBOOK SOURCES]\n${ragBlock}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async callOpenAiCompatible(
    endpoint: string,
    apiKey: string,
    modelId: string,
    temperature: number,
    input: AgentTurnInput,
    onStreamToken?: (chunk: string) => void,
  ): Promise<AgentTurnOutput> {
    const ragBlock = input.ragCitations
      .map(
        (c) =>
          `${NotebookRagEngine.formatCitationTag(c)}\n${c.snippet}`,
      )
      .join('\n\n');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature,
        messages: [
          {
            role: 'system',
            content: this.assembleSpecialistSystemPrompt(input, ragBlock),
          },
          { role: 'user', content: input.userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM Provider HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
        };
      }>;
    };
    const choiceMsg = data.choices?.[0]?.message;
    const rawText = choiceMsg?.content ?? '';

    const nativeToolCalls: AgentToolCallRequest[] = [];
    if (Array.isArray(choiceMsg?.tool_calls)) {
      for (const tc of choiceMsg.tool_calls) {
        if (tc.function?.name) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {}
          nativeToolCalls.push({ name: tc.function.name, arguments: args });
        }
      }
    }

    const extracted = extractToolCalls(rawText);
    const combinedToolCalls = [...nativeToolCalls, ...extracted.toolCalls];
    const finalReplyText =
      extracted.cleanText || (combinedToolCalls.length > 0 ? '' : rawText);
    if (onStreamToken && finalReplyText) onStreamToken(finalReplyText);

    return {
      replyText: finalReplyText,
      toolCalls: combinedToolCalls,
      providerUsed: input.modelConfig.provider,
      modelUsed: modelId,
    };
  }

  private async callAnthropic(
    apiKey: string,
    modelId: string,
    temperature: number,
    input: AgentTurnInput,
    onStreamToken?: (chunk: string) => void,
  ): Promise<AgentTurnOutput> {
    const ragBlock = input.ragCitations
      .map((c) => `${NotebookRagEngine.formatCitationTag(c)}\n${c.snippet}`)
      .join('\n\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 2048,
        temperature,
        system: this.assembleSpecialistSystemPrompt(input, ragBlock),
        messages: [{ role: 'user', content: input.userPrompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      content?: Array<
        | { type: 'text'; text?: string }
        | { type: 'tool_use'; name?: string; input?: Record<string, unknown> }
      >;
    };
    let rawText = '';
    const nativeToolCalls: AgentToolCallRequest[] = [];
    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text') {
          rawText += block.text ?? '';
        } else if (block.type === 'tool_use' && block.name) {
          nativeToolCalls.push({
            name: block.name,
            arguments: block.input ?? {},
          });
        }
      }
    }

    const extracted = extractToolCalls(rawText);
    const combinedToolCalls = [...nativeToolCalls, ...extracted.toolCalls];
    const finalReplyText =
      extracted.cleanText || (combinedToolCalls.length > 0 ? '' : rawText);
    if (onStreamToken && finalReplyText) onStreamToken(finalReplyText);

    return {
      replyText: finalReplyText,
      toolCalls: combinedToolCalls,
      providerUsed: 'anthropic',
      modelUsed: modelId,
    };
  }

  private async callGemini(
    apiKey: string,
    modelId: string,
    temperature: number,
    input: AgentTurnInput,
    onStreamToken?: (chunk: string) => void,
  ): Promise<AgentTurnOutput> {
    const ragBlock = input.ragCitations
      .map((c) => `${NotebookRagEngine.formatCitationTag(c)}\n${c.snippet}`)
      .join('\n\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: this.assembleSpecialistSystemPrompt(input, ragBlock),
            },
          ],
        },
        contents: [{ role: 'user', parts: [{ text: input.userPrompt }] }],
        generationConfig: { temperature },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name?: string; args?: Record<string, unknown> };
          }>;
        };
      }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    let rawText = '';
    const nativeToolCalls: AgentToolCallRequest[] = [];
    for (const p of parts) {
      if (p.text) rawText += p.text;
      if (p.functionCall?.name) {
        nativeToolCalls.push({
          name: p.functionCall.name,
          arguments: p.functionCall.args ?? {},
        });
      }
    }

    const extracted = extractToolCalls(rawText);
    const combinedToolCalls = [...nativeToolCalls, ...extracted.toolCalls];
    const finalReplyText =
      extracted.cleanText || (combinedToolCalls.length > 0 ? '' : rawText);
    if (onStreamToken && finalReplyText) onStreamToken(finalReplyText);

    return {
      replyText: finalReplyText,
      toolCalls: combinedToolCalls,
      providerUsed: 'gemini',
      modelUsed: modelId,
    };
  }

  private isFreeModel(modelId: string): boolean {
    const knownFreeModels = [
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-4-argon',
      'glm-5.3-flash-free',
      'deepseek-v4.1-flash-free',
      'beam-free',
      'flint-40b-free',
      'mimo-v2.6-flash-free',
      'gpt-5.4-mini',
      'claude-haiku-5-5',
    ];
    return (
      knownFreeModels.includes(modelId) ||
      AVAILABLE_MODELS_CATALOG.some((m) => m.modelId === modelId && m.isFree)
    );
  }

  private async runDeterministicSpecialist(
    input: AgentTurnInput,
    onStreamToken?: (chunk: string) => void,
  ): Promise<AgentTurnOutput> {
    const citationTags = input.ragCitations.map((c) =>
      NotebookRagEngine.formatCitationTag(c),
    );
    const citationFooter =
      citationTags.length > 0
        ? `\n\nSources consulted in Notebooks:\n${citationTags.map((t) => `- ${t}`).join('\n')}`
        : '';

    const toolCalls: AgentToolCallRequest[] = [];
    let replyText = '';

    if (input.role === 'architect') {
      const promptLower = input.userPrompt.toLowerCase();
      if (
        promptLower.includes('architecture') ||
        promptLower.includes('design') ||
        promptLower.includes('propose') ||
        promptLower.includes('requirement') ||
        promptLower.includes('arquitect') ||
        promptLower.includes('diseñ') ||
        promptLower.includes('propuest') ||
        promptLower.includes('requisit')
      ) {
        toolCalls.push(
          {
            name: 'propose_requirement',
            arguments: {
              code: 'REQ-001',
              title: `Functional Requirements — ${input.projectName}`,
              content: `# REQ-001: Functional Requirements\n\n- Context: ${input.userPrompt}\n- Acceptance criterion: Deterministic processing verified by automated QA tests.`,
              citations: citationTags,
            },
          },
          {
            name: 'record_adr',
            arguments: {
              code: 'ADR-001',
              title: 'Modular Architecture with Typed Contracts',
              content: `# ADR-001: Typed Contracts and Layer Separation\n\nAdopts a modular architecture with schema validation and decoupled persistence.`,
              tracesTo: ['REQ-001'],
              citations: citationTags,
            },
          },
          {
            name: 'write_architecture_doc',
            arguments: {
              code: 'ARCH-001',
              title: `Reference Architecture — ${input.projectName}`,
              content: `# ARCH-001: Technical Architecture\n\n## Modules and Contracts\n1. \`domain\`: Core entities and validation.\n2. \`service\`: Business logic compliant with REQ-001 and ADR-001.\n\n## Constraints\n- Presentation and persistence layers must remain strictly decoupled.`,
              tracesTo: ['REQ-001', 'ADR-001'],
              citations: citationTags,
            },
          },
          {
            name: 'write_specification',
            arguments: {
              code: 'SPEC-001',
              title: `Developer Technical Specification — ${input.projectName}`,
              content: `# SPEC-001: Implementation Specification\n\n- Implement the primary module fulfilling \`ARCH-001\` and \`REQ-001\`.\n- Export pure functions verifiable by independent QA.`,
              tracesTo: ['REQ-001', 'ARCH-001'],
              citations: citationTags,
            },
          },
          {
            name: 'request_po_approval',
            arguments: {
              artifactCode: 'ARCH-001',
            },
          },
        );
        replyText =
          `I have analyzed the requirements for **${input.projectName}** and prepared the formal proposal:\n` +
          `- \`REQ-001\`: Functional requirements and acceptance criteria.\n` +
          `- \`ADR-001\`: Architectural decision record on contracts and modularity.\n` +
          `- \`ARCH-001\`: Proposed technical architecture (status \`PENDING_APPROVAL\`).\n` +
          `- \`SPEC-001\`: Detailed technical specification for the Developer.\n\n` +
          `Awaiting your review and **Formal Approval** as Product Owner before handoff to the Developer.${citationFooter}`;
      } else {
        replyText =
          `[Software Architect] I have analyzed your inquiry regarding **${input.projectName}** (Current phase: \`${input.phase}\`). ` +
          `I can evaluate architectural alternatives, record new ADRs, or prepare the formal \`ARCH-001\` proposal for your approval.${citationFooter}`;
      }
    } else if (input.role === 'developer') {
      const promptLower = input.userPrompt.toLowerCase();
      if (
        promptLower.includes('ambiguity') ||
        promptLower.includes('deviat') ||
        promptLower.includes('blocker')
      ) {
        toolCalls.push({
          name: 'consult_architect',
          arguments: {
            subject: 'Consultation regarding architectural constraint during implementation',
            ambiguityOrBlocker: input.userPrompt,
            proposedAlternative: 'Introduce an intermediate adapter while preserving the ARCH-001 contract.',
            impactedArtifacts: ['ARCH-001', 'SPEC-001'],
          },
        });
        replyText =
          `[Senior Developer] I detected a potential deviation or ambiguity regarding \`ARCH-001\`. ` +
          `Following the authority rule, I will not modify the architecture unilaterally: I have submitted a formal consultation (\`consult_architect\`) to the Software Architect.${citationFooter}`;
      } else {
        toolCalls.push(
          {
            name: 'write_implementation_plan',
            arguments: {
              code: 'PLAN-001',
              title: `Implementation Plan — ${input.projectName}`,
              content: `# PLAN-001: Implementation Plan\n\nBased on \`ARCH-001\` and \`SPEC-001\`:\n1. Implement core domain module.\n2. Prepare verification deliverable for QA.`,
              tracesTo: ['ARCH-001', 'SPEC-001'],
              citations: citationTags,
            },
          },
          {
            name: 'write_source_file',
            arguments: {
              code: 'CODE-001',
              relFilePath: 'src/app-module.js',
              content: `// Generated in compliance with ARCH-001 and SPEC-001\nexport function executeBusinessLogic(input) {\n  if (!input || typeof input.value !== 'number') {\n    throw new Error('INVALID_INPUT');\n  }\n  return { ok: true, result: input.value * 2, architectureVersion: 'ARCH-001' };\n}\n`,
              tracesTo: ['REQ-001', 'ARCH-001', 'SPEC-001'],
              citations: citationTags,
            },
          },
        );
        replyText =
          `[Senior Developer] Worked on the approved Handoff bundle (\`REQ-001\`, \`ARCH-001\`, \`SPEC-001\`) and produced:\n` +
          `- \`PLAN-001\`: Implementation plan.\n` +
          `- \`CODE-001\` (\`src/app-module.js\`): Source implementation aligned with approved contracts.${citationFooter}`;
      }
    } else if (input.role === 'qa') {
      replyText =
        `[Independent QA Engineer] Ready to execute independent validation tests against \`REQ-001\`, \`ARCH-001\`, and \`CODE-001\`, collecting real execution evidence before issuing a verdict (\`ACCEPT\` or \`REJECT\`).${citationFooter}`;
    } else if (input.role === 'pm') {
      const promptLower = input.userPrompt.toLowerCase();
      if (
        promptLower.includes('csv') ||
        promptLower.includes('spreadsheet') ||
        promptLower.includes('excel') ||
        promptLower.includes('hoja') ||
        promptLower.includes('table') ||
        promptLower.includes('tabla')
      ) {
        toolCalls.push({
          name: 'write_llm_artifact',
          arguments: {
            code: 'OUT-CSV-001',
            title: `PM Spreadsheet Output — ${input.projectName}`,
            relFilePath: 'deliveries/pm_project_metrics.csv',
            content: [
              'project,phase,role,status,notes',
              `${input.projectName},${input.phase},architect,ACTIVE,Architecture governance active`,
              `${input.projectName},${input.phase},developer,ACTIVE,Implementation tracking active`,
              `${input.projectName},${input.phase},qa,ACTIVE,Independent verification ready`,
            ].join('\n') + '\n',
            citations: citationTags,
          },
        });
      }
      if (
        promptLower.includes('python') ||
        promptLower.includes('.py') ||
        promptLower.includes('script')
      ) {
        toolCalls.push({
          name: 'write_llm_artifact',
          arguments: {
            code: 'OUT-PY-001',
            title: `LLM Python Helper Script — ${input.projectName}`,
            relFilePath: 'scripts/pocli_task_helper.py',
            content: [
              '#!/usr/bin/env python3',
              '"""Auto-generated LLM helper script stored in project .pocli/artifacts/scripts."""',
              'import json',
              '',
              'def summarize_project():',
              `    return {"project": "${input.projectName}", "phase": "${input.phase}", "status": "ok"}`,
              '',
              'if __name__ == "__main__":',
              '    print(json.dumps(summarize_project(), indent=2))',
            ].join('\n') + '\n',
            citations: citationTags,
          },
        });
      }
      replyText =
        `[Project Manager (PM)] Consolidated status check for **${input.projectName}** (Phase: \`${input.phase}\`). ` +
        `I can execute parallel or sequential inquiries across the active Architect, Developer, and QA agents and store requested outputs (Python scripts, spreadsheets, reports) in the project artifacts directory (.pocli/artifacts/).${citationFooter}`;
    } else {
      replyText = `[Specialist ${input.role}] Analysis completed for ${input.projectName}.${citationFooter}`;
    }

    // Any role can also emit a Python helper script or spreadsheet output in the project artifacts directory when requested
    if (input.role !== 'pm') {
      const promptLower = input.userPrompt.toLowerCase();
      if (
        promptLower.includes('python') ||
        promptLower.includes('.py')
      ) {
        toolCalls.push({
          name: 'write_llm_artifact',
          arguments: {
            code: 'OUT-PY-001',
            title: `LLM Python Helper Script — ${input.projectName}`,
            relFilePath: 'scripts/pocli_task_helper.py',
            content: [
              '#!/usr/bin/env python3',
              `"""Helper script generated by ${input.role} for ${input.projectName}."""`,
              'print("POCLI helper script executed successfully")',
            ].join('\n') + '\n',
            citations: citationTags,
          },
        });
      }
    }

    if (onStreamToken && replyText) {
      const words = replyText.split(' ');
      for (const word of words) {
        onStreamToken(`${word} `);
      }
    }

    return {
      replyText,
      toolCalls,
      providerUsed: input.modelConfig.provider,
      modelUsed: input.modelConfig.modelId,
    };
  }
}
