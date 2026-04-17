import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchemaMigration1744953900000 implements MigrationInterface {
  name = 'InitialSchemaMigration1744953900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "webhooks" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "url" varchar NOT NULL,
        "isActive" boolean NOT NULL DEFAULT (1),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_webhooks_url_unique"
      ON "webhooks" ("url")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhooks_is_active_updated_at"
      ON "webhooks" ("isActive", "updatedAt")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notice_archives" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "noticeNum" integer NOT NULL,
        "subject" varchar(500) NOT NULL,
        "proposerCategory" varchar(100) NOT NULL,
        "committee" varchar(200) NOT NULL,
        "assemblyLink" text NOT NULL,
        "contentId" varchar(100),
        "proposalReason" text NOT NULL DEFAULT (''),
        "sourceTitle" text,
        "aiSummary" text,
        "aiSummaryStatus" varchar(30) NOT NULL DEFAULT ('not_requested'),
        "attachmentPdfFile" text NOT NULL DEFAULT (''),
        "attachmentHwpFile" text NOT NULL DEFAULT (''),
        "archived_at" datetime,
        "source_html" text,
        "source_html_sha256" varchar(64),
        "integrity_verified_at" datetime,
        "integrity_check_passed" boolean,
        "http_metadata_json" text,
        "http_fetched_at" datetime,
        "http_status_code" integer,
        "http_content_type" varchar(255),
        "http_etag" varchar(255),
        "http_last_modified" varchar(255),
        "archive_started_at" datetime NOT NULL DEFAULT (datetime('now')),
        "last_updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_notice_archives_notice_num"
      ON "notice_archives" ("noticeNum")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_archives_subject"
      ON "notice_archives" ("subject")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_subject"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_archives_notice_num"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "notice_archives"`);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_webhooks_is_active_updated_at"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_webhooks_url_unique"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "webhooks"`);
  }
}
