import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds list-absence tracking columns to notice_archives.
 *
 * Source-deletion detection used to treat "every active NSM row the latest list
 * scan did not return" as the probe candidate set and re-probe it on every
 * cycle. That only matches the archive when the scanned list covers the same
 * population as the archive; with a pending-only list (`LIKMS 계류의안` over an
 * NSM archive) it produced ~10k detail requests per 20-minute cycle, all of them
 * repeated forever.
 *
 * - `nsm_last_seen_in_list_at` records when a row was last returned by a
 *   completed list scan, so absence becomes an episode that starts when a
 *   previously seen row stops being returned.
 * - `nsm_list_absence_probed_at` records when that absence was last
 *   investigated without a confirmed deletion, so a row that stays absent (or
 *   is never listed by the active source) is probed once per cooldown instead
 *   of once per cycle.
 *
 * Both are nullable with no default, so existing rows read as "not seen since
 * this tracking was introduced" and drain under the cooldown (at most
 * `ARCHIVE_SYNC_NSM_MISSING_PROBE_MAX_CANDIDATES` per pass) rather than being
 * swept at once.
 */
export class AddNsmListAbsenceTracking1760400001000 implements MigrationInterface {
  name = 'AddNsmListAbsenceTracking1760400001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const driverType = queryRunner.connection.options.type;
    if (driverType !== 'sqlite' && driverType !== 'better-sqlite3') {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "notice_archives"
      ADD COLUMN "nsm_last_seen_in_list_at" datetime
    `);

    await queryRunner.query(`
      ALTER TABLE "notice_archives"
      ADD COLUMN "nsm_list_absence_probed_at" datetime
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const driverType = queryRunner.connection.options.type;
    if (driverType !== 'sqlite' && driverType !== 'better-sqlite3') {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "notice_archives" DROP COLUMN "nsm_list_absence_probed_at"
    `);

    await queryRunner.query(`
      ALTER TABLE "notice_archives" DROP COLUMN "nsm_last_seen_in_list_at"
    `);
  }
}
