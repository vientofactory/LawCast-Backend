-- Archive snapshot metadata for stronger archival guarantees
ALTER TABLE notice_archives ADD COLUMN archived_at DATETIME;
ALTER TABLE notice_archives ADD COLUMN source_html TEXT;
ALTER TABLE notice_archives ADD COLUMN source_html_sha256 VARCHAR(64);
ALTER TABLE notice_archives ADD COLUMN integrity_verified_at DATETIME;
ALTER TABLE notice_archives ADD COLUMN integrity_check_passed INTEGER;
ALTER TABLE notice_archives ADD COLUMN http_metadata_json TEXT;
ALTER TABLE notice_archives ADD COLUMN http_fetched_at DATETIME;
ALTER TABLE notice_archives ADD COLUMN http_status_code INTEGER;
ALTER TABLE notice_archives ADD COLUMN http_content_type VARCHAR(255);
ALTER TABLE notice_archives ADD COLUMN http_etag VARCHAR(255);
ALTER TABLE notice_archives ADD COLUMN http_last_modified VARCHAR(255);
