import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

interface OllamaGenerateResponse {
  // Basic response fields
  model: string;
  created_at: string;
  response: string;

  // Below fields may not be available when response is streamed
  done?: boolean;
  done_reason?: string;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

@Injectable()
export class OllamaClientService {
  private readonly logger = new Logger(OllamaClientService.name);
  private readonly client: AxiosInstance;
  private readonly model: string;
  private readonly modelTemperature = 0.2;
  private readonly modelNumPredict = 220;
  private readonly fallbackSummary =
    '핵심 정책 변화와 예상 영향이 확인되지만 제공된 정보만으로 구체 내용을 확정하기 어렵습니다.';

  constructor(private configService: ConfigService) {
    const apiUrl = this.configService.get<string>('ollama.apiUrl');
    const timeout = this.configService.get<number>('ollama.timeout', 10000);

    this.model = this.configService.get<string>('ollama.model', 'gemma3:1b');

    // Base HTTP Client for Ollama REST API
    this.client = axios.create({
      baseURL: apiUrl,
      timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async summarizeProposal(
    title: string,
    proposalReason: string,
  ): Promise<string | null> {
    const prompt = [
      '당신은 국회 입법예고 요약 도우미입니다. 아래 규칙을 위반하지 마세요.',
      '',
      '[출력 규칙]',
      '1) 한국어 한 문장만 출력합니다.',
      '2) 줄바꿈 없이 평문으로만 출력합니다.',
      '3) "요약:", "설명:", "참고:" 같은 머리말을 금지합니다.',
      '4) 목록 기호, 마크다운, 따옴표, 코드블록을 금지합니다.',
      '5) 법률안명은 반복하지 말고 핵심 정책 변화와 영향만 씁니다.',
      '6) 입력에 근거가 부족하면 아래 문장만 그대로 출력합니다.',
      `   ${this.fallbackSummary}`,
      '',
      '[출력 형식]',
      '반드시 요약 문장 하나만 출력',
      '',
      `법률안명: ${title}`,
      `제안이유 및 주요내용: ${proposalReason}`,
    ].join('\n');

    try {
      const payload = {
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature: this.modelTemperature,
          num_predict: this.modelNumPredict,
        },
      };

      // Generate response
      const response = await this.client.post<OllamaGenerateResponse>(
        '/api/generate',
        payload,
      );

      const summary = this.normalizeSummary(response.data.response, title);
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to summarize proposal with Ollama: ${message}`);
      return null;
    }
  }

  private normalizeSummary(rawSummary: string, title: string): string | null {
    if (!rawSummary) {
      return null;
    }

    const collapseWhitespace = (value: string): string =>
      value
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    let normalized = collapseWhitespace(rawSummary)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^[#>*\-\d.\s]+/, '')
      .replace(/^(요약|설명|참고)\s*[:：]\s*/i, '')
      .replace(/[*_~()[\]]/g, '')
      .replace(/["'`]/g, '')
      .trim();

    if (!normalized) {
      return null;
    }

    const sentenceParts = normalized
      .split(/(?<=[.!?。])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);

    normalized = sentenceParts[0] ?? normalized;

    if (!normalized) {
      return null;
    }

    if (title && normalized.includes(title)) {
      normalized = normalized.replace(title, '').trim();
    }

    normalized = collapseWhitespace(normalized);

    if (!normalized) {
      return null;
    }

    return normalized;
  }
}
