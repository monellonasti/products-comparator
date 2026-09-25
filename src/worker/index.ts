// Worker process: imports, image downloads, embeddings, suggestions, maintenance.
process.env.APP_ROLE ??= 'comparator-worker';
import { run, parseCrontab } from 'graphile-worker';
import { config } from '../config.ts';
import { migrate } from '../db/migrate.ts';
import { pool } from '../db/pool.ts';
import { ensureModel } from '../vision/index-admin.ts';
import { getModelSpec } from '../vision/models.ts';
import { storage } from '../storage/index.ts';
import { taskList } from './tasks.ts';

await migrate(config.DATABASE_URL, (m) => console.log(JSON.stringify({ level: 'info', msg: m })));
await ensureModel(pool, getModelSpec(config.VISION_MODEL), { activateIfNoneActive: true });
await storage().check(config.NODE_ENV !== 'production');

const runner = await run({
  connectionString: config.DATABASE_URL,
  concurrency: config.WORKER_CONCURRENCY,
  noHandleSignals: false,
  pollInterval: 2000,
  taskList,
  // Hourly housekeeping; `fill` is 0 so missed runs are not replayed after downtime.
  parsedCronItems: parseCrontab('15 * * * * maintenance ?max=1'),
});

console.log(JSON.stringify({ level: 'info', msg: 'worker started', concurrency: config.WORKER_CONCURRENCY, model: config.VISION_MODEL }));
await runner.promise;
await pool.end();
