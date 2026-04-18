import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddContentMetadataColumns1745001601000 implements MigrationInterface {
  name = 'AddContentMetadataColumns1745001601000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableName = 'notice_archives';

    await this.addColumnIfMissing(
      queryRunner,
      tableName,
      new TableColumn({
        name: 'content_bill_number',
        type: 'varchar',
        length: '100',
        isNullable: true,
      }),
    );

    await this.addColumnIfMissing(
      queryRunner,
      tableName,
      new TableColumn({
        name: 'content_proposer',
        type: 'varchar',
        length: '255',
        isNullable: true,
      }),
    );

    await this.addColumnIfMissing(
      queryRunner,
      tableName,
      new TableColumn({
        name: 'content_proposal_date',
        type: 'varchar',
        length: '100',
        isNullable: true,
      }),
    );

    await this.addColumnIfMissing(
      queryRunner,
      tableName,
      new TableColumn({
        name: 'content_committee',
        type: 'varchar',
        length: '200',
        isNullable: true,
      }),
    );

    await this.addColumnIfMissing(
      queryRunner,
      tableName,
      new TableColumn({
        name: 'content_referral_date',
        type: 'varchar',
        length: '100',
        isNullable: true,
      }),
    );

    await this.addColumnIfMissing(
      queryRunner,
      tableName,
      new TableColumn({
        name: 'content_notice_period',
        type: 'varchar',
        length: '200',
        isNullable: true,
      }),
    );

    await this.addColumnIfMissing(
      queryRunner,
      tableName,
      new TableColumn({
        name: 'content_proposal_session',
        type: 'varchar',
        length: '200',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tableName = 'notice_archives';
    const columns = [
      'content_proposal_session',
      'content_notice_period',
      'content_referral_date',
      'content_committee',
      'content_proposal_date',
      'content_proposer',
      'content_bill_number',
    ];

    for (const columnName of columns) {
      const hasColumn = await queryRunner.hasColumn(tableName, columnName);
      if (hasColumn) {
        await queryRunner.dropColumn(tableName, columnName);
      }
    }
  }

  private async addColumnIfMissing(
    queryRunner: QueryRunner,
    tableName: string,
    column: TableColumn,
  ): Promise<void> {
    const hasColumn = await queryRunner.hasColumn(tableName, column.name);
    if (!hasColumn) {
      await queryRunner.addColumn(tableName, column);
    }
  }
}
