// Import run lifecycle: stage (parse whole file into import_staging_rows) -> apply in checkpointed
// batches -> finalize (snapshot deactivation, supplier status, follow-up jobs).
// Safe to run twice for the same run: a session advisory lock guarantees a single executor, and
// every batch commits its checkpoint atomically with its data.
import pg from 'pg';
import { config } from '../config.ts';
import { pool, withTx, type Tx } from '../db/pool.ts';
import { storage } from '../storage/index.ts';
import { parseImportFile, ImportFileError, type ParsedRow } from './parsers.ts';
import { applyBatch, type Counters } from './apply.ts';
import type { ColumnMapping, ImportDefaults, ParseOptions } from './fields.ts';
import { refreshProducts } from '../domain/canonical.ts';
import { recordAudit } from '../domain/audit.ts';
import { enqueue } from '../jobs/queue.ts';
import { insertChanges } from '../domain/changes.ts';

export const BATCH_SIZE = 500;
const STAGE_CHUNK = 1000;
/** Snapshot safety: the file must contain at least this share of the currently active offers. */
export const SNAPSHOT_MIN_COVERAGE = 0.5;

export class PermanentImportError extends Error {}

type Logger = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
const noop: Logger = { info() {}, warn() {}, error() {} };

export async function runImport(runId: string, log: Logger = noop): Promise<'done' | 'busy' | 'skipped'> {
  const lockClient = new pg.Client({ connectionString: config.DATABASE_URL });
  await lockClient.connect();
  try {
    const got = (await lockClient.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [`import:${runId}`])).rows[0].ok;
    if (!got) return 'busy';
    // Conditional transition: a cancel that lands between a read and this update must not be overwritten.
    const run = (
      await pool.query(
        `UPDATE import_runs SET status = 'running', started_at = coalesce(started_at, now()), attempts = attempts + 1,
                heartbeat_at = now(), error = NULL
          WHERE id = $1 AND status IN ('queued', 'running', 'failed') RETURNING *`,
        [runId],
      )
    ).rows[0];
    if (!run) return 'skipped';
    try {
      await stage(runId, log);
      await applyAll(runId, log);
      await finalize(runId, log);
      await pool.query('DELETE FROM import_staging_rows WHERE import_run_id = $1', [runId]);
      return 'done';
    } catch (err) {
      // A PostgreSQL data exception (class 22: a value the column cannot hold, an invalid encoding) fails
      // the same way on every retry: report it instead of retrying the same batch forever.
      const dataError = typeof (err as { code?: unknown })?.code === 'string' && (err as { code: string }).code.startsWith('22');
      const raw = err instanceof Error ? err.message : String(err);
      const message = dataError ? `Dato non memorizzabile nel database (${raw}): correggere il file e ricaricarlo` : raw;
      const failed = await pool.query(
        `UPDATE import_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'running'`,
        [runId, message.slice(0, 2000)],
      );
      if (failed.rowCount) {
        await pool.query(
          `UPDATE suppliers SET last_import_status = 'failed', last_import_finished_at = now(), updated_at = now() WHERE id = $1`,
          [run.supplier_id],
        );
      }
      log.error({ runId, err: message }, 'import failed');
      if (err instanceof PermanentImportError || err instanceof ImportFileError || dataError || !failed.rowCount) return 'done';
      throw err; // transient: graphile-worker retries with backoff and the run resumes from its checkpoint
    }
  } finally {
    await lockClient.end().catch(() => {});
  }
}

async function stage(runId: string, log: Logger) {
  const run = (await pool.query('SELECT * FROM import_runs WHERE id = $1', [runId])).rows[0];
  if (run.staged_rows !== null) return;
  const bytes = await storage().get(run.file_key);
  const parsed = await parseImportFile(run.file_kind, bytes, run.parse_options as ParseOptions);
  if (parsed.rows.length > config.IMPORT_MAX_ROWS) {
    throw new PermanentImportError(`Il file contiene ${parsed.rows.length} righe: limite ${config.IMPORT_MAX_ROWS}`);
  }
  const mapping = run.mapping as ColumnMapping;
  const missing = Object.entries(mapping.fields)
    .flatMap(([, v]) => (Array.isArray(v) ? v : v ? [v] : []))
    .concat((mapping.tiers ?? []).map((t) => t.column))
    .filter((col) => !parsed.headers.includes(col));
  if (missing.length) throw new PermanentImportError(`Colonne mappate assenti nel file: ${missing.join(', ')}`);

  await withTx(async (tx) => {
    await tx.query('DELETE FROM import_staging_rows WHERE import_run_id = $1', [runId]);
    for (let i = 0; i < parsed.rows.length; i += STAGE_CHUNK) {
      const chunk = parsed.rows.slice(i, i + STAGE_CHUNK);
      await tx.query(
        `INSERT INTO import_staging_rows (import_run_id, row_number, raw)
         SELECT $1::uuid, x.rn, x.raw FROM unnest($2::int[], $3::jsonb[]) AS x(rn, raw)`,
        [runId, chunk.map((r) => r.rowNumber), chunk.map((r) => JSON.stringify({ values: r.values, numeric: r.numeric, formula: r.formula, links: r.links }))],
      );
    }
    const activeBefore = (await tx.query('SELECT count(*)::int AS n FROM supplier_offers WHERE supplier_id = $1 AND active', [run.supplier_id])).rows[0].n;
    await tx.query(
      `UPDATE import_runs SET staged_rows = $2, counters = counters || $3::jsonb, heartbeat_at = now() WHERE id = $1`,
      [runId, parsed.rows.length, JSON.stringify({ rows_total: parsed.rows.length, active_before: activeBefore })],
    );
    for (const w of parsed.warnings) {
      await tx.query(
        `INSERT INTO import_row_issues (import_run_id, row_number, severity, field, code, message) VALUES ($1, 0, 'warning', NULL, 'file_warning', $2)
         ON CONFLICT DO NOTHING`,
        [runId, w],
      );
    }
  });
  log.info({ runId, rows: parsed.rows.length }, 'import staged');
}

async function applyAll(runId: string, log: Logger) {
  for (;;) {
    const done = await withTx(async (tx) => {
      const run = (await tx.query('SELECT * FROM import_runs WHERE id = $1 FOR UPDATE', [runId])).rows[0];
      if (run.status === 'cancelled') throw new PermanentImportError('Import annullato');
      const staged = (
        await tx.query(
          `SELECT row_number, raw FROM import_staging_rows WHERE import_run_id = $1 AND row_number > $2 ORDER BY row_number LIMIT $3`,
          [runId, run.checkpoint_row, BATCH_SIZE],
        )
      ).rows;
      if (!staged.length) return true;
      const rows: ParsedRow[] = staged.map((s) => ({ rowNumber: s.row_number, values: s.raw.values, numeric: s.raw.numeric, formula: s.raw.formula, links: s.raw.links }));
      const defaults = run.defaults as ImportDefaults;
      const result = await applyBatch(tx, {
        runId,
        supplierId: run.supplier_id,
        asOf: run.as_of,
        mapping: run.mapping,
        defaults,
        decimalSeparator: (run.parse_options as ParseOptions).decimalSeparator ?? '.',
        recordNewOffers: (run.counters.active_before ?? 0) > 0,
      }, rows);
      await insertIssues(tx, runId, result.issues);
      const merged = mergeCounters(run.counters, result.counters);
      await tx.query(
        `UPDATE import_runs SET checkpoint_row = $2, counters = $3::jsonb, heartbeat_at = now() WHERE id = $1`,
        [runId, staged[staged.length - 1].row_number, JSON.stringify(merged)],
      );
      return false;
    });
    if (done) return;
    log.info({ runId }, 'import batch applied');
  }
}

async function insertIssues(tx: Tx, runId: string, issues: Array<{ rowNumber: number; severity: string; field: string | null; code: string; message: string; value?: string | null }>) {
  for (let i = 0; i < issues.length; i += 1000) {
    const c = issues.slice(i, i + 1000);
    await tx.query(
      `INSERT INTO import_row_issues (import_run_id, row_number, severity, field, code, message, value)
       SELECT $1::uuid, * FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
       ON CONFLICT DO NOTHING`,
      [runId, c.map((x) => x.rowNumber), c.map((x) => x.severity), c.map((x) => x.field), c.map((x) => x.code), c.map((x) => x.message), c.map((x) => x.value ?? null)],
    );
  }
}

export function mergeCounters(a: Counters, b: Counters): Counters {
  const out: Counters = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

async function finalize(runId: string, log: Logger) {
  await withTx(async (tx) => {
    const run = (await tx.query('SELECT * FROM import_runs WHERE id = $1 FOR UPDATE', [runId])).rows[0];
    const supplier = (await tx.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [run.supplier_id])).rows[0];
    const counters: Counters = run.counters;
    let snapshotResult: string | null = null;
    if (run.mode === 'snapshot') {
      const keyErrors = (
        await tx.query(
          `SELECT count(*)::int AS n FROM import_row_issues WHERE import_run_id = $1 AND code IN ('missing_sku', 'sku_precision_lost')`,
          [runId],
        )
      ).rows[0].n;
      const withSku = counters.rows_with_sku ?? 0;
      const activeBefore = counters.active_before ?? 0;
      if (keyErrors > 0) {
        snapshotResult = `Disattivazione non eseguita: ${keyErrors} righe senza SKU leggibile (non si può sapere quali prodotti mancano)`;
      } else if (supplier.last_snapshot_as_of && run.as_of < supplier.last_snapshot_as_of) {
        snapshotResult = 'Disattivazione non eseguita: il file è più vecchio dell’ultimo snapshot applicato';
      } else if (activeBefore > 0 && withSku < activeBefore * SNAPSHOT_MIN_COVERAGE) {
        snapshotResult = `Disattivazione non eseguita: il file contiene ${withSku} codici contro ${activeBefore} offerte attive (possibile file parziale)`;
      } else {
        const deactivated = (
          await tx.query(
            // Offers with data newer than this snapshot (a later delta) are kept. The snapshot date is recorded
            // so an older delta imported afterwards cannot bring the offer back.
            `UPDATE supplier_offers SET active = false, deactivated_at = now(), deactivated_reason = 'assente_dallo_snapshot', updated_at = now(),
                    source_as_of = GREATEST(source_as_of, $3)
              WHERE supplier_id = $1 AND active AND last_import_id IS DISTINCT FROM $2 AND source_as_of <= $3
              RETURNING id, product_id, price::text AS price, currency, stock_status, stock_quantity`,
            [run.supplier_id, runId, run.as_of],
          )
        ).rows;
        counters.offers_deactivated = deactivated.length;
        if (deactivated.length) {
          await insertChanges(
            tx, runId, run.supplier_id,
            deactivated.map((d) => ({
              offerId: d.id, productId: d.product_id, type: 'removed' as const, newValue: null, pct: null,
              oldValue: { price: d.price, currency: d.currency, stockStatus: d.stock_status, stockQuantity: d.stock_quantity },
            })),
          );
          counters.changes_removed = deactivated.length;
          await recordAudit(tx, {
            actor: { kind: 'import' }, action: 'import.snapshot_deactivation', entityType: 'import_run', entityId: runId,
            data: { offerIds: deactivated.map((d) => d.id) },
          });
          await refreshProducts(tx, deactivated.map((d) => d.product_id));
        }
        snapshotResult = `Snapshot applicato: ${deactivated.length} offerte non più presenti marcate inattive`;
      }
    }
    await tx.query(
      `UPDATE import_runs SET status = 'succeeded', finished_at = now(), counters = $2::jsonb, snapshot_result = $3, heartbeat_at = now() WHERE id = $1`,
      [runId, JSON.stringify(counters), snapshotResult],
    );
    await tx.query(
      `UPDATE suppliers SET last_import_status = 'succeeded', last_import_finished_at = now(),
              last_success_as_of = GREATEST(coalesce(last_success_as_of, $2), $2),
              last_snapshot_as_of = CASE WHEN $3 THEN GREATEST(coalesce(last_snapshot_as_of, $2), $2) ELSE last_snapshot_as_of END,
              updated_at = now()
        WHERE id = $1`,
      [run.supplier_id, run.as_of, run.mode === 'snapshot'],
    );
    await enqueue(tx, 'suggest_matches', { supplierId: run.supplier_id, importRunId: runId }, { jobKey: `suggest:${runId}`, maxAttempts: 3 });
    // Pictures replaced by the supplier at the same URL (reported as 'image_replaced' changes of this run).
    await enqueue(tx, 'images_recheck', { supplierId: run.supplier_id, runId }, { jobKey: `images_recheck:${run.supplier_id}`, maxAttempts: 3 });
    log.info({ runId, counters, snapshotResult }, 'import finalized');
  });
}
