// CSV/XLSX readers. Output rows are plain objects keyed by (de-duplicated) header, with string/number
// cell values. Formulas are never evaluated: XLSX cached results are used and flagged.
// XLSX are untrusted ZIP containers read fully in memory: they are inspected first (xlsx-guard.ts) and
// read one at a time per process, so peak memory stays bounded by XLSX_MAX_UNCOMPRESSED_BYTES.
import { parse as parseCsvSync } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import ExcelJS from 'exceljs';
import type { ParseOptions } from './fields.ts';
import { config } from '../config.ts';
import { inspectXlsxContainer, ZipLimitError } from './xlsx-guard.ts';

export const XLSX_MAX_PARTS = 5000;

export type CellValue = string | number | null;

export interface ParsedRow {
  rowNumber: number; // 1-based line/row number in the source file
  values: Record<string, CellValue>;
  /** Headers whose XLSX cell was numeric (codes may have lost leading zeros / precision). */
  numeric?: string[];
  /** Headers whose XLSX cell held a formula (cached result used). */
  formula?: string[];
  /** Hyperlink targets of XLSX cells (the visible text stays the value; links are used only for URL fields). */
  links?: Record<string, string>;
}

export interface ParsedFile {
  kind: 'csv' | 'xlsx';
  headers: string[];
  rows: ParsedRow[];
  totalRows: number;
  detected: { encoding?: string; delimiter?: string; sheet?: string; sheets?: string[]; decimalSeparator?: '.' | ',' };
  warnings: string[];
}

export class ImportFileError extends Error {}

export function detectFileKind(fileName: string, bytes: Buffer): 'csv' | 'xlsx' {
  // Content sniffing first: XLSX is a ZIP container ("PK\x03\x04").
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new ImportFileError('File .xls (Excel 97-2003) non supportato: salvarlo come .xlsx o .csv');
  }
  if (bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0) && !hasUtf16Bom(bytes)) {
    throw new ImportFileError('Il file non sembra un CSV di testo né un XLSX');
  }
  void fileName;
  return 'csv';
}

function hasUtf16Bom(b: Buffer): boolean {
  return b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));
}

export function decodeText(bytes: Buffer, requested?: string): { text: string; encoding: string } {
  if (requested && requested !== 'auto') {
    if (!iconv.encodingExists(requested)) throw new ImportFileError(`Codifica non supportata: ${requested}`);
    return { text: iconv.decode(bytes, requested).replace(/^﻿/, ''), encoding: requested };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: iconv.decode(bytes.subarray(2), 'utf-16le'), encoding: 'utf-16le' };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: iconv.decode(bytes.subarray(2), 'utf-16be'), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // Most common legacy encoding for Italian Excel/ERP exports.
    return { text: iconv.decode(bytes, 'windows-1252'), encoding: 'windows-1252' };
  }
}

export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 25);
  const candidates = [';', ',', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    if (!counts.length || counts[0] === 0) continue;
    const consistent = counts.filter((c) => c === counts[0]).length / counts.length;
    const score = consistent * 1000 + counts[0];
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

export function dedupeHeaders(raw: unknown[]): string[] {
  // Every generated name is checked too: ['Img', 'Img', 'Img (2)'] must not produce two "Img (2)".
  const used = new Set<string>();
  return raw.map((h, i) => {
    const base = String(h ?? '').replace(/\s+/g, ' ').trim() || `Colonna ${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
    used.add(name);
    return name;
  });
}

/** Guesses the decimal separator from sample numeric-looking strings. */
export function guessDecimalSeparator(samples: string[]): '.' | ',' {
  let comma = 0;
  let dot = 0;
  for (const s of samples) {
    const t = s.trim();
    if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(t) || /^-?\d+,\d{1,4}$/.test(t)) comma++;
    else if (/^-?\d{1,3}(,\d{3})*\.\d+$/.test(t) || /^-?\d+\.\d{1,4}$/.test(t)) dot++;
  }
  return comma > dot ? ',' : '.';
}

export function parseCsv(bytes: Buffer, opts: ParseOptions, maxRows?: number): ParsedFile {
  const { text, encoding } = decodeText(bytes, opts.encoding);
  const delimiter = opts.delimiter && opts.delimiter !== 'auto' ? (opts.delimiter === '\\t' ? '\t' : opts.delimiter) : detectDelimiter(text);
  const headerRow = Math.max(1, opts.headerRow ?? 1);
  let records: string[][];
  try {
    records = parseCsvSync(text, {
      delimiter,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
      bom: true,
      to_line: maxRows ? headerRow + maxRows : undefined,
      info: false,
    }) as string[][];
  } catch (err) {
    throw new ImportFileError(`CSV non leggibile: ${(err as Error).message}`);
  }
  if (records.length < headerRow) throw new ImportFileError('Riga di intestazione non trovata');
  const headers = dedupeHeaders(records[headerRow - 1]);
  const rows: ParsedRow[] = [];
  for (let i = headerRow; i < records.length; i++) {
    const rec = records[i];
    if (!rec || rec.every((c) => String(c ?? '').trim() === '')) continue;
    const values: Record<string, CellValue> = {};
    headers.forEach((h, j) => {
      const v = rec[j];
      values[h] = v === undefined || v === '' ? null : v;
    });
    rows.push({ rowNumber: i + 1, values });
  }
  const samples = rows.slice(0, 200).flatMap((r) => Object.values(r.values).filter((v): v is string => typeof v === 'string'));
  return {
    kind: 'csv',
    headers,
    rows,
    totalRows: rows.length,
    detected: { encoding, delimiter, decimalSeparator: guessDecimalSeparator(samples) },
    warnings: [],
  };
}

let xlsxQueue: Promise<unknown> = Promise.resolve();

/** At most one XLSX read at a time in this process: each one can take ~15x its uncompressed size in RAM. */
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = xlsxQueue.then(fn, fn);
  xlsxQueue = run.catch(() => {});
  return run;
}

export function parseXlsx(bytes: Buffer, opts: ParseOptions, maxRows?: number): Promise<ParsedFile> {
  return oneAtATime(() => parseXlsxNow(bytes, opts, maxRows));
}

async function parseXlsxNow(bytes: Buffer, opts: ParseOptions, maxRows?: number): Promise<ParsedFile> {
  try {
    inspectXlsxContainer(bytes, { maxEntries: XLSX_MAX_PARTS, maxUncompressedBytes: config.XLSX_MAX_UNCOMPRESSED_BYTES });
  } catch (err) {
    if (err instanceof ZipLimitError) throw new ImportFileError(`XLSX rifiutato: ${err.message}`);
    throw err;
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as any);
  } catch (err) {
    throw new ImportFileError(`XLSX non leggibile: ${(err as Error).message}`);
  }
  const sheets = wb.worksheets.filter((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden').map((ws) => ws.name);
  const sheetName = opts.sheet && sheets.includes(opts.sheet) ? opts.sheet : sheets.find((n) => (wb.getWorksheet(n)?.actualRowCount ?? 0) > 0) ?? sheets[0];
  const ws = sheetName ? wb.getWorksheet(sheetName) : undefined;
  if (!ws) throw new ImportFileError('Nessun foglio con dati nel file XLSX');
  const headerRow = Math.max(1, opts.headerRow ?? 1);
  const headerCells = ws.getRow(headerRow);
  const colCount = Math.max(ws.actualColumnCount, headerCells.cellCount);
  const rawHeaders: unknown[] = [];
  for (let c = 1; c <= colCount; c++) rawHeaders.push(cellToValue(headerCells.getCell(c)).value);
  const headers = dedupeHeaders(rawHeaders);
  const rows: ParsedRow[] = [];
  const warnings = new Set<string>();
  const last = ws.rowCount;
  for (let r = headerRow + 1; r <= last; r++) {
    if (maxRows && rows.length >= maxRows) break;
    const row = ws.getRow(r);
    if (!row.hasValues) continue;
    const values: Record<string, CellValue> = {};
    const numeric: string[] = [];
    const formula: string[] = [];
    let links: Record<string, string> | undefined;
    let any = false;
    headers.forEach((h, j) => {
      const conv = cellToValue(row.getCell(j + 1));
      values[h] = conv.value;
      if (conv.link) (links ??= {})[h] = conv.link;
      if (conv.value !== null && String(conv.value).trim() !== '') any = true;
      if (conv.numeric) numeric.push(h);
      if (conv.formula) formula.push(h);
      if (conv.error) warnings.add(`Celle con errore Excel (es. riga ${r}): valore ignorato`);
    });
    if (!any) continue;
    rows.push({ rowNumber: r, values, numeric: numeric.length ? numeric : undefined, formula: formula.length ? formula : undefined, links });
  }
  return {
    kind: 'xlsx',
    headers,
    rows,
    totalRows: rows.length,
    detected: { sheet: sheetName, sheets, decimalSeparator: '.' },
    warnings: [...warnings],
  };
}

function cellToValue(cell: ExcelJS.Cell): { value: CellValue; numeric?: boolean; formula?: boolean; error?: boolean; link?: string } {
  const v = cell.value as any;
  if (v === null || v === undefined) return { value: null };
  if (typeof v === 'number') return { value: numberCell(v), numeric: true };
  if (typeof v === 'string') return { value: v };
  if (typeof v === 'boolean') return { value: v ? 'TRUE' : 'FALSE' };
  if (v instanceof Date) return { value: v.toISOString() };
  if (typeof v === 'object') {
    if ('error' in v) return { value: null, error: true };
    if ('formula' in v || 'sharedFormula' in v) {
      const res = v.result;
      if (res === undefined || res === null || (typeof res === 'object' && 'error' in res)) return { value: null, formula: true };
      if (typeof res === 'number') return { value: numberCell(res), numeric: true, formula: true };
      return { value: res instanceof Date ? res.toISOString() : String(res), formula: true };
    }
    if ('richText' in v) return { value: (v.richText as Array<{ text: string }>).map((t) => t.text).join('') };
    if ('hyperlink' in v) {
      // The visible text is the value (an SKU or a title with a link stays itself); the target is kept
      // aside for URL fields.
      const text = typeof v.text === 'string' ? v.text : v.text?.richText?.map((t: any) => t.text).join('');
      const link = typeof v.hyperlink === 'string' ? v.hyperlink : undefined;
      return { value: text ?? link ?? null, link };
    }
  }
  return { value: String(v) };
}

/** Numbers are kept as numbers only when exactly representable; otherwise the string shows the loss. */
function numberCell(n: number): CellValue {
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) return n.toExponential(); // > 2^53: digits already lost
  return n;
}

export async function parseImportFile(kind: 'csv' | 'xlsx', bytes: Buffer, opts: ParseOptions, maxRows?: number): Promise<ParsedFile> {
  return kind === 'xlsx' ? parseXlsx(bytes, opts, maxRows) : parseCsv(bytes, opts, maxRows);
}
