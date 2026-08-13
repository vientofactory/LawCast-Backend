import { DataSource } from 'typeorm';
import { migrations } from './index';

/**
 * Exercises the immutability trigger against a real SQLite schema built by the
 * full migration chain, so trigger regressions surface without a live DB.
 */
describe('notice_archives immutability trigger', () => {
  let dataSource: DataSource;

  const insertRow = async (
    overrides: Record<string, unknown> = {},
  ): Promise<void> => {
    const row = {
      noticeNum: 2203643,
      subject: '테스트 법률안',
      proposerCategory: '의원',
      committee: '법제사법위원회',
      assemblyLink: 'https://pal.assembly.go.kr/napal/lgsltpa/lgsltpaOngoing',
      contentId: null,
      proposalReason: '사유 본문',
      source_html: null,
      source_html_sha256: null,
      http_metadata_json: null,
      http_status_code: null,
      screenshot_blob: null,
      screenshot_format: null,
      ...overrides,
    };

    const columns = Object.keys(row)
      .map((column) => `"${column}"`)
      .join(', ');
    const placeholders = Object.keys(row)
      .map(() => '?')
      .join(', ');

    await dataSource.query(
      `INSERT INTO "notice_archives" (${columns}) VALUES (${placeholders})`,
      Object.values(row),
    );
  };

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: false,
      migrationsRun: false,
      migrations,
      entities: [],
    });

    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('allows filling every snapshot artifact column while it is still NULL', async () => {
    await insertRow();

    await dataSource.query(
      `UPDATE "notice_archives"
         SET "source_html" = ?, "source_html_sha256" = ?
       WHERE "noticeNum" = ? AND "source_html" IS NULL`,
      ['<html>captured</html>', 'a'.repeat(64), 2203643],
    );

    await dataSource.query(
      `UPDATE "notice_archives"
         SET "http_metadata_json" = ?, "http_status_code" = ?
       WHERE "noticeNum" = ? AND "http_metadata_json" IS NULL`,
      ['{"statusCode":200}', 200, 2203643],
    );

    await dataSource.query(
      `UPDATE "notice_archives"
         SET "screenshot_blob" = ?, "screenshot_format" = ?
       WHERE "noticeNum" = ? AND "screenshot_blob" IS NULL`,
      [Buffer.from('shot'), 'jpeg', 2203643],
    );

    const [row] = await dataSource.query(
      `SELECT "source_html", "http_status_code", "screenshot_format"
         FROM "notice_archives" WHERE "noticeNum" = ?`,
      [2203643],
    );

    expect(row.source_html).toBe('<html>captured</html>');
    expect(row.http_status_code).toBe(200);
    expect(row.screenshot_format).toBe('jpeg');
  });

  it('rejects overwriting an artifact column that already has a value', async () => {
    await insertRow({ source_html: '<html>original</html>' });

    await expect(
      dataSource.query(
        `UPDATE "notice_archives" SET "source_html" = ? WHERE "noticeNum" = ?`,
        ['<html>tampered</html>', 2203643],
      ),
    ).rejects.toThrow(/immutable after initial snapshot archive/);
  });

  it('rejects clearing an artifact column back to NULL', async () => {
    await insertRow({ screenshot_blob: Buffer.from('shot') });

    await expect(
      dataSource.query(
        `UPDATE "notice_archives" SET "screenshot_blob" = NULL WHERE "noticeNum" = ?`,
        [2203643],
      ),
    ).rejects.toThrow(/immutable after initial snapshot archive/);
  });

  it('still rejects mutating content columns even alongside a valid fill', async () => {
    await insertRow();

    await expect(
      dataSource.query(
        `UPDATE "notice_archives"
           SET "source_html" = ?, "proposalReason" = ?
         WHERE "noticeNum" = ?`,
        ['<html>captured</html>', '변조된 사유', 2203643],
      ),
    ).rejects.toThrow(/immutable after initial snapshot archive/);
  });

  it.each([
    ['subject', '변조된 제목'],
    ['lifecycle_status', 'source_deleted'],
    ['integrity_check_passed', 1],
    ['archived_at', '2026-01-01 00:00:00'],
  ])('still rejects mutating %s', async (column, value) => {
    await insertRow();

    await expect(
      dataSource.query(
        `UPDATE "notice_archives" SET "${column}" = ? WHERE "noticeNum" = ?`,
        [value, 2203643],
      ),
    ).rejects.toThrow(/immutable after initial snapshot archive/);
  });

  it('still forbids physical deletes', async () => {
    await insertRow();

    await expect(
      dataSource.query(
        `DELETE FROM "notice_archives" WHERE "noticeNum" = ?`,
        [2203643],
      ),
    ).rejects.toThrow(/physical delete is forbidden/);
  });

  it('treats a no-op rewrite of an existing value as allowed', async () => {
    await insertRow({ source_html: '<html>original</html>' });

    await expect(
      dataSource.query(
        `UPDATE "notice_archives" SET "source_html" = ? WHERE "noticeNum" = ?`,
        ['<html>original</html>', 2203643],
      ),
    ).resolves.not.toThrow();
  });
});
