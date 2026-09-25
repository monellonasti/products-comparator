// Object storage abstraction. Images and uploaded files live here, never in DB rows.
// Keys are content-addressed where possible so objects are immutable and cacheable.
import { mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand,
  HeadObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { config } from '../config.ts';

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<{ key: string; lastModified: Date | null }>;
  /** Readiness probe; creates the bucket/root in development if missing. */
  check(createIfMissing: boolean): Promise<void>;
}

export class NotFoundError extends Error {}

class S3Storage implements ObjectStorage {
  private client: S3Client;
  private bucket: string;
  constructor() {
    if (!config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) throw new Error('S3 credentials missing (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY)');
    this.bucket = config.S3_BUCKET;
    this.client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT || undefined,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) throw new NotFoundError(key);
      throw err;
    }
  }
  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
      throw err;
    }
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async *list(prefix: string) {
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) if (o.Key) yield { key: o.Key, lastModified: o.LastModified ?? null };
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }
  async check(createIfMissing: boolean) {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err: any) {
      const status = err?.$metadata?.httpStatusCode;
      if (createIfMissing && (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchBucket')) {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        return;
      }
      throw err;
    }
  }
}

class FsStorage implements ObjectStorage {
  private root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  private file(key: string) {
    if (key.includes('..') || path.isAbsolute(key)) throw new Error('invalid storage key');
    return path.join(this.root, key);
  }
  async put(key: string, body: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body);
  }
  async get(key: string) {
    try {
      return await readFile(this.file(key));
    } catch (err: any) {
      if (err?.code === 'ENOENT') throw new NotFoundError(key);
      throw err;
    }
  }
  async exists(key: string) {
    return stat(this.file(key)).then(() => true, () => false);
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
  async *list(prefix: string) {
    const walk = async function* (dir: string, root: string): AsyncGenerator<{ key: string; lastModified: Date | null }> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(full, root);
        else yield { key: path.relative(root, full).split(path.sep).join('/'), lastModified: (await stat(full)).mtime };
      }
    };
    for await (const item of walk(this.root, this.root)) if (item.key.startsWith(prefix)) yield item;
  }
  async check() {
    await mkdir(this.root, { recursive: true });
  }
}

let instance: ObjectStorage | null = null;
export function storage(): ObjectStorage {
  instance ??= config.STORAGE_DRIVER === 's3' ? new S3Storage() : new FsStorage(config.STORAGE_FS_ROOT);
  return instance;
}

export function setStorageForTests(s: ObjectStorage) {
  instance = s;
}

export function createFsStorage(root: string): ObjectStorage {
  return new FsStorage(root);
}

export const keys = {
  image(sha: string, variant: 'thumb' | 'display' | 'infer' | 'original', ext: string) {
    return `img/${sha.slice(0, 2)}/${sha}/${variant}.${ext}`;
  },
  importFile(runId: string, sha: string) {
    return `imports/${runId}/${sha}`;
  },
  searchImage(searchId: string) {
    return `searches/${searchId}.jpg`;
  },
};
