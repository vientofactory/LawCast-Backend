import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileKiwiClientService } from './file-kiwi-client.service';

describe('FileKiwiClientService chunk buffers', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiwi-buffer-test-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const meta = (chunks: number, chunkSize: number) => ({
    chunks,
    chunkSize,
    uploadUrls: {
      head: 'https://example.test',
      path: '/upload',
      tail: 'x=y',
      signatures: Array.from({ length: chunks }, () => 'sig'),
      headers: {},
    },
  });
  const client = () =>
    new FileKiwiClientService(
      { get: () => undefined } as never,
      { get: () => undefined } as never,
    ) as any;

  it('reuses one plaintext buffer, handles short reads and preserves ciphertext view bounds', async () => {
    const filePath = path.join(dir, 'mirror');
    await fs.writeFile(filePath, 'abcdefg');
    const handle = await fs.open(filePath, 'r');
    const read = handle.read.bind(handle);
    jest
      .spyOn(handle, 'read')
      .mockImplementation(((
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => read(buffer, offset, Math.min(2, length), position)) as any);
    jest.spyOn(fs, 'open').mockResolvedValue(handle);
    const service = client();
    const payloads: string[] = [];
    service.uploadChunk = jest.fn(
      async ({ encryptedChunk }: { encryptedChunk: Buffer }) => {
        payloads.push(encryptedChunk.toString());
      },
    );
    const buffers = new Set<ArrayBufferLike>();
    await service.uploadAllChunks({
      filePath,
      fileSize: 7,
      fileMeta: meta(3, 3),
      secretKey: 'test',
      encryptChunk: async (chunk: Buffer) => {
        buffers.add(chunk.buffer);
        const padded = Uint8Array.from([88, ...chunk, 99]);
        return padded.subarray(1, padded.length - 1);
      },
    });
    expect(payloads).toEqual(['abc', 'g', 'def']);
    expect(buffers.size).toBe(1);
    expect(service.uploadChunk).toHaveBeenCalledTimes(3);
  });

  it('rejects inconsistent dimensions before allocating or opening a file', async () => {
    await expect(
      client().uploadAllChunks({
        filePath: 'missing',
        fileSize: 10,
        fileMeta: meta(1, 3),
      }),
    ).rejects.toThrow('Invalid file.kiwi chunk dimensions');
  });

  it('rejects truncated source data without encrypting or uploading a padded chunk', async () => {
    const filePath = path.join(dir, 'mirror');
    await fs.writeFile(filePath, 'ab');
    const service = client();
    const encryptChunk = jest.fn();
    service.uploadChunk = jest.fn();
    await expect(
      service.uploadAllChunks({
        filePath,
        fileSize: 3,
        fileMeta: meta(1, 3),
        encryptChunk,
      }),
    ).rejects.toThrow('Unexpected end');
    expect(encryptChunk).not.toHaveBeenCalled();
    expect(service.uploadChunk).not.toHaveBeenCalled();
  });
});
