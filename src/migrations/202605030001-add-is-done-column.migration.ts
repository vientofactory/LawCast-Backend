import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddIsDoneColumn1746316801000 implements MigrationInterface {
  name = 'AddIsDoneColumn1746316801000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.hasColumn('notice_archives', 'is_done');
    if (!hasColumn) {
      await queryRunner.addColumn(
        'notice_archives',
        new TableColumn({
          name: 'is_done',
          type: 'boolean',
          default: false,
          isNullable: false,
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.hasColumn('notice_archives', 'is_done');
    if (hasColumn) {
      await queryRunner.dropColumn('notice_archives', 'is_done');
    }
  }
}
