export type Role = 'admin' | 'operator';
export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'on_order' | 'unknown';

export interface BestPrice {
  offerId: string;
  supplierId: string;
  unitPrice: string;
  currency: string;
  stockStatus: StockStatus;
  moq: number | null;
  unitsPerPack: number;
}

export interface PriceSummary {
  best: BestPrice | null;
  cheaperSoldOut: BestPrice | null;
  currency: string | null;
  comparableCount: number;
  notComparableCount: number;
  otherCurrencies: string[];
}

export interface ProductCard {
  id: string;
  title: string;
  brand: string | null;
  imageId: string | null;
  gtin: string | null;
  offerCount: number;
  supplierCount: number;
  availableSupplierCount: number;
  bestPrice: PriceSummary | null;
  imageCount: number;
  dataAsOf: string | null;
  stale: boolean;
  matchedBy?: 'gtin' | 'barcode_raw' | 'sku' | 'text';
}

export interface CatalogPage {
  items: ProductCard[];
  total: number;
  offset: number;
  limit: number;
  mode: string;
}

export interface Facets {
  suppliers: Array<{ id: string; name: string; products: number }>;
  brands: Array<{ brand: string; products: number }>;
  categories: Array<{ id: string; name: string; products: number }>;
}

export interface Candidate {
  product: ProductCard;
  group: 'confirmed' | 'possible' | 'similar';
  score: number | null;
  matchedImageId: string | null;
  matchingImages?: number;
  evidence: Array<{ kind: 'barcode' | 'visual' | 'shared_image'; text: string }>;
}

export interface PhotoSearchResult {
  searchId: string;
  status: 'ok' | 'provider_unavailable' | 'failed';
  message: string | null;
  barcode: { text: string; status: string; gtin: string | null; matchedProducts: number } | null;
  candidates: Candidate[];
  abstained: boolean;
  coverage: { indexed: number; assets: number; pending: number } | null;
  model: { key: string; calibrated: boolean } | null;
  timings: Record<string, number>;
  imageAvailable?: boolean;
  imageExpiresAt?: string;
  createdAt?: string;
  feedback?: Array<{ verdict: string; product_id: string | null; note: string | null; created_at: string }>;
}

export interface Offer {
  id: string;
  supplier: { id: string; name: string; code: string };
  sku: string;
  active: boolean;
  deactivatedAt: string | null;
  linkSource: 'gtin' | 'standalone' | 'manual' | 'conflict_hold';
  barcode: { raw: string | null; status: string; format: string | null; issue: string | null; gtin: string | null };
  title: string | null;
  brand: string | null;
  description: string | null;
  categoryRaw: string | null;
  categoryName: string | null;
  attributes: Record<string, string>;
  price: string | null;
  currency: string | null;
  vatTreatment: 'net' | 'gross' | 'unknown';
  vatRate: string | null;
  salesUnit: string | null;
  unitsPerPack: number | null;
  moq: number | null;
  priceTiers: Array<{ minQty: number; price: string }> | null;
  netPackPrice: string | null;
  netUnitPrice: string | null;
  netDerivedFromGross: boolean;
  comparable: boolean;
  notComparableReasons: string[];
  stockQuantity: number | null;
  stockStatus: StockStatus;
  availabilityRaw: string | null;
  leadTimeDays: number | null;
  leadTimeRaw: string | null;
  productUrl: string | null;
  dataAsOf: string;
  lastSeenAt: string;
  stale: boolean;
  staleReason: string | null;
  lastImportId: string | null;
  sourceRow?: Record<string, unknown>;
}

export interface ProductDetail {
  mergedInto?: string;
  product: {
    id: string;
    status: string;
    title: string;
    brand: string | null;
    categoryId: string | null;
    categoryName: string | null;
    attributes: Record<string, string>;
    canonicalSources: Record<string, any>;
    overrides: { title: string | null; brand: string | null; categoryId: string | null; categoryName: string | null; primaryImageId: string | null };
    bestPrice: PriceSummary | null;
    dataAsOf: string | null;
    offerCount: number;
    supplierCount: number;
    availableSupplierCount: number;
  };
  identifiers: Array<{ value: string; display: string; source: string; evidence: string | null; created_at: string; created_by: string | null }>;
  offers: Offer[];
  gallery: Array<{ id: string; width: number; height: number; supplierId: string; supplierName: string; sourceUrl?: string; searchable: boolean }>;
  images: { pending: number; failed: number; activeModel: string | null };
  reviews: Array<{ id: string; kind: string; reasons: any[]; other_title: string; other_id: string }>;
  history: Array<{ id: number; at: string; action: string; reason: string | null; data: any; actor_kind: string; actor_name: string | null; reverted_by_event_id: number | null; reverts_event_id: number | null }>;
  recentChanges: OfferChange[];
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  website: string | null;
  priority: number;
  defaultCurrency: string;
  defaultVatTreatment: 'net' | 'gross' | 'unknown';
  defaultVatRate: string | null;
  imageHostAllowlist: string[];
  staleAfterHours: number;
  connectorKind: string;
  refreshIntervalMinutes: number | null;
  active: boolean;
  notes: string | null;
  lastImportStatus: 'succeeded' | 'failed' | null;
  lastImportFinishedAt: string | null;
  lastSuccessAsOf: string | null;
  feedEnabled?: boolean;
  feedNextRunAt?: string | null;
  feedLastStatus?: string | null;
  feedScheduleText?: string | null;
  stats?: { activeOffers: number; inactiveOffers: number; imagesPending: number; imagesFailed: number; unmappedCategories: number };
}

export interface ImportRun {
  id: string;
  supplierId: string;
  supplierName?: string;
  status: 'uploaded' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  mode: 'snapshot' | 'delta';
  fileName: string;
  fileKind: 'csv' | 'xlsx';
  fileSize: number;
  asOf: string;
  counters: Record<string, number>;
  stagedRows: number | null;
  checkpointRow: number;
  attempts: number;
  error: string | null;
  snapshotResult: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  createdBy: string | null;
  sourceKind?: 'upload' | 'feed';
  mapping: any;
  defaults: any;
  parseOptions: any;
}

export interface ColumnMapping {
  fields: Record<string, string | string[]>;
  tiers?: Array<{ column: string; minQty: number }>;
}

export interface ImportDefaults {
  currency: string | null;
  vatTreatment: 'net' | 'gross' | 'unknown';
  vatRate: string | null;
  unitsPerPack: number | null;
  salesUnit: string | null;
}

export interface TargetField {
  key: string;
  label: string;
  required: boolean;
  help?: string;
  multi?: boolean;
}

export type ChangeType = 'price' | 'availability' | 'stock' | 'images' | 'image_replaced' | 'new_offer' | 'removed' | 'reactivated' | 'barcode';

export interface OfferChange {
  id: number;
  at: string;
  type: ChangeType;
  typeLabel: string;
  oldValue: any;
  newValue: any;
  pct: string | null;
  importRunId: string | null;
  source: 'upload' | 'feed' | null;
  supplier: { id: string; name: string };
  sku: string;
  offerTitle: string | null;
  product: { id: string; title: string; imageId: string | null; gtin: string | null } | null;
}

export type FeedSchedule = { kind: 'daily'; time: string; timezone: string } | { kind: 'hourly'; everyHours: number };

export interface FeedView {
  configured: boolean;
  secretsKeyConfigured: boolean;
  enabled: boolean;
  urlDisplay: string | null;
  authType: 'none' | 'basic' | 'bearer' | 'header';
  headerName: string | null;
  secretsSet: { url: boolean; username: boolean; password: boolean; token: boolean; header_value: boolean } | null;
  schedule: FeedSchedule;
  scheduleText: string | null;
  mode: 'snapshot' | 'delta';
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  lastStatus: 'queued' | 'failed' | 'postponed' | 'no_mapping' | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastRun: { id: string; status: string; error: string | null; counters: Record<string, number>; finished_at: string | null; created_at: string } | null;
}
