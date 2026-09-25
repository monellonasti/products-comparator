import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.ts';
import { config } from '../../config.ts';
import { storage, NotFoundError } from '../../storage/index.ts';
import { HttpError, requireUser } from '../auth.ts';
import { photoSearch, type PhotoSearchFilters } from '../../search/photo.ts';
import { productCards } from '../../search/catalog.ts';
import { parseBarcode, displayGtin } from '../../lib/gtin.ts';

const cropSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) })
  .refine((c) => c.x + c.width <= 1.0001 && c.y + c.height <= 1.0001, 'Ritaglio fuori dall’immagine');
const filtersSchema = z.object({
  supplierIds: z.array(z.guid()).max(50).optional(),
  brand: z.string().max(200).optional(),
  categoryId: z.guid().optional(),
  availableOnly: z.boolean().optional(),
});

async function readMultipart(request: FastifyRequest, maxBytes: number) {
  const fields: Record<string, string> = {};
  let file: { buffer: Buffer; filename: string } | null = null;
  for await (const part of request.parts({ limits: { fileSize: maxBytes } })) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      file = { buffer, filename: part.filename };
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }
  return { fields, file };
}

function parseJsonField<T>(value: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HttpError(400, 'Parametri non validi');
  }
  return parsed === null ? undefined : schema.parse(parsed);
}

export async function searchRoutes(app: FastifyInstance) {
  app.post('/search/photo', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const user = requireUser(request);
    const { fields, file } = await readMultipart(request, config.UPLOAD_MAX_IMAGE_BYTES);
    if (!file || !file.buffer.length) throw new HttpError(400, 'Nessuna immagine ricevuta');
    return photoSearch({
      userId: user.id,
      image: file.buffer,
      crop: parseJsonField(fields.crop, cropSchema) ?? null,
      filters: parseJsonField(fields.filters, filtersSchema) as PhotoSearchFilters | undefined,
      clientBarcode: fields.barcode ? z.string().regex(/^\d{6,14}$/).parse(fields.barcode) : null,
    });
  });

  // New crop on the same photo without uploading it again.
  app.post('/search/photo/:id/recrop', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const user = requireUser(request);
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const body = z.object({ crop: cropSchema.nullable(), filters: filtersSchema.optional() }).parse(request.body);
    const s = (await pool.query('SELECT * FROM photo_searches WHERE id = $1', [id])).rows[0];
    if (!s) throw new HttpError(404, 'Ricerca non trovata');
    if (s.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Ricerca di un altro utente');
    if (!s.image_key || s.image_deleted_at) throw new HttpError(410, 'La foto non è più disponibile (conservazione scaduta): caricala di nuovo');
    let image: Buffer;
    try {
      image = await storage().get(s.image_key);
    } catch (err) {
      if (err instanceof NotFoundError) throw new HttpError(410, 'La foto non è più disponibile: caricala di nuovo');
      throw err;
    }
    return photoSearch({ userId: user.id, image, crop: body.crop, filters: body.filters as PhotoSearchFilters | undefined, parentSearchId: id });
  });

  app.get('/search/photo/:id', async (request) => {
    const user = requireUser(request);
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const s = (await pool.query('SELECT * FROM photo_searches WHERE id = $1', [id])).rows[0];
    if (!s) throw new HttpError(404, 'Ricerca non trovata');
    if (s.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Ricerca di un altro utente');
    const stored = s.result.candidates ?? [];
    const cards = await productCards(stored.map((c: any) => c.productId));
    const feedback = (await pool.query('SELECT verdict, product_id, note, created_at FROM search_feedback WHERE photo_search_id = $1 ORDER BY created_at', [id])).rows;
    return {
      searchId: s.id,
      status: s.status,
      message: s.error,
      createdAt: s.created_at,
      imageAvailable: !!s.image_key && !s.image_deleted_at && s.image_expires_at > new Date(),
      imageExpiresAt: s.image_expires_at,
      barcode: s.barcode,
      candidates: stored
        .filter((c: any) => cards.get(c.productId))
        .map((c: any) => ({ product: cards.get(c.productId), group: c.group, score: c.score, matchedImageId: c.imageId, evidence: c.evidence })),
      abstained: s.result.abstained,
      coverage: s.result.coverage,
      model: s.result.model,
      timings: s.timings,
      feedback,
    };
  });

  app.get('/search/photo/:id/image', async (request, reply) => {
    const user = requireUser(request);
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const s = (await pool.query('SELECT user_id, image_key, image_deleted_at, image_expires_at FROM photo_searches WHERE id = $1', [id])).rows[0];
    if (!s) throw new HttpError(404, 'Ricerca non trovata');
    if (s.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Ricerca di un altro utente');
    if (!s.image_key || s.image_deleted_at || s.image_expires_at < new Date()) throw new HttpError(410, 'Foto non più disponibile');
    try {
      const bytes = await storage().get(s.image_key);
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=3600').send(bytes);
    } catch (err) {
      if (err instanceof NotFoundError) throw new HttpError(410, 'Foto non più disponibile');
      throw err;
    }
  });

  // Feedback is stored for evaluation/audit only: it never merges products nor retrains a model.
  app.post('/search/photo/:id/feedback', async (request) => {
    const user = requireUser(request);
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const body = z
      .object({
        verdict: z.enum(['correct', 'wrong', 'none_relevant', 'useful_alternative']),
        productId: z.guid().optional(),
        note: z.string().max(1000).optional(),
      })
      .parse(request.body);
    const s = (await pool.query('SELECT user_id FROM photo_searches WHERE id = $1', [id])).rows[0];
    if (!s) throw new HttpError(404, 'Ricerca non trovata');
    if (s.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Ricerca di un altro utente');
    await pool.query(`INSERT INTO search_feedback (photo_search_id, user_id, verdict, product_id, note) VALUES ($1, $2, $3, $4, $5)`, [
      id, user.id, body.verdict, body.productId ?? null, body.note ?? null,
    ]);
    return { ok: true };
  });

  app.get('/lookup/barcode/:code', async (request) => {
    requireUser(request);
    const { code } = z.object({ code: z.string().regex(/^\d{6,14}$/) }).parse(request.params);
    const parsed = parseBarcode(code);
    const ids = parsed.gtin14
      ? (
          await pool.query(
            `SELECT DISTINCT p.id FROM products p WHERE p.status = 'active' AND (p.id IN (SELECT product_id FROM product_identifiers WHERE value = $1)
               OR EXISTS (SELECT 1 FROM supplier_offers o WHERE o.product_id = p.id AND o.gtin = $1))`,
            [parsed.gtin14],
          )
        ).rows.map((r) => r.id)
      : (await pool.query(`SELECT DISTINCT product_id AS id FROM supplier_offers WHERE barcode_raw = $1`, [code])).rows.map((r) => r.id);
    const cards = await productCards(ids);
    return {
      barcode: { text: code, status: parsed.status, issue: parsed.issue, gtin: parsed.gtin14 ? displayGtin(parsed.gtin14) : null },
      products: [...cards.values()],
    };
  });
}
