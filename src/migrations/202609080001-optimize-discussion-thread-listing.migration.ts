import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class OptimizeDiscussionThreadListing1757289601000 implements MigrationInterface {
  name = 'OptimizeDiscussionThreadListing1757289601000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discussion_threads_updated_at_id"
      ON "discussion_threads" ("updated_at" DESC, "id" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discussion_threads_status_updated_at_id"
      ON "discussion_threads" ("status", "updated_at" DESC, "id" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_threads_status_updated_at_id";',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_discussion_threads_updated_at_id";',
    );
  }
}
