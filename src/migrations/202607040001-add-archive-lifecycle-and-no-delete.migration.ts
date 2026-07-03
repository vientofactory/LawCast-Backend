import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds archive lifecycle columns and enforces a no-physical-delete policy.
 */
export class AddArchiveLifecycleAndNoDelete1751587201000 implements MigrationInterface {
  name = 'AddArchiveLifecycleAndNoDelete1751587201000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notice_archives"
      ADD COLUMN "lifecycle_status" varchar(30) NOT NULL DEFAULT ('active')
    `);

    await queryRunner.query(`
      ALTER TABLE "notice_archives"
      ADD COLUMN "source_deleted_at" datetime
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_lifecycle_status"
      ON "notice_archives" ("lifecycle_status")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_source_deleted_at"
      ON "notice_archives" ("source_deleted_at")
    `);

    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_archives_no_delete"
      BEFORE DELETE ON "notice_archives"
      BEGIN
        SELECT RAISE(ABORT, 'notice_archives physical delete is forbidden; use lifecycle_status/source_deleted_at');
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_archives_no_delete"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_source_deleted_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_lifecycle_status"`,
    );

    await queryRunner.query(`
      ALTER TABLE "notice_archives"
      DROP COLUMN "source_deleted_at"
    `);

    await queryRunner.query(`
      ALTER TABLE "notice_archives"
      DROP COLUMN "lifecycle_status"
    `);
  }
}
