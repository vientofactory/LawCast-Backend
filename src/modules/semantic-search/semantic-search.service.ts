import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { NoticeSearchService } from '../crawling/notice-search.service';
import { LoggerUtils } from '../../utils/logger.utils';
import {
  CHUNK_FETCH_GROWTH,
  CHUNK_FETCH_INITIAL_FACTOR,
  SIDE_CAR_MAX_CHUNK_K,
} from './semantic-search.constants';
import {
  SemanticEngineHealthResponse,
  SemanticSearchResponse,
  SemanticSidecarChunk,
  SemanticSidecarHealthResponse,
  SemanticSidecarSearchResponse,
} from './semantic-search.types';

const FALLBACK_REASON_UNAVAILABLE =
  '의미 검색 엔진을 사용할 수 없어 키워드 검색 결과를 반환합니다.';
const FALLBACK_REASON_DISABLED =
  '의미 검색 기능이 비활성화되어 있어 키워드 검색 결과를 반환합니다.';

@Injectable()
export class SemanticSearchService {
  private readonly logger = LoggerUtils.getContextLogger(
    SemanticSearchService.name,
  );
  private readonly http: AxiosInstance;
  private readonly enabled: boolean;
  /**
   * Chunk-window cap last reported by the sidecar's `/health` (`maxK`).
   * Starts at the compiled default so the first search behaves exactly like
   * the pre-negotiation code when health is unreachable or too old to report.
   */
  private chunkCap = SIDE_CAR_MAX_CHUNK_K;
  /** Date.now() of the last cap read; stamped even when the read fails. */
  private chunkCapReadAt = 0;
  /**
   * Cap freshness window (ms): `/health` is read at most this often, so a
   * cap change on the sidecar (`LAWCAST_SEMANTIC_MAX_K`, sidecar restart)
   * reaches the backend within this window, while the happy path costs at
   * most one extra request per window instead of one per search. Injected
   * from `SEMANTIC_SEARCH_CHUNK_CAP_REFRESH_MS` (default 60s) so operators
   * can tune how fast a sidecar cap change is picked up without a backend
   * deploy; a non-positive value forces a re-read on every search.
   */
  private readonly chunkCapRefreshMs: number;

  constructor(
    configService: ConfigService,
    private readonly noticeSearchService: NoticeSearchService,
  ) {
    this.enabled = configService.get<boolean>('semanticSearch.enabled') ?? true;
    this.chunkCapRefreshMs =
      configService.get<number>('semanticSearch.chunkCapRefreshMs') ?? 60_000;
    this.http = axios.create({
      baseURL: configService.get<string>('semanticSearch.apiUrl'),
      timeout: configService.get<number>('semanticSearch.timeout') ?? 10000,
    });
  }

  /**
   * Semantic search with graceful degradation. The failure policy is
   * per-phase so collected evidence is never discarded:
   * - first chunk-window failure (model loading/failed, network error, 5xx)
   *   degrades to the existing keyword search; client-contract violations
   *   (4xx) are surfaced as request errors;
   * - a failed widening request keeps the chunks already collected and
   *   returns partial semantic results (count < k is allowed) — the keyword
   *   fallback returns nothing for paraphrase queries, so partial semantic
   *   hits are strictly better;
   * - keyword fallback is used only when the first window failed (feature
   *   disabled or engine unreachable) — never on an empty clear tier: the
   *   sidecar already dropped unrelated hits, so an empty `results` is the
   *   engine's real answer and `weakResults` still rides along for the UI's
   *   explicit reveal.
   */
  async searchSemantic(query: string, k: number) {
    if (!this.enabled) {
      return this.keywordFallback(query, k, FALLBACK_REASON_DISABLED);
    }
    let collected: SemanticSidecarChunk[];
    let weakCollected: SemanticSidecarChunk[];
    let lastUpdateAt: string | null;
    try {
      ({
        chunks: collected,
        weakChunks: weakCollected,
        lastUpdateAt,
      } = await this.collectChunks(query, k));
    } catch (error) {
      return this.handleFirstWindowFailure(error, query, k);
    }
    return {
      query,
      mode: 'semantic',
      fallbackReason: null,
      lastUpdateAt,
      results: this.toNoticeHits(collected).slice(0, k),
      weakResults: this.toNoticeHits(weakCollected).slice(0, k),
    } satisfies SemanticSearchResponse;
  }

  /**
   * First-window failure: no semantic evidence was collected. 4xx is a
   * client-contract violation (surfaced, never masked by a fallback); any
   * other failure degrades to keyword search.
   */
  private handleFirstWindowFailure(
    error: unknown,
    query: string,
    k: number,
  ): Promise<SemanticSearchResponse> {
    if (axios.isAxiosError(error)) {
      const status: number | undefined = error.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(
          `semantic sidecar rejected the request (status ${status}): ${error.message}`,
        );
        throw new BadRequestException(
          '의미 검색 요청이 거부되었습니다. 요청 형식을 확인해 주세요.',
        );
      }
      this.logger.warn(
        `semantic sidecar unavailable (${status ?? this.describeError(error)}); ` +
          'falling back to keyword search',
      );
    } else {
      this.logger.warn(
        `semantic search failed (${this.describeError(error)}); falling back to keyword search`,
      );
    }
    return this.keywordFallback(query, k, FALLBACK_REASON_UNAVAILABLE);
  }

  /**
   * Degraded path served by the existing keyword search (read-only reuse of
   * NoticeSearchService; its own behavior is unchanged). `lastUpdateAt`
   * defaults to null: only a sidecar response can carry the index time.
   */
  private async keywordFallback(
    query: string,
    k: number,
    fallbackReason: string,
    lastUpdateAt: string | null = null,
  ): Promise<SemanticSearchResponse> {
    try {
      const result = await this.noticeSearchService.searchNotices({
        keyword: query,
        page: 1,
        limit: k,
        includeDone: true,
      });
      return {
        query,
        mode: 'keyword_fallback',
        fallbackReason,
        lastUpdateAt,
        results: result.items.map((item) => ({
          noticeNum: item.num,
          subject: item.subject,
          committee: item.committee,
          section: null,
          score: null,
          excerpt: null,
        })),
        weakResults: [],
      };
    } catch (error) {
      this.logger.error(
        `keyword fallback failed for semantic search: ${this.describeError(error)}`,
      );
      throw new ServiceUnavailableException(
        '검색 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      );
    }
  }

  /**
   * Collect chunk windows until they cover k distinct notices — the outer
   * policy: resolve the sidecar's current cap, then recover once from a cap
   * that went stale between the cache read and a sidecar restart.
   *
   * The cache can be older than a restart that LOWERED
   * `LAWCAST_SEMANTIC_MAX_K`; the first window would then ask for more
   * chunks than the sidecar accepts and be rejected with 422 (a widening
   * rejection never reaches here — that path answers with the partial
   * chunks already collected). One forced health re-read + retry follows,
   * but only when the sidecar actually reports a lower cap: an unchanged
   * cap means the 422 is a genuine client-contract violation (e.g. an
   * over-long query) and is surfaced immediately without a second request.
   */
  private async collectChunks(query: string, k: number) {
    const cap = await this.resolveChunkCap();
    try {
      return await this.collectChunkWindows(query, k, cap);
    } catch (error) {
      if (!this.isChunkWindowRejected(error)) {
        throw error;
      }
      const refreshed = await this.resolveChunkCap(true);
      if (refreshed >= cap) {
        throw error;
      }
      this.logger.warn(
        `semantic sidecar chunk cap changed (${cap} -> ${refreshed}); ` +
          'retrying the first window',
      );
      return this.collectChunkWindows(query, k, refreshed);
    }
  }

  /**
   * Chunk-window cap currently enforced by the sidecar, TTL-cached from
   * `GET /health` (`maxK`). Reading the cap here — instead of hardcoding it —
   * is what lets an operator change `LAWCAST_SEMANTIC_MAX_K` with only a
   * sidecar restart. Failure policy: a failed read keeps the last known cap
   * (a health blip must not downgrade a known custom cap to the compiled
   * default, which could overshoot and get the search rejected), and the
   * read attempt is stamped either way so a dead sidecar costs one health
   * probe per window rather than one per search.
   */
  private async resolveChunkCap(force = false): Promise<number> {
    const now = Date.now();
    if (!force && now - this.chunkCapReadAt < this.chunkCapRefreshMs) {
      return this.chunkCap;
    }
    this.chunkCapReadAt = now;
    try {
      const response =
        await this.http.get<SemanticSidecarHealthResponse>('/health');
      this.adoptChunkCap(response.data);
    } catch (error) {
      this.logger.warn(
        `semantic sidecar health unavailable while reading the chunk cap ` +
          `(${this.describeError(error)}); using ${this.chunkCap}`,
      );
    }
    return this.chunkCap;
  }

  /**
   * Adopt the `maxK` of a `/health` payload. Absent or invalid values keep
   * the current cap: a sidecar older than the field has the default
   * hardcoded anyway, and keeping a known cap after an image downgrade can
   * only under-ask (never overshoot into a 422).
   */
  private adoptChunkCap(payload: SemanticSidecarHealthResponse | undefined) {
    const reported = payload?.maxK;
    if (
      typeof reported === 'number' &&
      Number.isInteger(reported) &&
      reported >= 1
    ) {
      this.chunkCap = reported;
    }
  }

  /** A 422 from `/search`: query or k outside the sidecar's accepted bounds. */
  private isChunkWindowRejected(error: unknown): boolean {
    return axios.isAxiosError(error) && error.response?.status === 422;
  }

  /**
   * Collect chunk windows until they cover k distinct notices, clamping
   * every request to `cap` (the sidecar's reported chunk-window cap; `k`
   * counts CHUNKS here).
   *
   * `k` is a result count, not a cap: the sidecar ranks chunks, so one
   * top-chunkK fetch can collapse to fewer than k distinct notices. Fetch an
   * oversized chunk window first and widen it (growth up to `cap`) while
   * dedup leaves the result short. Widening stops as soon as the sidecar runs
   * out of chunks (it returned fewer than requested), so a small corpus
   * costs exactly one request. The sidecar splits each window into a clear
   * tier (`results`) and a weak band (`weakResults`); both ride along, and
   * exhaustion counts the two tiers together (the tiers cut the same top-k
   * window).
   *
   * Failure policy: only a failed FIRST window propagates (the caller turns
   * it into a fallback or a request error). A failed widening request keeps
   * the chunks collected so far — partial results beat discarding them. The
   * sidecar's `lastUpdateAt` rides along: the last successful window carries
   * the serving generation's index time.
   */
  private async collectChunkWindows(
    query: string,
    k: number,
    cap: number,
  ): Promise<{
    chunks: SemanticSidecarChunk[];
    weakChunks: SemanticSidecarChunk[];
    lastUpdateAt: string | null;
  }> {
    const collected: SemanticSidecarChunk[] = [];
    const weakCollected: SemanticSidecarChunk[] = [];
    let lastUpdateAt: string | null = null;
    let chunkK = Math.min(k * CHUNK_FETCH_INITIAL_FACTOR, cap);
    for (;;) {
      let window: SemanticSidecarSearchResponse;
      try {
        window = await this.fetchChunks(query, chunkK);
      } catch (error) {
        // Both tiers empty = the first window itself failed, so nothing
        // was ever collected and the failure must propagate.
        if (collected.length === 0 && weakCollected.length === 0) {
          throw error;
        }
        this.logger.warn(
          `semantic sidecar chunk widening failed (${this.describeError(error)}); ` +
            `returning partial results from ${collected.length} collected chunks`,
        );
        return {
          chunks: collected,
          weakChunks: weakCollected,
          lastUpdateAt,
        };
      }
      collected.push(...window.results);
      // `weakResults` is contract-required, but the sidecar and this backend
      // deploy as separate containers: tolerate an older sidecar that
      // predates the tiered response rather than failing the whole search.
      const windowWeak = window.weakResults ?? [];
      weakCollected.push(...windowWeak);
      lastUpdateAt = window.lastUpdateAt;
      const hits = this.toNoticeHits(collected);
      const corpusExhausted =
        window.results.length + windowWeak.length < chunkK;
      if (hits.length >= k || corpusExhausted || chunkK >= cap) {
        return {
          chunks: collected,
          weakChunks: weakCollected,
          lastUpdateAt,
        };
      }
      chunkK = Math.min(chunkK * CHUNK_FETCH_GROWTH, cap);
    }
  }

  /**
   * Engine status for the frontend's status block, read from the sidecar's
   * `/health` (readiness status, chunk index count, index-update time, last
   * update tick time). `status` is what lets the UI tell "not ready yet" from
   * "ready" — the search-unavailable overlay keys on it. There is no fallback
   * payload: a disabled feature or an unreachable sidecar surfaces as 503 so
   * the UI can show its error state.
   */
  async getEngineHealth(): Promise<SemanticEngineHealthResponse> {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        '의미 검색 엔진이 비활성화되어 있습니다.',
      );
    }
    try {
      const response =
        await this.http.get<SemanticSidecarHealthResponse>('/health');
      // A health read is also a fresh cap read: the frontend status poll
      // keeps the chunk cap warm for free. Only the UI subset below is
      // returned — `maxK` stays internal to this service.
      this.chunkCapReadAt = Date.now();
      this.adoptChunkCap(response.data);
      const { status, indexedChunks, lastUpdateAt, lastUpdateTriggeredAt } =
        response.data;
      return { status, indexedChunks, lastUpdateAt, lastUpdateTriggeredAt };
    } catch (error) {
      this.logger.warn(
        `semantic sidecar health unavailable (${this.describeError(error)})`,
      );
      throw new ServiceUnavailableException(
        '의미 검색 엔진 상태를 확인할 수 없습니다.',
      );
    }
  }

  private async fetchChunks(
    query: string,
    chunkK: number,
  ): Promise<SemanticSidecarSearchResponse> {
    const response = await this.http.get<SemanticSidecarSearchResponse>(
      '/search',
      { params: { query, k: chunkK } },
    );
    return response.data;
  }

  /**
   * Collapse chunk-level hits to notice-level results (best chunk per
   * notice), matching how retrieval quality is measured (notice-level rank).
   */
  private toNoticeHits(chunks: SemanticSidecarChunk[]) {
    const seen = new Set<number>();
    const hits: SemanticSearchResponse['results'] = [];
    for (const chunk of chunks) {
      if (seen.has(chunk.noticeNum)) {
        continue;
      }
      seen.add(chunk.noticeNum);
      hits.push({
        noticeNum: chunk.noticeNum,
        subject: chunk.subject,
        committee: chunk.committee,
        section: chunk.section,
        score: chunk.score,
        excerpt: chunk.text,
      });
    }
    return hits;
  }

  private describeError(error: unknown): string {
    return error instanceof AxiosError
      ? (error.code ?? error.message)
      : String((error as Error)?.message ?? error);
  }
}
