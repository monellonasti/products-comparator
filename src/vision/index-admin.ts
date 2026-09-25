// Embedding model registration and per-model HNSW partial indexes.
import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.ts';
import { escapeLiteral } from 'pg';
import { modelKey, specForKey, type ModelSpec } from './models.ts';

export function indexName(key: string): string {
  return `image_embeddings_hnsw_${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
}

/** SQL fragments with the model key inlined as a literal so the planner can match the partial index. */
export function vectorExpr(dim: number): string {
  return `(embedding::vector(${Number(dim)}))`;
}
export function modelPredicate(key: string): string {
  return `model_key = ${escapeLiteral(key)} AND status = 'done'`;
}

export async function ensureModel(db: Db, spec: ModelSpec, opts: { activateIfNoneActive: boolean }): Promise<string> {
  const key = modelKey(spec);
  await db.query(
    `INSERT INTO embedding_models (key, repo, revision, dim, preprocess, license, status, thresholds)
     VALUES ($1, $2, $3, $4, $5, $6, 'building', $7::jsonb) ON CONFLICT (key) DO NOTHING`,
    [key, spec.repo, spec.revision, spec.dim, spec.preprocess, spec.license, JSON.stringify(spec.thresholds)],
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${indexName(key)} ON image_embeddings USING hnsw (${vectorExpr(spec.dim)} vector_cosine_ops)
     WITH (m = 16, ef_construction = 64) WHERE ${modelPredicate(key)}`,
  );
  if (opts.activateIfNoneActive) {
    await db.query(
      `UPDATE embedding_models SET status = 'active', activated_at = now()
        WHERE key = $1 AND NOT EXISTS (SELECT 1 FROM embedding_models WHERE status = 'active')`,
      [key],
    );
  }
  return key;
}

export interface ActiveModel {
  key: string;
  spec: ModelSpec;
  thresholds: { possible: number; similar: number; calibrated: boolean };
}

export async function getActiveModel(db: Db): Promise<ActiveModel | null> {
  const row = (await db.query(`SELECT key, thresholds FROM embedding_models WHERE status = 'active'`)).rows[0];
  if (!row) return null;
  const spec = specForKey(row.key);
  if (!spec) return null;
  return { key: row.key, spec, thresholds: row.thresholds };
}

/** Models whose vectors must be (re)computed for new images: the active one and any being built. */
export async function getIndexingModels(db: Db): Promise<string[]> {
  return (await db.query(`SELECT key FROM embedding_models WHERE status IN ('active', 'building') ORDER BY status`)).rows.map((r) => r.key);
}

export async function indexCoverage(db: Db, key: string): Promise<{ assets: number; indexed: number; failed: number; pending: number }> {
  const r = (
    await db.query(
      `SELECT (SELECT count(*)::int FROM image_assets) AS assets,
              count(*) FILTER (WHERE e.status = 'done')::int AS indexed,
              count(*) FILTER (WHERE e.status = 'failed')::int AS failed
         FROM image_embeddings e WHERE e.model_key = $1`,
      [key],
    )
  ).rows[0];
  return { assets: r.assets, indexed: r.indexed, failed: r.failed, pending: Math.max(0, r.assets - r.indexed - r.failed) };
}
