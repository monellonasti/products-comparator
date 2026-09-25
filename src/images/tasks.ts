// Background image pipeline: fetch (SSRF-safe) -> byte dedupe by sha256 -> derivatives in storage ->
// embedding per indexing model. Every step is idempotent (re-running a job never duplicates rows,
// objects or vectors) and permanent failures are recorded instead of retried forever.
import { pool, withTx, vectorLiteral } from '../db/pool.ts';
import { config } from '../config.ts';
import { sha256 } from '../lib/hash.ts';
import { storage, keys } from '../storage/index.ts';
import { safeFetch } from './safe-fetch.ts';
import { makeDerivatives, validateImage, ImageInputError } from '../vision/preprocess.ts';
import { getEmbedder } from '../vision/embedder.ts';
import { specForKey } from '../vision/models.ts';
import { getIndexingModels } from '../vision/index-admin.ts';
import { enqueueEmbed } from '../jobs/queue.ts';
import { refreshProducts } from '../domain/canonical.ts';

export const FETCH_MAX_ATTEMPTS = 6;

export class TransientError extends Error {}

export async function fetchImageSource(sourceId: string): Promise<'fetched' | 'skipped' | 'failed'> {
  const src = (
    await pool.query(
      `SELECT s.*, sp.image_host_allowlist FROM image_sources s JOIN suppliers sp ON sp.id = s.supplier_id WHERE s.id = $1`,
      [sourceId],
    )
  ).rows[0];
  if (!src || src.status === 'fetched') return 'skipped';

  const outcome = await safeFetch(src.url, { allowlist: src.image_host_allowlist ?? [] });
  if (outcome.kind !== 'ok') {
    const attempts = src.attempts + 1;
    const permanent = outcome.kind === 'permanent' || attempts >= FETCH_MAX_ATTEMPTS;
    const status = outcome.kind === 'permanent' && /SSRF|autorizzati|Schema/.test(outcome.reason) ? 'blocked' : permanent ? 'failed' : 'pending';
    await pool.query(`UPDATE image_sources SET status = $2, attempts = $3, last_error = $4, last_attempt_at = now(), updated_at = now() WHERE id = $1`, [
      sourceId, status, attempts, outcome.reason,
    ]);
    if (!permanent) throw new TransientError(`download ${src.url}: ${outcome.reason}`);
    return 'failed';
  }

  let assetId: string;
  try {
    assetId = await storeAsset(outcome.bytes);
  } catch (err) {
    if (err instanceof ImageInputError) {
      await pool.query(`UPDATE image_sources SET status = 'failed', attempts = attempts + 1, last_error = $2, last_attempt_at = now(), updated_at = now() WHERE id = $1`, [
        sourceId, err.message,
      ]);
      return 'failed';
    }
    throw err;
  }

  await withTx(async (tx) => {
    await tx.query(
      `UPDATE image_sources SET status = 'fetched', image_asset_id = $2, attempts = attempts + 1, last_error = NULL,
              last_attempt_at = now(), fetched_at = now(), updated_at = now() WHERE id = $1`,
      [sourceId, assetId],
    );
    for (const key of await getIndexingModels(tx)) {
      const done = (await tx.query(`SELECT status FROM image_embeddings WHERE image_asset_id = $1 AND model_key = $2`, [assetId, key])).rows[0];
      if (done?.status !== 'done') await enqueueEmbed(tx, assetId, key);
    }
    const products = (
      await tx.query(`SELECT DISTINCT o.product_id FROM offer_images oi JOIN supplier_offers o ON o.id = oi.offer_id WHERE oi.image_source_id = $1`, [sourceId])
    ).rows.map((r) => r.product_id);
    await refreshProducts(tx, products);
  });
  return 'fetched';
}

/** Stores derivatives once per distinct byte content; returns the image_assets id. */
export async function storeAsset(bytes: Buffer): Promise<string> {
  const sha = sha256(bytes);
  const existing = (await pool.query(`SELECT id FROM image_assets WHERE sha256 = $1`, [sha])).rows[0];
  if (existing) return existing.id;
  const meta = await validateImage(bytes);
  const d = await makeDerivatives(bytes);
  const s = storage();
  const k = {
    thumb: keys.image(sha, 'thumb', 'webp'),
    display: keys.image(sha, 'display', 'webp'),
    infer: keys.image(sha, 'infer', 'jpg'),
    original: config.IMAGE_KEEP_ORIGINALS ? keys.image(sha, 'original', meta.format) : null,
  };
  await Promise.all([
    s.put(k.thumb, d.thumb, 'image/webp'),
    s.put(k.display, d.display, 'image/webp'),
    s.put(k.infer, d.infer, 'image/jpeg'),
    k.original ? s.put(k.original, bytes, `image/${meta.format}`) : Promise.resolve(),
  ]);
  const ins = await pool.query(
    `INSERT INTO image_assets (sha256, dhash, width, height, format, bytes, original_key, thumb_key, display_key, infer_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (sha256) DO NOTHING RETURNING id`,
    [sha, d.dhash, d.width, d.height, meta.format, bytes.length, k.original, k.thumb, k.display, k.infer],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  return (await pool.query(`SELECT id FROM image_assets WHERE sha256 = $1`, [sha])).rows[0].id;
}

export async function embedAsset(assetId: string, modelKeyValue: string): Promise<'done' | 'skipped' | 'failed'> {
  const spec = specForKey(modelKeyValue);
  const model = (await pool.query(`SELECT status FROM embedding_models WHERE key = $1`, [modelKeyValue])).rows[0];
  if (!spec || !model || model.status === 'retired') return 'skipped';
  const asset = (await pool.query(`SELECT id, infer_key FROM image_assets WHERE id = $1`, [assetId])).rows[0];
  if (!asset) return 'skipped';
  const current = (await pool.query(`SELECT status, attempts FROM image_embeddings WHERE image_asset_id = $1 AND model_key = $2`, [assetId, modelKeyValue])).rows[0];
  if (current?.status === 'done') return 'skipped';
  try {
    const bytes = await storage().get(asset.infer_key);
    const vec = await getEmbedder(spec.id).embed(bytes);
    await pool.query(
      `INSERT INTO image_embeddings (image_asset_id, model_key, status, embedding, attempts)
       VALUES ($1, $2, 'done', $3::vector, 1)
       ON CONFLICT (image_asset_id, model_key) DO UPDATE SET status = 'done', embedding = EXCLUDED.embedding, error = NULL,
         attempts = image_embeddings.attempts + 1, updated_at = now()`,
      [assetId, modelKeyValue, vectorLiteral(vec)],
    );
    return 'done';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = (current?.attempts ?? 0) + 1;
    await pool.query(
      `INSERT INTO image_embeddings (image_asset_id, model_key, status, error, attempts) VALUES ($1, $2, 'failed', $3, $4)
       ON CONFLICT (image_asset_id, model_key) DO UPDATE SET status = 'failed', error = EXCLUDED.error, attempts = EXCLUDED.attempts, updated_at = now()`,
      [assetId, modelKeyValue, message.slice(0, 1000), attempts],
    );
    if (attempts < 3) throw err;
    return 'failed';
  }
}
