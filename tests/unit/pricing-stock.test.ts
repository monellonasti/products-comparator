import { describe, expect, it } from 'vitest';
import { evaluatePrice, summarizePrices, countAvailableSuppliers, type PriceInput } from '../../src/domain/pricing.ts';
import { availabilityFromText, parseLeadTimeDays, resolveStock, splitQuantityCell } from '../../src/domain/stock.ts';
import { parseDecimal } from '../../src/lib/parse.ts';
import { fromScaled, toScaled } from '../../src/lib/decimal.ts';

const base = (over: Partial<PriceInput>): PriceInput => ({
  offerId: 'o1', supplierId: 's1', supplierPriority: 100, active: true, price: '10', currency: 'EUR',
  vatTreatment: 'net', vatRate: null, unitsPerPack: 1, moq: null, stockStatus: 'in_stock', stockQuantity: 5, ...over,
});

describe('decimal', () => {
  it('round-trips exact decimals', () => {
    expect(fromScaled(toScaled('12.3456')!)).toBe('12.3456');
    expect(fromScaled(toScaled('0.1')! + toScaled('0.2')!)).toBe('0.3000');
  });
});

describe('parseDecimal', () => {
  it('parses Italian and English formats with declared separator', () => {
    expect(parseDecimal('1.234,56', ',')).toEqual({ ok: true, value: '1234.5600' });
    expect(parseDecimal('1,234.56', '.')).toEqual({ ok: true, value: '1234.5600' });
    expect(parseDecimal('€ 12,50', ',')).toEqual({ ok: true, value: '12.5000' });
    expect(parseDecimal('', ',')).toEqual({ ok: true, value: null });
  });
  it('reports a separator mismatch instead of guessing', () => {
    const r = parseDecimal('12.50', ',');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('decimal_separator_mismatch');
  });
  it('rejects garbage', () => {
    expect(parseDecimal('dodici', '.').ok).toBe(false);
  });
});

describe('price comparability', () => {
  it('case F: 12 EUR per unit vs 50 EUR per pack of 5 -> unit prices 12 and 10', () => {
    const a = evaluatePrice(base({ offerId: 'a', price: '12' }));
    const b = evaluatePrice(base({ offerId: 'b', price: '50', unitsPerPack: 5 }));
    expect(a.netUnitPrice).toBe('12.0000');
    expect(b.netUnitPrice).toBe('10.0000');
    expect(b.netPackPrice).toBe('50.0000');
    const s = summarizePrices([base({ offerId: 'a', price: '12' }), base({ offerId: 'b', supplierId: 's2', price: '50', unitsPerPack: 5 })]);
    expect(s.best?.offerId).toBe('b');
    expect(s.best?.unitPrice).toBe('10.0000');
  });

  it('never derives a net price from an unknown VAT treatment', () => {
    const e = evaluatePrice(base({ vatTreatment: 'unknown' }));
    expect(e.comparable).toBe(false);
    expect(e.reasons).toContain('unknown_vat');
    expect(e.netUnitPrice).toBeNull();
  });

  it('derives net from gross only with a known rate', () => {
    expect(evaluatePrice(base({ vatTreatment: 'gross', price: '12.20', vatRate: '22' })).netUnitPrice).toBe('10.0000');
    expect(evaluatePrice(base({ vatTreatment: 'gross', price: '12.20', vatRate: null })).reasons).toContain('gross_without_rate');
  });

  it('requires a declared pack size to compare unit prices', () => {
    expect(evaluatePrice(base({ unitsPerPack: null })).reasons).toContain('unknown_pack');
  });

  it('shows a cheaper sold-out price separately, not as best', () => {
    const s = summarizePrices([
      base({ offerId: 'cheap', price: '5', stockStatus: 'out_of_stock', stockQuantity: 0 }),
      base({ offerId: 'ok', supplierId: 's2', price: '8' }),
    ]);
    expect(s.best?.offerId).toBe('ok');
    expect(s.cheaperSoldOut?.offerId).toBe('cheap');
  });

  it('does not convert currencies', () => {
    const s = summarizePrices([base({ offerId: 'e', price: '10' }), base({ offerId: 'u', supplierId: 's2', price: '1', currency: 'USD' })]);
    expect(s.currency).toBe('EUR');
    expect(s.best?.offerId).toBe('e');
    expect(s.otherCurrencies).toEqual(['USD']);
  });

  it('counts suppliers with availability instead of summing stock', () => {
    const n = countAvailableSuppliers([
      { active: true, supplierId: 's1', stockStatus: 'in_stock' },
      { active: true, supplierId: 's2', stockStatus: 'unknown' },
      { active: true, supplierId: 's3', stockStatus: 'out_of_stock' },
    ]);
    expect(n).toBe(1);
  });
});

describe('stock semantics', () => {
  it('null is unknown, zero is sold out (case G/qualitative)', () => {
    expect(resolveStock({ quantity: null, availabilityText: null })).toEqual({ quantity: null, status: 'unknown' });
    expect(resolveStock({ quantity: 0, availabilityText: null })).toEqual({ quantity: 0, status: 'out_of_stock' });
    expect(resolveStock({ quantity: null, availabilityText: 'Disponibile' })).toEqual({ quantity: null, status: 'in_stock' });
  });
  it('keeps qualitative text without inventing a quantity', () => {
    expect(splitQuantityCell('disponibile')).toEqual({ quantity: null, text: 'disponibile', negative: false });
    expect(splitQuantityCell('>10')).toEqual({ quantity: null, text: '>10', negative: false });
    expect(availabilityFromText('>10')).toBe('in_stock');
    expect(splitQuantityCell('12')).toEqual({ quantity: 12, text: null, negative: false });
    expect(splitQuantityCell(0)).toEqual({ quantity: 0, text: null, negative: false });
    expect(splitQuantityCell('')).toEqual({ quantity: null, text: null, negative: false });
  });
  it('parses lead times conservatively', () => {
    expect(parseLeadTimeDays('3-5 giorni')).toBe(5);
    expect(parseLeadTimeDays('2 settimane')).toBe(14);
    expect(parseLeadTimeDays('su richiesta')).toBeNull();
  });
});
