import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  scanWorkspaceTree,
  flattenTree,
  getAllDirectoryPaths,
  getInitialExpandedPaths,
  formatFileSize,
  getFileIconAndColor,
} from '../src/tui/FileTreeExplorer.js';

describe('Feature #84 — Repository Code Tree Explorer Sidebar', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-tree-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('1. scanWorkspaceTree scans nested directory structure and ignores internal noise', () => {
    // Setup directory structure
    // tmpDir/
    //   repos/
    //     my-service.git/
    //       src/
    //         main.py
    //       tests/
    //         test_main.py
    //       .git/
    //         config
    //       .venv/
    //         bin/python
    //       pyproject.toml
    //   contracts/
    //     ARCH-001_v1.md
    //   node_modules/
    //     package.json
    //   .pytest_cache/
    //     v/cache
    const repoDir = path.join(tmpDir, 'repos', 'my-service.git');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, '.venv'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'contracts'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.pytest_cache'), { recursive: true });

    fs.writeFileSync(path.join(repoDir, 'src', 'main.py'), 'print("hello world")');
    fs.writeFileSync(path.join(repoDir, 'tests', 'test_main.py'), 'def test(): pass');
    fs.writeFileSync(path.join(repoDir, '.git', 'config'), '[core]');
    fs.writeFileSync(path.join(repoDir, '.venv', 'pyvenv.cfg'), 'home = /usr/bin');
    fs.writeFileSync(path.join(repoDir, 'pyproject.toml'), '[project]\nname="test"');
    fs.writeFileSync(path.join(tmpDir, 'contracts', 'ARCH-001_v1.md'), '# ARCH-001');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dummy.js'), 'export {}');

    const tree = scanWorkspaceTree(tmpDir);

    // Root should only contain contracts/ and repos/
    const rootNames = tree.map((n) => n.name);
    expect(rootNames).toContain('contracts');
    expect(rootNames).toContain('repos');
    expect(rootNames).not.toContain('node_modules');
    expect(rootNames).not.toContain('.pytest_cache');

    // repos/my-service.git should contain src, tests, pyproject.toml but NOT .git or .venv
    const reposNode = tree.find((n) => n.name === 'repos')!;
    expect(reposNode).toBeDefined();
    const repoNode = reposNode.children!.find((n) => n.name === 'my-service.git')!;
    expect(repoNode).toBeDefined();

    const repoInnerNames = repoNode.children!.map((n) => n.name);
    expect(repoInnerNames).toContain('src');
    expect(repoInnerNames).toContain('tests');
    expect(repoInnerNames).toContain('pyproject.toml');
    expect(repoInnerNames).not.toContain('.git');
    expect(repoInnerNames).not.toContain('.venv');

    // Check file sizes
    const mainPy = repoNode.children!
      .find((n) => n.name === 'src')!
      .children!.find((n) => n.name === 'main.py')!;
    expect(mainPy.size).toBe(20);
    expect(mainPy.isDirectory).toBe(false);
  });

  it('2. flattenTree and expand/collapse behavior', () => {
    const repoDir = path.join(tmpDir, 'repos', 'app.git', 'src');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'app.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(tmpDir, 'repos', 'app.git', 'package.json'), '{}');

    const tree = scanWorkspaceTree(tmpDir);

    // Initial state: nothing expanded
    const emptyExpanded = new Set<string>();
    const flatEmpty = flattenTree(tree, emptyExpanded);
    expect(flatEmpty).toHaveLength(1); // Only 'repos/'
    expect(flatEmpty[0].name).toBe('repos');
    expect(flatEmpty[0].isDirectory).toBe(true);
    expect(flatEmpty[0].isExpanded).toBe(false);

    // Expand 'repos'
    const expandedRepos = new Set(['repos']);
    const flatRepos = flattenTree(tree, expandedRepos);
    expect(flatRepos.map((i) => i.name)).toEqual(['repos', 'app.git']);

    // Expand 'repos' and 'repos/app.git'
    const expandedAll = new Set(['repos', 'repos/app.git', 'repos/app.git/src']);
    const flatAll = flattenTree(tree, expandedAll);
    const allNames = flatAll.map((i) => i.name);
    expect(allNames).toContain('repos');
    expect(allNames).toContain('app.git');
    expect(allNames).toContain('src');
    expect(allNames).toContain('app.ts');
    expect(allNames).toContain('package.json');
  });

  it('3. getAllDirectoryPaths collects all directory relative paths for Expand All', () => {
    fs.mkdirSync(path.join(tmpDir, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'a', 'file.txt'), 'hi');

    const tree = scanWorkspaceTree(tmpDir);
    const allDirs = getAllDirectoryPaths(tree);

    expect(allDirs).toContain('a');
    expect(allDirs).toContain('a/b');
    expect(allDirs).toContain('a/b/c');
    expect(allDirs).toHaveLength(3);
  });

  it('4. getInitialExpandedPaths automatically expands repos and repo children', () => {
    fs.mkdirSync(path.join(tmpDir, 'repos', 'service.git', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'contracts'), { recursive: true });

    const tree = scanWorkspaceTree(tmpDir);
    const initial = getInitialExpandedPaths(tree);

    expect(initial.has('repos')).toBe(true);
    expect(initial.has('repos/service.git')).toBe(true);
    expect(initial.has('contracts')).toBe(true);
  });

  it('5. formatFileSize formats byte values cleanly', () => {
    expect(formatFileSize(undefined)).toBe('');
    expect(formatFileSize(0)).toBe('0B');
    expect(formatFileSize(855)).toBe('855B');
    expect(formatFileSize(2048)).toBe('2.0K');
    expect(formatFileSize(1048576 * 2.5)).toBe('2.5M');
  });

  it('6. getFileIconAndColor maps file extensions correctly', () => {
    expect(getFileIconAndColor('dir', true)).toEqual({ icon: '📁', color: 'yellow' });
    expect(getFileIconAndColor('main.py', false)).toEqual({ icon: '', color: 'green' });
    expect(getFileIconAndColor('app.ts', false)).toEqual({ icon: '', color: 'cyan' });
    expect(getFileIconAndColor('ARCH-001.md', false)).toEqual({ icon: '', color: 'blue' });
    expect(getFileIconAndColor('pyproject.toml', false)).toEqual({ icon: '', color: 'magenta' });
    expect(getFileIconAndColor('run.sh', false)).toEqual({ icon: '', color: 'green' });
    expect(getFileIconAndColor('database.sqlite', false)).toEqual({ icon: '', color: 'red' });
  });
});

