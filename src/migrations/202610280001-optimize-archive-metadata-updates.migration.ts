import { MigrationInterface, QueryRunner } from 'typeorm';

const TRIGGER_NAME = 'trg_notice_archives_prevent_update';

/** Keeps the existing protection predicate off metadata-only write batches. */
export class OptimizeArchiveMetadataUpdates1793145601000 implements MigrationInterface {
  name = 'OptimizeArchiveMetadataUpdates1793145601000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !['sqlite', 'better-sqlite3'].includes(
        queryRunner.connection.options.type,
      )
    ) {
      return;
    }
    const rows: Array<{ sql: string }> = await queryRunner.query(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`,
      [TRIGGER_NAME],
    );
    const original = rows[0]?.sql;
    if (!original) throw new Error('Archive protection trigger is missing');
    const columns = Array.from(
      new Set(
        Array.from(original.matchAll(/\b(?:NEW|OLD)\."([^"]+)"/gi)).map(
          (match) => match[1],
        ),
      ),
    );
    if (columns.length === 0) {
      throw new Error('Archive protection columns could not be determined');
    }
    // SQLite permits changing the INTEGER PRIMARY KEY through these aliases.
    columns.push('rowid', '_rowid_', 'oid');
    const scoped = original.replace(
      /BEFORE\s+UPDATE\s+ON\s+"notice_archives"/i,
      `BEFORE UPDATE OF ${columns.map((name) => `"${name}"`).join(', ')} ON "notice_archives"`,
    );
    if (scoped === original) {
      throw new Error(
        'Archive protection trigger has an unsupported definition',
      );
    }
    await queryRunner.query(`DROP TRIGGER "${TRIGGER_NAME}"`);
    await queryRunner.query(scoped);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (
      !['sqlite', 'better-sqlite3'].includes(
        queryRunner.connection.options.type,
      )
    ) {
      return;
    }
    const rows: Array<{ sql: string }> = await queryRunner.query(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`,
      [TRIGGER_NAME],
    );
    const original = rows[0]?.sql;
    if (!original) throw new Error('Archive protection trigger is missing');
    const restored = original.replace(
      /BEFORE\s+UPDATE\s+OF[\s\S]*?\s+ON\s+"notice_archives"/i,
      'BEFORE UPDATE ON "notice_archives"',
    );
    if (restored === original) {
      throw new Error('Scoped archive protection trigger is missing');
    }
    await queryRunner.query(`DROP TRIGGER "${TRIGGER_NAME}"`);
    await queryRunner.query(restored);
  }
}
