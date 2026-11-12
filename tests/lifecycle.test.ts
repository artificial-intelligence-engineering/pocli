import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  compareSemver,
  resolveLifecyclePaths,
  uninstallPocli,
  updatePocli,
} from '../src/core/lifecycle.js';

describe('CLI Lifecycle: uninstall & update (#108)', () => {
  let tmpRoot = '';
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-lifecycle-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...origEnv };
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('compares semver versions accurately', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('v1.0.1', '1.0.0')).toBe(1);
    expect(compareSemver('1.2.0', 'v1.10.0')).toBe(-1);
  });

  it('uninstalls bin, app, and runtime while preserving user data by default', () => {
    const binDir = path.join(tmpRoot, 'bin');
    const dataDir = path.join(tmpRoot, '.pocli');
    const appDir = path.join(dataDir, 'app');
    const runtimeDir = path.join(dataDir, 'runtime');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, 'node'), { recursive: true });
    fs.writeFileSync(path.join(binDir, 'pocli'), '#!/bin/sh\n', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'auth.json'), '{}', 'utf8');

    process.env.POCLI_BIN_DIR = binDir;
    process.env.POCLI_DATA_DIR = dataDir;
    process.env.POCLI_INSTALL_DIR = appDir;
    process.env.POCLI_RUNTIME_DIR = path.join(runtimeDir, 'node');

    const paths = resolveLifecyclePaths();
    const res = uninstallPocli({ paths });

    expect(res.nothingToRemove).toBe(false);
    expect(fs.existsSync(paths.binPath)).toBe(false);
    expect(fs.existsSync(paths.appDir)).toBe(false);
    expect(fs.existsSync(paths.runtimeDir)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'auth.json'))).toBe(true);
    expect(res.preservedDataDir).toBe(dataDir);
  });

  it('uninstalls everything including data directory when purgeData is true', () => {
    const binDir = path.join(tmpRoot, 'bin');
    const dataDir = path.join(tmpRoot, '.pocli');
    const appDir = path.join(dataDir, 'app');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'pocli'), '#!/bin/sh\n', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'auth.json'), '{}', 'utf8');

    const res = uninstallPocli({
      purgeData: true,
      paths: {
        binPath: path.join(binDir, 'pocli'),
        appDir,
        runtimeDir: path.join(dataDir, 'runtime'),
        dataDir,
      },
    });

    expect(res.nothingToRemove).toBe(false);
    expect(res.preservedDataDir).toBeNull();
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('reports up_to_date when latest release is not newer, and invokes installer when newer', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: 'v1.0.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: 'v1.2.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('#!/bin/sh\necho installed\n', { status: 200 }),
      );

    const upToDate = await updatePocli({ currentVersion: '1.0.0' });
    expect(upToDate.status).toBe('up_to_date');
    expect(upToDate.latestVersion).toBe('1.0.0');

    let capturedScript = '';
    let capturedArgs: string[] = [];
    const updated = await updatePocli({
      currentVersion: '1.0.0',
      runInstaller: (script, args) => {
        capturedScript = script;
        capturedArgs = args;
      },
    });
    expect(updated.status).toBe('updated');
    expect(updated.latestVersion).toBe('1.2.0');
    expect(capturedScript).toContain('echo installed');
    expect(capturedArgs).toEqual(['-y', '--version', 'v1.2.0']);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('CLI uninstall removes isolated bin and app directory cleanly', () => {
    const binDir = path.join(tmpRoot, 'bin');
    const dataDir = path.join(tmpRoot, '.pocli');
    const appDir = path.join(dataDir, 'app');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'pocli'), '#!/bin/sh\n', 'utf8');

    const cliPath = path.resolve(process.cwd(), 'dist', 'cli.js');
    const output = execFileSync('node', [cliPath, 'uninstall', '--yes'], {
      env: {
        ...process.env,
        POCLI_BIN_DIR: binDir,
        POCLI_DATA_DIR: dataDir,
        POCLI_INSTALL_DIR: appDir,
      },
      encoding: 'utf8',
    });

    expect(output).toContain('Removed');
    expect(fs.existsSync(path.join(binDir, 'pocli'))).toBe(false);
    expect(fs.existsSync(appDir)).toBe(false);
  });
});
