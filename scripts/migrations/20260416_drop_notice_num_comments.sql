-- SQLite migration: remove numComments from notice_archives
-- Purpose:
-- 1) Rebuild notice_archives without numComments column.
-- 2) Preserve existing data and timestamps.
-- 3) Recreate key indexes after table swap.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE TRANSACTION;

-- 1) Rename current table.
ALTER TABLE notice_archives RENAME TO notice_archives_old;

-- 2) Recreate table with the current application schema (without numComments).
CREATE TABLE notice_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  noticeNum INTEGER NOT NULL,
  subject VARCHAR(500) NOT NULL,
  proposerCategory VARCHAR(100) NOT NULL,
  committee VARCHAR(200) NOT NULL,
  assemblyLink TEXT NOT NULL,
  contentId VARCHAR(100),
  proposalReason TEXT NOT NULL DEFAULT '',
  sourceTitle TEXT,
  aiSummary TEXT,
  aiSummaryStatus VARCHAR(30) NOT NULL DEFAULT 'not_requested',
  attachmentPdfFile TEXT NOT NULL DEFAULT '',
  attachmentHwpFile TEXT NOT NULL DEFAULT '',
  archive_started_at DATETIME NOT NULL DEFAULT (datetime('now')),
  last_updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- 3) Copy data except the removed numComments column.
INSERT INTO notice_archives (
  id,
  noticeNum,
  subject,
  proposerCategory,
  committee,
  assemblyLink,
  contentId,
  proposalReason,
  sourceTitle,
  aiSummary,
  aiSummaryStatus,
  attachmentPdfFile,
  attachmentHwpFile,
  archive_started_at,
  last_updated_at
)
SELECT
  id,
  noticeNum,
  subject,
  proposerCategory,
  committee,
  assemblyLink,
  contentId,
  proposalReason,
  sourceTitle,
  aiSummary,
  aiSummaryStatus,
  attachmentPdfFile,
  attachmentHwpFile,
  archive_started_at,
  last_updated_at
FROM notice_archives_old;

-- 4) Drop old table.
DROP TABLE notice_archives_old;

-- 5) Recreate indexes expected by the application.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notice_archives_notice_num
ON notice_archives(noticeNum);

CREATE INDEX IF NOT EXISTS idx_notice_archives_subject
ON notice_archives(subject);

COMMIT;

PRAGMA foreign_keys = ON;

-- Optional validation queries (run manually if needed):
-- PRAGMA table_info('notice_archives');
-- SELECT COUNT(*) FROM notice_archives;
-- PRAGMA index_list('notice_archives');