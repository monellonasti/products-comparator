// DEVELOPMENT ONLY: serves fixtures/demo/images (and demo feed files under /feeds/) on http://127.0.0.1:4010
// so the real download pipelines (SSRF checks, retries, dedupe, derivatives, scheduled feeds) run on demo
// data. Requires IMAGE_FETCH_DEV_ALLOW=127.0.0.1:4010.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const IMAGES = path.resolve('fixtures/demo/images');
const FEEDS = path.resolve('fixtures/demo/feeds');
const PORT = Number(process.env.DEMO_IMAGE_PORT ?? 4010);

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.csv': 'text/csv; charset=windows-1252',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

http
  .createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
    const feed = /^feeds\/([a-z0-9._-]+\.(csv|xlsx))$/i.exec(name);
    const image = /^([a-z0-9._-]+\.(jpg|png|webp))$/i.exec(name);
    if (!feed && !image) {
      res.writeHead(404).end();
      return;
    }
    const file = feed ? path.join(FEEDS, feed[1]) : path.join(IMAGES, image![1]);
    try {
      const bytes = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': bytes.length }).end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`demo file server on http://127.0.0.1:${PORT} (dev only)`));
