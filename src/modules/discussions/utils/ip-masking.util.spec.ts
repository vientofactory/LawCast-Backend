import { IpMaskingUtil } from './ip-masking.util';
import type { Request } from 'express';

describe('IpMaskingUtil', () => {
  beforeAll(() => {
    process.env.DISCUSSION_AUTHOR_ID_SECRET = 'test-author-id-secret';
  });

  describe('maskIp', () => {
    it('should mask IPv4 preserving only first 2 octets', () => {
      expect(IpMaskingUtil.maskIp('123.45.67.89')).toBe('123.45.***.***');
      expect(IpMaskingUtil.maskIp('1.2.3.4')).toBe('1.2.***.***');
      expect(IpMaskingUtil.maskIp('211.234.110.5')).toBe('211.234.***.***');
    });

    it('should strip ::ffff: prefix from IPv4-mapped IPv6 addresses', () => {
      expect(IpMaskingUtil.maskIp('::ffff:192.168.1.50')).toBe(
        '192.168.***.***',
      );
    });

    it('should mask IPv6 addresses', () => {
      expect(
        IpMaskingUtil.maskIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334'),
      ).toBe('2001:0db8:****:****');
      expect(IpMaskingUtil.maskIp('::1')).toBe('::1');
    });
  });

  describe('extractClientIp', () => {
    it('should prioritize the trusted frontend proxy client IP', () => {
      const mockReq = {
        headers: {
          'x-lawcast-client-ip': '198.51.100.10',
          'cf-connecting-ip': '211.234.1.2',
        },
      } as unknown as Request;

      expect(IpMaskingUtil.extractClientIp(mockReq)).toBe('198.51.100.10');
    });

    it('should prioritize cf-connecting-ip', () => {
      const mockReq = {
        headers: {
          'cf-connecting-ip': '211.234.1.2',
          'x-forwarded-for': '10.0.0.1',
        },
      } as unknown as Request;

      expect(IpMaskingUtil.extractClientIp(mockReq)).toBe('211.234.1.2');
    });

    it('should fallback to x-forwarded-for first entry', () => {
      const mockReq = {
        headers: {
          'x-forwarded-for': '203.0.113.195, 70.41.3.18, 150.172.238.178',
        },
      } as unknown as Request;

      expect(IpMaskingUtil.extractClientIp(mockReq)).toBe('203.0.113.195');
    });

    it('should fallback to req.ip', () => {
      const mockReq = {
        headers: {},
        ip: '198.51.100.1',
      } as unknown as Request;

      expect(IpMaskingUtil.extractClientIp(mockReq)).toBe('198.51.100.1');
    });
  });

  describe('hashIp', () => {
    it('should generate consistent SHA-256 hash for identical IPs', () => {
      const hash1 = IpMaskingUtil.hashIp('123.45.67.89');
      const hash2 = IpMaskingUtil.hashIp('123.45.67.89');
      const hash3 = IpMaskingUtil.hashIp('123.45.67.90');

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1).toHaveLength(64);
    });
  });

  describe('authorIdFromIp', () => {
    it('should return the same scoped one-way identifier for the same IP', () => {
      const first = IpMaskingUtil.authorIdFromIp('123.45.67.89', 'thread:1');
      const second = IpMaskingUtil.authorIdFromIp('123.45.67.89', 'thread:1');

      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{64}$/i);
      expect(first).not.toBe(
        IpMaskingUtil.authorIdFromIp('123.45.67.89', 'thread:2'),
      );
    });

    it('should distinguish different IPs', () => {
      expect(IpMaskingUtil.authorIdFromIp('123.45.67.89', 'thread:1')).not.toBe(
        IpMaskingUtil.authorIdFromIp('123.45.67.90', 'thread:1'),
      );
    });
  });
});
