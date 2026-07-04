import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds targeted indexes to reduce scan cost for archive list/search,
 * sync backfill jobs, and change-tracking aggregates.
 */
export class AddQueryOptimizationIndexes1751590802000 implements MigrationInterface {
  name = 'AddQueryOptimizationIndexes1751590802000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Stable-identity lookups during upsert / renumber handling.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_content_id"
      ON "notice_archives" ("contentId")
      WHERE "contentId" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_content_bill_number"
      ON "notice_archives" ("content_bill_number")
      WHERE "content_bill_number" IS NOT NULL
    `);

    // Summary backfill pagination (status + noticeNum ordering).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_ai_summary_status_notice_num"
      ON "notice_archives" ("aiSummaryStatus", "noticeNum")
    `);

    // HTML backfill candidates.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_missing_pal_html_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "source_html" IS NULL AND "contentId" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_missing_nsm_html_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "source_html" IS NULL AND "contentId" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_missing_nsm_reason_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "contentId" IS NULL AND ("proposalReason" IS NULL OR TRIM("proposalReason") = '')
    `);

    // Screenshot backfill candidates.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_missing_pal_screenshot_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "screenshot_blob" IS NULL AND "contentId" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_missing_nsm_screenshot_notice_num"
      ON "notice_archives" ("noticeNum")
      WHERE "screenshot_blob" IS NULL AND "contentId" IS NULL
    `);

    // Recent changes filtering by event type.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_events_event_type_detected_at"
      ON "notice_change_events" ("event_type", "detected_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_events_event_type_detected_at"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_missing_nsm_screenshot_notice_num"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_missing_pal_screenshot_notice_num"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_missing_nsm_reason_notice_num"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_missing_nsm_html_notice_num"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_missing_pal_html_notice_num"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_ai_summary_status_notice_num"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_content_bill_number"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_content_id"`,
    );
  }
}
