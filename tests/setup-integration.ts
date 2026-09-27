// Integration tests: real PostgreSQL (TEST_DATABASE_URL) + filesystem storage in a temp folder.
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://comparator:comparator_dev@127.0.0.1:5432/comparator_test';
process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'fs';
process.env.STORAGE_FS_ROOT = '.data/test-storage';
process.env.VISION_WARMUP = 'false';
process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64'); // test-only key
process.env.IMAGE_FETCH_DEV_ALLOW = '127.0.0.1:47124,127.0.0.1:47127';
