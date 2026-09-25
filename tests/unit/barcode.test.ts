import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';
import { decodeRetailBarcodes, zxingWasmPath } from '../../src/vision/barcode.ts';

async function renderEan13(ean: string): Promise<Buffer> {
  const writer = await import('zxing-wasm/writer');
  const wasm = readFileSync(zxingWasmPath('writer'));
  await writer.prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer }, fireImmediately: true });
  const res = await writer.writeBarcode(ean, { format: 'EAN13', scale: 3, addHRT: true, addQuietZones: true });
  return sharp(Buffer.from(res.svg)).flatten({ background: '#fff' }).png().toBuffer();
}

describe('barcode reading (zxing-wasm, local WASM)', () => {
  it('finds the WASM binaries inside node_modules (no CDN)', () => {
    expect(existsSync(zxingWasmPath('reader'))).toBe(true);
    expect(existsSync(zxingWasmPath('writer'))).toBe(true);
  });

  it('decodes and validates an EAN-13 from an image', async () => {
    const png = await renderEan13('4006381333931');
    const found = await decodeRetailBarcodes(png);
    expect(found[0]?.parsed).toMatchObject({ status: 'valid', gtin14: '04006381333931' });
  });

  it('reads the barcode printed on a synthetic phone photo when present', async () => {
    const q = 'fixtures/demo/queries/q05-p009.jpg';
    if (!existsSync(q)) return; // fixtures not generated
    const found = await decodeRetailBarcodes(readFileSync(q));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].parsed.status).toBe('valid');
  });
});
