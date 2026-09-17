import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds screenshot capture status tracking columns to notice_archives so that
 * when a screenshot capture fails the reason is persisted and visible in the UI
 * instead of silently leaving the screenshot_blob as NULL with no explanation.
 */
export class AddScreenshotCaptureStatus1758096001000 implements MigrationInterface {
  name = 'AddScreenshotCaptureStatus1758096001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const driverType = queryRunner.connection.options.type;
    if (driverType !== 'sqlite' && driverType !== 'better-sqlite3') {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "notice_archives"
      ADD COLUMN "screenshot_capture_status" varchar(20)
    `);

    await queryRunner.query(`
      ALTER TABLE "notice_archives"
      ADD COLUMN "screenshot_capture_error" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const driverType = queryRunner.connection.options.type;
    if (driverType !== 'sqlite' && driverType !== 'better-sqlite3') {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "notice_archives" DROP COLUMN "screenshot_capture_error"
    `);

    await queryRunner.query(`
      ALTER TABLE "notice_archives" DROP COLUMN "screenshot_capture_status"
    `);
  }
}
