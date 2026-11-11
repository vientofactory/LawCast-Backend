import { join } from 'node:path';
import {
  Client,
  Metadata,
  credentials,
  loadPackageDefinition,
  status,
  type CallOptions,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type { SidecarTrace } from './semantic-search-timing';
import type {
  SemanticSidecarHealthResponse,
  SemanticSidecarSearchResponse,
} from './semantic-search.types';

type Reply<T> = (error: ServiceError | null, response?: T) => void;
type SearchReply = Omit<
  SemanticSidecarSearchResponse,
  'lastUpdateAt' | 'model'
> & { lastUpdateAt?: string; model?: string };
type HealthReply = Omit<
  SemanticSidecarHealthResponse,
  'lastUpdateAt' | 'lastUpdateTriggeredAt'
> & { lastUpdateAt?: string; lastUpdateTriggeredAt?: string };

interface SearchStub extends Client {
  search(
    request: { query: string; k: number },
    metadata: Metadata,
    options: CallOptions,
    callback: Reply<SearchReply>,
  ): void;
  getHealth(
    request: object,
    metadata: Metadata,
    options: CallOptions,
    callback: Reply<HealthReply>,
  ): void;
}

export class SemanticGrpcError extends Error {
  readonly sidecarStatus: number;
  readonly grpcCode: number;

  constructor(error: ServiceError) {
    super(error.message, { cause: error });
    this.grpcCode = error.code;
    // Keep the existing semantic failure policy separate from trace status.
    switch (error.code) {
      case status.INVALID_ARGUMENT:
        this.sidecarStatus = 400;
        break;
      case status.OUT_OF_RANGE:
        this.sidecarStatus = 422;
        break;
      case status.DEADLINE_EXCEEDED:
        this.sidecarStatus = 504;
        break;
      case status.UNAVAILABLE:
        this.sidecarStatus = 503;
        break;
      default:
        this.sidecarStatus = 502;
    }
  }
}

export class SemanticSearchGrpcClient {
  private readonly client: SearchStub;

  constructor(target: string) {
    const definitions = loadSync(join(__dirname, 'semantic_search.proto'), {
      defaults: true,
      longs: Number,
    });
    const { lawcast } = loadPackageDefinition(definitions) as unknown as {
      lawcast: {
        semantic: {
          v1: {
            SemanticSearch: new (
              ...args: ConstructorParameters<typeof Client>
            ) => SearchStub;
          };
        };
      };
    };
    const Stub = lawcast.semantic.v1.SemanticSearch;
    this.client = new Stub(target, credentials.createInsecure(), {
      'grpc.enable_retries': 0,
    });
  }

  close() {
    this.client.close();
  }

  async search(
    query: string,
    k: number,
    timeout: number,
    trace?: SidecarTrace,
  ) {
    const data = await this.call<SearchReply>(
      timeout,
      trace,
      (metadata, options, callback) =>
        this.client.search({ query, k }, metadata, options, callback),
    );
    return {
      data: {
        ...data,
        model: data.model ?? null,
        lastUpdateAt: data.lastUpdateAt ?? null,
      } satisfies SemanticSidecarSearchResponse,
    };
  }

  async health(timeout: number, trace?: SidecarTrace) {
    const data = await this.call<HealthReply>(
      timeout,
      trace,
      (metadata, options, callback) =>
        this.client.getHealth({}, metadata, options, callback),
    );
    return {
      data: {
        ...data,
        lastUpdateAt: data.lastUpdateAt ?? null,
        lastUpdateTriggeredAt: data.lastUpdateTriggeredAt ?? null,
      } satisfies SemanticSidecarHealthResponse,
    };
  }

  private call<T>(
    timeout: number,
    trace: SidecarTrace | undefined,
    send: (
      metadata: Metadata,
      options: CallOptions,
      callback: Reply<T>,
    ) => void,
  ): Promise<T> {
    const metadata = new Metadata();
    if (trace) {
      metadata.set('x-lawcast-search-trace', trace.traceId);
      metadata.set('x-lawcast-search-attempt', String(trace.attempt));
    }
    return new Promise((resolve, reject) => {
      send(metadata, { deadline: Date.now() + timeout }, (error, response) => {
        if (error) reject(new SemanticGrpcError(error));
        else if (response === undefined)
          reject(new Error('Empty gRPC response'));
        else resolve(response);
      });
    });
  }
}
