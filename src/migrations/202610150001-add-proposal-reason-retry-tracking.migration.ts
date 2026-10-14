import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds proposalReason retry-attempt tracking to notice_archives.
 *
 * The `proposalReason` retry cron picked its candidates with
 * `ORDER BY noticeNum ASC LIMIT 20` and no record of what it had already
 * tried. Production showed the consequence: the 20 lowest notice numbers were
 * non-bill agenda items (`사직의건`/`결의안`) whose `제안이유` does not exist in
 * any source, so every tick re-seeded the same 20 rows, each fetch returned
 * nothing, the drain dropped them again, and the 180 bill rows that actually
 * had a recoverable reason behind 267 earlier candidates were never reached
 * (agent_memories/39-likms-reason-backfill-throughput/).
 *
 * - `proposal_reason_retry_count` counts attempts, so a row that keeps failing
 *   sinks behind every row with fewer attempts (never-attempted rows, meaning
 *   every newly arrived candidate, sort first).
 * - `proposal_reason_retried_at` timestamps the last attempt, so rows with the
 *   same attempt count are served oldest-attempt-first and the pool is walked
 *   as a rotation instead of a fixed head.
 *
 * Both columns are outside the immutability trigger's unchanged-column list,
 * exactly like the `nsm_last_seen_in_list_at` / `nsm_list_absence_probed_at`
 * tracking stamps, so advancing them does not touch the snapshot contract. The
 * count defaults to 0 for existing rows, which is the correct "never
 * attempted" state.
 */
export class AddProposalReasonRetryTracking1760486401000 implements MigrationInterface {
  name = 'AddProposalReasonRetryTracking1760486401000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const driverType = queryRunner.connection.options.type;
    if (driverType !== 'sqlite' && driverType !== 'better-sqlite3') {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "notice_archives"
      ADD COLUMN "proposal_reason_retried_at" datetime
    `);

    await queryRunner.query(`
      ALTER TABLE "notice_archives"
      ADD COLUMN "proposal_reason_retry_count" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const driverType = queryRunner.connection.options.type;
    if (driverType !== 'sqlite' && driverType !== 'better-sqlite3') {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "notice_archives" DROP COLUMN "proposal_reason_retry_count"
    `);

    await queryRunner.query(`
      ALTER TABLE "notice_archives" DROP COLUMN "proposal_reason_retried_at"
    `);
  }
}
