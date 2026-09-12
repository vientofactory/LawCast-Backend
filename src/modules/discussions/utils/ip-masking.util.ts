import { BadRequestException } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import type { Request } from 'express';

const IP_SALT =
  process.env.DISCUSSION_IP_SALT ?? 'lawcast_discussion_salt_default';

export class IpMaskingUtil {
  /**
   * Normalize a header value to its first entry. Express may return a string
   * or a string[] depending on header repetition and version.
   */
  private static firstHeaderValue(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const first = value.find(
        (entry): entry is string => typeof entry === 'string' && !!entry.trim(),
      );
      return first ? first.trim() : null;
    }
    return null;
  }

  /**
   * Extract raw client IP from request headers or connection.
   * Returns null when no IP source is available; callers must reject the
   * request instead of attributing it to a placeholder address.
   */
  static extractClientIp(req: Request): string | null {
    const forwardedClientIp = this.firstHeaderValue(
      req.headers['x-lawcast-client-ip'],
    );
    if (forwardedClientIp) {
      return this.cleanIp(forwardedClientIp);
    }

    const cfIp = this.firstHeaderValue(req.headers['cf-connecting-ip']);
    if (cfIp) {
      return this.cleanIp(cfIp);
    }

    const trueClientIp = this.firstHeaderValue(req.headers['true-client-ip']);
    if (trueClientIp) {
      return this.cleanIp(trueClientIp);
    }

    const xForwardedFor = this.firstHeaderValue(req.headers['x-forwarded-for']);
    if (xForwardedFor) {
      const firstIp = xForwardedFor.split(',')[0].trim();
      if (firstIp) {
        return this.cleanIp(firstIp);
      }
    }

    const xRealIp = this.firstHeaderValue(req.headers['x-real-ip']);
    if (xRealIp) {
      return this.cleanIp(xRealIp);
    }

    if (req.ip) {
      return this.cleanIp(req.ip);
    }

    if (req.socket?.remoteAddress) {
      return this.cleanIp(req.socket.remoteAddress);
    }

    return null;
  }

  /**
   * extractClientIp + reject: throws a 400 when the client IP cannot be
   * determined, so unattributable traffic never reaches business logic
   * (rate-limit buckets, PoW proofs, author IDs, IP masking).
   */
  static requireClientIp(req: Request): string {
    const clientIp = this.extractClientIp(req);
    if (!clientIp) {
      throw new BadRequestException({
        success: false,
        message: '클라이언트 IP를 확인할 수 없어 요청을 처리할 수 없습니다.',
      });
    }
    return clientIp;
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

  /**
   * Generates a stable, thread-scoped one-way HMAC identifier without storing the IP.
   * The secret prevents offline IP candidate matching against persisted IDs.
   */
  static authorIdFromIp(rawIp: string, scope: string): string {
    const authorIdSecret = process.env.DISCUSSION_AUTHOR_ID_SECRET;
    if (!authorIdSecret) {
      throw new Error('DISCUSSION_AUTHOR_ID_SECRET must be configured');
    }
    const ip = this.cleanIp(rawIp);
    return createHmac('sha256', authorIdSecret)
      .update(`${scope}:${ip}`)
      .digest('hex');
  }
}
