import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddArchiveIntegrityCheckTables1752019201000 implements MigrationInterface {
  name = 'AddArchiveIntegrityCheckTables1752019201000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notice_archive_integrity_checks" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "notice_num" integer NOT NULL,
        "checked_at" datetime NOT NULL,
        "stored_sha256" varchar(64),
        "calculated_sha256" varchar(64),
        "check_result" varchar(20) NOT NULL,
        "skip_reason" varchar(100),
        "verifier_version" varchar(40) NOT NULL DEFAULT ('v1'),
        "diagnostics_json" text,
        "created_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archive_integrity_checks_notice_num_checked_at"
      ON "notice_archive_integrity_checks" ("notice_num", "checked_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archive_integrity_checks_result_checked_at"
      ON "notice_archive_integrity_checks" ("check_result", "checked_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notice_archive_integrity_states" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "notice_num" integer NOT NULL,
        "latest_check_id" integer,
        "latest_result" varchar(20),
        "latest_checked_at" datetime,
        "last_passed_at" datetime,
        "failure_streak" integer NOT NULL DEFAULT (0),
        "last_skip_reason" varchar(100),
        "latest_stored_sha256" varchar(64),
        "latest_calculated_sha256" varchar(64),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_notice_archive_integrity_states_notice_num"
      ON "notice_archive_integrity_states" ("notice_num")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archive_integrity_states_latest_result_checked_at"
      ON "notice_archive_integrity_states" ("latest_result", "latest_checked_at")
    `);

    await queryRunner.query(`
      INSERT INTO "notice_archive_integrity_checks" (
        "notice_num",
        "checked_at",
        "stored_sha256",
        "calculated_sha256",
        "check_result",
        "skip_reason",
        "verifier_version",
        "diagnostics_json"
      )
      SELECT
        na."noticeNum",
        COALESCE(na."integrity_verified_at", datetime('now')),
        na."source_html_sha256",
        CASE
          WHEN na."integrity_check_passed" IS NULL THEN NULL
          ELSE na."source_html_sha256"
        END,
        CASE
          WHEN na."integrity_check_passed" = 1 THEN 'passed'
          WHEN na."integrity_check_passed" = 0 THEN 'failed'
          ELSE 'skipped'
        END,
        CASE
          WHEN na."integrity_check_passed" IS NULL THEN 'legacy_unknown'
          ELSE NULL
        END,
        'legacy-migration-v1',
        '{"migratedFromLegacy":true}'
      FROM "notice_archives" na
      WHERE na."integrity_verified_at" IS NOT NULL
         OR na."integrity_check_passed" IS NOT NULL
    `);

    await queryRunner.query(`
      INSERT OR REPLACE INTO "notice_archive_integrity_states" (
        "notice_num",
        "latest_check_id",
        "latest_result",
        "latest_checked_at",
        "last_passed_at",
        "failure_streak",
        "last_skip_reason",
        "latest_stored_sha256",
        "latest_calculated_sha256",
        "updated_at"
      )
      SELECT
        c."notice_num",
        c."id",
        c."check_result",
        c."checked_at",
        CASE
          WHEN c."check_result" = 'passed' THEN c."checked_at"
          ELSE NULL
        END,
        CASE
          WHEN c."check_result" = 'failed' THEN 1
          ELSE 0
        END,
        c."skip_reason",
        c."stored_sha256",
        c."calculated_sha256",
        datetime('now')
      FROM "notice_archive_integrity_checks" c
      INNER JOIN (
        SELECT "notice_num", MAX("id") AS "latest_id"
        FROM "notice_archive_integrity_checks"
        GROUP BY "notice_num"
      ) latest
        ON latest."notice_num" = c."notice_num"
       AND latest."latest_id" = c."id"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archive_integrity_states_latest_result_checked_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archive_integrity_states_notice_num"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notice_archive_integrity_states"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archive_integrity_checks_result_checked_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archive_integrity_checks_notice_num_checked_at"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notice_archive_integrity_checks"`,
    );
  }
}
