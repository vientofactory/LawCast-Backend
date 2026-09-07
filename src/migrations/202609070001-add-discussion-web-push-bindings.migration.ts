import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddDiscussionWebPushBindings1757203200000 implements MigrationInterface {
  name = 'AddDiscussionWebPushBindings1757203200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discussion_web_push_bindings" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "thread_id" integer NOT NULL,
        "author_id" varchar(64) NOT NULL,
        "subscription_id" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT (1),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "fk_discussion_web_push_binding_thread"
          FOREIGN KEY ("thread_id") REFERENCES "discussion_threads" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_discussion_web_push_binding_subscription"
          FOREIGN KEY ("subscription_id") REFERENCES "web_push_subscriptions" ("id") ON DELETE CASCADE
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discussion_web_push_bindings_lookup"
      ON "discussion_web_push_bindings" ("thread_id", "author_id", "is_active");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discussion_web_push_bindings_subscription"
      ON "discussion_web_push_bindings" ("subscription_id", "is_active");
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_discussion_web_push_bindings_unique"
      ON "discussion_web_push_bindings" ("thread_id", "author_id", "subscription_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_web_push_bindings_unique";',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_web_push_bindings_subscription";',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_web_push_bindings_lookup";',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS "discussion_web_push_bindings";',
    );
  }
}
