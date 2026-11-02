import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Logger } from '../src/core/logger.js';

describe('Logger subsystem', () => {
  const tmpLogDir = path.join(os.tmpdir(), `pocli-test-logs-${Date.now()}`);

  beforeEach(() => {
    Logger.setLogDir(tmpLogDir);
    Logger.clear();
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpLogDir)) {
        fs.rmSync(tmpLogDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
    Logger.setLogDir(null);
  });

  it('writes structured log entries to file with categories and levels', () => {
    Logger.info('ORCHESTRATOR', 'Project initialized', { projectId: 'p123' });
    Logger.warn('LLM-ROUTER', 'Approaching token limit', { tokens: 180000 });
    Logger.error('WORKER', 'Subprocess crashed', new Error('Out of memory'));
    Logger.debug('SQLITE', 'Indexed artifacts');

    const logPath = Logger.getLogFilePath();
    expect(fs.existsSync(logPath)).toBe(true);

    const lines = Logger.getRecentLines(10);
    expect(lines.length).toBe(4);

    expect(lines[0]).toContain('[INFO ] [ORCHESTRATOR] Project initialized {"projectId":"p123"}');
    expect(lines[1]).toContain('[WARN ] [LLM-ROUTER] Approaching token limit {"tokens":180000}');
    expect(lines[2]).toContain('[ERROR] [WORKER] Subprocess crashed');
    expect(lines[2]).toContain('"error":"Out of memory"');
    expect(lines[3]).toContain('[DEBUG] [SQLITE] Indexed artifacts');
  });

  it('provides recent lines limit', () => {
    for (let i = 0; i < 20; i++) {
      Logger.info('TEST', `Message ${i}`);
    }

    const lines = Logger.getRecentLines(5);
    expect(lines.length).toBe(5);
    expect(lines[4]).toContain('Message 19');
  });

  it('clears log file and in-memory buffer', () => {
    Logger.info('TEST', 'A message before clear');
    expect(Logger.getRecentLines().length).toBe(1);

    Logger.clear();
    expect(Logger.getRecentLines().length).toBe(0);
  });
});

