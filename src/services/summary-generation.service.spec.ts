import { Test, TestingModule } from '@nestjs/testing';
import { SummaryGenerationService } from './summary-generation.service';
import { OllamaClientService } from '../modules/ollama/ollama-client.service';
import { NoticeArchiveService } from './notice-archive.service';
import { CrawlingCoreService } from './crawling-core.service';
import { type ITableData } from 'pal-crawl';

describe('SummaryGenerationService', () => {
  let service: SummaryGenerationService;
  let ollamaClientService: OllamaClientService;
  let crawlingCoreService: CrawlingCoreService;

  const mockNotice: ITableData = {
    num: 1,
    subject: '테스트 입법예고',
    proposerCategory: '정부',
    committee: '법제사법위원회',
    numComments: 5,
    link: '/test/link/1',
    contentId: 'content-1',
    attachments: { pdfFile: '', hwpFile: '' },
  };

  const mockNoticeWithoutContentId: ITableData = {
    num: 2,
    subject: '컨텐츠 ID 없는 입법예고',
    proposerCategory: '의원',
    committee: '국정감사위원회',
    numComments: 3,
    link: '/test/link/2',
    contentId: null,
    attachments: { pdfFile: '', hwpFile: '' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SummaryGenerationService,
        {
          provide: OllamaClientService,
          useValue: {
            isEnabled: jest.fn(),
            summarizeProposal: jest.fn(),
          },
        },
        {
          provide: NoticeArchiveService,
          useValue: {
            getSummaryStateByNoticeNums: jest.fn(),
            updateSummaryStateByNoticeNum: jest.fn(),
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

    service = module.get<SummaryGenerationService>(SummaryGenerationService);
    ollamaClientService = module.get<OllamaClientService>(OllamaClientService);
    crawlingCoreService = module.get<CrawlingCoreService>(CrawlingCoreService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('enrichNoticesWithSummary', () => {
    it('should return notices with cached summaries when available', async () => {
      const existingNotices = new Map([
        [
          1,
          {
            ...mockNotice,
            aiSummary: '캐시된 요약',
            aiSummaryStatus: 'ready' as const,
          },
        ],
      ]);

      const result = await service.enrichNoticesWithSummary(
        [mockNotice],
        existingNotices,
      );

      expect(result).toEqual([
        {
          ...mockNotice,
          aiSummary: '캐시된 요약',
          aiSummaryStatus: 'ready',
        },
      ]);
      expect(ollamaClientService.summarizeProposal).not.toHaveBeenCalled();
    });

    it('should return notices with archived summaries when available', async () => {
      const archiveSummaryStates = new Map([
        [
          1,
          { aiSummary: '아카이브된 요약', aiSummaryStatus: 'ready' as const },
        ],
      ]);

      const result = await service.enrichNoticesWithSummary(
        [mockNotice],
        new Map(),
        archiveSummaryStates,
      );

      expect(result).toEqual([
        {
          ...mockNotice,
          aiSummary: '아카이브된 요약',
          aiSummaryStatus: 'ready',
        },
      ]);
      expect(ollamaClientService.summarizeProposal).not.toHaveBeenCalled();
    });

    it('should generate a new summary when archive state is not_requested', async () => {
      // Simulates a notice archived by executeFullSync without a summary
      const archiveSummaryStates = new Map([
        [1, { aiSummary: null, aiSummaryStatus: 'not_requested' as const }],
      ]);

      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(true);
      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      (ollamaClientService.summarizeProposal as jest.Mock).mockResolvedValue(
        '새로운 요약',
      );

      const result = await service.enrichNoticesWithSummary(
        [mockNotice],
        new Map(),
        archiveSummaryStates,
      );

      expect(result[0].aiSummary).toBe('새로운 요약');
      expect(result[0].aiSummaryStatus).toBe('ready');
      expect(ollamaClientService.summarizeProposal).toHaveBeenCalled();
    });

    it('should retry unavailable archived summaries when option is enabled', async () => {
      const archiveSummaryStates = new Map([
        [1, { aiSummary: null, aiSummaryStatus: 'unavailable' as const }],
      ]);

      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(true);
      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      (ollamaClientService.summarizeProposal as jest.Mock).mockResolvedValue(
        '새로운 요약',
      );

      const result = await service.enrichNoticesWithSummary(
        [mockNotice],
        new Map(),
        archiveSummaryStates,
        { retryUnavailableArchiveSummary: true },
      );

      expect(result).toEqual([
        {
          ...mockNotice,
          aiSummary: '새로운 요약',
          aiSummaryStatus: 'ready',
        },
      ]);
      expect(ollamaClientService.summarizeProposal).toHaveBeenCalledWith(
        'Test Title',
        'Test Proposal Reason',
      );
    });

    it('should generate new summaries when no cache or archive available', async () => {
      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(true);
      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      (ollamaClientService.summarizeProposal as jest.Mock).mockResolvedValue(
        '새로운 요약',
      );

      const result = await service.enrichNoticesWithSummary([mockNotice]);

      expect(result).toEqual([
        {
          ...mockNotice,
          aiSummary: '새로운 요약',
          aiSummaryStatus: 'ready',
        },
      ]);
      expect(ollamaClientService.summarizeProposal).toHaveBeenCalledWith(
        'Test Title',
        'Test Proposal Reason',
      );
    });

    it('should handle empty notices array', async () => {
      const result = await service.enrichNoticesWithSummary([]);

      expect(result).toEqual([]);
    });

    it('should process multiple notices with concurrency', async () => {
      const notices = [mockNotice, mockNoticeWithoutContentId];
      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(true);
      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      (ollamaClientService.summarizeProposal as jest.Mock).mockResolvedValue(
        '요약',
      );

      const result = await service.enrichNoticesWithSummary(notices);

      expect(result).toHaveLength(2);
      expect(result[0].aiSummary).toBe('요약');
      expect(result[1].aiSummary).toBeNull();
      expect(result[1].aiSummaryStatus).toBe('not_supported');
    });
  });

  describe('generateSummaryForNotice', () => {
    it('should return not_requested when AI summary is disabled', async () => {
      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(false);

      const result = await service.generateSummaryForNotice(mockNotice);

      expect(result).toEqual({
        aiSummary: null,
        aiSummaryStatus: 'not_requested',
      });
      expect(crawlingCoreService.getContent).not.toHaveBeenCalled();
    });

    it('should return not_supported when notice has no contentId', async () => {
      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(true);

      const result = await service.generateSummaryForNotice(
        mockNoticeWithoutContentId,
      );

      expect(result).toEqual({
        aiSummary: null,
        aiSummaryStatus: 'not_supported',
      });
      expect(crawlingCoreService.getContent).not.toHaveBeenCalled();
    });

    it('should return not_supported when content has no proposalReason', async () => {
      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(true);
      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: '',
      });

      const result = await service.generateSummaryForNotice(mockNotice);

      expect(result).toEqual({
        aiSummary: null,
        aiSummaryStatus: 'not_supported',
      });
      expect(ollamaClientService.summarizeProposal).not.toHaveBeenCalled();
    });

    it('should return ready status when summary is generated successfully', async () => {
      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(true);
      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      (ollamaClientService.summarizeProposal as jest.Mock).mockResolvedValue(
        '성공적인 요약',
      );

      const result = await service.generateSummaryForNotice(mockNotice);

      expect(result).toEqual({
        aiSummary: '성공적인 요약',
        aiSummaryStatus: 'ready',
      });
      expect(ollamaClientService.summarizeProposal).toHaveBeenCalledWith(
        'Test Title',
        'Test Proposal Reason',
      );
    });

    it('should return unavailable status when summary generation fails', async () => {
      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(true);
      (crawlingCoreService.getContent as jest.Mock).mockRejectedValue(
        new Error('Content fetch failed'),
      );

      const result = await service.generateSummaryForNotice(mockNotice);

      expect(result).toEqual({
        aiSummary: null,
        aiSummaryStatus: 'unavailable',
      });
    });

    it('should return unavailable status when Ollama returns null', async () => {
      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(true);
      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      (ollamaClientService.summarizeProposal as jest.Mock).mockResolvedValue(
        null,
      );

      const result = await service.generateSummaryForNotice(mockNotice);

      expect(result).toEqual({
        aiSummary: null,
        aiSummaryStatus: 'unavailable',
      });
    });
  });
});
