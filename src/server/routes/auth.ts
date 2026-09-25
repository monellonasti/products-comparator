import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.ts';
import { createSession, destroySession, HttpError, requireUser, verifyPassword } from '../auth.ts';

// A constant hash used to keep timing similar when the e-mail does not exist.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(request.body);
    const user = (await pool.query('SELECT * FROM users WHERE email = $1', [body.email])).rows[0];
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || !user.active) {
      request.log.warn({ email: body.email }, 'login failed');
      throw new HttpError(401, 'Email o password non corretti', 'invalid_credentials');
    }
    await createSession(reply, user.id, request.ip, request.headers['user-agent']);
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    return { user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } };
  });

  app.post('/auth/logout', async (request, reply) => {
    await destroySession(request, reply);
    return { ok: true };
  });

  app.get('/auth/me', async (request) => {
    const user = requireUser(request);
    return { user };
  });
}
