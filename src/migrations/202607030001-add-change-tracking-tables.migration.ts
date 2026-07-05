import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 foundation for change tracking.
 *
 * - notice_change_events: append-only chain headers per notice
 * - notice_change_details: field-level diff records
 */
export class AddChangeTrackingTables1751500801000 implements MigrationInterface {
  name = 'AddChangeTrackingTables1751500801000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notice_change_events" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "notice_num" integer NOT NULL,
        "detected_at" datetime NOT NULL,
        "event_type" varchar(40) NOT NULL,
        "source" varchar(80),
        "event_height" integer NOT NULL,
        "prev_event_hash" varchar(64),
        "event_hash" varchar(64) NOT NULL,
        "changed_field_count" integer NOT NULL DEFAULT (0),
        "diff_summary_json" text,
        "crawler_run_id" varchar(64),
        "hash_algo" varchar(20) NOT NULL DEFAULT ('sha256'),
        "canon_version" integer NOT NULL DEFAULT (1),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_notice_change_events_notice_num_event_height_unique"
      ON "notice_change_events" ("notice_num", "event_height")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_notice_change_events_event_hash_unique"
      ON "notice_change_events" ("event_hash")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_events_notice_num_detected_at"
      ON "notice_change_events" ("notice_num", "detected_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_events_detected_at"
      ON "notice_change_events" ("detected_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notice_change_details" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "event_id" integer NOT NULL,
        "field_path" varchar(255) NOT NULL,
        "change_type" varchar(20) NOT NULL,
        "before_value" text,
        "after_value" text,
        "before_hash" varchar(64),
        "after_hash" varchar(64),
        FOREIGN KEY ("event_id") REFERENCES "notice_change_events" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_details_event_id"
      ON "notice_change_details" ("event_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_details_field_path"
      ON "notice_change_details" ("field_path")
    `);

    // Enforce append-only semantics at DB layer.
    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_change_events_no_update"
      BEFORE UPDATE ON "notice_change_events"
      BEGIN
        SELECT RAISE(ABORT, 'notice_change_events is append-only');
      END
    `);

    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_change_events_no_delete"
      BEFORE DELETE ON "notice_change_events"
      BEGIN
        SELECT RAISE(ABORT, 'notice_change_events is append-only');
      END
    `);

    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_change_details_no_update"
      BEFORE UPDATE ON "notice_change_details"
      BEGIN
        SELECT RAISE(ABORT, 'notice_change_details is append-only');
      END
    `);

    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "trg_notice_change_details_no_delete"
      BEFORE DELETE ON "notice_change_details"
      BEGIN
        SELECT RAISE(ABORT, 'notice_change_details is append-only');
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_change_details_no_delete"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_change_details_no_update"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_change_events_no_delete"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_change_events_no_update"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_details_field_path"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_details_event_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "notice_change_details"`);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_events_detected_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_events_notice_num_detected_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_events_event_hash_unique"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_events_notice_num_event_height_unique"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "notice_change_events"`);
  }
}
