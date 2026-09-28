// Generates DECLARED-SYNTHETIC demo data (fixtures/demo): three supplier price lists in different
// formats + rendered product images + "phone-like" query photos with labels.
// Neutral multi-brand, multi-category catalogue (hair/body care, hygiene, small appliances, accessories).
// The same item costs differently across suppliers (spread of a few %-25%), and three items also exist as
// OEM "twins" sold under a wholesaler's private label (same product, different brand and EAN, cheaper).
// Brands, names and EANs are fictitious. These fixtures exercise the pipeline end to end; they do NOT
// measure real-world visual accuracy (see docs/BENCHMARK.md).
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import { gs1CheckDigit } from '../lib/gtin.ts';
import { readFileSync } from 'node:fs';
import { zxingWasmPath } from '../vision/zxing-path.ts';

const OUT = path.resolve('fixtures/demo');
const IMG = path.join(OUT, 'images');
const QRY = path.join(OUT, 'queries');
const IMAGE_BASE = process.env.DEMO_IMAGE_BASE ?? 'http://127.0.0.1:4010';

// ---------------------------------------------------------------- EAN-13 symbols (zxing-wasm writer, local WASM)
async function barcodeDataUri(ean: string): Promise<string> {
  const writer = await import('zxing-wasm/writer');
  const wasm = readFileSync(zxingWasmPath('writer'));
  await writer.prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer }, fireImmediately: true });
  const res = await writer.writeBarcode(ean, { format: 'EAN13', scale: 4, addHRT: true, addQuietZones: true });
  const png = await sharp(Buffer.from(res.svg)).flatten({ background: '#ffffff' }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

// ---------------------------------------------------------------- deterministic randomness
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260925);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const between = (a: number, b: number) => a + rnd() * (b - a);

// ---------------------------------------------------------------- catalogue definition
type Shape = 'bottle' | 'tube' | 'box' | 'dryer' | 'jar' | 'ring' | 'brush';
interface Product {
  key: string;
  ean: string;
  brand: string;
  name: string;
  shape: Shape;
  color: string;
  accent: string;
  category: string;
  colorName: string;
  size: string;
  imageKey: string; // products sharing imageKey share the same catalogue photo (case D)
  base: number; // reference net price: each supplier applies its own spread
  oemOf?: string; // private-label twin: key of the branded product it is identical to
  owner?: 'beta' | 'gamma'; // wholesaler selling the private-label twin
}

const BRANDS = ['Quellora', 'Brivanto', 'Solvetta', 'Tessavo', 'Olvari', 'Marvessa'];
const PRIVATE_LABELS = { beta: 'Beta Essentials', gamma: 'Linea Gamma' } as const;
const COLORS: Array<[string, string, string]> = [
  ['#b0306a', '#f7c6da', 'Fucsia'], ['#5b2a86', '#d9c2f0', 'Viola'], ['#1f5f8b', '#bfe0f5', 'Blu'], ['#222428', '#9aa0a6', 'Nero'],
  ['#c9745a', '#f5d7c9', 'Rosa cipria'], ['#2f7d5b', '#c5ead9', 'Verde'], ['#d4a017', '#f6e7b0', 'Oro'],
];
const LINES: Array<{ shape: Shape; category: string; names: string[]; sizes: string[]; price: [number, number] }> = [
  { shape: 'bottle', category: 'Cura capelli', names: ['Shampoo Nutriente', 'Shampoo Delicato', 'Balsamo Lisciante', 'Olio Capelli'], sizes: ['250 ml', '500 ml', '1000 ml'], price: [3.2, 9.5] },
  { shape: 'tube', category: 'Cura del corpo', names: ['Crema Mani', 'Crema Viso Idratante', 'Gel Doccia Agrumi'], sizes: ['75 ml', '150 ml'], price: [2.8, 11] },
  { shape: 'box', category: 'Igiene', names: ['Dischetti Cotone', 'Salviette Struccanti', 'Cerotti Delicati', 'Testine Spazzolino'], sizes: ['20 pz', '40 pz'], price: [1.6, 7.5] },
  { shape: 'dryer', category: 'Piccoli elettrodomestici', names: ['Asciugacapelli Pro', 'Asciugacapelli Compact', 'Asciugacapelli Ionico', 'Asciugacapelli Travel'], sizes: ['Standard'], price: [19, 58] },
  { shape: 'brush', category: 'Piccoli elettrodomestici', names: ['Spazzolino Sonico', 'Spazzolino Ricaricabile', 'Spazzolino Junior'], sizes: ['Standard'], price: [14, 42] },
  { shape: 'jar', category: 'Cura del corpo', names: ['Burro Corpo', 'Scrub Corpo'], sizes: ['200 ml'], price: [5.5, 13] },
  { shape: 'ring', category: 'Accessori capelli', names: ['Elastici Spirale', 'Elastici Duo'], sizes: ['Standard'], price: [1.2, 4.5] },
];
// Private-label twins (the "same item, other brand" case the photo search must surface).
const TWINS: Array<{ of: string; owner: 'beta' | 'gamma'; name: string }> = [
  { of: 'p013', owner: 'beta', name: 'Asciugacapelli 2200W' },
  { of: 'p003', owner: 'beta', name: 'Balsamo Capelli Lisci' },
  { of: 'p021', owner: 'gamma', name: 'Spazzolino Elettrico Sonic' },
];

let eanSeq = 1;
function nextEan(): string {
  const body = `80099${String(eanSeq++).padStart(7, '0')}`;
  return body + gs1CheckDigit(body);
}

function buildCatalogue(): Product[] {
  const products: Product[] = [];
  let n = 0;
  for (const line of LINES) {
    for (const name of line.names) {
      const brand = pick(BRANDS);
      const variants = line.shape === 'dryer' || line.shape === 'brush' ? 2 : 1;
      const usedColors = new Set<number>();
      for (let v = 0; v < variants; v++) {
        let ci = Math.floor(rnd() * COLORS.length);
        while (usedColors.has(ci)) ci = (ci + 1) % COLORS.length;
        usedColors.add(ci);
        const [color, accent, colorName] = COLORS[ci];
        const imageKey = `p${String(++n).padStart(3, '0')}`;
        const base = between(line.price[0], line.price[1]);
        line.sizes.slice(0, line.shape === 'bottle' ? 2 : 1).forEach((size, si) => {
          const ref = Math.round(base * (1 + 0.65 * si) * 100) / 100; // bigger size, higher price
          products.push({ key: `${imageKey}-${size.replace(/\s/g, '')}`, ean: nextEan(), brand, name, shape: line.shape, color, accent, category: line.category, colorName, size, imageKey, base: ref });
        });
      }
    }
  }
  return products;
}

function buildTwins(catalogue: Product[]): Product[] {
  return TWINS.map((t, i) => {
    const src = catalogue.find((p) => p.imageKey === t.of)!;
    const n = String(i + 1).padStart(2, '0');
    return { ...src, key: `t${n}`, ean: nextEan(), brand: PRIVATE_LABELS[t.owner], name: t.name, imageKey: `t${n}`, base: Math.round(src.base * between(0.74, 0.84) * 100) / 100, oemOf: src.key, owner: t.owner };
  });
}

// ---------------------------------------------------------------- rendering
function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function productSvg(p: Product, variant: 'a' | 'b', transparent = false, barcode: string | null = null): string {
  const W = 800;
  const c = p.color;
  const a = p.accent;
  const label = `<text x="400" y="%Y%" font-family="Arial, Helvetica, sans-serif" font-size="%S%" font-weight="700" text-anchor="middle" fill="%F%">${esc(p.brand.toUpperCase())}</text>`;
  const sub = `<text x="400" y="%Y%" font-family="Arial, Helvetica, sans-serif" font-size="26" text-anchor="middle" fill="%F%">${esc(p.name)}</text>`;
  const fit = (size: number) => Math.round(Math.min(size, (size * 9) / Math.max(9, p.brand.length)));
  const L = (y: number, size: number, fill: string) => label.replace('%Y%', String(y)).replace('%S%', String(fit(size))).replace('%F%', fill);
  const S = (y: number, fill: string) => sub.replace('%Y%', String(y)).replace('%F%', fill);
  let body = '';
  switch (p.shape) {
    case 'bottle':
      body = `<rect x="370" y="110" width="60" height="40" rx="6" fill="#333"/><rect x="340" y="95" width="120" height="22" rx="8" fill="#444"/>
        <rect x="355" y="150" width="90" height="50" rx="10" fill="${a}"/>
        <rect x="270" y="195" width="260" height="480" rx="60" fill="${c}"/>
        <rect x="295" y="330" width="210" height="200" rx="14" fill="${a}"/>${L(410, 34, c)}${S(450, '#333')}
        <text x="400" y="505" font-family="Arial" font-size="24" text-anchor="middle" fill="#555">${esc(p.size)}</text>`;
      break;
    case 'tube':
      body = `<path d="M300 120 L500 120 L470 610 L330 610 Z" fill="${c}"/><rect x="345" y="610" width="110" height="70" rx="10" fill="#2b2b2b"/>
        <rect x="300" y="110" width="200" height="22" fill="${a}"/>${L(330, 36, a)}${S(380, '#fff')}`;
      break;
    case 'box':
      body = `<path d="M210 250 L530 250 L610 190 L290 190 Z" fill="${a}"/><path d="M530 250 L610 190 L610 600 L530 660 Z" fill="${c}" opacity="0.75"/>
        <rect x="210" y="250" width="320" height="410" fill="${c}"/><circle cx="370" cy="380" r="70" fill="${a}"/>${L(520, 38, '#fff')}${S(565, a)}
        <text x="370" y="395" font-family="Arial" font-size="40" font-weight="700" text-anchor="middle" fill="${c}">${esc(p.size.replace(' pz', ''))}</text>
        ${barcode ? `<rect x="214" y="545" width="312" height="112" fill="#fff"/><image href="${barcode}" x="220" y="549" width="300" height="104" preserveAspectRatio="none"/>` : ''}`;
      break;
    case 'dryer': // hair dryer: barrel, rear grille, nozzle, handle with switch and cord
      body = `<rect x="160" y="190" width="400" height="200" rx="100" fill="${c}"/><rect x="540" y="228" width="110" height="124" rx="18" fill="${a}"/>
        <circle cx="262" cy="290" r="64" fill="${a}"/><circle cx="262" cy="290" r="40" fill="${c}" opacity="0.55"/>
        <path d="M330 370 L430 370 L410 660 L350 660 Z" fill="${c}"/><rect x="365" y="440" width="30" height="64" rx="8" fill="${a}"/>
        <rect x="355" y="652" width="50" height="22" rx="6" fill="#333"/>${L(740, 34, c)}`;
      break;
    case 'brush': // electric toothbrush: white head with bristles, neck, handle with button and charge LEDs
      body = `<rect x="368" y="78" width="64" height="96" rx="24" fill="#f4f4f4" stroke="#c9c9c9" stroke-width="4"/>
        <rect x="380" y="94" width="40" height="58" rx="10" fill="${a}"/><rect x="385" y="166" width="30" height="120" rx="12" fill="#e6e6e6"/>
        <rect x="342" y="272" width="116" height="410" rx="50" fill="${c}"/><circle cx="400" cy="400" r="24" fill="${a}"/>
        <rect x="372" y="468" width="16" height="8" rx="4" fill="${a}"/><rect x="392" y="468" width="16" height="8" rx="4" fill="${a}"/><rect x="412" y="468" width="16" height="8" rx="4" fill="${a}"/>
        ${L(740, 34, c)}`;
      break;
    case 'jar':
      body = `<rect x="230" y="260" width="340" height="360" rx="40" fill="${c}"/><rect x="215" y="200" width="370" height="90" rx="20" fill="${a}"/>
        <rect x="260" y="380" width="280" height="150" rx="12" fill="#ffffff" opacity="0.9"/>${L(450, 36, c)}${S(495, '#333')}`;
      break;
    case 'ring':
      body = `<path fill-rule="evenodd" fill="${c}" d="M200 380 a200 200 0 1 0 400 0 a200 200 0 1 0 -400 0 Z M280 380 a120 120 0 1 0 240 0 a120 120 0 1 0 -240 0 Z"/>
        <rect x="370" y="560" width="60" height="70" rx="12" fill="${a}"/>${L(720, 34, c)}`;
      break;
  }
  const bg = variant === 'a' ? '#ffffff' : '#f1f1f4';
  const shadow = `<ellipse cx="400" cy="700" rx="200" ry="22" fill="#000" opacity="${variant === 'a' ? 0.08 : 0.14}"/>`;
  const background = transparent ? '' : `<rect width="${W}" height="${W}" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}">${background}${shadow}${body}</svg>`;
}

async function renderCatalogImage(p: Product, variant: 'a' | 'b'): Promise<Buffer> {
  const base = sharp(Buffer.from(productSvg(p, variant)));
  if (variant === 'a') return base.jpeg({ quality: 90 }).toBuffer();
  // Another supplier's official photo of the same item: different background, slight rotation and crop.
  const rotated = await base.rotate(between(-6, 6), { background: '#f1f1f4' }).png().toBuffer();
  return sharp(rotated).resize(760, 760, { fit: 'cover' }).extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#f1f1f4' }).jpeg({ quality: 85 }).toBuffer();
}

function noiseBackground(w: number, h: number, tone: [number, number, number]): Buffer {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const band = Math.sin(y / 9 + rnd() * 0.3) * 10; // wood-like stripes
    for (let x = 0; x < w; x++) {
      const n = (rnd() - 0.5) * 30 + band;
      const i = (y * w + x) * 3;
      buf[i] = Math.max(0, Math.min(255, tone[0] + n));
      buf[i + 1] = Math.max(0, Math.min(255, tone[1] + n));
      buf[i + 2] = Math.max(0, Math.min(255, tone[2] + n));
    }
  }
  return buf;
}

/** "Smartphone photo": cluttered background, rotation, skew, lighting change, blur, JPEG artifacts. */
async function renderPhoneQuery(svg: string, closeUp = false): Promise<{ bytes: Buffer; bbox: { x: number; y: number; width: number; height: number } }> {
  const W = 1024;
  const H = 1365;
  // closeUp: the operator frames the package so that the barcode is readable (small tilt, larger object).
  const size = Math.round(closeUp ? between(840, 900) : between(560, 760));
  const shear = closeUp ? 0.02 : 0.08;
  const tilt = closeUp ? 4 : 18;
  let product = await sharp(Buffer.from(svg))
    .resize(size, size)
    .affine([[1, between(-shear, shear)], [between(-shear / 2, shear / 2), 1]], { background: '#00000000' })
    .rotate(between(-tilt, tilt), { background: '#00000000' })
    .modulate({ brightness: between(0.75, 1.1), saturation: between(0.85, 1.1) })
    .png()
    .toBuffer();
  let meta = await sharp(product).metadata();
  if (meta.width! > W || meta.height! > H) {
    product = await sharp(product).resize(W - 8, H - 8, { fit: 'inside' }).png().toBuffer();
    meta = await sharp(product).metadata();
  }
  const tones: Array<[number, number, number]> = [[150, 118, 90], [120, 125, 130], [190, 180, 165], [95, 80, 70]];
  const bg = sharp(noiseBackground(W, H, pick(tones)), { raw: { width: W, height: H, channels: 3 } });
  const left = Math.max(0, Math.round((W - meta.width!) / 2 + between(-80, 80)));
  const top = Math.max(0, Math.round((H - meta.height!) / 2 + between(-120, 120)));
  const x = Math.min(left, W - meta.width!);
  const y = Math.min(top, H - meta.height!);
  const composed = await bg.composite([{ input: product, left: x, top: y }]).png().toBuffer();
  const bytes = await sharp(composed).blur(closeUp ? between(0.4, 0.7) : between(0.6, 1.4)).jpeg({ quality: Math.round(closeUp ? between(80, 88) : between(62, 78)) }).toBuffer();
  // Region a user would crop (the pasted product square), relative to the photo.
  return { bytes, bbox: { x: x / W, y: y / H, width: meta.width! / W, height: meta.height! / H } };
}

// ---------------------------------------------------------------- price lists

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(IMG, { recursive: true });
  await mkdir(QRY, { recursive: true });
  const catalogue = buildCatalogue();
  const twins = buildTwins(catalogue);

  // Images: supplier A uses variant "a" (one photo shared by size variants: case D); supplier B variant "b".
  const rendered = new Set<string>();
  for (const p of catalogue) {
    if (rendered.has(p.imageKey)) continue;
    rendered.add(p.imageKey);
    await writeFile(path.join(IMG, `alfa-${p.imageKey}.jpg`), await renderCatalogImage(p, 'a'));
    await writeFile(path.join(IMG, `beta-${p.imageKey}.jpg`), await renderCatalogImage(p, 'b'));
  }
  // Twins: photographed by their owner (Beta style or Gamma using the manufacturer's white-background shot).
  for (const t of twins) {
    await writeFile(path.join(IMG, `${t.owner}-${t.imageKey}.jpg`), await renderCatalogImage(t, t.owner === 'beta' ? 'b' : 'a'));
  }

  // Supplier A (Alfa Distribuzione): CSV ';', windows-1252, decimal comma, Italian headers.
  const alfa = catalogue.filter((_, i) => i % 5 !== 4);
  const alfaRows = alfa.map((p, i) => ({
    'Codice Articolo': `ALF-${String(1000 + i)}`,
    EAN: p.ean,
    Descrizione: `${p.name} ${p.brand} ${p.colorName !== 'Nero' || p.shape !== 'box' ? p.colorName : ''} ${p.size}`.replace(/\s+/g, ' ').trim(),
    Marca: p.brand,
    Categoria: `${p.category} > ${p.brand}`,
    Colore: p.shape === 'box' ? '' : p.colorName,
    Contenuto: /ml$/.test(p.size) ? p.size : '',
    'Prezzo netto': (p.base * between(0.96, 1.2)).toFixed(2).replace('.', ','),
    'Pz/conf': '1',
    Giacenza: String(i % 7 === 0 ? 0 : i % 11 === 0 ? '' : Math.floor(between(1, 120))),
    'Immagine 1': `${IMAGE_BASE}/alfa-${p.imageKey}.jpg`,
    'Immagine 2': '',
    'Link prodotto': `https://alfa.example.com/p/ALF-${1000 + i}`,
  }));
  // Extra rows: missing EAN (case C, two rows) and an invalid check digit.
  alfaRows.push(
    { ...alfaRows[0], 'Codice Articolo': 'ALF-9001', EAN: '', Descrizione: 'Set Viaggio Deluxe', Marca: 'Tessavo', Categoria: 'Set regalo > Tessavo', 'Immagine 1': '' },
    { ...alfaRows[0], 'Codice Articolo': 'ALF-9002', EAN: '', Descrizione: 'Set Viaggio Classic', Marca: 'Tessavo', Categoria: 'Set regalo > Tessavo', 'Immagine 1': '' },
    { ...alfaRows[1], 'Codice Articolo': 'ALF-9003', EAN: `${alfaRows[1].EAN.slice(0, 12)}${(Number(alfaRows[1].EAN[12]) + 1) % 10}`, Descrizione: 'Candela Profumata Vaniglia', Marca: 'Marvessa' },
  );
  const alfaHeaders = Object.keys(alfaRows[0]);
  const alfaCsv = [alfaHeaders.join(';'), ...alfaRows.map((r) => alfaHeaders.map((h) => (r as any)[h]).join(';'))].join('\r\n') + '\r\n';
  await writeFile(path.join(OUT, 'alfa-distribuzione.csv'), iconv.encode(alfaCsv, 'windows-1252'));

  // "Day 2" feed of supplier Alfa (deterministic edits, no randomness): demonstrates the scheduled feed and
  // the change report (prices up/down, sold out, quantity, added image, a product leaving, a new product).
  const day2 = alfaRows.filter((r) => r['Codice Articolo'] !== 'ALF-1003').map((r) => ({ ...r }));
  const edit = (sku: string, f: (r: (typeof day2)[number]) => void) => {
    const r = day2.find((x) => x['Codice Articolo'] === sku);
    if (r) f(r);
  };
  const price2 = (v: string, factor: number) => (Number(v.replace(',', '.')) * factor).toFixed(2).replace('.', ',');
  edit('ALF-1000', (r) => (r['Prezzo netto'] = price2(r['Prezzo netto'], 1.1)));
  edit('ALF-1001', (r) => (r['Prezzo netto'] = price2(r['Prezzo netto'], 0.92)));
  edit('ALF-1002', (r) => (r.Giacenza = '0'));
  edit('ALF-1004', (r) => (r.Giacenza = String(Number(r.Giacenza || 0) + 15)));
  edit('ALF-1005', (r) => (r['Immagine 2'] = r['Immagine 1'].replace('/alfa-', '/beta-')));
  day2.push({ ...alfaRows[0], 'Codice Articolo': 'ALF-2001', EAN: '', Descrizione: 'Gel Doccia Menta 250 ml', Marca: 'Olvari', Categoria: 'Cura del corpo > Olvari', Colore: '', Contenuto: '250 ml', 'Prezzo netto': '3,40', Giacenza: '40', 'Immagine 1': '', 'Link prodotto': 'https://alfa.example.com/p/ALF-2001' });
  await mkdir(path.join(OUT, 'feeds'), { recursive: true });
  const day2Csv = [alfaHeaders.join(';'), ...day2.map((r) => alfaHeaders.map((h) => (r as any)[h]).join(';'))].join('\r\n') + '\r\n';
  await writeFile(path.join(OUT, 'feeds', 'alfa-listino-giorno2.csv'), iconv.encode(day2Csv, 'windows-1252'));

  // Supplier B (Beta Wholesale): XLSX, English headers, numeric prices, some packs of 5 (case F),
  // qualitative availability (case G), EAN mostly as text; two EANs stored as numbers.
  const beta = catalogue.filter((_, i) => i % 3 !== 2);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Pricelist');
  ws.addRow(['Item No', 'EAN Code', 'Product Name', 'Brand', 'Category', 'Colour', 'Unit Price', 'Pack', 'MOQ', 'Availability', 'Delivery', 'Image URL', 'Product URL']);
  const betaCategory = (c: string) =>
    ({ 'Cura capelli': 'Hair care', 'Cura del corpo': 'Body care', Igiene: 'Hygiene', 'Piccoli elettrodomestici': 'Small appliances', 'Accessori capelli': 'Hair accessories' })[c] ?? 'Other';
  beta.forEach((p, i) => {
    const pack = p.shape === 'box' ? 5 : 1;
    const avail = ['In stock', 'Low stock', 'Out of stock', 'In stock', 'Available', 'On order'][i % 6];
    const row = ws.addRow([
      `BW-${p.key.toUpperCase()}`,
      p.ean,
      `${p.brand} ${p.name} ${p.size} (${p.colorName.toLowerCase()})`,
      i % 4 === 0 ? `${p.brand} Srl` : p.brand,
      betaCategory(p.category),
      p.shape === 'box' ? null : p.colorName,
      Math.round(p.base * between(0.86, 1.12) * pack * 100) / 100,
      pack,
      i % 5 === 0 ? 3 : null,
      avail,
      ['2-3 days', '1 week', '5 giorni', '48h'][i % 4],
      `${IMAGE_BASE}/beta-${p.imageKey}.jpg`,
      `https://beta.example.com/item/${p.key}`,
    ]);
    if (i === 3 || i === 7) row.getCell(2).value = Number(p.ean); // numeric EAN cells (leading digits kept, but flagged when invalid)
    else row.getCell(2).numFmt = '@';
  });
  // Conflict: same EAN as a catalogue item but different brand and colour -> held for review.
  const target = catalogue.find((p) => p.shape === 'dryer')!;
  ws.addRow(['BW-CONFLICT-1', target.ean, 'Hair Dryer Pro (other brand)', 'OtherBrand', 'Small appliances', 'Giallo', 24.9, 1, null, 'In stock', '1 week', `${IMAGE_BASE}/beta-${target.imageKey}.jpg`, null]);
  // Beta's private label: OEM twins of branded items, cheaper, different EAN.
  for (const t of twins.filter((x) => x.owner === 'beta')) {
    ws.addRow([`BW-OWN-${t.imageKey.toUpperCase()}`, t.ean, `${t.brand} ${t.name} ${t.size} (${t.colorName.toLowerCase()})`, t.brand, betaCategory(t.category), t.colorName,
      t.base, 1, null, 'In stock', '48h', `${IMAGE_BASE}/beta-${t.imageKey}.jpg`, `https://beta.example.com/item/${t.key}`]).getCell(2).numFmt = '@';
  }
  await wb.xlsx.writeFile(path.join(OUT, 'beta-wholesale.xlsx'));

  // Supplier C (Gamma Import): CSV ',' UTF-8, gross prices with VAT column, some rows without EAN.
  const gamma = catalogue.filter((_, i) => i % 4 === 0);
  const gammaLines = ['sku,ean,title,brand,price_gross,vat,stock,image'];
  gamma.forEach((p, i) => {
    gammaLines.push([
      `GI${500 + i}`, i % 6 === 5 ? '' : p.ean, `"${p.name} – ${p.brand}, ${p.size}"`, p.brand,
      (p.base * between(0.9, 1.15) * 1.22).toFixed(2), '22', i % 3 === 0 ? 'disponibile' : String(Math.floor(between(0, 40))), `${IMAGE_BASE}/alfa-${p.imageKey}.jpg`,
    ].join(','));
  });
  // Gamma's private label (OEM twin).
  twins.filter((x) => x.owner === 'gamma').forEach((t, i) => {
    gammaLines.push([`GI-OWN-${i + 1}`, t.ean, `"${t.name} – ${t.brand}, ${t.colorName.toLowerCase()}"`, t.brand, (t.base * 1.22).toFixed(2), '22', '25', `${IMAGE_BASE}/gamma-${t.imageKey}.jpg`].join(','));
  });
  await writeFile(path.join(OUT, 'gamma-import.csv'), gammaLines.join('\n') + '\n', 'utf8');

  // Query photos: phone-like renders of catalogue items + out-of-catalogue objects (case H).
  const queries: Array<{ file: string; expectedEan: string | null; sameImageEans: string[]; oemTwinEans?: string[]; kind: string; note: string; bbox: object; hasBarcode: boolean }> = [];
  const sample = [...rendered].filter((_, i) => i % 2 === 0).slice(0, 16);
  let qn = 0;
  for (const imageKey of sample) {
    const p = catalogue.find((x) => x.imageKey === imageKey)!;
    const siblings = catalogue.filter((x) => x.imageKey === imageKey).map((x) => x.ean);
    const file = `q${String(++qn).padStart(2, '0')}-${imageKey}.jpg`;
    const withBarcode = p.shape === 'box';
    const q = await renderPhoneQuery(productSvg(p, rnd() < 0.5 ? 'a' : 'b', true, withBarcode ? await barcodeDataUri(p.ean) : null), withBarcode);
    await writeFile(path.join(QRY, file), q.bytes);
    const oem = twins.filter((t) => t.oemOf && catalogue.find((x) => x.key === t.oemOf)?.imageKey === imageKey).map((t) => t.ean);
    queries.push({ file, expectedEan: p.ean, sameImageEans: siblings, ...(oem.length ? { oemTwinEans: oem } : {}), kind: withBarcode ? 'in_catalog_barcode_closeup' : 'in_catalog', note: `${p.brand} ${p.name} ${p.colorName}${withBarcode ? ' (primo piano con barcode leggibile)' : ''}${oem.length ? ' (esiste anche con marchio del grossista: prodotto OEM identico)' : ''}`, bbox: q.bbox, hasBarcode: withBarcode });
  }
  const outsiders: Product[] = [
    { key: 'x1', ean: '', brand: 'Tervalo', name: 'Tazza Termica', shape: 'jar', color: '#e5d000', accent: '#1a1a1a', category: '', colorName: 'Giallo', size: '', imageKey: 'x1', base: 0 },
    { key: 'x2', ean: '', brand: 'Kivento', name: 'Penna Touch', shape: 'brush', color: '#ff6a00', accent: '#202020', category: '', colorName: 'Arancio', size: '', imageKey: 'x2', base: 0 },
    { key: 'x3', ean: '', brand: 'Nordavik', name: 'Scatola Scarpe', shape: 'box', color: '#00a86b', accent: '#fafafa', category: '', colorName: 'Verde', size: '42', imageKey: 'x3', base: 0 },
    { key: 'x4', ean: '', brand: 'Acquedra', name: 'Borraccia', shape: 'bottle', color: '#00b7eb', accent: '#ffffff', category: '', colorName: 'Azzurro', size: '750 ml', imageKey: 'x4', base: 0 },
  ];
  for (const o of outsiders) {
    const file = `q${String(++qn).padStart(2, '0')}-outside-${o.key}.jpg`;
    const q = await renderPhoneQuery(productSvg(o, 'a', true));
    await writeFile(path.join(QRY, file), q.bytes);
    queries.push({ file, expectedEan: null, sameImageEans: [], kind: 'out_of_catalog', note: `${o.brand} ${o.name} (non a catalogo; forma simile a prodotti presenti)`, bbox: q.bbox, hasBarcode: false });
  }
  await writeFile(path.join(OUT, 'queries.json'), JSON.stringify({ synthetic: true, generatedWith: 'src/scripts/demo-fixtures.ts', queries }, null, 2));
  await writeFile(
    path.join(OUT, 'catalogue.json'),
    JSON.stringify({
      synthetic: true,
      products: [...catalogue, ...twins].map(({ key, ean, brand, name, colorName, size, category, imageKey, oemOf, owner }) => ({ key, ean, brand, name, colorName, size, category, imageKey, ...(oemOf ? { oemOf, soldBy: owner } : {}) })),
    }, null, 2),
  );
  console.log(`catalogo sintetico: ${catalogue.length} prodotti + ${twins.length} gemelli OEM a marchio del grossista, ${rendered.size} foto per fornitore, ${queries.length} query`);
  console.log(`listini: alfa ${alfaRows.length} righe (CSV cp1252), beta ${beta.length + 1 + twins.filter((t) => t.owner === 'beta').length} righe (XLSX), gamma ${gammaLines.length - 1} righe (CSV utf-8)`);
}

await main();
