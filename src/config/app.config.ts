export interface AppConfig {
  port: number;
  nodeEnv: string;
  database: {
    type: 'sqlite';
    path: string;
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
  CACHE: {
    MAX_SIZE: 50,
    DEFAULT_LIMIT: 10,
    NOTICES_RECENT_LIMIT: 20,
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
} as const;

export default (): AppConfig => ({
  port: parseInt(process.env.PORT, 10) || APP_CONSTANTS.DEFAULT_PORT,
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    type: 'sqlite',
    path: process.env.DATABASE_PATH || 'lawcast.db',
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
