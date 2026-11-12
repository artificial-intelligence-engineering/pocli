import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeCatalogDiff,
  getModelsCatalogStatus,
  refreshModelsCatalog,
  validateModelsCatalog,
} from '../src/core/models-refresh.js';
import {
  AVAILABLE_MODELS_CATALOG,
  ModelCatalogEntry,
  refreshModelsCatalogInMemory,
} from '../src/runtime/llm-gateway.js';

const SAMPLE_ENTRY: ModelCatalogEntry = {
  provider: 'opencode',
  vendor: 'OPENCODE',
  providerLabel: 'OpenCode Zen',
  modelId: 'glm-5-free',
  displayName: 'GLM-5 Free',
  isFree: true,
  contextWindow: '200K',
  recommendedFor: 'Fast Free Tasks',
  defaultTemperature: 0.2,
};

const NEW_ENTRY: ModelCatalogEntry = {
  provider: 'gemini',
  vendor: 'GEMINI',
  providerLabel: 'Google Antigravity',
  modelId: 'gemini-3.0-pro',
  displayName: 'Gemini 3.0 Pro',
  isFree: false,
  contextWindow: '2M',
  recommendedFor: 'Deep Reasoning',
  defaultTemperature: 0.1,
};

describe('Models Catalog Refresh (#107)', () => {
  let tmpHome = '';
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-models-test-'));
    process.env.POCLI_DATA_DIR = tmpHome;
    refreshModelsCatalogInMemory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...origEnv };
    refreshModelsCatalogInMemory();
    if (tmpHome && fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('validates catalog schema and rejects malformed payloads', () => {
    expect(validateModelsCatalog([SAMPLE_ENTRY])).toHaveLength(1);
    expect(() => validateModelsCatalog([])).toThrow(/non-empty/);
    expect(() =>
      validateModelsCatalog([{ ...SAMPLE_ENTRY, isFree: 'yes' }]),
    ).toThrow(/isFree/);
    expect(() =>
      validateModelsCatalog([{ ...SAMPLE_ENTRY, modelId: '' }]),
    ).toThrow(/modelId/);
  });

  it('computes added, updated, and removed models accurately', () => {
    const updatedSample: ModelCatalogEntry = {
      ...SAMPLE_ENTRY,
      displayName: 'GLM-5 Free v2',
    };
    const diff = computeCatalogDiff(
      [SAMPLE_ENTRY, NEW_ENTRY],
      [updatedSample],
    );
    expect(diff.added).toHaveLength(0);
    expect(diff.updated).toHaveLength(1);
    expect(diff.updated[0].displayName).toBe('GLM-5 Free v2');
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].modelId).toBe('gemini-3.0-pro');
  });

  it('fetches, persists, detects 304 up-to-date, and updates in-memory catalog', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify([SAMPLE_ENTRY]), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ETag: '"v1-etag"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([SAMPLE_ENTRY, NEW_ENTRY]), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ETag: '"v2-etag"',
          },
        }),
      );

    // 1. Initial download
    const first = await refreshModelsCatalog();
    expect(first.status).toBe('updated');
    expect(first.total).toBe(1);
    expect(AVAILABLE_MODELS_CATALOG).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpHome, 'models.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, 'models.meta.json'))).toBe(true);

    // 2. Second check with ETag -> 304 Not Modified
    const second = await refreshModelsCatalog();
    expect(second.status).toBe('up_to_date');
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'If-None-Match': '"v1-etag"' }),
      }),
    );

    // 3. Third check with new model added
    const third = await refreshModelsCatalog();
    expect(third.status).toBe('updated');
    expect(third.total).toBe(2);
    expect(third.diff.added).toHaveLength(1);
    expect(third.diff.added[0].modelId).toBe('gemini-3.0-pro');
    expect(AVAILABLE_MODELS_CATALOG).toHaveLength(2);

    const status = getModelsCatalogStatus();
    expect(status.hasLocalCache).toBe(true);
    expect(status.total).toBe(2);
    expect(status.meta?.etag).toBe('"v2-etag"');
  });

  it('preserves existing local cache if remote fetch fails or returns invalid JSON', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify([SAMPLE_ENTRY]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
      );

    await refreshModelsCatalog();
    await expect(refreshModelsCatalog()).rejects.toThrow(/500/);
    expect(AVAILABLE_MODELS_CATALOG).toHaveLength(1);
  });
});
