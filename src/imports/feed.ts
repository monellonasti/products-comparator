// Generic scheduled supplier feed: downloads a CSV/XLSX price list from an HTTP(S) URL and runs it through
// the SAME import pipeline as manual uploads, using the supplier's saved column mapping. Not tied to any
// supplier-specific API (see connectors.ts for the extension point).
//
// Secrets (feed URL, which often embeds a token, and credentials) are encrypted in supplier_secrets and
// never returned to the browser nor written to logs; error messages only mention the URL's host/path.
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.ts';
import { pool, withTx, type Db } from '../db/pool.ts';
import { decryptSecret, encryptSecret, parseKey } from '../lib/secrets.ts';
import { isValidTimeZone, nextRun, type FeedSchedule } from '../lib/schedule.ts';
import { safeFetch } from '../images/safe-fetch.ts';
import { recordAudit, type Actor } from '../domain/audit.ts';
import { enqueue } from '../jobs/queue.ts';
import { createUploadRun, startRun, ImportRequestError, type InspectResult } from './service.ts';
import { parseImportFile, detectFileKind, ImportFileError } from './parsers.ts';
import { mappedColumns, type ColumnMapping } from './fields.ts';

export const HTTP_FEED = 'http_feed';
export const MAX_RETRIES = 3;
const RETRY_BASE_MINUTES = 30;
const POSTPONE_MINUTES = 15;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie', 'user-agent', 'accept', 'te', 'upgrade']);

export const feedInputSchema = z.object({
  enabled: z.boolean(),
  /** Write-only: present = replace the stored URL. */
  url: z.string().url().max(2000).optional(),
  auth: z.object({
    type: z.enum(['none', 'basic', 'bearer', 'header']),
    username: z.string().max(200).optional(),
    password: z.string().max(500).optional(),
    token: z.string().max(4000).optional(),
    headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Nome header non valido').optional(),
    headerValue: z.string().max(4000).optional(),
  }),
  schedule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('daily'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Orario HH:MM'), timezone: z.string().max(64) }),
    z.object({ kind: z.literal('hourly'), everyHours: z.number().int().min(1).max(24) }),
  ]),
  mode: z.enum(['snapshot', 'delta']),
});
export type FeedInput = z.infer<typeof feedInputSchema>;

/** Non-secret part of the configuration, stored in suppliers.connector_config. */
export interface FeedConfig {
  urlDisplay: string;
  authType: 'none' | 'basic' | 'bearer' | 'header';
  headerName: string | null;
  schedule: FeedSchedule;
  mode: 'snapshot' | 'delta';
}

type SecretName = 'url' | 'username' | 'password' | 'token' | 'header_value';

export class FeedError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Origin + path, query hidden: safe to show and log (tokens usually travel in the query string). */
export function displayUrl(raw: string): string {
  const u = new URL(raw);
  return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
}

const aad = (supplierId: string, name: SecretName) => `${supplierId}:${name}`;

async function readSecrets(db: Db, supplierId: string): Promise<Partial<Record<SecretName, string>>> {
  const key = parseKey(config.SECRETS_KEY);
  const rows = (await db.query(`SELECT name, ciphertext FROM supplier_secrets WHERE supplier_id = $1`, [supplierId])).rows;
  const out: Partial<Record<SecretName, string>> = {};
  for (const r of rows) out[r.name as SecretName] = decryptSecret(key, r.ciphertext, aad(supplierId, r.name));
  return out;
}

export async function secretFlags(db: Db, supplierId: string): Promise<Record<SecretName, boolean>> {
  const names = new Set((await db.query(`SELECT name FROM supplier_secrets WHERE supplier_id = $1`, [supplierId])).rows.map((r) => r.name));
  return { url: names.has('url'), username: names.has('username'), password: names.has('password'), token: names.has('token'), header_value: names.has('header_value') };
}

export async function saveFeedConfig(supplierId: string, input: FeedInput, actor: Actor): Promise<void> {
  const key = parseKey(config.SECRETS_KEY);
  if (input.schedule.kind === 'daily' && !isValidTimeZone(input.schedule.timezone)) throw new FeedError('Fuso orario non valido');
  await withTx(async (tx) => {
    const s = (await tx.query(`SELECT * FROM suppliers WHERE id = $1 FOR UPDATE`, [supplierId])).rows[0];
    if (!s) throw new FeedError('Fornitore non trovato', 404);
    const stored = await secretFlags(tx, supplierId);
    const put = async (name: SecretName, value: string) =>
      tx.query(
        `INSERT INTO supplier_secrets (supplier_id, name, ciphertext) VALUES ($1, $2, $3)
         ON CONFLICT (supplier_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
        [supplierId, name, encryptSecret(key, value, aad(supplierId, name))],
      );
    const drop = async (names: SecretName[]) => tx.query(`DELETE FROM supplier_secrets WHERE supplier_id = $1 AND name = ANY($2::text[])`, [supplierId, names]);

    let urlDisplay: string = (s.connector_config?.urlDisplay as string) ?? '';
    let protocol = urlDisplay ? new URL(urlDisplay.replace('?…', '')).protocol : '';
    if (input.url) {
      const u = new URL(input.url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FeedError('Sono ammessi solo URL http/https');
      if (u.username || u.password) throw new FeedError('Non inserire credenziali nell’URL: usare l’autenticazione Basic');
      await put('url', u.toString());
      urlDisplay = displayUrl(u.toString());
      protocol = u.protocol;
    } else if (!stored.url && input.enabled) {
      throw new FeedError('Indicare l’URL del feed');
    }

    const a = input.auth;
    const need = (name: SecretName, value: string | undefined, label: string) => {
      if (value) return put(name, value);
      if (!stored[name]) throw new FeedError(`${label} obbligatorio per questo tipo di autenticazione`);
      return Promise.resolve();
    };
    if (a.type === 'none') await drop(['username', 'password', 'token', 'header_value']);
    if (a.type === 'basic') {
      await need('username', a.username, 'Utente');
      await need('password', a.password, 'Password');
      await drop(['token', 'header_value']);
    }
    if (a.type === 'bearer') {
      await need('token', a.token, 'Token');
      await drop(['username', 'password', 'header_value']);
    }
    if (a.type === 'header') {
      if (!a.headerName || FORBIDDEN_HEADERS.has(a.headerName.toLowerCase())) throw new FeedError('Nome header mancante o non consentito');
      await need('header_value', a.headerValue, 'Valore header');
      await drop(['username', 'password', 'token']);
    }
    if (a.type !== 'none' && protocol === 'http:') throw new FeedError('Le credenziali possono essere inviate solo su HTTPS');

    const cfg: FeedConfig = {
      urlDisplay, authType: a.type, headerName: a.type === 'header' ? a.headerName ?? null : null, schedule: input.schedule, mode: input.mode,
    };
    await tx.query(
      `UPDATE suppliers SET connector_kind = $2, connector_config = $3::jsonb, feed_enabled = $4, feed_next_run_at = $5,
              feed_consecutive_failures = CASE WHEN $4 THEN feed_consecutive_failures ELSE 0 END, updated_at = now()
        WHERE id = $1`,
      [supplierId, HTTP_FEED, JSON.stringify(cfg), input.enabled, input.enabled ? nextRun(input.schedule) : null],
    );
    await recordAudit(tx, {
      actor, action: 'supplier.feed_configured', entityType: 'supplier', entityId: supplierId,
      data: { enabled: input.enabled, urlDisplay, authType: a.type, schedule: input.schedule, mode: input.mode, urlChanged: !!input.url },
    });
  });
}

interface LoadedFeed {
  supplier: any;
  cfg: FeedConfig;
  url: string;
  headers: Record<string, string>;
}

async function loadFeed(supplierId: string): Promise<LoadedFeed> {
  const supplier = (await pool.query(`SELECT * FROM suppliers WHERE id = $1`, [supplierId])).rows[0];
  if (!supplier) throw new FeedError('Fornitore non trovato', 404);
  if (supplier.connector_kind !== HTTP_FEED) throw new FeedError('Feed non configurato per questo fornitore');
  const cfg = supplier.connector_config as FeedConfig;
  const secrets = await readSecrets(pool, supplierId);
  if (!secrets.url) throw new FeedError('URL del feed non configurato');
  const headers: Record<string, string> = {};
  if (cfg.authType === 'basic') headers.authorization = `Basic ${Buffer.from(`${secrets.username ?? ''}:${secrets.password ?? ''}`).toString('base64')}`;
  if (cfg.authType === 'bearer') headers.authorization = `Bearer ${secrets.token ?? ''}`;
  if (cfg.authType === 'header' && cfg.headerName) headers[cfg.headerName.toLowerCase()] = secrets.header_value ?? '';
  return { supplier, cfg, url: secrets.url, headers };
}

export interface Downloaded {
  bytes: Buffer;
  fileName: string;
}

/** SSRF-safe download with size/time limits; credentials only to the configured origin. */
export async function downloadFeed(feed: LoadedFeed): Promise<Downloaded> {
  const res = await safeFetch(feed.url, {
    allowlist: [],
    maxBytes: config.UPLOAD_MAX_IMPORT_BYTES,
    timeoutMs: config.FEED_TIMEOUT_MS,
    maxRedirects: 5,
    accept: 'text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain;q=0.8,*/*;q=0.5',
    credentialHeaders: feed.headers,
  });
  if (res.kind !== 'ok') throw new FeedError(`Download del feed ${feed.cfg.urlDisplay} non riuscito: ${res.reason}`, 502);
  if (!res.bytes.length) throw new FeedError(`Il feed ${feed.cfg.urlDisplay} ha restituito un file vuoto`, 502);
  const base = decodeURIComponent(path.posix.basename(new URL(feed.url).pathname)).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return { bytes: res.bytes, fileName: `feed-${stamp}-${base || feed.supplier.code}` };
}

async function loadProfile(supplierId: string) {
  return (await pool.query(`SELECT * FROM import_profiles WHERE supplier_id = $1 AND name = 'default'`, [supplierId])).rows[0] ?? null;
}

/** "Prova feed": download and read the header only, no import. */
export async function testFeed(supplierId: string) {
  const feed = await loadFeed(supplierId);
  const t0 = Date.now();
  const file = await downloadFeed(feed);
  let kind: 'csv' | 'xlsx';
  try {
    kind = detectFileKind(file.fileName, file.bytes);
  } catch (err) {
    throw new FeedError((err as Error).message);
  }
  const profile = await loadProfile(supplierId);
  let parsed;
  try {
    parsed = await parseImportFile(kind, file.bytes, profile?.file_kind === kind ? profile.parse_options : {}, 5);
  } catch (err) {
    if (err instanceof ImportFileError) throw new FeedError(err.message);
    throw err;
  }
  const missing = profile ? mappedColumns(profile.mapping as ColumnMapping).filter((c) => !parsed.headers.includes(c)) : [];
  return {
    ok: true,
    urlDisplay: feed.cfg.urlDisplay,
    bytes: file.bytes.length,
    downloadMs: Date.now() - t0,
    fileKind: kind,
    headers: parsed.headers,
    sample: parsed.rows.slice(0, 3).map((r) => r.values),
    hasMapping: !!profile,
    missingMappedColumns: missing,
  };
}

/** Download the feed into an 'uploaded' import run so the admin can configure the mapping in the wizard. */
export async function sampleFeedForWizard(supplierId: string, userId: string): Promise<InspectResult> {
  const feed = await loadFeed(supplierId);
  const file = await downloadFeed(feed);
  return createUploadRun({ supplierId, fileName: file.fileName, bytes: file.bytes, userId, sourceKind: 'feed' });
}

export type FeedOutcome = 'queued' | 'failed' | 'postponed' | 'no_mapping' | 'skipped';

/** Scheduled or manual feed execution (worker task). Never throws for supplier-side problems. */
export async function runFeed(supplierId: string, trigger: 'schedule' | 'manual', log: (m: string) => void = () => {}): Promise<FeedOutcome> {
  let feed: LoadedFeed;
  try {
    feed = await loadFeed(supplierId);
  } catch (err) {
    log(`feed ${supplierId}: ${(err as Error).message}`);
    return 'skipped';
  }
  const s = feed.supplier;
  if (!s.active || (trigger === 'schedule' && !s.feed_enabled)) return 'skipped';
  const scheduled = () => (s.feed_enabled ? nextRun(feed.cfg.schedule) : null);
  const setState = (status: FeedOutcome, extra: { error?: string | null; next?: Date | null; runId?: string | null; failures?: number }) =>
    pool.query(
      `UPDATE suppliers SET feed_last_checked_at = now(), feed_last_status = $2, feed_last_error = $3, feed_next_run_at = $4,
              feed_last_run_id = coalesce($5, feed_last_run_id), feed_consecutive_failures = coalesce($6, feed_consecutive_failures), updated_at = now()
        WHERE id = $1`,
      [supplierId, status, extra.error ?? null, extra.next ?? null, extra.runId ?? null, extra.failures ?? null],
    );

  const profile = await loadProfile(supplierId);
  if (!profile) {
    await setState('no_mapping', { error: 'Mappatura delle colonne non configurata: usare "Configura mappatura dal feed"', next: scheduled() });
    return 'no_mapping';
  }
  const busy = (await pool.query(`SELECT 1 FROM import_runs WHERE supplier_id = $1 AND status IN ('queued', 'running')`, [supplierId])).rowCount;
  if (busy) {
    await setState('postponed', { error: 'Import già in corso: feed rinviato', next: new Date(Date.now() + POSTPONE_MINUTES * 60_000) });
    return 'postponed';
  }

  let file: Downloaded;
  try {
    file = await downloadFeed(feed);
  } catch (err) {
    const failures = (s.feed_consecutive_failures ?? 0) + 1;
    const retry = failures <= MAX_RETRIES ? new Date(Date.now() + RETRY_BASE_MINUTES * failures * 60_000) : scheduled();
    const message = `${(err as Error).message}${failures <= MAX_RETRIES ? ` (nuovo tentativo ${failures}/${MAX_RETRIES})` : ''}`;
    await setState('failed', { error: message, next: retry, failures });
    // The supplier's data is now not confirmed: offers are shown as not up to date.
    await pool.query(`UPDATE suppliers SET last_import_status = 'failed', last_import_finished_at = now() WHERE id = $1`, [supplierId]);
    log(`feed ${s.code}: ${message}`);
    return 'failed';
  }

  let runId: string | null = null;
  try {
    const up = await createUploadRun({ supplierId, fileName: file.fileName, bytes: file.bytes, userId: null, sourceKind: 'feed' });
    runId = up.run.id;
    await startRun(runId, {
      mapping: profile.mapping, defaults: profile.defaults, parseOptions: profile.parse_options, mode: feed.cfg.mode, asOf: new Date(), saveProfile: false,
    });
  } catch (err) {
    if (runId) await pool.query(`UPDATE import_runs SET status = 'cancelled', finished_at = now(), error = $2 WHERE id = $1 AND status = 'uploaded'`, [runId, (err as Error).message]);
    if (err instanceof ImportRequestError && err.status === 409) {
      await setState('postponed', { error: 'Import già in corso: feed rinviato', next: new Date(Date.now() + POSTPONE_MINUTES * 60_000) });
      return 'postponed';
    }
    const failures = (s.feed_consecutive_failures ?? 0) + 1;
    await setState('failed', { error: (err as Error).message, next: failures <= MAX_RETRIES ? new Date(Date.now() + RETRY_BASE_MINUTES * failures * 60_000) : scheduled(), failures });
    await pool.query(`UPDATE suppliers SET last_import_status = 'failed', last_import_finished_at = now() WHERE id = $1`, [supplierId]);
    return 'failed';
  }
  await setState('queued', { error: null, next: scheduled(), runId, failures: 0 });
  log(`feed ${s.code}: import ${runId} queued`);
  return 'queued';
}

/** Cron tick: claims due feeds (so each is enqueued once) and enqueues their execution. */
export async function feedsTick(): Promise<number> {
  return withTx(async (tx) => {
    const due = (
      await tx.query(
        `SELECT id FROM suppliers WHERE feed_enabled AND active AND connector_kind = $1 AND feed_next_run_at <= now()
          ORDER BY feed_next_run_at FOR UPDATE SKIP LOCKED LIMIT 50`,
        [HTTP_FEED],
      )
    ).rows;
    for (const d of due) {
      // Claim: if the job never runs (worker crash) the tick retries after an hour.
      await tx.query(`UPDATE suppliers SET feed_next_run_at = now() + interval '1 hour' WHERE id = $1`, [d.id]);
      await enqueue(tx, 'feed_fetch', { supplierId: d.id, trigger: 'schedule' }, { jobKey: `feed_fetch:${d.id}`, maxAttempts: 1 });
    }
    return due.length;
  });
}

export async function requestFeedRun(supplierId: string) {
  await enqueue(pool, 'feed_fetch', { supplierId, trigger: 'manual' }, { jobKey: `feed_fetch:${supplierId}`, maxAttempts: 1 });
}
