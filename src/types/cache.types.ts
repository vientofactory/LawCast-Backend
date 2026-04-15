import { type ITableData } from 'pal-crawl';

export interface CacheInfo {
  size: number;
  lastUpdated: Date | null;
  maxSize: number;
  isInitialized: boolean;
}

export interface CachedNotice extends ITableData {
  aiSummary?: string | null;
}
