// PostgreSQL access: a single pool plus a transaction helper. Queries are plain parameterised SQL.
import pg from 'pg';
import { config } from '../config.ts';

// NUMERIC stays a string (exact decimals); BIGINT counts are safe as JS numbers for our volumes.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  application_name: process.env.APP_ROLE ?? 'comparator',
});

pool.on('error', (err) => {
  // Idle client errors (e.g. DB restart) must not crash the process; the pool reconnects.
  console.error(JSON.stringify({ level: 'error', msg: 'pg pool idle client error', err: err.message }));
});

export type Db = pg.Pool | pg.PoolClient;
export type Tx = pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(text, params as any[]);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(db: Db, text: string, params: unknown[] = []): Promise<T | null> {
  const res = await db.query<T>(text, params as any[]);
  return res.rows[0] ?? null;
}

/** Runs fn inside a transaction; retries on serialization failures / deadlocks. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>, opts: { retries?: number } = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const retryable = err?.code === '40001' || err?.code === '40P01';
      if (retryable && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

export function vectorLiteral(values: ArrayLike<number>): string {
  const parts = new Array<string>(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) throw new Error('non-finite value in vector');
    parts[i] = String(v);
  }
  return `[${parts.join(',')}]`;
}
