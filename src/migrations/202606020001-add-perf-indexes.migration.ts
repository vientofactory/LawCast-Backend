import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds two performance indexes to notice_archives:
 *
 *   - idx_notice_archives_archive_started_at
 *       Covers the primary ORDER BY column used in archive listing queries
 *       (getArchiveNotices / getArchiveNoticesByOffset).
 *
 *   - idx_notice_archives_is_done
 *       Covers the boolean filter applied when the ?isDone query parameter
 *       is supplied. Without this index SQLite performs a full table scan
 *       for every filtered request.
 */
export class AddPerfIndexes1748822400000 implements MigrationInterface {
  name = 'AddPerfIndexes1748822400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_archive_started_at"
      ON "notice_archives" ("archive_started_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_is_done"
      ON "notice_archives" ("is_done")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_is_done"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_archive_started_at"`,
    );
  }
}
