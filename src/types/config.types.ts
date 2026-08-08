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
      OLLAMA_ENABLED?: string;
      OLLAMA_CPU_MODE?: string;
      OLLAMA_API_URL?: string;
      OLLAMA_MODEL?: string;
      OLLAMA_TIMEOUT?: string;
      ARCHIVE_SYNC_SUMMARY_BACKFILL_CPU_BATCH_SIZE?: string;
      ARCHIVE_SYNC_SUMMARY_BACKFILL_CPU_BATCH_DELAY_MS?: string;
      ARCHIVE_SYNC_SUMMARY_BACKFILL_CPU_CONCURRENCY?: string;
      FILE_MIRROR_ENABLED?: string;
      FILE_MIRROR_CRON?: string;
      FILE_MIRROR_API_BASE_URL?: string;
      FILE_MIRROR_DUMP_DIR?: string;
      FILE_MIRROR_TITLE_PREFIX?: string;
      FILE_MIRROR_KEEP_LOCAL_DUMP?: string;
      FILE_MIRROR_TEST_UPLOAD_ON_STARTUP?: string;
      FILE_MIRROR_DISCORD_CHANNEL_ID?: string;
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
