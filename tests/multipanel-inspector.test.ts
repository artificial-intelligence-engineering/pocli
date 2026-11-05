import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PoCliDatabase } from '../src/storage/database.js';
import { I18N_DICTIONARY } from '../src/core/i18n.js';

describe('Feature #46 — Multipanel Worker & Context Inspector', () => {
  let tmpDir: string;
  let db: PoCliDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-multipanel-test-'));
    db = new PoCliDatabase(path.join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Provides i18n dictionary translations for all Multipanel Inspector sections', () => {
    // English
    expect(I18N_DICTIONARY.en.multipanelInspectorTitle('architect')).toContain('ARCHITECT');
    expect(I18N_DICTIONARY.en.multipanelWorkerHeader).toBeTruthy();
    expect(I18N_DICTIONARY.en.multipanelContextStatsHeader).toBeTruthy();
    expect(I18N_DICTIONARY.en.multipanelMemoryHeader).toBeTruthy();
    expect(I18N_DICTIONARY.en.multipanelRecentExchangeHeader).toBeTruthy();
    expect(I18N_DICTIONARY.en.multipanelNoCompactionYet).toBeTruthy();

    // Spanish
    expect(I18N_DICTIONARY.es.multipanelInspectorTitle('architect')).toContain('ARCHITECT');
    expect(I18N_DICTIONARY.es.multipanelWorkerHeader).toContain('Worker');
    expect(I18N_DICTIONARY.es.multipanelContextStatsHeader).toContain('Contexto');
    expect(I18N_DICTIONARY.es.multipanelMemoryHeader).toContain('Memoria');
    expect(I18N_DICTIONARY.es.multipanelRecentExchangeHeader).toContain('Intercambio');
    expect(I18N_DICTIONARY.es.multipanelNoCompactionYet).toContain('presupuesto');
  });

  it('2. Tracks context tokens and compaction statistics per agent', () => {
    const proj = db.createProject({
      name: 'Inspector Test',
      description: 'Inspector Test',
      workspaceDir: path.join(tmpDir, 'proj'),
    });

    // Record initial messages with realistic text volume so compaction saves tokens
    for (let i = 1; i <= 4; i++) {
      db.recordMessage({
        projectId: proj.id,
        fromRole: 'product_owner',
        toRole: 'architect',
        content: `Detailed user requirement specification ${i} for telemetry module: ${'telemetry '.repeat(50)}`,
      });
      db.recordMessage({
        projectId: proj.id,
        fromRole: 'architect',
        toRole: 'product_owner',
        content: `Detailed architecture proposal ${i} analyzing options and tradeoffs: ${'architecture '.repeat(50)}`,
      });
    }

    const summary = db.getExpertChatSummary(proj.id, 'architect');
    expect(summary.totalMessages).toBe(8);
    expect(summary.activeContextTokens).toBeGreaterThan(0);
    expect(summary.compactionCount).toBe(0);
    expect(summary.savedTokensByCompaction).toBe(0);

    // Run compaction preserving the 2 most recent messages
    const checkpoint = db.compactAgentContextWindow({
      projectId: proj.id,
      expertRole: 'architect',
      keepRecentCount: 2,
    });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.compactedMessageCount).toBe(6);

    const updatedSummary = db.getExpertChatSummary(proj.id, 'architect');
    expect(updatedSummary.compactionCount).toBe(1);
    expect(updatedSummary.savedTokensByCompaction).toBeGreaterThan(0);

    const latestCheckpoint = db.getLatestCompactionCheckpoint(proj.id, 'architect');
    expect(latestCheckpoint).toBeDefined();
    expect(latestCheckpoint?.compactedMessageCount).toBe(6);
  });

  it('3. Tracks 4-layer persistent memory counts per agent', () => {
    const proj = db.createProject({
      name: 'Memory Test',
      description: 'Memory Test',
      workspaceDir: path.join(tmpDir, 'proj2'),
    });

    db.upsertMemory({
      projectId: proj.id,
      layer: 'CONVERSATIONAL',
      agentRole: 'developer',
      key: 'pref_lang',
      value: 'TypeScript',
    });

    db.upsertMemory({
      projectId: proj.id,
      layer: 'WORKING',
      agentRole: 'developer',
      key: 'active_task',
      value: 'Refactor IPC gateway',
    });

    db.upsertMemory({
      projectId: proj.id,
      layer: 'PROJECT_PERSISTENT',
      agentRole: 'developer',
      key: 'db_engine',
      value: 'SQLite WAL mode',
    });

    db.upsertMemory({
      projectId: proj.id,
      layer: 'AGENT_SPECIFIC',
      agentRole: 'developer',
      key: 'style_rule',
      value: 'Functions under 40 lines',
    });

    const devMems = db.listMemories(proj.id, undefined, 'developer');
    expect(devMems.length).toBe(4);
    expect(devMems.filter((m) => m.layer === 'CONVERSATIONAL').length).toBe(1);
    expect(devMems.filter((m) => m.layer === 'WORKING').length).toBe(1);
    expect(devMems.filter((m) => m.layer === 'PROJECT_PERSISTENT').length).toBe(1);
    expect(devMems.filter((m) => m.layer === 'AGENT_SPECIFIC').length).toBe(1);
  });
});
