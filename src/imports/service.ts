// Import use-cases shared by the API and tests: upload -> inspect -> preview -> start/retry/cancel.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool, withTx, type Db } from '../db/pool.ts';
import { storage, keys } from '../storage/index.ts';
import { sha256 } from '../lib/hash.ts';
import { detectFileKind, parseImportFile, ImportFileError, type ParsedFile } from './parsers.ts';
import { guessMapping, mappedColumns, TARGET_FIELDS, type ColumnMapping, type ImportDefaults, type ParseOptions } from './fields.ts';
import { normalizeRow, type RowIssue } from './normalize.ts';
import { evaluatePrice } from '../domain/pricing.ts';
import { enqueue } from '../jobs/queue.ts';

export class ImportRequestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const parseOptionsSchema = z.object({
  delimiter: z.string().max(3).optional(),
  encoding: z.string().max(40).optional(),
  sheet: z.string().max(200).optional(),
  headerRow: z.coerce.number().int().min(1).max(50).optional(),
  decimalSeparator: z.enum(['.', ',']).optional(),
});

export const mappingSchema = z.object({
  fields: z.record(z.string(), z.union([z.string().max(300), z.array(z.string().max(300)).max(20)])),
  tiers: z.array(z.object({ column: z.string().max(300), minQty: z.number().int().positive() })).max(10).optional(),
});

export const defaultsSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  vatTreatment: z.enum(['net', 'gross', 'unknown']),
  vatRate: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/).nullable(),
  unitsPerPack: z.number().int().positive().nullable(),
  salesUnit: z.string().max(50).nullable(),
});

const SAMPLE_ROWS = 50;
const PREVIEW_ROWS = 200;

export interface InspectResult {
  run: ImportRunRow;
  headers: string[];
  sample: Array<{ rowNumber: number; values: Record<string, unknown> }>;
  detected: ParsedFile['detected'];
  warnings: string[];
  suggestedMapping: ColumnMapping;
  suggestedDefaults: ImportDefaults;
  profileId: string | null;
  duplicateOf: { id: string; createdAt: string; status: string } | null;
}

export interface ImportRunRow {
  id: string;
  supplier_id: string;
  status: string;
  file_name: string;
  file_kind: 'csv' | 'xlsx';
  parse_options: ParseOptions;
  [k: string]: unknown;
}

export async function createUploadRun(input: { supplierId: string; fileName: string; bytes: Buffer; userId: string | null }): Promise<InspectResult> {
  const supplier = (await pool.query('SELECT * FROM suppliers WHERE id = $1', [input.supplierId])).rows[0];
  if (!supplier) throw new ImportRequestError('Fornitore non trovato', 404);
  if (!input.bytes.length) throw new ImportRequestError('File vuoto');
  let kind: 'csv' | 'xlsx';
  try {
    kind = detectFileKind(input.fileName, input.bytes);
  } catch (err) {
    throw new ImportRequestError((err as Error).message);
  }
  const fileSha = sha256(input.bytes);
  const runId = randomUUID();
  const fileKey = keys.importFile(runId, fileSha);
  await storage().put(fileKey, input.bytes, kind === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv');
  const profile = (await pool.query(`SELECT * FROM import_profiles WHERE supplier_id = $1 AND name = 'default'`, [input.supplierId])).rows[0];
  const parseOptions: ParseOptions = profile?.file_kind === kind ? { ...profile.parse_options } : {};
  const duplicate = (
    await pool.query(
      `SELECT id, created_at, status FROM import_runs WHERE supplier_id = $1 AND file_sha256 = $2 AND status <> 'uploaded' ORDER BY created_at DESC LIMIT 1`,
      [input.supplierId, fileSha],
    )
  ).rows[0];
  const run = (
    await pool.query(
      `INSERT INTO import_runs (id, supplier_id, profile_id, status, file_name, file_kind, file_sha256, file_size, file_key, parse_options, as_of, created_by)
       VALUES ($1, $2, $3, 'uploaded', $4, $5, $6, $7, $8, $9::jsonb, now(), $10) RETURNING *`,
      [runId, input.supplierId, profile?.id ?? null, input.fileName.slice(0, 250), kind, fileSha, input.bytes.length, fileKey, JSON.stringify(parseOptions), input.userId],
    )
  ).rows[0];
  const inspected = await inspect(run, input.bytes, parseOptions);
  const profileMappingUsable = profile && mappedColumns(profile.mapping).every((c) => inspected.headers.includes(c));
  return {
    ...inspected,
    suggestedMapping: profileMappingUsable ? profile.mapping : guessMapping(inspected.headers),
    suggestedDefaults: profile?.defaults && Object.keys(profile.defaults).length ? profile.defaults : supplierDefaults(supplier),
    profileId: profile?.id ?? null,
    duplicateOf: duplicate ? { id: duplicate.id, createdAt: duplicate.created_at.toISOString(), status: duplicate.status } : null,
  };
}

function supplierDefaults(s: any): ImportDefaults {
  return {
    currency: s.default_currency,
    vatTreatment: s.default_vat_treatment,
    vatRate: s.default_vat_rate === null ? null : String(Number(s.default_vat_rate)),
    unitsPerPack: 1,
    salesUnit: null,
  };
}

async function inspect(run: ImportRunRow, bytes: Buffer, opts: ParseOptions) {
  let parsed: ParsedFile;
  try {
    parsed = await parseImportFile(run.file_kind, bytes, opts, SAMPLE_ROWS);
  } catch (err) {
    if (err instanceof ImportFileError) throw new ImportRequestError(err.message);
    throw err;
  }
  const merged: ParseOptions = {
    ...opts,
    delimiter: opts.delimiter ?? parsed.detected.delimiter,
    encoding: opts.encoding ?? parsed.detected.encoding,
    sheet: opts.sheet ?? parsed.detected.sheet,
    decimalSeparator: opts.decimalSeparator ?? parsed.detected.decimalSeparator,
  };
  await pool.query('UPDATE import_runs SET parse_options = $2::jsonb WHERE id = $1', [run.id, JSON.stringify(merged)]);
  return {
    run: { ...run, parse_options: merged },
    headers: parsed.headers,
    sample: parsed.rows.slice(0, SAMPLE_ROWS).map((r) => ({ rowNumber: r.rowNumber, values: r.values })),
    detected: parsed.detected,
    warnings: parsed.warnings,
  };
}

async function loadEditableRun(db: Db, runId: string) {
  const run = (await db.query('SELECT * FROM import_runs WHERE id = $1', [runId])).rows[0];
  if (!run) throw new ImportRequestError('Import non trovato', 404);
  if (run.status !== 'uploaded') throw new ImportRequestError('Import già avviato: non modificabile', 409);
  return run;
}

export async function reinspect(runId: string, opts: ParseOptions) {
  const run = await loadEditableRun(pool, runId);
  const bytes = await storage().get(run.file_key);
  const inspected = await inspect(run, bytes, opts);
  return { ...inspected, suggestedMapping: guessMapping(inspected.headers) };
}

export interface PreviewResult {
  totalSampled: number;
  rows: Array<{
    rowNumber: number;
    sku: string | null;
    barcode: { raw: string | null; status: string; display: string | null };
    title: string | null;
    brand: string | null;
    price: string | null;
    currency: string | null;
    unitPrice: string | null;
    priceNote: string | null;
    stock: { quantity: number | null; status: string; raw: string | null };
    images: number;
    existingOffer: boolean;
    gtinInCatalog: boolean;
    issues: RowIssue[];
  }>;
  summary: {
    errors: number;
    warnings: number;
    byCode: Array<{ code: string; severity: string; count: number; message: string }>;
    barcode: Record<string, number>;
    newOffers: number;
    updatedOffers: number;
    gtinMatches: number;
  };
}

export async function previewRun(runId: string, mapping: ColumnMapping, defaults: ImportDefaults, opts?: ParseOptions): Promise<PreviewResult> {
  const run = await loadEditableRun(pool, runId);
  validateMapping(mapping);
  const parseOptions: ParseOptions = { ...run.parse_options, ...(opts ?? {}) };
  const bytes = await storage().get(run.file_key);
  const parsed = await parseImportFile(run.file_kind, bytes, parseOptions, PREVIEW_ROWS);
  const missing = mappedColumns(mapping).filter((c) => !parsed.headers.includes(c));
  if (missing.length) throw new ImportRequestError(`Colonne non presenti nel file: ${missing.join(', ')}`);
  const sep = parseOptions.decimalSeparator ?? '.';
  const normalized = parsed.rows.map((r) => normalizeRow(r, mapping, defaults, sep));
  const skus = normalized.map((n) => n.sku).filter((s): s is string => !!s);
  const gtins = normalized.map((n) => n.offer?.barcode.gtin14).filter((g): g is string => !!g);
  const existingSkus = new Set(
    (await pool.query('SELECT supplier_sku FROM supplier_offers WHERE supplier_id = $1 AND supplier_sku = ANY($2::text[])', [run.supplier_id, skus])).rows.map((r) => r.supplier_sku),
  );
  const knownGtins = new Set(
    (await pool.query(`SELECT value FROM product_identifiers WHERE kind = 'gtin' AND value = ANY($1::text[])`, [gtins])).rows.map((r) => r.value),
  );
  const byCode = new Map<string, { code: string; severity: string; count: number; message: string }>();
  const barcode: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  for (const n of normalized) {
    if (n.issues.some((i) => i.severity === 'error')) errors++;
    else if (n.issues.length) warnings++;
    for (const i of n.issues) {
      const e = byCode.get(i.code) ?? { code: i.code, severity: i.severity, count: 0, message: i.message };
      e.count++;
      byCode.set(i.code, e);
    }
    const st = n.offer?.barcode.status ?? 'n/d';
    barcode[st] = (barcode[st] ?? 0) + 1;
  }
  await pool.query('UPDATE import_runs SET parse_options = $2::jsonb, mapping = $3::jsonb, defaults = $4::jsonb WHERE id = $1', [
    runId, JSON.stringify(parseOptions), JSON.stringify(mapping), JSON.stringify(defaults),
  ]);
  return {
    totalSampled: normalized.length,
    rows: normalized.slice(0, 100).map((n) => {
      const o = n.offer;
      const ev = o
        ? evaluatePrice({
            offerId: 'preview', supplierId: run.supplier_id, supplierPriority: 0, active: true, price: o.price, currency: o.currency,
            vatTreatment: o.vatTreatment, vatRate: o.vatRate, unitsPerPack: o.unitsPerPack, moq: o.moq, stockStatus: o.stockStatus, stockQuantity: o.stockQuantity,
          })
        : null;
      return {
        rowNumber: n.rowNumber,
        sku: n.sku,
        barcode: { raw: o?.barcode.raw ?? null, status: o?.barcode.status ?? 'n/d', display: o?.barcode.gtin14 ?? null },
        title: o?.title ?? null,
        brand: o?.brand ?? null,
        price: o?.price ?? null,
        currency: o?.currency ?? null,
        unitPrice: ev?.netUnitPrice ?? null,
        priceNote: ev && !ev.comparable ? ev.reasons.join(',') : null,
        stock: { quantity: o?.stockQuantity ?? null, status: o?.stockStatus ?? 'unknown', raw: o?.availabilityRaw ?? null },
        images: o?.imageUrls.length ?? 0,
        existingOffer: !!n.sku && existingSkus.has(n.sku),
        gtinInCatalog: !!o?.barcode.gtin14 && knownGtins.has(o.barcode.gtin14),
        issues: n.issues,
      };
    }),
    summary: {
      errors,
      warnings,
      byCode: [...byCode.values()].sort((a, b) => b.count - a.count),
      barcode,
      newOffers: normalized.filter((n) => n.sku && !existingSkus.has(n.sku)).length,
      updatedOffers: normalized.filter((n) => n.sku && existingSkus.has(n.sku)).length,
      gtinMatches: normalized.filter((n) => n.offer?.barcode.gtin14 && knownGtins.has(n.offer.barcode.gtin14)).length,
    },
  };
}

function validateMapping(mapping: ColumnMapping) {
  const allowed = new Set<string>(TARGET_FIELDS.map((f) => f.key));
  for (const k of Object.keys(mapping.fields)) if (!allowed.has(k)) throw new ImportRequestError(`Campo di destinazione sconosciuto: ${k}`);
  if (!mapping.fields.sku) throw new ImportRequestError('Mappare la colonna del codice fornitore (SKU): è la chiave di aggiornamento');
}

export async function startRun(
  runId: string,
  input: { mapping: ColumnMapping; defaults: ImportDefaults; parseOptions?: ParseOptions; mode: 'snapshot' | 'delta'; asOf?: Date | null; saveProfile: boolean },
) {
  validateMapping(input.mapping);
  return withTx(async (tx) => {
    const run = (await tx.query('SELECT * FROM import_runs WHERE id = $1 FOR UPDATE', [runId])).rows[0];
    if (!run) throw new ImportRequestError('Import non trovato', 404);
    if (run.status !== 'uploaded') throw new ImportRequestError('Import già avviato', 409);
    const active = (await tx.query(`SELECT id FROM import_runs WHERE supplier_id = $1 AND status IN ('queued', 'running')`, [run.supplier_id])).rows[0];
    if (active) throw new ImportRequestError('C’è già un import in corso per questo fornitore: attendere la fine', 409);
    const parseOptions = { ...run.parse_options, ...(input.parseOptions ?? {}) };
    const asOf = input.asOf ?? new Date();
    if (asOf.getTime() > Date.now() + 5 * 60_000) throw new ImportRequestError('La data dei dati non può essere nel futuro');
    let profileId = run.profile_id;
    if (input.saveProfile) {
      profileId = (
        await tx.query(
          `INSERT INTO import_profiles (supplier_id, name, file_kind, parse_options, mapping, defaults)
           VALUES ($1, 'default', $2, $3::jsonb, $4::jsonb, $5::jsonb)
           ON CONFLICT (supplier_id, name) DO UPDATE SET file_kind = EXCLUDED.file_kind, parse_options = EXCLUDED.parse_options,
             mapping = EXCLUDED.mapping, defaults = EXCLUDED.defaults, updated_at = now()
           RETURNING id`,
          [run.supplier_id, run.file_kind, JSON.stringify(parseOptions), JSON.stringify(input.mapping), JSON.stringify(input.defaults)],
        )
      ).rows[0].id;
    }
    const updated = (
      await tx.query(
        `UPDATE import_runs SET status = 'queued', queued_at = now(), mode = $2, as_of = $3, mapping = $4::jsonb, defaults = $5::jsonb,
                parse_options = $6::jsonb, profile_id = $7
          WHERE id = $1 RETURNING *`,
        [runId, input.mode, asOf, JSON.stringify(input.mapping), JSON.stringify(input.defaults), JSON.stringify(parseOptions), profileId],
      )
    ).rows[0];
    await enqueue(tx, 'import_run', { runId }, { queueName: `import:${run.supplier_id}`, jobKey: `import_run:${runId}`, maxAttempts: 3 });
    return updated;
  });
}

export async function retryRun(runId: string) {
  return withTx(async (tx) => {
    const run = (await tx.query('SELECT * FROM import_runs WHERE id = $1 FOR UPDATE', [runId])).rows[0];
    if (!run) throw new ImportRequestError('Import non trovato', 404);
    const stuck = run.status === 'running' && run.heartbeat_at && Date.now() - run.heartbeat_at.getTime() > 15 * 60_000;
    if (run.status !== 'failed' && !stuck) throw new ImportRequestError('Si possono riprovare solo import falliti o bloccati', 409);
    const other = (await tx.query(`SELECT id FROM import_runs WHERE supplier_id = $1 AND status IN ('queued', 'running') AND id <> $2`, [run.supplier_id, runId])).rows[0];
    if (other) throw new ImportRequestError('C’è già un altro import attivo per questo fornitore', 409);
    await tx.query(`UPDATE import_runs SET status = 'queued', queued_at = now(), error = NULL, finished_at = NULL WHERE id = $1`, [runId]);
    await enqueue(tx, 'import_run', { runId }, { queueName: `import:${run.supplier_id}`, jobKey: `import_run:${runId}`, maxAttempts: 3 });
  });
}

export async function cancelRun(runId: string) {
  const res = await pool.query(
    `UPDATE import_runs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status IN ('uploaded', 'queued', 'failed') RETURNING id`,
    [runId],
  );
  if (!res.rowCount) throw new ImportRequestError('Import non annullabile nello stato attuale (in esecuzione o concluso)', 409);
}
