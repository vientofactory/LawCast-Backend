import { DataSource } from 'typeorm';
import { migrations } from '../../../migrations';
import { NoticeArchive } from '../notice-archive.entity';
import { NoticeArchiveSnapshotState } from '../notice-archive-summary-state.entity';
import { NoticeArchiveIntegrityCheck } from '../notice-archive-integrity-check.entity';
import { NoticeArchiveIntegrityState } from '../notice-archive-integrity-state.entity';
import { computeSha256 } from '../notice-archive.helpers';
import { NoticeArchiveArtifactSupport } from './notice-archive-artifact-support';

describe('cooperative snapshot integrity scan with real SQLite', () => {
  it('yields to timers, bounds HTML pages and persists every result across pages', async () => {
    const db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      migrations,
      entities: [
        NoticeArchive,
        NoticeArchiveSnapshotState,
        NoticeArchiveIntegrityCheck,
        NoticeArchiveIntegrityState,
      ],
    });
    await db.initialize();
    try {
      await db.runMigrations({ transaction: 'all' });
      const archives = db.getRepository(NoticeArchive);
      for (let i = 1; i <= 26; i++) {
        await archives.save({
          noticeNum: 2200000 + i,
          subject: 'Fixture bill',
          proposerCategory: '의원',
          committee: 'fixture',
          assemblyLink: 'https://example.test',
          proposalReason: 'Fixture reason',
          sourceHtml: i === 1 ? null : '<html>fixture</html>',
          sourceHtmlSha256:
            i === 2
              ? 'bad-hash'
              : i === 1
                ? null
                : computeSha256('<html>fixture</html>'),
        });
      }
      const checks = db.getRepository(NoticeArchiveIntegrityCheck);
      const states = db.getRepository(NoticeArchiveIntegrityState);
      const support = new NoticeArchiveArtifactSupport(
        archives,
        checks,
        states,
      );
      const find = jest.spyOn(archives, 'find');
      let completedAtTimer = -1;
      const timer = new Promise<void>((resolve) =>
        setTimeout(() => {
          void checks.count().then((count) => {
            completedAtTimer = count;
            resolve();
          });
        }, 0),
      );
      expect(await support.runIntegrityScan(200)).toEqual({
        scanned: 26,
        passed: 24,
        failed: 1,
        skipped: 1,
      });
      await timer;
      expect(completedAtTimer).toBeGreaterThan(0);
      expect(completedAtTimer).toBeLessThan(26);
      expect(await checks.count()).toBe(26);
      expect(await states.count()).toBe(26);
      for (const [options] of find.mock.calls)
        expect(options.take).toBeLessThanOrEqual(10);
      expect(
        (await archives.findOneByOrFail({ noticeNum: 2200002 }))
          .sourceHtmlSha256,
      ).toBe('bad-hash');
    } finally {
      await db.destroy();
    }
  });
});
