import { ConfigService } from '@nestjs/config';
import { HashguardService } from './hashguard.service';
import { HashGuardClient } from 'hashguard-client';

jest.mock('hashguard-client');
const MockedHashGuardClient = HashGuardClient as jest.MockedClass<
  typeof HashGuardClient
>;

describe('HashguardService', () => {
  let service: HashguardService;
  let mockClient: jest.Mocked<HashGuardClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      introspectToken: jest.fn(),
    } as any;
    MockedHashGuardClient.mockImplementation(() => mockClient);

    const configService = {
      get: jest.fn((key: string, defaultValue?: string) => {
        if (key === 'hashguard.apiUrl') return 'https://hashguard.test';
        if (key === 'hashguard.apiKey') return 'test-api-key';
        return defaultValue;
      }),
    } as unknown as ConfigService;

    service = new HashguardService(configService);
  });

  describe('verifyProof', () => {
    it.each([
      ['', 'discussion-thread'],
      ['203.0.113.10', ''],
    ])('rejects missing binding constraints (%s, %s)', async (ip, context) => {
      expect(await service.verifyProof('proof', ip, context)).toBe(false);
      expect(mockClient.introspectToken).not.toHaveBeenCalled();
    });

    it('returns false when proof is empty', async () => {
      const result = await service.verifyProof(
        '',
        '203.0.113.10',
        'discussion-thread',
      );
      expect(result).toBe(false);
      expect(mockClient.introspectToken).not.toHaveBeenCalled();
    });

    it('returns false when proof is undefined-like empty string', async () => {
      const result = await service.verifyProof(
        undefined as any,
        '203.0.113.10',
        'discussion-thread',
      );
      expect(result).toBe(false);
    });

    it('returns true when the PoW token is valid', async () => {
      mockClient.introspectToken.mockResolvedValue({
        valid: true,
        subject: '203.0.113.10',
        context: 'discussion-thread',
      });

      const result = await service.verifyProof(
        'valid-proof-token',
        '203.0.113.10',
        'discussion-thread',
      );

      expect(result).toBe(true);
      expect(mockClient.introspectToken).toHaveBeenCalledWith(
        'valid-proof-token',
        true,
        {
          expectedContext: 'discussion-thread',
          expectedSubject: '203.0.113.10',
        },
      );
    });

    it.each([
      { valid: true },
      { valid: true, subject: '203.0.113.11', context: 'discussion-thread' },
      { valid: true, subject: '203.0.113.10', context: 'webhook-registration' },
      { valid: 'true', subject: '203.0.113.10', context: 'discussion-thread' },
    ])(
      'rejects mismatched or malformed introspection claims (%p)',
      async (result) => {
        mockClient.introspectToken.mockResolvedValue(result as any);
        expect(
          await service.verifyProof(
            'proof',
            '203.0.113.10',
            'discussion-thread',
          ),
        ).toBe(false);
      },
    );

    it('returns false when the PoW token is invalid', async () => {
      mockClient.introspectToken.mockResolvedValue({ valid: false });

      const result = await service.verifyProof(
        'invalid-proof-token',
        '203.0.113.10',
        'discussion-thread',
      );

      expect(result).toBe(false);
    });

    it('returns false when the API call throws a network error', async () => {
      mockClient.introspectToken.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.verifyProof(
        'proof-token',
        '203.0.113.10',
        'discussion-thread',
      );

      expect(result).toBe(false);
    });

    it('returns false when the API call throws a timeout error', async () => {
      mockClient.introspectToken.mockRejectedValue(new Error('ETIMEDOUT'));

      const result = await service.verifyProof(
        'proof-token',
        '203.0.113.10',
        'discussion-thread',
      );

      expect(result).toBe(false);
    });

    it('returns false when the API returns an unexpected error', async () => {
      mockClient.introspectToken.mockRejectedValue(
        new Error('Internal Server Error'),
      );

      const result = await service.verifyProof(
        'proof-token',
        '203.0.113.10',
        'discussion-thread',
      );

      expect(result).toBe(false);
    });

    it('constructs the client with the configured API URL and key', () => {
      expect(MockedHashGuardClient).toHaveBeenCalledWith({
        baseUrl: 'https://hashguard.test',
        headers: { Authorization: 'Bearer test-api-key' },
      });
    });

    it('constructs the client without Authorization when no API key is configured', () => {
      jest.clearAllMocks();
      const configService = {
        get: jest.fn((key: string, defaultValue?: string) => {
          if (key === 'hashguard.apiUrl') return 'https://hashguard.test';
          if (key === 'hashguard.apiKey') return '';
          return defaultValue;
        }),
      } as unknown as ConfigService;

      new HashguardService(configService);

      expect(MockedHashGuardClient).toHaveBeenCalledWith({
        baseUrl: 'https://hashguard.test',
        headers: {},
      });
    });

    it('uses default URL when no config is provided', () => {
      jest.clearAllMocks();
      const configService = {
        get: jest.fn((_key: string, defaultValue?: string) => defaultValue),
      } as unknown as ConfigService;

      new HashguardService(configService);

      expect(MockedHashGuardClient).toHaveBeenCalledWith({
        baseUrl: 'https://hashguard.viento.me',
        headers: {},
      });
    });
  });
});
