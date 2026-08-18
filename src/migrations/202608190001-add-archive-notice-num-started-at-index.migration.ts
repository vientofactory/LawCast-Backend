import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddArchiveNoticeNumStartedAtIndex1755561601000 implements MigrationInterface {
  name = 'AddArchiveNoticeNumStartedAtIndex1755561601000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_notice_num_archive_started_at"
      ON "notice_archives" ("noticeNum", "archive_started_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_notice_num_archive_started_at"`,
    );
  }
}
