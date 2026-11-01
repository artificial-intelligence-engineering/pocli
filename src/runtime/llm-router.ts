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

export class LLMRouter {
  private providers: Map<string, ProviderConfig> = new Map();
  private trackers: Map<string, WindowTracker> = new Map();
  private strategy: RoutingStrategy;
  private fallbackEnabled: boolean;
  private requestTimeoutMs: number;

  constructor(config: RouterConfig) {
    this.strategy = config.strategy ?? 'auto:smart';
    this.fallbackEnabled = config.fallbackEnabled ?? true;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;

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
   * Sorts candidate providers by routing strategy score and health availability.
   */
  public selectCandidateChain(
    targetModel?: string,
    strategyOverride?: RoutingStrategy,
  ): ProviderConfig[] {
    const activeStrategy = strategyOverride ?? this.strategy;
    const now = Date.now();
    const allProviders = Array.from(this.providers.values());

    // Filter providers that support the requested model (or any provider if no model specified)
    const matching = targetModel
      ? allProviders.filter(
          (p) =>
            p.defaultModel === targetModel ||
            (p.supportedModels && p.supportedModels.includes(targetModel)),
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
      const modelToUse = payload.model ?? provider.defaultModel;

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

        return {
          text,
          providerId: provider.id,
          modelUsed: modelToUse,
          latencyMs,
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRateLimit = errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit');
        const isServerErr = errMsg.includes('500') || errMsg.includes('502') || errMsg.includes('503');

        // Apply backoff/cooldown (30s for 429, 15s for 5xx)
        const cooldownMs = isRateLimit ? 30000 : isServerErr ? 15000 : 5000;
        this.recordFailure(provider.id, cooldownMs);
        errors.push({ providerId: provider.id, error: errMsg });

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
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 300)}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string };
          text?: string;
        }>;
      };

      const reply = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
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
 * Pre-configured default providers for out-of-the-box operation:
 * 1. Pollinations: zero-key free reasoning & general model
 * 2. OpenRouter Free: auto router for public free models
 * 3. Ollama: local inference on localhost:11434
 */
export const DEFAULT_FREE_PROVIDERS: ProviderConfig[] = [
  {
    id: 'pollinations',
    name: 'Pollinations AI (Zero-Key Free)',
    endpoint: 'https://text.pollinations.ai/openai/chat/completions',
    defaultModel: 'openai',
    supportedModels: ['openai', 'openai-fast', 'gpt-oss-20b'],
    limits: { rpm: 30, rpd: 2000 },
    intelligenceScore: 0.85,
    speedScore: 0.9,
  },
  {
    id: 'openrouter-free',
    name: 'OpenRouter Free Tier',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'openrouter/free',
    supportedModels: ['openrouter/free', 'google/gemma-2-9b-it:free', 'meta-llama/llama-3.2-3b-instruct:free'],
    limits: { rpm: 20, rpd: 200 },
    intelligenceScore: 0.8,
    speedScore: 0.75,
  },
  {
    id: 'ollama-local',
    name: 'Ollama Local Ingestion',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    defaultModel: 'llama3.2',
    supportedModels: ['llama3.2', 'deepseek-r1', 'qwen2.5-coder'],
    isLocal: true,
    intelligenceScore: 0.8,
    speedScore: 0.95,
  },
];

