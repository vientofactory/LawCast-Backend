import path from 'node:path';

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
  hashguard: {
    apiUrl: string;
    apiKey: string;
  };
  ollama: {
    enabled: boolean;
    apiUrl: string;
    model: string;
    timeout: number;
  };
  frontend: {
    urls: string[];
  };
  cron: {
    timezone: string;
  };
  discordBridge: {
    enabled: boolean;
    botToken: string;
    guildId: string;
    bridgeChannelId: string;
    logChannelId: string;
    logLevel: number;
    adminUserIds: string[];
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
    // Only output debug logs in development environment
    DEVELOPMENT_ONLY: {
      DEBUG: true,
      VERBOSE: true,
    },
  },
  CACHE: {
    /** Internal storage cap - large enough to hold all active notices. */
    MAX_SIZE: 5000,
    /** Default limit for API responses that expose recent notices. */
    DEFAULT_LIMIT: 10,
    NOTICES_RECENT_LIMIT: 10,
    TTL: {
      NOTICES: 30 * 60 * 1000, // 30 minutes (milliseconds)
      CACHE_INFO: 60 * 1000, // 1 minute (milliseconds)
      STATS: 5 * 60 * 1000, // 5 minutes (milliseconds)
      QUICK_KEYWORDS: 60 * 60 * 1000, // 1 hour (milliseconds)
    },
    KEYS: {
      RECENT_NOTICES: 'recent_notices',
      CACHE_INFO: 'cache_info',
      NEW_NOTICES_SET: 'new_notices_set',
      LAST_UPDATED: 'last_updated',
      QUICK_KEYWORDS: 'quick_keywords',
    },
  },
  API: {
    PAGINATION: {
      DEFAULT_LIMIT: 10,
      MAX_LIMIT: 50,
      MIN_LIMIT: 1,
      MIN_PAGE: 1,
    },
    SEARCH: {
      MAX_LENGTH: 120,
    },
  },
  BATCH: {
    CONCURRENCY: 10,
    TIMEOUT: 30000,
    RETRY_COUNT: 3,
    RETRY_DELAY: 1000,
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
      RATE_LIMITS: {
        GLOBAL_PER_SECOND: 30, // 30 messages per second (global)
        PER_WEBHOOK_PER_MINUTE: 60, // 60 messages per minute per webhook
        RETRY_AFTER_HEADER: 'Retry-After',
        RESET_HEADER: 'X-RateLimit-Reset',
        REMAINING_HEADER: 'X-RateLimit-Remaining',
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
    TIMEOUT: 15000, // 15 seconds timeout
    RETRY_COUNT: 3, // 3 retries
    SUMMARY_CONCURRENCY: 3,
    /** Global max concurrent Chromium sessions across crawling/screenshot paths. */
    BROWSER_MAX_CONCURRENCY: parseIntWithDefault(
      process.env.CRAWLING_BROWSER_MAX_CONCURRENCY,
      1,
    ),
    /** Extra retries when browser launch fails due to process/resource pressure. */
    BROWSER_LAUNCH_RETRY_COUNT: parseIntWithDefault(
      process.env.CRAWLING_BROWSER_LAUNCH_RETRY_COUNT,
      2,
    ),
    /** Base delay (ms) between browser-launch retries. */
    BROWSER_LAUNCH_RETRY_DELAY_MS: parseIntWithDefault(
      process.env.CRAWLING_BROWSER_LAUNCH_RETRY_DELAY_MS,
      2000,
    ),
    /** Minimum interval (ms) between Chromium launch attempts to avoid spawn bursts. */
    BROWSER_MIN_LAUNCH_INTERVAL_MS: parseIntWithDefault(
      process.env.CRAWLING_BROWSER_MIN_LAUNCH_INTERVAL_MS,
      1500,
    ),
    /** When enabled, serialize browser-heavy tasks across processes with a file lock. */
    BROWSER_GLOBAL_LOCK_ENABLED: parseBooleanWithDefault(
      process.env.CRAWLING_BROWSER_GLOBAL_LOCK_ENABLED,
      true,
    ),
    /** Max wait (ms) to acquire cross-process browser lock before failing. */
    BROWSER_GLOBAL_LOCK_WAIT_TIMEOUT_MS: parseIntWithDefault(
      process.env.CRAWLING_BROWSER_GLOBAL_LOCK_WAIT_TIMEOUT_MS,
      120000,
    ),
    /** Stale lock TTL (ms). Older lock files are evicted as abandoned. */
    BROWSER_GLOBAL_LOCK_STALE_MS: parseIntWithDefault(
      process.env.CRAWLING_BROWSER_GLOBAL_LOCK_STALE_MS,
      300000,
    ),
    /** Global cooldown (ms) after launch resource-pressure failures (EAGAIN/posix_spawn). */
    BROWSER_RESOURCE_COOLDOWN_MS: parseIntWithDefault(
      process.env.CRAWLING_BROWSER_RESOURCE_COOLDOWN_MS,
      15000,
    ),
    HEADERS: {
      'Accept-Language': 'ko-KR,ko;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Cache-Control': 'no-cache',
    },
  },
  SCREENSHOT: {
    /** Headless Chromium viewport width (px). Narrower viewport → smaller file. */
    WIDTH: 1280,
    /** Initial viewport height (px). Actual capture height is determined by fullPage. */
    HEIGHT: 900,
    /** JPEG quality 0-100. 65 yields ~100-400KB for text-heavy government pages. */
    QUALITY: 65,
    /** Hard upper limit per screenshot - discard anything exceeding this. */
    MAX_SIZE_BYTES: 512 * 1024, // 500 KiB
    /** Max notices to backfill per bootstrap run (prevents runaway Chromium sessions on large DBs). */
    BACKFILL_BATCH_SIZE: 200,
    /** JPEG quality levels tried in order when the raw capture exceeds MAX_SIZE_BYTES. */
    FALLBACK_QUALITIES: [50, 35, 20] as const,
    /** Max retry attempts per notice before the item is skipped for this session. */
    MAX_RETRIES: 3,
    /** Delay (ms) before each retry attempt to avoid hammering the target server. */
    RETRY_DELAY_MS: 5000,
    /**
     * Inter-capture delay (ms) applied between consecutive NsmLmSts
     * (opinion.lawmaking.go.kr) screenshot requests to stay within the
     * site's rate limit.  Pal.assembly.go.kr does not require this because
     * Puppeteer navigates a stateless content-viewer URL.
     */
    NSM_INTER_CAPTURE_DELAY_MS: 3000,
    QUEUE: {
      KEY: 'crawling:screenshotQueue',
      MAX_SIZE: 20_000,
      TTL_SECONDS: 7 * 24 * 60 * 60,
    },
  },
  ARCHIVE_SYNC: {
    /** Items per crawler HTTP request (max 100). */
    CRAWLER_PAGE_UNIT: 100,
    /** Inter-page delay for bootstrap/full-sync crawls (ms). */
    CRAWLER_DELAY_MS: 500,
    /** Inter-page delay for hot-path cron crawls (ms). */
    CRAWLER_CRON_DELAY_MS: 100,
    NSM_CRAWLER_DELAY_MS: 3000, // NsmLmSts requires a longer delay to avoid connection resets
    /** Application-level retry budget for pending-bills cron (NsmLmSts). */
    PENDING_CRAWL_MAX_RETRIES: 5,
    /** Base delay (ms) for exponential backoff between pending-bills cron retries. */
    PENDING_CRAWL_RETRY_BASE_MS: 3000,
    /** Max attempts for the proposalReason in-memory retry queue before giving up. */
    NSM_REASON_RETRY_MAX_ATTEMPTS: 5,
    /** Max age (ms) for items in the proposalReason retry queue before they are evicted. */
    NSM_REASON_RETRY_MAX_AGE_MS: 24 * 60 * 60 * 1000,
    PROPOSAL_REASON_RETRY_QUEUE: {
      KEY: 'crawling:proposalReasonRetryQueue',
      MAX_SIZE: 5000,
      TTL_SECONDS: Math.ceil((24 * 60 * 60 * 1000) / 1000) * 2,
    },
    HTML_BACKFILL_RESULT_ZERO: {
      pal: { processed: 0, failed: 0 },
      nsm: { processed: 0, failed: 0 },
    },
    /** DB rows fetched per revert-pass batch. */
    DONE_BATCH_SIZE: 500,
    /** Archive rows per integrity-scan batch. */
    INTEGRITY_BATCH_SIZE: 200,
    /** Archive rows fetched per summary-backfill / retry batch. */
    SUMMARY_BACKFILL_BATCH_SIZE: 20,
  },
  CRON: {
    EXPRESSIONS: {
      CRAWLING_CHECK: '2-59/10 * * * *', // Every 10 minutes, shifted to avoid minute-0 contention
      PENDING_CRAWLING_CHECK: '6-59/20 * * * *', // Every 20 minutes, staggered from main crawl
      WEBHOOK_CLEANUP: '1 0 * * *', // Every day at 00:01
      WEBHOOK_OPTIMIZATION: '1 2 * * *', // Every day at 02:01
      SYSTEM_MONITORING: '0 * * * *', // Every hour
      IS_DONE_SYNC: '13 */6 * * *', // Every 6 hours, staggered away from heavy minute-0 jobs
      PROPOSAL_REASON_BACKFILL_DRAIN: '9-59/15 * * * *', // Every 15 minutes at 9/24/39/54, staggered from crawl/pending/isDone
      INTEGRITY_RESCAN: '43 3 * * *', // Daily at 03:43, isolated from top-of-hour workload
      CHANGE_TRACKING_DAILY_AUDIT: '7 4 * * *', // Daily at 04:07 after integrity rescan
      CHANGE_TRACKING_WEEKLY_AUDIT: '19 4 * * 1', // Every Monday at 04:19
      QUICK_KEYWORDS_REFRESH: '11 * * * *', // Every hour, refresh homepage keyword suggestions
      SQLITE_VACUUM: '31 5 * * 0', // Every Sunday at 05:31, after nightly maintenance tasks
    },
  },
} as const;

export default (): AppConfig => ({
  port: parseInt(process.env.PORT, 10) || APP_CONSTANTS.DEFAULT_PORT,
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    type: 'sqlite',
    path: resolveDatabasePath(process.env.DATABASE_PATH),
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'lawcast:',
    ttl: parseInt(process.env.REDIS_TTL, 10) || 30 * 60, // 30 minutes (seconds)
  },
  hashguard: {
    apiUrl: process.env.HASHGUARD_API_URL || 'https://hashguard.viento.me',
    apiKey: process.env.HASHGUARD_API_KEY || '',
  },
  ollama: {
    enabled:
      process.env.OLLAMA_ENABLED !== undefined
        ? process.env.OLLAMA_ENABLED.toLowerCase() === 'true'
        : !!process.env.OLLAMA_API_URL?.trim() &&
          !!process.env.OLLAMA_MODEL?.trim(),
    apiUrl: process.env.OLLAMA_API_URL?.trim() || '',
    model: process.env.OLLAMA_MODEL?.trim() || '',
    timeout: parseInt(process.env.OLLAMA_TIMEOUT, 10) || 10000,
  },
  frontend: {
    urls: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(',').map((url) => url.trim())
      : ['http://localhost:5173'],
  },
  cron: {
    timezone: process.env.CRON_TIMEZONE || 'Asia/Seoul',
  },
  discordBridge: {
    enabled: process.env.DISCORD_BRIDGE_ENABLED === 'true',
    botToken: process.env.DISCORD_BRIDGE_BOT_TOKEN ?? '',
    guildId: process.env.DISCORD_BRIDGE_GUILD_ID ?? '',
    bridgeChannelId: process.env.DISCORD_BRIDGE_CHANNEL_ID ?? '',
    logChannelId: process.env.DISCORD_BRIDGE_LOG_CHANNEL_ID ?? '',
    logLevel: parseBridgeLogLevel(process.env.DISCORD_BRIDGE_LOG_LEVEL),
    adminUserIds: process.env.DISCORD_BRIDGE_ADMIN_USER_IDS
      ? process.env.DISCORD_BRIDGE_ADMIN_USER_IDS.split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : [],
  },
});

function resolveDatabasePath(configuredPath: string | undefined): string {
  const normalizedPath = configuredPath?.trim() || 'lawcast.db';
  if (path.isAbsolute(normalizedPath)) {
    return normalizedPath;
  }

  // Resolve relative SQLite paths against backend project root, not process.cwd.
  return path.resolve(__dirname, '..', '..', normalizedPath);
}

function parseBridgeLogLevel(value: string | undefined): number {
  const map: Record<string, number> = {
    ERROR: 0,
    WARN: 1,
    LOG: 2,
    DEBUG: 3,
    VERBOSE: 4,
  };
  return map[value?.toUpperCase() ?? ''] ?? 2; // default: LOG
}

function parseBooleanWithDefault(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value == null) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseIntWithDefault(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = parseInt(value ?? '', 10);
  return isNaN(parsed) ? fallback : parsed;
}
