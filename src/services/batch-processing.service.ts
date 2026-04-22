import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { LoggerUtils } from '../utils/logger.utils';
import { APP_CONSTANTS } from '../config/app.config';

const { BATCH } = APP_CONSTANTS;

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
  batchSize?: number;
}

@Injectable()
export class BatchProcessingService implements OnApplicationShutdown {
  private readonly logger = new Logger(BatchProcessingService.name);
  private readonly jobQueue = new Map<string, Promise<any>>();
  private readonly activeTimeouts = new Set<NodeJS.Timeout>();
  private isShuttingDown = false;
  private readonly shutdownTimeout = 25000;

  constructor() {}

  /**
   * Process a batch of jobs with configurable concurrency, timeouts, and retry logic.
   * Supports optional batch size for large job sets, and includes graceful shutdown handling.
   * @param jobs - Array of functions that return a Promise for each job to execute
   * @param options - Batch processing options such as concurrency, timeouts, retries, and batch size
   * @returns An array of results for each job, including success status, data, errors, and execution duration
   */
  async executeBatch<T>(
    jobs: Array<(abortSignal: AbortSignal) => Promise<T>>,
    options: BatchProcessingOptions = {},
  ): Promise<BatchJobResult<T>[]> {
    // Reject new batch jobs if service is shutting down
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

    const results: BatchJobResult<T>[] = [];

    // If batchSize is specified, split the jobs into batches of the given size and process sequentially
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
      // If batchSize is not specified or the number of jobs is less than or equal to batchSize, use the existing logic
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
   * Process a single batch by dividing it into chunks based on concurrency and executing them in parallel.
   * Includes retry logic with delay and timeout handling for each job, and collects results with execution duration.
   * @param jobs - Array of functions that return a Promise for each job to execute
   * @param concurrency - Number of jobs to execute in parallel
   * @param timeout - Maximum time in milliseconds to allow for each job before timing out
   * @param retryCount - Number of times to retry a failed job before giving up
   * @param retryDelay - Time in milliseconds to wait between retry attempts for a failed job
   * @returns An array of results for each job, including success status, data, errors, and execution duration
   */
  private async processBatch<T>(
    jobs: Array<(abortSignal: AbortSignal) => Promise<T>>,
    concurrency: number,
    timeout: number,
    retryCount: number,
    retryDelay: number,
  ): Promise<BatchJobResult<T>[]> {
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
   * Execute a job with retry logic, including delay between retries and timeout handling.
   * Each attempt is given a unique job ID for logging purposes.
   * @param job - Function that returns a Promise for the job to execute
   * @param retryCount - Number of times to retry a failed job before giving up
   * @param retryDelay - Time in milliseconds to wait between retry attempts for a failed job
   * @param timeout - Maximum time in milliseconds to allow for each job before timing out
   * @param jobId - Unique identifier for the job, used for logging
   * @returns The result of the job if successful
   * @throws The last error encountered if all retry attempts fail
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
   * Run a job with a timeout, using an AbortController to signal cancellation if the timeout is reached.
   * The timeout is tracked in the activeTimeouts set for proper cleanup during shutdown.
   * @param run - Function that returns a Promise for the job to execute
   * @param timeout - Maximum time in milliseconds to allow for the job before timing out
   * @param abortController - AbortController used to signal cancellation if the timeout is reached
   * @returns The result of the job if successful
   * @throws An error if the operation times out or if the job execution fails
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
   * Split an array into chunks of a specified size
   * @param array - The array to split
   * @param chunkSize - The size of each chunk
   * @returns An array of chunks
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Delay execution for a specified number of milliseconds, tracking the timeout for proper cleanup during shutdown
   * @param ms - Time in milliseconds to delay
   * @returns A Promise that resolves after the specified delay
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
   * Get the current status of batch jobs, including the count of active jobs and their IDs.
   * @returns An object containing the count of active jobs and their IDs
   */
  getBatchJobStatus(): { jobCount: number; jobIds: string[] } {
    return {
      jobCount: this.jobQueue.size,
      jobIds: Array.from(this.jobQueue.keys()),
    };
  }

  /**
   * Wait for a specific batch job to complete
   * @param jobId - The ID of the batch job to wait for
   * @returns A Promise that resolves when the specified batch job completes
   */
  async waitForBatchJob(jobId: string): Promise<void> {
    const job = this.jobQueue.get(jobId);
    if (job) {
      await job;
    }
  }

  /**
   * Wait for all batch jobs to complete
   * @returns A Promise that resolves when all batch jobs have completed
   */
  async waitForAllBatchJobs(): Promise<void> {
    const jobs = Array.from(this.jobQueue.values());
    await Promise.allSettled(jobs);
  }

  /**
   * Clear all active timeouts (for testing purposes)
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
   * Graceful shutdown
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
      // Wait for all batch jobs to complete with a timeout
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
      // Clear all active timeouts
      this.clearAllTimeouts();
      this.logger.log('Batch processing service shutdown completed');
    }
  }

  /**
   * Check if the service is shutting down
   */
  isServiceShuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Force shutdown
   */
  forceShutdown(): void {
    this.logger.warn('Force shutdown initiated - canceling all active jobs');
    this.isShuttingDown = true;
    this.clearAllTimeouts();
    this.jobQueue.clear();
  }

  /**
   * Create a shutdown timeout Promise
   * @returns A Promise that rejects after the shutdown timeout duration
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
   * Get detailed batch job status
   * @returns An object containing detailed batch job status
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
