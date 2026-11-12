import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDefaultWorkDir } from './i18n.js';

export const DEFAULT_POCLI_REPO = 'artificial-intelligence-engineering/pocli';
export const DEFAULT_INSTALLER_URL =
  'https://artificial-intelligence-engineering.github.io/pocli/install.sh';
export const FALLBACK_INSTALLER_URL =
  'https://raw.githubusercontent.com/artificial-intelligence-engineering/pocli/main/install.sh';

export interface LifecyclePaths {
  binPath: string;
  appDir: string;
  runtimeDir: string;
  dataDir: string;
}

export interface UninstallResult {
  removedPaths: string[];
  preservedDataDir: string | null;
  nothingToRemove: boolean;
}

export interface ReleaseInfo {
  tagName: string;
  version: string;
  htmlUrl?: string;
}

export interface UpdateResult {
  status: 'updated' | 'up_to_date';
  currentVersion: string;
  latestVersion: string;
  tagName: string;
}

export function resolveLifecyclePaths(): LifecyclePaths {
  const dataDir = resolveDefaultWorkDir();
  const binDir = process.env.POCLI_BIN_DIR?.trim()
    ? path.resolve(process.env.POCLI_BIN_DIR.trim())
    : path.join(os.homedir(), '.local', 'bin');
  const appDir = process.env.POCLI_INSTALL_DIR?.trim()
    ? path.resolve(process.env.POCLI_INSTALL_DIR.trim())
    : path.join(dataDir, 'app');
  const runtimeDir = process.env.POCLI_RUNTIME_DIR?.trim()
    ? path.dirname(path.resolve(process.env.POCLI_RUNTIME_DIR.trim()))
    : path.join(dataDir, 'runtime');

  return {
    binPath: path.join(binDir, 'pocli'),
    appDir,
    runtimeDir,
    dataDir,
  };
}

export function uninstallPocli(options?: {
  purgeData?: boolean;
  paths?: LifecyclePaths;
}): UninstallResult {
  const paths = options?.paths ?? resolveLifecyclePaths();
  const removedPaths: string[] = [];

  if (fs.existsSync(paths.binPath)) {
    fs.rmSync(paths.binPath, { force: true });
    removedPaths.push(paths.binPath);
  }

  if (fs.existsSync(paths.appDir)) {
    fs.rmSync(paths.appDir, { recursive: true, force: true });
    removedPaths.push(paths.appDir);
  }

  if (fs.existsSync(paths.runtimeDir)) {
    fs.rmSync(paths.runtimeDir, { recursive: true, force: true });
    removedPaths.push(paths.runtimeDir);
  }

  let preservedDataDir: string | null = null;
  if (options?.purgeData) {
    if (fs.existsSync(paths.dataDir)) {
      fs.rmSync(paths.dataDir, { recursive: true, force: true });
      removedPaths.push(paths.dataDir);
    }
  } else if (fs.existsSync(paths.dataDir)) {
    preservedDataDir = paths.dataDir;
  }

  return {
    removedPaths,
    preservedDataDir,
    nothingToRemove: removedPaths.length === 0,
  };
}

export function normalizeVersionTag(version: string): string {
  return version.trim().replace(/^v/i, '');
}

export function compareSemver(a: string, b: string): number {
  const pa = normalizeVersionTag(a)
    .split('-')[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = normalizeVersionTag(b)
    .split('-')[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export async function fetchLatestReleaseInfo(
  repo = DEFAULT_POCLI_REPO,
): Promise<ReleaseInfo> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pocli-updater',
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to check latest release (${res.status} ${res.statusText})`,
    );
  }
  const data = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
  };
  if (!data.tag_name) {
    throw new Error('GitHub latest release response missing tag_name');
  }
  return {
    tagName: data.tag_name,
    version: normalizeVersionTag(data.tag_name),
    htmlUrl: data.html_url,
  };
}

async function downloadInstallerScript(customUrl?: string): Promise<string> {
  const urls = customUrl
    ? [customUrl]
    : [
        process.env.POCLI_INSTALLER_URL?.trim() || DEFAULT_INSTALLER_URL,
        FALLBACK_INSTALLER_URL,
      ];

  let lastError = 'Unknown error';
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'pocli-updater' },
      });
      if (res.ok) {
        const text = await res.text();
        if (text.trim().length > 0) {
          return text;
        }
      } else {
        lastError = `${res.status} ${res.statusText} (${url})`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`Failed to download installer script: ${lastError}`);
}

export async function updatePocli(options: {
  currentVersion: string;
  force?: boolean;
  targetVersion?: string;
  repo?: string;
  installerUrl?: string;
  runInstaller?: (scriptContent: string, args: string[]) => void;
}): Promise<UpdateResult> {
  const currentVersion = normalizeVersionTag(options.currentVersion);
  let targetTag = options.targetVersion?.trim();
  let latestVersion = targetTag ? normalizeVersionTag(targetTag) : currentVersion;

  if (!targetTag) {
    const release = await fetchLatestReleaseInfo(options.repo);
    targetTag = release.tagName;
    latestVersion = release.version;
    if (!options.force && compareSemver(latestVersion, currentVersion) <= 0) {
      return {
        status: 'up_to_date',
        currentVersion,
        latestVersion,
        tagName: targetTag,
      };
    }
  }

  const scriptContent = await downloadInstallerScript(options.installerUrl);
  const installerArgs = ['-y', '--version', targetTag];

  if (options.runInstaller) {
    options.runInstaller(scriptContent, installerArgs);
  } else {
    const tmpScript = path.join(
      os.tmpdir(),
      `pocli-update-${Date.now()}.sh`,
    );
    fs.writeFileSync(tmpScript, scriptContent, { mode: 0o700 });
    try {
      const result = spawnSync('sh', [tmpScript, ...installerArgs], {
        stdio: 'inherit',
        env: process.env,
      });
      if (result.error) {
        throw result.error;
      }
      if (typeof result.status === 'number' && result.status !== 0) {
        throw new Error(`Installer exited with status ${result.status}`);
      }
    } finally {
      try {
        fs.unlinkSync(tmpScript);
      } catch {
        // Ignore cleanup error
      }
    }
  }

  return {
    status: 'updated',
    currentVersion,
    latestVersion,
    tagName: targetTag,
  };
}
