import { DataSource } from 'typeorm';
import { migrations } from '../../migrations';
import { DiscussionNotificationService } from './discussion-notification.service';
import { DiscussionComment } from './entities/discussion-comment.entity';
import { DiscussionThread } from './entities/discussion-thread.entity';

describe('Bounded discussion quote lookup', () => {
  it('seeks only quoted sequences and preserves author, deletion, type and thread exclusions', async () => {
    const queries: Array<{ sql: string; parameters: unknown[] }> = [];
    const db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [DiscussionComment, DiscussionThread],
      migrations,
      logging: ['query'],
      logger: {
        logQuery: (sql, parameters) =>
          queries.push({
            sql,
            parameters: Array.isArray(parameters) ? parameters : [],
          }),
        logQueryError() {},
        logQuerySlow() {},
        logSchemaBuild() {},
        logMigration() {},
        log() {},
      },
    });
    await db.initialize();
    try {
      await db.runMigrations();
      await db.query(`
        INSERT INTO discussion_threads
          (id,notice_num,title,author_ip_masked,author_id,password_hash,password_salt)
        VALUES (7,100,'Fixture','masked','thread-author','hash','salt'),
               (8,100,'Other thread','masked','other-author','hash','salt')
      `);
      await db.query(`
        WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<3000)
        INSERT INTO discussion_comments
          (thread_id,notice_num,sequence,author_ip_masked,author_id,password_hash,password_salt,content,is_deleted,message_type)
        SELECT 7,100,n,'masked','author-'||n,'hash','salt',printf('%02000d',n),
               n=3, CASE WHEN n=4 THEN 'system' WHEN n=5 THEN 'admin' ELSE 'user' END
        FROM nums
      `);
      await db.query(`
        INSERT INTO discussion_comments
          (thread_id,notice_num,sequence,author_ip_masked,author_id,password_hash,password_salt,content)
        VALUES (8,100,1,'masked','other-thread-author','hash','salt','Other thread')
      `);
      const repository = db.getRepository(DiscussionComment);
      const find = jest.spyOn(repository, 'find');
      const subscriptions = {
        findActiveForDiscussionAuthor: jest
          .fn()
          .mockResolvedValue([{ id: 11 }]),
      };
      const push = { sendQuoteBatch: jest.fn().mockResolvedValue(undefined) };
      const service = new DiscussionNotificationService(
        repository,
        subscriptions as never,
        push as never,
      );
      queries.length = 0;
      await service.notifyForQuotes({
        id: 4000,
        threadId: 7,
        noticeNum: 100,
        sequence: 3001,
        authorId: 'author-2',
        authorNickname: 'Quoting author',
        content: '>>#6 >>#1 >>#2 >>#3 >>#4 >>#5 >>#6 >>#99999',
      } as DiscussionComment);
      expect(find).toHaveBeenCalledTimes(1);
      expect(await find.mock.results[0].value).toHaveLength(6);
      expect(push.sendQuoteBatch).toHaveBeenCalledTimes(2);
      expect(
        push.sendQuoteBatch.mock.calls
          .map(([payload]) => payload.quotedSequence)
          .sort(),
      ).toEqual([1, 6]);
      expect(
        subscriptions.findActiveForDiscussionAuthor.mock.calls
          .map(([, author]) => author)
          .sort(),
      ).toEqual(['author-1', 'author-6']);
      const query = queries.find(({ sql }) => sql.startsWith('SELECT'))!;
      expect(query.sql).not.toContain('password_hash');
      expect(query.sql).not.toContain('password_salt');
      expect(query.sql).not.toContain('"content"');
      const plan: Array<{ detail: string }> = await db.query(
        'EXPLAIN QUERY PLAN ' + query.sql,
        query.parameters,
      );
      expect(plan.map((row) => row.detail).join('\n')).toMatch(
        /thread_id=\? AND sequence=\?/,
      );
      find.mockClear();
      await service.notifyForQuotes({
        content: 'No quote',
      } as DiscussionComment);
      expect(find).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });
});
