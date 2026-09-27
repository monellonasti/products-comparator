// Enqueue background jobs through SQL so they are added in the SAME transaction as the data change
// (no lost or orphan jobs). Tasks are implemented in src/worker/tasks.ts and must be idempotent.
import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.ts';
import { config } from '../config.ts';

export type TaskName =
  | 'import_run'
  | 'image_fetch'
  | 'image_embed'
  | 'products_refresh'
  | 'suggest_matches'
  | 'maintenance'
  | 'reindex_model'
  | 'feeds_tick'
  | 'feed_fetch';

export interface EnqueueOptions {
  queueName?: string;
  jobKey?: string;
  jobKeyMode?: 'replace' | 'preserve_run_at' | 'unsafe_dedupe';
  maxAttempts?: number;
  runAt?: Date;
  priority?: number;
}

export async function enqueue(db: Db, task: TaskName, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<void> {
  const args: string[] = ['identifier => $1', 'payload => $2::json'];
  const params: unknown[] = [task, JSON.stringify(payload)];
  const add = (name: string, value: unknown, cast: string) => {
    params.push(value);
    args.push(`${name} => $${params.length}::${cast}`);
  };
  if (opts.queueName) add('queue_name', opts.queueName, 'text');
  if (opts.runAt) add('run_at', opts.runAt.toISOString(), 'timestamptz');
  if (opts.maxAttempts) add('max_attempts', opts.maxAttempts, 'int');
  if (opts.jobKey) add('job_key', opts.jobKey, 'text');
  if (opts.priority !== undefined) add('priority', opts.priority, 'int');
  if (opts.jobKeyMode) add('job_key_mode', opts.jobKeyMode, 'text');
  await db.query(`SELECT graphile_worker.add_job(${args.join(', ')})`, params);
}

function shard(value: string, shards: number): number {
  return createHash('sha1').update(value).digest().readUInt32BE(0) % shards;
}

/** Downloads are serialised per host (at most IMAGE_FETCH_PER_HOST in parallel for the same host). */
export function fetchQueueFor(url: string): string {
  let host = 'invalid';
  try {
    host = new URL(url).host.toLowerCase();
  } catch {}
  return `fetch:${host}:${shard(url, config.IMAGE_FETCH_PER_HOST)}`;
}

/** Inference is CPU-bound: embeddings run in a bounded number of serial queues. */
export function embedQueueFor(assetId: string): string {
  return `embed:${shard(assetId, config.EMBED_QUEUE_SHARDS)}`;
}

export async function enqueueImageFetch(db: Db, sourceId: string, url: string) {
  await enqueue(db, 'image_fetch', { sourceId }, { queueName: fetchQueueFor(url), jobKey: `image_fetch:${sourceId}`, maxAttempts: 6 });
}

export async function enqueueEmbed(db: Db, assetId: string, modelKey: string) {
  await enqueue(db, 'image_embed', { assetId, modelKey }, {
    queueName: embedQueueFor(assetId), jobKey: `image_embed:${modelKey}:${assetId}`, maxAttempts: 4, priority: 5,
  });
}

export async function enqueueProductsRefresh(db: Db, productIds: string[]) {
  if (!productIds.length) return;
  await enqueue(db, 'products_refresh', { productIds }, { maxAttempts: 10 });
}
