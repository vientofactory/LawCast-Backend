import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefactorArchiveSnapshotStatesAndImmutability1751846401000 implements MigrationInterface {
  name = 'RefactorArchiveSnapshotStatesAndImmutability1751846401000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notice_archive_snapshot_states_new" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "notice_num" integer NOT NULL,
        "is_done" boolean NOT NULL DEFAULT (0),
        "ai_summary" text,
        "ai_summary_status" varchar(30) NOT NULL DEFAULT ('not_requested'),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      INSERT OR IGNORE INTO "notice_archive_snapshot_states_new" (
        "notice_num",
        "is_done",
        "ai_summary",
        "ai_summary_status"
      )
      SELECT
        na."noticeNum",
        COALESCE(na."is_done", 0),
        ss."ai_summary",
        COALESCE(ss."ai_summary_status", 'not_requested')
      FROM "notice_archives" na
      LEFT JOIN "notice_archive_summary_states" ss
        ON ss."notice_num" = na."noticeNum"
    `);

    await queryRunner.query(
      `DROP TABLE IF EXISTS "notice_archive_snapshot_states"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notice_archive_summary_states"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notice_archive_snapshot_states_new" RENAME TO "notice_archive_snapshot_states"`,
    );

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_notice_archive_snapshot_states_notice_num"
      ON "notice_archive_snapshot_states" ("notice_num")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archive_snapshot_states_status_notice_num"
      ON "notice_archive_snapshot_states" ("ai_summary_status", "notice_num")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archive_snapshot_states_is_done_notice_num"
      ON "notice_archive_snapshot_states" ("is_done", "notice_num")
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_is_done"`,
    );

    await queryRunner.query(`
      CREATE TABLE "notice_archives_immutable" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "noticeNum" integer NOT NULL,
        "subject" varchar(500) NOT NULL,
        "proposerCategory" varchar(100) NOT NULL,
        "committee" varchar(200) NOT NULL,
        "assemblyLink" text NOT NULL,
        "contentId" varchar(100),
        "proposalReason" text NOT NULL DEFAULT (''),
        "sourceTitle" text,
        "content_bill_number" varchar(100),
        "content_proposer" varchar(255),
        "content_proposal_date" varchar(100),
        "content_committee" varchar(200),
        "content_referral_date" varchar(100),
        "content_notice_period" varchar(200),
        "content_proposal_session" varchar(200),
        "attachmentPdfFile" text NOT NULL DEFAULT (''),
        "attachmentHwpFile" text NOT NULL DEFAULT (''),
        "archived_at" datetime,
        "source_html" text,
        "source_html_sha256" varchar(64),
        "integrity_verified_at" datetime,
        "integrity_check_passed" boolean,
        "http_metadata_json" text,
        "http_fetched_at" datetime,
        "http_status_code" integer,
        "http_content_type" varchar(255),
        "http_etag" varchar(255),
        "http_last_modified" varchar(255),
        "lifecycle_status" varchar(30) NOT NULL DEFAULT ('active'),
        "source_deleted_at" datetime,
        "screenshot_blob" blob,
        "screenshot_format" varchar(10),
        "archive_started_at" datetime NOT NULL DEFAULT (datetime('now')),
        "last_updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      INSERT INTO "notice_archives_immutable" (
        "id",
        "noticeNum",
        "subject",
        "proposerCategory",
        "committee",
        "assemblyLink",
        "contentId",
        "proposalReason",
        "sourceTitle",
        "content_bill_number",
        "content_proposer",
        "content_proposal_date",
        "content_committee",
        "content_referral_date",
        "content_notice_period",
        "content_proposal_session",
        "attachmentPdfFile",
        "attachmentHwpFile",
        "archived_at",
        "source_html",
        "source_html_sha256",
        "integrity_verified_at",
        "integrity_check_passed",
        "http_metadata_json",
        "http_fetched_at",
        "http_status_code",
        "http_content_type",
        "http_etag",
        "http_last_modified",
        "lifecycle_status",
        "source_deleted_at",
        "screenshot_blob",
        "screenshot_format",
        "archive_started_at",
        "last_updated_at"
      )
      SELECT
        "id",
        "noticeNum",
        "subject",
        "proposerCategory",
        "committee",
        "assemblyLink",
        "contentId",
        "proposalReason",
        "sourceTitle",
        "content_bill_number",
        "content_proposer",
        "content_proposal_date",
        "content_committee",
        "content_referral_date",
        "content_notice_period",
        "content_proposal_session",
        "attachmentPdfFile",
        "attachmentHwpFile",
        "archived_at",
        "source_html",
        "source_html_sha256",
        "integrity_verified_at",
        "integrity_check_passed",
        "http_metadata_json",
        "http_fetched_at",
        "http_status_code",
        "http_content_type",
        "http_etag",
        "http_last_modified",
        "lifecycle_status",
        "source_deleted_at",
        "screenshot_blob",
        "screenshot_format",
        "archive_started_at",
        "last_updated_at"
      FROM "notice_archives"
    `);

    await queryRunner.query(`DROP TABLE "notice_archives"`);
    await queryRunner.query(
      `ALTER TABLE "notice_archives_immutable" RENAME TO "notice_archives"`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_notice_archives_notice_num" ON "notice_archives" ("noticeNum")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notice_archives_subject" ON "notice_archives" ("subject")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notice_archives_archive_started_at" ON "notice_archives" ("archive_started_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notice_archives_lifecycle_status" ON "notice_archives" ("lifecycle_status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notice_archives_source_deleted_at" ON "notice_archives" ("source_deleted_at")`,
    );
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_content_id"
      ON "notice_archives" ("contentId")
      WHERE "contentId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_content_bill_number"
      ON "notice_archives" ("content_bill_number")
      WHERE "content_bill_number" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_missing_pal_html_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "source_html" IS NULL AND "contentId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_missing_nsm_html_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "source_html" IS NULL AND "contentId" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_missing_nsm_reason_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "contentId" IS NULL AND ("proposalReason" IS NULL OR TRIM("proposalReason") = '')
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_missing_pal_screenshot_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "screenshot_blob" IS NULL AND "contentId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_missing_nsm_screenshot_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "screenshot_blob" IS NULL AND "contentId" IS NULL
    `);

    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_archives_prevent_update"
      BEFORE UPDATE ON "notice_archives"
      BEGIN
        SELECT RAISE(ABORT, 'notice_archives is immutable after initial snapshot archive');
      END
    `);

    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_archives_prevent_delete"
      BEFORE DELETE ON "notice_archives"
      BEGIN
        SELECT RAISE(ABORT, 'notice_archives physical delete is forbidden for immutable snapshots');
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_archives_prevent_delete"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_archives_prevent_update"`,
    );

    await queryRunner.query(`
      CREATE TABLE "notice_archives_with_is_done" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "noticeNum" integer NOT NULL,
        "subject" varchar(500) NOT NULL,
        "proposerCategory" varchar(100) NOT NULL,
        "committee" varchar(200) NOT NULL,
        "assemblyLink" text NOT NULL,
        "contentId" varchar(100),
        "proposalReason" text NOT NULL DEFAULT (''),
        "sourceTitle" text,
        "content_bill_number" varchar(100),
        "content_proposer" varchar(255),
        "content_proposal_date" varchar(100),
        "content_committee" varchar(200),
        "content_referral_date" varchar(100),
        "content_notice_period" varchar(200),
        "content_proposal_session" varchar(200),
        "attachmentPdfFile" text NOT NULL DEFAULT (''),
        "attachmentHwpFile" text NOT NULL DEFAULT (''),
        "archived_at" datetime,
        "source_html" text,
        "source_html_sha256" varchar(64),
        "integrity_verified_at" datetime,
        "integrity_check_passed" boolean,
        "http_metadata_json" text,
        "http_fetched_at" datetime,
        "http_status_code" integer,
        "http_content_type" varchar(255),
        "http_etag" varchar(255),
        "http_last_modified" varchar(255),
        "is_done" boolean NOT NULL DEFAULT (0),
        "lifecycle_status" varchar(30) NOT NULL DEFAULT ('active'),
        "source_deleted_at" datetime,
        "screenshot_blob" blob,
        "screenshot_format" varchar(10),
        "archive_started_at" datetime NOT NULL DEFAULT (datetime('now')),
        "last_updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      INSERT INTO "notice_archives_with_is_done" (
        "id",
        "noticeNum",
        "subject",
        "proposerCategory",
        "committee",
        "assemblyLink",
        "contentId",
        "proposalReason",
        "sourceTitle",
        "content_bill_number",
        "content_proposer",
        "content_proposal_date",
        "content_committee",
        "content_referral_date",
        "content_notice_period",
        "content_proposal_session",
        "attachmentPdfFile",
        "attachmentHwpFile",
        "archived_at",
        "source_html",
        "source_html_sha256",
        "integrity_verified_at",
        "integrity_check_passed",
        "http_metadata_json",
        "http_fetched_at",
        "http_status_code",
        "http_content_type",
        "http_etag",
        "http_last_modified",
        "is_done",
        "lifecycle_status",
        "source_deleted_at",
        "screenshot_blob",
        "screenshot_format",
        "archive_started_at",
        "last_updated_at"
      )
      SELECT
        na."id",
        na."noticeNum",
        na."subject",
        na."proposerCategory",
        na."committee",
        na."assemblyLink",
        na."contentId",
        na."proposalReason",
        na."sourceTitle",
        na."content_bill_number",
        na."content_proposer",
        na."content_proposal_date",
        na."content_committee",
        na."content_referral_date",
        na."content_notice_period",
        na."content_proposal_session",
        na."attachmentPdfFile",
        na."attachmentHwpFile",
        na."archived_at",
        na."source_html",
        na."source_html_sha256",
        na."integrity_verified_at",
        na."integrity_check_passed",
        na."http_metadata_json",
        na."http_fetched_at",
        na."http_status_code",
        na."http_content_type",
        na."http_etag",
        na."http_last_modified",
        COALESCE(ss."is_done", 0),
        na."lifecycle_status",
        na."source_deleted_at",
        na."screenshot_blob",
        na."screenshot_format",
        na."archive_started_at",
        na."last_updated_at"
      FROM "notice_archives" na
      LEFT JOIN "notice_archive_snapshot_states" ss
        ON ss."notice_num" = na."noticeNum"
    `);

    await queryRunner.query(`DROP TABLE "notice_archives"`);
    await queryRunner.query(
      `ALTER TABLE "notice_archives_with_is_done" RENAME TO "notice_archives"`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_notice_archives_notice_num" ON "notice_archives" ("noticeNum")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notice_archives_subject" ON "notice_archives" ("subject")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notice_archives_archive_started_at" ON "notice_archives" ("archive_started_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notice_archives_is_done" ON "notice_archives" ("is_done")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notice_archives_lifecycle_status" ON "notice_archives" ("lifecycle_status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notice_archives_source_deleted_at" ON "notice_archives" ("source_deleted_at")`,
    );
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_content_id"
      ON "notice_archives" ("contentId")
      WHERE "contentId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_content_bill_number"
      ON "notice_archives" ("content_bill_number")
      WHERE "content_bill_number" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_missing_pal_html_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "source_html" IS NULL AND "contentId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_missing_nsm_html_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "source_html" IS NULL AND "contentId" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_missing_nsm_reason_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "contentId" IS NULL AND ("proposalReason" IS NULL OR TRIM("proposalReason") = '')
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_missing_pal_screenshot_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "screenshot_blob" IS NULL AND "contentId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_missing_nsm_screenshot_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "screenshot_blob" IS NULL AND "contentId" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notice_archive_summary_states" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "notice_num" integer NOT NULL,
        "ai_summary" text,
        "ai_summary_status" varchar(30) NOT NULL DEFAULT ('not_requested'),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      INSERT OR IGNORE INTO "notice_archive_summary_states" (
        "notice_num",
        "ai_summary",
        "ai_summary_status"
      )
      SELECT
        "notice_num",
        "ai_summary",
        COALESCE("ai_summary_status", 'not_requested')
      FROM "notice_archive_snapshot_states"
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_notice_archive_summary_states_notice_num"
      ON "notice_archive_summary_states" ("notice_num")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archive_summary_states_status_notice_num"
      ON "notice_archive_summary_states" ("ai_summary_status", "notice_num")
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_notice_archive_snapshot_states_is_done_notice_num"
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archive_snapshot_states_status_notice_num"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archive_snapshot_states_notice_num"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notice_archive_snapshot_states"`,
    );
  }
}
