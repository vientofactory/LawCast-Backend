import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds:
 * 1) FTS5 virtual table for archive full-text search (subject/committee/proposalReason)
 * 2) Trigger-based sync between notice_archives and FTS index
 * 3) Composite indexes used by latest-field change-tracking lookups
 */
export class AddFtsAndChangeTrackingLatestValueIndexes1754611201000 implements MigrationInterface {
  name = 'AddFtsAndChangeTrackingLatestValueIndexes1754611201000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE VIRTUAL TABLE IF NOT EXISTS "notice_archives_fts"
      USING fts5(
        "subject",
        "committee",
        "proposalReason",
        content='notice_archives',
        content_rowid='rowid',
        tokenize='unicode61'
      )
    `);

    await queryRunner.query(`
      INSERT INTO "notice_archives_fts" ("notice_archives_fts") VALUES ('rebuild')
    `);

    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_archives_fts_insert"
      AFTER INSERT ON "notice_archives"
      BEGIN
        INSERT INTO "notice_archives_fts" ("rowid", "subject", "committee", "proposalReason")
        VALUES (new.rowid, new."subject", new."committee", new."proposalReason");
      END
    `);

    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_archives_fts_delete"
      AFTER DELETE ON "notice_archives"
      BEGIN
        INSERT INTO "notice_archives_fts" ("notice_archives_fts", "rowid", "subject", "committee", "proposalReason")
        VALUES ('delete', old.rowid, old."subject", old."committee", old."proposalReason");
      END
    `);

    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_archives_fts_update"
      AFTER UPDATE OF "subject", "committee", "proposalReason" ON "notice_archives"
      BEGIN
        INSERT INTO "notice_archives_fts" ("notice_archives_fts", "rowid", "subject", "committee", "proposalReason")
        VALUES ('delete', old.rowid, old."subject", old."committee", old."proposalReason");
        INSERT INTO "notice_archives_fts" ("rowid", "subject", "committee", "proposalReason")
        VALUES (new.rowid, new."subject", new."committee", new."proposalReason");
      END
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_details_field_path_event_id_id"
      ON "notice_change_details" ("field_path", "event_id", "id" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_details_event_id_field_path_id"
      ON "notice_change_details" ("event_id", "field_path", "id" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_details_event_id_field_path_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_details_field_path_event_id_id"`,
    );

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_archives_fts_update"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_archives_fts_delete"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_archives_fts_insert"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "notice_archives_fts"`);
  }
}
