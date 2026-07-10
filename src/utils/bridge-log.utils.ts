import { type DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';

type LogMethod =
  | 'debugDev'
  | 'logDev'
  | 'log'
  | 'logConditional'
  | 'warn'
  | 'error'
  | 'verbose'
  | 'debug';

interface LoggerLike {
  debugDev?(message: unknown, ...optionalParams: unknown[]): void;
  logDev?(message: unknown, ...optionalParams: unknown[]): void;
  log?(message: unknown, ...optionalParams: unknown[]): void;
  logConditional?(
    productionMessage: unknown,
    developmentMessage?: unknown,
    ...optionalParams: unknown[]
  ): void;
  warn?(message: unknown, ...optionalParams: unknown[]): void;
  error?(message: unknown, ...optionalParams: unknown[]): void;
  debug?(message: unknown, ...optionalParams: unknown[]): void;
  verbose?(message: unknown, ...optionalParams: unknown[]): void;
}

const LOG_METHOD_TO_BRIDGE_LEVEL: Record<LogMethod, BridgeLogLevel> = {
  debugDev: BridgeLogLevel.DEBUG,
  logDev: BridgeLogLevel.LOG,
  log: BridgeLogLevel.LOG,
  logConditional: BridgeLogLevel.LOG,
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
