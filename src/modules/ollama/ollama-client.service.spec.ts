import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import axios from 'axios';
import { OllamaClientService } from './ollama-client.service';

jest.mock('axios');

describe('OllamaClientService', () => {
  const mockPost =
    jest.fn<
      (url: string, payload: unknown) => Promise<{ data: { response: string } }>
    >();
  const mockGet =
    jest.fn<
      (url: string) => Promise<{ data: { models: Array<{ name: string }> } }>
    >();
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  const sampleTitle = '조세특례제한법 일부개정법률안';
  const sampleReason =
    '국가전략기술 범위에 소형모듈원자로를 추가하여 세제 지원을 확대하려는 내용';

  const createService = (): OllamaClientService => {
    mockedAxios.create.mockReturnValue({
      post: mockPost,
      get: mockGet,
    } as any);

    const configService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'ollama.enabled') return true;
        if (key === 'ollama.apiUrl') return 'http://localhost:11434';
        if (key === 'ollama.timeout') return 10000;
        if (key === 'ollama.model') return 'gemma3:1b';
        return defaultValue;
      }),
    } as unknown as ConfigService;

    return new OllamaClientService(configService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should build a strict prompt and send deterministic generation options', async () => {
    const service = createService();

    mockPost.mockResolvedValue({
      data: {
        response:
          '세액공제 확대를 통해 소형모듈원자로 공급망 투자와 인력 확보를 촉진합니다.',
      },
    });

    await service.summarizeProposal(sampleTitle, sampleReason);

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/generate',
      expect.objectContaining({
        model: 'gemma3:1b',
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 220,
        },
      }),
    );

    const payload = mockPost.mock.calls[0][1] as { prompt: string };

    expect(payload.prompt).toContain('[출력 규칙]');
    expect(payload.prompt).toContain('한국어 한 문장만 출력합니다.');
    expect(payload.prompt).toContain('반드시 요약 문장 하나만 출력');
    expect(payload.prompt).toContain(`법률안명: ${sampleTitle}`);
    expect(payload.prompt).toContain(`제안이유 및 주요내용: ${sampleReason}`);
  });

  it.each([
    {
      name: 'markdown and extra sentence',
      raw: '요약: **세액공제를 확대해 공급망 투자와 전문인력 확보를 촉진합니다.**\n추가 설명 문장입니다.',
      expected: '세액공제를 확대해 공급망 투자와 전문인력 확보를 촉진합니다.',
    },
    {
      name: 'full-width colon prefix',
      raw: '설명：세액공제 확대를 통해 기업의 설비투자 부담을 완화합니다.',
      expected: '세액공제 확대를 통해 기업의 설비투자 부담을 완화합니다.',
    },
    {
      name: 'bullet marker at line start',
      raw: '- 세액공제 확대로 공급망 기업의 초기 투자 리스크를 줄입니다.',
      expected: '세액공제 확대로 공급망 기업의 초기 투자 리스크를 줄입니다.',
    },
    {
      name: 'code block only first sentence survives',
      raw: '```text\n임시 응답\n``` 세액공제 확대로 산업 경쟁력을 높입니다. 후속 문장입니다.',
      expected: '세액공제 확대로 산업 경쟁력을 높입니다.',
    },
    {
      name: 'quoted text cleanup',
      raw: '"세액공제 확대로" 관련 산업의 선제적 투자 유인을 강화합니다.',
      expected: '세액공제 확대로 관련 산업의 선제적 투자 유인을 강화합니다.',
    },
    {
      name: 'single line normalization with tabs',
      raw: '참고:\t세제 지원 확대로\t기술 고도화와\t인력 확보를 촉진합니다.',
      expected: '세제 지원 확대로 기술 고도화와 인력 확보를 촉진합니다.',
    },
  ])('should normalize sampled output: $name', async ({ raw, expected }) => {
    const service = createService();

    mockPost.mockResolvedValue({
      data: {
        response: raw,
      },
    });

    const summary = await service.summarizeProposal(sampleTitle, sampleReason);

    expect(summary).toBe(expected);
    expect(summary).not.toContain('\n');
    expect(summary).not.toContain('요약:');
    expect(summary).not.toContain('설명:');
    expect(summary).not.toContain('참고:');
    expect(summary).not.toContain('```');
  });

  it('should remove exact bill title from output when repeated by model', async () => {
    const service = createService();

    mockPost.mockResolvedValue({
      data: {
        response: `${sampleTitle}은 세액공제를 확대해 관련 산업의 선제적 투자를 유도합니다.`,
      },
    });

    const summary = await service.summarizeProposal(sampleTitle, sampleReason);

    expect(summary).toBeTruthy();
    expect(summary).not.toContain(sampleTitle);
  });

  it('should remove all repeated title occurrences from output', async () => {
    const service = createService();

    mockPost.mockResolvedValue({
      data: {
        response: `${sampleTitle}은 세액공제를 확대하고 ${sampleTitle} 관련 후속 제도 정비를 추진합니다.`,
      },
    });

    const summary = await service.summarizeProposal(sampleTitle, sampleReason);

    expect(summary).toBe(
      '세액공제를 확대하고 관련 후속 제도 정비를 추진합니다.',
    );
    expect(summary).not.toContain(sampleTitle);
  });

  it('should keep only first sentence when model outputs multiple sentences', async () => {
    const service = createService();

    mockPost.mockResolvedValue({
      data: {
        response:
          '세액공제 확대로 기업 투자 부담을 완화합니다. 따라서 산업 성장에 긍정적입니다. 추가 문장입니다.',
      },
    });

    const summary = await service.summarizeProposal(sampleTitle, sampleReason);

    expect(summary).toBe('세액공제 확대로 기업 투자 부담을 완화합니다.');
  });

  it('should return null when only title remains after normalization', async () => {
    const service = createService();

    mockPost.mockResolvedValue({
      data: {
        response: sampleTitle,
      },
    });

    const summary = await service.summarizeProposal(sampleTitle, sampleReason);

    expect(summary).toBeNull();
  });

  it('should return null when model response is empty after normalization', async () => {
    const service = createService();

    mockPost.mockResolvedValue({
      data: {
        response: '```\n```',
      },
    });

    const summary = await service.summarizeProposal('법안명', '내용');

    expect(summary).toBeNull();
  });

  it('should return null when Ollama call fails', async () => {
    const service = createService();

    mockPost.mockRejectedValue(new Error('network error'));

    const summary = await service.summarizeProposal('법안명', '내용');

    expect(summary).toBeNull();
  });

  it('should collect summary request metrics and expose success rate', async () => {
    const service = createService();

    mockPost.mockResolvedValue({
      data: {
        response: '세액공제 확대를 통해 공급망 투자와 인력 확보를 촉진합니다.',
      },
    });

    await service.summarizeProposal(sampleTitle, sampleReason);
    const metrics = await service.getMetrics();

    expect(metrics.summary.total).toBe(1);
    expect(metrics.summary.success).toBe(1);
    expect(metrics.summary.failed).toBe(0);
    expect(metrics.summary.successRate).toBe(100);
    expect(metrics.summary.lastSuccessAt).toBeTruthy();
    expect(metrics.summary.lastError).toBeNull();
  });

  it('should expose unhealthy health metrics when health check fails', async () => {
    const service = createService();

    mockGet.mockRejectedValue(new Error('connection refused'));

    const metrics = await service.getMetrics({ forceHealthCheck: true });

    expect(metrics.health.status).toBe('unhealthy');
    expect(metrics.health.error).toContain('connection refused');
    expect(metrics.health.lastCheckedAt).toBeTruthy();
  });
});
