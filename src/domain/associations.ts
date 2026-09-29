// Manual identity operations. Every operation is audited with the exact rows it moved, so it can be
// reverted without losing offers or provenance (case J). Visual similarity never merges anything.
import type { Tx } from '../db/pool.ts';
import { recordAudit, type Actor } from './audit.ts';
import { refreshProducts } from './canonical.ts';

export class AssociationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function lockProducts(tx: Tx, ids: string[]) {
  const rows = (await tx.query(`SELECT * FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids])).rows;
  return new Map(rows.map((r) => [r.id, r]));
}

export interface MergeInput {
  targetId: string;
  sourceId: string;
  actor: Actor;
  reason: string;
  evidence?: string | null;
}

/** Merges `source` into `target`: offers and identifiers move, `source` becomes status=merged. */
export async function mergeProducts(tx: Tx, input: MergeInput): Promise<number> {
  if (input.targetId === input.sourceId) throw new AssociationError('Impossibile unire un prodotto con sé stesso');
  // Serialise with imports: they take the same advisory lock on each GTIN before reading which product owns
  // it, so no import can attach a new offer to the source product while it is being merged (the offer would
  // end up on a "merged" product and disappear from the catalogue). Taken before the row locks, in the same
  // order as imports (sorted), to avoid lock-order deadlocks.
  const gtins = (
    await tx.query(`SELECT DISTINCT value FROM product_identifiers WHERE kind = 'gtin' AND product_id = ANY($1::uuid[]) ORDER BY value`, [
      [input.targetId, input.sourceId],
    ])
  ).rows.map((r) => r.value as string);
  for (const g of gtins) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gtin:${g}`]);
  const products = await lockProducts(tx, [input.targetId, input.sourceId]);
  const target = products.get(input.targetId);
  const source = products.get(input.sourceId);
  if (!target || !source) throw new AssociationError('Prodotto non trovato', 404);
  if (target.status === 'merged' || source.status === 'merged') throw new AssociationError('Uno dei prodotti è già stato unito ad un altro', 409);

  const identifiers = (await tx.query(`SELECT id, value FROM product_identifiers WHERE product_id = $1`, [source.id])).rows;
  const targetIdentifiers = (await tx.query(`SELECT value FROM product_identifiers WHERE product_id = $1`, [target.id])).rows;
  if (identifiers.length && targetIdentifiers.length && (input.reason ?? '').trim().length < 10) {
    throw new AssociationError('I prodotti hanno EAN diversi: indicare una motivazione con le evidenze (almeno 10 caratteri)');
  }
  const offers = (await tx.query(`SELECT id, link_source FROM supplier_offers WHERE product_id = $1 ORDER BY id FOR UPDATE`, [source.id])).rows;

  await tx.query(
    `UPDATE supplier_offers SET product_id = $2,
            link_source = CASE WHEN link_source = 'gtin' THEN 'gtin' ELSE 'manual' END, updated_at = now()
      WHERE product_id = $1`,
    [source.id, target.id],
  );
  await tx.query(`UPDATE product_identifiers SET product_id = $2 WHERE product_id = $1`, [source.id, target.id]);
  await tx.query(`UPDATE products SET status = 'merged', merged_into_id = $2, updated_at = now() WHERE id = $1`, [source.id, target.id]);
  const eventId = await recordAudit(tx, {
    actor: input.actor,
    action: 'product.merge',
    entityType: 'product',
    entityId: target.id,
    relatedIds: [target.id, source.id],
    reason: input.reason,
    data: {
      targetId: target.id,
      sourceId: source.id,
      offers: offers.map((o) => ({ id: o.id, previousLinkSource: o.link_source })),
      identifiers: identifiers.map((i) => ({ id: i.id, value: i.value })),
      evidence: input.evidence ?? null,
    },
  });
  // Close reviews that this decision answers; other open reviews on the source no longer apply.
  await tx.query(
    `UPDATE match_reviews SET status = 'resolved', resolution = 'merged', resolved_at = now(), resolved_by = $3, audit_event_id = $4
      WHERE status = 'open' AND ((product_id = $1 AND candidate_product_id = $2) OR (product_id = $2 AND candidate_product_id = $1))`,
    [source.id, target.id, input.actor.userId ?? null, eventId],
  );
  await tx.query(
    `UPDATE match_reviews SET status = 'dismissed', resolution = 'dismissed', resolved_at = now(), resolution_note = 'Prodotto unito ad un altro prodotto'
      WHERE status = 'open' AND (product_id = $1 OR candidate_product_id = $1)`,
    [source.id],
  );
  await refreshProducts(tx, [target.id, source.id]);
  return eventId;
}

/** Reverts a merge: offers and identifiers go back, including offers that later arrived via moved GTINs. */
export async function splitMerge(tx: Tx, mergeEventId: number, actor: Actor, reason: string | null): Promise<number> {
  const ev = (await tx.query(`SELECT * FROM audit_events WHERE id = $1 FOR UPDATE`, [mergeEventId])).rows[0];
  if (!ev || ev.action !== 'product.merge') throw new AssociationError('Evento di unione non trovato', 404);
  if (ev.reverted_by_event_id) throw new AssociationError('Unione già annullata', 409);
  const { targetId, sourceId, offers, identifiers } = ev.data as {
    targetId: string; sourceId: string; offers: Array<{ id: string; previousLinkSource: string }>; identifiers: Array<{ id: string; value: string }>;
  };
  const products = await lockProducts(tx, [targetId, sourceId]);
  const source = products.get(sourceId);
  if (!source || source.status !== 'merged' || source.merged_into_id !== targetId) {
    throw new AssociationError('Il prodotto non è più nello stato risultante dall’unione: annullamento non sicuro', 409);
  }
  for (const o of offers) {
    await tx.query(`UPDATE supplier_offers SET product_id = $2, link_source = $3, updated_at = now() WHERE id = $1 AND product_id = $4`, [
      o.id, sourceId, o.previousLinkSource, targetId,
    ]);
  }
  const values = identifiers.map((i) => i.value);
  const laterOffers = values.length
    ? (
        await tx.query(
          `UPDATE supplier_offers SET product_id = $1, updated_at = now()
            WHERE product_id = $2 AND link_source = 'gtin' AND gtin = ANY($3::text[]) RETURNING id`,
          [sourceId, targetId, values],
        )
      ).rows
    : [];
  await tx.query(`UPDATE product_identifiers SET product_id = $1 WHERE id = ANY($2::uuid[])`, [sourceId, identifiers.map((i) => i.id)]);
  await tx.query(`UPDATE products SET status = 'active', merged_into_id = NULL, updated_at = now() WHERE id = $1`, [sourceId]);
  const id = await recordAudit(tx, {
    actor, action: 'product.split', entityType: 'product', entityId: targetId, relatedIds: [targetId, sourceId], reason,
    revertsEventId: mergeEventId, data: { restoredOffers: offers.map((o) => o.id), laterOffers: laterOffers.map((o) => o.id), identifiers },
  });
  await refreshProducts(tx, [targetId, sourceId]);
  return id;
}

/** Moves one offer out of its product into a new product (e.g. a wrong association). */
export async function detachOffer(tx: Tx, offerId: string, actor: Actor, reason: string): Promise<{ eventId: number; productId: string }> {
  const offer = (await tx.query(`SELECT * FROM supplier_offers WHERE id = $1 FOR UPDATE`, [offerId])).rows[0];
  if (!offer) throw new AssociationError('Offerta non trovata', 404);
  const others = (await tx.query(`SELECT count(*)::int AS n FROM supplier_offers WHERE product_id = $1 AND id <> $2`, [offer.product_id, offerId])).rows[0].n;
  if (others === 0) throw new AssociationError('L’offerta è l’unica del prodotto: niente da separare', 409);
  await lockProducts(tx, [offer.product_id]);
  const newProduct = (await tx.query(`INSERT INTO products DEFAULT VALUES RETURNING id`)).rows[0].id as string;
  await tx.query(`UPDATE supplier_offers SET product_id = $2, link_source = 'manual', updated_at = now() WHERE id = $1`, [offerId, newProduct]);
  const eventId = await recordAudit(tx, {
    actor, action: 'offer.detach', entityType: 'offer', entityId: offerId, relatedIds: [offer.product_id, newProduct], reason,
    data: { fromProductId: offer.product_id, toProductId: newProduct, previousLinkSource: offer.link_source },
  });
  await refreshProducts(tx, [offer.product_id, newProduct]);
  return { eventId, productId: newProduct };
}

async function revertDetach(tx: Tx, ev: any, actor: Actor, reason: string | null): Promise<number> {
  const { fromProductId, toProductId, previousLinkSource } = ev.data;
  const offer = (await tx.query(`SELECT * FROM supplier_offers WHERE id = $1 FOR UPDATE`, [ev.entity_id])).rows[0];
  if (!offer || offer.product_id !== toProductId) throw new AssociationError('L’offerta è stata spostata di nuovo: annullamento non sicuro', 409);
  const from = (await tx.query(`SELECT status FROM products WHERE id = $1`, [fromProductId])).rows[0];
  if (!from || from.status === 'merged') throw new AssociationError('Il prodotto di origine non è più disponibile', 409);
  await tx.query(`UPDATE supplier_offers SET product_id = $2, link_source = $3, updated_at = now() WHERE id = $1`, [ev.entity_id, fromProductId, previousLinkSource]);
  const id = await recordAudit(tx, {
    actor, action: 'offer.reattach', entityType: 'offer', entityId: ev.entity_id, relatedIds: [fromProductId, toProductId], reason, revertsEventId: ev.id, data: {},
  });
  await refreshProducts(tx, [fromProductId, toProductId]);
  return id;
}

export interface OverrideInput {
  title?: string | null;
  brand?: string | null;
  categoryId?: string | null;
  primaryImageId?: string | null;
}

const OVERRIDE_COLUMNS: Record<keyof OverrideInput, string> = {
  title: 'title_override', brand: 'brand_override', categoryId: 'category_override_id', primaryImageId: 'primary_image_override_id',
};

/** Manual canonical values; protected from later imports. null clears an override. */
export async function setOverrides(tx: Tx, productId: string, input: OverrideInput, actor: Actor, reason: string | null): Promise<number> {
  const products = await lockProducts(tx, [productId]);
  const p = products.get(productId);
  if (!p) throw new AssociationError('Prodotto non trovato', 404);
  if (p.status === 'merged') throw new AssociationError('Prodotto unito ad un altro: modificare il prodotto risultante', 409);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(OVERRIDE_COLUMNS) as Array<[keyof OverrideInput, string]>) {
    if (!(k in input)) continue;
    const value = typeof input[k] === 'string' ? (input[k] as string).trim() || null : input[k] ?? null;
    before[k] = p[col];
    after[k] = value;
    await tx.query(`UPDATE products SET ${col} = $2 WHERE id = $1`, [productId, value]);
  }
  const id = await recordAudit(tx, {
    actor, action: 'product.override', entityType: 'product', entityId: productId, relatedIds: [productId], reason, data: { before, after },
  });
  await refreshProducts(tx, [productId]);
  return id;
}

export async function revertEvent(tx: Tx, eventId: number, actor: Actor, reason: string | null): Promise<number> {
  const ev = (await tx.query(`SELECT * FROM audit_events WHERE id = $1 FOR UPDATE`, [eventId])).rows[0];
  if (!ev) throw new AssociationError('Evento non trovato', 404);
  if (ev.reverted_by_event_id) throw new AssociationError('Operazione già annullata', 409);
  switch (ev.action) {
    case 'product.merge':
      return splitMerge(tx, eventId, actor, reason);
    case 'offer.detach':
      return revertDetach(tx, ev, actor, reason);
    case 'product.override': {
      const before = ev.data.before as OverrideInput;
      const id = await setOverrides(tx, ev.entity_id, before, actor, reason ?? 'Annullamento modifica manuale');
      await tx.query(`UPDATE audit_events SET reverts_event_id = $1 WHERE id = $2`, [eventId, id]);
      await tx.query(`UPDATE audit_events SET reverted_by_event_id = $1 WHERE id = $2`, [id, eventId]);
      return id;
    }
    default:
      throw new AssociationError('Questa operazione non è annullabile', 400);
  }
}

export async function resolveReview(
  tx: Tx,
  reviewId: string,
  action: 'merge' | 'keep_separate' | 'dismiss',
  actor: Actor,
  note: string | null,
): Promise<{ auditEventId: number | null }> {
  const r = (await tx.query(`SELECT * FROM match_reviews WHERE id = $1 FOR UPDATE`, [reviewId])).rows[0];
  if (!r) throw new AssociationError('Revisione non trovata', 404);
  if (r.status !== 'open') throw new AssociationError('Revisione già chiusa', 409);
  if (action === 'merge') {
    const eventId = await mergeProducts(tx, {
      targetId: r.candidate_product_id, sourceId: r.product_id, actor, reason: note ?? '', evidence: `Revisione ${r.kind} ${reviewId}`,
    });
    await tx.query(`UPDATE match_reviews SET resolution_note = $2 WHERE id = $1`, [reviewId, note]);
    return { auditEventId: eventId };
  }
  let auditEventId: number | null = null;
  if (action === 'keep_separate') {
    const [a, b] = [r.product_id, r.candidate_product_id].sort();
    await tx.query(
      `INSERT INTO product_distinct_pairs (product_a, product_b, reason, decided_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [a, b, note, actor.userId ?? null],
    );
    if (r.offer_id) {
      await tx.query(`UPDATE supplier_offers SET link_source = 'manual' WHERE id = $1 AND link_source = 'conflict_hold'`, [r.offer_id]);
    }
    auditEventId = await recordAudit(tx, {
      actor, action: 'review.kept_separate', entityType: 'match_review', entityId: reviewId, relatedIds: [r.product_id, r.candidate_product_id], reason: note, data: {},
    });
  }
  await tx.query(
    `UPDATE match_reviews SET status = $2, resolution = $3, resolved_at = now(), resolved_by = $4, resolution_note = $5, audit_event_id = $6 WHERE id = $1`,
    [reviewId, action === 'dismiss' ? 'dismissed' : 'resolved', action === 'dismiss' ? 'dismissed' : 'kept_separate', actor.userId ?? null, note, auditEventId],
  );
  return { auditEventId };
}
