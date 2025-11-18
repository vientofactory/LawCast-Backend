export interface AppConfig {
  port: number;
  nodeEnv: string;
  database: {
    type: 'sqlite';
    path: string;
  };
  redis: {
    url: string;
    keyPrefix: string;
    ttl: number;
  };
  recaptcha: {
    secretKey?: string;
  };
  frontend: {
    urls: string[];
  };
  cron: {
    timezone: string;
  };
}

// Application Constants
export const APP_CONSTANTS = {
  DEFAULT_PORT: 3001,
  LOG: {
    LEVELS: {
      ERROR: 0,
      WARN: 1,
      LOG: 2,
      DEBUG: 3,
      VERBOSE: 4,
    },
    // 개발 환경에서만 디버그 로그 출력
    DEVELOPMENT_ONLY: {
      DEBUG: true,
      VERBOSE: true,
    },
  },
  CACHE: {
    MAX_SIZE: 50,
    DEFAULT_LIMIT: 10,
    NOTICES_RECENT_LIMIT: 50,
    TTL: {
      NOTICES: 30 * 60 * 1000, // 30분 (밀리초)
      CACHE_INFO: 60 * 1000, // 1분 (밀리초)
      STATS: 5 * 60 * 1000, // 5분 (밀리초)
    },
    KEYS: {
      RECENT_NOTICES: 'recent_notices',
      CACHE_INFO: 'cache_info',
      NEW_NOTICES_SET: 'new_notices_set',
    },
  },
  DISCORD: {
    WEBHOOK: {
      URL_MAX_LENGTH: 500,
      SNOWFLAKE_ID_LENGTH: { MIN: 17, MAX: 20 },
      TOKEN_LENGTH: { MIN: 64, MAX: 68 },
      PATH_PARTS_MIN: 5,
    },
    API: {
      ERROR_CODES: {
        NOT_FOUND: 404,
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        TOO_MANY_REQUESTS: 429,
        INTERNAL_SERVER_ERROR: 500,
      },
    },
  },
  COLORS: {
    DISCORD: {
      PRIMARY: 0x3b82f6, // Blue
      SUCCESS: 0x10b981, // Green
    },
  },
  CRAWLING: {
    USER_AGENT: 'LawCast/1.0 (Legislative Notice Crawler)',
    TIMEOUT: 15000, // 15초 타임아웃
    RETRY_COUNT: 3, // 3회 재시도
    HEADERS: {
      'Accept-Language': 'ko-KR,ko;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Cache-Control': 'no-cache',
    },
  },
  CRON: {
    EXPRESSIONS: {
      CRAWLING_CHECK: '0 */10 * * * *', // 10분마다
      WEBHOOK_CLEANUP: '0 0 0 * * *', // 매일 자정
      WEBHOOK_OPTIMIZATION: '0 0 2 * * *', // 매일 새벽 2시
      SYSTEM_MONITORING: '0 0 * * * *', // 매시간
    },
  },
} as const;

export default (): AppConfig => ({
  port: parseInt(process.env.PORT, 10) || APP_CONSTANTS.DEFAULT_PORT,
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    type: 'sqlite',
    path: process.env.DATABASE_PATH || 'lawcast.db',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'lawcast:',
    ttl: parseInt(process.env.REDIS_TTL, 10) || 30 * 60, // 30분 (초 단위)
  },
  recaptcha: {
    secretKey: process.env.RECAPTCHA_SECRET_KEY,
  },
  frontend: {
    urls: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(',').map((url) => url.trim())
      : ['http://localhost:5173'],
  },
  cron: {
    timezone: process.env.CRON_TIMEZONE || 'Asia/Seoul',
  },
});
