// Authentication: scrypt password hashes, opaque session tokens (only their sha256 is stored),
// httpOnly SameSite=Lax cookies. Authorization is enforced server-side on every route by role.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.ts';
import { config, cookieSecure } from '../config.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = 'pc_session';

export type Role = 'admin' | 'operator';
export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 12) return 'La password deve avere almeno 12 caratteri';
  if (password.length > 200) return 'Password troppo lunga';
  return null;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(reply: FastifyReply, userId: string, ip: string, userAgent: string | undefined) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [tokenHash(token), userId, config.SESSION_TTL_HOURS, ip, userAgent?.slice(0, 300) ?? null],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/', maxAge: config.SESSION_TTL_HOURS * 3600,
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[SESSION_COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function loadSessionUser(request: FastifyRequest): Promise<SessionUser | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  const row = (
    await pool.query(
      `UPDATE sessions s SET last_seen_at = now() FROM users u
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id AND u.active
        RETURNING u.id, u.email, u.display_name, u.role`,
      [tokenHash(token)],
    )
  ).rows[0];
  return row ? { id: row.id, email: row.email, displayName: row.display_name, role: row.role } : null;
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new HttpError(401, 'Accesso richiesto', 'unauthenticated');
  return request.user;
}

export function requireRole(request: FastifyRequest, role: Role): SessionUser {
  const user = requireUser(request);
  if (role === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Operazione riservata agli amministratori', 'forbidden');
  return user;
}
