import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddWebPushNotificationPreference1757203201000 implements MigrationInterface {
  name = 'AddWebPushNotificationPreference1757203201000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "web_push_subscriptions"
      ADD COLUMN "notice_notifications_enabled" boolean NOT NULL DEFAULT (1);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_web_push_subscriptions_notice_notifications"
      ON "web_push_subscriptions" ("is_active", "notice_notifications_enabled");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_web_push_subscriptions_notice_notifications";',
    );
    await queryRunner.query(`
      ALTER TABLE "web_push_subscriptions"
      DROP COLUMN "notice_notifications_enabled";
    `);
  }
}
