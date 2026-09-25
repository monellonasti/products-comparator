// Target fields of the import mapping and header auto-detection.
import { foldText } from '../lib/text.ts';

export const TARGET_FIELDS = [
  { key: 'sku', label: 'Codice fornitore (SKU)', required: true, help: 'Chiave univoca della riga presso il fornitore' },
  { key: 'barcode', label: 'EAN / GTIN', required: false, help: 'Conservato come testo, con zeri iniziali' },
  { key: 'title', label: 'Titolo', required: false },
  { key: 'brand', label: 'Marca', required: false },
  { key: 'description', label: 'Descrizione', required: false },
  { key: 'category', label: 'Categoria del fornitore', required: false },
  { key: 'price', label: 'Prezzo', required: false },
  { key: 'currency', label: 'Valuta', required: false },
  { key: 'vat_rate', label: 'Aliquota IVA %', required: false },
  { key: 'units_per_pack', label: 'Pezzi nel prezzo (confezione)', required: false },
  { key: 'sales_unit', label: 'Unità di vendita', required: false },
  { key: 'moq', label: 'Quantità minima (MOQ)', required: false },
  { key: 'stock_quantity', label: 'Giacenza (quantità)', required: false },
  { key: 'availability', label: 'Disponibilità (testo)', required: false },
  { key: 'lead_time', label: 'Tempi di consegna', required: false },
  { key: 'product_url', label: 'Link pagina prodotto', required: false },
  { key: 'image_urls', label: 'URL immagini (anche più colonne)', required: false, multi: true },
  { key: 'color', label: 'Colore', required: false },
  { key: 'size', label: 'Misura / taglia', required: false },
  { key: 'variant', label: 'Variante', required: false },
  { key: 'net_content', label: 'Contenuto netto', required: false },
  { key: 'pieces', label: 'Pezzi per articolo', required: false },
  { key: 'material', label: 'Materiale', required: false },
] as const;

export type TargetField = (typeof TARGET_FIELDS)[number]['key'];

export interface ColumnMapping {
  fields: Partial<Record<Exclude<TargetField, 'image_urls'>, string>> & { image_urls?: string[] };
  /** Quantity price breaks: column holding the unit price valid from minQty. */
  tiers?: Array<{ column: string; minQty: number }>;
}

export interface ImportDefaults {
  currency: string | null;
  vatTreatment: 'net' | 'gross' | 'unknown';
  vatRate: string | null;
  /** Units covered by the price when no column is mapped. null = not declared (not comparable). */
  unitsPerPack: number | null;
  salesUnit: string | null;
}

export interface ParseOptions {
  delimiter?: string;
  encoding?: string;
  sheet?: string;
  headerRow?: number;
  decimalSeparator?: '.' | ',';
}

const SYNONYMS: Record<Exclude<TargetField, 'image_urls'>, string[]> = {
  sku: ['sku', 'codice', 'cod', 'codice articolo', 'cod articolo', 'cod art', 'codice prodotto', 'articolo', 'art', 'item', 'item code', 'item number', 'item no', 'product code', 'part number', 'ref', 'reference', 'riferimento', 'artikelnummer', 'code', 'id articolo', 'codice fornitore'],
  barcode: ['ean', 'ean13', 'ean 13', 'gtin', 'gtin13', 'barcode', 'codice a barre', 'upc', 'ean code', 'codice ean', 'bar code'],
  title: ['titolo', 'nome', 'nome prodotto', 'descrizione breve', 'name', 'product name', 'title', 'descrizione articolo', 'denominazione', 'prodotto', 'product', 'bezeichnung', 'articolo descrizione'],
  brand: ['marca', 'brand', 'marchio', 'produttore', 'manufacturer', 'hersteller', 'marque'],
  description: ['descrizione', 'description', 'descrizione lunga', 'long description', 'dettagli', 'beschreibung'],
  category: ['categoria', 'category', 'famiglia', 'gruppo', 'reparto', 'categories', 'sottocategoria', 'kategorie', 'linea'],
  price: ['prezzo', 'price', 'prezzo netto', 'net price', 'listino', 'prezzo acquisto', 'costo', 'wholesale', 'wholesale price', 'prezzo rivenditore', 'preis', 'prezzo unitario', 'unit price', 'prezzo b2b', 'dealer price'],
  currency: ['valuta', 'currency', 'divisa', 'wahrung'],
  vat_rate: ['iva', 'aliquota', 'vat', 'tax', 'aliquota iva', 'vat rate', 'iva %', 'mwst'],
  units_per_pack: ['pezzi per prezzo', 'pezzi per confezione', 'pz conf', 'pz confezione', 'pack size', 'qty per pack', 'units per pack', 'inner', 'pezzi confezione', 'multiplo', 'pezzi per cartone'],
  sales_unit: ['unita', 'um', 'u m', 'unit', 'uom', 'unita di misura', 'unita di vendita', 'sales unit'],
  moq: ['moq', 'minimo', 'qta minima', 'quantita minima', 'min order', 'minimum order', 'ordine minimo', 'min qty'],
  stock_quantity: ['giacenza', 'stock', 'qty', 'quantita', 'disponibili', 'qta', 'inventory', 'bestand', 'magazzino', 'qta disponibile', 'stock qty', 'quantity'],
  availability: ['disponibilita', 'availability', 'stato', 'status', 'stato disponibilita', 'verfugbarkeit'],
  lead_time: ['tempi di consegna', 'consegna', 'lead time', 'delivery', 'tempo consegna', 'delivery time', 'lieferzeit'],
  product_url: ['url', 'link', 'pagina', 'product url', 'url prodotto', 'link prodotto', 'product link'],
  color: ['colore', 'color', 'colour', 'farbe', 'couleur'],
  size: ['taglia', 'misura', 'size', 'dimensioni', 'dimensione', 'grosse'],
  variant: ['variante', 'variant', 'versione'],
  net_content: ['contenuto', 'capacita', 'formato', 'contenuto netto', 'volume', 'net content', 'inhalt'],
  pieces: ['pezzi', 'pezzi per articolo', 'pieces', 'pcs', 'pz'],
  material: ['materiale', 'material', 'materiali'],
};

const IMAGE_HEADER = /^(img|image|images|immagine|immagini|foto|picture|photo|bild)( ?(url|link))?( ?\d+)?$/;

export function normalizeHeader(h: string): string {
  return foldText(h).replace(/\s+/g, ' ');
}

/** Suggests a mapping from header names. Each column is used at most once. */
export function guessMapping(headers: string[]): ColumnMapping {
  const fields: ColumnMapping['fields'] = {};
  const used = new Set<string>();
  const norm = headers.map((h) => ({ h, n: normalizeHeader(h) }));
  for (const [field, words] of Object.entries(SYNONYMS) as Array<[Exclude<TargetField, 'image_urls'>, string[]]>) {
    const exact = norm.find((c) => !used.has(c.h) && words.includes(c.n));
    if (exact) {
      fields[field] = exact.h;
      used.add(exact.h);
    }
  }
  const images = norm.filter((c) => !used.has(c.h) && IMAGE_HEADER.test(c.n)).map((c) => c.h);
  if (images.length) {
    fields.image_urls = images;
    images.forEach((h) => used.add(h));
  }
  return { fields };
}

export function mappedColumns(mapping: ColumnMapping): string[] {
  const cols = new Set<string>();
  for (const [k, v] of Object.entries(mapping.fields)) {
    if (k === 'image_urls') (v as string[] | undefined)?.forEach((c) => cols.add(c));
    else if (typeof v === 'string' && v) cols.add(v);
  }
  mapping.tiers?.forEach((t) => cols.add(t.column));
  return [...cols];
}
