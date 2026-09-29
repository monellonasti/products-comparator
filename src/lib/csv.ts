/** CSV cell escaping (";" separator) that also neutralises spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Formula injection guard; a plain number (e.g. a -12.50 price change) is data, not a formula.
  if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 BOM + CRLF: opens correctly in Excel with Italian locale. */
export function csvDocument(header: string[], rows: unknown[][]): string {
  return `﻿${[header.map(csvCell).join(';'), ...rows.map((r) => r.map(csvCell).join(';'))].join('\r\n')}\r\n`;
}
