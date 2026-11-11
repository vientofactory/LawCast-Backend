import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { superviseChainAuditChild } from './chain-audit-child-supervisor';
import { readChainAuditLimits } from './chain-audit-limits';
import { ChangeTrackingService } from './change-tracking.service';

jest.mock('node:child_process', () => ({ fork: jest.fn() }));

describe('Chain audit supervisor and lifecycle', () => {
  let child: EventEmitter & { pid: number; killed: boolean; kill: jest.Mock };
  const report = {
    checkedAt: '2026-01-01T00:00:00Z',
    scope: 'daily',
    noticeCount: 0,
    eventCount: 0,
    failureCount: 0,
    checkpointRootHash: 'a'.repeat(64),
    failures: [],
  };
  const options = () => ({
    entrypoint: '/fixture/child.js',
    database: '/fixture/db.sqlite',
    scope: 'daily' as const,
    signal: new AbortController().signal,
    limits: readChainAuditLimits({}),
  });
  beforeEach(() => {
    child = Object.assign(new EventEmitter(), {
      pid: 123456789,
      killed: false,
      kill: jest.fn(() => {
        child.killed = true;
        return true;
      }),
    });
    jest.mocked(fork).mockReturnValue(child as any);
  });
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('resolves only after a successful result and clean child close', async () => {
    const pending = superviseChainAuditChild(options());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    child.emit('message', { type: 'result', report });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', 0, null);
    await expect(pending).resolves.toEqual(report);
    expect(jest.mocked(fork).mock.calls[0][2]).toMatchObject({
      execArgv: ['--max-old-space-size=192'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    expect(jest.mocked(fork).mock.calls[0][2]?.env).not.toHaveProperty(
      'NODE_OPTIONS',
    );
  });

  it.each([
    null,
    { type: 'result', report: { ...report, failureCount: 1 } },
    { type: 'result', report: { ...report, scope: 'weekly' } },
    { type: 'result', report: { ...report, noticeCount: -1 } },
    { type: 'other' },
  ])('kills invalid child output and waits for close', async (payload) => {
    const pending = superviseChainAuditChild(options());
    child.emit('message', payload);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(pending).rejects.toThrow('Invalid chain audit child');
  });

  it('rejects a duplicate terminal message', async () => {
    const pending = superviseChainAuditChild(options());
    child.emit('message', { type: 'result', report });
    child.emit('message', { type: 'result', report });
    child.emit('close', null, 'SIGKILL');
    await expect(pending).rejects.toThrow('Invalid');
  });

  it.each([0, 1])('rejects child exit %s without a result', async (code) => {
    const pending = superviseChainAuditChild(options());
    child.emit('close', code, null);
    await expect(pending).rejects.toThrow('without a successful result');
  });

  it('does not accept a result followed by a failed exit', async () => {
    const pending = superviseChainAuditChild(options());
    child.emit('message', { type: 'result', report });
    child.emit('close', 1, null);
    await expect(pending).rejects.toThrow('without a successful result');
  });

  it('propagates a spawn error after child close', async () => {
    const pending = superviseChainAuditChild(options());
    child.emit('error', new Error('spawn failed'));
    child.emit('close', -1, null);
    await expect(pending).rejects.toThrow('spawn failed');
  });

  const service = () =>
    new ChangeTrackingService(
      {
        manager: {
          connection: { options: { database: '/fixture/db.sqlite' } },
        },
      } as any,
      {} as any,
      {} as any,
      undefined as any,
      undefined as any,
    );

  it('uses the child for scheduled audits, prevents overlapping scopes, and allows retry after failure', async () => {
    const target = service();
    const pending = target.runScheduledChainAudit('daily');
    await expect(target.runScheduledChainAudit('weekly')).rejects.toThrow(
      'already running',
    );
    child.emit('close', 1, null);
    await expect(pending).rejects.toThrow();
    const retry = target.runScheduledChainAudit('daily');
    child.emit('message', { type: 'result', report });
    child.emit('close', 0, null);
    await expect(retry).resolves.toEqual(report);
  });

  it('kills the active audit on shutdown, waits for reaping, and rejects subsequent work', async () => {
    const target = service();
    const pending = target.runScheduledChainAudit('daily');
    const rejected = expect(pending).rejects.toThrow('cancelled');
    const shutdown = target.onModuleDestroy();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await shutdown;
    await rejected;
    await expect(target.runScheduledChainAudit('daily')).rejects.toThrow(
      'shutting down',
    );
  });

  it('rejects in-memory databases instead of blocking the main thread as a fallback', async () => {
    const target = new ChangeTrackingService(
      { manager: { connection: { options: { database: ':memory:' } } } } as any,
      {} as any,
      {} as any,
      undefined as any,
      undefined as any,
    );
    await expect(target.runScheduledChainAudit('daily')).rejects.toThrow(
      'file-backed',
    );
    expect(fork).not.toHaveBeenCalled();
  });

  it('bounds configuration and rejects malformed or unbounded values', () => {
    expect(
      readChainAuditLimits({
        CHAIN_AUDIT_TIMEOUT_MS: 'Infinity',
        CHAIN_AUDIT_HEAP_MB: '99999',
        CHAIN_AUDIT_DUTY_PERCENT: '0',
        CHAIN_AUDIT_BATCH_SIZE: '-10',
      }),
    ).toEqual({
      timeoutMs: 1_800_000,
      heapMb: 512,
      rssMb: 512,
      dutyPercent: 25,
      batchSize: 50,
    });
  });
});
