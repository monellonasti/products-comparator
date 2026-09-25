// CLI for a controlled model switch (docs/VISUAL_SEARCH.md):
//   pnpm model:prepare -- --model clip-vit-b32            register model + HNSW index, queue embeddings of all images
//   pnpm model:prepare -- --model clip-vit-b32 --activate  make it the active model (only when coverage is complete, or --force)
import { parseArgs } from 'node:util';
import { pool, withTx } from '../db/pool.ts';
import { ensureModel, indexCoverage } from '../vision/index-admin.ts';
import { getModelSpec, modelKey } from '../vision/models.ts';
import { ensureWorkerSchema } from '../jobs/setup.ts';
import { enqueue } from '../jobs/queue.ts';
import { config } from '../config.ts';

const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== '--'), options: { model: { type: 'string' }, activate: { type: 'boolean', default: false }, force: { type: 'boolean', default: false } } });
if (!values.model) {
  console.error('Uso: pnpm model:prepare -- --model <id> [--activate] [--force]');
  process.exit(1);
}
const spec = getModelSpec(values.model);
await ensureWorkerSchema(config.DATABASE_URL);
const key = await ensureModel(pool, spec, { activateIfNoneActive: false });
const cov = await indexCoverage(pool, key);
console.log(`modello ${key}: ${cov.indexed}/${cov.assets} immagini indicizzate, ${cov.failed} fallite`);
if (!values.activate) {
  await enqueue(pool, 'reindex_model', { modelKey: key }, { jobKey: `reindex:${key}`, maxAttempts: 3 });
  console.log('reindicizzazione accodata: il worker calcola i vettori mancanti. Rilanciare con --activate a copertura completa.');
} else {
  if (cov.pending > 0 && !values.force) {
    console.error(`copertura incompleta (${cov.pending} immagini mancanti): usare --force per attivare comunque`);
    process.exit(1);
  }
  await withTx(async (tx) => {
    await tx.query(`UPDATE embedding_models SET status = 'retired' WHERE status = 'active' AND key <> $1`, [key]);
    await tx.query(`UPDATE embedding_models SET status = 'active', activated_at = now() WHERE key = $1`, [key]);
  });
  console.log(`modello attivo: ${key}. Impostare VISION_MODEL=${spec.id} e riavviare API e worker.`);
}
void modelKey;
await pool.end();
