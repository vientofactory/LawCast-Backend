import { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');
  const frontendUrls = configService.get<string>('FRONTEND_URL')
    ? configService.get<string>('FRONTEND_URL').split(',')
    : ['http://localhost:5173'];

  app.enableCors({
    origin: frontendUrls,
    credentials: true,
  });
  app.setGlobalPrefix('');
  app.disable('x-powered-by');

  const port = configService.get<number>('PORT') || 3001;
  await app.listen(port);

  logger.log(`LawCast Backend is running on port ${port}`);
}
bootstrap();
