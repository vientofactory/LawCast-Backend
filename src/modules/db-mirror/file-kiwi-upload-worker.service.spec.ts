import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as entrypoints from '../../utils/child-process-entrypoint.util';
import { FileKiwiUploadWorkerService } from './file-kiwi-upload-worker.service';

describe('FileKiwiUploadWorkerService', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiwi-upload-test-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function fixture(script: string, timeout = 2000) {
    const entrypoint = path.join(dir, 'child.cjs');
    await fs.writeFile(entrypoint, script);
    jest
      .spyOn(entrypoints, 'resolveChildEntrypoint')
      .mockReturnValue(entrypoint);
    return new FileKiwiUploadWorkerService({
      get: (key: string) =>
        key === 'FILE_MIRROR_UPLOAD_TIMEOUT_MS' ? timeout : undefined,
    } as never);
  }
  const result = `process.stdout.write(JSON.stringify({status:'ok',upload:{folderId:'folder',fileId:'file',folderUrlBase:'https://example.test/folder',shareUrl:'https://example.test/folder#key'},durationMs:1,processRssHighWaterBytes:1000}));`;
  const params = () => ({ filePath: path.join(dir, 'pid'), title: 'test' });

  it('returns a bounded result without passing application secrets or allocator options', async () => {
    const old = process.env.LAWCAST_PARENT_ONLY_TEST;
    process.env.LAWCAST_PARENT_ONLY_TEST = 'not-for-child';
    try {
      const service = await fixture(
        `if(process.env.LAWCAST_PARENT_ONLY_TEST || process.env.NODE_OPTIONS || process.env.LD_PRELOAD) throw Error('Inherited application environment'); ${result}`,
      );
      await expect(service.uploadFile(params())).resolves.toMatchObject({
        folderId: 'folder',
        fileId: 'file',
      });
    } finally {
      if (old === undefined) delete process.env.LAWCAST_PARENT_ONLY_TEST;
      else process.env.LAWCAST_PARENT_ONLY_TEST = old;
    }
  });

  it.each([
    ['malformed JSON', "process.stdout.write('not-json');"],
    [
      'invalid result shape',
      "process.stdout.write(JSON.stringify({status:'ok',upload:{}}));",
    ],
    ['nonzero exit', result + 'process.exitCode=1;'],
    [
      'oversized output',
      "process.stdout.write('x'.repeat(32768));setInterval(()=>{},1000);",
    ],
  ])('rejects %s', async (_name, script) => {
    await expect(
      (await fixture(script)).uploadFile(params()),
    ).rejects.toThrow();
  });

  it('does not accept an early success message before the worker exits', async () => {
    const service = await fixture(result + 'setInterval(()=>{},1000);', 100);
    await expect(service.uploadFile(params())).rejects.toThrow();
  });

  it('reaps the active worker on shutdown, rejects overlap and refuses new work', async () => {
    const service = await fixture(
      "require('fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);",
    );
    const work = service.uploadFile(params());
    const rejection = expect(work).rejects.toThrow();
    await expect(service.uploadFile(params())).rejects.toThrow(
      'already running',
    );
    for (let i = 0; i < 100; i++) {
      try {
        await fs.access(params().filePath);
        break;
      } catch {
        await delay(10);
      }
    }
    const pid = Number(await fs.readFile(params().filePath, 'utf8'));
    await service.onModuleDestroy();
    await rejection;
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(service.uploadFile(params())).rejects.toThrow('shutting down');
  });

  it('releases admission after a worker failure', async () => {
    const service = await fixture(
      "process.stdout.write(JSON.stringify({status:'error',message:'upload failed'}));process.exitCode=1;",
    );
    await expect(service.uploadFile(params())).rejects.toThrow('upload failed');
    await fs.writeFile(path.join(dir, 'child.cjs'), result);
    await expect(service.uploadFile(params())).resolves.toMatchObject({
      fileId: 'file',
    });
  });
  it('runs native encryption and the complete v2 upload protocol against a local provider', async () => {
    const uploaded = new Map<number, Buffer>();
    let baseUrl = '';
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'POST') {
          response.end(
            JSON.stringify({
              folderId: 'folder',
              folderUrlBase: baseUrl + '/share',
              uploadAuth: 'auth',
              files: [
                {
                  fileId: 'file',
                  chunks: 3,
                  chunkSize: 3,
                  uploadUrls: {
                    head: baseUrl,
                    path: '/chunks',
                    tail: 'x=y',
                    signatures: ['a', 'b', 'c'],
                    headers: {},
                  },
                },
              ],
            }),
          );
        } else if (request.method === 'PUT') {
          uploaded.set(
            Number(request.url!.split('/')[2].split('?')[0]),
            Buffer.concat(chunks),
          );
          response.end('{}');
        } else {
          response.end(
            JSON.stringify({ complete: uploaded.size === 3, missing: [] }),
          );
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const filePath = path.join(dir, 'mirror');
    await fs.writeFile(filePath, 'abcdefg');
    const service = new FileKiwiUploadWorkerService({
      get: (key: string) =>
        key === 'fileMirror.apiBaseUrl' ? baseUrl : undefined,
    } as never);
    try {
      const upload = await service.uploadFile({ filePath, title: 'test' });
      expect(upload.fileId).toBe('file');
      expect(new URL(upload.shareUrl).hash.length).toBeGreaterThan(20);
      expect([...uploaded.keys()]).toEqual([1, 3, 2]);
      expect(uploaded.size).toBe(3);
      for (const ciphertext of uploaded.values())
        expect(ciphertext.length).toBeGreaterThan(3);
    } finally {
      await service.onModuleDestroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
