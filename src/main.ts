import { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BatchProcessingService } from './services/batch-processing.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const batchProcessingService = app.get(BatchProcessingService);
  const logger = new Logger('Bootstrap');
  const frontendUrls = configService.get<string[]>('frontend.urls');

  app.enableCors({
    origin: frontendUrls,
    credentials: true,
  });
  app.setGlobalPrefix('');
  app.disable('x-powered-by');

  app.enableShutdownHooks();

  process.on('SIGTERM', async () => {
    logger.log('SIGTERM received, starting graceful shutdown...');
    await gracefulShutdown(app, batchProcessingService, logger);
  });

  process.on('SIGINT', async () => {
    logger.log('SIGINT received, starting graceful shutdown...');
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

  const port = configService.get<number>('port');
  await app.listen(port);

  logger.log(`LawCast Backend is running on port ${port}`);
}

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

bootstrap().catch((error) => {
  const logger = new Logger('Bootstrap');
  logger.error('Failed to start application:', error);
  process.exit(1);
});
