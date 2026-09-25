// End-to-end: real HTTP server, real PostgreSQL (TEST_DATABASE_URL, wiped), real S3 (S3_* from .env,
// separate bucket), real image downloads from a local server and the real vision model.
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://comparator:comparator_dev@127.0.0.1:5432/comparator_test';
process.env.NODE_ENV = 'test';
process.env.S3_BUCKET = process.env.E2E_S3_BUCKET ?? 'comparator-e2e';
process.env.IMAGE_FETCH_DEV_ALLOW = '127.0.0.1:4011';
process.env.VISION_WARMUP = 'false';
process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:1';
