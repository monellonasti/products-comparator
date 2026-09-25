// Worker thread: barcode decoding (WASM, CPU-bound) off the API event loop.
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { zxingWasmPath } from './zxing-path.ts';

const mod = await import('zxing-wasm/reader');
const wasm = readFileSync(zxingWasmPath('reader'));
await mod.prepareZXingModule({
  overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer },
  fireImmediately: true,
});

parentPort!.on('message', async (msg: { id: number; png: Uint8Array }) => {
  try {
    const results = await mod.readBarcodes(msg.png, { formats: ['EAN13', 'EAN8', 'UPCA', 'UPCE'], tryHarder: true, tryRotate: true, tryInvert: false, maxNumberOfSymbols: 4 });
    parentPort!.postMessage({ id: msg.id, results: results.map((r) => ({ text: r.text, format: String(r.format), isValid: r.isValid })) });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: (err as Error).message });
  }
});
parentPort!.postMessage({ ready: true });
