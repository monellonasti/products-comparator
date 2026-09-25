import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.ts';
import { config } from '../../config.ts';
import { HttpError, requireRole, requireUser } from '../auth.ts';
import {
  cancelRun, createUploadRun, defaultsSchema, mappingSchema, parseOptionsSchema, previewRun, reinspect, retryRun, startRun,
} from '../../imports/service.ts';
import { TARGET_FIELDS, type ColumnMapping } from '../../imports/fields.ts';
import { invalidateFacets } from '../../search/catalog.ts';

function runToApi(r: any) {
  return {
    id: r.id, supplierId: r.supplier_id, supplierName: r.supplier_name, status: r.status, mode: r.mode, fileName: r.file_name, fileKind: r.file_kind,
    fileSize: r.file_size, fileSha256: r.file_sha256, asOf: r.as_of, counters: r.counters, stagedRows: r.staged_rows, checkpointRow: r.checkpoint_row,
    attempts: r.attempts, error: r.error, snapshotResult: r.snapshot_result, createdAt: r.created_at, queuedAt: r.queued_at, startedAt: r.started_at,
    finishedAt: r.finished_at, heartbeatAt: r.heartbeat_at, createdBy: r.created_by_name ?? null, mapping: r.mapping, defaults: r.defaults,
    parseOptions: r.parse_options,
  };
}

/** CSV cell escaping that also neutralises spreadsheet formula injection. */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function importRoutes(app: FastifyInstance) {
  app.get('/imports/fields', async (request) => {
    requireUser(request);
    return { fields: TARGET_FIELDS };
  });

  app.post('/imports', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const user = requireRole(request, 'admin');
    let supplierId: string | null = null;
    let file: { buffer: Buffer; filename: string } | null = null;
    for await (const part of request.parts({ limits: { fileSize: config.UPLOAD_MAX_IMPORT_BYTES } })) {
      if (part.type === 'file') file = { buffer: await part.toBuffer(), filename: part.filename };
      else if (part.fieldname === 'supplierId') supplierId = String(part.value);
    }
    if (!supplierId || !z.guid().safeParse(supplierId).success) throw new HttpError(400, 'Selezionare un fornitore');
    if (!file) throw new HttpError(400, 'Nessun file ricevuto');
    const result = await createUploadRun({ supplierId, fileName: file.filename, bytes: file.buffer, userId: user.id });
    return { ...result, run: runToApi(result.run) };
  });

  app.post('/imports/:id/inspect', async (request) => {
    requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const opts = parseOptionsSchema.parse(request.body ?? {});
    const result = await reinspect(id, opts);
    return { ...result, run: runToApi(result.run) };
  });

  app.post('/imports/:id/preview', async (request) => {
    requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const b = z.object({ mapping: mappingSchema, defaults: defaultsSchema, parseOptions: parseOptionsSchema.optional() }).parse(request.body);
    return previewRun(id, b.mapping as ColumnMapping, b.defaults, b.parseOptions);
  });

  app.post('/imports/:id/start', async (request) => {
    requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const b = z
      .object({
        mapping: mappingSchema,
        defaults: defaultsSchema,
        parseOptions: parseOptionsSchema.optional(),
        mode: z.enum(['snapshot', 'delta']),
        asOf: z.string().datetime({ offset: true }).nullable().optional(),
        saveProfile: z.boolean().default(true),
      })
      .parse(request.body);
    const run = await startRun(id, { ...b, mapping: b.mapping as ColumnMapping, asOf: b.asOf ? new Date(b.asOf) : null });
    return { run: runToApi(run) };
  });

  app.post('/imports/:id/retry', async (request) => {
    requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    await retryRun(id);
    return { ok: true };
  });

  app.post('/imports/:id/cancel', async (request) => {
    requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    await cancelRun(id);
    invalidateFacets();
    return { ok: true };
  });

  app.get('/imports', async (request) => {
    requireUser(request);
    const q = z
      .object({ supplier: z.guid().optional(), status: z.string().max(20).optional(), offset: z.coerce.number().int().min(0).default(0) })
      .parse(request.query);
    const params: unknown[] = [];
    const where: string[] = [`r.status <> 'uploaded' OR r.created_at > now() - interval '1 day'`];
    if (q.supplier) {
      params.push(q.supplier);
      where.push(`r.supplier_id = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`r.status = $${params.length}`);
    }
    const rows = (
      await pool.query(
        `SELECT r.*, s.name AS supplier_name, u.display_name AS created_by_name FROM import_runs r
           JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN users u ON u.id = r.created_by
          WHERE ${where.map((w) => `(${w})`).join(' AND ')} ORDER BY r.created_at DESC LIMIT 50 OFFSET ${q.offset}`,
        params,
      )
    ).rows;
    return { items: rows.map(runToApi) };
  });

  app.get('/imports/:id', async (request) => {
    requireUser(request);
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const r = (
      await pool.query(
        `SELECT r.*, s.name AS supplier_name, u.display_name AS created_by_name FROM import_runs r
           JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN users u ON u.id = r.created_by WHERE r.id = $1`,
        [id],
      )
    ).rows[0];
    if (!r) throw new HttpError(404, 'Import non trovato');
    const issueSummary = (
      await pool.query(
        `SELECT severity, code, min(message) AS message, count(*)::int AS count FROM import_row_issues WHERE import_run_id = $1
          GROUP BY severity, code ORDER BY severity, count(*) DESC`,
        [id],
      )
    ).rows;
    const images = (
      await pool.query(
        `SELECT count(*) FILTER (WHERE src.status = 'pending')::int AS pending, count(*) FILTER (WHERE src.status = 'fetched')::int AS fetched,
                count(*) FILTER (WHERE src.status IN ('failed', 'blocked'))::int AS failed
           FROM image_sources src WHERE src.supplier_id = $1 AND src.id IN (
             SELECT oi.image_source_id FROM offer_images oi JOIN supplier_offers o ON o.id = oi.offer_id WHERE o.last_import_id = $2)`,
        [r.supplier_id, id],
      )
    ).rows[0];
    return { run: runToApi(r), issueSummary, images };
  });

  app.get('/imports/:id/issues', async (request) => {
    requireUser(request);
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const q = z
      .object({ severity: z.enum(['error', 'warning']).optional(), code: z.string().max(80).optional(), offset: z.coerce.number().int().min(0).default(0) })
      .parse(request.query);
    const params: unknown[] = [id];
    let where = 'import_run_id = $1';
    if (q.severity) {
      params.push(q.severity);
      where += ` AND severity = $${params.length}`;
    }
    if (q.code) {
      params.push(q.code);
      where += ` AND code = $${params.length}`;
    }
    const rows = (await pool.query(`SELECT row_number, severity, field, code, message, value FROM import_row_issues WHERE ${where} ORDER BY row_number, id LIMIT 200 OFFSET ${q.offset}`, params)).rows;
    const total = (await pool.query(`SELECT count(*)::int AS n FROM import_row_issues WHERE ${where}`, params)).rows[0].n;
    return { items: rows, total };
  });

  app.get('/imports/:id/issues.csv', async (request, reply) => {
    requireUser(request);
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const rows = (await pool.query(`SELECT row_number, severity, field, code, message, value FROM import_row_issues WHERE import_run_id = $1 ORDER BY row_number, id`, [id])).rows;
    const lines = ['riga;gravita;campo;codice;messaggio;valore', ...rows.map((r) => [r.row_number, r.severity, r.field, r.code, r.message, r.value].map(csvCell).join(';'))];
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="import-${id.slice(0, 8)}-problemi.csv"`)
      .send(`﻿${lines.join('\r\n')}\r\n`);
  });
}
