-- SQLite migration: restore unique index on notice_archives.noticeNum
-- Corresponds to TypeORM migration: RestoreNoticeNumUniqueIndex1748563200000
--
-- Purpose:
-- The AddScreenshotBlob migration caused TypeORM to internally recreate the
-- notice_archives table, which silently dropped the unique index on noticeNum.
-- Without this index, TypeORM's UPSERT generates:
--   INSERT ... ON CONFLICT ("noticeNum") DO UPDATE ...
-- which SQLite rejects at compile-time with:
--   "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"
--
-- This script is idempotent (IF NOT EXISTS) and safe to run multiple times.

BEGIN IMMEDIATE TRANSACTION;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_notice_archives_notice_num"
ON "notice_archives" ("noticeNum");

COMMIT;
