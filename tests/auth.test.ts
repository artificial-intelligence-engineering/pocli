import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuthStorage } from '../src/core/auth.js';

describe('AuthStorage subsystem', () => {
  const tmpAuthFile = path.join(
    os.tmpdir(),
    `pocli-test-auth-${Date.now()}.json`,
  );
  const origEnv = { ...process.env };

  beforeEach(() => {
    AuthStorage.setCustomAuthPath(tmpAuthFile);
    AuthStorage.clear();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    AuthStorage.clear();
    AuthStorage.setCustomAuthPath(null);
    process.env = { ...origEnv };
  });

  it('saves and retrieves API keys from file with 0600 permissions', () => {
    AuthStorage.setApiKey('anthropic', 'sk-ant-api03-test-secret-12345');

    expect(fs.existsSync(tmpAuthFile)).toBe(true);
    const key = AuthStorage.getApiKey('anthropic');
    expect(key).toBe('sk-ant-api03-test-secret-12345');
    expect(AuthStorage.getApiKeySource('anthropic')).toBe('file');

    // Check permissions on POSIX
    if (process.platform !== 'win32') {
      const stats = fs.statSync(tmpAuthFile);
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it('prioritizes environment variables over file storage', () => {
    AuthStorage.setApiKey('openai', 'sk-file-key-1111');
    process.env.OPENAI_API_KEY = 'sk-env-key-9999';

    expect(AuthStorage.getApiKey('openai')).toBe('sk-env-key-9999');
    expect(AuthStorage.getApiKeySource('openai')).toBe('env');

    // Removing env var falls back to file
    delete process.env.OPENAI_API_KEY;
    expect(AuthStorage.getApiKey('openai')).toBe('sk-file-key-1111');
    expect(AuthStorage.getApiKeySource('openai')).toBe('file');
  });

  it('masks API keys safely', () => {
    const masked = AuthStorage.maskApiKey('sk-ant-api03-abcdef1234567890');
    expect(masked).toContain('sk-ant-');
    expect(masked).toContain('***');
    expect(masked).toContain('7890');
    expect(masked).not.toBe('sk-ant-api03-abcdef1234567890');
  });

  it('removes keys and lists provider status', () => {
    AuthStorage.setApiKey('gemini', 'AIzaSyTestKey12345678');
    const providersBefore = AuthStorage.listProviders();
    const geminiBefore = providersBefore.find((p) => p.id === 'gemini');
    expect(geminiBefore?.status).toBe('CONFIGURED');
    expect(geminiBefore?.source).toBe('file');

    const removed = AuthStorage.removeApiKey('gemini');
    expect(removed).toBe(true);

    const providersAfter = AuthStorage.listProviders();
    const geminiAfter = providersAfter.find((p) => p.id === 'gemini');
    expect(geminiAfter?.status).toBe('NOT_CONFIGURED');
    expect(geminiAfter?.source).toBe('none');
  });

  it('supports OpenCode Zen with aliases and OPENCODE_API_KEY / OPENCODE_ZEN_API_KEY', () => {
    // 1. File persistence with alias 'zen'
    AuthStorage.setApiKey('zen', 'zen_live_testkey_12345678');
    expect(AuthStorage.getApiKey('opencode')).toBe('zen_live_testkey_12345678');
    expect(AuthStorage.getApiKey('zen')).toBe('zen_live_testkey_12345678');
    expect(AuthStorage.getApiKey('opencode-zen')).toBe('zen_live_testkey_12345678');

    const masked = AuthStorage.maskApiKey('zen_live_testkey_12345678');
    expect(masked).toContain('zen_');
    expect(masked).toContain('5678');

    // 2. Env variable precedence
    process.env.OPENCODE_API_KEY = 'zen_env_priority_99999999';
    expect(AuthStorage.getApiKey('opencode')).toBe('zen_env_priority_99999999');
    expect(AuthStorage.getApiKeySource('opencode')).toBe('env');

    delete process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_ZEN_API_KEY = 'zen_env_zen_alt_88888888';
    expect(AuthStorage.getApiKey('opencode')).toBe('zen_env_zen_alt_88888888');

    delete process.env.OPENCODE_ZEN_API_KEY;
    expect(AuthStorage.getApiKey('opencode')).toBe('zen_live_testkey_12345678');

    // 3. Removal via alias
    AuthStorage.removeApiKey('opencode-zen');
    expect(AuthStorage.getApiKey('opencode')).toBeUndefined();
  });

  it('lists Google Antigravity and normalizes antigravity aliases', () => {
    expect(AuthStorage.normalizeProviderId('antigravity')).toBe('gemini');
    expect(AuthStorage.normalizeProviderId('google-antigravity')).toBe('gemini');

    const providers = AuthStorage.listProviders();
    const antigravity = providers.find((p) => p.id === 'gemini');
    expect(antigravity?.name).toBe('Google Antigravity');
  });
});

