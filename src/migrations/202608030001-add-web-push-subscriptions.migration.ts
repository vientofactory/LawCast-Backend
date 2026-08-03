import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddWebPushSubscriptions1754179201000 implements MigrationInterface {
  name = 'AddWebPushSubscriptions1754179201000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "web_push_subscriptions" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "endpoint" text NOT NULL,
        "p256dh" text NOT NULL,
        "auth" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT (1),
        "user_agent" text,
        "last_notified_at" datetime,
        "failure_count" integer NOT NULL DEFAULT (0),
        "last_failure_reason" text,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_web_push_subscriptions_endpoint_unique"
      ON "web_push_subscriptions" ("endpoint");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_web_push_subscriptions_is_active_updated_at"
      ON "web_push_subscriptions" ("is_active", "updated_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_web_push_subscriptions_is_active_updated_at";',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_web_push_subscriptions_endpoint_unique";',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "web_push_subscriptions";');
  }
}
