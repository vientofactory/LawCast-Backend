import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

interface OllamaGenerateResponse {
  response?: string;
}

@Injectable()
export class OllamaClientService {
  private readonly logger = new Logger(OllamaClientService.name);
  private readonly client: AxiosInstance;
  private readonly model: string;

  constructor(private configService: ConfigService) {
    const apiUrl = this.configService.get<string>('ollama.apiUrl');
    const timeout = this.configService.get<number>('ollama.timeout', 10000);

    this.model = this.configService.get<string>('ollama.model', 'gemma3:1b');
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
      '당신은 국회 입법예고 요약 도우미입니다.',
      '다음 법률안의 "제안이유 및 주요내용"을 한국어로 한 문장으로 요약하세요.',
      '출력에는 불릿이나 번호를 쓰지 말고, 핵심 정책 변화와 영향을 간결하게 포함하세요.',
      '',
      `법률안명: ${title}`,
      `제안이유 및 주요내용: ${proposalReason}`,
    ].join('\n');

    try {
      const response = await this.client.post<OllamaGenerateResponse>(
        '/api/generate',
        {
          model: this.model,
          prompt,
          stream: false,
          options: {
            temperature: 0.2,
            num_predict: 220,
          },
        },
      );

      const summary = response.data?.response?.trim();
      return summary || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to summarize proposal with Ollama: ${message}`);
      return null;
    }
  }
}
