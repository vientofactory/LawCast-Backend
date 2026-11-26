import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class OptimizeArchiveMaintenanceIndexes1795651201000 implements MigrationInterface {
  name = 'OptimizeArchiveMaintenanceIndexes1795651201000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.replaceArtifactIndexes(queryRunner, true);
    // Only empty-reason rows enter this queue. Keep eligibility and rotation
    // in the index instead of sorting every active, large archive row.
    await queryRunner.query(`
      CREATE INDEX "idx_notice_archives_reason_retry_queue"
      ON "notice_archives" (
        "lifecycle_status", "proposal_reason_retry_count",
        "proposal_reason_retried_at", "noticeNum"
      )
      WHERE COALESCE(TRIM("proposalReason"), '') = ''
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX "idx_notice_archives_reason_retry_queue"',
    );
    await this.replaceArtifactIndexes(queryRunner, false);
  }

  private async replaceArtifactIndexes(
    queryRunner: QueryRunner,
    includeLifecycle: boolean,
  ): Promise<void> {
    for (const [artifact, column] of [
      ['html', 'source_html'],
      ['screenshot', 'screenshot_blob'],
    ]) {
      for (const [source, contentIdPredicate] of [
        ['pal', 'IS NOT NULL'],
        ['nsm', 'IS NULL'],
      ]) {
        const name = `idx_notice_archives_missing_${source}_${artifact}_notice_num`;
        await queryRunner.query(`DROP INDEX "${name}"`);
        // Replace, rather than duplicate, the existing partial indexes.
        await queryRunner.query(`
          CREATE INDEX "${name}"
          ON "notice_archives" (${includeLifecycle ? '"lifecycle_status", ' : ''}"noticeNum")
          WHERE "${column}" IS NULL AND "contentId" ${contentIdPredicate}
        `);
      }
    }
  }
}
