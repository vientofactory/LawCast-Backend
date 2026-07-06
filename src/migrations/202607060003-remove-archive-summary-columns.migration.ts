import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveArchiveSummaryColumns1751760003000 implements MigrationInterface {
  name = 'RemoveArchiveSummaryColumns1751760003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_ai_summary_status_notice_num"`,
    );

    await queryRunner.query(`
      CREATE TABLE "notice_archives_compacted" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "noticeNum" integer NOT NULL,
        "subject" varchar(500) NOT NULL,
        "proposerCategory" varchar(100) NOT NULL,
        "committee" varchar(200) NOT NULL,
        "assemblyLink" text NOT NULL,
        "contentId" varchar(100),
        "proposalReason" text NOT NULL DEFAULT ('') ,
        "sourceTitle" text,
        "content_bill_number" varchar(100),
        "content_proposer" varchar(255),
        "content_proposal_date" varchar(100),
        "content_committee" varchar(200),
        "content_referral_date" varchar(100),
        "content_notice_period" varchar(200),
        "content_proposal_session" varchar(200),
        "attachmentPdfFile" text NOT NULL DEFAULT ('') ,
        "attachmentHwpFile" text NOT NULL DEFAULT ('') ,
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
      INSERT INTO "notice_archives_compacted" (
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
      FROM "notice_archives"
    `);

    await queryRunner.query(`DROP TABLE "notice_archives"`);
    await queryRunner.query(
      `ALTER TABLE "notice_archives_compacted" RENAME TO "notice_archives"`,
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notice_archives" ADD COLUMN "aiSummary" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "notice_archives" ADD COLUMN "aiSummaryStatus" varchar(30) NOT NULL DEFAULT ('not_requested')`,
    );

    await queryRunner.query(`
      UPDATE "notice_archives"
      SET
        "aiSummary" = (
          SELECT "ai_summary"
          FROM "notice_archive_summary_states"
          WHERE "notice_archive_summary_states"."notice_num" = "notice_archives"."noticeNum"
        ),
        "aiSummaryStatus" = COALESCE(
          (
            SELECT "ai_summary_status"
            FROM "notice_archive_summary_states"
            WHERE "notice_archive_summary_states"."notice_num" = "notice_archives"."noticeNum"
          ),
          'not_requested'
        )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_ai_summary_status_notice_num"
      ON "notice_archives" ("aiSummaryStatus", "noticeNum")
    `);
  }
}
