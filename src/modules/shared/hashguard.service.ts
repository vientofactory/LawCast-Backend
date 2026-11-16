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

      LoggerUtils.debugDev(HashguardService.name, `PoW verification result:`, {
        valid: result.valid,
      });

      return (
        result.valid === true &&
        result.context === expectedContext &&
        result.subject === remoteIp
      );
    } catch {
      return false;
    }
  }
}
