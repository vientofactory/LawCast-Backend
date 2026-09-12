import { WebhookRegistrationService } from './webhook-registration.service';

function createService(
  overrides: {
    verifyProof?: boolean;
    findByUrl?: any;
    testWebhook?: any;
  } = {},
) {
  const webhookService = {
    findByUrl: overrides.findByUrl ?? jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 1, url: 'test' }),
  };

  const hashguardService = {
    verifyProof: jest.fn().mockResolvedValue(overrides.verifyProof ?? true),
  };

  const notificationService = {
    testWebhook:
      overrides.testWebhook ??
      jest.fn().mockResolvedValue({ success: true, shouldDelete: false }),
  };

  const service = new WebhookRegistrationService(
    webhookService as any,
    hashguardService as any,
    notificationService as any,
  );

  return { service, webhookService, hashguardService, notificationService };
}

const VALID_DISCORD_URL =
  'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890_-';

describe('WebhookRegistrationService', () => {
  describe('registerWebhook', () => {
    it('registers a webhook successfully when all validations pass', async () => {
      const { service, webhookService } = createService();

      const result = await service.registerWebhook(
        { url: VALID_DISCORD_URL, proof: 'valid-proof' },
        { ip: '127.0.0.1', headers: {} } as any,
      );

      expect(result).toBeDefined();
      expect(webhookService.create).toHaveBeenCalledWith(VALID_DISCORD_URL);
    });

    it('rejects registration when proof-of-work fails', async () => {
      const { service, webhookService } = createService({
        verifyProof: false,
      });

      await expect(
        service.registerWebhook(
          { url: VALID_DISCORD_URL, proof: 'invalid-proof' },
          { ip: '127.0.0.1', headers: {} } as any,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(webhookService.create).not.toHaveBeenCalled();
    });

    it('rejects registration for a non-Discord URL', async () => {
      const { service, webhookService } = createService();

      await expect(
        service.registerWebhook(
          { url: 'https://example.com/hook', proof: 'proof' },
          { ip: '127.0.0.1', headers: {} } as any,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(webhookService.create).not.toHaveBeenCalled();
    });

    it('rejects registration for an invalid URL format', async () => {
      const { service, webhookService } = createService();

      await expect(
        service.registerWebhook({ url: 'not-a-url', proof: 'proof' }, {
          ip: '127.0.0.1',
          headers: {},
        } as any),
      ).rejects.toMatchObject({ status: 400 });
      expect(webhookService.create).not.toHaveBeenCalled();
    });

    it('rejects registration when webhook already exists', async () => {
      const { service, webhookService } = createService({
        findByUrl: jest
          .fn()
          .mockResolvedValue({ id: 99, url: VALID_DISCORD_URL }),
      });

      await expect(
        service.registerWebhook(
          { url: VALID_DISCORD_URL, proof: 'valid-proof' },
          { ip: '127.0.0.1', headers: {} } as any,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(webhookService.create).not.toHaveBeenCalled();
    });

    it('rejects registration when the webhook test fails', async () => {
      const { service, webhookService } = createService({
        testWebhook: jest.fn().mockResolvedValue({
          success: false,
          error: { message: 'Not Found' },
          errorType: 'NOT_FOUND',
        }),
      });

      await expect(
        service.registerWebhook(
          { url: VALID_DISCORD_URL, proof: 'valid-proof' },
          { ip: '127.0.0.1', headers: {} } as any,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(webhookService.create).not.toHaveBeenCalled();
    });

    it('uses proxy-forwarded client IP for PoW verification', async () => {
      const { service, hashguardService } = createService();

      await service.registerWebhook(
        { url: VALID_DISCORD_URL, proof: 'proof' },
        {
          headers: { 'cf-connecting-ip': '203.0.113.10' },
          ip: '10.0.0.5',
        } as any,
      );

      expect(hashguardService.verifyProof).toHaveBeenCalledWith(
        'proof',
        '10.0.0.5',
      );
    });

    it('returns success response with webhook test result details', async () => {
      const { service } = createService({
        testWebhook: jest.fn().mockResolvedValue({
          success: true,
          shouldDelete: false,
        }),
      });

      const result = await service.registerWebhook(
        { url: VALID_DISCORD_URL, proof: 'proof' },
        { ip: '127.0.0.1', headers: {} } as any,
      );

      expect(result).toBeDefined();
    });
  });
});
