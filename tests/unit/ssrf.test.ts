import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { hostAllowed, isPublicAddress, safeFetch } from '../../src/images/safe-fetch.ts';

describe('SSRF protection', () => {
  it('classifies private, loopback, link-local, metadata and mapped addresses as non-public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::10.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['8.8.8.8', '151.101.1.69', '2a00:1450:4001:80b::200e']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('matches supplier host allowlists exactly or by subdomain', () => {
    expect(hostAllowed('cdn.fornitore.it', ['fornitore.it'])).toBe(true);
    expect(hostAllowed('fornitore.it', ['fornitore.it'])).toBe(true);
    expect(hostAllowed('evilfornitore.it', ['fornitore.it'])).toBe(false);
    expect(hostAllowed('fornitore.it.evil.com', ['fornitore.it'])).toBe(false);
    expect(hostAllowed('anything.example', [])).toBe(true);
  });

  it('refuses non-http schemes, credentials in URLs and internal targets', async () => {
    expect(await safeFetch('file:///etc/passwd', { allowlist: [] })).toMatchObject({ kind: 'permanent' });
    expect(await safeFetch('http://user:pw@example.com/a.jpg', { allowlist: [] })).toMatchObject({ kind: 'permanent' });
    const r = await safeFetch('http://169.254.169.254/latest/meta-data/', { allowlist: [] });
    expect(r).toMatchObject({ kind: 'permanent' });
    if (r.kind === 'permanent') expect(r.reason).toMatch(/SSRF/);
    expect(await safeFetch('http://localhost:1/x.jpg', { allowlist: [] })).toMatchObject({ kind: 'permanent' });
  });

  it('re-validates redirects: an allowed hop cannot bounce to an internal address', async () => {
    // A local server (allowed only via the dev escape hatch 127.0.0.1:47123) redirecting to the metadata IP.
    const server = http.createServer((_req, res) => res.writeHead(302, { location: 'http://169.254.169.254/latest/' }).end());
    await new Promise<void>((r) => server.listen(47123, '127.0.0.1', r));
    try {
      const r = await safeFetch('http://127.0.0.1:47123/img.jpg', { allowlist: [] });
      expect(r.kind).toBe('permanent');
      if (r.kind === 'permanent') expect(r.reason).toMatch(/SSRF/);
    } finally {
      server.close();
    }
  });
});
