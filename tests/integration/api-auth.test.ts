// Server-side authorisation, CSRF guard and session handling through the real Fastify app.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from '../../src/db/pool.ts';
import { buildApp } from '../../src/server/app.ts';
import { hashPassword } from '../../src/server/auth.ts';
import { createFsStorage, setStorageForTests } from '../../src/storage/index.ts';
import sharp from 'sharp';
import { createSupplier, importCsv, resetDatabase, row } from '../helpers.ts';

let app: FastifyInstance;
const PW = 'password-di-test-lunga';

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'fetch' }, payload: { email, password: PW } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0];
}

/** A session created directly (like a login would): tests that are not about logging in must not use up the login rate limit. */
async function sessionCookie(email: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) SELECT $1, id, now() + interval '1 hour' FROM users WHERE email = $2`,
    [createHash('sha256').update(token).digest('hex'), email],
  );
  return `pc_session=${token}`;
}

beforeAll(async () => {
  await resetDatabase();
  for (const [email, role] of [['admin@test.local', 'admin'], ['op@test.local', 'operator']]) {
    await pool.query(`INSERT INTO users (email, display_name, role, password_hash) VALUES ($1, $2, $3, $4)`, [email, email, role, await hashPassword(PW)]);
  }
  const s = await createSupplier('alfa');
  await importCsv({ supplierId: s.id, rows: [row({ SKU: 'A1', EAN: '4006381333931' })] });
  app = await buildApp({ logger: false });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('authentication', () => {
  it('rejects anonymous access to data and images', async () => {
    for (const url of ['/api/products', '/api/suppliers', '/api/imports', '/api/images/00000000-0000-0000-0000-000000000000/thumb']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('gives the same message for unknown user and wrong password', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'fetch' }, payload: { email: 'nobody@test.local', password: 'x' } });
    const b = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'fetch' }, payload: { email: 'op@test.local', password: 'wrong' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error).toBe(b.json().error);
  });

  it('sets an httpOnly SameSite cookie and never stores the raw token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'fetch' }, payload: { email: 'op@test.local', password: PW } });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const token = cookie.split(';')[0].split('=')[1];
    const stored = (await pool.query(`SELECT count(*)::int n FROM sessions WHERE token_hash = $1`, [token])).rows[0].n;
    expect(stored).toBe(0);
  });
});

describe('authorisation by role (server side)', () => {
  it('operator can read the catalogue but not administer', async () => {
    const cookie = await login('op@test.local');
    const h = { cookie, 'x-requested-with': 'fetch' };
    expect((await app.inject({ method: 'GET', url: '/api/products', headers: h })).statusCode).toBe(200);
    const pid = (await pool.query(`SELECT id FROM products LIMIT 1`)).rows[0].id;
    const forbidden = [
      { method: 'POST', url: '/api/suppliers', payload: { code: 'x1', name: 'X' } },
      { method: 'GET', url: '/api/admin/status' },
      { method: 'GET', url: '/api/users' },
      { method: 'PATCH', url: `/api/products/${pid}/overrides`, payload: { title: 'hack' } },
      { method: 'POST', url: `/api/products/${pid}/merge`, payload: { sourceProductId: pid } },
      { method: 'PATCH', url: '/api/admin/vision/thresholds', payload: { possible: 0.1, similar: 0.1, calibrated: true } },
    ] as const;
    for (const r of forbidden) {
      const res = await app.inject({ method: r.method, url: r.url, headers: h, payload: 'payload' in r ? r.payload : undefined });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
  });

  it('admin can administer', async () => {
    const cookie = await login('admin@test.local');
    expect((await app.inject({ method: 'GET', url: '/api/admin/status', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } })).statusCode).toBe(200);
  });

  it('a deactivated user loses access immediately', async () => {
    const cookie = await login('op@test.local');
    await pool.query(`UPDATE users SET active = false WHERE email = 'op@test.local'`);
    expect((await app.inject({ method: 'GET', url: '/api/products', headers: { cookie } })).statusCode).toBe(401);
    await pool.query(`UPDATE users SET active = true WHERE email = 'op@test.local'`);
  });
});

describe('CSRF guard', () => {
  it('rejects state-changing requests without the custom header or from another origin', async () => {
    const cookie = await login('admin@test.local');
    const noHeader = await app.inject({ method: 'POST', url: '/api/suppliers', headers: { cookie }, payload: { code: 'x2', name: 'X' } });
    expect(noHeader.statusCode).toBe(403);
    const evil = await app.inject({
      method: 'POST', url: '/api/suppliers', headers: { cookie, 'x-requested-with': 'fetch', origin: 'https://evil.example' }, payload: { code: 'x3', name: 'X' },
    });
    expect(evil.statusCode).toBe(403);
    expect((await pool.query(`SELECT count(*)::int n FROM suppliers WHERE code IN ('x2', 'x3')`)).rows[0].n).toBe(0);
  });
});

describe('input validation', () => {
  it('answers 404 for a malformed id in the URL and 400 with Italian details for a bad payload', async () => {
    const cookie = await login('admin@test.local');
    const missing = await app.inject({ method: 'GET', url: '/api/products/not-a-uuid', headers: { cookie } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('Risorsa non trovata');
    const bad = await app.inject({ method: 'POST', url: '/api/suppliers', headers: { cookie, 'x-requested-with': 'fetch' }, payload: { code: 'BAD CODE', name: '' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.join(' ')).not.toMatch(/Invalid|Too small/);
  });

  it('applies the CSRF guard to percent-encoded API paths too', async () => {
    const cookie = await sessionCookie('admin@test.local');
    const res = await app.inject({ method: 'POST', url: '/%61pi/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
  });

  it('maps database constraint violations to client errors, not 500', async () => {
    const cookie = await sessionCookie('admin@test.local');
    const res = await app.inject({
      method: 'POST', url: '/api/categories', headers: { cookie, 'x-requested-with': 'fetch' },
      payload: { name: 'Figlia di nessuno', parentId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('photo search resilience', () => {
  it('answers with an error, and keeps the process alive, when the storage fails at the start of a search', async () => {
    const cookie = await sessionCookie('op@test.local');
    const fs = createFsStorage('.data/test-storage');
    // Storage down: the photo upload fails immediately, while the other stages are still starting.
    setStorageForTests({
      put: () => Promise.reject(new Error('storage down')),
      get: (k) => fs.get(k), exists: (k) => fs.exists(k), delete: (k) => fs.delete(k), list: (p) => fs.list(p), check: (c) => fs.check(c),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c33' } }).jpeg().toBuffer();
      const boundary = '----audit-photo';
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="foto.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        image,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await app.inject({
        method: 'POST', url: '/api/search/photo', payload,
        headers: { cookie, 'x-requested-with': 'fetch', 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      await new Promise((r) => setTimeout(r, 200)); // let any stray rejection surface
      expect(res.statusCode).toBe(500);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      setStorageForTests(fs);
    }
  });
});
