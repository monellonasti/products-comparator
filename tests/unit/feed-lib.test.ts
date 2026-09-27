import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { nextRun, zonedTimeToUtc } from '../../src/lib/schedule.ts';
import { decryptSecret, encryptSecret, parseKey } from '../../src/lib/secrets.ts';
import { diffOffer, priceChangePct, type OfferCommercialState } from '../../src/domain/changes.ts';
import { safeFetch } from '../../src/images/safe-fetch.ts';

describe('feed schedule', () => {
  const daily = { kind: 'daily' as const, time: '06:00', timezone: 'Europe/Rome' };

  it('runs today at the wall-clock time when still ahead, otherwise tomorrow', () => {
    expect(nextRun(daily, new Date('2026-09-25T02:00:00Z')).toISOString()).toBe('2026-09-25T04:00:00.000Z'); // 06:00 CEST
    expect(nextRun(daily, new Date('2026-09-25T04:00:00Z')).toISOString()).toBe('2026-09-26T04:00:00.000Z'); // strictly after
  });

  it('follows daylight saving changes (06:00 local stays 06:00 local)', () => {
    // Europe/Rome leaves DST on 2026-10-25: 06:00 is 04:00Z before and 05:00Z after.
    expect(nextRun(daily, new Date('2026-10-24T12:00:00Z')).toISOString()).toBe('2026-10-25T05:00:00.000Z');
    // Enters DST on 2026-03-29.
    expect(nextRun(daily, new Date('2026-03-28T12:00:00Z')).toISOString()).toBe('2026-03-29T04:00:00.000Z');
  });

  it('resolves a non-existent local time (DST gap) to the next valid instant', () => {
    // 02:30 does not exist in Rome on 2026-03-29 (02:00 -> 03:00): 03:30 CEST = 01:30Z.
    expect(zonedTimeToUtc(2026, 3, 29, 2, 30, 'Europe/Rome').toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('supports every-N-hours schedules', () => {
    expect(nextRun({ kind: 'hourly', everyHours: 6 }, new Date('2026-09-25T10:00:00Z')).toISOString()).toBe('2026-09-25T16:00:00.000Z');
  });
});

describe('feed secrets', () => {
  const key = randomBytes(32);

  it('round-trips and never contains the plaintext', () => {
    const enc = encryptSecret(key, 'https://feed.example/x.csv?token=S3CR3T', 'sup1:url');
    expect(enc).not.toContain('S3CR3T');
    expect(decryptSecret(key, enc, 'sup1:url')).toBe('https://feed.example/x.csv?token=S3CR3T');
  });

  it('rejects tampering, a wrong key and a ciphertext moved to another supplier (AAD)', () => {
    const enc = encryptSecret(key, 'secret', 'sup1:token');
    expect(() => decryptSecret(key, enc, 'sup2:token')).toThrow();
    expect(() => decryptSecret(randomBytes(32), enc, 'sup1:token')).toThrow();
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(key, parts.join('.'), 'sup1:token')).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => parseKey(undefined)).toThrow(/SECRETS_KEY/);
    expect(() => parseKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 byte/);
    expect(parseKey(key.toString('base64')).length).toBe(32);
  });
});

describe('change detection', () => {
  const base: OfferCommercialState = {
    price: '10.0000', currency: 'EUR', vatTreatment: 'net', unitsPerPack: 1, stockQuantity: 5, stockStatus: 'in_stock',
    imageUrls: ['https://i/a.jpg'], gtin: '04006381333931',
  };

  it('reports a comparable price change with its percentage', () => {
    const c = diffOffer('o', 'p', base, { ...base, price: '12.0000' }, { compareImages: true });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ type: 'price', pct: '20.00' });
    expect(priceChangePct('10.0000', '9.2500')).toBe('-7.50');
  });

  it('does not compute a percentage when pack size, VAT or currency changed', () => {
    const c = diffOffer('o', 'p', base, { ...base, price: '50.0000', unitsPerPack: 5 }, { compareImages: true });
    expect(c[0]).toMatchObject({ type: 'price', pct: null });
  });

  it('distinguishes availability transitions from quantity changes', () => {
    expect(diffOffer('o', 'p', base, { ...base, stockQuantity: 0, stockStatus: 'out_of_stock' }, { compareImages: true })[0].type).toBe('availability');
    expect(diffOffer('o', 'p', base, { ...base, stockQuantity: 7 }, { compareImages: true })[0].type).toBe('stock');
    expect(diffOffer('o', 'p', { ...base, stockQuantity: null, stockStatus: 'unknown' }, { ...base, stockQuantity: null, stockStatus: 'unknown' }, { compareImages: true })).toEqual([]);
  });

  it('reports added/removed images only when the file maps image columns', () => {
    const after = { ...base, imageUrls: ['https://i/b.jpg'] };
    const c = diffOffer('o', 'p', base, after, { compareImages: true });
    expect(c[0]).toMatchObject({ type: 'images', oldValue: { removed: ['https://i/a.jpg'] }, newValue: { added: ['https://i/b.jpg'] } });
    expect(diffOffer('o', 'p', base, { ...base, imageUrls: [] }, { compareImages: false })).toEqual([]);
  });

  it('treats equal decimals written differently as unchanged', () => {
    expect(diffOffer('o', 'p', { ...base, price: '10.5' }, { ...base, price: '10.5000' }, { compareImages: true })).toEqual([]);
  });
});

describe('credential headers and redirects', () => {
  it('sends feed credentials only to the configured origin, never to a redirect target', async () => {
    const seen: Array<string | undefined> = [];
    const target = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'text/csv' }).end('a;b\n1;2\n');
    });
    const origin = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(302, { location: 'http://127.0.0.1:47126/file.csv' }).end();
    });
    await new Promise<void>((r) => origin.listen(47125, '127.0.0.1', r));
    await new Promise<void>((r) => target.listen(47126, '127.0.0.1', r));
    try {
      const r = await safeFetch('http://127.0.0.1:47125/feed.csv', { allowlist: [], accept: '*/*', credentialHeaders: { authorization: 'Bearer T0K3N' } });
      expect(r.kind).toBe('ok');
      expect(seen).toEqual(['Bearer T0K3N', undefined]);
    } finally {
      origin.close();
      target.close();
    }
  });
});
