import { describe, expect, it } from 'vitest';
import { displayGtin, expandUpcE, gs1CheckDigit, parseBarcode } from '../../src/lib/gtin.ts';

describe('parseBarcode', () => {
  it('accepts a valid EAN-13 and keeps the raw string', () => {
    const r = parseBarcode('4006381333931');
    expect(r).toMatchObject({ status: 'valid', format: 'EAN-13', gtin14: '04006381333931', raw: '4006381333931' });
  });

  it('keeps leading zeros: EAN-13 starting with 0 and its UPC-A form are the same GTIN', () => {
    const ean = parseBarcode('0036000291452');
    const upc = parseBarcode('036000291452');
    expect(ean.status).toBe('valid');
    expect(upc).toMatchObject({ status: 'valid', format: 'UPC-A' });
    expect(ean.gtin14).toBe(upc.gtin14);
    expect(ean.raw).toBe('0036000291452');
  });

  it('accepts EAN-8 and GTIN-14', () => {
    expect(parseBarcode('96385074')).toMatchObject({ status: 'valid', format: 'EAN-8', gtin14: '00000096385074' });
    const body = '1400638133393';
    const g14 = body + gs1CheckDigit(body);
    expect(parseBarcode(g14)).toMatchObject({ status: 'valid', format: 'GTIN-14', gtin14: g14 });
  });

  it('never equates a case GTIN-14 (indicator 1-8) with the single unit GTIN-13', () => {
    const unit = parseBarcode('4006381333931');
    const body = '1400638133393';
    const pack = parseBarcode(body + gs1CheckDigit(body));
    expect(pack.status).toBe('valid');
    expect(pack.gtin14).not.toBe(unit.gtin14);
  });

  it('rejects a wrong check digit without correcting it', () => {
    const r = parseBarcode('4006381333932');
    expect(r).toMatchObject({ status: 'invalid', issue: 'bad_check_digit', gtin14: null, raw: '4006381333932' });
  });

  it('rejects unsupported lengths (e.g. leading zeros lost) instead of padding', () => {
    expect(parseBarcode('36000291452')).toMatchObject({ status: 'invalid', issue: 'unsupported_length' });
  });

  it('flags Excel scientific notation as lost precision', () => {
    expect(parseBarcode('4.00638E+12')).toMatchObject({ status: 'invalid', issue: 'scientific_notation' });
    expect(parseBarcode('8,00123E+12')).toMatchObject({ status: 'invalid', issue: 'scientific_notation' });
  });

  it('rejects letters, decimals and all-zero codes', () => {
    expect(parseBarcode('40063813339A1').issue).toBe('not_digits');
    expect(parseBarcode('4006381333931.0').issue).toBe('not_digits');
    expect(parseBarcode('0000000000000').issue).toBe('all_zeros');
  });

  it('treats empty values as missing, distinct from invalid', () => {
    expect(parseBarcode('').status).toBe('missing');
    expect(parseBarcode('   ').status).toBe('missing');
    expect(parseBarcode(null).status).toBe('missing');
  });

  it('marks restricted circulation numbers (in-store 2xx, coupons) as restricted', () => {
    const body = '200123456789';
    const rcn = parseBarcode(body + gs1CheckDigit(body));
    expect(rcn.status).toBe('restricted');
    expect(rcn.gtin14).not.toBeNull();
    const rcn8Body = '2123456';
    expect(parseBarcode(rcn8Body + gs1CheckDigit(rcn8Body)).status).toBe('restricted');
  });

  it('ignores spaces between digit groups but reports it', () => {
    const r = parseBarcode('4 006381 333931');
    expect(r).toMatchObject({ status: 'valid', gtin14: '04006381333931', formattingRemoved: true });
  });

  it('displays GTIN-13 form when possible', () => {
    expect(displayGtin('04006381333931')).toBe('4006381333931');
  });
});

describe('expandUpcE', () => {
  it('expands zero-suppressed UPC-E to UPC-A (GS1 rules)', () => {
    expect(expandUpcE('04252614')).toBe('042100005264');
    expect(expandUpcE('01234565')).toBe('012345000065');
    expect(expandUpcE('01234531')).toBe('012300000451');
    expect(expandUpcE('01234530')).toBeNull(); // wrong check digit is not corrected
  });
  it('rejects malformed input', () => {
    expect(expandUpcE('9123456')).toBeNull();
    expect(expandUpcE('abc')).toBeNull();
  });
});
