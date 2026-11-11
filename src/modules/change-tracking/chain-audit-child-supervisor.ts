import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isolatedChildOptions } from '../../utils/child-process-entrypoint.util';
import {
  MAX_AUDIT_FAILURES,
  type ChainAuditLimits,
} from './chain-audit-limits';
import { type ChangeChainAuditReport } from './change-tracking.service';

export interface ChainAuditChildOptions {
  entrypoint: string;
  database: string;
  scope: 'daily' | 'weekly';
  limits: ChainAuditLimits;
  signal: AbortSignal;
}

function parseReport(
  value: unknown,
  scope: string,
): ChangeChainAuditReport | undefined {
  if (!value || typeof value !== 'object') return;
  const report = value as ChangeChainAuditReport;
  const count = (n: unknown) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (
    report.scope !== scope ||
    typeof report.checkedAt !== 'string' ||
    report.checkedAt.length > 40 ||
    !Number.isFinite(Date.parse(report.checkedAt)) ||
    !count(report.noticeCount) ||
    !count(report.eventCount) ||
    !count(report.failureCount) ||
    typeof report.checkpointRootHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(report.checkpointRootHash) ||
    !Array.isArray(report.failures) ||
    report.failures.length !== Math.min(report.failureCount, MAX_AUDIT_FAILURES)
  )
    return;
  if (
    !report.failures.every(
      (issue) =>
        issue &&
        count(issue.noticeNum) &&
        (issue.eventId === undefined || count(issue.eventId)) &&
        (issue.eventHeight === undefined || count(issue.eventHeight)) &&
        typeof issue.code === 'string' &&
        issue.code.length <= 80 &&
        typeof issue.message === 'string' &&
        issue.message.length <= 1024,
    )
  )
    return;
  return report;
}

export function superviseChainAuditChild(
  options: ChainAuditChildOptions,
): Promise<ChangeChainAuditReport> {
  if (options.signal.aborted)
    return Promise.reject(new Error('Chain audit cancelled'));
  return new Promise((resolve, reject) => {
    const child = fork(
      options.entrypoint,
      [options.database, options.scope, JSON.stringify(options.limits)],
      {
        ...isolatedChildOptions(options.entrypoint, options.limits.heapMb),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    let failure: Error | undefined;
    let result: ChangeChainAuditReport | undefined;
    let terminal = false;
    let checkingMemory = false;
    let closed = false;
    const stop = (error: Error) => {
      if (closed) return;
      failure ??= error;
      if (child.pid && !child.killed) child.kill('SIGKILL');
    };
    const abort = () => stop(new Error('Chain audit cancelled'));
    const deadline = setTimeout(
      () =>
        stop(new Error(`Chain audit exceeded ${options.limits.timeoutMs} ms`)),
      options.limits.timeoutMs,
    );
    deadline.unref();
    // Linux's external RSS watchdog can interrupt native SQLite work that cannot yield.
    const memoryTimer =
      process.platform === 'linux'
        ? setInterval(() => {
            if (checkingMemory || !child.pid || child.killed) return;
            checkingMemory = true;
            void readFile(`/proc/${child.pid}/status`, 'utf8')
              .then((status) => {
                const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
                if (rssKb > options.limits.rssMb * 1024)
                  stop(new Error('Chain audit RSS budget exceeded'));
              })
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT' && error.code !== 'ESRCH')
                  stop(error);
              })
              .finally(() => {
                checkingMemory = false;
              });
          }, 250)
        : undefined;
    memoryTimer?.unref();
    child.on('error', stop);
    child.on('message', (message: unknown) => {
      if (failure) return;
      if (!message || typeof message !== 'object' || terminal) {
        stop(new Error('Invalid chain audit child message'));
        return;
      }
      terminal = true;
      const payload = message as Record<string, unknown>;
      if (payload.type === 'result') {
        result = parseReport(payload.report, options.scope);
        if (!result) stop(new Error('Invalid chain audit child result'));
      } else if (
        payload.type === 'failure' &&
        typeof payload.message === 'string'
      ) {
        stop(
          new Error(payload.message.slice(0, 1024).replace(/[\r\n\t]/g, ' ')),
        );
      } else {
        stop(new Error('Invalid chain audit child message'));
      }
    });
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(deadline);
      if (memoryTimer) clearInterval(memoryTimer);
      options.signal.removeEventListener('abort', abort);
      if (!failure && code === 0 && result) resolve(result);
      else
        reject(
          failure ??
            new Error(
              `Chain audit child exited (${signal ?? code}) without a successful result`,
            ),
        );
    });
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
  });
}
