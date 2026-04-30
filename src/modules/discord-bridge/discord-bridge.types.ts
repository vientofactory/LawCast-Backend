export enum BridgeLogLevel {
  ERROR = 0,
  WARN = 1,
  LOG = 2,
  DEBUG = 3,
  VERBOSE = 4,
}

export const BRIDGE_LOG_LEVEL_LABELS: Record<BridgeLogLevel, string> = {
  [BridgeLogLevel.ERROR]: 'ERROR',
  [BridgeLogLevel.WARN]: 'WARN',
  [BridgeLogLevel.LOG]: 'INFO',
  [BridgeLogLevel.DEBUG]: 'DEBUG',
  [BridgeLogLevel.VERBOSE]: 'VERBOSE',
};

export const BRIDGE_LOG_LEVEL_COLORS: Record<BridgeLogLevel, number> = {
  [BridgeLogLevel.ERROR]: 0xff4444,
  [BridgeLogLevel.WARN]: 0xffa500,
  [BridgeLogLevel.LOG]: 0x3b82f6,
  [BridgeLogLevel.DEBUG]: 0x8b5cf6,
  [BridgeLogLevel.VERBOSE]: 0x6b7280,
};

export const BRIDGE_LOG_LEVEL_ICONS: Record<BridgeLogLevel, string> = {
  [BridgeLogLevel.ERROR]: '🔴',
  [BridgeLogLevel.WARN]: '🟡',
  [BridgeLogLevel.LOG]: '🔵',
  [BridgeLogLevel.DEBUG]: '🟣',
  [BridgeLogLevel.VERBOSE]: '⚫',
};

export interface BridgeCommandContext {
  currentLogLevel: BridgeLogLevel;
  setLogLevel: (level: BridgeLogLevel) => void;
  adminCount: number;
}

export function parseBridgeLogLevel(value: string | undefined): BridgeLogLevel {
  const map: Record<string, BridgeLogLevel> = {
    ERROR: BridgeLogLevel.ERROR,
    WARN: BridgeLogLevel.WARN,
    LOG: BridgeLogLevel.LOG,
    DEBUG: BridgeLogLevel.DEBUG,
    VERBOSE: BridgeLogLevel.VERBOSE,
  };
  return map[value?.toUpperCase() ?? ''] ?? BridgeLogLevel.LOG;
}
