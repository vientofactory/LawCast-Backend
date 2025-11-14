import { BadRequestException } from '@nestjs/common';
import { WebhookValidationUtils } from '../utils/webhook-validation.utils';

describe('WebhookValidationUtils', () => {
  describe('validateDiscordWebhookUrl', () => {
    const validWebhookUrl =
      'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890_-';
    const validDiscordAppUrl =
      'https://discordapp.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890_-';

    it('should pass valid Discord webhook URL', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(validWebhookUrl);
      }).not.toThrow();
    });

    it('should pass valid Discordapp.com webhook URL', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(validDiscordAppUrl);
      }).not.toThrow();
    });

    it('should throw exception for invalid URL format', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl('invalid-url');
      }).toThrow(BadRequestException);
    });

    it('should throw exception for non-Discord domain', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(
          'https://example.com/api/webhooks/123/token',
        );
      }).toThrow(BadRequestException);
    });

    it('should throw exception for invalid path', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(
          'https://discord.com/invalid/path',
        );
      }).toThrow(BadRequestException);
    });

    it('should throw exception for missing webhook ID', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(
          'https://discord.com/api/webhooks/',
        );
      }).toThrow(BadRequestException);
    });

    it('should throw exception for missing webhook token', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(
          'https://discord.com/api/webhooks/123456789012345678',
        );
      }).toThrow(BadRequestException);
    });

    it('should throw exception for invalid webhook ID format', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(
          'https://discord.com/api/webhooks/invalid-id/token',
        );
      }).toThrow(BadRequestException);
    });

    it('should throw exception for too short webhook ID', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(
          'https://discord.com/api/webhooks/123/validtoken123456789012345678901234567890123456789012345678',
        );
      }).toThrow(BadRequestException);
    });

    it('should throw exception for invalid webhook token format', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(
          'https://discord.com/api/webhooks/123456789012345678/invalid-token',
        );
      }).toThrow(BadRequestException);
    });

    it('should throw exception for too short webhook token', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(
          'https://discord.com/api/webhooks/123456789012345678/short',
        );
      }).toThrow(BadRequestException);
    });

    it('should throw exception for HTTP URL', () => {
      expect(() => {
        WebhookValidationUtils.validateDiscordWebhookUrl(
          'http://discord.com/api/webhooks/123456789012345678/token',
        );
      }).toThrow(BadRequestException);
    });
  });

  describe('extractClientIp', () => {
    it('should return req.ip when available', () => {
      const req = { ip: '127.0.0.1' };
      expect(WebhookValidationUtils.extractClientIp(req)).toBe('127.0.0.1');
    });

    it('should return req.connection.remoteAddress when available', () => {
      const req = { connection: { remoteAddress: '192.168.1.1' } };
      expect(WebhookValidationUtils.extractClientIp(req)).toBe('192.168.1.1');
    });

    it('should return x-forwarded-for header when available', () => {
      const req = { headers: { 'x-forwarded-for': '203.0.113.0' } };
      expect(WebhookValidationUtils.extractClientIp(req)).toBe('203.0.113.0');
    });

    it('should return unknown when no IP information is available', () => {
      const req = {
        headers: {},
      };
      expect(WebhookValidationUtils.extractClientIp(req)).toBe('unknown');
    });

    it('should return IP according to priority order', () => {
      const req = {
        ip: '127.0.0.1',
        connection: { remoteAddress: '192.168.1.1' },
        headers: { 'x-forwarded-for': '203.0.113.0' },
      };
      expect(WebhookValidationUtils.extractClientIp(req)).toBe('127.0.0.1');
    });
  });

  describe('getValidationPipeOptions', () => {
    it('should return correct ValidationPipe options', () => {
      const options = WebhookValidationUtils.getValidationPipeOptions();

      expect(options).toHaveProperty('whitelist', true);
      expect(options).toHaveProperty('forbidNonWhitelisted', true);
      expect(options).toHaveProperty('transform', true);
      expect(options).toHaveProperty('exceptionFactory');
      expect(typeof options.exceptionFactory).toBe('function');
    });

    it('should generate correct exceptions with exceptionFactory', () => {
      const options = WebhookValidationUtils.getValidationPipeOptions();
      const mockErrors = [
        {
          constraints: {
            isString: 'must be a string',
            isNotEmpty: 'should not be empty',
          },
        },
      ];

      const exception = options.exceptionFactory(mockErrors);

      expect(exception).toBeInstanceOf(BadRequestException);
      expect(exception.getResponse()).toMatchObject({
        success: false,
        message: '입력 데이터가 올바르지 않습니다.',
        errors: ['must be a string, should not be empty'],
      });
    });
  });
});
