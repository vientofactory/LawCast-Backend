import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckService } from './health-check.service';
import { CacheService } from './cache.service';
import { OllamaClientService } from '../modules/ollama/ollama-client.service';

describe('HealthCheckService', () => {
  let service: HealthCheckService;
  let cacheService: CacheService;
  let ollamaClientService: OllamaClientService;

  const mockCacheInfo = {
    size: 10,
    lastUpdated: new Date(),
    maxSize: 50,
    isInitialized: true,
  };

  const mockOllamaMetrics = {
    enabled: true,
    health: {
      status: 'healthy',
      responseTime: 150,
      lastChecked: new Date().toISOString(),
    },
    model: 'llama2',
    usage: {
      totalRequests: 100,
      successfulRequests: 95,
      failedRequests: 5,
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthCheckService,
        {
          provide: CacheService,
          useValue: {
            isRedisConnected: jest.fn(),
            getCacheInfo: jest.fn(),
            getRedisStatus: jest.fn(),
          },
        },
        {
          provide: OllamaClientService,
          useValue: {
            getMetrics: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<HealthCheckService>(HealthCheckService);
    cacheService = module.get<CacheService>(CacheService);
    ollamaClientService = module.get<OllamaClientService>(OllamaClientService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Reset cache between tests
    (service as any).ollamaMetricsCache = null;
    (service as any).ollamaMetricsCacheAt = null;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getApiHealthPayload', () => {
    it('should return healthy status for development environment', async () => {
      (cacheService.isRedisConnected as jest.Mock).mockResolvedValue(true);
      (cacheService.getCacheInfo as jest.Mock).mockResolvedValue(mockCacheInfo);
      (ollamaClientService.getMetrics as jest.Mock).mockResolvedValue(
        mockOllamaMetrics,
      );

      const result = await service.getApiHealthPayload({
        nodeEnv: 'development',
      });

      expect(result).toEqual({
        timestamp: expect.any(String),
        status: 'healthy',
        redis: {
          connected: true,
          cache: mockCacheInfo,
        },
        ollama: mockOllamaMetrics,
      });
      expect(cacheService.isRedisConnected).toHaveBeenCalled();
      expect(cacheService.getCacheInfo).toHaveBeenCalled();
      expect(ollamaClientService.getMetrics).toHaveBeenCalledWith({});
    });

    it('should return degraded status when Redis is disconnected', async () => {
      (cacheService.isRedisConnected as jest.Mock).mockResolvedValue(false);
      (cacheService.getCacheInfo as jest.Mock).mockResolvedValue(mockCacheInfo);
      (ollamaClientService.getMetrics as jest.Mock).mockResolvedValue(
        mockOllamaMetrics,
      );

      const result = await service.getApiHealthPayload({
        nodeEnv: 'development',
      });

      expect(result.status).toBe('degraded');
      expect(result.redis.connected).toBe(false);
    });

    it('should return degraded status when Ollama is unhealthy', async () => {
      const unhealthyOllamaMetrics = {
        ...mockOllamaMetrics,
        health: { ...mockOllamaMetrics.health, status: 'unhealthy' },
      };

      (cacheService.isRedisConnected as jest.Mock).mockResolvedValue(true);
      (cacheService.getCacheInfo as jest.Mock).mockResolvedValue(mockCacheInfo);
      (ollamaClientService.getMetrics as jest.Mock).mockResolvedValue(
        unhealthyOllamaMetrics,
      );

      const result = await service.getApiHealthPayload({
        nodeEnv: 'development',
      });

      expect(result.status).toBe('degraded');
      expect(result.ollama.health.status).toBe('unhealthy');
    });

    it('should return degraded status when Ollama is misconfigured', async () => {
      const misconfiguredOllamaMetrics = {
        ...mockOllamaMetrics,
        health: { ...mockOllamaMetrics.health, status: 'misconfigured' },
      };

      (cacheService.isRedisConnected as jest.Mock).mockResolvedValue(true);
      (cacheService.getCacheInfo as jest.Mock).mockResolvedValue(mockCacheInfo);
      (ollamaClientService.getMetrics as jest.Mock).mockResolvedValue(
        misconfiguredOllamaMetrics,
      );

      const result = await service.getApiHealthPayload({
        nodeEnv: 'development',
      });

      expect(result.status).toBe('degraded');
      expect(result.ollama.health.status).toBe('misconfigured');
    });

    it('should return production format when nodeEnv is production', async () => {
      (cacheService.isRedisConnected as jest.Mock).mockResolvedValue(true);
      (cacheService.getCacheInfo as jest.Mock).mockResolvedValue(mockCacheInfo);
      (ollamaClientService.getMetrics as jest.Mock).mockResolvedValue(
        mockOllamaMetrics,
      );

      const result = await service.getApiHealthPayload({
        nodeEnv: 'production',
      });

      expect(result).toEqual({
        timestamp: expect.any(String),
        status: 'healthy',
        dependencies: {
          redis: 'up',
          ollama: 'healthy',
        },
      });
      expect(result).not.toHaveProperty('redis');
      expect(result).not.toHaveProperty('ollama');
    });

    it('should handle undefined nodeEnv as development', async () => {
      (cacheService.isRedisConnected as jest.Mock).mockResolvedValue(true);
      (cacheService.getCacheInfo as jest.Mock).mockResolvedValue(mockCacheInfo);
      (ollamaClientService.getMetrics as jest.Mock).mockResolvedValue(
        mockOllamaMetrics,
      );

      const result = await service.getApiHealthPayload({});

      expect(result).toHaveProperty('redis');
      expect(result).toHaveProperty('ollama');
    });
  });

  describe('getRedisStatusForApi', () => {
    it('should return Redis status for development environment', async () => {
      const mockRedisStatus = {
        connected: true,
        responseTime: 5,
        error: null,
      };

      (cacheService.getRedisStatus as jest.Mock).mockResolvedValue(
        mockRedisStatus,
      );

      const result = await service.getRedisStatusForApi({
        nodeEnv: 'development',
      });

      expect(result).toEqual({
        data: mockRedisStatus,
        message: 'Redis is connected (5ms response time)',
      });
    });

    it('should return Redis status for production environment', async () => {
      const mockRedisStatus = {
        connected: true,
        responseTime: 5,
        error: null,
      };

      (cacheService.getRedisStatus as jest.Mock).mockResolvedValue(
        mockRedisStatus,
      );

      const result = await service.getRedisStatusForApi({
        nodeEnv: 'production',
      });

      expect(result).toEqual({
        data: {
          connected: true,
          timestamp: expect.any(String),
        },
        message: 'Redis status is available',
      });
    });

    it('should handle Redis disconnection in development', async () => {
      const mockRedisStatus = {
        connected: false,
        responseTime: null,
        error: 'Connection refused',
      };

      (cacheService.getRedisStatus as jest.Mock).mockResolvedValue(
        mockRedisStatus,
      );

      const result = await service.getRedisStatusForApi({
        nodeEnv: 'development',
      });

      expect(result.message).toBe(
        'Redis connection failed: Connection refused',
      );
    });
  });

  describe('getOllamaMetrics', () => {
    it('should return cached metrics when within TTL', async () => {
      // Set initial cache
      (service as any).ollamaMetricsCache = mockOllamaMetrics;
      (service as any).ollamaMetricsCacheAt = Date.now();

      const result = await service.getOllamaMetrics();

      expect(result).toBe(mockOllamaMetrics);
      expect(ollamaClientService.getMetrics).not.toHaveBeenCalled();
    });

    it('should fetch new metrics when cache is expired', async () => {
      // Set expired cache
      (service as any).ollamaMetricsCache = mockOllamaMetrics;
      (service as any).ollamaMetricsCacheAt = Date.now() - 40000; // 40 seconds ago

      const newMetrics = {
        ...mockOllamaMetrics,
        usage: { totalRequests: 200 },
      };
      (ollamaClientService.getMetrics as jest.Mock).mockResolvedValue(
        newMetrics,
      );

      const result = await service.getOllamaMetrics();

      expect(result).toBe(newMetrics);
      expect(ollamaClientService.getMetrics).toHaveBeenCalledWith({});
    });

    it('should fetch new metrics when forceHealthCheck is true', async () => {
      // Set valid cache
      (service as any).ollamaMetricsCache = mockOllamaMetrics;
      (service as any).ollamaMetricsCacheAt = Date.now();

      const newMetrics = {
        ...mockOllamaMetrics,
        usage: { totalRequests: 200 },
      };
      (ollamaClientService.getMetrics as jest.Mock).mockResolvedValue(
        newMetrics,
      );

      const result = await service.getOllamaMetrics({ forceHealthCheck: true });

      expect(result).toBe(newMetrics);
      expect(ollamaClientService.getMetrics).toHaveBeenCalledWith({
        forceHealthCheck: true,
      });
    });

    it('should fetch metrics when no cache exists', async () => {
      (ollamaClientService.getMetrics as jest.Mock).mockResolvedValue(
        mockOllamaMetrics,
      );

      const result = await service.getOllamaMetrics();

      expect(result).toBe(mockOllamaMetrics);
      expect(ollamaClientService.getMetrics).toHaveBeenCalledWith({});
    });

    it('should update cache after fetching new metrics', async () => {
      (ollamaClientService.getMetrics as jest.Mock).mockResolvedValue(
        mockOllamaMetrics,
      );

      await service.getOllamaMetrics();

      expect((service as any).ollamaMetricsCache).toBe(mockOllamaMetrics);
      expect((service as any).ollamaMetricsCacheAt).toBeDefined();
    });
  });
});
