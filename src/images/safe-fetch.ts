// SSRF-safe HTTP(S) download for supplier image URLs.
// - only http/https, no credentials in URL
// - optional per-supplier host allowlist (exact host or subdomain)
// - DNS resolved once; EVERY resolved address must be public; the socket connects to that pinned address
//   (no second resolution -> no DNS rebinding); redirects re-validated hop by hop (max 3)
// - size and time limits; content type is not trusted (the caller sniffs the bytes)
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { config, isProduction } from '../config.ts';

export type FetchOutcome =
  | { kind: 'ok'; bytes: Buffer; finalUrl: string; contentType: string | null }
  | { kind: 'permanent'; reason: string }
  | { kind: 'transient'; reason: string };

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['2001::', 32],
] as const) blocked.addSubnet(addr, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]+:[0-9a-f]+$/.test(lower) || lower.startsWith('64:ff9b:')) return false; // hex-form mapped/NAT64: refuse
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

export function hostAllowed(host: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) => {
    const e = entry.toLowerCase().trim().replace(/^\*\./, '').replace(/\.$/, '');
    return e && (h === e || h.endsWith(`.${e}`));
  });
}

function devAllowed(url: URL): boolean {
  if (isProduction || !config.IMAGE_FETCH_DEV_ALLOW) return false;
  const hostPort = `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  return config.IMAGE_FETCH_DEV_ALLOW.split(',').map((s) => s.trim()).includes(hostPort);
}

export interface SafeFetchOptions {
  allowlist: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<FetchOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'permanent', reason: 'URL non valido' };
  }
  const maxRedirects = opts.maxRedirects ?? 3;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await resolveTarget(url, opts.allowlist);
    if ('reason' in check) return { kind: 'permanent', reason: check.reason };
    const res = await request(url, check.address, check.family, opts);
    if (res.kind === 'redirect') {
      try {
        url = new URL(res.location, url);
      } catch {
        return { kind: 'permanent', reason: 'Redirect verso URL non valido' };
      }
      continue;
    }
    return res;
  }
  return { kind: 'permanent', reason: 'Troppi redirect' };
}

async function resolveTarget(url: URL, allowlist: string[]): Promise<{ address: string; family: 4 | 6 } | { reason: string }> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { reason: 'Schema non consentito' };
  if (url.username || url.password) return { reason: 'Credenziali nell’URL non consentite' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostAllowed(host, allowlist)) return { reason: `Host ${host} non presente tra gli host immagini autorizzati del fornitore` };
  const dev = devAllowed(url);
  let addresses: Array<{ address: string; family: number }>;
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
  else {
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      return { reason: `Host ${host} non risolvibile` };
    }
  }
  if (!addresses.length) return { reason: `Host ${host} non risolvibile` };
  if (!dev && addresses.some((a) => !isPublicAddress(a.address))) return { reason: 'Indirizzo interno o riservato: download bloccato (protezione SSRF)' };
  return { address: addresses[0].address, family: addresses[0].family === 6 ? 6 : 4 };
}

function request(
  url: URL,
  address: string,
  family: 4 | 6,
  opts: SafeFetchOptions,
): Promise<FetchOutcome | { kind: 'redirect'; location: string }> {
  const maxBytes = opts.maxBytes ?? config.IMAGE_FETCH_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? config.IMAGE_FETCH_TIMEOUT_MS;
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: { 'user-agent': 'ProductsComparator/0.1 (catalogo B2B interno)', accept: 'image/avif,image/webp,image/*;q=0.9,*/*;q=0.5' },
        // Pin the connection to the validated address; TLS still verifies the certificate for url.hostname.
        lookup: (_host: string, o: { all?: boolean } | undefined, cb: (err: Error | null, a: any, f?: number) => void) =>
          o?.all ? cb(null, [{ address, family }]) : cb(null, address, family),
        timeout: timeoutMs,
      } as any,
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ kind: 'redirect', location: res.headers.location });
          return;
        }
        if (status === 429 || status >= 500 || status === 408) {
          res.resume();
          resolve({ kind: 'transient', reason: `HTTP ${status}` });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ kind: 'permanent', reason: `HTTP ${status}` });
          return;
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > maxBytes) {
          res.destroy();
          resolve({ kind: 'permanent', reason: `File troppo grande (${declared} byte)` });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            resolve({ kind: 'permanent', reason: 'File troppo grande' });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ kind: 'ok', bytes: Buffer.concat(chunks), finalUrl: url.toString(), contentType: (res.headers['content-type'] as string) ?? null }));
        res.on('error', (e) => resolve({ kind: 'transient', reason: e.message }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ kind: 'transient', reason: 'Timeout' });
    });
    req.on('error', (e) => resolve({ kind: 'transient', reason: e.message }));
    req.end();
  });
}
