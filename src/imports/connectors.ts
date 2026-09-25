// Extension point for automatic supplier feeds/APIs.
//
// V1 ships only 'manual_upload' (CSV/XLSX uploaded by an admin). Supplier-specific connectors must be
// written only against real documentation and credentials. A connector returns a file (or rows) that
// goes through the SAME pipeline as uploads (staging, mapping, validation, upsert), so identity, price
// and snapshot rules stay in one place.
//
// Secrets: connector_config stores only NAMES of environment variables (e.g. {"tokenEnv": "SUPPLIER_X_TOKEN"});
// values are read from the environment at run time and never logged or sent to the browser.

export interface ConnectorFetchResult {
  fileName: string;
  fileKind: 'csv' | 'xlsx';
  bytes: Buffer;
  /** Timestamp the supplier data refers to (used for out-of-order protection). */
  asOf: Date;
  /** 'snapshot' only when the source guarantees the full catalogue. */
  mode: 'snapshot' | 'delta';
}

export interface SupplierConnector {
  readonly kind: string;
  /** Validates connector_config without contacting the supplier. */
  validateConfig(config: Record<string, unknown>): string[];
  fetch(supplier: { id: string; code: string; connectorConfig: Record<string, unknown> }): Promise<ConnectorFetchResult>;
}

const registry = new Map<string, SupplierConnector>();

export function registerConnector(c: SupplierConnector) {
  registry.set(c.kind, c);
}

export function getConnector(kind: string): SupplierConnector | undefined {
  return registry.get(kind);
}

export const MANUAL_UPLOAD = 'manual_upload';
