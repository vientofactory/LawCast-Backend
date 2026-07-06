import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops legacy immutability triggers on notice_archives that block update/delete.
 *
 * These triggers were introduced while experimenting with immutable archive rows,
 * but they conflict with the current snapshot lifecycle that requires updates.
 */
export class RemoveNoticeArchiveImmutabilityTriggers1751760004000 implements MigrationInterface {
  name = 'RemoveNoticeArchiveImmutabilityTriggers1751760004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_archives_prevent_delete"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_archives_prevent_update"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_archives_prevent_update"
      BEFORE UPDATE ON "notice_archives"
      BEGIN
        SELECT RAISE(ABORT, 'notice_archives is immutable');
      END
    `);

    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_archives_prevent_delete"
      BEFORE DELETE ON "notice_archives"
      BEGIN
        SELECT RAISE(ABORT, 'notice_archives is immutable');
      END
    `);
  }
}
