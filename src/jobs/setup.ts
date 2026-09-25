// graphile-worker keeps its own schema (graphile_worker.*). Installing it is idempotent; both the API
// (which enqueues) and the worker call this at startup.
import { runMigrations } from 'graphile-worker';

export async function ensureWorkerSchema(connectionString: string): Promise<void> {
  await runMigrations({ connectionString });
}
