// XLSX container inspection before decompression: zip bombs, forged sizes, DTDs, malformed archives.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { inspectXlsxContainer, ZipLimitError } from '../../src/imports/xlsx-guard.ts';
import { ImportFileError, parseXlsx } from '../../src/imports/parsers.ts';
import { buildZip, xlsxParts } from '../zip-builder.ts';

const limits = { maxEntries: 50, maxUncompressedBytes: 5_000_000 };
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
/** Valid worksheet whose XML is inflated to `mb` MB with whitespace (compresses ~1000:1). */
const paddedSheet = (mb: number) =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><sheetData>` +
  `<row r="1"><c r="A1" t="inlineStr"><is><t>SKU</t></is></c></row>${' '.repeat(mb * 1_000_000)}</sheetData></worksheet>`;
const withSheet = (sheet: string | Buffer, over: Partial<{ declaredSize: number; flags: number; method: number }> = {}) => {
  const parts = xlsxParts();
  parts[4] = { ...parts[4], data: sheet, ...over };
  return buildZip(parts);
};

describe('XLSX container guard', () => {
  it('accepts a file written by ExcelJS and a minimal hand-built XLSX, which then parses normally', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Listino').addRows([['SKU', 'Prezzo'], ['A-1', 9.5]]);
    const excel = Buffer.from(await wb.xlsx.writeBuffer());
    const summary = inspectXlsxContainer(excel, limits);
    expect(summary.entries).toBeGreaterThan(4);
    expect(summary.largest?.bytes).toBeGreaterThan(0);

    const minimal = buildZip(xlsxParts());
    expect(inspectXlsxContainer(minimal, limits).entries).toBe(5);
    const parsed = await parseXlsx(minimal, {});
    expect(parsed.rows.map((r) => r.values)).toEqual([{ SKU: 'A-1', Prezzo: 9.5 }]);
  });

  it('refuses content that would expand beyond the limit ("zip bomb"), before decompressing it', () => {
    const bomb = withSheet(paddedSheet(50));
    expect(bomb.length).toBeLessThan(200_000); // ~50 KB on disk, 50 MB once decompressed
    expect(() => inspectXlsxContainer(bomb, limits)).toThrow(/oltre 5 MB/);
  });

  it('detects forged sizes: a part holding more (or less) data than its header declares', () => {
    const forged = withSheet(paddedSheet(50), { declaredSize: 1000 });
    expect(() => inspectXlsxContainer(forged, limits)).toThrow(/più dati di quanto dichiarato/);
    const real = Buffer.byteLength(paddedSheet(0));
    expect(() => inspectXlsxContainer(withSheet(paddedSheet(0), { declaredSize: real + 100 }), limits)).toThrow(/dimensione diversa/);
  });

  it('refuses DTDs and entity definitions in XML parts ("billion laughs"), also in UTF-16', () => {
    const dtd = `<?xml version="1.0"?><!DOCTYPE worksheet [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><worksheet xmlns="${NS}"><sheetData/></worksheet>`;
    expect(() => inspectXlsxContainer(withSheet(dtd), limits)).toThrow(/DTD/);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(dtd, 'utf16le')]);
    expect(() => inspectXlsxContainer(withSheet(utf16), limits)).toThrow(/DTD/);
  });

  it('refuses too many parts, encrypted parts, unsupported compression and damaged archives', () => {
    const many = buildZip([...xlsxParts(), ...Array.from({ length: 60 }, (_, i) => ({ name: `xl/media/image${i}.png`, data: 'x' }))]);
    expect(() => inspectXlsxContainer(many, limits)).toThrow(/troppe parti/);
    expect(() => inspectXlsxContainer(withSheet(paddedSheet(0), { flags: 1 }), limits)).toThrow(/cifrate/);
    expect(() => inspectXlsxContainer(withSheet(paddedSheet(0), { method: 12 }), limits)).toThrow(/non supportato/);
    expect(() => inspectXlsxContainer(Buffer.from('PK\x03\x04 non sono un archivio'), limits)).toThrow(ZipLimitError);
    const ok = buildZip(xlsxParts());
    expect(() => inspectXlsxContainer(ok.subarray(0, ok.length - 30), limits)).toThrow(ZipLimitError);
    const corrupt = Buffer.from(ok);
    corrupt.writeUInt32LE(0xdeadbeef, corrupt.length - 22 + 16); // central directory offset outside the file
    expect(() => inspectXlsxContainer(corrupt, limits)).toThrow(/danneggiato/);
  });

  it('reads ZIP64 size fields', () => {
    const parts = xlsxParts().map((p) => ({ ...p, zip64: true }));
    expect(inspectXlsxContainer(buildZip(parts), limits).entries).toBe(5);
    const forged = xlsxParts(paddedSheet(20)).map((p) => ({ ...p, zip64: true }));
    expect(() => inspectXlsxContainer(buildZip(forged), limits)).toThrow(/oltre 5 MB/);
  });

  it('reports a refused file as an import error, and one refused file does not block the next reads', async () => {
    const forged = withSheet(paddedSheet(50), { declaredSize: 1000 });
    const [bad, good] = await Promise.allSettled([parseXlsx(forged, {}), parseXlsx(buildZip(xlsxParts()), {})]);
    expect(bad.status).toBe('rejected');
    expect((bad as PromiseRejectedResult).reason).toBeInstanceOf(ImportFileError);
    expect((bad as PromiseRejectedResult).reason.message).toMatch(/^XLSX rifiutato: .*zip bomb/);
    expect(good.status).toBe('fulfilled');
  });
});
