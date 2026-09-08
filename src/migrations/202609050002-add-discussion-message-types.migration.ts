import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddDiscussionMessageTypes1757059202000 implements MigrationInterface {
  name = 'AddDiscussionMessageTypes1757059202000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "discussion_comments"
      ADD COLUMN "message_type" varchar(20) NOT NULL DEFAULT ('user');
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discussion_comments_thread_message_type"
      ON "discussion_comments" ("thread_id", "message_type");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_comments_thread_message_type";',
    );
    await queryRunner.query(
      `DELETE FROM "discussion_comments" WHERE "message_type" = 'system';`,
    );
    await queryRunner.query(
      `ALTER TABLE "discussion_comments" DROP COLUMN "message_type";`,
    );
  }
}
