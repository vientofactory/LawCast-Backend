import { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BatchProcessingService } from './modules/shared/batch-processing.service';
import { WebhookValidationUtils } from './utils/webhook-validation.utils';
import { DiscordBridgeService } from './modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from './modules/discord-bridge/discord-bridge.types';
import { CrawlingSchedulerService } from './modules/crawling/crawling-scheduler.service';
import { ArchiveSyncService } from './modules/crawling/archive-sync.service';
import { LoggerUtils } from './utils/logger.utils';
import { logAndBridge } from './utils/bridge-log.utils';

if (!process.env.TZ) {
  process.env.TZ = 'Asia/Seoul';
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const dataSource = app.get(DataSource);
  const batchProcessingService = app.get(BatchProcessingService);
  const discordBridge = app.get(DiscordBridgeService);
  const crawlingSchedulerService = app.get(CrawlingSchedulerService);
  const archiveSyncService = app.get(ArchiveSyncService);
  const loggerContext = 'Bootstrap';
  const frontendUrls = configService.get<string[]>('frontend.urls');
  const { getValidationPipeOptions } = WebhookValidationUtils;

  // Initialize shutdown handlers
  app.enableShutdownHooks();
  initShutdownHandlers(
    app,
    batchProcessingService,
    crawlingSchedulerService,
    archiveSyncService,
    loggerContext,
    discordBridge,
  );

  logDatabasePath(dataSource, loggerContext);

  // Ensure database migrations are applied before starting the application
  await ensureDatabaseMigrations(dataSource, loggerContext);

  // initialize global validation pipe with custom options
  app.useGlobalPipes(new ValidationPipe(getValidationPipeOptions()));

  // Enable CORS for frontend URLs
  app.enableCors({
    origin: frontendUrls,
    credentials: true,
  });

  // Set global prefix and disable some headers for security
  app.setGlobalPrefix('');
  app.disable('x-powered-by');

  const port = configService.get<number>('port');
  await app.listen(port);

  LoggerUtils.log(loggerContext, `LawCast Backend is running on port ${port}`);
}

/**
 * Ensures that all pending TypeORM migrations are applied before the application starts accepting requests.
 * This function checks for pending migrations and runs them if necessary, logging the process.
 * If migrations fail, it will throw an error to prevent the application from starting in an inconsistent state.
 * @param dataSource The TypeORM DataSource instance used to manage database connections and migrations.
 * @param logger The NestJS Logger instance for logging migration status and errors.
 * @returns A Promise that resolves when migrations are complete or rejects if there is an error.
 * @throws Will throw an error if migration execution fails, preventing the application from starting.
 */
async function ensureDatabaseMigrations(
  dataSource: DataSource,
  loggerContext: string,
): Promise<void> {
  LoggerUtils.log(loggerContext, 'Checking TypeORM migration status...');

  const hasPendingMigrations = await dataSource.showMigrations();
  if (!hasPendingMigrations) {
    LoggerUtils.log(loggerContext, 'Database migrations are up to date');
    return;
  }

  LoggerUtils.warn(
    loggerContext,
    'Pending migrations detected. Running migrations during bootstrap...',
  );

  const result = await dataSource.runMigrations({ transaction: 'all' });
  LoggerUtils.log(
    loggerContext,
    `Migration initialization completed (${result.length} migration(s) applied)`,
  );
}

/**
 * Performs a graceful shutdown of the application, ensuring that ongoing batch jobs are completed
 * and the NestJS application is properly closed.
 * @param app The NestJS application instance to be closed during shutdown.
 * @param batchProcessingService The BatchProcessingService instance to ensure batch jobs are completed before shutdown.
 * @param logger The NestJS Logger instance for logging shutdown events and errors.
 * @param exitCode The exit code to use when terminating the process. Defaults to 0.
 */
async function gracefulShutdown(
  app: NestExpressApplication,
  batchProcessingService: BatchProcessingService,
  crawlingSchedulerService: CrawlingSchedulerService,
  archiveSyncService: ArchiveSyncService,
  loggerContext: string,
  exitCode = 0,
): Promise<void> {
  const shutdownTimeout = 30000; // 30 seconds
  let shutdownTimer: NodeJS.Timeout;

  try {
    // Forceful shutdown timer
    shutdownTimer = setTimeout(() => {
      LoggerUtils.error(
        loggerContext,
        'Graceful shutdown timeout, forcing exit...',
      );
      process.exit(1);
    }, shutdownTimeout);

    LoggerUtils.log(
      loggerContext,
      'Waiting for ongoing batch jobs to complete...',
    );

    const [archiveIdle, crawlingIdle] = await Promise.allSettled([
      archiveSyncService.waitForIdle(10000),
      crawlingSchedulerService.waitForIdle(10000),
    ]);

    if (archiveIdle.status === 'rejected') {
      LoggerUtils.warn(
        loggerContext,
        `Archive sync did not become idle before shutdown: ${String(archiveIdle.reason)}`,
      );
    }

    if (crawlingIdle.status === 'rejected') {
      LoggerUtils.warn(
        loggerContext,
        `Crawling scheduler did not become idle before shutdown: ${String(crawlingIdle.reason)}`,
      );
    }

    // Batch jobs graceful shutdown
    await batchProcessingService.gracefulShutdown();

    LoggerUtils.log(loggerContext, 'Closing NestJS application...');

    // NestJS application shutdown
    await app.close();

    LoggerUtils.log(loggerContext, 'Graceful shutdown completed successfully');

    // Clear timer
    clearTimeout(shutdownTimer);

    process.exit(exitCode);
  } catch (error) {
    LoggerUtils.error(loggerContext, 'Error during graceful shutdown:', error);
    clearTimeout(shutdownTimer!);
    process.exit(1);
  }
}

/**
 * Initializes handlers for graceful shutdown on SIGTERM and SIGINT signals,
 * as well as Node.js global runtime errors.
 * When the Discord bridge is connected, critical errors are also sent as alerts
 * to the configured Discord log channel before shutdown.
 * @param app The NestJS application instance to be closed during shutdown.
 * @param batchProcessingService The BatchProcessingService instance to ensure batch jobs are completed before shutdown.
 * @param logger The NestJS Logger instance for logging shutdown events and errors.
 * @param discordBridge The DiscordBridgeService instance used to forward critical alerts to Discord.
 */
function initShutdownHandlers(
  app: NestExpressApplication,
  batchProcessingService: BatchProcessingService,
  crawlingSchedulerService: CrawlingSchedulerService,
  archiveSyncService: ArchiveSyncService,
  loggerContext: string,
  discordBridge: DiscordBridgeService,
): void {
  process.on('SIGTERM', async () => {
    LoggerUtils.log(
      loggerContext,
      'SIGTERM received, starting graceful shutdown...',
    );
    await gracefulShutdown(
      app,
      batchProcessingService,
      crawlingSchedulerService,
      archiveSyncService,
      loggerContext,
    );
  });

  process.on('SIGINT', async () => {
    LoggerUtils.log(
      loggerContext,
      'SIGINT received, starting graceful shutdown...',
    );
    await gracefulShutdown(
      app,
      batchProcessingService,
      crawlingSchedulerService,
      archiveSyncService,
      loggerContext,
    );
  });

  // Node.js runtime warnings (e.g. MaxListenersExceeded, DeprecationWarning)
  process.on('warning', (warning) => {
    logAndBridge({
      logger: {
        warn: (message: string) => LoggerUtils.warn(loggerContext, message),
      },
      method: 'warn',
      message: `Node.js Warning [${warning.name}]: ${warning.message}`,
      context: `Warning:${warning.name}`,
      discordBridge,
      bridgeLevel: BridgeLogLevel.WARN,
      bridgeMessage: warning.message,
      metadata: warning.stack ? { stack: warning.stack } : undefined,
    });
  });

  // Unexpected error handling
  process.on('uncaughtException', async (error) => {
    LoggerUtils.error(loggerContext, 'Uncaught Exception:', error);
    await discordBridge.sendCriticalAlert(
      'UncaughtException',
      error.message,
      error,
    );
    await gracefulShutdown(
      app,
      batchProcessingService,
      crawlingSchedulerService,
      archiveSyncService,
      loggerContext,
      1,
    );
  });

  process.on('unhandledRejection', async (reason, promise) => {
    LoggerUtils.error(
      loggerContext,
      'Unhandled Rejection at:',
      promise,
      'reason:',
      reason,
    );
    const message =
      reason instanceof Error
        ? reason.message
        : `Unhandled promise rejection: ${String(reason)}`;
    await discordBridge.sendCriticalAlert(
      'UnhandledRejection',
      message,
      reason,
    );
    await gracefulShutdown(
      app,
      batchProcessingService,
      crawlingSchedulerService,
      archiveSyncService,
      loggerContext,
      1,
    );
  });
}

function logDatabasePath(dataSource: DataSource, loggerContext: string): void {
  const options = dataSource.options as { database?: unknown; type?: unknown };
  const dbType = String(options.type ?? 'unknown');
  const dbPath = typeof options.database === 'string' ? options.database : '';

  if (dbType === 'sqlite') {
    LoggerUtils.log(
      loggerContext,
      `SQLite database path: ${dbPath || '(not resolved)'}`,
    );
  }
}

bootstrap().catch((error) => {
  LoggerUtils.error('Bootstrap', 'Failed to start application:', error);
  process.exit(1);
});
