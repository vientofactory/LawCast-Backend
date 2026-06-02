-- SQLite migration: add performance indexes for archive_started_at and is_done
-- Purpose:
-- 1) Add index on archive_started_at (primary sort column for archive listing).
-- 2) Add index on is_done (commonly used as a filter condition).
-- 3) Idempotent with IF NOT EXISTS.

BEGIN IMMEDIATE TRANSACTION;

CREATE INDEX IF NOT EXISTS "idx_notice_archives_archive_started_at"
  ON notice_archives (archive_started_at);

CREATE INDEX IF NOT EXISTS "idx_notice_archives_is_done"
  ON notice_archives (is_done);

COMMIT;
