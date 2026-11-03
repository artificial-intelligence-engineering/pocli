import { describe, it, expect } from 'vitest';
import {
  AVAILABLE_MODELS_CATALOG,
  resolveModelSpec,
} from '../src/runtime/llm-gateway.js';
import { buildDefaultFreeProviders } from '../src/runtime/llm-router.js';
import { AuthStorage } from '../src/core/auth.js';

describe('Issue #16 — Realistic OpenCode Zen Model Catalog', () => {
  it('1. Model Catalog: contains real OpenCode Zen models and removes outdated placeholders', () => {
    const zenModels = AVAILABLE_MODELS_CATALOG.filter((m) => m.provider === 'opencode');
    expect(zenModels.length).toBeGreaterThanOrEqual(14);

    const modelIds = zenModels.map((m) => m.modelId);

    // Frontier & Coding Models in OpenCode Zen
    expect(modelIds).toContain('claude-sonnet-5-5');
    expect(modelIds).toContain('claude-haiku-5-5');
    expect(modelIds).toContain('claude-opus-5-5');
    expect(modelIds).toContain('gpt-5.5');
    expect(modelIds).toContain('gpt-5.4-mini');
    expect(modelIds).toContain('gpt-5.3-codex');
    expect(modelIds).toContain('deepseek-v4-pro');
    expect(modelIds).toContain('deepseek-v4.1-flash');
    expect(modelIds).toContain('gemini-3.8-flash');
    expect(modelIds).toContain('mistral-large-4');
    expect(modelIds).toContain('grok-4.7');
    expect(modelIds).toContain('kimi-k2.7-code');
    expect(modelIds).toContain('big-pickle');
    expect(modelIds).toContain('beam-free');

    // Outdated nonexistent Zen placeholders must not be present
    expect(modelIds).not.toContain('claude-3-7-sonnet');
    expect(modelIds).not.toContain('gpt-4o');
    expect(modelIds).not.toContain('qwen-2.5-coder-32b');
  });

  it('2. resolveModelSpec: correctly resolves OpenCode Zen model identifiers and prefixes', () => {
    const sonnet = resolveModelSpec('opencode/claude-sonnet-5-5');
    expect(sonnet).not.toBeNull();
    expect(sonnet?.provider).toBe('opencode');
    expect(sonnet?.displayName).toBe('Claude Sonnet 5.5 (Zen)');
    expect(sonnet?.vendor).toBe('ANTHROPIC');

    const deepseek = resolveModelSpec('deepseek-v4-pro');
    expect(deepseek).not.toBeNull();
    expect(deepseek?.provider).toBe('opencode');
    expect(deepseek?.displayName).toBe('DeepSeek V4 Pro (Zen)');

    const codex = resolveModelSpec('gpt-5.3-codex');
    expect(codex).not.toBeNull();
    expect(codex?.provider).toBe('opencode');
    expect(codex?.displayName).toBe('GPT-5.3 Codex (Zen)');
  });

  it('3. Router Dynamic Providers: configures OpenCode Zen with valid defaultModel and supportedModels', () => {
    // Temporarily ensure API key exists for test
    const originalKey = AuthStorage.getApiKey('opencode');
    try {
      if (!originalKey) {
        process.env.OPENCODE_ZEN_API_KEY = 'zen-test-key-mock';
      }

      const providers = buildDefaultFreeProviders();
      const zenProvider = providers.find((p) => p.id === 'opencode-zen');
      expect(zenProvider).toBeDefined();
      expect(zenProvider?.defaultModel).toBe('claude-sonnet-5-5');
      expect(zenProvider?.supportedModels).toContain('claude-sonnet-5-5');
      expect(zenProvider?.supportedModels).toContain('gpt-5.4-mini');
      expect(zenProvider?.supportedModels).toContain('deepseek-v4-pro');
    } finally {
      if (!originalKey) {
        delete process.env.OPENCODE_ZEN_API_KEY;
      }
    }
  });
});
