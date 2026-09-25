-- 0001_init: core schema. See docs/DATA_MODEL.md for the ERD and invariants.
-- Extensions must already exist or the migration role must be allowed to create them
-- (docker-compose: POSTGRES_USER is superuser; WSL/managed: see scripts/dev/setup-wsl-postgres.sh).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS citext;

-- unaccent() is STABLE; indexes need an IMMUTABLE wrapper bound to a fixed dictionary.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ---------------------------------------------------------------- users & sessions
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin', 'operator')),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE TABLE sessions (
  token_hash    text PRIMARY KEY,               -- sha256(cookie token); the token itself is never stored
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  ip            text,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------- suppliers & import config
CREATE TABLE suppliers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                      text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name                      text NOT NULL,
  website                   text,
  -- lower value = higher precedence when choosing canonical title/brand/category/image
  priority                  integer NOT NULL DEFAULT 100,
  default_currency          char(3) NOT NULL DEFAULT 'EUR' CHECK (default_currency ~ '^[A-Z]{3}$'),
  default_vat_treatment     text NOT NULL DEFAULT 'unknown' CHECK (default_vat_treatment IN ('net', 'gross', 'unknown')),
  default_vat_rate          numeric(5, 2) CHECK (default_vat_rate >= 0 AND default_vat_rate < 100),
  image_host_allowlist      text[] NOT NULL DEFAULT '{}',
  stale_after_hours         integer NOT NULL DEFAULT 168 CHECK (stale_after_hours > 0),
  -- connector: 'manual_upload' today; see src/imports/connectors.ts for the extension interface.
  connector_kind            text NOT NULL DEFAULT 'manual_upload',
  connector_config          jsonb NOT NULL DEFAULT '{}',   -- never secrets: only env var names
  refresh_interval_minutes  integer CHECK (refresh_interval_minutes IS NULL OR refresh_interval_minutes >= 15),
  active                    boolean NOT NULL DEFAULT true,
  notes                     text,
  last_import_status        text CHECK (last_import_status IN ('succeeded', 'failed')),
  last_import_finished_at   timestamptz,
  last_success_as_of        timestamptz,   -- as-of of the newest successfully applied import
  last_snapshot_as_of       timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id    uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name           text NOT NULL DEFAULT 'default',
  file_kind      text NOT NULL CHECK (file_kind IN ('csv', 'xlsx')),
  parse_options  jsonb NOT NULL DEFAULT '{}',
  mapping        jsonb NOT NULL DEFAULT '{}',
  defaults       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, name)
);

-- ---------------------------------------------------------------- categories
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  parent_id   uuid REFERENCES categories(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE category_mappings (
  supplier_id   uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  raw_category  text NOT NULL,
  category_id   uuid REFERENCES categories(id) ON DELETE SET NULL,   -- NULL = seen, not yet mapped
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, raw_category)
);

-- ---------------------------------------------------------------- images (physical assets)
CREATE TABLE image_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256        text NOT NULL UNIQUE,     -- of the original bytes: byte-identical dedupe
  dhash         text,                     -- 64-bit difference hash (hex): near-duplicate hint only
  width         integer NOT NULL,
  height        integer NOT NULL,
  format        text NOT NULL,
  bytes         integer NOT NULL,
  original_key  text,                     -- only when IMAGE_KEEP_ORIGINALS=true
  thumb_key     text NOT NULL,
  display_key   text NOT NULL,
  infer_key     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- canonical products
CREATE TABLE products (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'archived')),
  merged_into_id              uuid REFERENCES products(id),
  -- canonical values: computed with deterministic precedence (src/domain/canonical.ts)
  title                       text NOT NULL DEFAULT '',
  brand                       text,
  category_id                 uuid REFERENCES categories(id) ON DELETE SET NULL,
  primary_image_id            uuid REFERENCES image_assets(id) ON DELETE SET NULL,
  attributes                  jsonb NOT NULL DEFAULT '{}',
  canonical_sources           jsonb NOT NULL DEFAULT '{}',
  -- manual overrides: never written by imports
  title_override              text,
  brand_override              text,
  category_override_id        uuid REFERENCES categories(id) ON DELETE SET NULL,
  primary_image_override_id   uuid REFERENCES image_assets(id) ON DELETE SET NULL,
  -- denormalised summary for the grid (recomputed in the same transaction as the change)
  offer_count                 integer NOT NULL DEFAULT 0,
  supplier_count              integer NOT NULL DEFAULT 0,
  available_supplier_count    integer NOT NULL DEFAULT 0,
  best_price                  jsonb,
  best_unit_price             numeric(14, 4),
  best_price_currency         char(3),
  has_gtin                    boolean NOT NULL DEFAULT false,
  primary_gtin                text,
  image_count                 integer NOT NULL DEFAULT 0,
  data_as_of                  timestamptz,
  search_text                 text NOT NULL DEFAULT '',
  search_tsv                  tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent(lower(search_text)))) STORED,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))
);
CREATE INDEX products_tsv_idx ON products USING gin (search_tsv);
CREATE INDEX products_trgm_idx ON products USING gin (f_unaccent(lower(search_text)) gin_trgm_ops);
CREATE INDEX products_grid_idx ON products (status, updated_at DESC, id);
CREATE INDEX products_title_idx ON products (status, lower(title), id);
CREATE INDEX products_price_idx ON products (status, best_unit_price, id);
CREATE INDEX products_brand_idx ON products (lower(brand));
CREATE INDEX products_category_idx ON products (category_id);

-- One product per canonical GTIN, globally. This unique index is the concurrency backstop for
-- EAN aggregation (imports additionally take an advisory lock per GTIN).
CREATE TABLE product_identifiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id),
  kind        text NOT NULL CHECK (kind IN ('gtin')),
  value       text NOT NULL,                       -- canonical GTIN-14
  source      text NOT NULL CHECK (source IN ('import', 'manual')),
  evidence    text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value),
  CHECK (kind <> 'gtin' OR value ~ '^[0-9]{14}$')
);
CREATE INDEX product_identifiers_product_idx ON product_identifiers (product_id);

-- ---------------------------------------------------------------- supplier offers
CREATE TABLE supplier_offers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id            uuid NOT NULL REFERENCES suppliers(id),
  supplier_sku           text NOT NULL CHECK (length(supplier_sku) BETWEEN 1 AND 200),
  product_id             uuid NOT NULL REFERENCES products(id),
  -- how the offer got linked: gtin (automatic, same valid GTIN), standalone (no usable GTIN),
  -- manual (operator decision), conflict_hold (same GTIN but conflicting identity data: in review)
  link_source            text NOT NULL CHECK (link_source IN ('gtin', 'standalone', 'manual', 'conflict_hold')),
  barcode_raw            text,
  barcode_status         text NOT NULL CHECK (barcode_status IN ('valid', 'restricted', 'invalid', 'missing')),
  barcode_format         text,
  barcode_issue          text,
  gtin                   text CHECK (gtin IS NULL OR gtin ~ '^[0-9]{14}$'),
  title                  text,
  brand                  text,
  description            text,
  category_raw           text,
  category_id            uuid REFERENCES categories(id) ON DELETE SET NULL,
  attributes             jsonb NOT NULL DEFAULT '{}',
  price                  numeric(14, 4) CHECK (price IS NULL OR price >= 0),
  currency               char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  vat_treatment          text NOT NULL DEFAULT 'unknown' CHECK (vat_treatment IN ('net', 'gross', 'unknown')),
  vat_rate               numeric(5, 2),
  sales_unit             text,
  units_per_pack         integer CHECK (units_per_pack IS NULL OR units_per_pack > 0),
  moq                    integer CHECK (moq IS NULL OR moq > 0),
  price_tiers            jsonb,
  stock_quantity         integer CHECK (stock_quantity IS NULL OR stock_quantity >= 0),   -- NULL unknown, 0 sold out
  stock_status           text NOT NULL DEFAULT 'unknown'
                           CHECK (stock_status IN ('in_stock', 'low_stock', 'out_of_stock', 'on_order', 'unknown')),
  availability_raw       text,
  lead_time_days         integer CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  lead_time_raw          text,
  product_url            text,
  image_urls             text[] NOT NULL DEFAULT '{}',
  active                 boolean NOT NULL DEFAULT true,
  deactivated_at         timestamptz,
  deactivated_reason     text,
  source_as_of           timestamptz NOT NULL,     -- as-of of the data currently stored: guards out-of-order imports
  first_import_id        uuid,
  last_import_id         uuid,
  last_row_number        integer,
  row_hash               text NOT NULL,
  source_row             jsonb NOT NULL,           -- original row as read from the file (provenance)
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, supplier_sku),
  CHECK ((barcode_status IN ('valid', 'restricted')) = (gtin IS NOT NULL))
);
CREATE INDEX supplier_offers_product_idx ON supplier_offers (product_id);
CREATE INDEX supplier_offers_gtin_idx ON supplier_offers (gtin);
CREATE INDEX supplier_offers_barcode_raw_idx ON supplier_offers (barcode_raw);
CREATE INDEX supplier_offers_sku_idx ON supplier_offers (lower(supplier_sku));
CREATE INDEX supplier_offers_supplier_active_idx ON supplier_offers (supplier_id, active);

-- ---------------------------------------------------------------- image provenance
CREATE TABLE image_sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id         uuid NOT NULL REFERENCES suppliers(id),
  url                 text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fetched', 'failed', 'blocked')),
  image_asset_id      uuid REFERENCES image_assets(id),
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  last_attempt_at     timestamptz,
  fetched_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, url),
  CHECK ((status = 'fetched') = (image_asset_id IS NOT NULL))
);
CREATE INDEX image_sources_asset_idx ON image_sources (image_asset_id);
CREATE INDEX image_sources_status_idx ON image_sources (status);

CREATE TABLE offer_images (
  offer_id          uuid NOT NULL REFERENCES supplier_offers(id) ON DELETE CASCADE,
  image_source_id   uuid NOT NULL REFERENCES image_sources(id) ON DELETE CASCADE,
  position          integer NOT NULL,
  PRIMARY KEY (offer_id, image_source_id)
);
CREATE INDEX offer_images_source_idx ON offer_images (image_source_id);

-- ---------------------------------------------------------------- embeddings
CREATE TABLE embedding_models (
  key            text PRIMARY KEY,
  repo           text NOT NULL,
  revision       text NOT NULL,
  dim            integer NOT NULL CHECK (dim > 0 AND dim <= 4000),
  preprocess     text NOT NULL,
  license        text NOT NULL,
  status         text NOT NULL CHECK (status IN ('building', 'active', 'retired')),
  thresholds     jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  activated_at   timestamptz
);
CREATE UNIQUE INDEX embedding_models_single_active ON embedding_models ((true)) WHERE status = 'active';

-- The vector column is untyped so several models (dimensions) can coexist during a switch.
-- Each model gets a partial HNSW index on a dimension cast, created by ensureModelIndex().
CREATE TABLE image_embeddings (
  image_asset_id  uuid NOT NULL REFERENCES image_assets(id) ON DELETE CASCADE,
  model_key       text NOT NULL REFERENCES embedding_models(key),
  status          text NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  embedding       vector,
  error           text,
  attempts        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (image_asset_id, model_key),
  CHECK (status <> 'done' OR embedding IS NOT NULL)
);
CREATE INDEX image_embeddings_status_idx ON image_embeddings (model_key, status);

-- ---------------------------------------------------------------- imports
CREATE TABLE import_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id      uuid NOT NULL REFERENCES suppliers(id),
  profile_id       uuid REFERENCES import_profiles(id) ON DELETE SET NULL,
  status           text NOT NULL CHECK (status IN ('uploaded', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
  mode             text NOT NULL DEFAULT 'delta' CHECK (mode IN ('snapshot', 'delta')),
  source_kind      text NOT NULL DEFAULT 'upload',
  file_name        text NOT NULL,
  file_kind        text NOT NULL CHECK (file_kind IN ('csv', 'xlsx')),
  file_sha256      text NOT NULL,
  file_size        bigint NOT NULL,
  file_key         text NOT NULL,
  parse_options    jsonb NOT NULL DEFAULT '{}',
  mapping          jsonb,
  defaults         jsonb,
  as_of            timestamptz NOT NULL,
  counters         jsonb NOT NULL DEFAULT '{}',
  staged_rows      integer,               -- set once the whole file is parsed into staging
  checkpoint_row   integer NOT NULL DEFAULT 0,
  attempts         integer NOT NULL DEFAULT 0,
  error            text,
  snapshot_result  text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  queued_at        timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  heartbeat_at     timestamptz
);
-- At most one queued/running import per supplier: prevents overlapping updates.
CREATE UNIQUE INDEX import_runs_one_active_per_supplier ON import_runs (supplier_id) WHERE status IN ('queued', 'running');
CREATE INDEX import_runs_supplier_idx ON import_runs (supplier_id, created_at DESC);
CREATE INDEX import_runs_created_idx ON import_runs (created_at DESC);

CREATE TABLE import_staging_rows (
  import_run_id  uuid NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  row_number     integer NOT NULL,
  raw            jsonb NOT NULL,
  PRIMARY KEY (import_run_id, row_number)
);

CREATE TABLE import_row_issues (
  id              bigserial PRIMARY KEY,
  import_run_id   uuid NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  row_number      integer NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('error', 'warning')),
  field           text,
  code            text NOT NULL,
  message         text NOT NULL,
  value           text
);
CREATE INDEX import_row_issues_run_idx ON import_row_issues (import_run_id, severity, row_number);
CREATE UNIQUE INDEX import_row_issues_dedupe ON import_row_issues (import_run_id, row_number, code, coalesce(field, ''));

-- ---------------------------------------------------------------- review & audit
CREATE TABLE audit_events (
  id                    bigserial PRIMARY KEY,
  at                    timestamptz NOT NULL DEFAULT now(),
  actor_user_id         uuid REFERENCES users(id),
  actor_kind            text NOT NULL CHECK (actor_kind IN ('user', 'system', 'import')),
  action                text NOT NULL,
  entity_type           text NOT NULL,
  entity_id             text NOT NULL,
  related_ids           uuid[] NOT NULL DEFAULT '{}',
  reason                text,
  data                  jsonb NOT NULL DEFAULT '{}',
  reverts_event_id      bigint REFERENCES audit_events(id),
  reverted_by_event_id  bigint REFERENCES audit_events(id)
);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, at DESC);
CREATE INDEX audit_events_related_idx ON audit_events USING gin (related_ids);

CREATE TABLE match_reviews (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                   text NOT NULL CHECK (kind IN ('gtin_conflict', 'suggested_duplicate', 'gtin_changed')),
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  product_id             uuid NOT NULL REFERENCES products(id),
  candidate_product_id   uuid NOT NULL REFERENCES products(id),
  offer_id               uuid REFERENCES supplier_offers(id) ON DELETE SET NULL,
  gtin                   text,
  score                  real,
  reasons                jsonb NOT NULL DEFAULT '[]',
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by_import_id   uuid REFERENCES import_runs(id) ON DELETE SET NULL,
  resolved_at            timestamptz,
  resolved_by            uuid REFERENCES users(id),
  resolution             text CHECK (resolution IN ('merged', 'kept_separate', 'dismissed')),
  resolution_note        text,
  audit_event_id         bigint REFERENCES audit_events(id),
  CHECK (product_id <> candidate_product_id)
);
CREATE UNIQUE INDEX match_reviews_open_pair ON match_reviews
  (kind, least(product_id, candidate_product_id), greatest(product_id, candidate_product_id)) WHERE status = 'open';
CREATE INDEX match_reviews_status_idx ON match_reviews (status, created_at DESC);

-- Persistent "these are different products" decisions: suggestions never re-propose these pairs.
CREATE TABLE product_distinct_pairs (
  product_a    uuid NOT NULL REFERENCES products(id),
  product_b    uuid NOT NULL REFERENCES products(id),
  reason       text,
  decided_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_a, product_b),
  CHECK (product_a < product_b)
);

-- ---------------------------------------------------------------- photo search
CREATE TABLE photo_searches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL CHECK (status IN ('ok', 'failed', 'provider_unavailable')),
  image_key         text,
  image_expires_at  timestamptz NOT NULL,
  image_deleted_at  timestamptz,
  crop              jsonb,
  filters           jsonb NOT NULL DEFAULT '{}',
  model_key         text,
  barcode           jsonb,
  timings           jsonb NOT NULL DEFAULT '{}',
  result            jsonb NOT NULL DEFAULT '{}',
  error             text
);
CREATE INDEX photo_searches_expiry_idx ON photo_searches (image_expires_at) WHERE image_deleted_at IS NULL;

CREATE TABLE search_feedback (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_search_id   uuid NOT NULL REFERENCES photo_searches(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  verdict           text NOT NULL CHECK (verdict IN ('correct', 'wrong', 'none_relevant', 'useful_alternative')),
  product_id        uuid REFERENCES products(id),
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_feedback_search_idx ON search_feedback (photo_search_id);

-- ---------------------------------------------------------------- settings
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id)
);
