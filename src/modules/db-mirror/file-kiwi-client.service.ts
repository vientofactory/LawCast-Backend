import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GenerateKeysResult } from '@file-kiwi/node';
import axios, { AxiosError } from 'axios';
import { LoggerUtils } from '../../utils/logger.utils';
import { logAndBridge } from '../../utils/bridge-log.utils';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { encryptChunk, generateKeys } from '@file-kiwi/node';

interface FileKiwiV2UploadUrls {
  head: string;
  tail: string;
  path: string;
  signatures: string[];
  headers: Record<string, string>;
}

interface FileKiwiV2RegisteredFile {
  fileId: string;
  chunkSize: number;
  chunks: number;
  uploadUrls: FileKiwiV2UploadUrls;
}

interface FileKiwiV2CreateFolderResponse {
  folderId: string;
  folderUrl: string;
  folderUrlBase?: string;
  uploadAuth: string;
  files: FileKiwiV2RegisteredFile[];
}

interface FileKiwiV2UploadStatus {
  complete: boolean;
  missing: number[];
}

export interface FileKiwiUploadResult {
  folderId: string;
  folderUrlBase: string;
  shareUrl: string;
  fileId: string;
}

@Injectable()
export class FileKiwiClientService {
  private readonly logger = LoggerUtils.getContextLogger(
    FileKiwiClientService.name,
  );
  private readonly apiBase: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly discordBridge?: DiscordBridgeService,
  ) {
    this.apiBase =
      this.configService.get<string>('fileMirror.apiBaseUrl') ||
      'https://api.file.kiwi';
  }

  async uploadFile(params: {
    filePath: string;
    title: string;
  }): Promise<FileKiwiUploadResult> {
    const filePath = path.resolve(params.filePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    const keyResult = (await generateKeys()) as GenerateKeysResult;

    const encryptedFilename = await keyResult.encryptFilename(
      path.basename(filePath),
    );

    const created = await this.createFolder({
      title: params.title,
      encryptedFilename,
      fileSize: stat.size,
      ske: keyResult.ske,
    });

    const fileMeta = created.files[0];
    if (!fileMeta?.fileId) {
      throw new Error('file.kiwi v2 did not return a registered file entry');
    }

    await this.uploadAllChunks({
      filePath,
      fileSize: stat.size,
      fileMeta,
      secretKey: keyResult.secretKey,
      encryptChunk,
    });

    await this.verifyUpload({
      folderId: created.folderId,
      fileId: fileMeta.fileId,
      uploadAuth: created.uploadAuth,
    });

    const folderUrlBase = created.folderUrlBase || created.folderUrl;
    const shareUrl = `${folderUrlBase}#${keyResult.secretKey}`;

    logAndBridge({
      method: 'log',
      message: `file.kiwi v2 upload complete (folderId=${created.folderId}, fileId=${fileMeta.fileId})`,
      logger: this.logger,
      context: FileKiwiClientService.name,
      discordBridge: this.discordBridge,
      bridgeMessage: `file.kiwi upload complete: folder=${created.folderId}, file=${fileMeta.fileId}`,
      metadata: {
        folderId: created.folderId,
        fileId: fileMeta.fileId,
      },
    });

    return {
      folderId: created.folderId,
      folderUrlBase,
      shareUrl,
      fileId: fileMeta.fileId,
    };
  }

  private async uploadAllChunks(params: {
    filePath: string;
    fileSize: number;
    fileMeta: FileKiwiV2RegisteredFile;
    secretKey: string;
    encryptChunk: (
      chunk: Buffer | Uint8Array,
      secretKey: string,
    ) => Promise<Uint8Array>;
  }): Promise<void> {
    const { fileMeta } = params;

    const fileHandle = await fs.open(params.filePath, 'r');
    try {
      const uploadOrder = this.buildChunkOrder(fileMeta.chunks);

      for (const chunkIndex of uploadOrder) {
        const start = chunkIndex * fileMeta.chunkSize;
        const end = Math.min(start + fileMeta.chunkSize, params.fileSize);
        const length = end - start;

        const plainChunk = Buffer.alloc(length);
        await fileHandle.read(plainChunk, 0, length, start);

        const encryptedChunk = await params.encryptChunk(
          plainChunk,
          params.secretKey,
        );

        const chunkNumber = String(chunkIndex + 1).padStart(5, '0');
        const signature = fileMeta.uploadUrls.signatures[chunkIndex];
        if (!signature) {
          throw new Error(
            `Missing upload signature for chunk ${chunkIndex + 1}`,
          );
        }

        const uploadUrl =
          `${fileMeta.uploadUrls.head}${fileMeta.uploadUrls.path}/${chunkNumber}` +
          `?${fileMeta.uploadUrls.tail}&X-Amz-Signature=${signature}`;

        await this.uploadChunk({
          uploadUrl,
          encryptedChunk: Buffer.from(encryptedChunk),
          headers: fileMeta.uploadUrls.headers,
          chunkIndex,
        });
      }
    } finally {
      await fileHandle.close();
    }
  }

  private async verifyUpload(params: {
    folderId: string;
    fileId: string;
    uploadAuth: string;
  }): Promise<void> {
    const statusUrl = `${this.apiBase}/v2/folders/${params.folderId}/files/${params.fileId}/upload-status`;

    const status = await this.getUploadStatus(statusUrl, params.uploadAuth);
    if (!status.complete) {
      throw new Error(
        `file.kiwi upload incomplete: missing chunks ${status.missing.join(',')}`,
      );
    }
  }

  private async createFolder(params: {
    title: string;
    encryptedFilename: string;
    fileSize: number;
    ske: string;
  }): Promise<FileKiwiV2CreateFolderResponse> {
    const url = `${this.apiBase}/v2/folders`;

    try {
      const response = await axios.post<FileKiwiV2CreateFolderResponse>(
        url,
        {
          title: params.title,
          mode: 'send',
          encryption: {
            ske: params.ske,
          },
          files: [
            {
              filename: params.encryptedFilename,
              filesize: params.fileSize,
              mimetype: 'application/x-sqlite3',
            },
          ],
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data;
    } catch (error) {
      const details = this.describeAxiosError(error);
      logAndBridge({
        method: 'error',
        message: `file.kiwi folder creation failed: ${details}`,
        logger: this.logger,
        context: FileKiwiClientService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.ERROR,
        bridgeMessage: `file.kiwi folder creation failed`,
        metadata: { details },
      });
      throw this.createErrorWithCause(
        `file.kiwi folder creation failed: ${details}`,
        error,
      );
    }
  }

  private async uploadChunk(params: {
    uploadUrl: string;
    encryptedChunk: Buffer;
    headers: Record<string, string>;
    chunkIndex: number;
  }): Promise<void> {
    try {
      await axios.put(params.uploadUrl, params.encryptedChunk, {
        headers: {
          'Content-Length': String(params.encryptedChunk.length),
          ...params.headers,
        },
      });
    } catch (error) {
      const details = this.describeAxiosError(error);
      throw this.createErrorWithCause(
        `file.kiwi chunk upload failed (chunk=${params.chunkIndex + 1}): ${details}`,
        error,
      );
    }
  }

  private async getUploadStatus(
    statusUrl: string,
    uploadAuth: string,
  ): Promise<FileKiwiV2UploadStatus> {
    try {
      const response = await axios.get<FileKiwiV2UploadStatus>(statusUrl, {
        params: {
          uploadAuth,
        },
      });
      return response.data;
    } catch (error) {
      const details = this.describeAxiosError(error);
      throw this.createErrorWithCause(
        `file.kiwi upload-status check failed: ${details}`,
        error,
      );
    }
  }

  private describeAxiosError(error: unknown): string {
    if (!axios.isAxiosError(error)) {
      return (error as Error).message;
    }

    const axiosError = error as AxiosError<unknown>;
    const status = axiosError.response?.status;
    const responseData = axiosError.response?.data;
    const renderedData =
      responseData == null
        ? ''
        : typeof responseData === 'string'
          ? responseData
          : JSON.stringify(responseData);

    if (status) {
      return `status=${status}${renderedData ? `, body=${renderedData}` : ''}`;
    }

    return axiosError.message;
  }

  private createErrorWithCause(message: string, cause: unknown): Error {
    const error = new Error(message) as Error & { cause?: unknown };
    error.cause = cause;
    return error;
  }

  private buildChunkOrder(total: number): number[] {
    if (total <= 1) {
      return [0];
    }

    const order = [0, total - 1];
    for (let index = 1; index < total - 1; index += 1) {
      order.push(index);
    }
    return order;
  }
}
