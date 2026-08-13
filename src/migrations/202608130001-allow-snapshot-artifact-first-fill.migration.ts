import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Columns that may never change once the snapshot row exists.
 */
const IMMUTABLE_COLUMNS = [
  'id',
  'noticeNum',
  'subject',
  'proposerCategory',
  'committee',
  'assemblyLink',
  'contentId',
  'proposalReason',
  'sourceTitle',
  'content_bill_number',
  'content_proposer',
  'content_proposal_date',
  'content_committee',
  'content_referral_date',
  'content_notice_period',
  'content_proposal_session',
  'attachmentPdfFile',
  'attachmentHwpFile',
  'archived_at',
  'integrity_verified_at',
  'integrity_check_passed',
  'lifecycle_status',
  'source_deleted_at',
  'archive_started_at',
];

/**
 * Capture artifacts that may be written exactly once while still NULL, so a
 * failed first capture stays recoverable without weakening immutability.
 */
const FIRST_FILL_COLUMNS = [
  'source_html',
  'source_html_sha256',
  'http_metadata_json',
  'http_fetched_at',
  'http_status_code',
  'http_content_type',
  'http_etag',
  'http_last_modified',
  'screenshot_blob',
  'screenshot_format',
];

const ABORT_MESSAGE =
  'notice_archives is immutable after initial snapshot archive';

function buildAllowedUpdatePredicate(): string {
  // `IS` is null-safe in SQLite, so unchanged NULL columns compare equal.
  const unchanged = IMMUTABLE_COLUMNS.map(
    (column) => `NEW."${column}" IS OLD."${column}"`,
  );

  const fillOnce = FIRST_FILL_COLUMNS.map(
    (column) =>
      `(OLD."${column}" IS NULL OR NEW."${column}" IS OLD."${column}")`,
  );

  return [...unchanged, ...fillOnce].join('\n        AND ');
}

export class AllowSnapshotArtifactFirstFill1755043201000 implements MigrationInterface {
  name = 'AllowSnapshotArtifactFirstFill1755043201000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const driverType = queryRunner.connection.options.type;
    if (driverType !== 'sqlite' && driverType !== 'better-sqlite3') {
      return;
    }

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_archives_prevent_update"`,
    );

    await queryRunner.query(`
      CREATE TRIGGER "trg_notice_archives_prevent_update"
      BEFORE UPDATE ON "notice_archives"
      WHEN NOT (
        ${buildAllowedUpdatePredicate()}
      )
      BEGIN
        SELECT RAISE(ABORT, '${ABORT_MESSAGE}');
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const driverType = queryRunner.connection.options.type;
    if (driverType !== 'sqlite' && driverType !== 'better-sqlite3') {
      return;
    }

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notice_archives_prevent_update"`,
    );

    await queryRunner.query(`
      CREATE TRIGGER "trg_notice_archives_prevent_update"
      BEFORE UPDATE ON "notice_archives"
      BEGIN
        SELECT RAISE(ABORT, '${ABORT_MESSAGE}');
      END
    `);
  }
}
