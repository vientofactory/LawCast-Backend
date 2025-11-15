import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { type ITableData } from 'pal-crawl';
import { WebhookService } from './webhook.service';
import { NotificationService } from './notification.service';

export interface BatchJobResult<T = any> {
  success: boolean;
  data?: T;
  error?: Error;
  duration: number;
}

export interface BatchProcessingOptions {
  concurrency?: number;
  timeout?: number;
  retryCount?: number;
  retryDelay?: number;
}

@Injectable()
export class BatchProcessingService implements OnApplicationShutdown {
  private readonly logger = new Logger(BatchProcessingService.name);
  private readonly jobQueue = new Map<string, Promise<any>>();
  private readonly activeTimeouts = new Set<NodeJS.Timeout>();
  private isShuttingDown = false;
  private readonly shutdownTimeout = 25000; // 25초 (main.ts의 30초보다 짧게)

  constructor(
    private webhookService: WebhookService,
    private notificationService: NotificationService,
  ) {}

  /**
   * 논블로킹 병렬 배치 작업 실행
   */
  async executeBatch<T>(
    jobs: Array<() => Promise<T>>,
    options: BatchProcessingOptions = {},
  ): Promise<BatchJobResult<T>[]> {
    // 종료 중인 경우 새로운 작업 거부
    if (this.isShuttingDown) {
      this.logger.warn('Rejecting new batch job - service is shutting down');
      throw new Error('Service is shutting down, cannot process new jobs');
    }

    const {
      concurrency = 10,
      timeout = 30000,
      retryCount = 3,
      retryDelay = 1000,
    } = options;

    const results: BatchJobResult<T>[] = [];
    const chunks = this.chunkArray(jobs, concurrency);

    for (const chunk of chunks) {
      const chunkPromises = chunk.map(async (job, index) => {
        const startTime = Date.now();
        const jobId = `job_${Date.now()}_${index}`;

        try {
          const result = await this.executeJobWithRetry(
            job,
            retryCount,
            retryDelay,
            timeout,
            jobId,
          );

          return {
            success: true,
            data: result,
            duration: Date.now() - startTime,
          };
        } catch (error) {
          this.logger.error(`Job ${jobId} failed:`, error);
          return {
            success: false,
            error: error as Error,
            duration: Date.now() - startTime,
          };
        }
      });

      const chunkResults = await Promise.allSettled(chunkPromises);
      results.push(
        ...chunkResults.map((result) =>
          result.status === 'fulfilled'
            ? result.value
            : {
                success: false,
                error: new Error('Job execution failed'),
                duration: 0,
              },
        ),
      );
    }

    return results;
  }

  /**
   * 입법예고 알림 배치 처리
   */
  async processNotificationBatch(
    notices: ITableData[],
    options: BatchProcessingOptions = {},
  ): Promise<void> {
    // 종료 중인 경우 새로운 작업 거부
    if (this.isShuttingDown) {
      this.logger.warn(
        'Rejecting new notification batch - service is shutting down',
      );
      throw new Error(
        'Service is shutting down, cannot process new notifications',
      );
    }

    const jobId = `notification_batch_${Date.now()}`;
    this.logger.log(
      `Starting notification batch processing for ${notices.length} notices`,
    );

    // 논블로킹 실행
    const batchPromise = this.executeNotificationBatch(notices, options);
    this.jobQueue.set(jobId, batchPromise);

    // 완료 후 정리
    batchPromise
      .then((results) => {
        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.length - successCount;

        this.logger.log(
          `Notification batch completed: ${successCount} success, ${failureCount} failed`,
        );
      })
      .catch((error) => {
        this.logger.error('Notification batch processing failed:', error);
      })
      .finally(() => {
        this.jobQueue.delete(jobId);
      });

    // 즉시 반환 (논블로킹)
    this.logger.log(`Notification batch job ${jobId} started in background`);
  }

  /**
   * 실제 알림 배치 실행
   */
  private async executeNotificationBatch(
    notices: ITableData[],
    options: BatchProcessingOptions,
  ): Promise<BatchJobResult[]> {
    const webhooks = await this.webhookService.findAll();

    if (webhooks.length === 0) {
      this.logger.warn('No active webhooks found');
      return [];
    }

    // 각 입법예고별로 배치 작업 생성
    const notificationJobs = notices.map((notice) => async () => {
      const results =
        await this.notificationService.sendDiscordNotificationBatch(
          notice,
          webhooks,
        );

      // 실패한 웹훅들 수집
      const failedWebhookIds = results
        .filter((result) => !result.success)
        .map((result) => result.webhookId);

      // 실패한 웹훅들을 자동 삭제
      if (failedWebhookIds.length > 0) {
        await this.webhookService.removeFailedWebhooks(failedWebhookIds);
        this.logger.warn(
          `Removed ${failedWebhookIds.length} failed webhooks for notice: ${notice.subject}`,
        );
      }

      return {
        notice: notice.subject,
        totalWebhooks: webhooks.length,
        successCount: results.filter((r) => r.success).length,
        failedCount: failedWebhookIds.length,
      };
    });

    return this.executeBatch(notificationJobs, options);
  }

  /**
   * 재시도 로직이 포함된 작업 실행
   */
  private async executeJobWithRetry<T>(
    job: () => Promise<T>,
    retryCount: number,
    retryDelay: number,
    timeout: number,
    jobId: string,
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= retryCount + 1; attempt++) {
      try {
        return await Promise.race<T>([
          job(),
          this.createTimeoutPromise<T>(timeout),
        ]);
      } catch (error) {
        lastError = error as Error;

        if (attempt <= retryCount) {
          this.logger.warn(
            `Job ${jobId} attempt ${attempt} failed, retrying in ${retryDelay}ms:`,
            error,
          );
          await this.delay(retryDelay);
        }
      }
    }

    throw lastError!;
  }

  /**
   * 타임아웃 Promise 생성
   */
  private createTimeoutPromise<T>(timeout: number): Promise<T> {
    return new Promise<T>((_, reject) => {
      const timeoutId = setTimeout(() => {
        this.activeTimeouts.delete(timeoutId);
        reject(new Error(`Operation timed out after ${timeout}ms`));
      }, timeout);
      this.activeTimeouts.add(timeoutId);
    });
  }

  /**
   * 배열을 청크 단위로 분할
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * 지연 함수
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.activeTimeouts.delete(timeoutId);
        resolve();
      }, ms);
      this.activeTimeouts.add(timeoutId);
    });
  }

  /**
   * 현재 실행 중인 배치 작업 상태 반환
   */
  getBatchJobStatus(): { jobCount: number; jobIds: string[] } {
    return {
      jobCount: this.jobQueue.size,
      jobIds: Array.from(this.jobQueue.keys()),
    };
  }

  /**
   * 특정 배치 작업 대기
   */
  async waitForBatchJob(jobId: string): Promise<void> {
    const job = this.jobQueue.get(jobId);
    if (job) {
      await job;
    }
  }

  /**
   * 모든 배치 작업 완료 대기
   */
  async waitForAllBatchJobs(): Promise<void> {
    const jobs = Array.from(this.jobQueue.values());
    await Promise.allSettled(jobs);
  }

  /**
   * 모든 활성 타이머 정리 (테스트용)
   */
  clearAllTimeouts(): void {
    this.activeTimeouts.forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    this.activeTimeouts.clear();
  }

  /**
   * NestJS OnApplicationShutdown hook
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Application shutdown signal received: ${signal}`);
    await this.gracefulShutdown();
  }

  /**
   * Graceful shutdown 시작
   */
  async gracefulShutdown(): Promise<void> {
    this.logger.log('Starting batch processing service graceful shutdown...');
    this.isShuttingDown = true;

    const startTime = Date.now();
    const jobStatus = this.getBatchJobStatus();

    if (jobStatus.jobCount === 0) {
      this.logger.log('No active batch jobs, shutdown completed immediately');
      this.clearAllTimeouts();
      return;
    }

    this.logger.log(
      `Waiting for ${jobStatus.jobCount} active batch jobs to complete...`,
    );
    this.logger.debug(`Active job IDs: ${jobStatus.jobIds.join(', ')}`);

    try {
      // 타임아웃과 함께 모든 배치 작업 완료 대기
      await Promise.race([
        this.waitForAllBatchJobs(),
        this.createShutdownTimeoutPromise(),
      ]);

      const duration = Date.now() - startTime;
      this.logger.log(`All batch jobs completed gracefully in ${duration}ms`);
    } catch (error) {
      this.logger.error('Error during batch jobs completion:', error);
      throw error;
    } finally {
      // 모든 활성 타이머 정리
      this.clearAllTimeouts();
      this.logger.log('Batch processing service shutdown completed');
    }
  }

  /**
   * Shutdown 상태 확인
   */
  isServiceShuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * 강제 종료 (긴급 상황용)
   */
  forceShutdown(): void {
    this.logger.warn('Force shutdown initiated - canceling all active jobs');
    this.isShuttingDown = true;
    this.clearAllTimeouts();
    this.jobQueue.clear();
  }

  /**
   * Shutdown 타임아웃 Promise 생성
   */
  private createShutdownTimeoutPromise(): Promise<never> {
    return new Promise<never>((_, reject) => {
      const timeoutId = setTimeout(() => {
        this.activeTimeouts.delete(timeoutId);
        reject(
          new Error(
            `Batch jobs shutdown timed out after ${this.shutdownTimeout}ms`,
          ),
        );
      }, this.shutdownTimeout);
      this.activeTimeouts.add(timeoutId);
    });
  }

  /**
   * 상세한 배치 작업 상태 반환 (모니터링용)
   */
  getDetailedBatchJobStatus(): {
    jobCount: number;
    jobIds: string[];
    isShuttingDown: boolean;
    activeTimeouts: number;
  } {
    return {
      jobCount: this.jobQueue.size,
      jobIds: Array.from(this.jobQueue.keys()),
      isShuttingDown: this.isShuttingDown,
      activeTimeouts: this.activeTimeouts.size,
    };
  }
}
