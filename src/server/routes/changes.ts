// Change report API (read-only, all authenticated users).
import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.ts';
import { requireUser } from '../auth.ts';
import { csvDocument } from '../../lib/csv.ts';
import { buildChangeWhere, changeQuerySchema, describeChange, listChanges } from '../../search/changes.ts';

export async function changeRoutes(app: FastifyInstance) {
  app.get('/changes', async (request) => {
    requireUser(request);
    const q = changeQuerySchema.parse(request.query);
    const items = await listChanges(q, q.limit, q.offset);
    const w = buildChangeWhere(q, { withTypes: false });
    const counts = (
      await pool.query(
        `SELECT c.change_type, count(*)::int AS n FROM offer_changes c JOIN supplier_offers o ON o.id = c.offer_id
          WHERE ${w.sql} GROUP BY c.change_type`,
        w.params,
      )
    ).rows;
    return { items, counts: Object.fromEntries(counts.map((c) => [c.change_type, c.n])) };
  });

  app.get('/changes.csv', async (request, reply) => {
    requireUser(request);
    const q = changeQuerySchema.parse(request.query);
    const items = await listChanges(q, 50_000, 0);
    const rows = items.map((c) => {
      const [before, after] = describeChange(c.type, c.oldValue, c.newValue);
      return [
        new Date(c.at).toISOString(), c.supplier.name, c.sku, c.product?.title ?? c.offerTitle ?? '', c.product?.gtin ?? '', c.typeLabel,
        before, after, c.pct ?? '', c.source === 'feed' ? 'feed automatico' : 'caricamento manuale',
      ];
    });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="variazioni-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csvDocument(['data', 'fornitore', 'codice fornitore', 'prodotto', 'EAN', 'tipo', 'prima', 'dopo', 'variazione %', 'origine'], rows));
  });
}
