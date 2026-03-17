import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HashGuardClient } from 'hashguard-client';
import { LoggerUtils } from '../utils/logger.utils';

@Injectable()
export class HashguardService {
  private readonly logger = new Logger(HashguardService.name);
  private client: HashGuardClient;

  constructor(private readonly configService: ConfigService) {
    const baseUrl = this.configService.get<string>(
      'hashguard.apiUrl',
      'https://hashguard.viento.me',
    );
    this.client = new HashGuardClient({ baseUrl });
  }

  async verifyProof(proof: string, _remoteIp?: string): Promise<boolean> {
    if (!proof) {
      return false;
    }

    try {
      const result = await this.client.introspectToken(proof);

      LoggerUtils.debugDev(
        HashguardService.name,
        `PoW verification result:`,
        result,
      );

      return result.valid;
    } catch (error) {
      this.logger.error('PoW verification failed:', error);
      return false;
    }
  }
}
