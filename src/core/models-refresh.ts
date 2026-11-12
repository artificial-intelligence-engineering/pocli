import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDefaultWorkDir } from './i18n.js';
import {
  AVAILABLE_MODELS_CATALOG,
  getActiveModelsCatalogSource,
  getLocalModelsCatalogPath,
  ModelCatalogEntry,
  refreshModelsCatalogInMemory,
} from '../runtime/llm-gateway.js';

export const DEFAULT_MODELS_CATALOG_URL =
  'https://raw.githubusercontent.com/artificial-intelligence-engineering/models/main/models.json';

export interface ModelsCatalogMeta {
  sourceUrl: string;
  etag?: string;
  sha256: string;
  updatedAt: string;
  checkedAt: string;
  count: number;
}

export interface ModelsCatalogDiff {
  added: ModelCatalogEntry[];
  removed: ModelCatalogEntry[];
  updated: ModelCatalogEntry[];
}

export interface ModelsRefreshResult {
  status: 'updated' | 'up_to_date';
  total: number;
  sourceUrl: string;
  localPath: string;
  sha256: string;
  diff: ModelsCatalogDiff;
}

export function getModelsCatalogUrl(): string {
  return process.env.POCLI_MODELS_CATALOG_URL?.trim() || DEFAULT_MODELS_CATALOG_URL;
}

export function getModelsMetaPath(): string {
  return path.join(resolveDefaultWorkDir(), 'models.meta.json');
}

export function readModelsMeta(): ModelsCatalogMeta | undefined {
  const metaPath = getModelsMetaPath();
  if (!fs.existsSync(metaPath)) return undefined;
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ModelsCatalogMeta;
    }
  } catch {
    // Ignore corrupt meta file
  }
  return undefined;
}

function writeModelsMeta(meta: ModelsCatalogMeta): void {
  const metaPath = getModelsMetaPath();
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function validateModelsCatalog(raw: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Models catalog must be a non-empty JSON array.');
  }
  const validated: ModelCatalogEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid model entry at index ${i}: expected object.`);
    }
    const rec = item as Record<string, unknown>;
    const requiredStrings = [
      'provider',
      'vendor',
      'providerLabel',
      'modelId',
      'displayName',
      'contextWindow',
      'recommendedFor',
    ];
    for (const field of requiredStrings) {
      if (typeof rec[field] !== 'string' || !rec[field].toString().trim()) {
        throw new Error(
          `Invalid model entry at index ${i}: missing or empty "${field}".`,
        );
      }
    }
    if (typeof rec.isFree !== 'boolean') {
      throw new Error(
        `Invalid model entry at index ${i}: "isFree" must be a boolean.`,
      );
    }
    if (typeof rec.defaultTemperature !== 'number' || Number.isNaN(rec.defaultTemperature)) {
      throw new Error(
        `Invalid model entry at index ${i}: "defaultTemperature" must be a number.`,
      );
    }
    validated.push({
      provider: rec.provider as ModelCatalogEntry['provider'],
      vendor: rec.vendor as string,
      providerLabel: rec.providerLabel as string,
      modelId: rec.modelId as string,
      displayName: rec.displayName as string,
      isFree: rec.isFree,
      contextWindow: rec.contextWindow as string,
      recommendedFor: rec.recommendedFor as string,
      defaultTemperature: rec.defaultTemperature,
    });
  }
  return validated;
}

function modelKey(m: ModelCatalogEntry): string {
  return `${m.provider}/${m.modelId}`;
}

export function computeCatalogDiff(
  prev: ModelCatalogEntry[],
  next: ModelCatalogEntry[],
): ModelsCatalogDiff {
  const prevMap = new Map<string, ModelCatalogEntry>();
  for (const m of prev) {
    prevMap.set(modelKey(m), m);
  }
  const nextMap = new Map<string, ModelCatalogEntry>();
  for (const m of next) {
    nextMap.set(modelKey(m), m);
  }

  const added: ModelCatalogEntry[] = [];
  const removed: ModelCatalogEntry[] = [];
  const updated: ModelCatalogEntry[] = [];

  for (const [k, m] of nextMap) {
    const old = prevMap.get(k);
    if (!old) {
      added.push(m);
    } else if (
      old.displayName !== m.displayName ||
      old.isFree !== m.isFree ||
      old.contextWindow !== m.contextWindow ||
      old.recommendedFor !== m.recommendedFor ||
      old.defaultTemperature !== m.defaultTemperature ||
      old.providerLabel !== m.providerLabel ||
      old.vendor !== m.vendor
    ) {
      updated.push(m);
    }
  }

  for (const [k, m] of prevMap) {
    if (!nextMap.has(k)) {
      removed.push(m);
    }
  }

  return { added, removed, updated };
}

export function getModelsCatalogStatus(): {
  total: number;
  sourcePath: string;
  localCachePath: string;
  hasLocalCache: boolean;
  meta?: ModelsCatalogMeta;
} {
  const localCachePath = getLocalModelsCatalogPath();
  return {
    total: AVAILABLE_MODELS_CATALOG.length,
    sourcePath: getActiveModelsCatalogSource(),
    localCachePath,
    hasLocalCache: fs.existsSync(localCachePath),
    meta: readModelsMeta(),
  };
}

export async function refreshModelsCatalog(options?: {
  url?: string;
  force?: boolean;
}): Promise<ModelsRefreshResult> {
  const sourceUrl = options?.url?.trim() || getModelsCatalogUrl();
  const localPath = getLocalModelsCatalogPath();
  const meta = readModelsMeta();
  const hasLocalFile = fs.existsSync(localPath);
  const now = new Date().toISOString();

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'pocli-models-refresh',
  };
  if (!options?.force && hasLocalFile && meta?.etag) {
    headers['If-None-Match'] = meta.etag;
  }

  const response = await fetch(sourceUrl, { method: 'GET', headers });

  if (response.status === 304 && hasLocalFile) {
    if (meta) {
      writeModelsMeta({ ...meta, checkedAt: now });
    }
    const current = refreshModelsCatalogInMemory();
    return {
      status: 'up_to_date',
      total: current.length,
      sourceUrl,
      localPath,
      sha256: meta?.sha256 ?? computeSha256(fs.readFileSync(localPath, 'utf8')),
      diff: { added: [], removed: [], updated: [] },
    };
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models catalog (${response.status} ${response.statusText}) from ${sourceUrl}`,
    );
  }

  const rawText = await response.text();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Downloaded models catalog is not valid JSON: ${(err as Error).message}`,
    );
  }

  const nextModels = validateModelsCatalog(parsedJson);
  const normalizedJson = `${JSON.stringify(nextModels, null, 2)}\n`;
  const sha256 = computeSha256(normalizedJson);
  const etag = response.headers.get('etag') ?? undefined;

  const existingSha = hasLocalFile
    ? computeSha256(fs.readFileSync(localPath, 'utf8'))
    : undefined;

  if (!options?.force && hasLocalFile && existingSha === sha256) {
    writeModelsMeta({
      sourceUrl,
      etag: etag ?? meta?.etag,
      sha256,
      updatedAt: meta?.updatedAt ?? now,
      checkedAt: now,
      count: nextModels.length,
    });
    const current = refreshModelsCatalogInMemory();
    return {
      status: 'up_to_date',
      total: current.length,
      sourceUrl,
      localPath,
      sha256,
      diff: { added: [], removed: [], updated: [] },
    };
  }

  const prevModels = [...AVAILABLE_MODELS_CATALOG];
  const diff = computeCatalogDiff(prevModels, nextModels);

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, normalizedJson, 'utf8');
  writeModelsMeta({
    sourceUrl,
    etag,
    sha256,
    updatedAt: now,
    checkedAt: now,
    count: nextModels.length,
  });

  refreshModelsCatalogInMemory();

  return {
    status: 'updated',
    total: nextModels.length,
    sourceUrl,
    localPath,
    sha256,
    diff,
  };
}
