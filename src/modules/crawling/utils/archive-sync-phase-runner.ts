import { BridgeLogLevel } from '../../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../../utils/logger.utils';

export type ArchiveSyncPhaseStatus = 'idle' | 'running' | 'failed';

export interface ArchiveSyncPhaseState<TResult> {
  status: ArchiveSyncPhaseStatus;
  lastRunAt: string | null;
  lastResult: TResult | null;
  lastError: string | null;
}

export interface PhaseTracker<TResult> extends ArchiveSyncPhaseState<TResult> {
  isRunning: boolean;
}

export interface PhaseEntry {
  name: string;
  tracker: PhaseTracker<unknown>;
}

interface RunPhaseOptions<TResult> {
  phaseName: string;
  tracker: PhaseTracker<TResult>;
  trigger: string;
  task: () => Promise<TResult>;
  formatResult?: (result: TResult) => string;
  crossPhaseGuard?: boolean;
  phaseEntries: PhaseEntry[];
  serviceName: string;
  discordLogger?: (
    level: BridgeLogLevel,
    serviceName: string,
    message: string,
  ) => void;
}

export function makePhaseTracker<T>(): PhaseTracker<T> {
  return {
    isRunning: false,
    status: 'idle',
    lastRunAt: null,
    lastResult: null,
    lastError: null,
  };
}

export class ArchiveSyncPhaseRunner {
  isAnyPhaseRunning(phaseEntries: PhaseEntry[]): boolean {
    return phaseEntries.some(({ tracker }) => tracker.isRunning);
  }

  async runPhase<TResult>({
    phaseName,
    tracker,
    trigger,
    task,
    formatResult,
    crossPhaseGuard = false,
    phaseEntries,
    serviceName,
    discordLogger,
  }: RunPhaseOptions<TResult>): Promise<TResult | null> {
    if (tracker.isRunning) {
      LoggerUtils.warn(
        serviceName,
        `${phaseName} already in progress - skipping [${trigger}]`,
      );
      return null;
    }

    if (crossPhaseGuard) {
      const running = this.runningPhaseName(phaseEntries);
      if (running) {
        LoggerUtils.warn(
          serviceName,
          `${phaseName} skipped - another phase is in progress (${running}) [${trigger}]`,
        );
        discordLogger?.(
          BridgeLogLevel.WARN,
          serviceName,
          `**${phaseName}** skipped - \`${running}\` is already running [${trigger}]`,
        );
        return null;
      }
    }

    tracker.isRunning = true;
    tracker.status = 'running';
    tracker.lastError = null;

    try {
      const result = await task();
      tracker.status = 'idle';
      tracker.lastRunAt = new Date().toISOString();
      tracker.lastResult = result;
      tracker.lastError = null;
      if (formatResult) {
        discordLogger?.(
          BridgeLogLevel.DEBUG,
          serviceName,
          `[${trigger}] ${phaseName} - ${formatResult(result)}`,
        );
      }
      return result;
    } catch (error) {
      tracker.status = 'failed';
      tracker.lastRunAt = new Date().toISOString();
      tracker.lastError =
        error instanceof Error ? error.message : String(error);
      discordLogger?.(
        BridgeLogLevel.ERROR,
        serviceName,
        `[${trigger}] **${phaseName}** failed - ${(error as Error).message}`,
      );
      throw error;
    } finally {
      tracker.isRunning = false;
    }
  }

  toStatus<TResult>(
    tracker: PhaseTracker<TResult>,
  ): ArchiveSyncPhaseState<TResult> {
    const { isRunning: _, ...status } = tracker;
    return status;
  }

  private runningPhaseName(phaseEntries: PhaseEntry[]): string | null {
    return phaseEntries.find(({ tracker }) => tracker.isRunning)?.name ?? null;
  }
}
