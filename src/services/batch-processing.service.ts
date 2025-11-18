import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { type ITableData } from 'pal-crawl';
import { WebhookService } from './webhook.service';
import { NotificationService } from './notification.service';
import { LoggerUtils } from '../utils/logger.utils';

export interface BatchJobResult<T = any> {
  success: boolean;
  data?: T;
  error?: Error;
  duration: number;
  notice?: string;
  totalWebhooks?: number;
  successCount?: number;
  failedCount?: number;
  deactivated?: number;
  temporaryFailures?: number;
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
  ): Promise<string> {
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
    LoggerUtils.logDev(
      this.logger,
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
        this.logger.error('Batch processing error:', error);
      })
      .finally(() => {
        this.jobQueue.delete(jobId);
        LoggerUtils.logDev(this.logger, `Batch job ${jobId} cleaned up`);
      });

    LoggerUtils.logDev(this.logger, `Notification batch job ${jobId} started`);

    return jobId;
  }

  /**
   * 실제 알림 배치 실행
   */
  private async executeNotificationBatch(
    notices: ITableData[],
    options: BatchProcessingOptions,
  ): Promise<BatchJobResult[]> {
    // 각 입법예고별로 배치 작업 생성
    const notificationJobs = notices.map((notice) => async () => {
      // 각 알림마다 최신 웹훅 리스트를 독립적으로 가져옴
      const currentWebhooks = await this.webhookService.findAll();

      if (currentWebhooks.length === 0) {
        LoggerUtils.logDev(
          this.logger,
          'No active webhooks available for notification',
        );
        return {
          notice: notice.subject,
          totalWebhooks: 0,
          successCount: 0,
          failedCount: 0,
          deactivated: 0,
          temporaryFailures: 0,
        };
      }

      const results =
        await this.notificationService.sendDiscordNotificationBatch(
          notice,
          currentWebhooks,
        );

      // 영구적으로 삭제해야 할 웹훅들과 일시적으로 실패한 웹훅들 분리
      const permanentFailures = results.filter(
        (result) => !result.success && result.shouldDelete,
      );
      const temporaryFailures = results.filter(
        (result) => !result.success && !result.shouldDelete,
      );

      // 영구적으로 실패한 웹훅들은 비활성화
      if (permanentFailures.length > 0) {
        const permanentFailureIds = permanentFailures.map(
          (result) => result.webhookId,
        );

        // 각 웹훅을 개별적으로 비활성화
        for (const webhookId of permanentFailureIds) {
          try {
            await this.webhookService.remove(webhookId);
          } catch (error) {
            this.logger.error(
              `Failed to deactivate webhook ${webhookId}:`,
              error,
            );
          }
        }

        this.logger.log(
          `Deactivated ${permanentFailures.length} permanently failed webhooks for notice: ${notice.subject}`,
        );
      }

      // 일시적 실패는 로그 최소화
      if (temporaryFailures.length > 0) {
        LoggerUtils.logDev(
          this.logger,
          `${temporaryFailures.length} webhooks failed temporarily for notice: ${notice.subject}`,
        );
      }

      const successCount = results.filter((r) => r.success).length;

      return {
        notice: notice.subject,
        totalWebhooks: currentWebhooks.length,
        successCount,
        failedCount: permanentFailures.length + temporaryFailures.length,
        deactivated: permanentFailures.length,
        temporaryFailures: temporaryFailures.length,
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

    LoggerUtils.debugDev(
      this.logger,
      `Active job IDs: ${jobStatus.jobIds.join(', ')}`,
    );

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
