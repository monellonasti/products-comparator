// graphile-worker task list. Each task is idempotent and safe to run twice.
import type { TaskList } from 'graphile-worker';
import { pool, withTx } from '../db/pool.ts';
import { storage } from '../storage/index.ts';
import { runImport } from '../imports/pipeline.ts';
import { fetchImageSource, embedAsset, recheckImageSource, scheduleImageRechecks } from '../images/tasks.ts';
import { refreshProducts } from '../domain/canonical.ts';
import { suggestForProducts } from '../domain/suggestions.ts';
import { enqueueEmbed, enqueueImageFetch } from '../jobs/queue.ts';
import { feedsTick, runFeed } from '../imports/feed.ts';
import { config } from '../config.ts';

export const taskList: TaskList = {
  async import_run(payload: any, helpers) {
    const outcome = await runImport(payload.runId, {
      info: (o, m) => helpers.logger.info(`${m ?? ''} ${JSON.stringify(o)}`),
      warn: (o, m) => helpers.logger.warn(`${m ?? ''} ${JSON.stringify(o)}`),
      error: (o, m) => helpers.logger.error(`${m ?? ''} ${JSON.stringify(o)}`),
    });
    if (outcome === 'busy') throw new Error('import already running in another worker; will retry');
  },

  async image_fetch(payload: any) {
    await fetchImageSource(payload.sourceId);
  },

  async images_recheck(payload: any, helpers) {
    const n = await scheduleImageRechecks(payload.supplierId, payload.runId ?? null);
    if (n) helpers.logger.info(`images_recheck supplier=${payload.supplierId}: ${n} immagini da ricontrollare`);
  },

  async image_recheck(payload: any, helpers) {
    const outcome = await recheckImageSource(payload.sourceId, payload.runId ?? null);
    if (outcome === 'replaced') helpers.logger.info(`image_recheck ${payload.sourceId}: immagine sostituita dal fornitore`);
  },

  async image_embed(payload: any) {
    await embedAsset(payload.assetId, payload.modelKey);
  },

  async products_refresh(payload: any) {
    const ids: string[] = payload.productIds ?? [];
    for (let i = 0; i < ids.length; i += 500) await withTx((tx) => refreshProducts(tx, ids.slice(i, i + 500)));
  },

  async suggest_matches(payload: any, helpers) {
    // Products of this supplier without a usable GTIN, touched by the import.
    const ids = (
      await pool.query(
        `SELECT DISTINCT o.product_id FROM supplier_offers o JOIN products p ON p.id = o.product_id
          WHERE o.supplier_id = $1 AND ($2::uuid IS NULL OR o.last_import_id = $2) AND NOT p.has_gtin AND p.status = 'active'`,
        [payload.supplierId, payload.importRunId ?? null],
      )
    ).rows.map((r) => r.product_id);
    let opened = 0;
    for (let i = 0; i < ids.length; i += 200) opened += await withTx((tx) => suggestForProducts(tx, ids.slice(i, i + 200), payload.importRunId ?? null));
    helpers.logger.info(`suggest_matches supplier=${payload.supplierId} products=${ids.length} opened=${opened}`);
  },

  async feeds_tick(_payload, helpers) {
    const n = await feedsTick();
    if (n) helpers.logger.info(`feeds_tick: ${n} feed da eseguire`);
  },

  async feed_fetch(payload: any, helpers) {
    const outcome = await runFeed(payload.supplierId, payload.trigger === 'manual' ? 'manual' : 'schedule', (m) => helpers.logger.info(m));
    helpers.logger.info(`feed_fetch ${payload.supplierId}: ${outcome}`);
  },

  async reindex_model(payload: any, helpers) {
    // Enqueue embeddings for every asset missing a vector for this model (used when switching model).
    const rows = (
      await pool.query(
        `SELECT a.id FROM image_assets a
          WHERE NOT EXISTS (SELECT 1 FROM image_embeddings e WHERE e.image_asset_id = a.id AND e.model_key = $1 AND e.status = 'done')`,
        [payload.modelKey],
      )
    ).rows;
    for (let i = 0; i < rows.length; i += 1000) {
      await withTx(async (tx) => {
        for (const r of rows.slice(i, i + 1000)) await enqueueEmbed(tx, r.id, payload.modelKey);
      });
    }
    helpers.logger.info(`reindex_model ${payload.modelKey}: ${rows.length} images queued`);
  },

  async maintenance(_payload, helpers) {
    // 1) Short retention for search photos (they never become catalogue images).
    const expired = (
      await pool.query(`SELECT id, image_key FROM photo_searches WHERE image_deleted_at IS NULL AND image_expires_at < now() LIMIT 1000`)
    ).rows;
    let deleteFailures = 0;
    for (const s of expired) {
      if (s.image_key) {
        try {
          await storage().delete(s.image_key);
        } catch {
          deleteFailures++; // not marked as deleted: retried at the next run
          continue;
        }
      }
      await pool.query(`UPDATE photo_searches SET image_deleted_at = now() WHERE id = $1`, [s.id]);
    }
    if (deleteFailures) helpers.logger.warn(`maintenance: ${deleteFailures} search photos not deleted (storage error), retried next run`);
    // 2) Expired sessions; change history older than CHANGE_HISTORY_DAYS.
    const sessions = await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
    await pool.query(`DELETE FROM offer_changes WHERE created_at < now() - make_interval(days => $1)`, [config.CHANGE_HISTORY_DAYS]);
    // 3) Staging rows of finished runs older than 7 days (kept for failed runs to allow retry).
    await pool.query(
      `DELETE FROM import_staging_rows WHERE import_run_id IN (SELECT id FROM import_runs WHERE status IN ('succeeded', 'cancelled') AND finished_at < now() - interval '7 days')`,
    );
    // 4) Image downloads still pending after an hour with no job left (e.g. retries exhausted during a
    //    storage outage): queued again, otherwise they would stay pending forever.
    const stalled = (
      await pool.query(
        `SELECT s.id, s.url FROM image_sources s
          WHERE s.status = 'pending' AND s.updated_at < now() - interval '1 hour'
            AND NOT EXISTS (SELECT 1 FROM graphile_worker._private_jobs j WHERE j.key = 'image_fetch:' || s.id)
          LIMIT 1000`,
      )
    ).rows;
    for (const s of stalled) await enqueueImageFetch(pool, s.id, s.url);
    if (stalled.length) helpers.logger.warn(`maintenance: ${stalled.length} pending image downloads queued again`);
    // 5) Orphan objects: image derivatives without an image_assets row (crash between upload and insert) and
    //    search photos without a photo_searches row (search failed after storing the photo).
    const orphans = await sweepOrphans(helpers.logger);
    helpers.logger.info(
      `maintenance: search images purged=${expired.length - deleteFailures} sessions=${sessions.rowCount} orphan images=${orphans.images} orphan search photos=${orphans.searches}`,
    );
  },
};

/**
 * Deletes stored objects that no database row references. Guarded against a wrong or empty database
 * (a lost volume, a wrong DATABASE_URL): then everything looks orphaned, and deleting it would also
 * propagate to a mirrored backup. The sweep stops without deleting when the catalogue is empty or when
 * too large a share of the checked objects looks orphaned.
 */
async function sweepOrphans(logger: { warn: (m: string) => void; error: (m: string) => void }): Promise<{ images: number; searches: number }> {
  const cutoff = Date.now() - 24 * 3600_000;
  const assets = (await pool.query(`SELECT count(*)::int AS n FROM image_assets`)).rows[0].n as number;
  let images = 0;
  if (assets === 0) {
    logger.warn('maintenance: image_assets is empty, orphan image sweep skipped (wrong or new database?)');
  } else {
    const checked = new Set<string>();
    const orphanShas: string[] = [];
    for await (const obj of storage().list('img/')) {
      const sha = obj.key.split('/')[2];
      if (!sha || checked.has(sha) || (obj.lastModified && obj.lastModified.getTime() > cutoff)) continue;
      checked.add(sha);
      if (!(await pool.query(`SELECT 1 FROM image_assets WHERE sha256 = $1`, [sha])).rowCount) orphanShas.push(sha);
      if (checked.size >= 20000) break;
    }
    if (orphanShas.length > 20 && orphanShas.length > checked.size * 0.2) {
      logger.error(`maintenance: ${orphanShas.length} of ${checked.size} stored images have no database row: sweep skipped, check the database`);
    } else {
      for (const sha of orphanShas) {
        for (const v of ['thumb.webp', 'display.webp', 'infer.jpg']) await storage().delete(`img/${sha.slice(0, 2)}/${sha}/${v}`).catch(() => {});
        images++;
      }
    }
  }
  // Search photos: older than the retention window plus a day and without a row. Normally none exist
  // (expired photos are deleted above), so the guard is on an empty table rather than on a ratio.
  let searches = 0;
  const searchRows = (await pool.query(`SELECT count(*)::int AS n FROM photo_searches`)).rows[0].n as number;
  if (searchRows === 0) return { images, searches };
  const searchCutoff = Date.now() - (config.PHOTO_SEARCH_RETENTION_HOURS + 24) * 3600_000;
  const candidates: string[] = [];
  let checkedSearches = 0;
  for await (const obj of storage().list('searches/')) {
    if (obj.lastModified && obj.lastModified.getTime() > searchCutoff) continue;
    checkedSearches++;
    if (!(await pool.query(`SELECT 1 FROM photo_searches WHERE image_key = $1`, [obj.key])).rowCount) candidates.push(obj.key);
    if (checkedSearches >= 5000) break;
  }
  for (const key of candidates) {
    await storage().delete(key).catch(() => {});
    searches++;
  }
  return { images, searches };
}
