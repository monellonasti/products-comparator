// Photo search pipeline (docs/VISUAL_SEARCH.md):
// validate -> auto-orient/crop -> same "infer" preprocessing as the catalogue -> embedding (active model)
// -> HNSW top-K images with oversampling + iterative scan -> group by canonical product (best image kept)
// -> structured filters -> classification with thresholds (similarity is NOT a probability) or abstention.
// A barcode read in the photo is extra evidence only after GTIN validation and a catalogue match.
import { randomUUID } from 'node:crypto';
import { pool, vectorLiteral } from '../db/pool.ts';
import { config } from '../config.ts';
import { storage, keys } from '../storage/index.ts';
import { makeInferImage, makeQueryDisplay, validateImage, type Crop } from '../vision/preprocess.ts';
import { getEmbedder, withTimeout, EmbedderUnavailableError } from '../vision/embedder.ts';
import { getActiveModel, indexCoverage, modelPredicate, vectorExpr } from '../vision/index-admin.ts';
import { decodeRetailBarcodes } from '../vision/barcode.ts';
import { parseBarcode, displayGtin } from '../lib/gtin.ts';
import { productCards, type ProductCard } from './catalog.ts';
import { metrics } from '../server/metrics.ts';

export const ANN_CANDIDATES = 200;
export const MAX_RESULTS = 24;
const EMBED_TIMEOUT_MS = 30_000;

export interface PhotoSearchFilters {
  supplierIds?: string[];
  brand?: string;
  categoryId?: string;
  availableOnly?: boolean;
}

export type EvidenceKind = 'barcode' | 'visual' | 'shared_image';

export interface Candidate {
  product: ProductCard;
  group: 'confirmed' | 'possible' | 'similar';
  score: number | null;
  matchedImageId: string | null;
  matchingImages: number;
  evidence: Array<{ kind: EvidenceKind; text: string }>;
}

export interface PhotoSearchResult {
  searchId: string;
  status: 'ok' | 'provider_unavailable';
  message: string | null;
  barcode: { text: string; status: string; gtin: string | null; matchedProducts: number } | null;
  candidates: Candidate[];
  abstained: boolean;
  coverage: { indexed: number; assets: number; pending: number } | null;
  model: { key: string; calibrated: boolean } | null;
  timings: Record<string, number>;
}

export async function photoSearch(input: {
  userId: string;
  image: Buffer;
  crop?: Crop | null;
  filters?: PhotoSearchFilters;
  clientBarcode?: string | null;
  parentSearchId?: string | null;
}): Promise<PhotoSearchResult> {
  const t = timer();
  await validateImage(input.image);
  const [infer, display] = await Promise.all([makeInferImage(input.image, input.crop), makeQueryDisplay(input.image)]);
  t.lap('preprocess');

  const searchId = randomUUID();
  const imageKey = keys.searchImage(searchId);

  // Independent stages run concurrently: storing the photo, barcode evidence, visual retrieval.
  const storeStage = storage().put(imageKey, display, 'image/jpeg').then(() => t.mark('store'));

  const barcodeStage = (async () => {
    let barcodeText: string | null = null;
    if (input.clientBarcode) barcodeText = input.clientBarcode.trim().slice(0, 32);
    else {
      try {
        const found = await decodeRetailBarcodes(input.crop ? await makeInferImageForBarcode(input.image, input.crop) : input.image);
        barcodeText = found.find((f) => f.parsed.status === 'valid')?.parsed.gtin14 ?? found[0]?.text ?? null;
      } catch (err) {
        // Barcode reading is optional evidence: the search continues, but the failure is visible.
        metrics.inc('barcode_decode_errors_total');
        console.error(JSON.stringify({ level: 'error', msg: 'barcode decode failed', err: (err as Error).message }));
      }
    }
    const parsed = barcodeText ? parseBarcode(barcodeText) : null;
    const products = parsed?.gtin14 ? await productsByGtin(parsed.gtin14) : [];
    t.mark('barcode');
    return { barcodeText, parsed, products };
  })();

  const active = await getActiveModel(pool);
  const visualStage = (async () => {
    if (!config.VISION_ENABLED || !active) {
      return { status: 'provider_unavailable' as const, message: 'La ricerca per immagine non è attiva: puoi cercare per testo, EAN o SKU.', hits: [] };
    }
    try {
      const vec = await withTimeout(getEmbedder(active.spec.id).embed(infer), EMBED_TIMEOUT_MS, 'Tempo scaduto per l’analisi della foto');
      t.mark('embed');
      const hits = await nearestImages(active.key, active.spec.dim, vec);
      t.mark('ann');
      return { status: 'ok' as const, message: null, hits };
    } catch (err) {
      metrics.inc('photo_search_errors_total');
      return {
        status: 'provider_unavailable' as const,
        message:
          err instanceof EmbedderUnavailableError
            ? 'Il motore di riconoscimento immagini non è disponibile in questo momento. Il catalogo e la ricerca per testo/EAN funzionano normalmente.'
            : 'Errore durante l’analisi della foto. Riprova o cerca per testo/EAN.',
        hits: [] as Array<{ asset_id: string; score: number }>,
      };
    }
  })();

  const [, bc, visualResult] = await Promise.all([storeStage, barcodeStage, visualStage]);
  const { barcodeText, parsed: parsedBarcode, products: barcodeProducts } = bc;
  const status: PhotoSearchResult['status'] = visualResult.status;
  const message: string | null = visualResult.message;
  const hits = visualResult.hits;

  // --- aggregate per product (one card per canonical product, best image kept)
  const byProduct = await aggregateByProduct(hits);
  const allowed = await applyFilters([...new Set([...byProduct.keys(), ...barcodeProducts])], input.filters ?? {});
  const cards = await productCards([...allowed]);
  t.lap('aggregate');

  const thresholds = active?.thresholds ?? { possible: 1, similar: 1, calibrated: false };
  const candidates: Candidate[] = [];
  for (const pid of barcodeProducts) {
    if (!allowed.has(pid) || !cards.get(pid)) continue;
    const v = byProduct.get(pid);
    candidates.push({
      product: cards.get(pid)!,
      group: 'confirmed',
      score: v ? round(v.score) : null,
      matchedImageId: v?.assetId ?? null,
      matchingImages: v?.count ?? 0,
      evidence: [{ kind: 'barcode', text: `Codice a barre ${displayGtin(parsedBarcode!.gtin14!)} letto nella foto e presente nel catalogo` }],
    });
  }
  const visual = [...byProduct.entries()]
    .filter(([pid]) => allowed.has(pid) && !barcodeProducts.includes(pid) && cards.get(pid))
    .sort((a, b) => b[1].score - a[1].score);
  for (const [pid, v] of visual) {
    if (candidates.length >= MAX_RESULTS) break;
    const group = v.score >= thresholds.possible ? 'possible' : v.score >= thresholds.similar ? 'similar' : null;
    if (!group) continue;
    const evidence: Candidate['evidence'] = [
      { kind: 'visual', text: group === 'possible' ? 'Aspetto molto simile a una foto del catalogo' : 'Aspetto simile (possibile alternativa)' },
    ];
    if (v.shared) evidence.push({ kind: 'shared_image', text: 'La stessa foto è usata per più prodotti: verificare variante e confezione' });
    candidates.push({ product: cards.get(pid)!, group, score: round(v.score), matchedImageId: v.assetId, matchingImages: v.count, evidence });
  }
  const coverage = active ? await indexCoverage(pool, active.key) : null;
  const abstained = status === 'ok' && candidates.length === 0;
  const timings = t.done();
  metrics.observe('photo_search_server_ms', timings.total);

  const result: PhotoSearchResult = {
    searchId,
    status,
    message,
    barcode: parsedBarcode
      ? { text: barcodeText!, status: parsedBarcode.status, gtin: parsedBarcode.gtin14 ? displayGtin(parsedBarcode.gtin14) : null, matchedProducts: barcodeProducts.length }
      : null,
    candidates,
    abstained,
    coverage: coverage ? { indexed: coverage.indexed, assets: coverage.assets, pending: coverage.pending } : null,
    model: active ? { key: active.key, calibrated: !!thresholds.calibrated } : null,
    timings,
  };
  await pool.query(
    `INSERT INTO photo_searches (id, user_id, status, image_key, image_expires_at, crop, filters, model_key, barcode, timings, result, error)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), $6::jsonb, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)`,
    [
      searchId, input.userId, status, imageKey, config.PHOTO_SEARCH_RETENTION_HOURS, JSON.stringify(input.crop ?? null),
      JSON.stringify(input.filters ?? {}), active?.key ?? null, JSON.stringify(result.barcode), JSON.stringify(timings),
      JSON.stringify({
        candidates: candidates.map((c) => ({ productId: c.product.id, group: c.group, score: c.score, imageId: c.matchedImageId, evidence: c.evidence })),
        abstained, coverage: result.coverage, model: result.model, parentSearchId: input.parentSearchId ?? null,
      }),
      message,
    ],
  );
  return result;
}

async function makeInferImageForBarcode(image: Buffer, crop: Crop): Promise<Buffer> {
  // Barcode decoding on the cropped region at higher resolution than the 448px inference image.
  const sharp = (await import('sharp')).default;
  const oriented = await sharp(image).rotate().toBuffer({ resolveWithObject: true });
  const W = oriented.info.width;
  const H = oriented.info.height;
  const left = Math.max(0, Math.round(crop.x * W));
  const top = Math.max(0, Math.round(crop.y * H));
  return sharp(oriented.data)
    .extract({ left, top, width: Math.max(16, Math.min(W - left, Math.round(crop.width * W))), height: Math.max(16, Math.min(H - top, Math.round(crop.height * H))) })
    .png()
    .toBuffer();
}

export interface ProductHit {
  score: number;
  assetId: string;
  count: number;
  /** The matched image is linked to several products (e.g. variants sharing a generic photo). */
  shared: boolean;
}

/** Groups image hits by canonical product; keeps the best-scoring image per product. */
export async function aggregateByProduct(hits: Array<{ asset_id: string; score: number }>): Promise<Map<string, ProductHit>> {
  const byProduct = new Map<string, ProductHit>();
  if (!hits.length) return byProduct;
  const links = (
    await pool.query(
      `SELECT DISTINCT src.image_asset_id AS asset_id, o.product_id
         FROM image_sources src JOIN offer_images oi ON oi.image_source_id = src.id
         JOIN supplier_offers o ON o.id = oi.offer_id AND o.active
         JOIN products p ON p.id = o.product_id AND p.status = 'active'
        WHERE src.image_asset_id = ANY($1::uuid[])`,
      [hits.map((h) => h.asset_id)],
    )
  ).rows;
  const productsPerAsset = new Map<string, string[]>();
  for (const l of links) productsPerAsset.set(l.asset_id, [...(productsPerAsset.get(l.asset_id) ?? []), l.product_id]);
  for (const h of hits) {
    const products = productsPerAsset.get(h.asset_id) ?? [];
    for (const pid of products) {
      const cur = byProduct.get(pid);
      const shared = products.length > 1;
      if (!cur) byProduct.set(pid, { score: h.score, assetId: h.asset_id, count: 1, shared });
      else {
        cur.count++;
        if (h.score > cur.score) Object.assign(cur, { score: h.score, assetId: h.asset_id, shared });
      }
    }
  }
  return byProduct;
}

export async function nearestImages(key: string, dim: number, vec: Float32Array, k = ANN_CANDIDATES): Promise<Array<{ asset_id: string; score: number }>> {
  const client = await pool.connect();
  try {
    // One round trip: iterative scan keeps returning neighbours when rows are filtered out (pgvector >= 0.8).
    await client.query(`BEGIN; SET LOCAL hnsw.ef_search = ${Math.max(Math.trunc(k), 100)}; SET LOCAL hnsw.iterative_scan = relaxed_order`);
    const res = await client.query(
      `SELECT image_asset_id AS asset_id, 1 - (${vectorExpr(dim)} <=> $1::vector(${dim})) AS score
         FROM image_embeddings WHERE ${modelPredicate(key)}
        ORDER BY ${vectorExpr(dim)} <=> $1::vector(${dim}) LIMIT ${k}`,
      [vectorLiteral(vec)],
    );
    await client.query('COMMIT');
    return res.rows.map((r) => ({ asset_id: r.asset_id, score: Number(r.score) }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function productsByGtin(gtin14: string): Promise<string[]> {
  return (
    await pool.query(
      `SELECT DISTINCT p.id FROM products p
        WHERE p.status = 'active' AND (p.id IN (SELECT product_id FROM product_identifiers WHERE kind = 'gtin' AND value = $1)
           OR EXISTS (SELECT 1 FROM supplier_offers o WHERE o.product_id = p.id AND o.gtin = $1))`,
      [gtin14],
    )
  ).rows.map((r) => r.id);
}

async function applyFilters(ids: string[], f: PhotoSearchFilters): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const params: unknown[] = [ids];
  const where = [`p.id = ANY($1::uuid[])`];
  if (f.supplierIds?.length) {
    params.push(f.supplierIds);
    where.push(`EXISTS (SELECT 1 FROM supplier_offers o WHERE o.product_id = p.id AND o.active AND o.supplier_id = ANY($${params.length}::uuid[]))`);
  }
  if (f.brand) {
    params.push(f.brand);
    where.push(`lower(p.brand) = lower($${params.length})`);
  }
  if (f.categoryId) {
    params.push(f.categoryId);
    where.push(`p.category_id = $${params.length}`);
  }
  if (f.availableOnly) where.push('p.available_supplier_count > 0');
  return new Set((await pool.query(`SELECT p.id FROM products p WHERE ${where.join(' AND ')}`, params)).rows.map((r) => r.id));
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function timer() {
  const start = performance.now();
  let last = start;
  let parallelStart = 0;
  const laps: Record<string, number> = {};
  return {
    /** Sequential stage: time since the previous lap. */
    lap(name: string) {
      const now = performance.now();
      laps[name] = Math.round(now - last);
      last = now;
      parallelStart = now;
    },
    /** Concurrent stage: time since the parallel section started. */
    mark(name: string) {
      laps[name] = Math.round(performance.now() - (parallelStart || start));
    },
    done() {
      laps.total = Math.round(performance.now() - start);
      return laps;
    },
  };
}
