import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddDiscussionCommentDeletedBy1757289602000 implements MigrationInterface {
  name = 'AddDiscussionCommentDeletedBy1757289602000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "discussion_comments"
      ADD COLUMN "deleted_by" varchar(20);
    `);
    await queryRunner.query(`
      UPDATE "discussion_comments"
      SET "deleted_by" = 'author'
      WHERE "is_deleted" = 1 AND "deleted_by" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "discussion_comments" DROP COLUMN "deleted_by";`,
    );
  }
}
