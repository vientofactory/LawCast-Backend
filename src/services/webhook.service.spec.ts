import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { HttpException, HttpStatus } from '@nestjs/common';
import { WebhookService } from '../services/webhook.service';
import { Webhook } from '../entities/webhook.entity';

describe('WebhookService', () => {
  let service: WebhookService;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        {
          provide: getRepositoryToken(Webhook),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    const validWebhookUrl =
      'https://discord.com/api/webhooks/123456789/token123';
    it('should successfully create a new webhook', async () => {
      const mockWebhook = { id: 1, url: validWebhookUrl, isActive: true };

      mockRepository.create.mockReturnValue(mockWebhook);
      mockRepository.save.mockResolvedValue(mockWebhook);

      const result = await service.create(validWebhookUrl);

      expect(result).toEqual(mockWebhook);
      expect(mockRepository.create).toHaveBeenCalledWith({
        url: validWebhookUrl,
      });
    });

    it('should normalize URL', async () => {
      const urlWithTrailingSlash =
        'https://discord.com/api/webhooks/123456789/token123/';
      const normalizedUrl =
        'https://discord.com/api/webhooks/123456789/token123';

      mockRepository.create.mockReturnValue({});
      mockRepository.save.mockResolvedValue({});

      await service.create(urlWithTrailingSlash);

      expect(mockRepository.create).toHaveBeenCalledWith({
        url: normalizedUrl,
      });
    });

    it('should remove query parameters', async () => {
      const urlWithQuery =
        'https://discord.com/api/webhooks/123456789/token123?wait=true';
      const normalizedUrl =
        'https://discord.com/api/webhooks/123456789/token123';

      mockRepository.create.mockReturnValue({});
      mockRepository.save.mockResolvedValue({});

      await service.create(urlWithQuery);

      expect(mockRepository.create).toHaveBeenCalledWith({
        url: normalizedUrl,
      });
    });

    it('should handle invalid URL format', async () => {
      const invalidUrl = 'invalid-url';

      mockRepository.create.mockReturnValue({});
      mockRepository.save.mockResolvedValue({});

      await service.create(invalidUrl);

      // 파싱 실패 시 원본 URL이 사용되어야 함
      expect(mockRepository.create).toHaveBeenCalledWith({
        url: 'invalid-url',
      });
    });
  });

  describe('findAll', () => {
    it('should return active webhooks', async () => {
      const mockWebhooks = [
        {
          id: 1,
          url: 'https://discord.com/api/webhooks/1/token1',
          isActive: true,
        },
        {
          id: 2,
          url: 'https://discord.com/api/webhooks/2/token2',
          isActive: true,
        },
      ];

      mockRepository.find.mockResolvedValue(mockWebhooks);

      const result = await service.findAll();

      expect(result).toEqual(mockWebhooks);
      expect(mockRepository.find).toHaveBeenCalledWith({
        where: { isActive: true },
      });
    });
  });

  describe('findOne', () => {
    it('should find webhook by ID', async () => {
      const mockWebhook = {
        id: 1,
        url: 'https://discord.com/api/webhooks/1/token1',
        isActive: true,
      };

      mockRepository.findOne.mockResolvedValue(mockWebhook);

      const result = await service.findOne(1);

      expect(result).toEqual(mockWebhook);
      expect(mockRepository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('should throw NOT_FOUND error for non-existent webhook', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(999)).rejects.toThrow(HttpException);

      try {
        await service.findOne(999);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      }
    });
  });

  describe('findByUrl', () => {
    it('should find webhook by URL', async () => {
      const mockWebhook = {
        id: 1,
        url: 'https://discord.com/api/webhooks/123/token',
        isActive: true,
      };

      mockRepository.findOne.mockResolvedValue(mockWebhook);

      const result = await service.findByUrl(
        'https://discord.com/api/webhooks/123/token',
      );

      expect(result).toEqual(mockWebhook);
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: {
          url: 'https://discord.com/api/webhooks/123/token',
          isActive: true,
        },
      });
    });

    it('should normalize URL before searching', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await service.findByUrl('https://discord.com/api/webhooks/123/token/');

      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: {
          url: 'https://discord.com/api/webhooks/123/token',
          isActive: true,
        },
      });
    });

    it('should return null when webhook not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      const result = await service.findByUrl(
        'https://discord.com/api/webhooks/nonexistent/token',
      );

      expect(result).toBeNull();
    });
  });

  describe('remove', () => {
    it('should deactivate webhook', async () => {
      const mockWebhook = {
        id: 1,
        url: 'https://discord.com/api/webhooks/1/token1',
        isActive: true,
      };

      mockRepository.findOne.mockResolvedValue(mockWebhook);
      mockRepository.save.mockResolvedValue({
        ...mockWebhook,
        isActive: false,
      });

      await service.remove(1);

      expect(mockWebhook.isActive).toBe(false);
      expect(mockRepository.save).toHaveBeenCalledWith(mockWebhook);
    });
  });

  describe('removeFailedWebhooks', () => {
    it('should permanently delete failed webhooks', async () => {
      const webhookIds = [1, 2, 3];
      const mockDeleteResult = { affected: 3 };
      mockRepository.delete.mockResolvedValue(mockDeleteResult);

      const result = await service.removeFailedWebhooks(webhookIds);

      expect(result).toBe(3);
      expect(mockRepository.delete).toHaveBeenCalledWith({
        id: In(webhookIds),
      });
    });

    it('should do nothing for empty array', async () => {
      await service.removeFailedWebhooks([]);

      expect(mockRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('deletePermanently', () => {});

  describe('cleanupInactiveWebhooks', () => {
    it('should delete all inactive webhooks', async () => {
      mockRepository.delete.mockResolvedValue({ affected: 5 });

      const result = await service.cleanupInactiveWebhooks();

      expect(result).toBe(5);
      expect(mockRepository.delete).toHaveBeenCalledWith({ isActive: false });
    });

    it('should return 0 when no webhooks are deleted', async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });

      const result = await service.cleanupInactiveWebhooks();

      expect(result).toBe(0);
    });
  });

  // getDetailedStats는 복잡한 SQL 쿼리를 사용하므로 통합 테스트에서 검증
});
