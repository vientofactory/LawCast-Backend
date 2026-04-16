import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { OllamaClientService } from './ollama-client.service';

jest.mock('axios');

describe('OllamaClientService', () => {
  const mockPost = jest.fn();
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  const createService = (): OllamaClientService => {
    mockedAxios.create.mockReturnValue({
      post: mockPost,
    } as any);

    const configService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
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

    await service.summarizeProposal(
      '조세특례제한법 일부개정법률안',
      '국가전략기술 범위에 소형모듈원자로를 추가하여 세제 지원을 확대하려는 내용',
    );

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
    expect(payload.prompt).toContain(
      '핵심 정책 변화와 예상 영향이 확인되지만 제공된 정보만으로 구체 내용을 확정하기 어렵습니다.',
    );
  });

  it('should normalize model output to one clean sentence', async () => {
    const service = createService();

    mockPost.mockResolvedValue({
      data: {
        response:
          '요약: **세액공제를 확대해 공급망 투자와 전문인력 확보를 촉진합니다.**\n추가 설명 문장입니다.',
      },
    });

    const summary = await service.summarizeProposal(
      '조세특례제한법 일부개정법률안',
      '세제 지원 확대를 통해 산업 경쟁력을 강화하려는 내용',
    );

    expect(summary).toBe(
      '세액공제를 확대해 공급망 투자와 전문인력 확보를 촉진합니다.',
    );
    expect(summary).not.toContain('\n');
    expect(summary).not.toContain('요약:');
    expect(summary).not.toContain('*');
  });

  it('should remove exact bill title from output when repeated by model', async () => {
    const service = createService();
    const title = '조세특례제한법 일부개정법률안';

    mockPost.mockResolvedValue({
      data: {
        response: `${title}은 세액공제를 확대해 관련 산업의 선제적 투자를 유도합니다.`,
      },
    });

    const summary = await service.summarizeProposal(
      title,
      '국가전략기술 지정과 세제지원을 확대하는 내용',
    );

    expect(summary).toBeTruthy();
    expect(summary).not.toContain(title);
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
});
