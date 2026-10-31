import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ActorRole, Notebook, RagCitation } from '../core/contracts.js';
import { PoCliDatabase } from '../storage/database.js';

export interface IndexResult {
  notebookId: string;
  notebookName: string;
  scannedFiles: number;
  indexedFiles: number;
  unchangedFiles: number;
  removedFiles: number;
  totalChunks: number;
}

const SUPPORTED_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.ts',
  '.js',
  '.sql',
  '.html',
]);

/**
 * Notebook Knowledge Base Manager & Hybrid RAG Engine (AGENTS.md Section 8).
 * Decouples the user-facing Notebook entity (directory on Linux filesystem)
 * from the underlying incremental indexing, FTS5 lexical search, and vector similarity retrieval.
 */
export class NotebookRagEngine {
  private watchers = new Map<string, fs.FSWatcher>();

  constructor(private readonly storage: PoCliDatabase) {}

  /**
   * Incrementally indexes a Notebook directory by checking SHA-256 hashes of files.
   * Only new or modified files are re-chunked and re-embedded.
   */
  indexNotebook(notebookId: string): IndexResult {
    const notebook = this.storage.getNotebook(notebookId);
    if (!notebook) {
      throw new Error(`Notebook ${notebookId} not found.`);
    }

    const absFiles = this.walkDirectory(notebook.dirPath);
    const existingRows = this.storage.db
      .prepare(`SELECT file_path, sha256 FROM notebook_files WHERE notebook_id = ?`)
      .all(notebookId) as Array<{ file_path: string; sha256: string }>;

    const existingMap = new Map(existingRows.map((r) => [r.file_path, r.sha256]));
    const seenPaths = new Set<string>();

    let indexedFiles = 0;
    let unchangedFiles = 0;

    for (const absFile of absFiles) {
      const relPath = path.relative(notebook.dirPath, absFile);
      seenPaths.add(relPath);

      const raw = fs.readFileSync(absFile, 'utf8');
      const sha256 = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');

      if (existingMap.get(relPath) === sha256) {
        unchangedFiles++;
        continue;
      }

      // Remove old chunks for this file if it was previously indexed
      this.removeChunksForFile(notebookId, relPath);

      // Chunk document by structural headings / paragraphs with line numbers
      const chunks = this.chunkDocument(raw, relPath);
      const now = new Date().toISOString();

      for (const chunk of chunks) {
        const chunkId = `chk_${crypto.randomUUID().slice(0, 10)}`;
        const embedding = this.computeSemanticEmbedding(
          `${chunk.section}\n${chunk.content}`,
        );

        this.storage.db
          .prepare(
            `INSERT INTO notebook_chunks (
              id, notebook_id, notebook_name, document_path, section,
              line_range, external_ref, content, embedding_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunkId,
            notebook.id,
            notebook.name,
            relPath,
            chunk.section,
            chunk.lineRange,
            chunk.externalRef ?? null,
            chunk.content,
            JSON.stringify(embedding),
          );

        this.storage.db
          .prepare(
            `INSERT INTO notebook_chunks_fts (chunk_id, notebook_id, section, content)
             VALUES (?, ?, ?, ?)`,
          )
          .run(chunkId, notebook.id, chunk.section, chunk.content);
      }

      this.storage.db
        .prepare(
          `INSERT INTO notebook_files (notebook_id, file_path, sha256, indexed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(notebook_id, file_path) DO UPDATE SET
             sha256 = excluded.sha256,
             indexed_at = excluded.indexed_at`,
        )
        .run(notebook.id, relPath, sha256, now);

      indexedFiles++;
    }

    // Also index external references configured on the notebook metadata
    if (notebook.externalRefs.length > 0) {
      const extKey = '__external_references__';
      seenPaths.add(extKey);
      const extSerialized = JSON.stringify(notebook.externalRefs);
      const extSha = crypto.createHash('sha256').update(extSerialized, 'utf8').digest('hex');
      if (existingMap.get(extKey) !== extSha) {
        this.removeChunksForFile(notebookId, extKey);
        for (const ref of notebook.externalRefs) {
          const chunkId = `chk_${crypto.randomUUID().slice(0, 10)}`;
          const content = `${ref.title}: ${ref.notes ?? ''} (${ref.url})`;
          const embedding = this.computeSemanticEmbedding(content);
          this.storage.db
            .prepare(
              `INSERT INTO notebook_chunks (
                id, notebook_id, notebook_name, document_path, section,
                line_range, external_ref, content, embedding_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              chunkId,
              notebook.id,
              notebook.name,
              extKey,
              ref.title,
              'EXT-REF',
              ref.url,
              content,
              JSON.stringify(embedding),
            );
          this.storage.db
            .prepare(
              `INSERT INTO notebook_chunks_fts (chunk_id, notebook_id, section, content)
               VALUES (?, ?, ?, ?)`,
            )
            .run(chunkId, notebook.id, ref.title, content);
        }
        this.storage.db
          .prepare(
            `INSERT INTO notebook_files (notebook_id, file_path, sha256, indexed_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(notebook_id, file_path) DO UPDATE SET
               sha256 = excluded.sha256,
               indexed_at = excluded.indexed_at`,
          )
          .run(notebook.id, extKey, extSha, new Date().toISOString());
      }
    }

    // Clean up deleted files
    let removedFiles = 0;
    for (const oldPath of existingMap.keys()) {
      if (!seenPaths.has(oldPath)) {
        this.removeChunksForFile(notebookId, oldPath);
        this.storage.db
          .prepare(`DELETE FROM notebook_files WHERE notebook_id = ? AND file_path = ?`)
          .run(notebookId, oldPath);
        removedFiles++;
      }
    }

    const countRow = this.storage.db
      .prepare(`SELECT COUNT(*) as cnt FROM notebook_chunks WHERE notebook_id = ?`)
      .get(notebookId) as { cnt: number };

    return {
      notebookId: notebook.id,
      notebookName: notebook.name,
      scannedFiles: absFiles.length,
      indexedFiles,
      unchangedFiles,
      removedFiles,
      totalChunks: Number(countRow.cnt),
    };
  }

  /**
   * Starts a Linux inotify directory watcher (`fs.watch`) for automatic incremental re-indexing.
   */
  watchNotebook(notebookId: string): void {
    if (this.watchers.has(notebookId)) return;
    const notebook = this.storage.getNotebook(notebookId);
    if (!notebook || !fs.existsSync(notebook.dirPath)) return;

    const watcher = fs.watch(notebook.dirPath, { recursive: true }, () => {
      try {
        this.indexNotebook(notebookId);
      } catch {
        // Ignore transient write lock errors
      }
    });
    this.watchers.set(notebookId, watcher);
  }

  stopWatchers(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  /**
   * Hybrid RAG retrieval (FTS5 BM25 lexical matching + semantic vector cosine similarity)
   * filtered by project association and agent role permissions.
   */
  queryForProjectRole(params: {
    projectId: string;
    role: ActorRole;
    query: string;
    topK?: number;
  }): RagCitation[] {
    const topK = params.topK ?? 5;
    const authorizedNotebooks: Notebook[] = this.storage.getProjectNotebooks(
      params.projectId,
      params.role,
    );
    if (authorizedNotebooks.length === 0) return [];

    // Ensure all authorized notebooks are up to date
    for (const nb of authorizedNotebooks) {
      this.indexNotebook(nb.id);
    }

    const allowedIds = new Set(authorizedNotebooks.map((n) => n.id));
    const queryEmbedding = this.computeSemanticEmbedding(params.query);

    // 1. Lexical FTS5 search
    const ftsScores = new Map<string, number>();
    const safeTerms = params.query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    if (safeTerms.length > 0) {
      const ftsQuery = safeTerms.map((t) => `"${t}"*`).join(' OR ');
      try {
        const ftsRows = this.storage.db
          .prepare(
            `SELECT chunk_id, notebook_id, bm25(notebook_chunks_fts) as rank
             FROM notebook_chunks_fts
             WHERE notebook_chunks_fts MATCH ?
             LIMIT 30`,
          )
          .all(ftsQuery) as Array<{ chunk_id: string; notebook_id: string; rank: number }>;

        for (const r of ftsRows) {
          if (allowedIds.has(r.notebook_id)) {
            // In SQLite FTS5, bm25 rank is negative (more negative = better match)
            ftsScores.set(r.chunk_id, Math.min(1, Math.abs(Number(r.rank)) / 10));
          }
        }
      } catch {
        // Fallback to vector-only if FTS query syntax is rejected
      }
    }

    // 2. Semantic Vector Similarity + Hybrid Reranking across authorized chunks
    const placeholders = Array.from(allowedIds).map(() => '?').join(',');
    const rows = this.storage.db
      .prepare(`SELECT * FROM notebook_chunks WHERE notebook_id IN (${placeholders})`)
      .all(...Array.from(allowedIds)) as Array<Record<string, unknown>>;

    const scored: RagCitation[] = [];
    for (const row of rows) {
      const chunkId = String(row.id);
      const embedding = JSON.parse(String(row.embedding_json)) as number[];
      const vecSim = this.cosineSimilarity(queryEmbedding, embedding);
      const lexScore = ftsScores.get(chunkId) ?? 0;

      // Hybrid score: 60% semantic vector similarity + 40% FTS5 lexical score
      const hybridScore = Number((vecSim * 0.6 + lexScore * 0.4).toFixed(4));
      if (hybridScore > 0.05 || lexScore > 0) {
        scored.push({
          chunkId,
          notebookId: String(row.notebook_id),
          notebookName: String(row.notebook_name),
          documentPath: String(row.document_path),
          section: String(row.section),
          lineRange: String(row.line_range),
          externalRef: row.external_ref ? String(row.external_ref) : undefined,
          snippet: String(row.content),
          score: hybridScore,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  static formatCitationTag(citation: RagCitation): string {
    const ext = citation.externalRef ? ` | Ref: ${citation.externalRef}` : '';
    return `[Notebook: ${citation.notebookName} | Doc: ${citation.documentPath} | Section: ${citation.section} (${citation.lineRange})${ext}]`;
  }

  private removeChunksForFile(notebookId: string, relPath: string): void {
    const oldChunks = this.storage.db
      .prepare(`SELECT id FROM notebook_chunks WHERE notebook_id = ? AND document_path = ?`)
      .all(notebookId, relPath) as Array<{ id: string }>;

    for (const c of oldChunks) {
      this.storage.db.prepare(`DELETE FROM notebook_chunks_fts WHERE chunk_id = ?`).run(c.id);
    }
    this.storage.db
      .prepare(`DELETE FROM notebook_chunks WHERE notebook_id = ? AND document_path = ?`)
      .run(notebookId, relPath);
  }

  private walkDirectory(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) return [];
    const results: string[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.walkDirectory(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
    return results;
  }

  private chunkDocument(
    rawText: string,
    relPath: string,
  ): Array<{ section: string; lineRange: string; content: string; externalRef?: string }> {
    const lines = rawText.split(/\r?\n/);
    const chunks: Array<{
      section: string;
      lineRange: string;
      content: string;
      externalRef?: string;
    }> = [];

    let currentSection = path.basename(relPath);
    let buffer: string[] = [];
    let startLine = 1;

    const flush = (endLine: number) => {
      const text = buffer.join('\n').trim();
      if (text.length > 0) {
        const urlMatch = text.match(/https?:\/\/[^\s)]+/);
        chunks.push({
          section: currentSection,
          lineRange: `L${startLine}-L${endLine}`,
          content: text,
          externalRef: urlMatch ? urlMatch[0] : undefined,
        });
      }
      buffer = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        if (buffer.length > 0) {
          flush(i);
        }
        currentSection = headingMatch[2].trim();
        startLine = i + 1;
        buffer.push(line);
      } else {
        buffer.push(line);
        if (buffer.join('\n').length >= 900) {
          flush(i + 1);
          startLine = i + 2;
        }
      }
    }
    flush(lines.length);
    return chunks;
  }

  /**
   * Computes a normalized 128-dimensional semantic character/word n-gram embedding vector.
   */
  private computeSemanticEmbedding(text: string, dims = 128): number[] {
    const vec = new Array<number>(dims).fill(0);
    const normalized = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const tokens = normalized.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

    for (const token of tokens) {
      // Word unigram hash
      const h1 = this.fnv1aHash(token);
      vec[h1 % dims] += 2.0;

      // Character trigram hashes for morphological / root similarity
      for (let i = 0; i <= token.length - 3; i++) {
        const tri = token.slice(i, i + 3);
        const h2 = this.fnv1aHash(tri);
        vec[h2 % dims] += 1.0;
      }
    }

    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => Number((v / norm).toFixed(5)));
  }

  private fnv1aHash(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
    }
    return Math.max(0, Math.min(1, dot));
  }
}

