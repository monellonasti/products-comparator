// graphile-worker task list. Each task is idempotent and safe to run twice.
import type { TaskList } from 'graphile-worker';
import { pool, withTx } from '../db/pool.ts';
import { storage } from '../storage/index.ts';
import { runImport } from '../imports/pipeline.ts';
import { fetchImageSource, embedAsset, recheckImageSource, scheduleImageRechecks } from '../images/tasks.ts';
import { refreshProducts } from '../domain/canonical.ts';
import { suggestForProducts } from '../domain/suggestions.ts';
import { enqueueEmbed } from '../jobs/queue.ts';
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
    for (const s of expired) {
      if (s.image_key) await storage().delete(s.image_key).catch(() => {});
      await pool.query(`UPDATE photo_searches SET image_deleted_at = now() WHERE id = $1`, [s.id]);
    }
    // 2) Expired sessions; change history older than CHANGE_HISTORY_DAYS.
    const sessions = await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
    await pool.query(`DELETE FROM offer_changes WHERE created_at < now() - make_interval(days => $1)`, [config.CHANGE_HISTORY_DAYS]);
    // 3) Staging rows of finished runs older than 7 days (kept for failed runs to allow retry).
    await pool.query(
      `DELETE FROM import_staging_rows WHERE import_run_id IN (SELECT id FROM import_runs WHERE status IN ('succeeded', 'cancelled') AND finished_at < now() - interval '7 days')`,
    );
    // 4) Orphan image objects: stored derivatives without an image_assets row (crash between upload and insert).
    let orphans = 0;
    const cutoff = Date.now() - 24 * 3600_000;
    const seen = new Set<string>();
    for await (const obj of storage().list('img/')) {
      const sha = obj.key.split('/')[2];
      if (!sha || seen.has(sha) || (obj.lastModified && obj.lastModified.getTime() > cutoff)) continue;
      seen.add(sha);
      const exists = (await pool.query(`SELECT 1 FROM image_assets WHERE sha256 = $1`, [sha])).rowCount;
      if (!exists) {
        for (const v of ['thumb.webp', 'display.webp', 'infer.jpg']) await storage().delete(`img/${sha.slice(0, 2)}/${sha}/${v}`).catch(() => {});
        orphans++;
      }
      if (seen.size > 20000) break;
    }
    helpers.logger.info(`maintenance: search images purged=${expired.length} sessions=${sessions.rowCount} orphan objects=${orphans}`);
  },
};
