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
    const validWebhookData = {
      url: 'https://discord.com/api/webhooks/123456789/token123',
    };

    it('should successfully create a new webhook', async () => {
      const mockWebhook = { id: 1, url: validWebhookData.url, isActive: true };

      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.count.mockResolvedValue(10);
      mockRepository.create.mockReturnValue(mockWebhook);
      mockRepository.save.mockResolvedValue(mockWebhook);

      const result = await service.create(validWebhookData);

      expect(result).toEqual(mockWebhook);
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { url: validWebhookData.url },
      });
      expect(mockRepository.count).toHaveBeenCalledWith({
        where: { isActive: true },
      });
      expect(mockRepository.create).toHaveBeenCalledWith({
        url: validWebhookData.url,
      });
    });

    it('should normalize URL', async () => {
      const urlWithTrailingSlash = {
        url: 'https://discord.com/api/webhooks/123456789/token123/',
      };
      const normalizedUrl =
        'https://discord.com/api/webhooks/123456789/token123';

      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.count.mockResolvedValue(10);
      mockRepository.create.mockReturnValue({});
      mockRepository.save.mockResolvedValue({});

      await service.create(urlWithTrailingSlash);

      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { url: normalizedUrl },
      });
      expect(mockRepository.create).toHaveBeenCalledWith({
        url: normalizedUrl,
      });
    });

    it('should remove query parameters', async () => {
      const urlWithQuery = {
        url: 'https://discord.com/api/webhooks/123456789/token123?wait=true',
      };
      const normalizedUrl =
        'https://discord.com/api/webhooks/123456789/token123';

      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.count.mockResolvedValue(10);
      mockRepository.create.mockReturnValue({});
      mockRepository.save.mockResolvedValue({});

      await service.create(urlWithQuery);

      expect(mockRepository.create).toHaveBeenCalledWith({
        url: normalizedUrl,
      });
    });

    it('should throw CONFLICT error for duplicate URL', async () => {
      const existingWebhook = { id: 1, url: validWebhookData.url };
      mockRepository.findOne.mockResolvedValue(existingWebhook);

      await expect(service.create(validWebhookData)).rejects.toThrow(
        HttpException,
      );

      try {
        await service.create(validWebhookData);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(error.getResponse()).toMatchObject({
          success: false,
          message: '이미 등록된 웹훅 URL입니다.',
        });
      }
    });

    it('should throw TOO_MANY_REQUESTS error for webhook limit', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.count.mockResolvedValue(100);

      await expect(service.create(validWebhookData)).rejects.toThrow(
        HttpException,
      );

      try {
        await service.create(validWebhookData);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(error.getResponse()).toMatchObject({
          success: false,
          message: '최대 100개의 웹훅만 등록할 수 있습니다.',
        });
      }
    });

    it('should handle invalid URL format', async () => {
      const invalidUrlData = { url: 'invalid-url' };

      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.count.mockResolvedValue(10);
      mockRepository.create.mockReturnValue({});
      mockRepository.save.mockResolvedValue({});

      await service.create(invalidUrlData);

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
    it('should batch deactivate failed webhooks', async () => {
      const webhookIds = [1, 2, 3];

      await service.removeFailedWebhooks(webhookIds);

      expect(mockRepository.update).toHaveBeenCalledWith(
        { id: In(webhookIds) },
        { isActive: false },
      );
    });

    it('should do nothing for empty array', async () => {
      await service.removeFailedWebhooks([]);

      expect(mockRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should return webhook statistics', async () => {
      mockRepository.count
        .mockResolvedValueOnce(150) // total
        .mockResolvedValueOnce(120); // active

      const result = await service.getStats();

      expect(result).toEqual({
        total: 150,
        active: 120,
        inactive: 30,
      });

      expect(mockRepository.count).toHaveBeenCalledTimes(2);
      expect(mockRepository.count).toHaveBeenNthCalledWith(1);
      expect(mockRepository.count).toHaveBeenNthCalledWith(2, {
        where: { isActive: true },
      });
    });
  });
});
