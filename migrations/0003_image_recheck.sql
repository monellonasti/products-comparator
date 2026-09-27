-- Periodic re-check of already downloaded supplier images: a supplier can replace the picture while
-- keeping the same URL. Conditional requests (ETag / Last-Modified) keep the check cheap; when the bytes
-- differ the source points to the new asset and an 'image_replaced' change is recorded.

ALTER TABLE image_sources
  ADD COLUMN etag          text,
  ADD COLUMN last_modified text,
  ADD COLUMN checked_at    timestamptz;   -- last successful re-check (NULL: never re-checked, use fetched_at)

CREATE INDEX image_sources_recheck_idx ON image_sources (supplier_id, (coalesce(checked_at, fetched_at))) WHERE status = 'fetched';

ALTER TABLE offer_changes DROP CONSTRAINT offer_changes_change_type_check;
ALTER TABLE offer_changes ADD CONSTRAINT offer_changes_change_type_check
  CHECK (change_type IN ('price', 'availability', 'stock', 'images', 'image_replaced', 'new_offer', 'removed', 'reactivated', 'barcode'));
