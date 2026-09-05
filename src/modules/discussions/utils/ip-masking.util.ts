import { createHash } from 'crypto';
import type { Request } from 'express';

const IP_SALT =
  process.env.DISCUSSION_IP_SALT || 'lawcast_discussion_salt_default';

export class IpMaskingUtil {
  /**
   * Extract raw client IP from request headers or connection.
   */
  static extractClientIp(req: Request): string {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim()) {
      return this.cleanIp(cfIp.trim());
    }

    const xForwardedFor = req.headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
      const firstIp = xForwardedFor.split(',')[0].trim();
      if (firstIp) {
        return this.cleanIp(firstIp);
      }
    } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
      const firstIp = xForwardedFor[0].split(',')[0].trim();
      if (firstIp) {
        return this.cleanIp(firstIp);
      }
    }

    const xRealIp = req.headers['x-real-ip'];
    if (typeof xRealIp === 'string' && xRealIp.trim()) {
      return this.cleanIp(xRealIp.trim());
    }

    if (req.ip) {
      return this.cleanIp(req.ip);
    }

    if (req.socket?.remoteAddress) {
      return this.cleanIp(req.socket.remoteAddress);
    }

    return '127.0.0.1';
  }

  /**
   * Remove ::ffff: prefix from IPv4-mapped IPv6 addresses.
   */
  static cleanIp(ip: string): string {
    const trimmed = ip.trim();
    if (trimmed.startsWith('::ffff:')) {
      return trimmed.substring(7);
    }
    return trimmed;
  }

  /**
   * Mask IP address:
   * IPv4: 123.45.67.89 -> 123.45.***.***
   * IPv6: 2001:db8:85a3:: -> 2001:db8:****:****
   */
  static maskIp(rawIp: string): string {
    const ip = this.cleanIp(rawIp);

    // Check if IPv4
    const ipv4Parts = ip.split('.');
    if (
      ipv4Parts.length === 4 &&
      ipv4Parts.every(
        (p) => !isNaN(Number(p)) && Number(p) >= 0 && Number(p) <= 255,
      )
    ) {
      return `${ipv4Parts[0]}.${ipv4Parts[1]}.***.***`;
    }

    // Check if IPv6
    if (ip.includes(':')) {
      if (ip === '::1' || ip === '::') {
        return '::1';
      }
      const ipv6Parts = ip.split(':').filter(Boolean);
      if (ipv6Parts.length >= 2) {
        return `${ipv6Parts[0]}:${ipv6Parts[1]}:****:****`;
      }
      return `${ipv6Parts[0] || '2001'}:****:****:****`;
    }

    return '***.***.***.***';
  }

  /**
   * Generates a deterministic salted SHA-256 hash of the raw IP for abuse/spam prevention.
   */
  static hashIp(rawIp: string): string {
    const ip = this.cleanIp(rawIp);
    return createHash('sha256').update(`${ip}:${IP_SALT}`).digest('hex');
  }
}
