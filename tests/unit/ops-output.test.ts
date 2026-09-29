// Regressions from the 2026-09-29 audit: monitoring output, CSV export, secrets, feed schedule at the
// October DST change, and the total download deadline.
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { metrics } from '../../src/server/metrics.ts';
import { csvCell } from '../../src/lib/csv.ts';
import { decryptSecret, encryptSecret } from '../../src/lib/secrets.ts';
import { nextRun } from '../../src/lib/schedule.ts';
import { safeFetch } from '../../src/images/safe-fetch.ts';

describe('Prometheus output', () => {
  it('keeps labels out of the metric name and emits one TYPE line per family', () => {
    metrics.observe('http_ms{route="/api/a",method="GET"}', 10);
    metrics.observe('http_ms{route="/api/b",method="POST"}', 20);
    metrics.inc('audit_test_total');
    const out = metrics.render({ queue_depth: 3 });
    expect(out.match(/^# TYPE http_ms summary$/gm)).toHaveLength(1);
    expect(out).toContain('http_ms{route="/api/a",method="GET",quantile="0.5"} 10');
    expect(out).toContain('http_ms_sum{route="/api/b",method="POST"} 20');
    expect(out).toContain('http_ms_count{route="/api/a",method="GET"} 1');
    expect(out).toContain('audit_test_total 1');
    expect(out).toContain('queue_depth 3');
    // Every sample line: name{labels} value — no "}{" or "}_sum".
    expect(out).not.toMatch(/\}\{|\}_/);
  });
});

describe('CSV export', () => {
  it('neutralises formulas but leaves numbers (also negative) as numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell('+3')).toBe('+3');
  });
});

describe('secrets', () => {
  it('refuses a ciphertext whose authentication tag was truncated', () => {
    const key = randomBytes(32);
    const enc = encryptSecret(key, 'segreto', 'aad');
    expect(decryptSecret(key, enc, 'aad')).toBe('segreto');
    const [v, iv, tag, ct] = enc.split('.');
    const short = [v, iv, Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url'), ct].join('.');
    expect(() => decryptSecret(key, short, 'aad')).toThrow();
  });
});

describe('feed schedule at the October DST change', () => {
  const at = (time: string) => ({ kind: 'daily' as const, time, timezone: 'Europe/Rome' });
  it('keeps 01:30 at 01:30 local on 2026-10-25 (the clock goes back at 03:00)', () => {
    expect(nextRun(at('01:30'), new Date('2026-10-24T22:00:00Z')).toISOString()).toBe('2026-10-24T23:30:00.000Z');
  });
  it('runs a repeated time (02:30) once, at its first occurrence', () => {
    expect(nextRun(at('02:30'), new Date('2026-10-24T22:00:00Z')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(nextRun(at('02:30'), new Date('2026-10-25T00:31:00Z')).toISOString()).toBe('2026-10-26T01:30:00.000Z');
  });
});

describe('download deadline', () => {
  it('stops a server that trickles data, even though the socket is never idle', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv' });
      const t = setInterval(() => res.write('x'), 100);
      res.on('close', () => clearInterval(t));
    });
    await new Promise<void>((r) => server.listen(47128, '127.0.0.1', r));
    try {
      const started = Date.now();
      const r = await safeFetch('http://127.0.0.1:47128/slow.csv', { allowlist: [], accept: '*/*', timeoutMs: 800 });
      expect(r).toMatchObject({ kind: 'transient', reason: 'Timeout' });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
