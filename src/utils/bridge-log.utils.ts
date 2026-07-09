import { type DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';

type LogMethod = 'log' | 'warn' | 'error' | 'debug' | 'verbose';

interface LoggerLike {
  log?(message: string, ...optionalParams: unknown[]): void;
  warn?(message: string, ...optionalParams: unknown[]): void;
  error?(message: string, ...optionalParams: unknown[]): void;
  debug?(message: string, ...optionalParams: unknown[]): void;
  verbose?(message: string, ...optionalParams: unknown[]): void;
}

const LOG_METHOD_TO_BRIDGE_LEVEL: Record<LogMethod, BridgeLogLevel> = {
  log: BridgeLogLevel.LOG,
  warn: BridgeLogLevel.WARN,
  error: BridgeLogLevel.ERROR,
  debug: BridgeLogLevel.DEBUG,
  verbose: BridgeLogLevel.VERBOSE,
};

export function logAndBridge(params: {
  logger?: LoggerLike;
  method: LogMethod;
  message: string;
  context: string;
  discordBridge?: DiscordBridgeService;
  bridgeLevel?: BridgeLogLevel;
  bridgeMessage?: string;
  metadata?: Record<string, unknown>;
  loggerArgs?: unknown[];
}): void {
  const {
    logger,
    method,
    message,
    context,
    discordBridge,
    bridgeLevel,
    bridgeMessage,
    metadata,
    loggerArgs,
  } = params;

  logger?.[method]?.(message, ...(loggerArgs ?? []));

  void discordBridge?.logEvent(
    bridgeLevel ?? LOG_METHOD_TO_BRIDGE_LEVEL[method],
    context,
    bridgeMessage ?? message,
    metadata,
  );
}
