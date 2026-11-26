import cronstrue from 'cronstrue/i18n';
import { APP_CONSTANTS } from '../../config/app.config';

/**
 * Maps known cron expressions to interval (ms) for UI timer calculations.
 */
const CRON_INTERVAL_MAP: Record<string, number> = {
  [APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK]: 600_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.PENDING_CRAWLING_CHECK]: 1_200_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.IS_DONE_SYNC]: 21_600_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.PROPOSAL_REASON_BACKFILL_DRAIN]: 900_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.INTEGRITY_RESCAN]: 86_400_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.CHANGE_TRACKING_DAILY_AUDIT]: 86_400_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.CHANGE_TRACKING_WEEKLY_AUDIT]: 604_800_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_CLEANUP]: 86_400_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.WEB_PUSH_CLEANUP]: 3_600_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.QUICK_KEYWORDS_REFRESH]: 3_600_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.SQLITE_VACUUM]: 604_800_000,
};

const MAX_DESCRIPTIONS = 64;
const descriptions = new Map<string, string>();

/** Cache immutable presentation text, never crawler status or runtime schedule selection. */
export function describeCron(expression: string): string {
  const cached = descriptions.get(expression);
  if (cached !== undefined) return cached;
  let description: string;
  try {
    description = cronstrue.toString(expression, {
      locale: 'ko',
      use24HourTimeFormat: true,
    });
  } catch {
    description = expression;
  }
  if (descriptions.size >= MAX_DESCRIPTIONS)
    descriptions.delete(descriptions.keys().next().value);
  descriptions.set(expression, description);
  return description;
}

/** Keep status cron objects and transparency intervals on the same presentation path. */
export function getCronSchedule(expression?: string): {
  expression: string;
  intervalMs: number;
  description: string;
} {
  if (!expression) return { expression: '', intervalMs: 0, description: '' };
  return {
    expression,
    intervalMs: CRON_INTERVAL_MAP[expression] ?? 0,
    description: describeCron(expression),
  };
}
