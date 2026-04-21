import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { LoggerUtils } from '../utils/logger.utils';
import { APP_CONSTANTS } from '../config/app.config';

const { BATCH } = APP_CONSTANTS;

export interface BatchJobResult {
  success: boolean;
  duration: number;
  totalWebhooks?: number;
  successCount?: number;
  failedCount?: number;
  deactivated?: number;
  temporaryFailures?: number;
}

export interface RecentBatch {
  batchId: string;
  jobs: BatchJobResult[];
}

export interface BatchJobStatus {
  jobCount: number;
  jobIds: string[];
}

export interface BatchProcessingOptions {
  concurrency?: number;
  timeout?: number;
  retryCount?: number;
  retryDelay?: number;
  batchSize?: number;
}

@Injectable()
export class BatchProcessingService implements OnApplicationShutdown {
  private recentBatches: RecentBatch[] = [];
  private readonly logger = new Logger(BatchProcessingService.name);
  private readonly jobQueue = new Map<string, Promise<any>>();
  private readonly activeTimeouts = new Set<NodeJS.Timeout>();
  private isShuttingDown = false;
  private readonly shutdownTimeout = 25000;

  /**
   * 논블로킹 병렬 배치 작업 실행
   */
  async executeBatch(
    jobs: Array<(abortSignal: AbortSignal) => Promise<any>>,
    options: BatchProcessingOptions = {},
  ): Promise<BatchJobResult[]> {
    // 종료 중인 경우 새로운 작업 거부
    if (this.isShuttingDown) {
      this.logger.warn('Rejecting new batch job - service is shutting down');
      throw new Error('Service is shutting down, cannot process new jobs');
    }

    const {
      concurrency = BATCH.CONCURRENCY,
      timeout = BATCH.TIMEOUT,
      retryCount = BATCH.RETRY_COUNT,
      retryDelay = BATCH.RETRY_DELAY,
      batchSize,
    } = options;

    const results: BatchJobResult[] = [];

    // batchSize가 지정된 경우 전체 작업을 배치 크기로 나누어 순차적으로 처리
    if (batchSize && jobs.length > batchSize) {
      const jobBatches = this.chunkArray(jobs, batchSize);

      for (const jobBatch of jobBatches) {
        LoggerUtils.logDev(
          BatchProcessingService.name,
          `Processing batch of ${jobBatch.length} jobs (${results.length}/${jobs.length} completed)`,
        );

        const batchResults = await this.processBatch(
          jobBatch,
          concurrency,
          timeout,
          retryCount,
          retryDelay,
        );
        results.push(...batchResults);
      }
    } else {
      // batchSize가 없거나 작업 수가 batchSize 이하인 경우 기존 로직 사용
      results.push(
        ...(await this.processBatch(
          jobs,
          concurrency,
          timeout,
          retryCount,
          retryDelay,
        )),
      );
    }

    return results;
  }

  /**
   * 단일 배치를 concurrency로 나누어 병렬 처리
   */
  private async processBatch(
    jobs: Array<(abortSignal: AbortSignal) => Promise<any>>,
    concurrency: number,
    timeout: number,
    retryCount: number,
    retryDelay: number,
  ): Promise<BatchJobResult[]> {
    const results: BatchJobResult[] = [];
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

  // 범용 배치 관리 메서드
  registerJob(jobId: string, promise: Promise<BatchJobResult[]>) {
    this.jobQueue.set(jobId, promise);
  }
  unregisterJob(jobId: string) {
    this.jobQueue.delete(jobId);
  }
  addRecentBatch(jobId: string, jobs: BatchJobResult[]) {
    this.recentBatches.unshift({ batchId: jobId, jobs });
    if (this.recentBatches.length > 5) {
      this.recentBatches = this.recentBatches.slice(0, 5);
    }
  }

  // 최근 배치 5개 반환
  getRecentBatches(): RecentBatch[] {
    return this.recentBatches;
  }

  /**
   * 재시도 로직이 포함된 작업 실행
   */
  private async executeJobWithRetry<T>(
    job: (abortSignal: AbortSignal) => Promise<T>,
    retryCount: number,
    retryDelay: number,
    timeout: number,
    jobId: string,
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= retryCount + 1; attempt++) {
      const abortController = new AbortController();
      try {
        return await this.runJobWithTimeout(
          () => job(abortController.signal),
          timeout,
          abortController,
        );
      } catch (error) {
        lastError = error as Error;
        abortController.abort();

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
   * 타임아웃과 취소를 포함한 단일 작업 실행
   */
  private runJobWithTimeout<T>(
    run: () => Promise<T>,
    timeout: number,
    abortController: AbortController,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.activeTimeouts.delete(timeoutId);
        abortController.abort();
        reject(new Error(`Operation timed out after ${timeout}ms`));
      }, timeout);
      this.activeTimeouts.add(timeoutId);

      run()
        .then((result) => {
          this.activeTimeouts.delete(timeoutId);
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          this.activeTimeouts.delete(timeoutId);
          clearTimeout(timeoutId);
          reject(error);
        });
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
  getBatchJobStatus(): BatchJobStatus {
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
      BatchProcessingService.name,
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
