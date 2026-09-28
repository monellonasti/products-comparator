// Defensive inspection of an XLSX (ZIP) container BEFORE the XLSX library decompresses it in memory.
// A few MB of compressed data can expand to GBs ("zip bomb") and the reader keeps every part in memory.
// - central directory parsed with bounds checks (ZIP64 supported; multi-disk archives, encrypted entries
//   and compression methods other than stored/deflate refused)
// - limits on the number of parts and on the total DECLARED uncompressed size
// - every part is really inflated with a hard output cap equal to its declared size: a forged size is
//   detected (the reader trusts the compressed stream, not the header). Peak memory = one part.
// - XML parts must not contain a DTD: SpreadsheetML never needs one, and entity definitions are the basis
//   of "billion laughs" expansion.
import { inflateRawSync } from 'node:zlib';

export class ZipLimitError extends Error {}

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
}

export interface ZipSummary {
  entries: number;
  uncompressedBytes: number;
  largest: { name: string; bytes: number } | null;
}

const SIG = { eocd: 0x06054b50, zip64Locator: 0x07064b50, zip64Eocd: 0x06064b50, central: 0x02014b50, local: 0x04034b50 };
const U32_MAX = 0xffffffff;
const DTD_MARKERS = ['<!DOCTYPE', '<!ENTITY'].flatMap((m) => [Buffer.from(m, 'utf8'), Buffer.from(m, 'utf16le')]);

function fail(message: string): never {
  throw new ZipLimitError(message);
}

function u64(b: Buffer, at: number): number {
  if (at + 8 > b.length) fail('archivio ZIP danneggiato');
  const v = b.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail('archivio ZIP danneggiato');
  return Number(v);
}

function findEndOfCentralDirectory(b: Buffer): number {
  // 22-byte record + optional comment (max 65535): the last occurrence wins, like common readers.
  const stop = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= stop; i--) if (b.readUInt32LE(i) === SIG.eocd) return i;
  return -1;
}

interface Entry {
  name: string;
  method: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
}

function readCentralDirectory(b: Buffer, limits: ZipLimits): Entry[] {
  const eocd = findEndOfCentralDirectory(b);
  if (eocd < 0) fail('archivio ZIP non valido');
  if (b.readUInt16LE(eocd + 4) !== 0 || b.readUInt16LE(eocd + 6) !== 0 || b.readUInt16LE(eocd + 8) !== b.readUInt16LE(eocd + 10)) {
    fail('archivi ZIP divisi in più parti non supportati');
  }
  let count = b.readUInt16LE(eocd + 10);
  let size = b.readUInt32LE(eocd + 12);
  let offset = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === U32_MAX || offset === U32_MAX) {
    const locator = eocd - 20;
    if (locator < 0 || b.readUInt32LE(locator) !== SIG.zip64Locator) fail('archivio ZIP64 danneggiato');
    const z = u64(b, locator + 8);
    if (z + 56 > b.length || b.readUInt32LE(z) !== SIG.zip64Eocd) fail('archivio ZIP64 danneggiato');
    count = u64(b, z + 32);
    size = u64(b, z + 40);
    offset = u64(b, z + 48);
  }
  if (count > limits.maxEntries) fail(`troppe parti nell'archivio (${count}, massimo ${limits.maxEntries})`);
  const end = offset + size;
  if (end > b.length) fail('archivio ZIP danneggiato');

  const entries: Entry[] = [];
  let total = 0;
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || b.readUInt32LE(p) !== SIG.central) fail('archivio ZIP danneggiato');
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    let compressed = b.readUInt32LE(p + 20);
    let uncompressed = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    let localOffset = b.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > end) fail('archivio ZIP danneggiato');
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);

    if (uncompressed === U32_MAX || compressed === U32_MAX || localOffset === U32_MAX) {
      // ZIP64 extended information (header 0x0001): only the fields that overflowed are present, in order.
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      let found = false;
      while (e + 4 <= extraEnd) {
        const id = b.readUInt16LE(e);
        const len = b.readUInt16LE(e + 2);
        if (e + 4 + len > extraEnd) break;
        if (id === 0x0001) {
          let q = e + 4;
          const take = () => {
            if (q + 8 > e + 4 + len) fail('archivio ZIP64 danneggiato');
            const v = u64(b, q);
            q += 8;
            return v;
          };
          if (uncompressed === U32_MAX) uncompressed = take();
          if (compressed === U32_MAX) compressed = take();
          if (localOffset === U32_MAX) localOffset = take();
          found = true;
          break;
        }
        e += 4 + len;
      }
      if (!found) fail('archivio ZIP64 danneggiato');
    }
    if (flags & 0x1) fail('parti cifrate nell’archivio: non supportate');
    if (method !== 0 && method !== 8) fail(`metodo di compressione non supportato (${method})`);
    if (method === 0 && compressed !== uncompressed) fail('archivio ZIP danneggiato');
    total += uncompressed;
    if (total > limits.maxUncompressedBytes) {
      fail(`contenuto decompresso oltre ${Math.round(limits.maxUncompressedBytes / 1e6)} MB: file troppo grande o costruito per esaurire la memoria. Per listini molto grandi usare il CSV`);
    }
    entries.push({ name, method, compressed, uncompressed, localOffset });
    p = next;
  }
  return entries;
}

function containsDtd(xml: Buffer): boolean {
  return DTD_MARKERS.some((m) => xml.includes(m));
}

/** Throws ZipLimitError when the archive is malformed or exceeds the limits. */
export function inspectXlsxContainer(bytes: Buffer, limits: ZipLimits): ZipSummary {
  const entries = readCentralDirectory(bytes, limits);
  let largest: ZipSummary['largest'] = null;
  let total = 0;
  for (const e of entries) {
    const lh = e.localOffset;
    if (lh + 30 > bytes.length || bytes.readUInt32LE(lh) !== SIG.local) fail('archivio ZIP danneggiato');
    const start = lh + 30 + bytes.readUInt16LE(lh + 26) + bytes.readUInt16LE(lh + 28);
    if (start + e.compressed > bytes.length) fail('archivio ZIP danneggiato');
    const data = bytes.subarray(start, start + e.compressed);
    let out: Buffer;
    if (e.method === 0) out = data;
    else {
      try {
        // One byte of headroom: a stream that produces MORE than declared fails here instead of allocating.
        out = inflateRawSync(data, { maxOutputLength: e.uncompressed + 1 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') fail(`la parte ${e.name} contiene più dati di quanto dichiarato (possibile "zip bomb")`);
        fail('dati compressi danneggiati');
      }
    }
    if (out.length !== e.uncompressed) fail(`la parte ${e.name} ha una dimensione diversa da quella dichiarata (possibile "zip bomb")`);
    if (/\.(xml|rels|vml)$/i.test(e.name) && containsDtd(out)) fail(`la parte ${e.name} contiene una DTD o definizioni di entità: non ammesse`);
    total += out.length;
    if (!largest || out.length > largest.bytes) largest = { name: e.name, bytes: out.length };
  }
  return { entries: entries.length, uncompressedBytes: total, largest };
}
