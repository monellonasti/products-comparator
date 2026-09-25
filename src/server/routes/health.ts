import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.ts';
import { storage } from '../../storage/index.ts';
import { config, isProduction } from '../../config.ts';
import { metrics } from '../metrics.ts';
import { getActiveModel, indexCoverage } from '../../vision/index-admin.ts';
import { getEmbedder } from '../../vision/embedder.ts';

export async function healthRoutes(app: FastifyInstance) {
  // Liveness: the process is up.
  app.get('/healthz', async () => ({ ok: true }));

  // Readiness: DB and storage reachable. Visual search degradation is reported but does not fail
  // readiness (the catalogue must stay usable without it).
  app.get('/readyz', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      await pool.query('SELECT 1');
      checks.database = { ok: true };
    } catch (err) {
      checks.database = { ok: false, detail: (err as Error).message };
    }
    try {
      await storage().check(!isProduction);
      checks.storage = { ok: true };
    } catch (err) {
      checks.storage = { ok: false, detail: (err as Error).message };
    }
    const vision = config.VISION_ENABLED ? getEmbedder().status() : { state: 'disabled', error: null };
    const ready = checks.database.ok && checks.storage.ok;
    return reply.status(ready ? 200 : 503).send({ ready, checks, vision: { state: vision.state, error: vision.error ? 'unavailable' : null } });
  });

  app.get('/metrics', async (request, reply) => {
    if (!config.METRICS_TOKEN || request.headers.authorization !== `Bearer ${config.METRICS_TOKEN}`) return reply.status(404).send();
    const gauges: Record<string, number> = {};
    try {
      const q = (
        await pool.query(
          `SELECT (SELECT count(*) FROM graphile_worker._private_jobs)::int AS queue_depth,
                  (SELECT count(*) FROM graphile_worker._private_jobs WHERE last_error IS NOT NULL)::int AS queue_jobs_with_errors,
                  (SELECT count(*) FROM image_sources WHERE status IN ('failed', 'blocked'))::int AS image_download_failures,
                  (SELECT count(*) FROM image_sources WHERE status = 'pending')::int AS image_download_pending,
                  (SELECT count(*) FROM supplier_offers o JOIN suppliers s ON s.id = o.supplier_id
                    WHERE o.active AND o.source_as_of < now() - make_interval(hours => s.stale_after_hours))::int AS stale_offers,
                  (SELECT count(*) FROM import_runs WHERE status = 'failed' AND finished_at > now() - interval '7 days')::int AS failed_imports_7d`,
        )
      ).rows[0];
      Object.assign(gauges, q);
      const active = await getActiveModel(pool);
      if (active) {
        const c = await indexCoverage(pool, active.key);
        gauges.vision_index_assets = c.assets;
        gauges.vision_index_indexed = c.indexed;
        gauges.vision_index_failed = c.failed;
      }
    } catch {
      gauges.metrics_db_error = 1;
    }
    return reply.header('content-type', 'text/plain; version=0.0.4').send(metrics.render(gauges));
  });
}
