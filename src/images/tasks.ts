// Background image pipeline: fetch (SSRF-safe) -> byte dedupe by sha256 -> derivatives in storage ->
// embedding per indexing model. Every step is idempotent (re-running a job never duplicates rows,
// objects or vectors) and permanent failures are recorded instead of retried forever.
// Downloaded images are re-checked after later imports (conditional request): a supplier may replace the
// picture keeping the same URL; the new content becomes a new asset and an 'image_replaced' change.
import { pool, withTx, vectorLiteral, type Tx } from '../db/pool.ts';
import { config } from '../config.ts';
import { sha256 } from '../lib/hash.ts';
import { storage, keys } from '../storage/index.ts';
import { safeFetch } from './safe-fetch.ts';
import { makeDerivatives, validateImage, ImageInputError } from '../vision/preprocess.ts';
import { getEmbedder } from '../vision/embedder.ts';
import { specForKey } from '../vision/models.ts';
import { getIndexingModels } from '../vision/index-admin.ts';
import { enqueueEmbed, enqueueImageRecheck } from '../jobs/queue.ts';
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
              last_attempt_at = now(), fetched_at = now(), checked_at = now(), etag = $3, last_modified = $4, updated_at = now()
        WHERE id = $1`,
      [sourceId, assetId, outcome.etag, outcome.lastModified],
    );
    await afterAssetLinked(tx, sourceId, assetId);
  });
  return 'fetched';
}

/** Vectors for every indexing model + refreshed product summaries (primary image). */
async function afterAssetLinked(tx: Tx, sourceId: string, assetId: string) {
  for (const key of await getIndexingModels(tx)) {
    const done = (await tx.query(`SELECT status FROM image_embeddings WHERE image_asset_id = $1 AND model_key = $2`, [assetId, key])).rows[0];
    if (done?.status !== 'done') await enqueueEmbed(tx, assetId, key);
  }
  const products = (
    await tx.query(`SELECT DISTINCT o.product_id FROM offer_images oi JOIN supplier_offers o ON o.id = oi.offer_id WHERE oi.image_source_id = $1`, [sourceId])
  ).rows.map((r) => r.product_id);
  await refreshProducts(tx, products);
}

/**
 * Queues a re-check of the supplier's downloaded images that are still used by active offers and were not
 * checked for IMAGE_RECHECK_HOURS (oldest first, at most IMAGE_RECHECK_MAX_PER_RUN). Called after an import.
 */
export async function scheduleImageRechecks(supplierId: string, runId: string | null): Promise<number> {
  if (!config.IMAGE_RECHECK_HOURS) return 0;
  const due = (
    await pool.query(
      `SELECT s.id, s.url FROM image_sources s
        WHERE s.supplier_id = $1 AND s.status = 'fetched'
          AND coalesce(s.checked_at, s.fetched_at) < now() - make_interval(hours => $2)
          AND EXISTS (SELECT 1 FROM offer_images oi JOIN supplier_offers o ON o.id = oi.offer_id WHERE oi.image_source_id = s.id AND o.active)
        ORDER BY coalesce(s.checked_at, s.fetched_at)
        LIMIT $3`,
      [supplierId, config.IMAGE_RECHECK_HOURS, config.IMAGE_RECHECK_MAX_PER_RUN],
    )
  ).rows;
  for (let i = 0; i < due.length; i += 500) {
    await withTx(async (tx) => {
      for (const s of due.slice(i, i + 500)) await enqueueImageRecheck(tx, s.id, s.url, runId);
    });
  }
  return due.length;
}

export type RecheckOutcome = 'unchanged' | 'replaced' | 'skipped' | 'error';

/**
 * Downloads again an image that was already fetched. HTTP 304 or identical bytes: only the check time is
 * updated. Different bytes: the source points to the new asset (the old one stays for the change report),
 * vectors are queued and an 'image_replaced' change is recorded for every active offer using the image.
 * Errors keep the current image (checked again after a later import).
 */
export async function recheckImageSource(sourceId: string, runId: string | null): Promise<RecheckOutcome> {
  const src = (
    await pool.query(
      `SELECT s.*, sp.image_host_allowlist, a.sha256 AS asset_sha FROM image_sources s
         JOIN suppliers sp ON sp.id = s.supplier_id LEFT JOIN image_assets a ON a.id = s.image_asset_id
        WHERE s.id = $1`,
      [sourceId],
    )
  ).rows[0];
  if (!src || src.status !== 'fetched') return 'skipped';
  const markChecked = (etag: string | null = src.etag, lastModified: string | null = src.last_modified) =>
    pool.query(`UPDATE image_sources SET checked_at = now(), etag = $2, last_modified = $3 WHERE id = $1`, [sourceId, etag, lastModified]);

  const outcome = await safeFetch(src.url, { allowlist: src.image_host_allowlist ?? [], conditional: { etag: src.etag, lastModified: src.last_modified } });
  if (outcome.kind === 'not_modified') {
    await markChecked();
    return 'unchanged';
  }
  if (outcome.kind !== 'ok') {
    await markChecked();
    return 'error';
  }
  if (sha256(outcome.bytes) === src.asset_sha) {
    await markChecked(outcome.etag, outcome.lastModified);
    return 'unchanged';
  }
  let assetId: string;
  try {
    assetId = await storeAsset(outcome.bytes);
  } catch (err) {
    if (!(err instanceof ImageInputError)) throw err;
    await markChecked();
    return 'error';
  }

  return withTx(async (tx): Promise<RecheckOutcome> => {
    const current = (await tx.query(`SELECT image_asset_id FROM image_sources WHERE id = $1 FOR UPDATE`, [sourceId])).rows[0];
    if (!current || current.image_asset_id !== src.image_asset_id) return 'skipped'; // changed concurrently
    await tx.query(
      `UPDATE image_sources SET image_asset_id = $2, etag = $3, last_modified = $4, checked_at = now(), fetched_at = now(), updated_at = now()
        WHERE id = $1`,
      [sourceId, assetId, outcome.etag, outcome.lastModified],
    );
    const offers = (
      await tx.query(
        `SELECT o.id, o.product_id FROM offer_images oi JOIN supplier_offers o ON o.id = oi.offer_id WHERE oi.image_source_id = $1 AND o.active`,
        [sourceId],
      )
    ).rows;
    if (offers.length) {
      // One row per offer and run: several replaced images of the same offer are merged into the lists.
      const inserted = (
        await tx.query(
          `INSERT INTO offer_changes AS c (import_run_id, supplier_id, offer_id, product_id, change_type, old_value, new_value)
           SELECT $1::uuid, $2::uuid, x.offer_id, x.product_id, 'image_replaced', $5::jsonb, $6::jsonb
             FROM unnest($3::uuid[], $4::uuid[]) AS x(offer_id, product_id)
           ON CONFLICT (import_run_id, offer_id, change_type) DO UPDATE
             SET old_value = jsonb_build_object('images', (c.old_value -> 'images') || (EXCLUDED.old_value -> 'images')),
                 new_value = jsonb_build_object('images', (c.new_value -> 'images') || (EXCLUDED.new_value -> 'images'))
           RETURNING (xmax = 0) AS inserted`,
          [
            runId, src.supplier_id, offers.map((o) => o.id), offers.map((o) => o.product_id),
            JSON.stringify({ images: [{ url: src.url, assetId: src.image_asset_id }] }),
            JSON.stringify({ images: [{ url: src.url, assetId }] }),
          ],
        )
      ).rows.filter((r) => r.inserted).length;
      if (runId && inserted) {
        await tx.query(
          `UPDATE import_runs SET counters = jsonb_set(counters, '{changes_image_replaced}', to_jsonb(coalesce((counters ->> 'changes_image_replaced')::int, 0) + $2))
            WHERE id = $1`,
          [runId, inserted],
        );
      }
    }
    await afterAssetLinked(tx, sourceId, assetId);
    return 'replaced';
  });
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
