-- SQLite migration: safe index creation with constraint-violation prevention
-- Purpose:
-- 1) Deduplicate webhook URLs before adding a unique index.
-- 2) Create recommended indexes for performance.
-- 3) Keep migration idempotent with IF NOT EXISTS.

BEGIN IMMEDIATE TRANSACTION;

-- 0) Remove invalid URL rows that could cause poor data quality.
DELETE FROM webhooks
WHERE url IS NULL OR TRIM(url) = '';

-- 1) Deduplicate webhooks by URL.
-- Keep exactly one row per URL using this priority:
--   isActive DESC, updatedAt DESC, createdAt DESC, id DESC
-- That preserves the most relevant/latest active webhook.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY url
      ORDER BY
        COALESCE(isActive, 0) DESC,
        COALESCE(updatedAt, createdAt, '1970-01-01 00:00:00') DESC,
        COALESCE(createdAt, '1970-01-01 00:00:00') DESC,
        id DESC
    ) AS rn
  FROM webhooks
)
DELETE FROM webhooks
WHERE id IN (
  SELECT id
  FROM ranked
  WHERE rn > 1
);

-- 2) Create indexes (safe and rerunnable).
-- Webhook indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_url_unique
ON webhooks(url);

CREATE INDEX IF NOT EXISTS idx_webhooks_is_active_updated_at
ON webhooks(isActive, updatedAt);

-- Notice archive indexes (kept for safety in existing DBs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_notice_archives_notice_num
ON notice_archives(noticeNum);

CREATE INDEX IF NOT EXISTS idx_notice_archives_subject
ON notice_archives(subject);

COMMIT;

-- Optional validation queries (run manually if needed):
-- SELECT url, COUNT(*) AS cnt FROM webhooks GROUP BY url HAVING cnt > 1;
-- PRAGMA index_list('webhooks');
-- PRAGMA index_list('notice_archives');
