import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../../db/pool.ts';
import { storage, NotFoundError } from '../../storage/index.ts';
import { HttpError, requireRole, requireUser } from '../auth.ts';
import { facets, invalidateFacets, listProducts, productDetail } from '../../search/catalog.ts';
import { detachOffer, mergeProducts, revertEvent, setOverrides } from '../../domain/associations.ts';
import { getActiveModel, indexCoverage } from '../../vision/index-admin.ts';
import { getEmbedder } from '../../vision/embedder.ts';
import { config } from '../../config.ts';

const csv = (s: string | undefined) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const uuid = z.guid();

export async function catalogRoutes(app: FastifyInstance) {
  app.get('/products', async (request) => {
    requireUser(request);
    const q = z
      .object({
        q: z.string().max(200).optional(),
        suppliers: z.string().max(2000).optional(),
        brand: z.string().max(200).optional(),
        category: uuid.optional(),
        priceMin: z.coerce.number().min(0).optional(),
        priceMax: z.coerce.number().min(0).optional(),
        availability: z.enum(['available', 'unavailable']).optional(),
        gtin: z.enum(['present', 'absent']).optional(),
        image: z.enum(['with', 'without']).optional(),
        withoutOffers: z.enum(['1']).optional(),
        sort: z.enum(['relevance', 'title', 'updated', 'price']).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(96).optional(),
      })
      .parse(request.query);
    const supplierIds = csv(q.suppliers);
    supplierIds?.forEach((id) => uuid.parse(id));
    return listProducts({
      q: q.q, supplierIds, brand: q.brand, categoryId: q.category, priceMin: q.priceMin, priceMax: q.priceMax, availability: q.availability,
      gtin: q.gtin, hasImage: q.image === 'with' ? true : q.image === 'without' ? false : undefined, includeWithoutOffers: q.withoutOffers === '1',
      sort: q.sort, offset: q.offset, limit: q.limit,
    });
  });

  // Operational state for the catalogue page (no technical details: counts and plain flags only).
  app.get('/catalog/status', async (request) => {
    requireUser(request);
    const [counts, active] = await Promise.all([
      pool.query(
        `SELECT (SELECT count(*) FROM products WHERE status = 'active' AND offer_count > 0)::int AS products,
                (SELECT count(*) FROM image_sources WHERE status = 'pending')::int AS images_downloading,
                (SELECT count(*) FROM import_runs WHERE status IN ('queued', 'running'))::int AS imports_running,
                (SELECT count(*) FROM suppliers WHERE active AND last_import_status = 'failed')::int AS suppliers_failed`,
      ),
      getActiveModel(pool),
    ]);
    const c = counts.rows[0];
    const coverage = active ? await indexCoverage(pool, active.key) : null;
    const vision = !config.VISION_ENABLED || !active ? 'disabled' : getEmbedder(active.spec.id).status().state;
    return {
      products: c.products,
      importsRunning: c.imports_running,
      suppliersWithFailedImport: c.suppliers_failed,
      imagesProcessing: c.images_downloading + (coverage?.pending ?? 0),
      photoSearch: vision === 'failed' || vision === 'disabled' ? 'unavailable' : vision === 'ready' ? 'ready' : 'starting',
    };
  });

  app.get('/catalog/facets', async (request) => {
    requireUser(request);
    return facets();
  });

  app.get('/products/:id', async (request) => {
    const user = requireUser(request);
    const { id } = z.object({ id: uuid }).parse(request.params);
    const detail = await productDetail(id, { isAdmin: user.role === 'admin' });
    if (!detail) throw new HttpError(404, 'Prodotto non trovato');
    return detail;
  });

  // Images are served through the API (private bucket + session check). Keys are content-addressed.
  app.get('/images/:id/:variant', async (request, reply) => {
    requireUser(request);
    const { id, variant } = z.object({ id: uuid, variant: z.enum(['thumb', 'display']) }).parse(request.params);
    const asset = (await pool.query('SELECT thumb_key, display_key FROM image_assets WHERE id = $1', [id])).rows[0];
    if (!asset) throw new HttpError(404, 'Immagine non trovata');
    try {
      const bytes = await storage().get(variant === 'thumb' ? asset.thumb_key : asset.display_key);
      return reply.header('content-type', 'image/webp').header('cache-control', 'private, max-age=604800, immutable').send(bytes);
    } catch (err) {
      if (err instanceof NotFoundError) throw new HttpError(404, 'Immagine non disponibile nello storage');
      throw err;
    }
  });

  app.patch('/products/:id/overrides', async (request) => {
    const user = requireRole(request, 'admin');
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z
      .object({
        title: z.string().max(500).nullable().optional(),
        brand: z.string().max(200).nullable().optional(),
        categoryId: uuid.nullable().optional(),
        primaryImageId: uuid.nullable().optional(),
        reason: z.string().max(1000).optional(),
      })
      .parse(request.body);
    const { reason, ...fields } = body;
    const eventId = await withTx((tx) => setOverrides(tx, id, fields, { kind: 'user', userId: user.id }, reason ?? null));
    invalidateFacets();
    return { eventId };
  });

  app.post('/products/:id/merge', async (request) => {
    const user = requireRole(request, 'admin');
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ sourceProductId: uuid, reason: z.string().max(2000).default(''), evidence: z.string().max(2000).optional() }).parse(request.body);
    const eventId = await withTx((tx) =>
      mergeProducts(tx, { targetId: id, sourceId: body.sourceProductId, actor: { kind: 'user', userId: user.id }, reason: body.reason, evidence: body.evidence }),
    );
    invalidateFacets();
    return { eventId };
  });

  app.post('/offers/:id/detach', async (request) => {
    const user = requireRole(request, 'admin');
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ reason: z.string().min(3).max(2000) }).parse(request.body);
    const result = await withTx((tx) => detachOffer(tx, id, { kind: 'user', userId: user.id }, body.reason));
    invalidateFacets();
    return result;
  });

  app.post('/audit/:id/revert', async (request) => {
    const user = requireRole(request, 'admin');
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const body = z.object({ reason: z.string().max(2000).optional() }).parse(request.body ?? {});
    const eventId = await withTx((tx) => revertEvent(tx, id, { kind: 'user', userId: user.id }, body.reason ?? null));
    invalidateFacets();
    return { eventId };
  });
}
