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

type CachedBaseNotice = Omit<ITableData, 'numComments'>;

export interface CachedNotice extends CachedBaseNotice {
  aiSummary?: string | null;
  aiSummaryStatus?: AISummaryStatus;
}
