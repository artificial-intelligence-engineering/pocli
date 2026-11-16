import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HfModelFile, HfModelSummary } from './contracts.js';
import { inferQuantizationFromFilename } from './gguf-inspector.js';

const HF_API_BASE = 'https://huggingface.co/api';
const HF_WEB_BASE = 'https://huggingface.co';

function hfHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'pocli-local-llm',
    Accept: 'application/json',
  };
  const token = process.env.HF_TOKEN?.trim() || process.env.HUGGING_FACE_HUB_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function searchHfGgufModels(
  query = '',
  limit = 20,
): Promise<HfModelSummary[]> {
  const trimmed = query.trim();
  const clampedLimit = Math.max(1, Math.min(200, limit));
  const searchParam = trimmed ? `search=${encodeURIComponent(trimmed)}&` : '';
  const url = `${HF_API_BASE}/models?${searchParam}filter=gguf&sort=downloads&direction=-1&limit=${clampedLimit}`;
  const res = await fetch(url, { headers: hfHeaders() });
  if (!res.ok) {
    throw new Error(`Hugging Face search failed (${res.status} ${res.statusText})`);
  }
  const data = (await res.json()) as Array<{
    id?: string;
    modelId?: string;
    downloads?: number;
    likes?: number;
    tags?: string[];
    lastModified?: string;
  }>;

  return data
    .filter((m) => Boolean(m.id || m.modelId))
    .map((m) => ({
      repoId: (m.id ?? m.modelId) as string,
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      tags: Array.isArray(m.tags) ? m.tags : [],
      lastModified: m.lastModified,
    }));
}

export async function getHfModelInfo(repoId: string): Promise<{
  repoId: string;
  downloads: number;
  likes: number;
  tags: string[];
  ggufFiles: HfModelFile[];
}> {
  const url = `${HF_API_BASE}/models/${repoId}?blobs=true`;
  const res = await fetch(url, { headers: hfHeaders() });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Hugging Face model "${repoId}" (${res.status} ${res.statusText})`,
    );
  }
  const data = (await res.json()) as {
    id?: string;
    downloads?: number;
    likes?: number;
    tags?: string[];
    siblings?: Array<{ rfilename?: string; size?: number }>;
  };

  const ggufFiles: HfModelFile[] = (data.siblings ?? [])
    .filter((s) => s.rfilename && s.rfilename.toLowerCase().endsWith('.gguf'))
    .map((s) => ({
      fileName: s.rfilename as string,
      sizeBytes: typeof s.size === 'number' ? s.size : undefined,
      quantization: inferQuantizationFromFilename(s.rfilename as string),
    }));

  return {
    repoId: data.id ?? repoId,
    downloads: data.downloads ?? 0,
    likes: data.likes ?? 0,
    tags: Array.isArray(data.tags) ? data.tags : [],
    ggufFiles,
  };
}

export function pickGgufFile(
  files: HfModelFile[],
  options?: { file?: string; quant?: string },
): HfModelFile {
  if (files.length === 0) {
    throw new Error('No .gguf files found in this Hugging Face repository.');
  }

  if (options?.file) {
    const exact = files.find(
      (f) => f.fileName === options.file || path.basename(f.fileName) === options.file,
    );
    if (!exact) {
      throw new Error(
        `File "${options.file}" not found. Available: ${files.map((f) => f.fileName).join(', ')}`,
      );
    }
    return exact;
  }

  if (options?.quant) {
    const q = options.quant.toUpperCase();
    const byQuant = files.find(
      (f) =>
        f.quantization?.toUpperCase() === q ||
        f.fileName.toUpperCase().includes(q),
    );
    if (!byQuant) {
      throw new Error(
        `Quantization "${options.quant}" not found. Available: ${files.map((f) => f.quantization ?? f.fileName).join(', ')}`,
      );
    }
    return byQuant;
  }

  // Prefer Q4_K_M -> Q4_K_S -> Q5_K_M -> Q8_0 -> first file
  for (const preferred of ['Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q8_0']) {
    const match = files.find((f) => f.quantization === preferred);
    if (match) return match;
  }
  return files[0];
}

export async function downloadHfFile(params: {
  repoId: string;
  fileName: string;
  destPath: string;
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
}): Promise<{ destPath: string; sizeBytes: number; sha256: string }> {
  const { repoId, fileName, destPath, onProgress } = params;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const partPath = `${destPath}.part`;
  let existingBytes = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;

  const url = `${HF_WEB_BASE}/${repoId}/resolve/main/${fileName.split('/').map(encodeURIComponent).join('/')}`;
  const headers = hfHeaders();
  delete headers.Accept;
  if (existingBytes > 0) {
    headers.Range = `bytes=${existingBytes}-`;
  }

  let res = await fetch(url, { headers, redirect: 'follow' });
  if (res.status === 416 && existingBytes > 0) {
    // Range not satisfiable (stale .part) -> restart clean
    fs.rmSync(partPath, { force: true });
    existingBytes = 0;
    delete headers.Range;
    res = await fetch(url, { headers, redirect: 'follow' });
  }

  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status} ${res.statusText}) from ${url}`);
  }

  const isPartial = res.status === 206;
  const contentLength = Number(res.headers.get('content-length') ?? 0) || undefined;
  const totalBytes = contentLength
    ? isPartial
      ? existingBytes + contentLength
      : contentLength
    : undefined;

  if (!isPartial && existingBytes > 0) {
    existingBytes = 0;
  }

  const writeStream = fs.createWriteStream(partPath, {
    flags: isPartial ? 'a' : 'w',
  });

  let downloaded = existingBytes;
  const reader = res.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await new Promise<void>((resolve, reject) => {
          writeStream.write(value, (err) => (err ? reject(err) : resolve()));
        });
        downloaded += value.byteLength;
        onProgress?.(downloaded, totalBytes);
      }
    }
  } finally {
    await new Promise<void>((resolve) => writeStream.end(() => resolve()));
  }

  fs.renameSync(partPath, destPath);
  const finalSize = fs.statSync(destPath).size;

  // Compute SHA-256 via streaming so multi-GB models don't blow memory
  const sha256 = await new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(destPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });

  return { destPath, sizeBytes: finalSize, sha256 };
}
