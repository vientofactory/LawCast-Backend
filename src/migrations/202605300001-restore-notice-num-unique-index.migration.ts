import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restores the unique index on notice_archives.noticeNum that may have been
 * silently dropped when TypeORM internally recreated the table while applying
 * the AddScreenshotBlob migration.
 *
 * Without this index, TypeORM's UPSERT generates:
 *   INSERT ... ON CONFLICT ("noticeNum") DO UPDATE ...
 * which SQLite rejects at compile-time with:
 *   "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"
 */
export class RestoreNoticeNumUniqueIndex1748563200000 implements MigrationInterface {
  name = 'RestoreNoticeNumUniqueIndex1748563200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_notice_archives_notice_num"
      ON "notice_archives" ("noticeNum")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_notice_num"`,
    );
  }
}
