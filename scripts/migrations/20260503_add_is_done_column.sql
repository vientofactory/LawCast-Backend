-- SQLite migration: add is_done column to notice_archives
-- Purpose:
-- 1) Add is_done (boolean, default false) to notice_archives.
-- 2) Idempotent: skipped silently if the column already exists.
-- Note: SQLite does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN,
--       so the guard is handled at the application layer (TypeORM migration
--       uses queryRunner.hasColumn before executing). Run this script only
--       on databases where the column is absent.

BEGIN IMMEDIATE TRANSACTION;

ALTER TABLE notice_archives ADD COLUMN is_done BOOLEAN NOT NULL DEFAULT 0;

COMMIT;
