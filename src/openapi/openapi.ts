import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const OPENAPI_HOST = '127.0.0.1';

export function isLocalOpenApiEnabled(
  nodeEnv: string | undefined,
  flag: string | undefined,
): boolean {
  return nodeEnv === 'development' && flag === 'true';
}

export function setupOpenApi(
  app: INestApplication,
  port: number,
  getVersion: () => string,
): void {
  SwaggerModule.setup(
    'docs',
    app,
    () =>
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle('LawCast API')
          .setDescription('LawCast 로컬 개발 및 Bruno 테스트용 API 명세')
          .setVersion(getVersion())
          .setOpenAPIVersion('3.1.0')
          .addServer(`http://${OPENAPI_HOST}:${port}`, '로컬 개발 서버')
          .build(),
        {
          operationIdFactory: (controller, method) => `${controller}_${method}`,
        },
      ),
    {
      jsonDocumentUrl: 'openapi.json',
      raw: ['json'],
      swaggerOptions: { validatorUrl: null },
    },
  );
}
