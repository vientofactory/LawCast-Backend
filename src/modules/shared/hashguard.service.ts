import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HashGuardClient } from 'hashguard-client';
import { LoggerUtils } from '../../utils/logger.utils';

@Injectable()
export class HashguardService {
  private client: HashGuardClient;
  private readonly isProduction: boolean;

  constructor(private readonly configService: ConfigService) {
    const baseUrl = this.configService.get<string>(
      'hashguard.apiUrl',
      'https://hashguard.viento.me',
    );
    const apiKey = this.configService.get<string>('hashguard.apiKey', '');
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    this.client = new HashGuardClient({ baseUrl, headers });
    this.isProduction =
      this.configService.get<string>('nodeEnv') === 'production';
  }

  async verifyProof(
    proof: string,
    remoteIp: string,
    expectedContext: string,
  ): Promise<boolean> {
    if (!proof || !remoteIp || !expectedContext) {
      return false;
    }

    // A loopback peer is local-only: the proof token was bound to the browser's
    // public IP at assessment time, so the subject constraint is skipped for it
    // while context, single-use and expiry checks still apply. Gated to
    // non-production so a spoofed loopback header can never disable it in prod.
    const bindSubject =
      this.isProduction || !this.isUntrustedSubjectIp(remoteIp);
    const constraints: { expectedContext: string; expectedSubject?: string } = {
      expectedContext,
      ...(bindSubject ? { expectedSubject: remoteIp } : {}),
    };

    try {
      const result = await this.client.introspectToken(
        proof,
        true,
        constraints,
      );

      const passed =
        result.valid === true &&
        result.context === expectedContext &&
        (bindSubject ? result.subject === remoteIp : true);

      if (!passed) {
        LoggerUtils.warn(HashguardService.name, 'PoW verification rejected:', {
          valid: result.valid,
          subject: result.subject,
          expectedSubject: remoteIp,
          bindSubject,
          context: result.context,
          expectedContext,
          error: result.error ?? null,
          issuedAt: result.issuedAt ?? null,
          expiresAt: result.expiresAt ?? null,
        });
      }

      return passed;
    } catch (error) {
      LoggerUtils.warn(HashguardService.name, 'PoW introspection failed:', {
        expectedSubject: remoteIp,
        bindSubject,
        expectedContext,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** True for loopback peers, whose IP is not a trustworthy subject to bind. */
  private isUntrustedSubjectIp(ip: string): boolean {
    const normalized = ip.startsWith('::ffff:')
      ? ip.slice('::ffff:'.length)
      : ip;
    return normalized === '::1' || normalized.startsWith('127.');
  }
}
