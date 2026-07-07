import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { NotificationService } from './notification.service';
import { NoticeChangeSource } from '../change-tracking/notice-change-source.enum';
import { CacheService } from '../cache/cache.service';
import { LoggerUtils } from '../../utils/logger.utils';
import { Webhook } from '../webhook/webhook.entity';
import {
  MessageBuilder,
  Webhook as DiscordWebhook,
} from 'discord-webhook-node';

jest.mock('discord-webhook-node');
const MockedDiscordWebhook = DiscordWebhook as jest.MockedClass<
  typeof DiscordWebhook
>;
const MockedMessageBuilder = MessageBuilder as jest.MockedClass<
  typeof MessageBuilder
>;

describe('NotificationService', () => {
  let service: NotificationService;
  let mockDiscordWebhook: jest.Mocked<DiscordWebhook>;
  let mockMessageBuilder: jest.Mocked<MessageBuilder>;

  beforeEach(async () => {
    // MessageBuilder 모킹
    mockMessageBuilder = {
      setTitle: jest.fn().mockReturnThis(),
      setDescription: jest.fn().mockReturnThis(),
      setAuthor: jest.fn().mockReturnThis(),
      addField: jest.fn().mockReturnThis(),
      setColor: jest.fn().mockReturnThis(),
      setTimestamp: jest.fn().mockReturnThis(),
      setFooter: jest.fn().mockReturnThis(),
    } as any;

    // DiscordWebhook 모킹
    mockDiscordWebhook = {
      setUsername: jest.fn(),
      send: jest.fn(),
    } as any;

    MockedMessageBuilder.mockImplementation(() => mockMessageBuilder);
    MockedDiscordWebhook.mockImplementation(() => mockDiscordWebhook);

    jest.spyOn(LoggerUtils, 'getContextLogger').mockReturnValue({
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        CacheService,
        {
          provide: CACHE_MANAGER,
          useValue: {
            set: jest.fn(),
            get: jest.fn(),
            del: jest.fn(),
            reset: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'frontend.urls') {
                return ['http://localhost:5173'];
              }
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
  });

  afterEach(() => {
    // 모든 모킹 정리
    jest.clearAllMocks();
  });

  describe('sendDiscordNotificationBatch', () => {
    const mockNotice = {
      num: 1,
      subject: '테스트 법률안',
      proposerCategory: '정부',
      committee: '법제사법위원회',
      link: 'https://example.com/notice/1',
      contentId: null,
      attachments: { pdfFile: '', hwpFile: '' },
    };

    const mockWebhooks: Webhook[] = [
      {
        id: 1,
        url: 'https://discord.com/api/webhooks/1/token1',
        isActive: true,
      } as Webhook,
      {
        id: 2,
        url: 'https://discord.com/api/webhooks/2/token2',
        isActive: true,
      } as Webhook,
    ];

    it('should successfully send notifications to all webhooks', async () => {
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      await service.sendDiscordNotificationBatch(mockNotice, mockWebhooks);

      expect(MockedDiscordWebhook).toHaveBeenCalledTimes(2);
      expect(mockDiscordWebhook.setUsername).toHaveBeenCalledWith(
        'LawCast 알리미',
      );
      expect(mockDiscordWebhook.send).toHaveBeenCalledTimes(2);
    });

    it('should handle webhook sending failures', async () => {
      mockDiscordWebhook.send
        .mockResolvedValueOnce(undefined) // 첫 번째 성공
        .mockRejectedValueOnce(new Error('Network error')); // 두 번째 실패

      await service.sendDiscordNotificationBatch(mockNotice, mockWebhooks);

      expect(mockDiscordWebhook.send).toHaveBeenCalledTimes(2);
    });

    it('should create correct embed message', async () => {
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      await service.sendDiscordNotificationBatch(mockNotice, [mockWebhooks[0]]);

      expect(mockMessageBuilder.setTitle).toHaveBeenCalledWith(
        '새로운 국회 입법예고',
      );
      expect(mockMessageBuilder.addField).toHaveBeenCalledWith(
        '법률안명',
        '테스트 법률안',
        false,
      );
      expect(mockMessageBuilder.addField).toHaveBeenCalledWith(
        '제안자 구분',
        '정부',
        true,
      );
      expect(mockMessageBuilder.setColor).toHaveBeenCalledWith(0x3b82f6);
      expect(mockMessageBuilder.addField).toHaveBeenCalledWith(
        '자세히 보기',
        '[입법예고 전문](http://localhost:5173/notices/1)',
        false,
      );
    });

    it('should include precomputed aiSummary when provided', async () => {
      const summarized = '핵심 정책 변화와 영향 중심의 사전 생성 요약입니다.';
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      await service.sendDiscordNotificationBatch(
        {
          num: 1,
          subject: '테스트 법률안',
          proposerCategory: '정부',
          committee: '법제사법위원회',
          link: 'https://example.com/notice/1',
          contentId: 'PRC_TEST_CONTENT_ID',
          aiSummary: summarized,
          attachments: { pdfFile: '', hwpFile: '' },
        },
        [
          {
            id: 1,
            url: 'https://discord.com/api/webhooks/1/token1',
            isActive: true,
          } as Webhook,
        ],
      );

      expect(mockMessageBuilder.addField).toHaveBeenCalledWith(
        '핵심 내용 AI 요약',
        summarized,
        false,
      );
    });

    it('should skip summary field when aiSummary is not precomputed', async () => {
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      await service.sendDiscordNotificationBatch(
        {
          num: 1,
          subject: '요약 미생성 법률안',
          proposerCategory: '정부',
          committee: '법제사법위원회',
          link: 'https://example.com/notice/1',
          contentId: 'PRC_TEST_CONTENT_ID',
          attachments: { pdfFile: '', hwpFile: '' },
        },
        [
          {
            id: 1,
            url: 'https://discord.com/api/webhooks/1/token1',
            isActive: true,
          } as Webhook,
        ],
      );

      expect(mockMessageBuilder.addField).not.toHaveBeenCalledWith(
        '핵심 내용 AI 요약',
        expect.any(String),
        false,
      );
    });

    it('should include guidance field when proposalReason is missing for NSM notice', async () => {
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      await service.sendDiscordNotificationBatch(
        {
          num: 1,
          subject: '제안이유 누락 법률안',
          proposerCategory: '정부',
          committee: '법제사법위원회',
          link: 'https://example.com/notice/1',
          contentId: null,
          proposalReason: null,
          aiSummary: null,
          aiSummaryStatus: 'not_supported',
          attachments: { pdfFile: '', hwpFile: '' },
        },
        [
          {
            id: 1,
            url: 'https://discord.com/api/webhooks/1/token1',
            isActive: true,
          } as Webhook,
        ],
      );

      expect(mockMessageBuilder.addField).toHaveBeenCalledWith(
        '안내',
        '법률안 제안이유를 아직 수집하지 못했습니다. 자세히 보기 링크를 통해 국회 페이지에서 직접 확인해 주세요.',
        false,
      );
    });
  });

  describe('sendDiscordNotificationBatch', () => {
    const mockNotice = {
      num: 1,
      subject: '테스트 법률안',
      proposerCategory: '정부',
      committee: '법제사법위원회',
      link: 'https://example.com/notice/1',
      contentId: null,
      attachments: { pdfFile: '', hwpFile: '' },
    };

    const mockWebhooks: Webhook[] = [
      {
        id: 1,
        url: 'https://discord.com/api/webhooks/1/token1',
        isActive: true,
      } as Webhook,
      {
        id: 2,
        url: 'https://discord.com/api/webhooks/2/token2',
        isActive: true,
      } as Webhook,
    ];

    it('should successfully send notifications to all webhooks in parallel', async () => {
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      const results = await service.sendDiscordNotificationBatch(
        mockNotice,
        mockWebhooks,
      );

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ webhookId: 1, success: true });
      expect(results[1]).toEqual({ webhookId: 2, success: true });
    });

    it('should return appropriate results for failed webhooks', async () => {
      const error = { response: { status: 404 } };
      mockDiscordWebhook.send
        .mockResolvedValueOnce(undefined) // 첫 번째 성공
        .mockRejectedValueOnce(error); // 두 번째 실패 (404 - 삭제 대상)

      const results = await service.sendDiscordNotificationBatch(
        mockNotice,
        mockWebhooks,
      );

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ webhookId: 1, success: true });
      expect(results[1]).toMatchObject({
        webhookId: 2,
        success: false,
        shouldDelete: true,
        error,
      });
    });

    it('should not delete webhooks for temporary errors', async () => {
      const networkError = new Error('Network timeout');
      mockDiscordWebhook.send.mockRejectedValue(networkError);

      const results = await service.sendDiscordNotificationBatch(mockNotice, [
        mockWebhooks[0],
      ]);

      expect(results[0]).toMatchObject({
        webhookId: 1,
        success: false,
        shouldDelete: false,
        error: networkError,
      });
    });
  });

  describe('testWebhook', () => {
    const testWebhookUrl = 'https://discord.com/api/webhooks/1/token1';

    it('should handle successful test webhook', async () => {
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      const result = await service.testWebhook(testWebhookUrl);

      expect(result).toEqual({ success: true, shouldDelete: false });
      expect(mockDiscordWebhook.setUsername).toHaveBeenCalledWith(
        'LawCast 알리미',
      );
      expect(mockMessageBuilder.setTitle).toHaveBeenCalledWith(
        'LawCast 웹훅 테스트',
      );
      expect(mockMessageBuilder.setColor).toHaveBeenCalledWith(0x10b981);
    });

    it('should handle failed test webhook', async () => {
      const error = { response: { status: 401 } };
      mockDiscordWebhook.send.mockRejectedValue(error);

      const result = await service.testWebhook(testWebhookUrl);

      expect(result).toEqual({
        success: false,
        shouldDelete: true,
        error,
        errorType: 'UNAUTHORIZED',
      });
    });

    it('should not delete webhooks for network errors', async () => {
      const networkError = new Error('Connection timeout');
      mockDiscordWebhook.send.mockRejectedValue(networkError);

      const result = await service.testWebhook(testWebhookUrl);

      expect(result).toEqual({
        success: false,
        shouldDelete: false,
        error: networkError,
        errorType: 'UNKNOWN_ERROR',
      });
    });
  });

  describe('shouldDeleteWebhook (private method behavior)', () => {
    it('should request deletion for 404, 401, 403 errors', async () => {
      const errors = [
        { response: { status: 404 } }, // Not found
        { response: { status: 401 } }, // Unauthorized
        { response: { status: 403 } }, // Forbidden
      ];

      for (const error of errors) {
        mockDiscordWebhook.send.mockRejectedValueOnce(error);
        const result = await service.testWebhook(
          'https://discord.com/api/webhooks/1/token1',
        );
        expect(result.shouldDelete).toBe(true);
      }
    });

    it('should not request deletion for other HTTP errors', async () => {
      const errors = [
        { response: { status: 500 } }, // Server error
        { response: { status: 429 } }, // Rate limit
        new Error('Network error'), // Network error
      ];

      for (const error of errors) {
        mockDiscordWebhook.send.mockRejectedValueOnce(error);
        const result = await service.testWebhook(
          'https://discord.com/api/webhooks/1/token1',
        );
        expect(result.shouldDelete).toBe(false);
      }
    });
  });

  describe('sendDiscordChangeNotificationBatch', () => {
    const mockWebhooks: Webhook[] = [
      {
        id: 10,
        url: 'https://discord.com/api/webhooks/10/token10',
        isActive: true,
      } as Webhook,
    ];

    it('should render changed fields with Korean labels in embed', async () => {
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      await service.sendDiscordChangeNotificationBatch(
        {
          noticeNum: 2210001,
          subject: '변경 추적 테스트 법률안',
          eventType: 'updated',
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          changedFields: ['subject', 'billNumber', 'unknown.field'],
          eventHash: 'hash-test-1',
          eventHeight: 5,
        },
        mockWebhooks,
      );

      expect(mockMessageBuilder.addField).toHaveBeenCalledWith(
        '변경 필드',
        '법률안명, 입법예고 의안번호, 기타(unknown.field)',
        true,
      );

      const detailFieldCall = (
        mockMessageBuilder.addField as jest.Mock
      ).mock.calls.find((call) => call[0] === '자세히 보기');

      expect(detailFieldCall).toBeDefined();
      expect(detailFieldCall?.[2]).toBe(false);
      expect(detailFieldCall?.[1]).toContain(
        'http://localhost:5173/notices/2210001',
      );
      expect(detailFieldCall?.[1]).toContain('cmpFrom=4');
      expect(detailFieldCall?.[1]).toContain('cmpTo=5');
    });
  });

  describe('sendDiscordChangeDigestNotificationBatch', () => {
    const mockWebhooks: Webhook[] = [
      {
        id: 11,
        url: 'https://discord.com/api/webhooks/11/token11',
        isActive: true,
      } as Webhook,
    ];

    it('should send one digest embed when multiple changes are provided', async () => {
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      const results = await service.sendDiscordChangeDigestNotificationBatch(
        [
          {
            noticeNum: 3310001,
            subject: '법률안 A',
            eventType: 'updated',
            source: NoticeChangeSource.ARCHIVE_UPSERT,
            changedFields: ['subject', 'committee'],
            eventHash: 'hash-a',
            eventHeight: 2,
            eventId: 101,
            detectedAt: '2026-07-08T09:00:00.000Z',
          },
          {
            noticeNum: 3310002,
            subject: '법률안 B',
            eventType: 'updated',
            source: NoticeChangeSource.ARCHIVE_UPSERT,
            changedFields: ['proposalReason'],
            eventHash: 'hash-b',
            eventHeight: 3,
            eventId: 104,
            detectedAt: '2026-07-08T09:00:10.000Z',
          },
        ],
        mockWebhooks,
      );

      expect(mockMessageBuilder.setTitle).toHaveBeenCalledWith(
        '입법예고 변경 감지 (2건)',
      );
      expect(mockMessageBuilder.addField).toHaveBeenCalledWith(
        '변경 건수',
        '2',
        true,
      );

      const digestLinkFieldCall = (
        mockMessageBuilder.addField as jest.Mock
      ).mock.calls.find((call) => call[0] === '모아보기 이동');

      expect(digestLinkFieldCall).toBeDefined();
      expect(digestLinkFieldCall?.[1]).toContain('/notices/changes?');
      expect(digestLinkFieldCall?.[1]).toContain('fromEventId=101');
      expect(digestLinkFieldCall?.[1]).toContain('toEventId=104');
      expect(digestLinkFieldCall?.[1]).toContain('digest=1');
      expect(digestLinkFieldCall?.[1]).toContain('jumpToFirst=1');
      expect(mockDiscordWebhook.send).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ webhookId: 11, success: true });
    });
  });
});
