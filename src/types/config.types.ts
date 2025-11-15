import { AppConfig } from '../config/app.config';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      PORT?: string;
      NODE_ENV?: 'development' | 'production' | 'test';
      DATABASE_PATH?: string;
      RECAPTCHA_SECRET_KEY?: string;
      CRON_TIMEZONE?: string;
      FRONTEND_URL?: string;
    }
  }
}

// ConfigService용 타입 확장
declare module '@nestjs/config' {
  interface ConfigService {
    get<T = any>(propertyPath: keyof AppConfig | string): T | undefined;
    get<T = any>(propertyPath: keyof AppConfig | string, defaultValue: T): T;
  }
}

export {};
