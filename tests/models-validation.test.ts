import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PoCliDatabase } from '../src/storage/database.js';
import { resolveModelSpec } from '../src/runtime/llm-gateway.js';

describe('Model & Agent Role Validation (#113)', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-model-val-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects arbitrary substrings and unknown models in strict mode', () => {
    expect(resolveModelSpec('b', { strict: true })).toBeNull();
    expect(resolveModelSpec('nonexistent-model', { strict: true })).toBeNull();
    expect(resolveModelSpec('anthropic/nonexistent', { strict: true })).toBeNull();

    const valid = resolveModelSpec('opencode/gemini-3.8-flash', { strict: true });
    expect(valid?.provider).toBe('opencode');
    expect(valid?.modelId).toBe('gemini-3.8-flash');

    const localOllama = resolveModelSpec('ollama/llama3.2', { strict: true });
    expect(localOllama?.provider).toBe('ollama');
    expect(localOllama?.modelId).toBe('llama3.2');
  });

  it('rejects invalid agent roles in PoCliDatabase.assignModelToRole', () => {
    const dbPath = path.join(tmpDir, 'pocli.sqlite');
    const storage = new PoCliDatabase(dbPath, tmpDir);
    const project = storage.createProject({
      name: 'ValidationProj',
      description: 'Validation test project',
      workspaceDir: tmpDir,
    });

    expect(() =>
      storage.assignModelToRole({
        projectId: project.id,
        role: 'a' as unknown as 'pm',
        provider: 'opencode',
        modelId: 'gemini-3.8-flash',
      }),
    ).toThrow(/Invalid agent role/);

    const configs = storage.listRoleConfigs(project.id);
    expect(configs.map((c) => c.role).sort()).toEqual([
      'architect',
      'developer',
      'pm',
      'qa',
    ]);
    storage.close();
  });

  it('CLI rejects invalid agent "a" and invalid model "b"', () => {
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const storage = new PoCliDatabase(path.join(dataDir, 'pocli.sqlite'), tmpDir);
    storage.createProject({
      name: 'CliTest',
      description: 'CLI validation test',
      workspaceDir: tmpDir,
    });
    storage.close();

    const cliPath = path.resolve(process.cwd(), 'dist', 'cli.js');

    let errInvalidAgent = '';
    try {
      execFileSync('node', [cliPath, 'models', 'a', 'b'], {
        env: { ...process.env, POCLI_DATA_DIR: dataDir },
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { stderr?: string; status?: number };
      expect(e.status).toBe(1);
      errInvalidAgent = e.stderr ?? '';
    }
    expect(errInvalidAgent).toContain('Invalid agent "a"');

    let errInvalidModel = '';
    try {
      execFileSync('node', [cliPath, 'models', 'developer', 'b'], {
        env: { ...process.env, POCLI_DATA_DIR: dataDir },
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { stderr?: string; status?: number };
      expect(e.status).toBe(1);
      errInvalidModel = e.stderr ?? '';
    }
    expect(errInvalidModel).toContain('Model "b" does not exist');
  });
});
