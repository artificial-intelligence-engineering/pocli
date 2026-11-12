import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuthStorage } from '../src/core/auth.js';
import {
  buildGoogleAuthUrl,
  decodeJwtPayload,
  generatePkcePair,
  startGoogleOidcLogin,
} from '../src/core/oidc.js';

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

  it('lists Google Antigravity with SSO support and normalizes antigravity aliases', () => {
    expect(AuthStorage.normalizeProviderId('antigravity')).toBe('gemini');
    expect(AuthStorage.normalizeProviderId('google-antigravity')).toBe('gemini');

    const providers = AuthStorage.listProviders();
    const antigravity = providers.find((p) => p.id === 'gemini');
    expect(antigravity?.name).toBe('Google Antigravity');
    expect(antigravity?.supportsSso).toBe(true);
  });

  it('stores OAuth client config and SSO credentials without env vars, and switches cleanly', async () => {
    AuthStorage.setOAuthClientConfig('gemini', {
      clientId: '123456.apps.googleusercontent.com',
      clientSecret: 'sec_test_123',
    });
    expect(AuthStorage.getOAuthClientConfig('gemini')).toEqual({
      clientId: '123456.apps.googleusercontent.com',
      clientSecret: 'sec_test_123',
    });

    AuthStorage.setOAuthCredentials('gemini', {
      clientId: '123456.apps.googleusercontent.com',
      clientSecret: 'sec_test_123',
      accessToken: 'ya29.test_access_token_abcdef',
      refreshToken: '1//test_refresh_token',
      expiresAt: Date.now() + 3600_000,
      email: 'dev@example.com',
    });

    expect(AuthStorage.isConfigured('gemini')).toBe(true);
    const providers = AuthStorage.listProviders();
    const antigravity = providers.find((p) => p.id === 'gemini');
    expect(antigravity?.status).toBe('CONFIGURED');
    expect(antigravity?.source).toBe('sso');
    expect(antigravity?.authMode).toBe('sso');
    expect(antigravity?.ssoEmail).toBe('dev@example.com');

    const cred = await AuthStorage.resolveProviderCredential('gemini');
    expect(cred).toEqual({
      mode: 'sso',
      token: 'ya29.test_access_token_abcdef',
    });

    // Switching to API KEY clears active SSO token while preserving OAuth client config
    AuthStorage.setApiKey('gemini', 'AIzaSyTestSwitchKey12345');
    expect(AuthStorage.getOAuthCredentials('gemini')).toBeUndefined();
    expect(AuthStorage.getOAuthClientConfig('gemini')?.clientId).toBe(
      '123456.apps.googleusercontent.com',
    );
    const credKey = await AuthStorage.resolveProviderCredential('gemini');
    expect(credKey).toEqual({
      mode: 'api_key',
      token: 'AIzaSyTestSwitchKey12345',
    });

    // Removing clears it
    expect(AuthStorage.removeApiKey('gemini')).toBe(true);
    expect(AuthStorage.isConfigured('gemini')).toBe(false);
  });

  it('refreshes expired Google OIDC access tokens using refreshToken', async () => {
    AuthStorage.setOAuthCredentials('gemini', {
      clientId: 'client-123.apps.googleusercontent.com',
      accessToken: 'ya29.expired_token',
      refreshToken: '1//valid_refresh',
      expiresAt: Date.now() - 10_000,
      email: 'user@example.com',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'ya29.refreshed_token_999',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    try {
      const cred = await AuthStorage.resolveProviderCredential('gemini');
      expect(cred).toEqual({
        mode: 'sso',
        token: 'ya29.refreshed_token_999',
      });
      expect(AuthStorage.getOAuthCredentials('gemini')?.accessToken).toBe(
        'ya29.refreshed_token_999',
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('generates PKCE URL and completes loopback OIDC callback flow', async () => {
    const pkce = generatePkcePair();
    expect(pkce.codeVerifier.length).toBeGreaterThan(32);
    expect(pkce.codeChallenge.length).toBeGreaterThan(32);
    expect(pkce.state.length).toBeGreaterThan(16);

    const url = buildGoogleAuthUrl({
      clientId: 'abc.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:43210/callback',
      state: pkce.state,
      codeChallenge: pkce.codeChallenge,
    });
    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('access_type=offline');

    const fakeJwtPayload = Buffer.from(
      JSON.stringify({ email: 'oidc@antigravity.dev', sub: '123' }),
    ).toString('base64url');
    const fakeIdToken = `eyJhbGciOiJSUzI1NiJ9.${fakeJwtPayload}.sig`;
    expect(decodeJwtPayload(fakeIdToken)?.email).toBe('oidc@antigravity.dev');

    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const target = typeof input === 'string' ? input : input.toString();
        if (target.startsWith('https://oauth2.googleapis.com/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'ya29.oidc_callback_token',
              refresh_token: '1//oidc_refresh',
              id_token: fakeIdToken,
              expires_in: 3600,
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return realFetch(input, init);
      });

    try {
      let capturedAuthUrl = '';
      const session = startGoogleOidcLogin({
        clientId: 'abc.apps.googleusercontent.com',
        openBrowser: false,
        timeoutMs: 10_000,
        onAuthUrl: (authUrl) => {
          capturedAuthUrl = authUrl;
          const parsed = new URL(authUrl);
          const redirectUri = parsed.searchParams.get('redirect_uri')!;
          const state = parsed.searchParams.get('state')!;
          void realFetch(
            `${redirectUri}?code=test_auth_code&state=${encodeURIComponent(state)}`,
          );
        },
      });

      const tokens = await session.promise;
      expect(capturedAuthUrl).toContain('accounts.google.com');
      expect(tokens.accessToken).toBe('ya29.oidc_callback_token');
      expect(tokens.refreshToken).toBe('1//oidc_refresh');
      expect(tokens.email).toBe('oidc@antigravity.dev');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

