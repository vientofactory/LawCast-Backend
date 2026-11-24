import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import {
  isolatedChildOptions,
  resolveChildEntrypoint,
} from '../../utils/child-process-entrypoint.util';
import type { FileKiwiUploadResult } from './file-kiwi-client.service';
import { logMirrorMetric } from './mirror-phase-metrics';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

@Injectable()
export class FileKiwiUploadWorkerService implements OnModuleDestroy {
  private active?: {
    controller: AbortController;
    work: Promise<FileKiwiUploadResult>;
  };
  private shuttingDown = false;

  constructor(private readonly configService: ConfigService) {}

  async uploadFile(params: {
    filePath: string;
    title: string;
  }): Promise<FileKiwiUploadResult> {
    if (this.shuttingDown) throw new Error('Upload service is shutting down');
    if (this.active)
      throw new Error('Database mirror upload is already running');
    const controller = new AbortController();
    const work = this.run(params, controller.signal);
    this.active = { controller, work };
    try {
      return await work;
    } finally {
      this.active = undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await Promise.allSettled([active.work]);
  }

  private run(
    params: { filePath: string; title: string },
    signal: AbortSignal,
  ): Promise<FileKiwiUploadResult> {
    const entrypoint = resolveChildEntrypoint(
      __dirname,
      'file-kiwi-upload-child',
    );
    const options = isolatedChildOptions(entrypoint, 128);
    const requested = Number(
      this.configService.get('FILE_MIRROR_UPLOAD_TIMEOUT_MS'),
    );
    const timeout =
      Number.isSafeInteger(requested) && requested > 0
        ? Math.min(2_147_483_647, requested)
        : DEFAULT_TIMEOUT_MS;
    // Preserve explicit network routing/CA configuration, but not bot tokens,
    // database credentials, NODE_OPTIONS or allocator state from the API.
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      if (process.env[key]) options.env![key] = process.env[key];
    }
    return new Promise((resolve, reject) => {
      let executionError: Error | null = null;
      let output = '';
      const child = execFile(
        process.execPath,
        [
          ...options.execArgv!,
          entrypoint,
          params.filePath,
          params.title,
          this.configService.get<string>('fileMirror.apiBaseUrl') ||
            'https://api.file.kiwi',
        ],
        {
          env: options.env,
          timeout,
          killSignal: 'SIGKILL',
          signal,
          maxBuffer: 16 * 1024,
        },
        (error, stdout) => {
          executionError = error;
          output = stdout;
        },
      );
      // Abort can report an error before the process exits. Always reap before
      // allowing DbMirrorService to remove the file still being uploaded.
      child.once('close', () => {
        try {
          let result: Record<string, unknown>;
          try {
            result = JSON.parse(output) as Record<string, unknown>;
          } catch {
            if (signal.aborted)
              throw new Error(
                'Database mirror upload cancelled during shutdown',
              );
            if (executionError)
              throw new Error(
                'Database mirror upload worker exited without a result (timeout, output limit or process failure)',
              );
            throw new Error('Invalid upload worker result');
          }
          if (!result || result.status !== 'ok' || executionError) {
            throw new Error(
              typeof result?.message === 'string'
                ? result.message.slice(0, 1024)
                : 'Database mirror upload worker failed',
            );
          }
          const upload = result.upload as FileKiwiUploadResult | undefined;
          if (
            !upload ||
            !['folderId', 'folderUrlBase', 'shareUrl', 'fileId'].every(
              (key) => {
                const value = upload[key as keyof FileKiwiUploadResult];
                return (
                  typeof value === 'string' &&
                  value.length > 0 &&
                  value.length <= 4096
                );
              },
            ) ||
            ![result.durationMs, result.processRssHighWaterBytes].every(
              (value) =>
                typeof value === 'number' &&
                Number.isSafeInteger(value) &&
                value >= 0,
            )
          ) {
            throw new Error('Invalid upload worker result');
          }
          try {
            logMirrorMetric({
              event: 'db_mirror_upload_child_finish',
              executionContext: 'upload-child',
              durationMs: result.durationMs as number,
              processRssHighWaterBytes:
                result.processRssHighWaterBytes as number,
            });
          } catch {
            // Observability must not turn a completed upload into a failure.
          }
          resolve(upload);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
