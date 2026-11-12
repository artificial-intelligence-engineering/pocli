import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Logger } from './logger.js';

export const GOOGLE_OIDC_AUTH_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OIDC_TOKEN_ENDPOINT =
  'https://oauth2.googleapis.com/token';

export const DEFAULT_GOOGLE_ANTIGRAVITY_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/generative-language.retriever',
  'https://www.googleapis.com/auth/cloud-platform',
];

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret?: string;
}

export interface OidcTokenResult {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
  expiresAt: number;
  tokenType: string;
  scope?: string;
  email?: string;
}

export interface OidcLoginSession {
  promise: Promise<OidcTokenResult>;
  cancel: () => void;
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = toBase64Url(crypto.randomBytes(48));
  const codeChallenge = toBase64Url(
    crypto.createHash('sha256').update(codeVerifier).digest(),
  );
  const state = toBase64Url(crypto.randomBytes(24));
  return { codeVerifier, codeChallenge, state };
}

export function decodeJwtPayload(
  jwtToken?: string,
): Record<string, unknown> | undefined {
  if (!jwtToken || typeof jwtToken !== 'string') return undefined;
  const parts = jwtToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed JWT
  }
  return undefined;
}

export function buildGoogleAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
}): string {
  const url = new URL(GOOGLE_OIDC_AUTH_ENDPOINT);
  url.searchParams.set('client_id', params.clientId.trim());
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set(
    'scope',
    (params.scopes ?? DEFAULT_GOOGLE_ANTIGRAVITY_SCOPES).join(' '),
  );
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

function spawnDetached(
  cmd: string,
  args: string[],
  captureStderr: boolean,
  onFail?: () => void,
): boolean {
  try {
    Logger.info('OIDC', `Attempting to launch system browser with '${cmd}'`, {
      cmd,
      platform: process.platform,
      display: process.env.DISPLAY ?? null,
      waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
      desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
    });
    const child = spawn(cmd, args, {
      detached: true,
      stdio: captureStderr ? ['ignore', 'ignore', 'pipe'] : 'ignore',
      env: process.env,
      windowsVerbatimArguments: process.platform === 'win32',
    });
    let stderrBuf = '';
    if (captureStderr && child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
      });
    }
    Logger.info('OIDC', `Spawned browser launcher '${cmd}'`, {
      cmd,
      pid: child.pid ?? null,
    });
    child.on('error', (err) => {
      Logger.error('OIDC', `Browser launcher '${cmd}' spawn error`, {
        cmd,
        error: err.message,
      });
      onFail?.();
    });
    child.on('exit', (code, signal) => {
      if (typeof code === 'number' && code === 0) {
        Logger.info('OIDC', `Browser launcher '${cmd}' exited cleanly (code 0)`, {
          cmd,
        });
      } else {
        Logger.warn('OIDC', `Browser launcher '${cmd}' exited abnormally`, {
          cmd,
          code,
          signal,
          stderr: stderrBuf.trim() || undefined,
        });
        onFail?.();
      }
    });
    child.unref();
    return true;
  } catch (err) {
    Logger.error('OIDC', `Exception spawning browser launcher '${cmd}'`, {
      cmd,
      error: err instanceof Error ? err.message : String(err),
    });
    onFail?.();
    return false;
  }
}

export function openSystemBrowser(url: string): boolean {
  if (process.platform === 'darwin') {
    return spawnDetached('open', [url], true);
  }
  if (process.platform === 'win32') {
    return spawnDetached('cmd', ['/c', 'start', '', url], false);
  }

  // Linux / POSIX: try $BROWSER, then xdg-open, then gio open, then common browsers
  const candidates: Array<{ cmd: string; args: string[]; captureStderr: boolean }> = [];
  if (process.env.BROWSER?.trim()) {
    candidates.push({
      cmd: process.env.BROWSER.trim(),
      args: [url],
      captureStderr: false,
    });
  }
  candidates.push({ cmd: 'xdg-open', args: [url], captureStderr: true });
  candidates.push({ cmd: 'gio', args: ['open', url], captureStderr: true });
  candidates.push({ cmd: 'google-chrome', args: [url], captureStderr: false });
  candidates.push({ cmd: 'firefox', args: [url], captureStderr: false });

  const tryNext = (idx: number): boolean => {
    if (idx >= candidates.length) {
      Logger.error('OIDC', 'All system browser launchers failed');
      return false;
    }
    const { cmd, args, captureStderr } = candidates[idx];
    return spawnDetached(cmd, args, captureStderr, () => {
      tryNext(idx + 1);
    });
  };

  return tryNext(0);
}

export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
}): Promise<OidcTokenResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
    client_id: params.clientId.trim(),
  });
  if (params.clientSecret?.trim()) {
    body.set('client_secret', params.clientSecret.trim());
  }

  const res = await fetch(GOOGLE_OIDC_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google OIDC token exchange failed (${res.status}): ${errText}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  if (!json.access_token) {
    throw new Error('Google OIDC response missing access_token');
  }

  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  const payload = decodeJwtPayload(json.id_token);
  const email =
    typeof payload?.email === 'string' ? payload.email : undefined;

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    expiresIn,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: json.token_type ?? 'Bearer',
    scope: json.scope,
    email,
  };
}

export async function refreshGoogleToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
}): Promise<OidcTokenResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId.trim(),
  });
  if (params.clientSecret?.trim()) {
    body.set('client_secret', params.clientSecret.trim());
  }

  const res = await fetch(GOOGLE_OIDC_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google OIDC token refresh failed (${res.status}): ${errText}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  if (!json.access_token) {
    throw new Error('Google OIDC refresh response missing access_token');
  }

  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  const payload = decodeJwtPayload(json.id_token);
  const email =
    typeof payload?.email === 'string' ? payload.email : undefined;

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? params.refreshToken,
    idToken: json.id_token,
    expiresIn,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: json.token_type ?? 'Bearer',
    scope: json.scope,
    email,
  };
}

function renderCallbackHtml(ok: boolean, message: string): string {
  const title = ok
    ? 'Google Antigravity SSO — Authenticated'
    : 'Google Antigravity SSO — Error';
  const color = ok ? '#10b981' : '#ef4444';
  const icon = ok ? '✔' : '✖';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px 40px; max-width: 480px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    .icon { font-size: 42px; color: ${color}; margin-bottom: 12px; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

export function startGoogleOidcLogin(options: {
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  timeoutMs?: number;
  openBrowser?: boolean;
  onAuthUrl?: (url: string) => void;
}): OidcLoginSession {
  const clientId = options.clientId.trim();
  if (!clientId) {
    return {
      promise: Promise.reject(new Error('Google OAuth Client ID is required')),
      cancel: () => {},
    };
  }

  let server: http.Server | null = null;
  let timer: NodeJS.Timeout | null = null;
  let settled = false;
  let rejectFn: ((err: Error) => void) | null = null;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (server) {
      try {
        server.close();
      } catch {
        // Ignore close error
      }
      server = null;
    }
  };

  const promise = new Promise<OidcTokenResult>((resolve, reject) => {
    rejectFn = reject;
    const { codeVerifier, codeChallenge, state } = generatePkcePair();

    server = http.createServer(async (req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const errorParam = reqUrl.searchParams.get('error');
      if (errorParam) {
        const desc = reqUrl.searchParams.get('error_description') || errorParam;
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCallbackHtml(false, `Authorization denied: ${desc}`));
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`Google OIDC authorization error: ${desc}`));
        }
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');
      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderCallbackHtml(
            false,
            'Invalid OIDC state or missing authorization code.',
          ),
        );
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('Google OIDC callback validation failed (state/code mismatch)'));
        }
        return;
      }

      const addr = server?.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      try {
        const tokens = await exchangeCodeForTokens({
          code,
          codeVerifier,
          redirectUri,
          clientId,
          clientSecret: options.clientSecret,
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderCallbackHtml(
            true,
            'Authentication succeeded. You can close this browser tab and return to PO CLI.',
          ),
        );
        if (!settled) {
          settled = true;
          cleanup();
          resolve(tokens);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCallbackHtml(false, msg));
        if (!settled) {
          settled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error(msg));
        }
      }
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = buildGoogleAuthUrl({
        clientId,
        redirectUri,
        state,
        codeChallenge,
        scopes: options.scopes,
      });

      Logger.info('OIDC', 'Loopback OIDC server listening', {
        redirectUri,
        openBrowser: options.openBrowser !== false,
      });

      options.onAuthUrl?.(authUrl);
      if (options.openBrowser !== false) {
        openSystemBrowser(authUrl);
      }

      const timeoutMs = options.timeoutMs ?? 180_000;
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('Google OIDC SSO login timed out'));
        }
      }, timeoutMs);
    });
  });

  return {
    promise,
    cancel: () => {
      if (!settled) {
        settled = true;
        cleanup();
        rejectFn?.(new Error('Google OIDC SSO login cancelled'));
      }
    },
  };
}
