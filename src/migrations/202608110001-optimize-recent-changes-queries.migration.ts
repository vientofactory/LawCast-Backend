import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Optimizes recent change listing/search paths.
 *
 * 1) Stable pagination ordering for recent changes (detected_at, id)
 * 2) Event-type filtered ordering path
 * 3) Notice-scoped ordering path
 * 4) Partial index for isDone-change exclusion
 */
export class OptimizeRecentChangesQueries1754899201000 implements MigrationInterface {
  name = 'OptimizeRecentChangesQueries1754899201000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_events_detected_at_id"
      ON "notice_change_events" ("detected_at" DESC, "id" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_events_event_type_detected_at_id"
      ON "notice_change_events" ("event_type", "detected_at" DESC, "id" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_events_notice_num_detected_at_id"
      ON "notice_change_events" ("notice_num", "detected_at" DESC, "id" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notice_change_details_is_done_event_id"
      ON "notice_change_details" ("event_id")
      WHERE "field_path" = 'isDone'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_details_is_done_event_id"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_events_notice_num_detected_at_id"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_events_event_type_detected_at_id"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notice_change_events_detected_at_id"`,
    );
  }
}
