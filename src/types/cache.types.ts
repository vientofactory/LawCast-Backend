import { type ITableData } from 'pal-crawl';

export type AISummaryStatus =
  | 'ready'
  | 'unavailable'
  | 'not_supported'
  | 'not_requested';

export interface CacheInfo {
  size: number;
  lastUpdated: Date | null;
  maxSize: number;
  isInitialized: boolean;
}

export interface CachedNotice extends ITableData {
  aiSummary?: string | null;
  aiSummaryStatus?: AISummaryStatus;
}
