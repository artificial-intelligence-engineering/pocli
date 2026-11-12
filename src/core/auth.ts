import fs from 'node:fs';
import path from 'node:path';
import { resolveDefaultWorkDir } from './i18n.js';
import {
  refreshGoogleToken,
  type GoogleOAuthClientConfig,
} from './oidc.js';

export interface ProviderAuthInfo {
  id: string;
  name: string;
  envVar: string;
  keyPrefix?: string;
  helpUrl?: string;
  supportsSso?: boolean;
}

export interface StoredOAuthCredentials {
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  email?: string;
  scope?: string;
}

export interface ProviderAuthStatus {
  id: string;
  name: string;
  envVar: string;
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
  source: 'env' | 'file' | 'sso' | 'none';
  maskedKey?: string;
  supportsSso?: boolean;
  authMode?: 'api_key' | 'sso';
  ssoEmail?: string;
}

export interface ResolvedProviderCredential {
  mode: 'api_key' | 'sso';
  token: string;
}

export const SUPPORTED_AUTH_PROVIDERS: ProviderAuthInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    envVar: 'ANTHROPIC_API_KEY',
    keyPrefix: 'sk-ant-',
    helpUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT-4o, o1, o3)',
    envVar: 'OPENAI_API_KEY',
    keyPrefix: 'sk-',
    helpUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'gemini',
    name: 'Google Antigravity',
    envVar: 'GEMINI_API_KEY',
    keyPrefix: 'AIzaSy',
    helpUrl: 'https://aistudio.google.com/app/apikey',
    supportsSso: true,
  },
  {
    id: 'groq',
    name: 'Groq (Llama, Gemma)',
    envVar: 'GROQ_API_KEY',
    keyPrefix: 'gsk_',
    helpUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (Multi-model)',
    envVar: 'OPENROUTER_API_KEY',
    keyPrefix: 'sk-or-',
    helpUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'cerebras',
    name: 'Cerebras (Ultra-fast inference)',
    envVar: 'CEREBRAS_API_KEY',
    keyPrefix: 'csk-',
    helpUrl: 'https://cloud.cerebras.ai',
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen (Pay-per-use)',
    envVar: 'OPENCODE_API_KEY',
    keyPrefix: 'zen_',
    helpUrl: 'https://opencode.ai/zen',
  },
];

export class AuthStorage {
  private static customFilePath: string | null = null;

  public static setCustomAuthPath(filePath: string | null): void {
    this.customFilePath = filePath;
  }

  public static getAuthFilePath(): string {
    if (this.customFilePath) {
      return this.customFilePath;
    }
    const baseDir = resolveDefaultWorkDir();
    return path.join(baseDir, 'auth.json');
  }

  public static normalizeProviderId(id: string): string {
    const lower = id.toLowerCase().trim();
    if (lower === 'zen' || lower === 'opencode-zen' || lower === 'opencode_zen') {
      return 'opencode';
    }
    if (
      lower === 'antigravity' ||
      lower === 'google-antigravity' ||
      lower === 'google_antigravity'
    ) {
      return 'gemini';
    }
    return lower;
  }

  /**
   * Resolves the API key for a provider following strict precedence:
   * 1. Shell environment variable (e.g. process.env.ANTHROPIC_API_KEY)
   * 2. Persisted credentials in $HOME/.pocli/auth.json
   */
  public static getApiKey(providerId: string): string | undefined {
    const normalized = this.normalizeProviderId(providerId);
    const prov = SUPPORTED_AUTH_PROVIDERS.find((p) => p.id === normalized);

    // 1. Check environment variable
    if (prov && process.env[prov.envVar]) {
      const envVal = process.env[prov.envVar]?.trim();
      if (envVal) return envVal;
    }

    if (normalized === 'opencode' && process.env.OPENCODE_ZEN_API_KEY?.trim()) {
      return process.env.OPENCODE_ZEN_API_KEY.trim();
    }

    // Also check direct environment variable if named like <PROVIDER>_API_KEY
    const directEnv = process.env[`${normalized.toUpperCase()}_API_KEY`]?.trim();
    if (directEnv) return directEnv;

    // 2. Check auth.json file
    const fileData = this.readFile();
    const rawVal = fileData[normalized];
    const zenVal = normalized === 'opencode' ? fileData['zen'] : undefined;
    const fileVal =
      typeof rawVal === 'string' && rawVal.trim()
        ? rawVal.trim()
        : typeof zenVal === 'string' && zenVal.trim()
          ? zenVal.trim()
          : undefined;
    if (fileVal) return fileVal;

    return undefined;
  }

  public static getApiKeySource(providerId: string): 'env' | 'file' | 'none' {
    const normalized = this.normalizeProviderId(providerId);
    const prov = SUPPORTED_AUTH_PROVIDERS.find((p) => p.id === normalized);

    if (prov && process.env[prov.envVar]?.trim()) {
      return 'env';
    }
    if (normalized === 'opencode' && process.env.OPENCODE_ZEN_API_KEY?.trim()) {
      return 'env';
    }
    if (process.env[`${normalized.toUpperCase()}_API_KEY`]?.trim()) {
      return 'env';
    }

    const fileData = this.readFile();
    const rawVal = fileData[normalized];
    const zenVal = normalized === 'opencode' ? fileData['zen'] : undefined;
    if (
      (typeof rawVal === 'string' && rawVal.trim()) ||
      (typeof zenVal === 'string' && zenVal.trim())
    ) {
      return 'file';
    }

    return 'none';
  }

  public static setApiKey(providerId: string, apiKey: string): void {
    const normalized = this.normalizeProviderId(providerId);
    const trimmed = apiKey.trim();
    if (!trimmed) {
      this.removeApiKey(normalized);
      return;
    }

    const fileData = this.readFile();
    fileData[normalized] = trimmed;
    // Clear active SSO tokens for this provider so API key mode is unambiguous
    const ssoMap = this.getRecordField(fileData, 'sso');
    if (ssoMap && normalized in ssoMap) {
      delete ssoMap[normalized];
      fileData.sso = ssoMap;
    }
    this.writeFile(fileData);
  }

  public static removeApiKey(providerId: string): boolean {
    const normalized = this.normalizeProviderId(providerId);
    const fileData = this.readFile();
    let removed = false;
    if (normalized in fileData) {
      delete fileData[normalized];
      removed = true;
    }
    if (normalized === 'opencode' && 'zen' in fileData) {
      delete fileData['zen'];
      removed = true;
    }
    const ssoMap = this.getRecordField(fileData, 'sso');
    if (ssoMap && normalized in ssoMap) {
      delete ssoMap[normalized];
      fileData.sso = ssoMap;
      removed = true;
    }
    if (removed) {
      this.writeFile(fileData);
      return true;
    }
    return false;
  }

  public static getOAuthClientConfig(
    providerId: string,
  ): GoogleOAuthClientConfig | undefined {
    const normalized = this.normalizeProviderId(providerId);
    const fileData = this.readFile();
    const clients = this.getRecordField(fileData, 'oauthClients');
    const entry = clients?.[normalized];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (typeof rec.clientId === 'string' && rec.clientId.trim()) {
        return {
          clientId: rec.clientId.trim(),
          clientSecret:
            typeof rec.clientSecret === 'string' && rec.clientSecret.trim()
              ? rec.clientSecret.trim()
              : undefined,
        };
      }
    }
    return undefined;
  }

  public static setOAuthClientConfig(
    providerId: string,
    config: GoogleOAuthClientConfig,
  ): void {
    const normalized = this.normalizeProviderId(providerId);
    const fileData = this.readFile();
    const clients = this.getRecordField(fileData, 'oauthClients') ?? {};
    clients[normalized] = {
      clientId: config.clientId.trim(),
      ...(config.clientSecret?.trim()
        ? { clientSecret: config.clientSecret.trim() }
        : {}),
    };
    fileData.oauthClients = clients;
    this.writeFile(fileData);
  }

  public static getOAuthCredentials(
    providerId: string,
  ): StoredOAuthCredentials | undefined {
    const normalized = this.normalizeProviderId(providerId);
    const fileData = this.readFile();
    const ssoMap = this.getRecordField(fileData, 'sso');
    const entry = ssoMap?.[normalized];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (typeof rec.accessToken === 'string' && rec.accessToken.trim()) {
        return {
          clientId: typeof rec.clientId === 'string' ? rec.clientId : '',
          clientSecret:
            typeof rec.clientSecret === 'string' ? rec.clientSecret : undefined,
          accessToken: rec.accessToken,
          refreshToken:
            typeof rec.refreshToken === 'string' ? rec.refreshToken : undefined,
          idToken: typeof rec.idToken === 'string' ? rec.idToken : undefined,
          expiresAt: typeof rec.expiresAt === 'number' ? rec.expiresAt : 0,
          email: typeof rec.email === 'string' ? rec.email : undefined,
          scope: typeof rec.scope === 'string' ? rec.scope : undefined,
        };
      }
    }
    return undefined;
  }

  public static setOAuthCredentials(
    providerId: string,
    creds: StoredOAuthCredentials,
  ): void {
    const normalized = this.normalizeProviderId(providerId);
    const fileData = this.readFile();
    const ssoMap = this.getRecordField(fileData, 'sso') ?? {};
    ssoMap[normalized] = creds;
    fileData.sso = ssoMap;
    // Keep client config saved for future re-logins
    if (creds.clientId.trim()) {
      const clients = this.getRecordField(fileData, 'oauthClients') ?? {};
      clients[normalized] = {
        clientId: creds.clientId.trim(),
        ...(creds.clientSecret?.trim()
          ? { clientSecret: creds.clientSecret.trim() }
          : {}),
      };
      fileData.oauthClients = clients;
    }
    // Clear persisted file API key for this provider so SSO mode is active
    if (normalized in fileData && typeof fileData[normalized] === 'string') {
      delete fileData[normalized];
    }
    this.writeFile(fileData);
  }

  public static isConfigured(providerId: string): boolean {
    if (this.getApiKey(providerId)) return true;
    const sso = this.getOAuthCredentials(providerId);
    return Boolean(sso?.accessToken || sso?.refreshToken);
  }

  public static async resolveProviderCredential(
    providerId: string,
  ): Promise<ResolvedProviderCredential | undefined> {
    const apiKey = this.getApiKey(providerId);
    if (apiKey) {
      return { mode: 'api_key', token: apiKey };
    }

    const sso = this.getOAuthCredentials(providerId);
    if (!sso) return undefined;

    // Refresh if expired or expiring within 60 seconds
    if (sso.expiresAt > 0 && Date.now() >= sso.expiresAt - 60_000) {
      if (sso.refreshToken && sso.clientId) {
        const refreshed = await refreshGoogleToken({
          refreshToken: sso.refreshToken,
          clientId: sso.clientId,
          clientSecret: sso.clientSecret,
        });
        this.setOAuthCredentials(providerId, {
          ...sso,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? sso.refreshToken,
          idToken: refreshed.idToken ?? sso.idToken,
          expiresAt: refreshed.expiresAt,
          email: refreshed.email ?? sso.email,
          scope: refreshed.scope ?? sso.scope,
        });
        return { mode: 'sso', token: refreshed.accessToken };
      }
      return undefined;
    }

    return { mode: 'sso', token: sso.accessToken };
  }

  public static maskApiKey(key: string): string {
    if (!key || key.length < 8) return '********';
    const prefixLen = key.startsWith('sk-ant-')
      ? 7
      : key.startsWith('sk-or-')
        ? 6
        : key.startsWith('AIzaSy')
          ? 6
          : key.startsWith('zen_')
            ? 4
            : Math.min(8, Math.floor(key.length / 3));
    const suffixLen = Math.min(4, Math.floor(key.length / 4));
    const prefix = key.slice(0, prefixLen);
    const suffix = key.slice(-suffixLen);
    return `${prefix}***${suffix}`;
  }

  public static listProviders(): ProviderAuthStatus[] {
    return SUPPORTED_AUTH_PROVIDERS.map((prov) => {
      const key = this.getApiKey(prov.id);
      if (key) {
        return {
          id: prov.id,
          name: prov.name,
          envVar: prov.envVar,
          status: 'CONFIGURED',
          source: this.getApiKeySource(prov.id),
          maskedKey: this.maskApiKey(key),
          supportsSso: prov.supportsSso,
          authMode: 'api_key',
        };
      }
      const sso = this.getOAuthCredentials(prov.id);
      if (sso?.accessToken) {
        return {
          id: prov.id,
          name: prov.name,
          envVar: prov.envVar,
          status: 'CONFIGURED',
          source: 'sso',
          maskedKey: this.maskApiKey(sso.accessToken),
          supportsSso: prov.supportsSso,
          authMode: 'sso',
          ssoEmail: sso.email,
        };
      }
      return {
        id: prov.id,
        name: prov.name,
        envVar: prov.envVar,
        status: 'NOT_CONFIGURED',
        source: 'none',
        supportsSso: prov.supportsSso,
      };
    });
  }

  public static getAllEffectiveKeys(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const prov of SUPPORTED_AUTH_PROVIDERS) {
      const key = this.getApiKey(prov.id);
      if (key) {
        result[prov.id] = key;
      }
    }
    return result;
  }

  public static clear(): void {
    try {
      const filePath = this.getAuthFilePath();
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore
    }
  }

  private static getRecordField(
    data: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> | undefined {
    const val = data[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return val as Record<string, unknown>;
    }
    return undefined;
  }

  private static readFile(): Record<string, unknown> {
    const filePath = this.getAuthFilePath();
    if (!fs.existsSync(filePath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt or empty file
    }
    return {};
  }

  private static writeFile(data: Record<string, unknown>): void {
    const filePath = this.getAuthFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Strict POSIX permissions (0o600: read/write owner only)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Ignore chmod error on platforms that don't support it
    }
  }
}
