import { setImmediate as nextTurn } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { DbMirrorService } from './db-mirror.service';

describe('DbMirrorService startup isolation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not block initialization or leak a later mirror failure', async () => {
    const service = new DbMirrorService(
      { get: jest.fn() } as never,
      { get: jest.fn().mockReturnValue(true) } as never,
      {} as never,
      {} as never,
    );
    let fail: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    jest.spyOn(service, 'runMirrorJob').mockReturnValue(pending);
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});

    expect(service.onModuleInit()).toBeUndefined();
    fail(new Error('dump timed out'));
    await nextTurn();
    expect(error).toHaveBeenCalledWith(
      'Startup database mirror job failed: dump timed out',
    );
  });
});
