import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { ITableData, IContentData } from 'pal-crawl';
import { CachedNotice } from '../../types/cache.types';

interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
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

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
  }>;
}

export type OllamaHealthStatus =
  | 'disabled'
  | 'misconfigured'
  | 'unknown'
  | 'healthy'
  | 'unhealthy';

export interface OllamaRuntimeMetrics {
  enabled: boolean;
  configured: boolean;
  model: string | null;
  summary: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
    successRate: number;
    lastLatencyMs: number | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastError: string | null;
  };
  health: {
    status: OllamaHealthStatus;
    lastCheckedAt: string | null;
    lastLatencyMs: number | null;
    availableModelCount: number | null;
    error: string | null;
  };
}

@Injectable()
export class OllamaClientService {
  private readonly logger = new Logger(OllamaClientService.name);
  private readonly client: AxiosInstance | null;
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly modelTemperature = 0.2;
  private readonly modelNumPredict = 220;
  private readonly healthCacheTtlMs = 30000;

  private summaryTotal = 0;
  private summarySuccess = 0;
  private summaryFailed = 0;
  private summarySkipped = 0;
  private lastSummaryLatencyMs: number | null = null;
  private lastSummarySuccessAt: Date | null = null;
  private lastSummaryFailureAt: Date | null = null;
  private lastSummaryError: string | null = null;

  private healthStatus: OllamaHealthStatus = 'unknown';
  private lastHealthCheckedAt: Date | null = null;
  private lastHealthLatencyMs: number | null = null;
  private availableModelCount: number | null = null;
  private lastHealthError: string | null = null;

  constructor(private configService: ConfigService) {
    this.enabled = !!this.configService.get<boolean>('ollama.enabled', false);
    const apiUrl = this.configService.get<string>('ollama.apiUrl');
    const timeout = this.configService.get<number>('ollama.timeout', 10000);

    this.model = this.configService.get<string>('ollama.model', '');

    if (!this.enabled || !apiUrl || !this.model) {
      this.client = null;
      this.healthStatus = this.enabled ? 'misconfigured' : 'disabled';
      this.logger.log(
        'Ollama summarization is disabled. Set OLLAMA_ENABLED=true with OLLAMA_API_URL and OLLAMA_MODEL to enable it.',
      );
      return;
    }

    // Base HTTP Client for Ollama REST API
    this.client = axios.create({
      baseURL: apiUrl,
      timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Summarizes a legislative proposal using the Ollama model.
   * @param title The title of the legislative proposal.
   * @param proposalReason The reason and main content of the proposal.
   * @returns A summary sentence or null if summarization fails.
   */
  async summarizeProposal(
    title: string,
    proposalReason: string,
  ): Promise<string | null> {
    if (!this.enabled || !this.client) {
      this.summarySkipped += 1;
      return null;
    }

    const prompt = this.getSummarizationPrompt(title, proposalReason);

    const payload = {
      model: this.model,
      prompt,
      stream: false,
      options: {
        temperature: this.modelTemperature,
        num_predict: this.modelNumPredict,
      },
    };

    try {
      this.summaryTotal += 1;
      const requestStartedAt = Date.now();

      // Generate response
      const response = await this.client.post<OllamaGenerateResponse>(
        '/api/generate',
        payload,
      );

      this.summarySuccess += 1;
      this.lastSummaryLatencyMs = Date.now() - requestStartedAt;
      this.lastSummarySuccessAt = new Date();
      this.lastSummaryError = null;
      this.healthStatus = 'healthy';
      this.lastHealthCheckedAt = this.lastSummarySuccessAt;
      this.lastHealthLatencyMs = this.lastSummaryLatencyMs;
      this.lastHealthError = null;

      // Normalize and return the summary
      const summary = this.normalizeSummary(response.data.response, title);
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.summaryFailed += 1;
      this.lastSummaryFailureAt = new Date();
      this.lastSummaryError = message;
      this.healthStatus = 'unhealthy';
      this.lastHealthCheckedAt = this.lastSummaryFailureAt;
      this.lastHealthError = message;
      this.logger.warn(`Failed to summarize proposal with Ollama: ${message}`);
      return null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async getMetrics(
    options: { forceHealthCheck?: boolean } = {},
  ): Promise<OllamaRuntimeMetrics> {
    await this.refreshHealthStatus(options.forceHealthCheck ?? false);

    return {
      enabled: this.enabled,
      configured: !!this.client,
      model: this.model?.trim() ? this.model : null,
      summary: {
        total: this.summaryTotal,
        success: this.summarySuccess,
        failed: this.summaryFailed,
        skipped: this.summarySkipped,
        successRate:
          this.summaryTotal > 0
            ? Number(
                ((this.summarySuccess / this.summaryTotal) * 100).toFixed(1),
              )
            : 0,
        lastLatencyMs: this.lastSummaryLatencyMs,
        lastSuccessAt: this.lastSummarySuccessAt?.toISOString() || null,
        lastFailureAt: this.lastSummaryFailureAt?.toISOString() || null,
        lastError: this.lastSummaryError,
      },
      health: {
        status: this.healthStatus,
        lastCheckedAt: this.lastHealthCheckedAt?.toISOString() || null,
        lastLatencyMs: this.lastHealthLatencyMs,
        availableModelCount: this.availableModelCount,
        error: this.lastHealthError,
      },
    };
  }

  private async refreshHealthStatus(forceHealthCheck: boolean): Promise<void> {
    if (!this.enabled) {
      this.healthStatus = 'disabled';
      return;
    }

    if (!this.client) {
      this.healthStatus = 'misconfigured';
      return;
    }

    if (
      !forceHealthCheck &&
      this.lastHealthCheckedAt &&
      Date.now() - this.lastHealthCheckedAt.getTime() < this.healthCacheTtlMs
    ) {
      return;
    }

    const startedAt = Date.now();

    try {
      const response = await this.client.get<OllamaTagsResponse>('/api/tags');
      this.healthStatus = 'healthy';
      this.lastHealthCheckedAt = new Date();
      this.lastHealthLatencyMs = Date.now() - startedAt;
      this.availableModelCount = Array.isArray(response.data?.models)
        ? response.data.models.length
        : 0;
      this.lastHealthError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.healthStatus = 'unhealthy';
      this.lastHealthCheckedAt = new Date();
      this.lastHealthLatencyMs = Date.now() - startedAt;
      this.lastHealthError = message;
    }
  }

  /**
   * Normalizes the raw response from the model to extract a clean summary sentence.
   * @param rawSummary The raw text response from the model.
   * @param title The original proposal title, used to remove redundant mentions.
   * @returns A cleaned summary sentence or null if it cannot be extracted.
   */
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
      normalized = normalized.split(title).join('').trim();
      normalized = normalized.replace(/^(은|는|이|가)\s*/, '').trim();
    }

    normalized = collapseWhitespace(normalized);

    if (!normalized) {
      return null;
    }

    return normalized;
  }

  /**
   * Constructs the prompt for the summarization model based on the proposal title and reason.
   * @param title The title of the legislative proposal.
   * @param proposalReason The reason and main content of the proposal.
   * @returns A formatted prompt string to be sent to the model.
   */
  private getSummarizationPrompt(
    title: string,
    proposalReason: string,
  ): string {
    const prompt = [
      '당신은 국회 입법예고 요약 도우미입니다. 아래 규칙을 위반하지 마세요.',
      '',
      '[출력 규칙]',
      '1) 한국어 한 문장만 출력합니다.',
      '2) 줄바꿈 없이 평문으로만 출력합니다.',
      '3) "요약:", "설명:", "참고:" 같은 머리말을 금지합니다.',
      '4) 목록 기호, 마크다운, 따옴표, 코드블록을 금지합니다.',
      '5) 법률안명은 반복하지 말고 핵심 정책 변화와 영향만 씁니다.',
      '',
      '[출력 형식]',
      '반드시 요약 문장 하나만 출력',
      '',
      `법률안명: ${title}`,
      `제안이유 및 주요내용: ${proposalReason}`,
    ].join('\n');

    return prompt;
  }

  /**
   * Merge AI summary and archive info into original notice array
   * - If AI summary is not available, it will be null and status will indicate the reason.
   * - Archive info will be attached to each notice for additional context.
   * @param notices Original notice array
   * @param noticeArchiveService Archive service
   * @returns Notice array with merged summary and archive info
   */
  async summarizeAndMergeNotices<
    T extends ITableData & IContentData & Partial<CachedNotice>,
  >(notices: T[], noticeArchiveService: any): Promise<T[]> {
    const summarized = await Promise.all(
      notices.map(async (notice) => {
        let aiSummary = notice.aiSummary ?? null;
        let aiSummaryStatus = notice.aiSummaryStatus ?? 'not_requested';
        if (!aiSummary && notice.proposalReason && notice.title) {
          aiSummary = await this.summarizeProposal(
            notice.title,
            notice.proposalReason,
          );
          aiSummaryStatus = aiSummary ? 'ready' : 'unavailable';
        }
        const [noticeWithArchive] =
          await noticeArchiveService.attachArchiveInfoToNotices([
            { ...notice, aiSummary, aiSummaryStatus },
          ]);
        return noticeWithArchive;
      }),
    );
    return summarized;
  }
}
