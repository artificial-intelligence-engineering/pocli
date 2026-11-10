import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Linux Installer & Release Distribution Packaging', () => {
  let tmpDir: string;
  const repoRoot = path.resolve(__dirname, '..');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-installer-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('install.sh passes POSIX shell syntax check and renders --help cleanly', () => {
    const installerPath = path.join(repoRoot, 'install.sh');
    expect(fs.existsSync(installerPath)).toBe(true);

    execFileSync('sh', ['-n', installerPath], { encoding: 'utf8' });
    const helpOut = execFileSync('sh', [installerPath, '--help'], { encoding: 'utf8' });
    expect(helpOut).toContain('POCLI Installer');
    expect(helpOut).toContain('--version');
    expect(helpOut).toContain('--uninstall');
  });

  it('dist/cli.js, dist/behavior/, and dist/data/ exist with executable cli.js after build', () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.js');
    if (!fs.existsSync(cliPath)) {
      execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' });
    }

    expect(fs.existsSync(cliPath)).toBe(true);
    const stat = fs.statSync(cliPath);
    expect((stat.mode & 0o111) !== 0).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'dist', 'behavior', 'system', 'architect.md'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'dist', 'data', 'models.json'))).toBe(true);

    const verOut = execFileSync(cliPath, ['--version'], { cwd: tmpDir, encoding: 'utf8' }).trim();
    expect(verOut).toMatch(/^\d+\.\d+\.\d+/);
  }, 20000);

  it('install.sh extracts a release tarball into isolated HOME, runs pocli --version, and uninstalls without wiping pocli.sqlite', () => {
    const installerPath = path.join(repoRoot, 'install.sh');
    const stageDir = path.join(tmpDir, 'stage');
    const tarballPath = path.join(tmpDir, 'pocli-linux.tar.gz');
    const fakeHome = path.join(tmpDir, 'fake-home');
    fs.mkdirSync(stageDir, { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.pocli'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.pocli', 'pocli.sqlite'), 'sentinel-db', 'utf8');

    // Stage minimal self-contained tarball from current dist/
    fs.cpSync(path.join(repoRoot, 'package.json'), path.join(stageDir, 'package.json'));
    fs.cpSync(path.join(repoRoot, 'dist'), path.join(stageDir, 'dist'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'behavior'), path.join(stageDir, 'behavior'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'data'), path.join(stageDir, 'data'), { recursive: true });
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(stageDir, 'node_modules'));

    execFileSync('tar', ['-czf', tarballPath, '-C', stageDir, '.']);

    const installOut = execFileSync('sh', [installerPath, '--yes'], {
      cwd: tmpDir,
      env: {
        ...process.env,
        HOME: fakeHome,
        POCLI_LOCAL_TARBALL: tarballPath,
      },
      encoding: 'utf8',
    });

    expect(installOut).toContain('Installed POCLI');
    const launcher = path.join(fakeHome, '.local', 'bin', 'pocli');
    expect(fs.existsSync(launcher)).toBe(true);

    const versionFromLauncher = execFileSync(launcher, ['--version'], {
      cwd: tmpDir,
      env: { ...process.env, HOME: fakeHome },
      encoding: 'utf8',
    }).trim();
    expect(versionFromLauncher).toBe('1.0.0');

    // Verify uninstall preserves user sqlite data
    execFileSync('sh', [installerPath, '--uninstall'], {
      cwd: tmpDir,
      env: { ...process.env, HOME: fakeHome },
      encoding: 'utf8',
    });
    expect(fs.existsSync(launcher)).toBe(false);
    expect(fs.existsSync(path.join(fakeHome, '.pocli', 'app'))).toBe(false);
    expect(fs.readFileSync(path.join(fakeHome, '.pocli', 'pocli.sqlite'), 'utf8')).toBe('sentinel-db');
  });
});
