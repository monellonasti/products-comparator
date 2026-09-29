import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../../db/pool.ts';
import { HttpError, requireRole, requireUser } from '../auth.ts';
import { refreshProducts } from '../../domain/canonical.ts';
import { invalidateFacets } from '../../search/catalog.ts';
import { foldText } from '../../lib/text.ts';
import { config } from '../../config.ts';
import { describeSchedule } from '../../lib/schedule.ts';
import {
  feedInputSchema, FeedError, HTTP_FEED, requestFeedRun, sampleFeedForWizard, saveFeedConfig, secretFlags, testFeed, type FeedConfig,
} from '../../imports/feed.ts';
import { SecretsUnavailableError } from '../../lib/secrets.ts';
import { runToApi } from './imports.ts';

/**
 * Feed state for the UI: configuration without secrets, only whether each secret is set. Operators see
 * only the host of the feed URL: its path can itself be an access token (".../export/<token>/list.csv").
 */
async function feedView(s: any, isAdmin: boolean) {
  const cfg = s.connector_kind === HTTP_FEED ? (s.connector_config as FeedConfig) : null;
  const lastRun = s.feed_last_run_id
    ? (await pool.query(`SELECT id, status, error, counters, finished_at, created_at FROM import_runs WHERE id = $1`, [s.feed_last_run_id])).rows[0] ?? null
    : null;
  return {
    configured: !!cfg,
    secretsKeyConfigured: !!config.SECRETS_KEY,
    enabled: s.feed_enabled,
    urlDisplay: cfg ? (isAdmin ? cfg.urlDisplay : hostOnly(cfg.urlDisplay)) : null,
    authType: cfg?.authType ?? 'none',
    headerName: cfg?.headerName ?? null,
    secretsSet: cfg ? await secretFlags(pool, s.id) : null,
    schedule: cfg?.schedule ?? { kind: 'daily', time: '06:00', timezone: config.FEED_DEFAULT_TIMEZONE },
    scheduleText: cfg ? describeSchedule(cfg.schedule) : null,
    mode: cfg?.mode ?? 'snapshot',
    nextRunAt: s.feed_next_run_at,
    lastCheckedAt: s.feed_last_checked_at,
    lastStatus: s.feed_last_status,
    lastError: isAdmin || !cfg || !s.feed_last_error ? s.feed_last_error : String(s.feed_last_error).split(cfg.urlDisplay).join(hostOnly(cfg.urlDisplay)),
    consecutiveFailures: s.feed_consecutive_failures,
    lastRun,
  };
}

function hostOnly(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '…';
  }
}

function feedErrors(err: unknown): never {
  if (err instanceof FeedError) throw new HttpError(err.status === 502 ? 502 : err.status, err.message);
  if (err instanceof SecretsUnavailableError) throw new HttpError(503, err.message);
  throw err;
}

const supplierBody = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'Codice: minuscole, numeri e trattini (2-41 caratteri)'),
  name: z.string().min(1).max(200),
  website: z.string().url().max(500).regex(/^https?:\/\//i, 'Sito web: indirizzo http o https').nullable().optional(),
  priority: z.number().int().min(0).max(10000).default(100),
  defaultCurrency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
  defaultVatTreatment: z.enum(['net', 'gross', 'unknown']).default('unknown'),
  defaultVatRate: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/).nullable().optional(),
  imageHostAllowlist: z.array(z.string().regex(/^(\*\.)?[a-z0-9.-]+$/i).max(253)).max(50).default([]),
  staleAfterHours: z.number().int().min(1).max(24 * 365).default(168),
  refreshIntervalMinutes: z.number().int().min(15).nullable().optional(),
  active: z.boolean().default(true),
  notes: z.string().max(4000).nullable().optional(),
});

function toApi(s: any) {
  return {
    id: s.id, code: s.code, name: s.name, website: s.website, priority: s.priority, defaultCurrency: s.default_currency,
    defaultVatTreatment: s.default_vat_treatment, defaultVatRate: s.default_vat_rate, imageHostAllowlist: s.image_host_allowlist,
    staleAfterHours: s.stale_after_hours, connectorKind: s.connector_kind, refreshIntervalMinutes: s.refresh_interval_minutes, active: s.active,
    notes: s.notes, lastImportStatus: s.last_import_status, lastImportFinishedAt: s.last_import_finished_at, lastSuccessAsOf: s.last_success_as_of,
    feedEnabled: s.feed_enabled, feedNextRunAt: s.feed_next_run_at, feedLastStatus: s.feed_last_status,
    feedScheduleText: s.connector_kind === HTTP_FEED && s.connector_config?.schedule ? describeSchedule(s.connector_config.schedule) : null,
    stats: s.stats ?? undefined,
  };
}

export async function supplierRoutes(app: FastifyInstance) {
  app.get('/suppliers', async (request) => {
    requireUser(request);
    const rows = (
      await pool.query(
        `SELECT s.*, json_build_object(
            'activeOffers', (SELECT count(*) FROM supplier_offers o WHERE o.supplier_id = s.id AND o.active),
            'inactiveOffers', (SELECT count(*) FROM supplier_offers o WHERE o.supplier_id = s.id AND NOT o.active),
            'imagesPending', (SELECT count(*) FROM image_sources i WHERE i.supplier_id = s.id AND i.status = 'pending'),
            'imagesFailed', (SELECT count(*) FROM image_sources i WHERE i.supplier_id = s.id AND i.status IN ('failed', 'blocked')),
            'unmappedCategories', (SELECT count(*) FROM category_mappings m WHERE m.supplier_id = s.id AND m.category_id IS NULL)
          ) AS stats
           FROM suppliers s ORDER BY s.name`,
      )
    ).rows;
    return { items: rows.map(toApi) };
  });

  app.get('/suppliers/:id', async (request) => {
    requireUser(request);
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const s = (await pool.query('SELECT * FROM suppliers WHERE id = $1', [id])).rows[0];
    if (!s) throw new HttpError(404, 'Fornitore non trovato');
    const profile = (await pool.query(`SELECT * FROM import_profiles WHERE supplier_id = $1 ORDER BY name`, [id])).rows;
    return { supplier: toApi(s), profiles: profile, feed: await feedView(s, request.user!.role === 'admin') };
  });

  app.post('/suppliers', async (request) => {
    requireRole(request, 'admin');
    const b = supplierBody.parse(request.body);
    try {
      const s = (
        await pool.query(
          `INSERT INTO suppliers (code, name, website, priority, default_currency, default_vat_treatment, default_vat_rate, image_host_allowlist,
                                  stale_after_hours, refresh_interval_minutes, active, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [b.code, b.name, b.website ?? null, b.priority, b.defaultCurrency, b.defaultVatTreatment, b.defaultVatRate ?? null, b.imageHostAllowlist,
            b.staleAfterHours, b.refreshIntervalMinutes ?? null, b.active, b.notes ?? null],
        )
      ).rows[0];
      invalidateFacets();
      return { supplier: toApi(s) };
    } catch (err: any) {
      if (err.code === '23505') throw new HttpError(409, 'Esiste già un fornitore con questo codice');
      throw err;
    }
  });

  app.patch('/suppliers/:id', async (request) => {
    requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const b = supplierBody.partial().parse(request.body);
    const cols: Record<string, unknown> = {
      code: b.code, name: b.name, website: b.website, priority: b.priority, default_currency: b.defaultCurrency,
      default_vat_treatment: b.defaultVatTreatment, default_vat_rate: b.defaultVatRate, image_host_allowlist: b.imageHostAllowlist,
      stale_after_hours: b.staleAfterHours, refresh_interval_minutes: b.refreshIntervalMinutes, active: b.active, notes: b.notes,
    };
    const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (!entries.length) throw new HttpError(400, 'Nessuna modifica');
    const s = await withTx(async (tx) => {
      const updated = (
        await tx.query(
          `UPDATE suppliers SET ${entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
          [id, ...entries.map(([, v]) => v)],
        )
      ).rows[0];
      if (!updated) throw new HttpError(404, 'Fornitore non trovato');
      if (b.priority !== undefined) {
        // Priority drives canonical precedence: recompute affected products in the same transaction.
        const ids = (await tx.query('SELECT DISTINCT product_id FROM supplier_offers WHERE supplier_id = $1', [id])).rows.map((r) => r.product_id);
        for (let i = 0; i < ids.length; i += 500) await refreshProducts(tx, ids.slice(i, i + 500));
      }
      return updated;
    });
    invalidateFacets();
    return { supplier: toApi(s) };
  });

  // ---- scheduled feed (admin): secrets are write-only and never returned
  app.put('/suppliers/:id/feed', async (request) => {
    const user = requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const body = feedInputSchema.parse(request.body);
    try {
      await saveFeedConfig(id, body, { kind: 'user', userId: user.id });
    } catch (err) {
      feedErrors(err);
    }
    const s = (await pool.query('SELECT * FROM suppliers WHERE id = $1', [id])).rows[0];
    return { feed: await feedView(s, true) };
  });

  app.post('/suppliers/:id/feed/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    try {
      return await testFeed(id);
    } catch (err) {
      feedErrors(err);
    }
  });

  app.post('/suppliers/:id/feed/sample', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const user = requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    try {
      const r = await sampleFeedForWizard(id, user.id);
      return { ...r, run: runToApi(r.run) }; // same shape as POST /imports: the wizard reads camelCase fields
    } catch (err) {
      feedErrors(err);
    }
  });

  app.post('/suppliers/:id/feed/run', async (request) => {
    requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const s = (await pool.query('SELECT connector_kind FROM suppliers WHERE id = $1', [id])).rows[0];
    if (!s) throw new HttpError(404, 'Fornitore non trovato');
    if (s.connector_kind !== HTTP_FEED) throw new HttpError(400, 'Feed non configurato');
    await requestFeedRun(id);
    return { ok: true };
  });

  // ---- normalised categories and per-supplier mapping of raw categories
  app.get('/categories', async (request) => {
    requireUser(request);
    return { items: (await pool.query('SELECT id, name, slug, parent_id FROM categories ORDER BY name')).rows };
  });

  app.post('/categories', async (request) => {
    requireRole(request, 'admin');
    const b = z.object({ name: z.string().min(1).max(120), parentId: z.guid().nullable().optional() }).parse(request.body);
    const slug = foldText(b.name).replace(/\s+/g, '-');
    try {
      return { category: (await pool.query('INSERT INTO categories (name, slug, parent_id) VALUES ($1, $2, $3) RETURNING *', [b.name, slug, b.parentId ?? null])).rows[0] };
    } catch (err: any) {
      if (err.code === '23505') throw new HttpError(409, 'Categoria già esistente');
      throw err;
    }
  });

  app.get('/suppliers/:id/category-mappings', async (request) => {
    requireUser(request);
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const rows = (
      await pool.query(
        `SELECT m.raw_category, m.category_id, c.name AS category_name,
                (SELECT count(*)::int FROM supplier_offers o WHERE o.supplier_id = m.supplier_id AND o.category_raw = m.raw_category) AS offers
           FROM category_mappings m LEFT JOIN categories c ON c.id = m.category_id WHERE m.supplier_id = $1 ORDER BY m.category_id NULLS FIRST, m.raw_category`,
        [id],
      )
    ).rows;
    return { items: rows };
  });

  app.put('/suppliers/:id/category-mappings', async (request) => {
    requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const b = z.object({ rawCategory: z.string().min(1).max(300), categoryId: z.guid().nullable() }).parse(request.body);
    await withTx(async (tx) => {
      const res = await tx.query(`UPDATE category_mappings SET category_id = $3, updated_at = now() WHERE supplier_id = $1 AND raw_category = $2`, [id, b.rawCategory, b.categoryId]);
      if (!res.rowCount) throw new HttpError(404, 'Categoria del fornitore non trovata');
      const products = (
        await tx.query(`UPDATE supplier_offers SET category_id = $3 WHERE supplier_id = $1 AND category_raw = $2 RETURNING product_id`, [id, b.rawCategory, b.categoryId])
      ).rows.map((r) => r.product_id);
      const unique = [...new Set(products)];
      for (let i = 0; i < unique.length; i += 500) await refreshProducts(tx, unique.slice(i, i + 500));
    });
    invalidateFacets();
    return { ok: true };
  });
}
