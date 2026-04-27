import { Test, TestingModule } from '@nestjs/testing';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { NoticeArchiveService } from './notice-archive.service';
import { CrawlingCoreService } from './crawling-core.service';
import { type CachedNotice } from '../types/cache.types';

// fetch를 모킹
declare const global: any;
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('ArchiveOrchestratorService', () => {
  let service: ArchiveOrchestratorService;
  let noticeArchiveService: NoticeArchiveService;
  let crawlingCoreService: CrawlingCoreService;

  const mockNotice: CachedNotice = {
    num: 1,
    subject: '테스트 입법예고',
    proposerCategory: '정부',
    committee: '법제사법위원회',
    link: 'https://example.com/notice/1',
    contentId: 'content-1',
    attachments: { pdfFile: '', hwpFile: '' },
    aiSummary: 'AI 요약',
    aiSummaryStatus: 'ready',
  };

  const mockNoticeWithoutContentId: CachedNotice = {
    num: 2,
    subject: '컨텐츠 ID 없는 입법예고',
    proposerCategory: '의원',
    committee: '국정감사위원회',
    link: 'https://example.com/notice/2',
    contentId: null,
    attachments: { pdfFile: '', hwpFile: '' },
    aiSummary: null,
    aiSummaryStatus: 'not_supported',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArchiveOrchestratorService,
        {
          provide: NoticeArchiveService,
          useValue: {
            upsertNoticeArchive: jest.fn(),
            getExistingNoticeNumSet: jest.fn(),
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

    service = module.get<ArchiveOrchestratorService>(
      ArchiveOrchestratorService,
    );
    noticeArchiveService =
      module.get<NoticeArchiveService>(NoticeArchiveService);
    crawlingCoreService = module.get<CrawlingCoreService>(CrawlingCoreService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('archiveNotices', () => {
    it('should return early for empty notices array', async () => {
      await service.archiveNotices([]);

      expect(noticeArchiveService.upsertNoticeArchive).not.toHaveBeenCalled();
      expect(crawlingCoreService.getContent).not.toHaveBeenCalled();
    });

    it('should archive notices with contentId successfully', async () => {
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

      const mockResponse = {
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/1',
        status: 200,
        headers: {
          get: jest.fn((header: string) => {
            const headers: Record<string, string> = {
              'content-type': 'text/html',
              etag: 'test-etag',
              'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
            };
            return headers[header] || null;
          }),
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue(
        mockContent,
      );
      mockFetch.mockResolvedValue(mockResponse);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNotice]);

      expect(crawlingCoreService.getContent).toHaveBeenCalledWith('content-1');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/notice/1', {
        method: 'GET',
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; Lawcast/1.0)',
        },
        redirect: 'follow',
      });
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledWith(
        mockNotice,
        expect.objectContaining({
          proposalReason: 'Test Proposal Reason',
          title: 'Test Title',
          billNumber: 'Test Bill Number',
          proposer: 'Test Proposer',
          proposalDate: '2024-01-01',
          committee: 'Test Committee',
          referralDate: '2024-01-02',
          noticePeriod: 'Test Period',
          proposalSession: 'Test Session',
          sourceHtml: '<html>Test HTML</html>',
          htmlSha256: expect.any(String),
          archivedAt: expect.any(Date),
          httpMetadata: expect.objectContaining({
            requestUrl: 'https://example.com/notice/1',
            responseUrl: 'https://example.com/notice/1',
            statusCode: 200,
            contentType: 'text/html',
            etag: 'test-etag',
            lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
          }),
        }),
      );
    });

    it('should archive notices without contentId', async () => {
      const mockResponse = {
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/2',
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
      };

      mockFetch.mockResolvedValue(mockResponse);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNoticeWithoutContentId]);

      expect(crawlingCoreService.getContent).not.toHaveBeenCalled();
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledWith(
        mockNoticeWithoutContentId,
        expect.objectContaining({
          proposalReason: '',
          title: '컨텐츠 ID 없는 입법예고',
          billNumber: null,
          proposer: null,
          proposalDate: null,
          committee: null,
          referralDate: null,
          noticePeriod: null,
          proposalSession: null,
          sourceHtml: '<html>Test HTML</html>',
          htmlSha256: expect.any(String),
          archivedAt: expect.any(Date),
          httpMetadata: expect.objectContaining({
            requestUrl: 'https://example.com/notice/2',
            responseUrl: 'https://example.com/notice/2',
            statusCode: 200,
          }),
        }),
      );
    });

    it('should handle content fetch errors gracefully', async () => {
      const mockResponse = {
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/1',
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockRejectedValue(
        new Error('Content fetch failed'),
      );
      mockFetch.mockResolvedValue(mockResponse);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNotice]);

      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledWith(
        mockNotice,
        expect.objectContaining({
          proposalReason: '',
          title: '테스트 입법예고',
        }),
      );
    });

    it('should handle HTML capture errors gracefully', async () => {
      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetch.mockRejectedValue(new Error('HTML capture failed'));
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNotice]);

      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledWith(
        mockNotice,
        expect.objectContaining({
          proposalReason: 'Test Proposal Reason',
          title: 'Test Title',
          sourceHtml: null,
          htmlSha256: null,
          httpMetadata: null,
        }),
      );
    });

    it('should handle archive upsert errors gracefully', async () => {
      const mockResponse = {
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/1',
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetch.mockResolvedValue(mockResponse);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockRejectedValue(
        new Error('Archive failed'),
      );

      await service.archiveNotices([mockNotice]);

      // Should not throw, just log the error
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalled();
    });

    it('should process notices in chunks with concurrency limit', async () => {
      const notices = Array.from({ length: 12 }, (_, i) => ({
        ...mockNotice,
        num: i + 1,
        link: `https://example.com/notice/${i + 1}`,
        contentId: `content-${i + 1}`,
      }));

      const mockResponse = {
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/1',
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetch.mockResolvedValue(mockResponse);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices(notices);

      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledTimes(
        12,
      );
    });
  });

  describe('filterAlreadyArchivedNotices', () => {
    it('should return empty array for empty input', async () => {
      const result = await service.filterAlreadyArchivedNotices([]);

      expect(result).toEqual([]);
      expect(
        noticeArchiveService.getExistingNoticeNumSet,
      ).not.toHaveBeenCalled();
    });

    it('should filter out already archived notices', async () => {
      const notices = [
        { num: 1, subject: 'Notice 1' },
        { num: 2, subject: 'Notice 2' },
        { num: 3, subject: 'Notice 3' },
      ];

      (
        noticeArchiveService.getExistingNoticeNumSet as jest.Mock
      ).mockResolvedValue(new Set([1, 3]));

      const result = await service.filterAlreadyArchivedNotices(notices);

      expect(noticeArchiveService.getExistingNoticeNumSet).toHaveBeenCalledWith(
        [1, 2, 3],
      );
      expect(result).toEqual([{ num: 2, subject: 'Notice 2' }]);
    });

    it('should return all notices when none are archived', async () => {
      const notices = [
        { num: 1, subject: 'Notice 1' },
        { num: 2, subject: 'Notice 2' },
      ];

      (
        noticeArchiveService.getExistingNoticeNumSet as jest.Mock
      ).mockResolvedValue(new Set());

      const result = await service.filterAlreadyArchivedNotices(notices);

      expect(result).toEqual(notices);
    });

    it('should return empty array when all notices are archived', async () => {
      const notices = [
        { num: 1, subject: 'Notice 1' },
        { num: 2, subject: 'Notice 2' },
      ];

      (
        noticeArchiveService.getExistingNoticeNumSet as jest.Mock
      ).mockResolvedValue(new Set([1, 2]));

      const result = await service.filterAlreadyArchivedNotices(notices);

      expect(result).toEqual([]);
    });
  });
});
