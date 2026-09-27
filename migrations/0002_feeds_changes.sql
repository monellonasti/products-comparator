-- 0002: scheduled supplier feeds (generic HTTP(S) CSV/XLSX download) and the change report.

-- Feed schedule/state. The configuration itself lives in suppliers.connector_config (no secrets);
-- secrets (feed URL, credentials) are encrypted in supplier_secrets and never returned by the API.
ALTER TABLE suppliers
  ADD COLUMN feed_enabled               boolean NOT NULL DEFAULT false,
  ADD COLUMN feed_next_run_at           timestamptz,
  ADD COLUMN feed_last_checked_at       timestamptz,
  ADD COLUMN feed_last_status           text CHECK (feed_last_status IN ('queued', 'failed', 'postponed', 'no_mapping')),
  ADD COLUMN feed_last_error            text,
  ADD COLUMN feed_last_run_id           uuid REFERENCES import_runs(id) ON DELETE SET NULL,
  ADD COLUMN feed_consecutive_failures  integer NOT NULL DEFAULT 0;
CREATE INDEX suppliers_feed_due_idx ON suppliers (feed_next_run_at) WHERE feed_enabled;

ALTER TABLE import_runs ADD CONSTRAINT import_runs_source_kind_check CHECK (source_kind IN ('upload', 'feed'));

CREATE TABLE supplier_secrets (
  supplier_id  uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (name IN ('url', 'username', 'password', 'token', 'header_value')),
  ciphertext   text NOT NULL,        -- AES-256-GCM, key from SECRETS_KEY, AAD = supplier_id:name
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, name)
);

-- What changed in each import (manual or feed): price, availability/quantity, images, listing status.
CREATE TABLE offer_changes (
  id              bigserial PRIMARY KEY,
  import_run_id   uuid REFERENCES import_runs(id) ON DELETE CASCADE,
  supplier_id     uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  offer_id        uuid NOT NULL REFERENCES supplier_offers(id) ON DELETE CASCADE,
  product_id      uuid REFERENCES products(id) ON DELETE SET NULL,   -- product at the time of the change
  change_type     text NOT NULL CHECK (change_type IN ('price', 'availability', 'stock', 'images', 'new_offer', 'removed', 'reactivated', 'barcode')),
  old_value       jsonb,
  new_value       jsonb,
  pct             numeric(9, 2),      -- relative price change, only when old/new are comparable
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_run_id, offer_id, change_type)
);
CREATE INDEX offer_changes_created_idx ON offer_changes (created_at DESC, id DESC);
CREATE INDEX offer_changes_supplier_idx ON offer_changes (supplier_id, created_at DESC);
CREATE INDEX offer_changes_run_idx ON offer_changes (import_run_id, change_type);
CREATE INDEX offer_changes_offer_idx ON offer_changes (offer_id, created_at DESC);
CREATE INDEX offer_changes_type_idx ON offer_changes (change_type, created_at DESC);
