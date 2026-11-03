import { describe, it, expect, vi } from 'vitest';
import {
  cleanModelOutput,
  DEFAULT_FREE_PROVIDERS,
  LLMRouter,
  ProviderConfig,
} from '../src/runtime/llm-router.js';

describe('LLMRouter Unit & Failover Engine', () => {
  it('initializes with default free providers including keyless community backends', () => {
    const router = new LLMRouter({
      providers: DEFAULT_FREE_PROVIDERS,
      strategy: 'auto:smart',
    });

    const providers = router.listProviders();
    expect(providers.length).toBeGreaterThanOrEqual(2);
    expect(providers.some((p) => p.id === 'pollinations')).toBe(true);
    expect(providers.some((p) => p.id === 'aihorde')).toBe(true);
  });

  it('safely maps arbitrary model names to provider defaultModel when unsupported', () => {
    const mockProvider: ProviderConfig = {
      id: 'mock-p1',
      name: 'Mock Provider',
      endpoint: 'http://localhost:9999/v1/chat/completions',
      defaultModel: 'openai-default',
      supportedModels: ['openai-default', 'special-model'],
      modelMapping: {
        'claude-haiku-5-5': 'special-model',
      },
    };

    const router = new LLMRouter({ providers: [mockProvider] });

    // 1. Explicit mapping matches
    expect(router.resolveModelForProvider(mockProvider, 'claude-haiku-5-5')).toBe('special-model');

    // 2. Direct supportedModel matches
    expect(router.resolveModelForProvider(mockProvider, 'special-model')).toBe('special-model');

    // 3. Unknown model gracefully falls back to defaultModel to avoid HTTP 404
    expect(router.resolveModelForProvider(mockProvider, 'unsupported-arbitrary-model')).toBe(
      'openai-default',
    );

    // 4. Undefined model falls back to defaultModel
    expect(router.resolveModelForProvider(mockProvider, undefined)).toBe('openai-default');
  });

  it('cleans thinking tokens and reasoning blocks from LLM completions', () => {
    const textWithThink = '<think>\nAnalyzing prompt...\nDone\n</think>Final architecture plan.';
    expect(cleanModelOutput(textWithThink)).toBe('Final architecture plan.');

    const textWithChannel =
      '<|channel>thought\nThinking Process:\n1. Step 1\n<|channel>PO CLI is ready.';
    expect(cleanModelOutput(textWithChannel)).toBe('PO CLI is ready.');

    const normalText = 'Direct plain response without tags.';
    expect(cleanModelOutput(normalText)).toBe('Direct plain response without tags.');
  });

  it('fails over to next provider when candidate encounters rate limit or server error', async () => {
    const mockProviderFail: ProviderConfig = {
      id: 'failing-provider',
      name: 'Failing Provider',
      endpoint: 'http://localhost:59991/v1/chat/completions',
      defaultModel: 'fail-model',
      supportedModels: ['test-model'],
      intelligenceScore: 0.9,
    };

    const mockProviderSuccess: ProviderConfig = {
      id: 'working-provider',
      name: 'Working Provider',
      endpoint: 'http://localhost:59992/v1/chat/completions',
      defaultModel: 'work-model',
      supportedModels: ['test-model'],
      intelligenceScore: 0.5,
    };

    const router = new LLMRouter({
      providers: [mockProviderFail, mockProviderSuccess],
      strategy: 'auto:smart',
      fallbackEnabled: true,
      requestTimeoutMs: 1000,
    });

    // Mock fetch to simulate 429 on mockProviderFail and 200 on mockProviderSuccess
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('59991')) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('59992')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Fallback response from working provider' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL ${urlStr}`);
    });

    try {
      const result = await router.completion({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(result.providerId).toBe('working-provider');
      expect(result.text).toBe('Fallback response from working provider');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('handles real network free completion with zero configuration', async () => {
    const router = new LLMRouter({
      providers: DEFAULT_FREE_PROVIDERS,
      strategy: 'auto:smart',
      fallbackEnabled: true,
      requestTimeoutMs: 40000,
    });

    const result = await router.completion({
      model: 'claude-haiku-5-5',
      messages: [
        { role: 'system', content: 'You are an architect. Reply in 3 words.' },
        { role: 'user', content: 'Say hello' },
      ],
    });

    expect(result.text).toBeTruthy();
    expect(result.text.length).toBeGreaterThan(0);
    const validProviderIds = DEFAULT_FREE_PROVIDERS.map((p) => p.id);
    expect(validProviderIds).toContain(result.providerId);
  }, 45000);
});

