// Shared helpers for integration/e2e tests. They WIPE the target database: never point them at real data.
import { pool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { ensureWorkerSchema } from '../src/jobs/setup.ts';
import { createUploadRun, startRun } from '../src/imports/service.ts';
import { runImport } from '../src/imports/pipeline.ts';
import type { ColumnMapping, ImportDefaults } from '../src/imports/fields.ts';

let migrated = false;

export async function resetDatabase() {
  const url = process.env.DATABASE_URL!;
  if (!/_test\b|test/.test(url)) throw new Error(`Refusing to wipe a non-test database: ${url}`);
  if (!migrated) {
    await migrate(url, () => {});
    await ensureWorkerSchema(url);
    migrated = true;
  }
  const tables = (
    await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations')`)
  ).rows.map((r) => `public."${r.tablename}"`);
  await pool.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM graphile_worker._private_jobs`);
}

export async function createSupplier(code: string, over: Record<string, unknown> = {}) {
  const res = await pool.query(
    `INSERT INTO suppliers (code, name, priority, default_currency, default_vat_treatment, stale_after_hours)
     VALUES ($1, $2, $3, 'EUR', 'net', 168) RETURNING *`,
    [code, over.name ?? `Fornitore ${code}`, over.priority ?? 100],
  );
  return res.rows[0];
}

export const defaultsNet: ImportDefaults = { currency: 'EUR', vatTreatment: 'net', vatRate: null, unitsPerPack: 1, salesUnit: null };

export function csv(rows: Array<Record<string, string | number | null>>, delimiter = ';'): Buffer {
  const headers = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Buffer.from([headers.join(delimiter), ...rows.map((r) => headers.map((h) => esc(r[h])).join(delimiter))].join('\n') + '\n', 'utf8');
}

export const standardMapping: ColumnMapping = {
  fields: {
    sku: 'SKU', barcode: 'EAN', title: 'Titolo', brand: 'Marca', price: 'Prezzo', stock_quantity: 'Giacenza',
    availability: 'Disponibilita', units_per_pack: 'PezziConf', color: 'Colore', image_urls: ['Immagine'],
  },
};

export async function importCsv(opts: {
  supplierId: string;
  rows: Array<Record<string, string | number | null>>;
  mode?: 'snapshot' | 'delta';
  asOf?: Date;
  mapping?: ColumnMapping;
  defaults?: ImportDefaults;
  run?: boolean;
}) {
  const up = await createUploadRun({ supplierId: opts.supplierId, fileName: 'listino.csv', bytes: csv(opts.rows), userId: null });
  await startRun(up.run.id, {
    mapping: opts.mapping ?? standardMapping,
    defaults: opts.defaults ?? defaultsNet,
    parseOptions: { decimalSeparator: '.' },
    mode: opts.mode ?? 'delta',
    asOf: opts.asOf ?? null,
    saveProfile: false,
  });
  if (opts.run !== false) {
    const outcome = await runImport(up.run.id);
    if (outcome !== 'done') throw new Error(`import outcome ${outcome}`);
  }
  return (await pool.query('SELECT * FROM import_runs WHERE id = $1', [up.run.id])).rows[0];
}

export function row(over: Partial<Record<string, string | number | null>>): Record<string, string | number | null> {
  return {
    SKU: 'X', EAN: '', Titolo: 'Prodotto', Marca: '', Prezzo: '10', Giacenza: '', Disponibilita: '', PezziConf: '', Colore: '', Immagine: '',
    ...over,
  };
}
