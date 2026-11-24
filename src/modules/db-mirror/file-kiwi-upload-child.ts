import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants, setPriority } from 'node:os';
import { FileKiwiClientService } from './file-kiwi-client.service';

// The protocol owns stdout. Neither logs nor inherited application credentials
// belong in this disposable encryption/upload process.
Logger.overrideLogger(false);
if (process.platform === 'linux') {
  setPriority(0, constants.priority.PRIORITY_LOW);
}
const [filePath, title, apiBaseUrl] = process.argv.slice(2);
const client = new FileKiwiClientService(
  { get: () => undefined } as never,
  new ConfigService({ fileMirror: { apiBaseUrl } }),
);
const started = Date.now();
void client.uploadFile({ filePath, title }).then(
  (upload) => {
    process.stdout.write(
      JSON.stringify({
        status: 'ok',
        upload,
        durationMs: Date.now() - started,
        processRssHighWaterBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
  },
  (error: unknown) => {
    process.exitCode = 1;
    process.stdout.write(
      JSON.stringify({
        status: 'error',
        message: (error instanceof Error ? error.message : String(error)).slice(
          0,
          1024,
        ),
      }),
    );
  },
);
