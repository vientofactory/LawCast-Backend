import type { getAiSummaryTransparencyInfo } from '../ollama/ai-summary-prompt.util';

export interface ArchiveTransparencyTotals {
  total: number;
  palCount: number;
  nsmCount: number;
  byLifecycle: Record<string, number>;
}

export interface ChangeEventTransparencyTotals {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
}

export interface TransparencyStats {
  noticeSources: {
    id: 'pal' | 'nsm';
    name: string;
    url: string;
    description: string;
    noticeCount: number;
    intervalMs: number;
    intervalLabel: string;
  }[];
  collection: {
    totalNotices: number;
    byLifecycle: Record<string, number>;
    bySource: Record<string, number>;
  };
  changeTracking: { totalEvents: number; byType: Record<string, number> };
  schedules: {
    id: string;
    name: string;
    intervalMs: number;
    intervalLabel: string;
    description: string;
  }[];
  transferFlow: { description: string; nsmToPalIndicator: string };
  aiSummary: ReturnType<typeof getAiSummaryTransparencyInfo>;
}

export interface EventLoopDelayStats {
  min: number;
  max: number;
  mean: number;
  stddev: number;
  percentiles: { p50: number; p90: number; p99: number };
  exceeds: number;
  lastUpdated: number;
}
