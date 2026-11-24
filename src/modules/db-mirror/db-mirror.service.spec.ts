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
  it('rejects a second job through upload and releases admission after failure', async () => {
    let fail!: (error: Error) => void;
    const upload = jest.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const removeDumpFile = jest.fn();
    const service = new DbMirrorService(
      { get: jest.fn() } as never,
      {
        get: jest.fn((key: string) =>
          key === 'fileMirror.enabled' ? true : undefined,
        ),
      } as never,
      {
        createSanitizedDump: jest.fn().mockResolvedValue({
          dumpPath: '/tmp/test.sqlite',
          dumpFileName: 'test.sqlite',
        }),
        removeDumpFile,
      } as never,
      { uploadFile: upload } as never,
    );
    const first = service.runMirrorJob();
    const assertion = expect(first).rejects.toThrow('network failed');
    await nextTurn();
    await expect(service.runMirrorJob({ force: true })).rejects.toThrow(
      'already running',
    );
    expect(upload).toHaveBeenCalledTimes(1);
    fail(new Error('network failed'));
    await assertion;
    expect(removeDumpFile).toHaveBeenCalledTimes(1);
    upload.mockRejectedValueOnce(new Error('retry failed'));
    await expect(service.runMirrorJob()).rejects.toThrow('retry failed');
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
