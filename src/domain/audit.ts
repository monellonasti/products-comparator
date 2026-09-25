// Append-only audit trail. Every association/merge/split/override is recorded with enough data to
// be reverted (see src/domain/associations.ts).
import type { Db } from '../db/pool.ts';

export interface Actor {
  kind: 'user' | 'system' | 'import';
  userId?: string | null;
}

export const SYSTEM: Actor = { kind: 'system' };

export interface AuditInput {
  actor: Actor;
  action: string;
  entityType: string;
  entityId: string;
  relatedIds?: string[];
  reason?: string | null;
  data?: Record<string, unknown>;
  revertsEventId?: number | null;
}

export async function recordAudit(db: Db, e: AuditInput): Promise<number> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO audit_events (actor_user_id, actor_kind, action, entity_type, entity_id, related_ids, reason, data, reverts_event_id)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8::jsonb, $9) RETURNING id`,
    [
      e.actor.userId ?? null, e.actor.kind, e.action, e.entityType, e.entityId,
      [...new Set(e.relatedIds ?? [])], e.reason ?? null, JSON.stringify(e.data ?? {}), e.revertsEventId ?? null,
    ],
  );
  const id = res.rows[0].id;
  if (e.revertsEventId) await db.query('UPDATE audit_events SET reverted_by_event_id = $1 WHERE id = $2', [id, e.revertsEventId]);
  return id;
}
