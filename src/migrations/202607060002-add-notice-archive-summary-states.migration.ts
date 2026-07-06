import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNoticeArchiveSummaryStates1751760002000 implements MigrationInterface {
  name = 'AddNoticeArchiveSummaryStates1751760002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_notice_archive_summary_states_notice_num"
      ON "notice_archive_summary_states" ("notice_num")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archive_summary_states_status_notice_num"
      ON "notice_archive_summary_states" ("ai_summary_status", "notice_num")
    `);

    await queryRunner.query(`
      INSERT OR IGNORE INTO "notice_archive_summary_states" (
        "notice_num",
        "ai_summary",
        "ai_summary_status"
      )
      SELECT
        "noticeNum",
        "aiSummary",
        COALESCE("aiSummaryStatus", 'not_requested')
      FROM "notice_archives"
      WHERE "aiSummary" IS NOT NULL
         OR "aiSummaryStatus" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archive_summary_states_status_notice_num"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archive_summary_states_notice_num"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notice_archive_summary_states"`,
    );
  }
}
