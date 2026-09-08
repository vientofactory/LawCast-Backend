import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DiscussionsService } from './discussions.service';
import { DiscussionThread } from './entities/discussion-thread.entity';
import { DiscussionComment } from './entities/discussion-comment.entity';
import { NoticeArchive } from '../notice/notice-archive.entity';
import { migrations } from '../../migrations';

/**
 * Exercises adminSetThreadLock against a real SQLite schema built by the full
 * migration chain, so any persistence/read-back regression for isLocked
 * surfaces without a live DB (reported bug: unlocking a thread appears to
 * still show as locked after a page refresh).
 */
describe('DiscussionsService lock persistence (real schema)', () => {
  let dataSource: DataSource;
  let service: DiscussionsService;
  let moduleRef: TestingModule;

  beforeAll(() => {
    process.env.DISCUSSION_AUTHOR_ID_SECRET = 'test-author-id-secret';
  });

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          synchronize: false,
          migrationsRun: false,
          migrations,
          entities: [DiscussionThread, DiscussionComment, NoticeArchive],
        }),
        TypeOrmModule.forFeature([
          DiscussionThread,
          DiscussionComment,
          NoticeArchive,
        ]),
      ],
      providers: [DiscussionsService],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    await dataSource.runMigrations({ transaction: 'all' });
    service = moduleRef.get(DiscussionsService);

    await dataSource.query(
      `INSERT INTO "discussion_threads"
        ("id", "notice_num", "title", "status", "author_nickname", "author_ip_masked", "author_id", "password_hash", "password_salt", "comment_count")
       VALUES (1, 2200001, '테스트 토론', 'open', '익명', '127.0.***.***', 'author-1', 'hash', 'salt', 1)`,
    );
    await dataSource.query(
      `INSERT INTO "discussion_comments"
        ("id", "thread_id", "notice_num", "sequence", "message_type", "author_nickname", "author_ip_masked", "author_id", "password_hash", "password_salt", "content")
       VALUES (1, 1, 2200001, 1, 'user', '익명', '127.0.***.***', 'author-1', 'hash', 'salt', '첫 의견')`,
    );
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('persists isLocked=false after unlocking, surviving a fresh read from the repository', async () => {
    const locked = await service.adminSetThreadLock(1, true);
    expect(locked.isLocked).toBe(true);
    expect(locked.status).toBe('closed');

    const unlocked = await service.adminSetThreadLock(1, false);
    expect(unlocked.isLocked).toBe(false);
    expect(unlocked.status).toBe('closed');

    // Simulate a page refresh: read the thread again as getThreadDetail would.
    const refreshed = await service.getThreadDetail(1);
    expect(refreshed.thread.isLocked).toBe(false);

    const rawRow = await dataSource.query(
      `SELECT "is_locked" FROM "discussion_threads" WHERE "id" = 1`,
    );
    expect(Number(rawRow[0].is_locked)).toBe(0);
  });

  it('getThreadDetail repository instance is the same used by adminSetThreadLock', () => {
    const repoFromService = (
      service as unknown as { threadRepository: unknown }
    ).threadRepository;
    const repoFromModule = moduleRef.get(getRepositoryToken(DiscussionThread));
    expect(repoFromService).toBe(repoFromModule);
  });
});
