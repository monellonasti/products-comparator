// DEVELOPMENT ONLY: serves fixtures/demo/images on http://127.0.0.1:4010 so the real download pipeline
// (SSRF checks, retries, dedupe, derivatives) runs on demo data. Requires IMAGE_FETCH_DEV_ALLOW=127.0.0.1:4010.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('fixtures/demo/images');
const PORT = Number(process.env.DEMO_IMAGE_PORT ?? 4010);

http
  .createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
    if (!/^[a-z0-9._-]+\.(jpg|png|webp)$/i.test(name)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(path.join(ROOT, name));
      res.writeHead(200, { 'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg', 'content-length': bytes.length }).end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`demo image server on http://127.0.0.1:${PORT} (dev only)`));
