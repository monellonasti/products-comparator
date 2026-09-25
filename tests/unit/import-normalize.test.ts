import { describe, expect, it } from 'vitest';
import { normalizeRow, offerFingerprint } from '../../src/imports/normalize.ts';
import { guessMapping } from '../../src/imports/fields.ts';
import { parseCsv, detectDelimiter, decodeText } from '../../src/imports/parsers.ts';
import { detectIdentityConflicts, brandsConflict } from '../../src/domain/identity.ts';
import type { ImportDefaults } from '../../src/imports/fields.ts';

const defaults: ImportDefaults = { currency: 'EUR', vatTreatment: 'net', vatRate: null, unitsPerPack: 1, salesUnit: null };

describe('CSV parsing', () => {
  it('detects semicolon delimiter and windows-1252 encoding, keeps leading zeros as text', () => {
    const latin1 = Buffer.from('Codice;EAN;Descrizione;Prezzo\nA1;0036000291452;Vibratore rosa perché;12,50\n', 'latin1');
    const parsed = parseCsv(latin1, {});
    expect(parsed.detected.delimiter).toBe(';');
    expect(parsed.detected.encoding).toBe('windows-1252');
    expect(parsed.detected.decimalSeparator).toBe(',');
    expect(parsed.rows[0].values.EAN).toBe('0036000291452');
    expect(parsed.rows[0].values.Descrizione).toBe('Vibratore rosa perché');
    expect(parsed.rows[0].rowNumber).toBe(2);
  });
  it('handles UTF-8 BOM and quoted fields', () => {
    const { text } = decodeText(Buffer.from('﻿a,b\n"x, y",2\n', 'utf8'));
    expect(text.startsWith('a,b')).toBe(true);
    expect(detectDelimiter('a,b\n"x, y",2')).toBe(',');
  });
  it('de-duplicates repeated headers', () => {
    const p = parseCsv(Buffer.from('Img;Img;SKU\nu1;u2;X\n'), {});
    expect(p.headers).toEqual(['Img', 'Img (2)', 'SKU']);
  });
});

describe('mapping guess', () => {
  it('maps common Italian headers and multiple image columns', () => {
    const m = guessMapping(['Codice Articolo', 'EAN', 'Descrizione', 'Marca', 'Prezzo', 'Giacenza', 'Immagine 1', 'Immagine 2']);
    expect(m.fields.sku).toBe('Codice Articolo');
    expect(m.fields.barcode).toBe('EAN');
    expect(m.fields.price).toBe('Prezzo');
    expect(m.fields.stock_quantity).toBe('Giacenza');
    expect(m.fields.image_urls).toEqual(['Immagine 1', 'Immagine 2']);
  });
});

describe('row normalisation', () => {
  const mapping = { fields: { sku: 'SKU', barcode: 'EAN', title: 'Titolo', price: 'Prezzo', stock_quantity: 'Qta', image_urls: ['Img'] } };

  it('rejects a row without SKU (never applied)', () => {
    const r = normalizeRow({ rowNumber: 2, values: { SKU: '', EAN: '4006381333931' } }, mapping, defaults, '.');
    expect(r.offer).toBeNull();
    expect(r.issues[0].code).toBe('missing_sku');
  });

  it('keeps an invalid EAN as data with a warning (distinct product later)', () => {
    const r = normalizeRow({ rowNumber: 2, values: { SKU: 'X', EAN: '4006381333932', Titolo: 'T', Prezzo: '1' } }, mapping, defaults, '.');
    expect(r.offer?.barcode.status).toBe('invalid');
    expect(r.issues.some((i) => i.code === 'barcode_bad_check_digit' && i.severity === 'warning')).toBe(true);
  });

  it('turns an unparsable price into a row error so previous data is kept', () => {
    const r = normalizeRow({ rowNumber: 3, values: { SKU: 'X', Prezzo: 'abc' } }, mapping, defaults, '.');
    expect(r.offer).toBeNull();
    expect(r.sku).toBe('X');
  });

  it('distinguishes empty stock (unknown) from zero (sold out)', () => {
    const unknown = normalizeRow({ rowNumber: 2, values: { SKU: 'X', Qta: '' } }, mapping, defaults, '.');
    const zero = normalizeRow({ rowNumber: 2, values: { SKU: 'X', Qta: '0' } }, mapping, defaults, '.');
    expect(unknown.offer).toMatchObject({ stockQuantity: null, stockStatus: 'unknown' });
    expect(zero.offer).toMatchObject({ stockQuantity: 0, stockStatus: 'out_of_stock' });
  });

  it('drops non-http image URLs with a warning', () => {
    const r = normalizeRow({ rowNumber: 2, values: { SKU: 'X', Img: 'https://a.example/1.jpg|file:///etc/passwd' } }, mapping, defaults, '.');
    expect(r.offer?.imageUrls).toEqual(['https://a.example/1.jpg']);
    expect(r.issues.some((i) => i.code === 'invalid_image_url')).toBe(true);
  });

  it('produces identical fingerprints for identical rows (case E)', () => {
    const row = { rowNumber: 2, values: { SKU: 'X', EAN: '4006381333931', Titolo: 'T', Prezzo: '1.5' } };
    const a = normalizeRow(row, mapping, defaults, '.');
    const b = normalizeRow({ ...row, rowNumber: 9 }, mapping, defaults, '.');
    expect(offerFingerprint(a.offer!)).toBe(offerFingerprint(b.offer!));
    const c = normalizeRow({ ...row, values: { ...row.values, Prezzo: '1.6' } }, mapping, defaults, '.');
    expect(offerFingerprint(c.offer!)).not.toBe(offerFingerprint(a.offer!));
  });

  it('fingerprint includes nested attributes', () => {
    const m = { fields: { sku: 'SKU', color: 'Colore' } };
    const a = normalizeRow({ rowNumber: 2, values: { SKU: 'X', Colore: 'Rosa' } }, m, defaults, '.');
    const b = normalizeRow({ rowNumber: 2, values: { SKU: 'X', Colore: 'Nero' } }, m, defaults, '.');
    expect(offerFingerprint(a.offer!)).not.toBe(offerFingerprint(b.offer!));
  });
});

describe('identity conflicts', () => {
  it('treats brand spelling variants as the same brand', () => {
    expect(brandsConflict('LELO', 'Lelo Inc.')).toBe(false);
    expect(brandsConflict('We-Vibe', 'WE VIBE')).toBe(false);
    expect(brandsConflict('LELO', 'Satisfyer')).toBe(true);
  });
  it('flags variant attribute mismatches but not title differences', () => {
    const c = detectIdentityConflicts(
      { brand: 'Lelo', attributes: { color: 'Rosa', net_content: '100 ml' } },
      { brand: 'LELO', attributes: { color: 'Nero', net_content: '100ml' } },
    );
    expect(c.map((x) => x.field)).toEqual(['color']);
  });
});

describe('import templates', () => {
  it('the shipped CSV template maps every column automatically and parses cleanly', async () => {
    const { readFileSync } = await import('node:fs');
    const parsed = parseCsv(readFileSync('templates/listino-template.csv'), {});
    const m = guessMapping(parsed.headers);
    expect(Object.keys(m.fields).sort()).toEqual(
      ['availability', 'barcode', 'brand', 'category', 'color', 'currency', 'image_urls', 'lead_time', 'moq', 'net_content', 'price', 'product_url', 'size', 'sku', 'stock_quantity', 'title', 'units_per_pack', 'vat_rate'].sort(),
    );
    const rows = parsed.rows.map((r) => normalizeRow(r, m, defaults, ','));
    expect(rows.every((r) => r.offer && !r.issues.some((i) => i.severity === 'error'))).toBe(true);
    expect(rows[1].offer).toMatchObject({ unitsPerPack: 3, barcode: { status: 'valid', gtin14: '00036000291452' }, stockStatus: 'in_stock', stockQuantity: null });
  });
});
