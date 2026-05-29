import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddScreenshotBlob1748476800000 implements MigrationInterface {
  name = 'AddScreenshotBlob1748476800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasBlob = await queryRunner.hasColumn(
      'notice_archives',
      'screenshot_blob',
    );
    if (!hasBlob) {
      await queryRunner.addColumn(
        'notice_archives',
        new TableColumn({
          name: 'screenshot_blob',
          type: 'blob',
          isNullable: true,
        }),
      );
    }

    const hasFormat = await queryRunner.hasColumn(
      'notice_archives',
      'screenshot_format',
    );
    if (!hasFormat) {
      await queryRunner.addColumn(
        'notice_archives',
        new TableColumn({
          name: 'screenshot_format',
          type: 'varchar',
          length: '10',
          isNullable: true,
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasFormat = await queryRunner.hasColumn(
      'notice_archives',
      'screenshot_format',
    );
    if (hasFormat) {
      await queryRunner.dropColumn('notice_archives', 'screenshot_format');
    }

    const hasBlob = await queryRunner.hasColumn(
      'notice_archives',
      'screenshot_blob',
    );
    if (hasBlob) {
      await queryRunner.dropColumn('notice_archives', 'screenshot_blob');
    }
  }
}
