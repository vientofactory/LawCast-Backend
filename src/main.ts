import { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BatchProcessingService } from './services/batch-processing.service';
import { WebhookValidationUtils } from './utils/webhook-validation.utils';
import { DiscordBridgeService } from './modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from './modules/discord-bridge/discord-bridge.types';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const dataSource = app.get(DataSource);
  const batchProcessingService = app.get(BatchProcessingService);
  const logger = new Logger('Bootstrap');
  const frontendUrls = configService.get<string[]>('frontend.urls');
  const { getValidationPipeOptions } = WebhookValidationUtils;

  // Initialize shutdown handlers
  app.enableShutdownHooks();
  const discordBridge = app.get(DiscordBridgeService);
  initShutdownHandlers(app, batchProcessingService, logger, discordBridge);

  // Ensure database migrations are applied before starting the application
  await ensureDatabaseMigrations(dataSource, logger);

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

  logger.log(`LawCast Backend is running on port ${port}`);

  void discordBridge.logEvent(
    BridgeLogLevel.LOG,
    'Bootstrap',
    `LawCast backend started on port **${port}**`,
    { nodeEnv: process.env.NODE_ENV, port },
  );
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
  logger: Logger,
): Promise<void> {
  logger.log('Checking TypeORM migration status...');

  const hasPendingMigrations = await dataSource.showMigrations();
  if (!hasPendingMigrations) {
    logger.log('Database migrations are up to date');
    return;
  }

  logger.warn(
    'Pending migrations detected. Running migrations during bootstrap...',
  );

  const result = await dataSource.runMigrations({ transaction: 'all' });
  logger.log(
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
  logger: Logger,
  exitCode = 0,
): Promise<void> {
  const shutdownTimeout = 30000; // 30 seconds
  let shutdownTimer: NodeJS.Timeout;

  try {
    // Forceful shutdown timer
    shutdownTimer = setTimeout(() => {
      logger.error('Graceful shutdown timeout, forcing exit...');
      process.exit(1);
    }, shutdownTimeout);

    logger.log('Waiting for ongoing batch jobs to complete...');

    // Batch jobs graceful shutdown
    await batchProcessingService.gracefulShutdown();

    logger.log('Closing NestJS application...');

    // NestJS application shutdown
    await app.close();

    logger.log('Graceful shutdown completed successfully');

    // Clear timer
    clearTimeout(shutdownTimer);

    process.exit(exitCode);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    clearTimeout(shutdownTimer!);
    process.exit(1);
  }
}

/**
 * Initializes handlers for graceful shutdown on SIGTERM and SIGINT signals, as well as unexpected errors.
 * @param app The NestJS application instance to be closed during shutdown.
 * @param batchProcessingService The BatchProcessingService instance to ensure batch jobs are completed before shutdown.
 * @param logger The NestJS Logger instance for logging shutdown events and errors.
 */
function initShutdownHandlers(
  app: NestExpressApplication,
  batchProcessingService: BatchProcessingService,
  logger: Logger,
  discordBridge?: DiscordBridgeService,
): void {
  process.on('SIGTERM', async () => {
    logger.log('SIGTERM received, starting graceful shutdown...');
    await discordBridge?.logEvent(
      BridgeLogLevel.WARN,
      'Bootstrap',
      'SIGTERM received — starting graceful shutdown',
    );
    await gracefulShutdown(app, batchProcessingService, logger);
  });

  process.on('SIGINT', async () => {
    logger.log('SIGINT received, starting graceful shutdown...');
    await discordBridge?.logEvent(
      BridgeLogLevel.WARN,
      'Bootstrap',
      'SIGINT received — starting graceful shutdown',
    );
    await gracefulShutdown(app, batchProcessingService, logger);
  });

  // Unexpected error handling
  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught Exception:', error);
    await gracefulShutdown(app, batchProcessingService, logger, 1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await gracefulShutdown(app, batchProcessingService, logger, 1);
  });
}

bootstrap().catch((error) => {
  const logger = new Logger('Bootstrap');
  logger.error('Failed to start application:', error);
  process.exit(1);
});
