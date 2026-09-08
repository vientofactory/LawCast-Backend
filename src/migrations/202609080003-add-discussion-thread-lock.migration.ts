import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddDiscussionThreadLock1757289603000 implements MigrationInterface {
  name = 'AddDiscussionThreadLock1757289603000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "discussion_threads"
      ADD COLUMN "is_locked" boolean NOT NULL DEFAULT (0);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "discussion_threads" DROP COLUMN "is_locked";`,
    );
  }
}
