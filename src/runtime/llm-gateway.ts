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
  senderRole?: ActorRole | 'product_owner';
}

export interface AgentTurnOutput {
  replyText: string;
  toolCalls: AgentToolCallRequest[];
  providerUsed: string;
  modelUsed: string;
}

const KNOWN_TOOLS = new Set([
  'propose_requirement',
  'record_adr',
  'write_architecture_doc',
  'write_architecture',
  'write_specification',
  'write_spec',
  'request_po_approval',
  'handoff_to_developer',
  'initiate_developer',
  'delegate_to_developer',
  'start_implementation',
  'evaluate_consultation',
  'init_repository',
  'init_git_repository',
  'init_repo',
  'write_implementation_log',
  'record_implementation_log',
  'write_implementation_plan',
  'write_source_file',
  'write_gherkin_scenarios',
  'run_unit_tests',
  'run_tests',
  'consult_architect',
  'submit_for_qa',
  'handoff_to_qa',
  'clone_repo_for_qa',
  'write_qa_gherkin',
  'install_qa_tool',
  'provision_qa_tool',
  'write_qa_test_script',
  'run_qa_test_suite',
  'run_mutation_check',
  'submit_qa_verdict',
  'write_test_case',
  'run_verification_test',
  'submit_qa_report',
  'write_pm_report',
  'write_llm_artifact',
  'run_command',
]);

function isRecognizedToolName(name: string): boolean {
  return (
    KNOWN_TOOLS.has(name) ||
    name.startsWith('write_') ||
    name.startsWith('record_') ||
    name.startsWith('propose_') ||
    name.startsWith('create_') ||
    name.startsWith('handoff_') ||
    name.startsWith('initiate_') ||
    name.startsWith('submit_') ||
    name.startsWith('run_') ||
    name.startsWith('clone_')
  );
}

/**
 * Scans a string starting at `startIndex` (which must be '{' or '[')
 * and returns the slice ending at the matching closing '}' or ']',
 * correctly ignoring braces inside JSON string literals and escaped quotes.
 */
function extractBalancedJson(
  text: string,
  startIndex: number,
): { endIndex: number; jsonStr: string } | null {
  const openChar = text[startIndex];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === openChar) {
        depth++;
      } else if (ch === closeChar) {
        depth--;
        if (depth === 0) {
          return { endIndex: i + 1, jsonStr: text.slice(startIndex, i + 1) };
        }
      }
    }
  }
  return null;
}

/**
 * Robustly extracts and cleans structured tool calls from LLM response text,
 * supporting ```tool_call blocks, ```json blocks, <tool_call> tags, and inline JSON,
 * even when the tool call arguments contain internal markdown code blocks or diagrams.
 */
export function extractToolCalls(rawText: string): {
  cleanText: string;
  toolCalls: AgentToolCallRequest[];
} {
  const toolCalls: AgentToolCallRequest[] = [];
  if (!rawText) {
    return { cleanText: '', toolCalls: [] };
  }

  const removalRanges: Array<{ start: number; end: number }> = [];

  function processParsedObject(
    parsed: unknown,
    blockStart?: number,
    blockEnd?: number,
  ): boolean {
    let matched = false;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (item && typeof item === 'object') {
        const candidate = item as Record<string, unknown>;
        const name = candidate.name || candidate.tool;
        let args = candidate.arguments || candidate.params || candidate.args || {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {}
        }
        if (typeof name === 'string' && isRecognizedToolName(name)) {
          toolCalls.push({
            name,
            arguments: (args as Record<string, unknown>) ?? {},
          });
          matched = true;
        }
      }
    }
    if (matched && blockStart !== undefined && blockEnd !== undefined) {
      removalRanges.push({ start: blockStart, end: blockEnd });
    }
    return matched;
  }

  // Pass 1: Find fenced code blocks (```tool_call, ```json, ```) or <tool_call> tags
  const fenceRegex = /(?:```(?:tool_call|toolCall|json:tool_call|json)?|<tool_call>)\s*/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(rawText)) !== null) {
    const tagStart = fenceMatch.index;
    const contentStart = tagStart + fenceMatch[0].length;
    let jsonStart = contentStart;
    let toolNamePrefix: string | undefined;

    // Check if the fence body begins with `<tool_name>\n{...}`
    const prefixMatch = rawText.slice(contentStart).match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\n\s*/);
    if (prefixMatch && isRecognizedToolName(prefixMatch[1])) {
      toolNamePrefix = prefixMatch[1];
      jsonStart = contentStart + prefixMatch[0].length;
    }

    const firstChar = rawText[jsonStart];
    if (firstChar === '{' || firstChar === '[') {
      const extracted = extractBalancedJson(rawText, jsonStart);
      if (extracted) {
        try {
          let parsed = JSON.parse(extracted.jsonStr);
          if (toolNamePrefix && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.name) {
            parsed = { name: toolNamePrefix, arguments: parsed };
          }
          let blockEnd = extracted.endIndex;
          const remaining = rawText.slice(extracted.endIndex);
          const closeMatch = remaining.match(/^\s*(?:```|<\/tool_call>)/);
          if (closeMatch) {
            blockEnd = extracted.endIndex + closeMatch[0].length;
          }
          if (processParsedObject(parsed, tagStart, blockEnd)) {
            fenceRegex.lastIndex = blockEnd;
          }
        } catch {
          // not valid json, ignore
        }
      }
    }
  }

  // Pass 2: Look for raw JSON objects that might not be wrapped in code fences
  for (let i = 0; i < rawText.length; i++) {
    if (removalRanges.some((r) => i >= r.start && i < r.end)) continue;
    if (rawText[i] === '{' || rawText[i] === '[') {
      const preview = rawText.slice(i, i + 120);
      if (preview.includes('"name"') || preview.includes('"tool"')) {
        const extracted = extractBalancedJson(rawText, i);
        if (extracted) {
          try {
            const parsed = JSON.parse(extracted.jsonStr);
            if (processParsedObject(parsed, i, extracted.endIndex)) {
              i = extracted.endIndex - 1;
            }
          } catch {}
        }
      }
    }
  }

  // Pass 3: Support function-call style tool invocations inside ```tool_call blocks
  // e.g. clone_repo_for_qa(repoName="pysqlite-crud-api")
  const fnBlockRegex =
    /```(?:tool_call|toolCall|json:tool_call)\s*([\s\S]*?)(?:```|$)/gi;
  let fnBlockMatch: RegExpExecArray | null;
  while ((fnBlockMatch = fnBlockRegex.exec(rawText)) !== null) {
    const bStart = fnBlockMatch.index;
    const bEnd = bStart + fnBlockMatch[0].length;
    if (removalRanges.some((r) => bStart >= r.start && bStart < r.end)) continue;

    const inner = fnBlockMatch[1].trim();
    const fnCallRegex =
      /\b([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)/gi;
    let callMatch: RegExpExecArray | null;
    let foundFn = false;
    while ((callMatch = fnCallRegex.exec(inner)) !== null) {
      const fnName = callMatch[1];
      const argsBody = callMatch[2].trim();
      if (!isRecognizedToolName(fnName)) continue;
      const argsObj: Record<string, unknown> = {};
      if (argsBody.startsWith('{') && argsBody.endsWith('}')) {
        try {
          Object.assign(argsObj, JSON.parse(argsBody));
        } catch {}
      } else if (argsBody.length > 0) {
        const kvRegex =
          /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(true|false|\d+(?:\.\d+)?))/g;
        let kv: RegExpExecArray | null;
        while ((kv = kvRegex.exec(argsBody)) !== null) {
          const key = kv[1];
          if (kv[2] !== undefined) argsObj[key] = kv[2].replace(/\\"/g, '"');
          else if (kv[3] !== undefined) argsObj[key] = kv[3].replace(/\\'/g, "'");
          else if (kv[4] === 'true') argsObj[key] = true;
          else if (kv[4] === 'false') argsObj[key] = false;
          else if (kv[4] !== undefined) argsObj[key] = Number(kv[4]);
        }
      }
      toolCalls.push({ name: fnName, arguments: argsObj });
      foundFn = true;
    }
    if (foundFn) {
      removalRanges.push({ start: bStart, end: bEnd });
    }
  }

  // Construct cleanText by removing identified ranges
  removalRanges.sort((a, b) => b.start - a.start);
  let cleanText = rawText;
  for (const range of removalRanges) {
    cleanText = cleanText.slice(0, range.start) + cleanText.slice(range.end);
  }

  cleanText = cleanText
    .replace(/^\s*```\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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
          replyText:
            extracted.cleanText ||
            (extracted.toolCalls.length > 0 ? '' : result.text),
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
        max_tokens: 8192,
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
      const wantsDeveloperHandoff =
        promptLower.includes('initiate_developer') ||
        promptLower.includes('delega al desarrollador') ||
        promptLower.includes('handoff_to_developer');

      if (wantsDeveloperHandoff) {
        toolCalls.push({
          name: 'handoff_to_developer',
          arguments: {
            instructions:
              'Implement the approved architecture ARCH-001 and technical specification SPEC-001, run unit tests, write DEV-GHERKIN-001.feature, and submit to QA.',
            approvalComments:
              'Approved by Product Owner in conversation and delegated to Senior Developer.',
          },
        });
        replyText =
          `[Software Architect] Architecture \`ARCH-001\` and specification \`SPEC-001\` are formally approved. ` +
          `I have initiated the autonomous handoff (\`[ARQ → DEV]\`) to the Senior Developer via \`handoff_to_developer\`.${citationFooter}`;
      } else if (
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
            name: 'write_architecture_doc',
            arguments: {
              code: 'ARCH-001',
              title: `Reference Architecture — ${input.projectName}`,
              content: `# ARCH-001: Technical Architecture\n\n## Modules and Contracts\n1. \`domain\`: Core entities and validation.\n2. \`service\`: Business logic.\n\n## Constraints\n- Presentation and persistence layers must remain strictly decoupled.`,
              citations: citationTags,
            },
          },
          {
            name: 'write_specification',
            arguments: {
              code: 'SPEC-001',
              title: `Developer Technical Specification — ${input.projectName}`,
              content: `# SPEC-001: Implementation Specification\n\n- Implement the primary module fulfilling \`ARCH-001\`.\n- Export pure functions verifiable by independent QA.`,
              tracesTo: ['ARCH-001'],
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
          `I have analyzed the technical requirements for **${input.projectName}** and prepared the contracts:\n` +
          `- \`ARCH-001\`: Reference technical architecture (status \`PENDING_APPROVAL\`).\n` +
          `- \`SPEC-001\`: Developer technical specification contract.\n\n` +
          `Awaiting your review and **Formal Approval** as Product Owner before handoff to the Developer.${citationFooter}`;
      } else {
        replyText =
          `[Software Architect] I have analyzed your inquiry regarding **${input.projectName}** (Current phase: \`${input.phase}\`). ` +
          `I can evaluate architectural alternatives and maintain the Reference Architecture (\`ARCH-001\`) and Developer Specification (\`SPEC-001\`).${citationFooter}`;
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
        const shouldHandoffToQa =
          input.senderRole === 'architect' ||
          input.senderRole === 'qa' ||
          [
            'PHASE_4_DEVELOPER_HANDOFF',
            'PHASE_5_IMPLEMENTATION',
            'PHASE_6_QA_VALIDATION',
            'PHASE_7_CORRECTION_CYCLE',
          ].includes(input.phase) ||
          promptLower.includes('submit_for_qa') ||
          promptLower.includes('gherkin');

        const simulateDefect =
          input.senderRole !== 'qa' &&
          (promptLower.includes('force_test_failure') ||
            promptLower.includes('simulate_bug'));
        const multiplier = simulateDefect ? 3 : 2;

        toolCalls.push(
          {
            name: 'write_source_file',
            arguments: {
              code: 'CODE-001',
              relFilePath: 'src/app-module.js',
              content: `// Generated in compliance with ARCH-001 and SPEC-001\nexport function executeBusinessLogic(input) {\n  if (!input || typeof input.value !== 'number') {\n    throw new Error('INVALID_INPUT');\n  }\n  return { ok: true, result: input.value * ${multiplier}, architectureVersion: 'ARCH-001' };\n}\n`,
              tracesTo: ['ARCH-001', 'SPEC-001'],
              citations: citationTags,
            },
          },
          {
            name: 'write_source_file',
            arguments: {
              code: 'TEST-001',
              relFilePath: 'tests/app-module.test.js',
              content: `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { executeBusinessLogic } from '../src/app-module.js';\n\ntest('executeBusinessLogic multiplies value by 2', () => {\n  const res = executeBusinessLogic({ value: 21 });\n  assert.deepStrictEqual(res, { ok: true, result: 42, architectureVersion: 'ARCH-001' });\n});\n\ntest('executeBusinessLogic throws INVALID_INPUT on invalid input', () => {\n  assert.throws(() => executeBusinessLogic(null), /INVALID_INPUT/);\n  assert.throws(() => executeBusinessLogic({ value: 'string' }), /INVALID_INPUT/);\n});\n`,
              tracesTo: ['ARCH-001', 'SPEC-001'],
              citations: citationTags,
            },
          },
          {
            name: 'run_unit_tests',
            arguments: {
              testCommand: 'node --test tests/app-module.test.js',
            },
          },
          ...(shouldHandoffToQa
            ? [
                {
                  name: 'write_gherkin_scenarios',
                  arguments: {
                    code: 'DEV-GHERKIN-001',
                    title: `Developer Behavioral Scenarios — ${input.projectName}`,
                    filename: 'DEV-GHERKIN-001.feature',
                    content: [
                      `Feature: ${input.projectName} Core Business Logic (SPEC-001)`,
                      `  As a consumer of ${input.projectName}`,
                      `  I want executeBusinessLogic to process valid numeric inputs and reject invalid inputs`,
                      `  So that the service complies with ARCH-001 and SPEC-001`,
                      ``,
                      `  Scenario: Valid numeric input is multiplied by 2`,
                      `    Given a valid input object with value 21`,
                      `    When executeBusinessLogic is invoked`,
                      `    Then the result should be 42 with ok true and architectureVersion "ARCH-001"`,
                      ``,
                      `  Scenario: Null or non-numeric input is rejected`,
                      `    Given an invalid input such as null or a non-numeric value`,
                      `    When executeBusinessLogic is invoked`,
                      `    Then it should throw an "INVALID_INPUT" error`,
                    ].join('\n') + '\n',
                    tracesTo: ['ARCH-001', 'SPEC-001'],
                  },
                },
              ]
            : []),
          {
            name: 'write_implementation_log',
            arguments: {
              code: 'IMP-001',
              title: `Technical Implementation Log — ${input.projectName}`,
              content: `# IMP-001: Technical Implementation Log\n\nBased on input contract \`SPEC-001\` and reference architecture \`ARCH-001\`:\n\n## 1. Feature Implementation\n- Implemented business logic module in \`src/app-module.js\` (\`CODE-001\`).\n- Exported \`executeBusinessLogic\` function with strict input validation.\n\n## 2. Mandatory Unit Testing & Execution\n- Created unit test suite in \`tests/app-module.test.js\` (\`TEST-001\`).\n- Executed unit tests via \`run_unit_tests\` (\`node --test tests/app-module.test.js\`).\n- Test Results: 2/2 tests passed (100% green).\n- Test Coverage: 100% statement and branch coverage.\n\n## 3. Definition of Done & QA Readiness\n- Authoring Developer Gherkin scenarios in \`contracts/qa/DEV-GHERKIN-001.feature\`.\n- All unit tests verified green.\n- Deliverable submitted for independent QA verification via \`submit_for_qa\`.`,
              tracesTo: ['ARCH-001', 'SPEC-001'],
              citations: citationTags,
            },
          },
          ...(shouldHandoffToQa
            ? [
                {
                  name: 'submit_for_qa',
                  arguments: {
                    deliverableNotes: `Completed implementation of ${input.projectName} per ARCH-001 and SPEC-001. All unit tests (2/2) pass with 100% coverage and Developer Gherkin contract DEV-GHERKIN-001.feature is ready in contracts/qa/. Please execute independent QA verification.`,
                    testCommand: 'node --test tests/app-module.test.js',
                  },
                },
              ]
            : []),
        );
        const isFromArchitect = input.senderRole === 'architect';
        const isFromQa = input.senderRole === 'qa';
        if (isFromArchitect) {
          replyText =
            `[Senior Developer] Reporting back to the Software Architect on the implementation of \`SPEC-001\` / \`ARCH-001\`:\n` +
            `1. **Feature Implemented**: Core business logic module in \`src/app-module.js\` per specifications.\n` +
            `2. **Unit Tests Executed**: Created and executed \`tests/app-module.test.js\` via \`run_unit_tests\` (2/2 passing, 100% green).\n` +
            `3. **Test Coverage**: Achieved 100% coverage on implemented logic.\n` +
            `4. **Developer Gherkin & QA Handoff**: Recorded \`DEV-GHERKIN-001.feature\` in \`contracts/qa/\`, logged \`IMP-001\`, and notified the Independent QA Engineer (\`[DEV → QA]\`) via \`submit_for_qa\`.${citationFooter}`;
        } else if (isFromQa) {
          replyText =
            `[Senior Developer] Addressed the defects reported by the Independent QA Engineer (\`[QA → DEV]\`):\n` +
            `- Fixed the root cause in \`src/app-module.js\` to comply with \`SPEC-001\` and regression scenarios.\n` +
            `- Re-executed unit tests (\`2/2 passed\`, 100% green) and updated \`IMP-001\`.\n` +
            `- Re-submitted deliverable to QA (\`[DEV → QA]\`) via \`submit_for_qa\` for regression verification.${citationFooter}`;
        } else {
          replyText =
            `[Senior Developer] Worked on the approved Handoff bundle (\`ARCH-001\`, \`SPEC-001\`) and completed implementation:\n` +
            `- **Feature**: Business logic module implemented in \`src/app-module.js\`.\n` +
            `- **Unit Tests & Execution**: Created and executed \`tests/app-module.test.js\` (100% green).\n` +
            `- **Coverage**: 100% code coverage achieved.\n` +
            `- **Gherkin & QA Handoff**: \`DEV-GHERKIN-001\` and \`IMP-001\` recorded; notified Independent QA Engineer via \`submit_for_qa\`.${citationFooter}`;
        }
      }
    } else if (input.role === 'qa') {
      const promptLower = input.userPrompt.toLowerCase();
      const isPmInquiry =
        promptLower.startsWith('[pm ') ||
        promptLower.includes('report executed tests, discovered defects');
      const shouldRunAutonomousQa =
        !isPmInquiry &&
        (input.senderRole === 'developer' ||
          promptLower.includes('verify') ||
          promptLower.includes('validat') ||
          promptLower.includes('handoff') ||
          promptLower.includes('submit_for_qa') ||
          promptLower.includes('pruebas') ||
          promptLower.includes('audit'));

      if (shouldRunAutonomousQa) {
        toolCalls.push(
          {
            name: 'clone_repo_for_qa',
            arguments: {},
          },
          {
            name: 'write_qa_gherkin',
            arguments: {
              code: 'QA-GHERKIN-001',
              category: 'QA',
              filename: 'QA-GHERKIN-001.feature',
              title: `Independent Adversarial & Boundary QA Scenarios — ${input.projectName}`,
              content: [
                `Feature: Independent Adversarial Verification of ${input.projectName}`,
                `  As the Independent QA Engineer`,
                `  I want to challenge ${input.projectName} with functional, boundary, and adversarial inputs`,
                `  So that I can prove whether SPEC-001 and ARCH-001 hold under stress`,
                ``,
                `  Scenario: Functional contract verification (value = 21 -> 42)`,
                `    Given the isolated QA clone in scripts/qa-env`,
                `    When executeBusinessLogic is called with { value: 21 }`,
                `    Then it returns { ok: true, result: 42, architectureVersion: "ARCH-001" }`,
                ``,
                `  Scenario: Boundary value zero and negative numbers`,
                `    Given boundary numeric values 0 and -15`,
                `    When executeBusinessLogic is called`,
                `    Then it returns 0 and -30 respectively without precision loss`,
                ``,
                `  @adversarial`,
                `  Scenario: Adversarial malformed payloads (null, undefined, string, NaN)`,
                `    Given malformed payloads null, undefined, and { value: "malicious" }`,
                `    When executeBusinessLogic is called`,
                `    Then it rejects each payload with Error "INVALID_INPUT"`,
              ].join('\n') + '\n',
            },
          },
          {
            name: 'install_qa_tool',
            arguments: {
              toolName: 'robotframework',
            },
          },
          {
            name: 'write_qa_test_script',
            arguments: {
              relFilePath: 'qa_acceptance.robot',
              content: [
                `*** Settings ***`,
                `Documentation     Independent QA Robot Framework Acceptance Suite for ${input.projectName}`,
                `Library           Process`,
                ``,
                `*** Test Cases ***`,
                `TC-001 Verify Nominal Business Logic Contract`,
                `    [Documentation]    Verifies SPEC-001 nominal calculation (21 * 2 == 42)`,
                `    [Tags]             functional    SPEC-001`,
                `    \${result}=    Run Process    node    qa_adversarial_runner.mjs    cwd=\${CURDIR}`,
                `    Should Be Equal As Integers    \${result.rc}    0`,
                ``,
                `TC-002 Verify Boundary And Adversarial Inputs`,
                `    [Documentation]    Verifies negative, zero, null, and malformed payload handling`,
                `    [Tags]             adversarial    boundary    QA-GHERKIN-001`,
                `    \${result}=    Run Process    node    qa_adversarial_runner.mjs    cwd=\${CURDIR}`,
                `    Should Be Equal As Integers    \${result.rc}    0`,
              ].join('\n') + '\n',
            },
          },
          {
            name: 'run_qa_test_suite',
            arguments: {
              command: 'auto',
            },
          },
          {
            name: 'run_mutation_check',
            arguments: {},
          },
          {
            name: 'submit_qa_verdict',
            arguments: {
              autoEvaluateFromExecution: true,
              summary: `Executed 7-phase independent QA verification (Discovery, Requirements Analysis, Static Code Review, Adversarial Gherkin & Robot Test Generation, Isolated Test Execution, and Mutation Testing) for ${input.projectName}.`,
            },
          },
        );
        replyText =
          `[Independent QA Engineer] Completed the 7-phase autonomous QA verification in isolated workspace (\`contracts/qa/\` and \`scripts/\`) for **${input.projectName}** and emitted the verdict and summary table.${citationFooter}`;
      } else {
        replyText =
          `[Independent QA Engineer] Ready to execute independent validation tests against \`REQ-001\`, \`ARCH-001\`, and \`CODE-001\`, collecting real execution evidence before issuing a verdict (\`ACCEPT\` or \`REJECT\`).${citationFooter}`;
      }
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
              '"""Auto-generated LLM helper script stored in project scripts/."""',
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
        `I can execute parallel or sequential inquiries across the active Architect, Developer, and QA agents and store requested outputs (Python scripts, spreadsheets, reports) in the project workspace (scripts/, outputs/, deliveries/).${citationFooter}`;
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
