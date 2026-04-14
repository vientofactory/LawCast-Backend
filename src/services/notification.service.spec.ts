import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { NotificationService } from '../services/notification.service';
import { CacheService } from '../services/cache.service';
import { Webhook } from '../entities/webhook.entity';
import { OllamaClientService } from '../modules/ollama/ollama-client.service';
import { PalCrawl } from 'pal-crawl';
import {
  MessageBuilder,
  Webhook as DiscordWebhook,
} from 'discord-webhook-node';

jest.mock('discord-webhook-node');
jest.mock('pal-crawl');
const MockedDiscordWebhook = DiscordWebhook as jest.MockedClass<
  typeof DiscordWebhook
>;
const MockedMessageBuilder = MessageBuilder as jest.MockedClass<
  typeof MessageBuilder
>;
const MockedPalCrawl = PalCrawl as jest.MockedClass<typeof PalCrawl>;

describe('NotificationService', () => {
  let service: NotificationService;
  let mockDiscordWebhook: jest.Mocked<DiscordWebhook>;
  let mockMessageBuilder: jest.Mocked<MessageBuilder>;
  let mockPalCrawl: { getContent: jest.Mock };
  let mockOllamaClientService: { summarizeProposal: jest.Mock };

  beforeEach(async () => {
    // Jest 타이머 모킹 활성화
    jest.useFakeTimers();

    // MessageBuilder 모킹
    mockMessageBuilder = {
      setTitle: jest.fn().mockReturnThis(),
      setDescription: jest.fn().mockReturnThis(),
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
    mockPalCrawl = {
      getContent: jest.fn(),
    };
    MockedPalCrawl.mockImplementation(() => mockPalCrawl as any);

    mockOllamaClientService = {
      summarizeProposal: jest.fn(),
    };

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
          provide: OllamaClientService,
          useValue: mockOllamaClientService,
        },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);

    // Logger 모킹하여 테스트 출력 정리
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    // 모든 모킹 정리
    jest.clearAllMocks();
    // 모든 pending 타이머 정리
    jest.clearAllTimers();
    // Jest 타이머 모킹 비활성화
    jest.useRealTimers();
  });

  describe('sendDiscordNotification', () => {
    const mockNotice = {
      num: 1,
      subject: '테스트 법률안',
      proposerCategory: '정부',
      committee: '법제사법위원회',
      numComments: 5,
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

      await service.sendDiscordNotification(mockNotice, mockWebhooks);

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

      await service.sendDiscordNotification(mockNotice, mockWebhooks);

      expect(mockDiscordWebhook.send).toHaveBeenCalledTimes(2);
    });

    it('should create correct embed message', async () => {
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      await service.sendDiscordNotification(mockNotice, [mockWebhooks[0]]);

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
    });

    it('should summarize hardcoded full proposal content and include it in embed', async () => {
      const hardcodedContent = {
        title: '[2218288] 조세특례제한법 일부개정법률안(윤한홍의원 등 10인)',
        proposalReason:
          '소형모듈원자로(SMR)는 글로벌 에너지 전환과 미래 전력수요 증가에 대응할 핵심 저탄소 기술로 부상하고 있고, 우리나라는 「소형모듈원자로 개발 촉진 및 지원에 관한 특별법」 제정 등 연구개발, 실증, 특구 조성 등 제도적 기반을 마련하여 국가 차원의 전략적 육성을 추진 중임. 그러나 소형모듈원자로 산업의 상용화와 수출 경쟁력 확보를 위해 필수적인 제조 공급망의 설비투자와 전문기술 확보를 뒷받침할 세제 지원 체계는 아직 충분히 구축되지 못한 상황임. 현재 소형모듈원자로 관련 핵심 기술은 국가전략기술로 규정되어 있지 않아, 시설투자 및 연구ㆍ인력개발에 적용되는 세액공제율이 중소ㆍ중견기업의 선제적 투자 결정을 이끌기에는 제한적이고, 특히 소형모듈원자로 산업은 높은 초기 설비투자와 국제적 인증 충족이 필수임에도 수주가 확정되기 전까지 기업이 자체적으로 감당해야 하는 위험이 크기 때문에 공급망 내 기업들의 투자가 지연되는 구조적 문제가 지속되고 있음. 이에 국가전략기술의 범위에 소형모듈원자로를 추가해 세액공제율을 실질적으로 확대함으로써 수요 불확실성 하에서도 설비 확충ㆍ기술 고도화ㆍ전문인력 확보가 가능한 환경을 조성하여 글로벌 시장에서의 경쟁력을 강화하는 한편, 국가전략기술의 사업화시설 투자비용에 대한 세액공제의 일몰기한을 삭제하려는 것임(안 제10조제1항제2호 및 제24조제1항제2호).',
      };
      const summarized =
        'SMR를 국가전략기술에 포함해 세액공제 지원을 확대하고, 사업화시설 투자 세액공제 일몰기한을 삭제해 공급망 설비투자와 기술·인력 확보를 촉진하려는 내용입니다.';

      mockPalCrawl.getContent.mockResolvedValue(hardcodedContent);
      mockOllamaClientService.summarizeProposal.mockResolvedValue(summarized);
      mockDiscordWebhook.send.mockResolvedValue(undefined);

      await service.sendDiscordNotification(
        {
          num: 1,
          subject: '테스트 법률안',
          proposerCategory: '정부',
          committee: '법제사법위원회',
          numComments: 5,
          link: 'https://example.com/notice/1',
          contentId: 'PRC_W2W6V0D4D0B9C1B4B4Z6V2W0U7V2T9',
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

      expect(mockPalCrawl.getContent).toHaveBeenCalledWith(
        'PRC_W2W6V0D4D0B9C1B4B4Z6V2W0U7V2T9',
      );
      expect(mockOllamaClientService.summarizeProposal).toHaveBeenCalledWith(
        hardcodedContent.title,
        hardcodedContent.proposalReason,
      );
      expect(mockMessageBuilder.addField).toHaveBeenCalledWith(
        '제안이유·주요내용 핵심',
        summarized,
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
      numComments: 5,
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
});
