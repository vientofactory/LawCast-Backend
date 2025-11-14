import { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');
  const frontendUrls = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',')
    : ['http://localhost:5173', 'http://localhost:3000'];

  app.enableCors({
    origin: frontendUrls,
    credentials: true,
  });
  app.setGlobalPrefix('');
  app.disable('x-powered-by');

  const port = process.env.PORT || 3001;
  await app.listen(port);

  logger.log(`LawCast Backend is running on: http://localhost:${port}`);
}
bootstrap();
