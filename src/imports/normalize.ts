// Row normalisation: mapped raw cells -> typed offer fields + row issues.
// Error-severity issues mean the row is NOT applied (previous data for that SKU stays untouched);
// warnings are recorded and the row is applied.
import { parseBarcode, barcodeIssueMessage, type ParsedBarcode } from '../lib/gtin.ts';
import {
  isEmptyCell, parseCurrency, parseDecimal, parseHttpUrl, parseNonNegativeInt, parseVatRate, splitUrls, toPlainText,
  type DecimalSeparator,
} from '../lib/parse.ts';
import { parseLeadTimeDays, resolveStock, splitQuantityCell, type StockStatus } from '../domain/stock.ts';
import type { ColumnMapping, ImportDefaults } from './fields.ts';
import type { ParsedRow } from './parsers.ts';
import { stableStringify } from '../lib/hash.ts';

export interface RowIssue {
  severity: 'error' | 'warning';
  field: string | null;
  code: string;
  message: string;
  value?: string | null;
}

export interface NormalizedOffer {
  sku: string;
  barcode: ParsedBarcode;
  title: string | null;
  brand: string | null;
  description: string | null;
  categoryRaw: string | null;
  attributes: Record<string, string>;
  price: string | null;
  currency: string | null;
  vatTreatment: 'net' | 'gross' | 'unknown';
  vatRate: string | null;
  salesUnit: string | null;
  unitsPerPack: number | null;
  moq: number | null;
  priceTiers: Array<{ minQty: number; price: string }> | null;
  stockQuantity: number | null;
  stockStatus: StockStatus;
  availabilityRaw: string | null;
  leadTimeDays: number | null;
  leadTimeRaw: string | null;
  productUrl: string | null;
  imageUrls: string[];
}

export interface NormalizedRow {
  rowNumber: number;
  sku: string | null;
  offer: NormalizedOffer | null;
  issues: RowIssue[];
}

const MAX_IMAGES_PER_ROW = 12;
/** numeric(14,4): larger prices cannot be stored and are almost always a code in the price column. */
const MAX_PRICE = 9_999_999_999;
const MAX_BARCODE_CELL = 64;
const ATTRIBUTE_FIELDS = ['color', 'size', 'variant', 'net_content', 'pieces', 'material'] as const;

function text(value: unknown, max = 500): string | null {
  if (isEmptyCell(value)) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

export function normalizeRow(row: ParsedRow, mapping: ColumnMapping, defaults: ImportDefaults, sep: DecimalSeparator): NormalizedRow {
  const issues: RowIssue[] = [];
  const f = mapping.fields;
  const cell = (col: string | undefined) => (col ? row.values[col] ?? null : null);
  // URL fields: an XLSX cell showing "Foto" or "Scheda" with a hyperlink contributes its link target.
  const urlCell = (col: string | undefined) => {
    const v = cell(col);
    const link = col ? row.links?.[col] : undefined;
    return link && !(typeof v === 'string' && /^https?:/i.test(v.trim())) ? link : v;
  };
  const isNumericCell = (col: string | undefined) => !!col && !!row.numeric?.includes(col);
  const err = (field: string, code: string, message: string, value?: unknown) =>
    issues.push({ severity: 'error', field, code, message, value: value === null || value === undefined ? null : String(value).slice(0, 200) });
  const warn = (field: string, code: string, message: string, value?: unknown) =>
    issues.push({ severity: 'warning', field, code, message, value: value === null || value === undefined ? null : String(value).slice(0, 200) });

  for (const col of row.formula ?? []) {
    if (Object.values(f).flat().includes(col)) warn(col, 'formula_cached_value', 'Cella con formula: usato il valore memorizzato nel file, la formula non è stata eseguita');
  }

  // --- key
  const skuRaw = cell(f.sku);
  const sku = text(skuRaw, 200);
  if (!sku) {
    err('sku', 'missing_sku', 'Codice fornitore (SKU) mancante: riga non importabile');
    return { rowNumber: row.rowNumber, sku: null, offer: null, issues };
  }
  if (isNumericCell(f.sku) && typeof skuRaw === 'string' && /e/i.test(skuRaw)) {
    err('sku', 'sku_precision_lost', 'SKU numerico troppo lungo: Excel ha perso cifre', skuRaw);
  }

  // --- barcode (kept as original string)
  const barcodeCell = cell(f.barcode);
  // A real code is at most 14 digits plus formatting; longer text (e.g. a description in the wrong
  // column) is kept truncated so it never exceeds the indexed column.
  const barcode = parseBarcode(barcodeCell === null ? null : String(barcodeCell).slice(0, MAX_BARCODE_CELL));
  if (barcode.status === 'invalid') {
    warn('barcode', `barcode_${barcode.issue}`, `EAN non valido (${barcodeIssueMessage(barcode.issue!)}): il prodotto resta separato`, barcodeCell);
  } else if (barcode.status === 'restricted') {
    warn('barcode', 'barcode_restricted', 'Codice a circolazione limitata (interno/negozio): nessun accorpamento automatico', barcodeCell);
  }
  if (barcode.formattingRemoved) warn('barcode', 'barcode_formatting', 'Spazi o trattini nel codice ignorati', barcodeCell);
  if (isNumericCell(f.barcode) && barcode.status === 'invalid') {
    warn('barcode', 'barcode_numeric_cell', 'Codice salvato come numero in Excel: zeri iniziali o cifre potrebbero essere persi e non vengono ricostruiti', barcodeCell);
  }

  // --- commercial data
  const priceRes = parseDecimal(cell(f.price), sep);
  let price: string | null = null;
  if (!priceRes.ok) err('price', priceRes.code, priceRes.message, cell(f.price));
  else price = priceRes.value;
  if (price !== null && Number(price) < 0) err('price', 'negative_price', 'Prezzo negativo', price);
  else if (price !== null && Number(price) > MAX_PRICE) {
    err('price', 'price_out_of_range', 'Prezzo fuori scala: probabilmente un codice finito nella colonna del prezzo', price);
  } else if (price !== null && Number(price) === 0) {
    warn('price', 'zero_price', 'Prezzo pari a zero (prezzo su richiesta?): l’offerta non entra nel confronto prezzi', price);
  }

  let currency = defaults.currency;
  if (f.currency && !isEmptyCell(cell(f.currency))) {
    const c = parseCurrency(cell(f.currency));
    if (!c.ok) err('currency', c.code, c.message, cell(f.currency));
    else currency = c.value;
  }

  let vatRate = defaults.vatRate;
  if (f.vat_rate && !isEmptyCell(cell(f.vat_rate))) {
    const v = parseVatRate(cell(f.vat_rate), sep);
    if (!v.ok) err('vat_rate', v.code, v.message, cell(f.vat_rate));
    else vatRate = v.value;
  }

  let unitsPerPack = defaults.unitsPerPack;
  if (f.units_per_pack && !isEmptyCell(cell(f.units_per_pack))) {
    const u = parseNonNegativeInt(cell(f.units_per_pack), sep);
    if (!u.ok) err('units_per_pack', u.code, u.message, cell(f.units_per_pack));
    else if (u.value === 0) err('units_per_pack', 'zero_pack', 'Pezzi per confezione pari a zero', cell(f.units_per_pack));
    else unitsPerPack = u.value;
  }

  let moq: number | null = null;
  if (f.moq) {
    const m = parseNonNegativeInt(cell(f.moq), sep);
    if (!m.ok) err('moq', m.code, m.message, cell(f.moq));
    else moq = m.value === 0 ? null : m.value;
  }

  let priceTiers: NormalizedOffer['priceTiers'] = null;
  for (const tier of mapping.tiers ?? []) {
    const t = parseDecimal(cell(tier.column), sep);
    if (!t.ok) {
      warn(tier.column, 'invalid_tier_price', `Prezzo a scaglione non interpretabile (${t.message})`, cell(tier.column));
      continue;
    }
    if (t.value !== null && (Number(t.value) <= 0 || Number(t.value) > MAX_PRICE)) {
      warn(tier.column, 'invalid_tier_price', 'Prezzo a scaglione pari a zero o fuori scala: ignorato', t.value);
      continue;
    }
    if (t.value !== null) (priceTiers ??= []).push({ minQty: tier.minQty, price: t.value });
  }
  priceTiers?.sort((a, b) => a.minQty - b.minQty);

  // --- stock
  const qtyCell = splitQuantityCell(cell(f.stock_quantity));
  if (qtyCell.negative) warn('stock_quantity', 'negative_stock', 'Giacenza negativa: considerata esaurita, quantità non registrata', cell(f.stock_quantity));
  if (qtyCell.outOfRange) warn('stock_quantity', 'stock_out_of_range', 'Giacenza fuori scala: quantità non registrata', cell(f.stock_quantity));
  const availabilityRaw = text(cell(f.availability), 200) ?? qtyCell.text;
  const stock = resolveStock({ quantity: qtyCell.quantity, availabilityText: availabilityRaw });
  const stockStatus: StockStatus = qtyCell.negative && stock.status === 'unknown' ? 'out_of_stock' : stock.status;
  if (availabilityRaw && stock.status === 'unknown' && qtyCell.quantity === null) {
    warn('availability', 'availability_unrecognized', 'Disponibilità non riconosciuta: conservata come testo', availabilityRaw);
  }

  const leadTimeRaw = text(cell(f.lead_time), 100);

  // --- links
  let productUrl: string | null = null;
  if (f.product_url) {
    const u = parseHttpUrl(urlCell(f.product_url));
    if (!u.ok) warn('product_url', u.code, u.message, urlCell(f.product_url));
    else productUrl = u.value;
  }
  const imageUrls: string[] = [];
  for (const col of f.image_urls ?? []) {
    for (const candidate of splitUrls(urlCell(col))) {
      const u = parseHttpUrl(candidate);
      if (!u.ok) warn(col, 'invalid_image_url', u.message, candidate);
      else if (u.value && !imageUrls.includes(u.value)) imageUrls.push(u.value);
    }
  }
  if (imageUrls.length > MAX_IMAGES_PER_ROW) {
    warn('image_urls', 'too_many_images', `Oltre ${MAX_IMAGES_PER_ROW} immagini: considerate solo le prime`);
    imageUrls.length = MAX_IMAGES_PER_ROW;
  }

  const attributes: Record<string, string> = {};
  for (const a of ATTRIBUTE_FIELDS) {
    const v = text(cell(f[a]), 200);
    if (v) attributes[a] = v;
  }

  const title = text(cell(f.title), 500);
  if (!title) warn('title', 'missing_title', 'Titolo mancante');

  if (issues.some((i) => i.severity === 'error')) return { rowNumber: row.rowNumber, sku, offer: null, issues };

  return {
    rowNumber: row.rowNumber,
    sku,
    issues,
    offer: {
      sku,
      barcode,
      title,
      brand: text(cell(f.brand), 200),
      description: toPlainText(cell(f.description)),
      categoryRaw: text(cell(f.category), 300),
      attributes,
      price,
      currency,
      vatTreatment: defaults.vatTreatment,
      vatRate,
      salesUnit: text(cell(f.sales_unit), 50) ?? defaults.salesUnit,
      unitsPerPack,
      moq,
      priceTiers,
      stockQuantity: qtyCell.negative ? null : stock.quantity,
      stockStatus,
      availabilityRaw,
      leadTimeDays: parseLeadTimeDays(cell(f.lead_time)),
      leadTimeRaw,
      productUrl,
      imageUrls,
    },
  };
}

/** Stable JSON used for the row hash (unchanged rows are detected and skipped). */
export function offerFingerprint(o: NormalizedOffer): string {
  const { barcode, ...rest } = o;
  return stableStringify({ ...rest, barcodeRaw: barcode.raw?.trim() ?? null });
}
