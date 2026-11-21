import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HashGuardClient } from 'hashguard-client';
import { LoggerUtils } from '../../utils/logger.utils';

@Injectable()
export class HashguardService {
  private client: HashGuardClient;

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
  }

  async verifyProof(
    proof: string,
    remoteIp: string,
    expectedContext: string,
  ): Promise<boolean> {
    if (!proof || !remoteIp || !expectedContext) {
      return false;
    }

    try {
      const result = await this.client.introspectToken(proof, true, {
        expectedContext,
        expectedSubject: remoteIp,
      });

      const passed =
        result.valid === true &&
        result.context === expectedContext &&
        result.subject === remoteIp;

      // Diagnostic (production-visible): a rejected PoW proof is a security-gate
      // event. The previous `LoggerUtils.debugDev` is dev-only, so production
      // rejections were silent and the subject/context/expiry cause could not be
      // observed. Emit a `warn` on every rejection with the full comparison so the
      // exact mismatch (subject vs expectedSubject, context vs expectedContext,
      // expiry, or server error) is visible in production logs.
      // The proof token itself is intentionally NOT logged: it is single-use and
      // replayable.
      if (!passed) {
        LoggerUtils.warn(HashguardService.name, 'PoW verification rejected:', {
          valid: result.valid,
          subject: result.subject,
          expectedSubject: remoteIp,
          context: result.context,
          expectedContext,
          error: result.error ?? null,
          issuedAt: result.issuedAt ?? null,
          expiresAt: result.expiresAt ?? null,
        });
      }

      return passed;
    } catch (error) {
      // Diagnostic (production-visible): an introspection transport/auth error
      // (e.g. HTTP 401, network failure) is otherwise swallowed silently. Capture
      // it so the failing path is observable in production.
      LoggerUtils.warn(HashguardService.name, 'PoW introspection failed:', {
        expectedSubject: remoteIp,
        expectedContext,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
