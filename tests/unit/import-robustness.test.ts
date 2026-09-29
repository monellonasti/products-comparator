// Regressions from the 2026-09-29 audit: values a listino can contain that used to abort a whole import,
// be silently misread, or win the price comparison while meaning "price on request".
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { summarizePrices, evaluatePrice, type PriceInput } from '../../src/domain/pricing.ts';
import { parseDecimal, parseHttpUrl, parseVatRate } from '../../src/lib/parse.ts';
import { normalizeRow } from '../../src/imports/normalize.ts';
import { dedupeHeaders, parseImportFile } from '../../src/imports/parsers.ts';
import { splitQuantityCell, parseLeadTimeDays } from '../../src/domain/stock.ts';
import { diffOffer, priceChangePct, type OfferCommercialState } from '../../src/domain/changes.ts';
import type { ImportDefaults } from '../../src/imports/fields.ts';

const offer = (over: Partial<PriceInput>): PriceInput => ({
  offerId: 'o1', supplierId: 's1', supplierPriority: 100, active: true, price: '10', currency: 'EUR',
  vatTreatment: 'net', vatRate: null, unitsPerPack: 1, moq: null, stockStatus: 'in_stock', stockQuantity: 5, ...over,
});
const defaults: ImportDefaults = { currency: 'EUR', vatTreatment: 'net', vatRate: null, unitsPerPack: 1, salesUnit: null };
const mapping = { fields: { sku: 'SKU', barcode: 'EAN', title: 'Titolo', price: 'Prezzo', stock_quantity: 'Qta', lead_time: 'Consegna', image_urls: ['Img'] } };

describe('price comparison', () => {
  it('never makes a 0 price ("su richiesta") the best offer', () => {
    const s = summarizePrices([offer({ offerId: 'zero', price: '0' }), offer({ offerId: 'real', price: '10' })]);
    expect(s.best?.offerId).toBe('real');
    expect(evaluatePrice(offer({ price: '0' })).reasons).toContain('zero_price');
  });

  it('ranks on the exact unit price, not on its 4-decimal rounding', () => {
    // 1.34 and 1.26 per pack of 1000: both round to 0.0013 per piece, but the second is cheaper.
    const s = summarizePrices([
      offer({ offerId: 'a', supplierPriority: 1, price: '1.34', unitsPerPack: 1000 }),
      offer({ offerId: 'b', supplierPriority: 2, price: '1.26', unitsPerPack: 1000 }),
    ]);
    expect(s.best?.offerId).toBe('b');
  });
});

describe('cell parsing', () => {
  it('reads an Excel percentage cell (0.22) as 22%, and refuses a typed fraction', () => {
    expect(parseVatRate(0.22, '.')).toEqual({ ok: true, value: '22.0000' });
    expect(parseVatRate(0.1, ',')).toEqual({ ok: true, value: '10.0000' });
    const typed = parseVatRate('0,22', ',');
    expect(typed.ok).toBe(false);
    if (!typed.ok) expect(typed.code).toBe('vat_rate_fraction');
    expect(parseVatRate('22%', ',')).toEqual({ ok: true, value: '22.0000' });
    expect(parseVatRate(0, ',')).toEqual({ ok: true, value: '0.0000' });
  });

  it('does not read "0.125" as 125 when the comma is the decimal separator', () => {
    const r = parseDecimal('0.125', ',');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('decimal_separator_mismatch');
    expect(parseDecimal('1.234', ',')).toEqual({ ok: true, value: '1234.0000' }); // thousands group still accepted
    expect(parseDecimal('0,125', ',')).toEqual({ ok: true, value: '0.1250' });
  });

  it('refuses URLs too long for the image index', () => {
    const r = parseHttpUrl(`https://img.example/${'a'.repeat(3000)}.jpg`);
    expect(r.ok).toBe(false);
  });

  it('keeps quantities and lead times within what the database can store', () => {
    expect(splitQuantityCell('3000000000')).toMatchObject({ quantity: null, outOfRange: true });
    expect(splitQuantityCell(12)).toMatchObject({ quantity: 12 });
    expect(parseLeadTimeDays('99999999999 giorni')).toBeNull();
    expect(parseLeadTimeDays('2-3 settimane')).toBe(21);
  });
});

describe('row normalisation', () => {
  it('turns an EAN in the price column into a row error instead of a database overflow', () => {
    const r = normalizeRow({ rowNumber: 2, values: { SKU: 'A', Prezzo: '8001234567890' } }, mapping, defaults, '.');
    expect(r.offer).toBeNull();
    expect(r.issues.map((i) => i.code)).toContain('price_out_of_range');
  });

  it('applies a row with an absurd stock or lead time, without storing the value', () => {
    const r = normalizeRow({ rowNumber: 2, values: { SKU: 'A', Prezzo: '5', Qta: '3000000000', Consegna: '99999999 gg' } }, mapping, defaults, '.');
    expect(r.offer).toMatchObject({ stockQuantity: null, leadTimeDays: null, price: '5.0000' });
    expect(r.issues.map((i) => i.code)).toContain('stock_out_of_range');
  });

  it('keeps a 0 price with a warning (the offer exists, it just is not comparable)', () => {
    const r = normalizeRow({ rowNumber: 2, values: { SKU: 'A', Prezzo: '0' } }, mapping, defaults, '.');
    expect(r.offer?.price).toBe('0.0000');
    expect(r.issues.map((i) => i.code)).toContain('zero_price');
  });

  it('truncates a long text in the barcode column so it fits the indexed column', () => {
    const r = normalizeRow({ rowNumber: 2, values: { SKU: 'A', Prezzo: '1', EAN: 'x'.repeat(5000) } }, mapping, defaults, '.');
    expect(r.offer?.barcode.raw?.length).toBeLessThanOrEqual(64);
  });

  it('uses the hyperlink target of an image cell whose text is not a URL', () => {
    const r = normalizeRow(
      { rowNumber: 2, values: { SKU: 'A', Prezzo: '1', Img: 'Foto' }, links: { Img: 'https://img.example/a.jpg' } },
      mapping, defaults, '.',
    );
    expect(r.offer?.imageUrls).toEqual(['https://img.example/a.jpg']);
  });
});

describe('XLSX parsing', () => {
  it('keeps the visible text of hyperlink cells as their value (an SKU with a link stays the SKU)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Listino');
    ws.addRow(['SKU', 'Titolo', 'Img']);
    ws.addRow([
      { text: 'ABC-1', hyperlink: 'https://shop.example.com/p/abc-1' },
      'Shampoo',
      { text: 'Foto', hyperlink: 'https://img.example/abc-1.jpg' },
    ]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const parsed = await parseImportFile('xlsx', bytes, {});
    expect(parsed.rows[0].values.SKU).toBe('ABC-1');
    expect(parsed.rows[0].values.Img).toBe('Foto');
    expect(parsed.rows[0].links?.Img).toBe('https://img.example/abc-1.jpg');
  });

  it('gives distinct names to duplicated headers even when a generated name already exists', () => {
    expect(dedupeHeaders(['Img', 'Img', 'Img (2)'])).toEqual(['Img', 'Img (2)', 'Img (2) (2)']);
    expect(new Set(dedupeHeaders(['A', 'A', 'A', 'A (2)', 'A (3)'])).size).toBe(5);
  });
});

describe('change report', () => {
  const state = (over: Partial<OfferCommercialState>): OfferCommercialState => ({
    price: '10', currency: 'EUR', vatTreatment: 'net', vatRate: null, unitsPerPack: 1, stockQuantity: 5, stockStatus: 'in_stock', imageUrls: [], gtin: null, ...over,
  });

  it('gives no percentage when it cannot be stored (placeholder 0,01 replaced by a real price)', () => {
    expect(priceChangePct('0.01', '1500')).toBeNull();
    expect(priceChangePct('10', '11')).toBe('10.00');
  });

  it('records a VAT-rate change of a gross price as a price change without percentage', () => {
    const changes = diffOffer('o', 'p', state({ vatTreatment: 'gross', vatRate: '22' }), state({ vatTreatment: 'gross', vatRate: '10' }), { compareImages: false });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: 'price', pct: null });
    // For a net price the rate is irrelevant.
    expect(diffOffer('o', 'p', state({ vatRate: '22' }), state({ vatRate: '10' }), { compareImages: false })).toHaveLength(0);
  });
});
