import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../../db/pool.ts';
import { hashPassword, HttpError, requireRole, validatePasswordPolicy } from '../auth.ts';
import { getActiveModel, indexCoverage } from '../../vision/index-admin.ts';
import { getEmbedder } from '../../vision/embedder.ts';
import { config } from '../../config.ts';
import { enqueueImageFetch, enqueueEmbed } from '../../jobs/queue.ts';

export async function adminRoutes(app: FastifyInstance) {
  // ---- users
  app.get('/users', async (request) => {
    requireRole(request, 'admin');
    return { items: (await pool.query('SELECT id, email, display_name, role, active, created_at, last_login_at FROM users ORDER BY display_name')).rows };
  });

  app.post('/users', async (request) => {
    requireRole(request, 'admin');
    const b = z.object({ email: z.string().email().max(200), displayName: z.string().min(1).max(200), role: z.enum(['admin', 'operator']), password: z.string() }).parse(request.body);
    const policy = validatePasswordPolicy(b.password);
    if (policy) throw new HttpError(400, policy);
    try {
      const u = (
        await pool.query('INSERT INTO users (email, display_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, display_name, role, active', [
          b.email, b.displayName, b.role, await hashPassword(b.password),
        ])
      ).rows[0];
      return { user: u };
    } catch (err: any) {
      if (err.code === '23505') throw new HttpError(409, 'Email già registrata');
      throw err;
    }
  });

  app.patch('/users/:id', async (request) => {
    const admin = requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const b = z
      .object({ displayName: z.string().min(1).max(200).optional(), role: z.enum(['admin', 'operator']).optional(), active: z.boolean().optional(), password: z.string().optional() })
      .parse(request.body);
    if (id === admin.id && (b.active === false || b.role === 'operator')) throw new HttpError(400, 'Non puoi disattivare o declassare il tuo stesso account');
    return withTx(async (tx) => {
      if (b.displayName !== undefined) await tx.query('UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1', [id, b.displayName]);
      if (b.role !== undefined) await tx.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [id, b.role]);
      if (b.active !== undefined) {
        await tx.query('UPDATE users SET active = $2, updated_at = now() WHERE id = $1', [id, b.active]);
        if (!b.active) await tx.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      }
      if (b.password !== undefined) {
        const policy = validatePasswordPolicy(b.password);
        if (policy) throw new HttpError(400, policy);
        await tx.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [id, await hashPassword(b.password)]);
        await tx.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      }
      const u = (await tx.query('SELECT id, email, display_name, role, active FROM users WHERE id = $1', [id])).rows[0];
      if (!u) throw new HttpError(404, 'Utente non trovato');
      const admins = (await tx.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`)).rows[0].n;
      if (admins === 0) throw new HttpError(400, 'Deve restare almeno un amministratore attivo');
      return { user: u };
    });
  });

  // ---- system status (technical details are confined to the admin area)
  app.get('/admin/status', async (request) => {
    requireRole(request, 'admin');
    const active = await getActiveModel(pool);
    const [models, queue, images, stale, searches] = await Promise.all([
      pool.query('SELECT key, repo, revision, dim, license, status, thresholds, created_at, activated_at FROM embedding_models ORDER BY created_at'),
      pool.query(
        `SELECT t.identifier AS task, count(*)::int AS jobs, count(*) FILTER (WHERE j.last_error IS NOT NULL)::int AS with_errors,
                count(*) FILTER (WHERE j.locked_at IS NOT NULL)::int AS running
           FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id GROUP BY t.identifier`,
      ),
      pool.query(`SELECT status, count(*)::int AS n FROM image_sources GROUP BY status`),
      pool.query(
        `SELECT s.id, s.name, s.last_import_status, s.last_success_as_of, s.stale_after_hours,
                (s.last_success_as_of IS NULL OR s.last_success_as_of < now() - make_interval(hours => s.stale_after_hours)) AS stale
           FROM suppliers s WHERE s.active ORDER BY s.name`,
      ),
      pool.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status <> 'ok')::int AS failed,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings->>'total')::numeric) AS p95_ms
           FROM photo_searches WHERE created_at > now() - interval '7 days'`,
      ),
    ]);
    const failures = (
      await pool.query(`SELECT id, url, status, last_error, attempts, last_attempt_at FROM image_sources WHERE status IN ('failed', 'blocked') ORDER BY last_attempt_at DESC NULLS LAST LIMIT 50`)
    ).rows;
    const embedFailures = active
      ? (await pool.query(`SELECT image_asset_id, error, attempts, updated_at FROM image_embeddings WHERE model_key = $1 AND status = 'failed' ORDER BY updated_at DESC LIMIT 50`, [active.key])).rows
      : [];
    const feedback = (await pool.query(`SELECT verdict, count(*)::int AS n FROM search_feedback GROUP BY verdict`)).rows;
    return {
      vision: {
        enabled: config.VISION_ENABLED,
        configuredModel: config.VISION_MODEL,
        activeModel: active ? { key: active.key, label: active.spec.label, license: active.spec.license, thresholds: active.thresholds } : null,
        embedder: active ? getEmbedder(active.spec.id).status() : null,
        coverage: active ? await indexCoverage(pool, active.key) : null,
        models: models.rows,
        embedFailures,
      },
      queue: queue.rows,
      images: Object.fromEntries(images.rows.map((r) => [r.status, r.n])),
      imageFailures: failures,
      suppliers: stale.rows,
      photoSearches: searches.rows[0],
      feedback,
    };
  });

  app.post('/admin/images/retry-failed', async (request) => {
    requireRole(request, 'admin');
    const b = z.object({ includeBlocked: z.boolean().default(false) }).parse(request.body ?? {});
    const n = await withTx(async (tx) => {
      const rows = (
        await tx.query(
          `UPDATE image_sources SET status = 'pending', attempts = 0, updated_at = now()
            WHERE status = ANY($1::text[]) RETURNING id, url`,
          [b.includeBlocked ? ['failed', 'blocked'] : ['failed']],
        )
      ).rows;
      for (const r of rows) await enqueueImageFetch(tx, r.id, r.url);
      const active = await getActiveModel(tx);
      if (active) {
        const failed = (await tx.query(`UPDATE image_embeddings SET status = 'pending', attempts = 0 WHERE model_key = $1 AND status = 'failed' RETURNING image_asset_id`, [active.key])).rows;
        for (const f of failed) await enqueueEmbed(tx, f.image_asset_id, active.key);
        return rows.length + failed.length;
      }
      return rows.length;
    });
    return { requeued: n };
  });

  app.patch('/admin/vision/thresholds', async (request) => {
    const user = requireRole(request, 'admin');
    const b = z
      .object({ possible: z.number().min(0).max(1), similar: z.number().min(0).max(1), calibrated: z.boolean(), note: z.string().max(1000).optional() })
      .refine((t) => t.similar <= t.possible, 'La soglia "simili" deve essere ≤ della soglia "possibili"')
      .parse(request.body);
    const active = await getActiveModel(pool);
    if (!active) throw new HttpError(409, 'Nessun modello attivo');
    await pool.query(`UPDATE embedding_models SET thresholds = $2::jsonb WHERE key = $1`, [
      active.key, JSON.stringify({ possible: b.possible, similar: b.similar, calibrated: b.calibrated, note: b.note ?? null, updatedBy: user.id, updatedAt: new Date() }),
    ]);
    return { ok: true };
  });
}
