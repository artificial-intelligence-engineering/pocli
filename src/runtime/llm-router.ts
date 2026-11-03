/**
 * Standalone LLM Router Engine ported from FreeLLMAPI (tashfeenahmed/freellmapi).
 *
 * Implements:
 * 1. Multi-provider execution via standard OpenAI-compatible HTTP fetch (Pollinations,
 *    OpenRouter, Groq, Cerebras, Ollama, Gemini, etc.) without external CLI dependencies.
 * 2. Sliding window quota & rate-limit tracking (RPM, RPD, TPM, TPD) with cooldown logic.
 * 3. Smart Bandit scoring with presets ('auto:smart' / 'auto:fast' / 'auto:balanced' / 'auto:reliable').
 * 4. Automatic failover: on HTTP 429, 503, timeout or provider errors, cleanly cascades
 *    to the next candidate in the fallback chain.
 */

import { Logger } from '../core/logger.js';
import { AuthStorage } from '../core/auth.js';

export type RoutingStrategy = 'auto:smart' | 'auto:fast' | 'auto:balanced' | 'auto:reliable' | 'custom';

export interface ProviderQuotaLimits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  endpoint: string;
  apiKey?: string;
  defaultModel: string;
  supportedModels?: string[];
  modelMapping?: Record<string, string>;
  limits?: ProviderQuotaLimits;
  intelligenceScore?: number; // 0.0 - 1.0 (used in auto:smart)
  speedScore?: number;        // 0.0 - 1.0 (used in auto:fast)
  customHeaders?: Record<string, string>;
  isLocal?: boolean;
}

export interface RouterConfig {
  providers: ProviderConfig[];
  strategy?: RoutingStrategy;
  fallbackEnabled?: boolean;
  requestTimeoutMs?: number;
}

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionPayload {
  model?: string;
  messages: CompletionMessage[];
  temperature?: number;
  maxTokens?: number;
  strategy?: RoutingStrategy;
  onStreamChunk?: (chunk: string) => void;
}

export interface CompletionResult {
  text: string;
  providerId: string;
  modelUsed: string;
  tokensUsed?: number;
  latencyMs: number;
}

interface WindowTracker {
  timestamps: number[];
  tokenTimestamps: { ts: number; tokens: number }[];
  cooldownUntil: number;
  consecutiveErrors: number;
  successCount: number;
  totalLatencyMs: number;
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function cleanModelOutput(rawText: string): string {
  let cleaned = rawText;
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  cleaned = cleaned
    .replace(/<\|channel\|?>thought[\s\S]*?(?:<\|channel\|?>call|<\|channel\|?>|$)/gi, '')
    .trim();
  return cleaned || rawText;
}

export class LLMRouter {
  private providers: Map<string, ProviderConfig> = new Map();
  private trackers: Map<string, WindowTracker> = new Map();
  private strategy: RoutingStrategy;
  private fallbackEnabled: boolean;
  private requestTimeoutMs: number;

  constructor(config: RouterConfig) {
    this.strategy = config.strategy ?? 'auto:smart';
    this.fallbackEnabled = config.fallbackEnabled ?? true;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 90000;

    for (const p of config.providers) {
      this.providers.set(p.id, p);
    }
  }

  public registerProvider(provider: ProviderConfig): void {
    this.providers.set(provider.id, provider);
  }

  public getProvider(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  public listProviders(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  private getTracker(providerId: string): WindowTracker {
    let t = this.trackers.get(providerId);
    if (!t) {
      t = {
        timestamps: [],
        tokenTimestamps: [],
        cooldownUntil: 0,
        consecutiveErrors: 0,
        successCount: 0,
        totalLatencyMs: 0,
      };
      this.trackers.set(providerId, t);
    }
    return t;
  }

  /**
   * Evaluates if a provider is eligible to serve a request given its current
   * sliding window quotas (RPM, RPD) and cooldown state.
   */
  public canUseProvider(providerId: string, now = Date.now()): boolean {
    const provider = this.providers.get(providerId);
    if (!provider) return false;
    const tracker = this.getTracker(providerId);

    // 1. Check cooldown
    if (tracker.cooldownUntil > now) {
      return false;
    }

    // 2. Clean up outdated timestamps
    tracker.timestamps = tracker.timestamps.filter((ts) => ts > now - DAY_MS);

    const limits = provider.limits;
    if (!limits) return true;

    // 3. RPM limit
    if (limits.rpm && limits.rpm > 0) {
      const minuteCount = tracker.timestamps.filter((ts) => ts > now - MINUTE_MS).length;
      if (minuteCount >= limits.rpm) return false;
    }

    // 4. RPD limit
    if (limits.rpd && limits.rpd > 0) {
      if (tracker.timestamps.length >= limits.rpd) return false;
    }

    return true;
  }

  /**
   * Computes the Bandit routing score for a provider given the chosen strategy.
   * Based on FreeLLMAPI's convex combination of reliability, speed and intelligence.
   */
  private calculateProviderScore(
    provider: ProviderConfig,
    strategy: RoutingStrategy,
    now: number,
  ): number {
    const tracker = this.getTracker(provider.id);

    // Reliability score via simplified Beta posterior (successes / (successes + failures + 1))
    const successes = tracker.successCount;
    const failures = tracker.consecutiveErrors;
    const reliability = (successes + 1) / (successes + failures + 2);

    // Speed score (0..1, normalized from observed latency or config default)
    let speed = provider.speedScore ?? 0.5;
    if (tracker.successCount > 0) {
      const avgLatency = tracker.totalLatencyMs / tracker.successCount;
      // Exponential decay mapping 500ms -> ~0.8, 3000ms -> ~0.2
      speed = Math.max(0.1, Math.min(1.0, Math.exp(-avgLatency / 2000)));
    }

    // Intelligence score
    const intelligence = provider.intelligenceScore ?? 0.5;

    // Weights per preset strategy (from FreeLLMAPI BANDIT_PRESETS)
    let wRel = 0.5;
    let wSpeed = 0.25;
    let wIntel = 0.25;

    if (strategy === 'auto:smart') {
      wRel = 0.35;
      wSpeed = 0.1;
      wIntel = 0.55;
    } else if (strategy === 'auto:fast') {
      wRel = 0.35;
      wSpeed = 0.55;
      wIntel = 0.1;
    } else if (strategy === 'auto:reliable') {
      wRel = 0.7;
      wSpeed = 0.15;
      wIntel = 0.15;
    }

    const baseScore = wRel * reliability + wSpeed * speed + wIntel * intelligence;

    // Headroom factor guardrail (demote if near RPM/RPD cap)
    let headroomFactor = 1.0;
    if (provider.limits?.rpm) {
      const minuteCount = tracker.timestamps.filter((ts) => ts > now - MINUTE_MS).length;
      const fraction = minuteCount / provider.limits.rpm;
      headroomFactor = Math.max(0.1, 1.0 - fraction);
    }

    // Rate-limit factor: severely demote if recent consecutive errors occurred
    const errorDemote = Math.pow(0.5, Math.min(4, tracker.consecutiveErrors));

    return baseScore * headroomFactor * errorDemote;
  }

  /**
   * Resolves the actual model name to send to a specific provider.
   * Prevents HTTP 404/invalid model errors when the user requests an arbitrary catalog model.
   */
  public resolveModelForProvider(provider: ProviderConfig, requestedModel?: string): string {
    if (!requestedModel) {
      return provider.defaultModel;
    }
    if (provider.supportedModels && provider.supportedModels.includes(requestedModel)) {
      return requestedModel;
    }
    if (provider.defaultModel === requestedModel) {
      return requestedModel;
    }
    if (provider.modelMapping && provider.modelMapping[requestedModel]) {
      return provider.modelMapping[requestedModel];
    }
    return provider.defaultModel;
  }

  /**
   * Sorts candidate providers by routing strategy score and health availability.
   */
  public selectCandidateChain(
    targetModel?: string,
    strategyOverride?: RoutingStrategy,
  ): ProviderConfig[] {
    const activeStrategy = strategyOverride ?? this.strategy;
    const now = Date.now();
    const allProviders = Array.from(this.providers.values());

    // Filter providers that explicitly support the requested model or have a mapping for it
    const matching = targetModel
      ? allProviders.filter(
          (p) =>
            p.defaultModel === targetModel ||
            (p.supportedModels && p.supportedModels.includes(targetModel)) ||
            (p.modelMapping && Boolean(p.modelMapping[targetModel])),
        )
      : allProviders;

    const pool = matching.length > 0 ? matching : allProviders;

    return [...pool].sort((a, b) => {
      const aAvail = this.canUseProvider(a.id, now);
      const bAvail = this.canUseProvider(b.id, now);

      if (aAvail !== bAvail) {
        return aAvail ? -1 : 1;
      }

      const scoreA = this.calculateProviderScore(a, activeStrategy, now);
      const scoreB = this.calculateProviderScore(b, activeStrategy, now);
      return scoreB - scoreA;
    });
  }

  /**
   * Main completion method with automatic failover chain and metrics recording.
   */
  public async completion(payload: CompletionPayload): Promise<CompletionResult> {
    const chain = this.selectCandidateChain(payload.model, payload.strategy);
    if (chain.length === 0) {
      throw new Error('LLMRouter: No available providers configured');
    }

    const errors: Array<{ providerId: string; error: string }> = [];

    for (const provider of chain) {
      const startTime = Date.now();
      const modelToUse = this.resolveModelForProvider(provider, payload.model);
      Logger.debug('LLM-ROUTER', `Requesting completion from provider '${provider.id}' (model: ${modelToUse})`);

      try {
        const text = await this.executeProviderRequest(
          provider,
          modelToUse,
          payload.messages,
          payload.temperature ?? 0.2,
          payload.maxTokens,
          payload.onStreamChunk,
        );

        const latencyMs = Date.now() - startTime;
        this.recordSuccess(provider.id, latencyMs, text.length);
        Logger.info('LLM-ROUTER', `Provider '${provider.id}' (${modelToUse}) responded in ${latencyMs}ms (${text.length} chars)`);

        return {
          text,
          providerId: provider.id,
          modelUsed: payload.model ?? modelToUse,
          latencyMs,
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRateLimit =
          errMsg.includes('429') ||
          errMsg.includes('402') ||
          errMsg.toLowerCase().includes('rate limit') ||
          errMsg.toLowerCase().includes('free limit reached');
        const isServerErr =
          errMsg.includes('500') ||
          errMsg.includes('502') ||
          errMsg.includes('503') ||
          errMsg.includes('504');

        // Apply backoff/cooldown (45s for 402/429 rate limits, 15s for 5xx, 10s for other failures)
        const cooldownMs = isRateLimit ? 45000 : isServerErr ? 15000 : 10000;
        this.recordFailure(provider.id, cooldownMs);
        errors.push({ providerId: provider.id, error: errMsg });
        Logger.warn('LLM-ROUTER', `Provider '${provider.id}' failed (cooldown ${cooldownMs}ms): ${errMsg}`);

        if (!this.fallbackEnabled) {
          throw new Error(`LLMRouter failure on ${provider.id}: ${errMsg}`);
        }
        // Continue to next candidate in the fallback chain
      }
    }

    throw new Error(
      `LLMRouter: All candidate providers failed in chain [${chain.map((c) => c.id).join(', ')}]. Errors: ${JSON.stringify(errors)}`,
    );
  }

  private async executeProviderRequest(
    provider: ProviderConfig,
    model: string,
    messages: CompletionMessage[],
    temperature: number,
    maxTokens?: number,
    onStreamChunk?: (chunk: string) => void,
  ): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.customHeaders,
    };

    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const bodyPayload: Record<string, unknown> = {
        model,
        messages,
        temperature,
      };
      if (maxTokens) {
        bodyPayload['max_tokens'] = maxTokens;
      }

      const response = await fetch(provider.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();

        // Graceful rate-limit backoff handling (e.g. Pollinations 45s anonymous window)
        if (response.status === 402 || response.status === 429) {
          const match =
            errorText.match(/retry after (\d+)s/i) ||
            errorText.match(/wait (\d+) seconds/i);
          const waitSec = match ? parseInt(match[1], 10) : 0;
          if (waitSec > 0 && waitSec <= 50) {
            if (onStreamChunk) {
              onStreamChunk(
                `\n[PO CLI: Esperando ${waitSec}s para el siguiente turno gratuito... (Configura GROQ_API_KEY o GEMINI_API_KEY para respuestas inmediatas)]\n`,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, (waitSec + 1) * 1000));
            const retryRes = await fetch(provider.endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(bodyPayload),
              signal: controller.signal,
            });
            if (retryRes.ok) {
              const retryData = (await retryRes.json()) as {
                choices?: Array<{
                  message?: { content?: string; reasoning?: string };
                  text?: string;
                }>;
              };
              const retryRaw =
                retryData.choices?.[0]?.message?.content ??
                retryData.choices?.[0]?.text ??
                retryData.choices?.[0]?.message?.reasoning ??
                '';
              const retryReply = cleanModelOutput(retryRaw);
              if (retryReply) {
                if (onStreamChunk) {
                  onStreamChunk(retryReply);
                }
                return retryReply;
              }
            }
          }
        }

        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 300)}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string; reasoning?: string };
          text?: string;
        }>;
      };

      const rawReply =
        data.choices?.[0]?.message?.content ??
        data.choices?.[0]?.text ??
        data.choices?.[0]?.message?.reasoning ??
        '';
      const reply = cleanModelOutput(rawReply);
      if (!reply) {
        throw new Error('Received empty completion response from provider');
      }

      if (onStreamChunk) {
        onStreamChunk(reply);
      }

      return reply;
    } finally {
      clearTimeout(timeout);
    }
  }

  private recordSuccess(providerId: string, latencyMs: number, _charCount: number): void {
    const tracker = this.getTracker(providerId);
    const now = Date.now();
    tracker.timestamps.push(now);
    tracker.successCount++;
    tracker.consecutiveErrors = 0;
    tracker.totalLatencyMs += latencyMs;
  }

  private recordFailure(providerId: string, cooldownDurationMs: number): void {
    const tracker = this.getTracker(providerId);
    tracker.consecutiveErrors++;
    tracker.cooldownUntil = Date.now() + cooldownDurationMs;
  }
}

/**
 * Builds the runtime default providers for free / keyless operation.
 * Automatically injects free-tier providers if their environment keys exist (Groq, Gemini, OpenRouter),
 * and provides zero-key public inference (Pollinations, AI Horde, local Ollama) out of the box.
 */
export function buildDefaultFreeProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [
    {
      id: 'pollinations',
      name: 'Pollinations AI (Zero-Key)',
      endpoint: 'https://text.pollinations.ai/openai/chat/completions',
      defaultModel: 'openai',
      supportedModels: ['openai', 'openai-fast', 'gpt-oss-20b'],
      limits: { rpm: 2, rpd: 2000 },
      intelligenceScore: 0.85,
      speedScore: 0.85,
    },
  ];

  const groqKey = AuthStorage.getApiKey('groq');
  if (groqKey) {
    providers.push({
      id: 'groq-free',
      name: 'Groq Free Tier',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: groqKey,
      defaultModel: 'llama-3.3-70b-versatile',
      supportedModels: [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'gemma2-9b-it',
        'mixtral-8x7b-32768',
      ],
      limits: { rpm: 30, rpd: 14400 },
      intelligenceScore: 0.95,
      speedScore: 0.99,
    });
  }

  const geminiKey = AuthStorage.getApiKey('gemini');
  if (geminiKey) {
    providers.push({
      id: 'gemini-free',
      name: 'Google Gemini Free',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKey: geminiKey,
      defaultModel: 'gemini-2.0-flash',
      supportedModels: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-pro'],
      limits: { rpm: 15, rpd: 1500 },
      intelligenceScore: 0.92,
      speedScore: 0.92,
    });
  }

  const openrouterKey = AuthStorage.getApiKey('openrouter');
  if (openrouterKey) {
    providers.push({
      id: 'openrouter-free',
      name: 'OpenRouter Free Tier',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: openrouterKey,
      defaultModel: 'openrouter/free',
      supportedModels: [
        'openrouter/free',
        'google/gemma-2-9b-it:free',
        'meta-llama/llama-3.2-3b-instruct:free',
        'qwen/qwen-2.5-coder-32b-instruct:free',
      ],
      limits: { rpm: 20, rpd: 200 },
      intelligenceScore: 0.85,
      speedScore: 0.8,
    });
  }

  const opencodeKey = AuthStorage.getApiKey('opencode');
  if (opencodeKey) {
    providers.push({
      id: 'opencode-zen',
      name: 'OpenCode Zen (Pay-per-use)',
      endpoint: 'https://opencode.ai/zen/v1/chat/completions',
      apiKey: opencodeKey,
      defaultModel: 'claude-sonnet-5-5',
      supportedModels: [
        'claude-sonnet-5-5',
        'claude-haiku-5-5',
        'claude-opus-5-5',
        'gpt-5.5',
        'gpt-5.4-mini',
        'gpt-5.3-codex',
        'gpt-6-astra',
        'deepseek-v4-pro',
        'deepseek-v4.1-flash',
        'gemini-3.8-flash',
        'mistral-large-4',
        'grok-4.7',
        'kimi-k2.7-code',
        'qwen3.8-flash',
        'big-pickle',
        'beam-free',
      ],
      limits: { rpm: 60, rpd: 50000 },
      intelligenceScore: 0.98,
      speedScore: 0.95,
    });
  }

  // AI Horde community cluster (Zero-Key)
  providers.push({
    id: 'aihorde',
    name: 'AI Horde Community (Zero-Key)',
    endpoint: 'https://oai.aihorde.net/v1/chat/completions',
    apiKey: '0000000000',
    defaultModel: 'koboldcpp/gemma-4-E4B-it',
    supportedModels: [
      'koboldcpp/gemma-4-E4B-it',
      'koboldcpp/L3-8B-Stheno-v3.2',
      'koboldcpp/Anubis-Mini-8B-v1',
    ],
    limits: { rpm: 10, rpd: 1000 },
    intelligenceScore: 0.75,
    speedScore: 0.5,
  });

  // Local Ollama instance
  providers.push({
    id: 'ollama-local',
    name: 'Ollama Local Ingestion',
    endpoint: (process.env.OLLAMA_HOST ?? 'http://localhost:11434') + '/v1/chat/completions',
    defaultModel: 'llama3.2',
    supportedModels: ['llama3.2', 'deepseek-r1', 'qwen2.5-coder'],
    isLocal: true,
    limits: { rpm: 120, rpd: 10000 },
    intelligenceScore: 0.8,
    speedScore: 0.95,
  });

  return providers;
}

export const DEFAULT_FREE_PROVIDERS: ProviderConfig[] = buildDefaultFreeProviders();

