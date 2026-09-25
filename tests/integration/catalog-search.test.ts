import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.ts';
import { listProducts, productDetail } from '../../src/search/catalog.ts';
import { createSupplier, importCsv, resetDatabase, row } from '../helpers.ts';

beforeAll(async () => {
  await resetDatabase();
  const a = await createSupplier('alfa', { priority: 10 });
  const b = await createSupplier('beta', { priority: 20 });
  await importCsv({
    supplierId: a.id,
    rows: [
      row({ SKU: 'ALF-VIB-1', EAN: '4006381333931', Titolo: 'Vibratore Wave Rosa', Marca: 'Sensa', Prezzo: '20', Giacenza: '5' }),
      row({ SKU: 'ALF-GEL-2', EAN: '0036000291452', Titolo: 'Gel Idratante 100 ml', Marca: 'Nuvia', Prezzo: '8', Giacenza: '0' }),
      row({ SKU: 'ALF-KIT-3', EAN: '', Titolo: 'Kit Regalo Coppia', Marca: 'Aurum', Prezzo: '30' }),
      row({ SKU: 'ALF-BAD-4', EAN: '4006381333932', Titolo: 'Candela Massaggio', Marca: 'Moira', Prezzo: '12' }),
    ],
  });
  await importCsv({ supplierId: b.id, rows: [row({ SKU: 'B-77', EAN: '4006381333931', Titolo: 'Wave vibe pink', Marca: 'SENSA', Prezzo: '18', Disponibilita: 'Disponibile' })] });
});
afterAll(() => pool.end());

describe('catalogue search', () => {
  it('browses one card per product with server-side pagination', async () => {
    const page = await listProducts({ limit: 2 });
    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(2);
    const next = await listProducts({ limit: 2, offset: 2 });
    expect(new Set([...page.items, ...next.items].map((i) => i.id)).size).toBe(4);
  });

  it('finds by EAN in any equivalent form (UPC-A vs EAN-13) and by raw invalid code', async () => {
    const upc = await listProducts({ q: '036000291452' });
    const ean13 = await listProducts({ q: '0036000291452' });
    expect(upc.items.map((i) => i.title)).toEqual(['Gel Idratante 100 ml']);
    expect(ean13.items[0].id).toBe(upc.items[0].id);
    expect(upc.items[0].matchedBy).toBe('gtin');
    const invalid = await listProducts({ q: '4006381333932' });
    expect(invalid.items[0]).toMatchObject({ title: 'Candela Massaggio', matchedBy: 'barcode_raw' });
  });

  it('finds by supplier SKU (case-insensitive) and by text, including titles of other suppliers and typos', async () => {
    expect((await listProducts({ q: 'alf-kit-3' })).items[0]).toMatchObject({ title: 'Kit Regalo Coppia', matchedBy: 'sku' });
    expect((await listProducts({ q: 'wave' })).items.map((i) => i.title)).toContain('Vibratore Wave Rosa');
    expect((await listProducts({ q: 'pink' })).items.map((i) => i.title)).toContain('Vibratore Wave Rosa'); // title of supplier B
    expect((await listProducts({ q: 'vibratre' })).items.map((i) => i.title)).toContain('Vibratore Wave Rosa');
    expect((await listProducts({ q: 'idratante gel' })).total).toBe(1);
    expect((await listProducts({ q: 'zzzqqq' })).total).toBe(0);
  });

  it('filters by supplier, availability, EAN presence and price', async () => {
    const suppliers = (await pool.query(`SELECT id, code FROM suppliers`)).rows;
    const beta = suppliers.find((s) => s.code === 'beta').id;
    expect((await listProducts({ supplierIds: [beta] })).total).toBe(1);
    const available = await listProducts({ availability: 'available' });
    expect(available.items.map((i) => i.title)).toEqual(['Vibratore Wave Rosa']);
    expect((await listProducts({ gtin: 'absent' })).items.map((i) => i.title).sort()).toEqual(['Candela Massaggio', 'Kit Regalo Coppia']);
    expect((await listProducts({ priceMin: 10, priceMax: 19 })).items.map((i) => i.title).sort()).toEqual(['Candela Massaggio', 'Vibratore Wave Rosa']);
  });

  it('product sheet shows both offers, provenance and the cheapest purchasable price', async () => {
    const card = (await listProducts({ q: '4006381333931' })).items[0];
    expect(card.supplierCount).toBe(2);
    const d: any = await productDetail(card.id, { isAdmin: false });
    expect(d.offers).toHaveLength(2);
    expect(d.product.bestPrice.best.unitPrice).toBe('18.0000');
    expect(d.product.canonicalSources.title.supplierId).toBeTruthy();
    expect(d.product.title).toBe('Vibratore Wave Rosa'); // supplier with higher priority wins
    expect(d.offers[0].sourceRow).toBeUndefined(); // raw rows only for admins
  });
});
