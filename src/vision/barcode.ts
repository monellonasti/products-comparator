// Barcode reading from a photo (server side) with zxing-wasm, in a small worker-thread pool so the
// CPU-bound WASM decode never blocks the API event loop. The WASM binary is loaded from node_modules
// (never from a CDN). A decoded code is only evidence after GTIN validation.
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { expandUpcE, parseBarcode, type ParsedBarcode } from '../lib/gtin.ts';
export { zxingWasmPath } from './zxing-path.ts';

const POOL_SIZE = 2;
const TIMEOUT_MS = 10_000;

interface Slot {
  worker: Worker;
  ready: Promise<void>;
  inFlight: number;
}
let pool: Slot[] | null = null;
let rr = 0;
let seq = 0;
const pending = new Map<number, { resolve: (v: RawResult[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; slot: Slot }>();

/** A worker keeps the process alive only while it has requests in flight. */
function settle(slot: Slot) {
  slot.inFlight--;
  if (slot.inFlight === 0) slot.worker.unref();
}

interface RawResult {
  text: string;
  format: string;
  isValid: boolean;
}

function startWorker(): Slot {
  const worker = new Worker(new URL('./barcode-worker.ts', import.meta.url));
  const slot: Slot = { worker, ready: Promise.resolve(), inFlight: 0 };
  const ready = new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    const onMsg = (m: any) => {
      if (m?.ready) {
        worker.off('message', onMsg);
        resolve();
      }
    };
    worker.on('message', onMsg);
  });
  worker.on('message', (m: any) => {
    if (m?.id === undefined) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    settle(p.slot);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.results);
  });
  worker.on('error', (err: Error) => {
    for (const [id, p] of pending) {
      if (p.slot !== slot) continue;
      clearTimeout(p.timer);
      p.reject(err);
      pending.delete(id);
    }
    pool = null; // recreate the pool on next use
  });
  // Idle workers must not keep the process alive (unref after attaching listeners: 'message' re-refs).
  worker.unref();
  slot.ready = ready;
  return slot;
}

async function decodeInWorker(png: Buffer): Promise<RawResult[]> {
  pool ??= Array.from({ length: POOL_SIZE }, startWorker);
  const slot = pool[rr++ % pool.length];
  slot.inFlight++;
  slot.worker.ref(); // keep the process alive while this request (including worker start-up) is pending
  try {
    await slot.ready;
  } catch (err) {
    settle(slot);
    throw err;
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      settle(slot);
      reject(new Error('barcode decode timeout'));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, slot });
    slot.worker.postMessage({ id, png: new Uint8Array(png) });
  });
}

export interface DecodedBarcode {
  text: string;
  format: string;
  parsed: ParsedBarcode;
}

/** Returns validated retail barcodes found in the image (EAN-13/8, UPC-A/E). */
export async function decodeRetailBarcodes(imageBytes: Buffer): Promise<DecodedBarcode[]> {
  // Decode on a bounded-size greyscale PNG: large phone photos are slow and not more readable.
  const png = await sharp(imageBytes).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).greyscale().png().toBuffer();
  const results = await decodeInWorker(png);
  const out: DecodedBarcode[] = [];
  for (const r of results) {
    if (!r.isValid || !r.text) continue;
    const isUpcE = /UPC-?E/i.test(r.format) && r.text.length === 8;
    const parsed = parseBarcode(isUpcE ? expandUpcE(r.text) ?? `invalid:${r.text}` : r.text);
    if (!out.some((o) => o.text === r.text)) out.push({ text: r.text, format: r.format, parsed });
  }
  return out;
}

export async function shutdownBarcodeWorkers() {
  const p = pool;
  pool = null;
  await Promise.all((p ?? []).map((s) => s.worker.terminate()));
}
