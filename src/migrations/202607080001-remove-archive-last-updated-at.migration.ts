import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveArchiveLastUpdatedAt1751932801000 implements MigrationInterface {
  name = 'RemoveArchiveLastUpdatedAt1751932801000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notice_archives" DROP COLUMN "last_updated_at"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const driverType = queryRunner.connection.options.type;

    if (driverType === 'sqlite' || driverType === 'better-sqlite3') {
      await queryRunner.query(
        `ALTER TABLE "notice_archives" ADD COLUMN "last_updated_at" datetime NOT NULL DEFAULT (datetime('now'))`,
      );
      return;
    }

    await queryRunner.query(
      `ALTER TABLE "notice_archives" ADD COLUMN "last_updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    );
  }
}
