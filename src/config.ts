// Runtime configuration from environment variables (see .env.example). Parsed once, validated with zod.
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('127.0.0.1'),
  PUBLIC_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  COOKIE_SECURE: bool.optional(),

  STORAGE_DRIVER: z.enum(['s3', 'fs']).default('s3'),
  STORAGE_FS_ROOT: z.string().default('.data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('comparator'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),

  VISION_ENABLED: bool.default(true),
  VISION_MODEL: z.string().default('siglip2-base-p16-224'),
  VISION_THREADS: z.coerce.number().int().positive().default(2),
  // Parallel inferences per process (each uses VISION_THREADS intra-op threads). Keep THREADS x CONCURRENCY <= vCPU.
  VISION_CONCURRENCY: z.coerce.number().int().positive().default(2),
  VISION_CACHE_DIR: z.string().default('.models'),
  VISION_ALLOW_REMOTE_MODELS: bool.default(true),
  VISION_WARMUP: bool.default(true),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  EMBED_QUEUE_SHARDS: z.coerce.number().int().positive().default(1),
  IMAGE_FETCH_PER_HOST: z.coerce.number().int().positive().default(2),
  IMAGE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  IMAGE_FETCH_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  IMAGE_KEEP_ORIGINALS: bool.default(false),
  // Development only: host:port pairs allowed despite resolving to private/loopback IPs (demo image server).
  IMAGE_FETCH_DEV_ALLOW: z.string().default(''),

  UPLOAD_MAX_IMPORT_BYTES: z.coerce.number().int().positive().default(60 * 1024 * 1024),
  UPLOAD_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  IMAGE_MAX_PIXELS: z.coerce.number().int().positive().default(40_000_000),
  PHOTO_SEARCH_RETENTION_HOURS: z.coerce.number().int().positive().default(72),
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(250_000),

  METRICS_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.IMAGE_FETCH_DEV_ALLOW) {
    throw new Error('IMAGE_FETCH_DEV_ALLOW must be empty in production');
  }
  return cfg;
}

export const config: Config = load();

export const isProduction = config.NODE_ENV === 'production';
export const cookieSecure = config.COOKIE_SECURE ?? isProduction;
