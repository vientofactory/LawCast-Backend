import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ChangeTrackingService } from './change-tracking.service';
import {
  CHANGE_EVENT_TYPE,
  NoticeChangeEvent,
} from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';

describe('Revision history cursor pagination', () => {
  let dataSource: DataSource;
  let service: ChangeTrackingService;

  beforeEach(async () => {
    dataSource = await new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [NoticeChangeEvent, NoticeChangeDetail],
    }).initialize();
    const events = dataSource.getRepository(NoticeChangeEvent);
    const details = dataSource.getRepository(NoticeChangeDetail);
    service = new ChangeTrackingService(
      events,
      details,
      undefined as any,
      undefined as any,
      undefined as any,
    );
    await events.insert(
      Array.from({ length: 125 }, (_, i) => ({
        noticeNum: 2210001,
        eventHeight: i + 1,
        detectedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 125 - i)),
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        eventHash: `event-${i + 1}`,
        changedFieldCount: 1,
      })),
    );
    const saved = await events.find();
    await details.insert(
      saved.map((event) => ({
        eventId: event.id,
        fieldPath: 'proposalReason',
        changeType: 'modified' as const,
        beforeValue: `before-${event.eventHeight}`,
        afterValue: `after-${event.eventHeight}`,
      })),
    );
    await events.insert({
      noticeNum: 2210002,
      eventHeight: 999,
      eventType: CHANGE_EVENT_TYPE.CREATED,
      eventHash: 'other-notice',
      detectedAt: new Date(),
    });
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('loads beyond 100 records without duplicates when a new head arrives between pages', async () => {
    const first = await service.getNoticeChangeTimelinePage({
      noticeNum: 2210001,
    });
    expect(first.items.map((item) => item.eventHeight)).toEqual(
      Array.from({ length: 20 }, (_, i) => 125 - i),
    );
    expect(first).toMatchObject({
      count: 20,
      hasMore: true,
      nextBeforeHeight: 106,
    });
    expect(first.items[0].details[0].afterValue).toBe('after-125');
    await dataSource.getRepository(NoticeChangeEvent).insert({
      noticeNum: 2210001,
      eventHeight: 126,
      eventType: CHANGE_EVENT_TYPE.UPDATED,
      eventHash: 'new-head',
      detectedAt: new Date(),
    });
    const heights = first.items.map((item) => item.eventHeight);
    let cursor = first.nextBeforeHeight;
    while (cursor !== null) {
      const page = await service.getNoticeChangeTimelinePage({
        noticeNum: 2210001,
        beforeHeight: cursor,
      });
      expect(
        page.items.every(
          (item) => item.eventHeight < cursor && item.noticeNum === 2210001,
        ),
      ).toBe(true);
      heights.push(...page.items.map((item) => item.eventHeight));
      cursor = page.nextBeforeHeight;
    }
    expect(heights).toEqual(Array.from({ length: 125 }, (_, i) => 125 - i));
    expect(new Set(heights).size).toBe(125);
  });

  it('caps page sizes and supplies an exclusive cursor only when another page exists', async () => {
    const page = await service.getNoticeChangeTimelinePage({
      noticeNum: 2210001,
      limit: 1000,
    });
    expect(page).toMatchObject({
      count: 100,
      hasMore: true,
      nextBeforeHeight: 26,
    });
    const last = await service.getNoticeChangeTimelinePage({
      noticeNum: 2210001,
      beforeHeight: 26,
      limit: 100,
    });
    expect(last).toMatchObject({
      count: 25,
      hasMore: false,
      nextBeforeHeight: null,
    });
    const empty = await service.getNoticeChangeTimelinePage({
      noticeNum: 2210001,
      beforeHeight: 1,
    });
    expect(empty).toEqual({
      items: [],
      count: 0,
      hasMore: false,
      nextBeforeHeight: null,
    });
    expect(
      await service.getNoticeChangeTimelinePage({ noticeNum: 999999 }),
    ).toEqual(empty);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
    'rejects invalid cursor %s before querying',
    async (beforeHeight) => {
      await expect(
        service.getNoticeChangeTimelinePage({
          noticeNum: 2210001,
          beforeHeight,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('uses the existing notice-height index for an older-page seek', async () => {
    const plan = await dataSource.query(
      'EXPLAIN QUERY PLAN SELECT * FROM notice_change_events WHERE notice_num = ? AND event_height < ? ORDER BY event_height DESC LIMIT 21',
      [2210001, 106],
    );
    expect(plan.map((row) => row.detail).join(' ')).toContain(
      'idx_notice_change_events_notice_num_event_height_unique',
    );
    expect(plan.map((row) => row.detail).join(' ')).not.toContain(
      'TEMP B-TREE',
    );
  });
});
