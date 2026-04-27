import { Test, TestingModule } from '@nestjs/testing';
import { CrawlingService } from './crawling.service';
import { CacheService } from './cache.service';
import { NoticeArchiveService } from './notice-archive.service';
import { CrawlingSchedulerService } from './crawling-scheduler.service';
import { HealthCheckService } from './health-check.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { CrawlingCoreService } from './crawling-core.service';

describe('CrawlingService', () => {
  let service: CrawlingService;
  let cacheService: CacheService;
  let noticeArchiveService: NoticeArchiveService;
  let crawlingSchedulerService: CrawlingSchedulerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrawlingService,
        {
          provide: CacheService,
          useValue: {
            getRecentNotices: jest.fn(),
            getCacheInfo: jest.fn(),
          },
        },
        {
          provide: NoticeArchiveService,
          useValue: {
            existsByNoticeNum: jest.fn(),
            getExistingNoticeNumSet: jest.fn(),
            upsertNoticeArchive: jest.fn(),
            getSummaryStateByNoticeNums: jest.fn(),
            updateSummaryStateByNoticeNum: jest.fn(),
            getArchiveStartedAtByNoticeNums: jest.fn(),
          },
        },
        {
          provide: CrawlingSchedulerService,
          useValue: {
            handleCron: jest.fn(),
          },
        },
        {
          provide: HealthCheckService,
          useValue: {
            getApiHealthPayload: jest.fn(),
            getOllamaMetrics: jest.fn(),
          },
        },
        {
          provide: ArchiveOrchestratorService,
          useValue: {
            archiveNotices: jest.fn(),
            filterAlreadyArchivedNotices: jest.fn(),
          },
        },
        {
          provide: CrawlingCoreService,
          useValue: {
            getContent: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CrawlingService>(CrawlingService);
    cacheService = module.get<CacheService>(CacheService);
    noticeArchiveService =
      module.get<NoticeArchiveService>(NoticeArchiveService);
    crawlingSchedulerService = module.get<CrawlingSchedulerService>(
      CrawlingSchedulerService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('handleCron', () => {
    it('should delegate to crawlingSchedulerService.handleCron', async () => {
      const handleCronSpy = jest.spyOn(crawlingSchedulerService, 'handleCron');

      await service.handleCron();

      expect(handleCronSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRecentNotices', () => {
    it('should return cached notices with default limit', async () => {
      const mockNotices = [
        { num: 1, subject: 'Test Notice 1' },
        { num: 2, subject: 'Test Notice 2' },
      ];
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue(
        mockNotices,
      );
      (
        noticeArchiveService.getArchiveStartedAtByNoticeNums as jest.Mock
      ).mockResolvedValue(
        new Map([
          [1, new Date('2024-01-01')],
          [2, new Date('2024-01-02')],
        ]),
      );

      const result = await service.getRecentNotices();

      expect(cacheService.getRecentNotices).toHaveBeenCalledWith(10);
      expect(
        noticeArchiveService.getArchiveStartedAtByNoticeNums,
      ).toHaveBeenCalledWith([1, 2]);
      expect(result).toEqual([
        { num: 2, subject: 'Test Notice 2' },
        { num: 1, subject: 'Test Notice 1' },
      ]);
    });

    it('should return cached notices with custom limit', async () => {
      const mockNotices = [
        { num: 1, subject: 'Test Notice 1' },
        { num: 2, subject: 'Test Notice 2' },
        { num: 3, subject: 'Test Notice 3' },
      ];
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue(
        mockNotices,
      );
      (
        noticeArchiveService.getArchiveStartedAtByNoticeNums as jest.Mock
      ).mockResolvedValue(
        new Map([
          [1, new Date('2024-01-01')],
          [2, new Date('2024-01-02')],
          [3, new Date('2024-01-03')],
        ]),
      );

      const result = await service.getRecentNotices(2);

      expect(cacheService.getRecentNotices).toHaveBeenCalledWith(10);
      expect(
        noticeArchiveService.getArchiveStartedAtByNoticeNums,
      ).toHaveBeenCalledWith([1, 2, 3]);
      expect(result).toEqual([
        { num: 3, subject: 'Test Notice 3' },
        { num: 2, subject: 'Test Notice 2' },
      ]);
    });

    it('should return empty array when no cached notices', async () => {
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue([]);

      const result = await service.getRecentNotices();

      expect(cacheService.getRecentNotices).toHaveBeenCalledWith(10);
      expect(
        noticeArchiveService.getArchiveStartedAtByNoticeNums,
      ).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  describe('getCacheInfo', () => {
    it('should delegate to cacheService.getCacheInfo', async () => {
      const mockCacheInfo = {
        size: 10,
        lastUpdated: new Date(),
        maxSize: 50,
        isInitialized: true,
      };
      (cacheService.getCacheInfo as jest.Mock).mockReturnValue(mockCacheInfo);

      const result = await service.getCacheInfo();

      expect(cacheService.getCacheInfo).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockCacheInfo);
    });
  });

  describe('getNoticeDetail', () => {
    const mockNotice: any = {
      num: 1,
      subject: 'Test Notice',
      proposerCategory: '정부',
      committee: '법제사법위원회',
      link: 'https://example.com/notice/1',
      contentId: 'content-1',
      attachments: { pdfFile: '', hwpFile: '' },
      aiSummary: 'AI 요약',
      aiSummaryStatus: 'ready',
    };

    const mockContent = {
      title: 'Test Title',
      proposalReason: 'Test Proposal Reason',
      billNumber: 'Test Bill Number',
      proposer: 'Test Proposer',
      proposalDate: '2024-01-01',
      committee: 'Test Committee',
      referralDate: '2024-01-02',
      noticePeriod: 'Test Period',
      proposalSession: 'Test Session',
    };

    it('should return notice detail with content', async () => {
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue([
        mockNotice,
      ]);
      (service as any).crawlingCoreService.getContent = jest
        .fn()
        .mockResolvedValue(mockContent);

      const result = await service.getNoticeDetail(1);

      expect(cacheService.getRecentNotices).toHaveBeenCalledWith(10);
      expect(
        (service as any).crawlingCoreService.getContent,
      ).toHaveBeenCalledWith('content-1');
      expect(result).toEqual({
        notice: mockNotice,
        originalContent: {
          contentId: 'content-1',
          title: 'Test Title',
          proposalReason: 'Test Proposal Reason',
          billNumber: 'Test Bill Number',
          proposer: 'Test Proposer',
          proposalDate: '2024-01-01',
          committee: 'Test Committee',
          referralDate: '2024-01-02',
          noticePeriod: 'Test Period',
          proposalSession: 'Test Session',
        },
      });
    });

    it('should throw NotFoundException when notice not found', async () => {
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue([]);

      await expect(service.getNoticeDetail(999)).rejects.toThrow(
        '의안번호 999에 해당하는 입법예고를 찾을 수 없습니다.',
      );
    });

    it('should throw NotFoundException when notice has no contentId', async () => {
      const noticeWithoutContentId = { ...mockNotice, contentId: null };
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue([
        noticeWithoutContentId,
      ]);

      await expect(service.getNoticeDetail(1)).rejects.toThrow(
        '의안번호 1의 원문 정보를 조회할 수 없습니다.',
      );
    });

    it('should throw NotFoundException when content has no proposalReason', async () => {
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue([
        mockNotice,
      ]);
      (service as any).crawlingCoreService.getContent = jest
        .fn()
        .mockResolvedValue({
          ...mockContent,
          proposalReason: '',
        });

      await expect(service.getNoticeDetail(1)).rejects.toThrow(
        '의안번호 1의 제안이유 및 주요내용 원문이 비어 있습니다.',
      );
    });

    it('should throw ServiceUnavailableException on crawling error', async () => {
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue([
        mockNotice,
      ]);
      (service as any).crawlingCoreService.getContent = jest
        .fn()
        .mockRejectedValue(new Error('Network error'));

      await expect(service.getNoticeDetail(1)).rejects.toThrow(
        '원문 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
      );
    });
  });
});
