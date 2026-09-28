// Minimal ZIP writer for tests: builds valid (or deliberately malicious) XLSX containers byte by byte,
// e.g. with a forged declared size, ZIP64 fields, encryption flag or an unsupported method.
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipPart {
  name: string;
  data: Buffer | string;
  /** 0 = stored, 8 = deflate (default). Any other value is written as-is (data stored). */
  method?: number;
  /** Uncompressed size written in the headers (default: the real one). */
  declaredSize?: number;
  flags?: number;
  /** Write sizes as 0xFFFFFFFF with a ZIP64 extra field in the central directory. */
  zip64?: boolean;
}

export function buildZip(parts: ZipPart[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const raw = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8');
    const method = part.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const usize = part.declaredSize ?? raw.length;
    const name = Buffer.from(part.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(part.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);

    const extra = part.zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (part.zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(usize), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
    }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(45, 4);
    cd.writeUInt16LE(part.zip64 ? 45 : 20, 6);
    cd.writeUInt16LE(part.flags ?? 0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(part.zip64 ? 0xffffffff : body.length, 20);
    cd.writeUInt32LE(part.zip64 ? 0xffffffff : usize, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name, extra);
    offset += local.length + name.length + body.length;
  }
  const cdBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(cdBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBytes, eocd]);
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006';

/** Parts of a minimal valid XLSX with one sheet; `sheetXml` replaces the worksheet body. */
export function xlsxParts(sheetXml?: string): ZipPart[] {
  const sheet =
    sheetXml ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>Prezzo</t></is></c></row>` +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>A-1</t></is></c><c r="B2"><v>9.5</v></c></row>` +
      `</sheetData></worksheet>`;
  return [
    {
      name: '[Content_Types].xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${PKG}/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Listino" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ];
}
