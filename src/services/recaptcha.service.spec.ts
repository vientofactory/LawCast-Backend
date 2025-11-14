import { Test, TestingModule } from '@nestjs/testing';
import { RecaptchaService } from '../services/recaptcha.service';
import axios from 'axios';

// axios를 모킹합니다
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('RecaptchaService', () => {
  let service: RecaptchaService;

  beforeEach(async () => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.RECAPTCHA_SECRET_KEY;
  });

  describe('verifyToken', () => {
    describe('when secret key is available', () => {
      beforeEach(async () => {
        process.env.RECAPTCHA_SECRET_KEY = 'test-secret-key';

        const module: TestingModule = await Test.createTestingModule({
          providers: [RecaptchaService],
        }).compile();

        service = module.get<RecaptchaService>(RecaptchaService);
      });

      const mockToken = 'test-recaptcha-token';

      it('should handle successful reCAPTCHA verification', async () => {
        const mockResponse = {
          data: {
            success: true,
            score: 0.9,
            action: 'submit',
          },
        };

        mockedAxios.post.mockResolvedValue(mockResponse);

        const result = await service.verifyToken(mockToken);

        expect(result).toBe(true);
        expect(mockedAxios.post).toHaveBeenCalledWith(
          'https://www.google.com/recaptcha/api/siteverify',
          null,
          {
            params: {
              secret: 'test-secret-key',
              response: mockToken,
            },
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        );
      });

      it('should handle failed reCAPTCHA verification', async () => {
        const mockResponse = {
          data: {
            success: false,
            'error-codes': ['invalid-input-response'],
          },
        };

        mockedAxios.post.mockResolvedValue(mockResponse);

        const result = await service.verifyToken(mockToken);

        expect(result).toBe(false);
      });

      it('should handle verification with remoteIp', async () => {
        const mockResponse = {
          data: {
            success: true,
            score: 0.9,
            action: 'submit',
          },
        };
        const remoteIp = '192.168.1.1';

        mockedAxios.post.mockResolvedValue(mockResponse);

        const result = await service.verifyToken(mockToken, remoteIp);

        expect(result).toBe(true);
        expect(mockedAxios.post).toHaveBeenCalledWith(
          'https://www.google.com/recaptcha/api/siteverify',
          null,
          {
            params: {
              secret: 'test-secret-key',
              response: mockToken,
              remoteip: remoteIp,
            },
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        );
      });

      it('should handle HTTP errors', async () => {
        const error = new Error('Network error');
        mockedAxios.post.mockRejectedValue(error);

        const result = await service.verifyToken(mockToken);

        expect(result).toBe(false);
      });

      it('should handle empty token', async () => {
        const result = await service.verifyToken('');

        expect(result).toBe(false);
        expect(mockedAxios.post).not.toHaveBeenCalled();
      });

      it('should handle null token', async () => {
        const result = await service.verifyToken(null as any);

        expect(result).toBe(false);
        expect(mockedAxios.post).not.toHaveBeenCalled();
      });

      it('should handle undefined token', async () => {
        const result = await service.verifyToken(undefined as any);

        expect(result).toBe(false);
        expect(mockedAxios.post).not.toHaveBeenCalled();
      });
    });

    describe('when secret key is not available', () => {
      beforeEach(async () => {
        delete process.env.RECAPTCHA_SECRET_KEY;

        const module: TestingModule = await Test.createTestingModule({
          providers: [RecaptchaService],
        }).compile();

        service = module.get<RecaptchaService>(RecaptchaService);
      });

      it('should always pass in development environment', async () => {
        const result = await service.verifyToken('any-token');

        // 시크릿 키가 없으면 개발 환경에서는 true를 반환
        expect(result).toBe(true);
        expect(mockedAxios.post).not.toHaveBeenCalled();
      });
    });
  });
});
