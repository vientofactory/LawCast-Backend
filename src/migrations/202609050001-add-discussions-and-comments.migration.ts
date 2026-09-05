import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddDiscussionsAndComments1757059201000 implements MigrationInterface {
  name = 'AddDiscussionsAndComments1757059201000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discussion_threads" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "notice_num" integer NOT NULL,
        "title" varchar(255) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT ('open'),
        "author_nickname" varchar(100) NOT NULL DEFAULT ('익명'),
        "author_ip_masked" varchar(50) NOT NULL,
        "author_ip_hash" varchar(64) NOT NULL,
        "password_hash" varchar(128) NOT NULL,
        "password_salt" varchar(64) NOT NULL,
        "comment_count" integer NOT NULL DEFAULT (1),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discussion_threads_notice_num"
      ON "discussion_threads" ("notice_num");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discussion_threads_notice_num_updated_at"
      ON "discussion_threads" ("notice_num", "updated_at");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discussion_comments" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "thread_id" integer NOT NULL,
        "notice_num" integer NOT NULL,
        "sequence" integer NOT NULL,
        "author_nickname" varchar(100) NOT NULL DEFAULT ('익명'),
        "author_ip_masked" varchar(50) NOT NULL,
        "author_ip_hash" varchar(64) NOT NULL,
        "password_hash" varchar(128) NOT NULL,
        "password_salt" varchar(64) NOT NULL,
        "content" text NOT NULL,
        "is_deleted" boolean NOT NULL DEFAULT (0),
        "is_edited" boolean NOT NULL DEFAULT (0),
        "edited_at" datetime,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY ("thread_id") REFERENCES "discussion_threads" ("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discussion_comments_thread_id"
      ON "discussion_comments" ("thread_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discussion_comments_notice_num"
      ON "discussion_comments" ("notice_num");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discussion_comments_thread_id_seq"
      ON "discussion_comments" ("thread_id", "sequence");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_comments_thread_id_seq";',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_comments_notice_num";',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_comments_thread_id";',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "discussion_comments";');

    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_threads_notice_num_updated_at";',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_threads_notice_num";',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "discussion_threads";');
  }
}
