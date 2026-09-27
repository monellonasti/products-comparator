// API/web process entry point.
process.env.APP_ROLE ??= 'comparator-api';
import { config } from '../config.ts';
import { migrate } from '../db/migrate.ts';
import { pool } from '../db/pool.ts';
import { ensureWorkerSchema } from '../jobs/setup.ts';
import { ensureModel, getActiveModel } from '../vision/index-admin.ts';
import { getModelSpec } from '../vision/models.ts';
import { getEmbedder } from '../vision/embedder.ts';
import { storage } from '../storage/index.ts';
import { buildApp } from './app.ts';

await migrate(config.DATABASE_URL, (m) => console.log(JSON.stringify({ level: 'info', msg: m })));
await ensureWorkerSchema(config.DATABASE_URL);
await ensureModel(pool, getModelSpec(config.VISION_MODEL), { activateIfNoneActive: true });
await storage().check(config.NODE_ENV !== 'production').catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'storage not reachable at startup', err: err.message }));
});

const app = await buildApp();
await app.listen({ port: config.PORT, host: config.HOST });

if (config.VISION_ENABLED && config.VISION_WARMUP) {
  // Load the encoder in background so the first photo search does not pay the cold start. The search uses
  // the ACTIVE model from the database (it may differ from VISION_MODEL after `pnpm model:prepare --activate`).
  const active = await getActiveModel(pool);
  const warm = getEmbedder(active?.spec.id ?? config.VISION_MODEL);
  warm
    .load()
    .then(() => app.log.info({ model: warm.spec.id, ...warm.status() }, 'vision model ready'))
    .catch((err) => app.log.error({ err: err.message }, 'vision model unavailable: photo search degraded'));
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
