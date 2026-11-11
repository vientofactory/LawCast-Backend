import {
  BadRequestException,
  Injectable,
  type OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { NoticeSearchService } from '../crawling/notice-search.service';
import { LoggerUtils } from '../../utils/logger.utils';
import {
  measureSemanticSidecarCall,
  semanticSidecarErrorStatus,
  TRACE_HEADER,
  SEARCH_ATTEMPT_HEADER,
  type SidecarTrace,
} from './semantic-search-timing';
import { SemanticSearchGrpcClient } from './semantic-search-grpc.client';
import {
  CHUNK_FETCH_GROWTH,
  CHUNK_FETCH_INITIAL_FACTOR,
  SIDE_CAR_MAX_CHUNK_K,
} from './semantic-search.constants';
import {
  SemanticEngineHealthResponse,
  SemanticSearchResponse,
  SemanticSearchResultItem,
  SemanticSidecarChunk,
  SemanticSidecarHealthResponse,
  SemanticSidecarSearchResponse,
} from './semantic-search.types';

const FALLBACK_REASON_UNAVAILABLE =
  '의미 검색 엔진을 사용할 수 없어 키워드 검색 결과를 반환합니다.';
const FALLBACK_REASON_DISABLED =
  '의미 검색 기능이 비활성화되어 있어 키워드 검색 결과를 반환합니다.';

@Injectable()
export class SemanticSearchService implements OnModuleDestroy {
  private readonly logger = LoggerUtils.getContextLogger(
    SemanticSearchService.name,
  );
  private readonly http?: AxiosInstance;
  private readonly grpc?: SemanticSearchGrpcClient;
  private readonly enabled: boolean;
  /**
   * Per-window ceiling (ms) for one sidecar `/search` round trip
   * (`SEMANTIC_SEARCH_TIMEOUT`). Also the axios instance default.
   */
  private readonly requestTimeout: number;
  /**
   * Aggregate budget (ms) for one search's whole chunk-window loop
   * (`SEMANTIC_SEARCH_TOTAL_TIMEOUT`, defaults to `requestTimeout`).
   * Bounds the worst case a slow sidecar can impose: without it each
   * widening pass could burn a full `requestTimeout` in turn.
   */
  private readonly totalTimeoutMs: number;
  /**
   * Chunk-window cap last reported by the sidecar's `/health` (`maxK`).
   * Starts at the compiled default so the first search behaves exactly like
   * the pre-negotiation code when health is unreachable or too old to report.
   */
  private chunkCap: number;
  private readonly chunkCapCeiling: number;
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
  /**
   * No-result gate over the sidecar's per-hit `lexicalEvidence` flag
   * (`SEMANTIC_SEARCH_LEXICAL_GATE`): `off` keeps pure dense ranking,
   * `shadow` only logs, `enforce` drops gated hits after the chunk windows
   * are collected (never inside the widening loop, so the
   * `corpusExhausted` stop condition keeps working).
   */
  private readonly lexicalGate: 'off' | 'shadow' | 'enforce';
  /**
   * Dense top-1 score that skips the gate (`lexicalBypassScore`, default
   * 0.6): high-confidence matches bypass so colloquial paraphrases without
   * shared surface tokens are never emptied.
   */
  private readonly lexicalBypassScore: number;
  constructor(
    configService: ConfigService,
    private readonly noticeSearchService: NoticeSearchService,
  ) {
    this.enabled = configService.get<boolean>('semanticSearch.enabled') ?? true;
    this.chunkCapRefreshMs =
      configService.get<number>('semanticSearch.chunkCapRefreshMs') ?? 60_000;
    this.lexicalGate =
      configService.get<'off' | 'shadow' | 'enforce'>(
        'semanticSearch.lexicalGate',
      ) ?? 'off';
    const ceiling = configService.get<number>('semanticSearch.chunkCapCeiling');
    this.chunkCapCeiling =
      ceiling !== undefined && ceiling > 0 ? ceiling : Number.POSITIVE_INFINITY;
    this.chunkCap = Math.min(SIDE_CAR_MAX_CHUNK_K, this.chunkCapCeiling);
    this.lexicalBypassScore =
      configService.get<number>('semanticSearch.lexicalBypassScore') ?? 0.6;
    this.requestTimeout =
      configService.get<number>('semanticSearch.timeout') ?? 10000;
    const configuredTotal = configService.get<number>(
      'semanticSearch.totalTimeoutMs',
    );
    this.totalTimeoutMs =
      configuredTotal && configuredTotal > 0
        ? configuredTotal
        : this.requestTimeout;
    const grpcTarget = configService.get<string>('semanticSearch.grpcTarget');
    if (this.enabled && grpcTarget) {
      this.grpc = new SemanticSearchGrpcClient(grpcTarget);
    } else {
      this.http = axios.create({
        baseURL: configService.get<string>('semanticSearch.apiUrl'),
        timeout: this.requestTimeout,
      });
    }
  }

  onModuleDestroy() {
    this.grpc?.close();
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
    let calibrated: boolean;
    try {
      ({
        chunks: collected,
        weakChunks: weakCollected,
        lastUpdateAt,
        calibrated,
      } = await this.collectChunks(query, k));
    } catch (error) {
      return this.handleFirstWindowFailure(error, query, k);
    }
    if (calibrated) {
      const strong = this.toNoticeHits(collected);
      const strongIds = new Set(strong.map((hit) => hit.noticeNum));
      return {
        query,
        mode: 'semantic',
        fallbackReason: null,
        lastUpdateAt,
        results: strong.slice(0, k),
        weakResults: this.toNoticeHits(weakCollected)
          .filter((hit) => !strongIds.has(hit.noticeNum))
          .slice(0, k),
      } satisfies SemanticSearchResponse;
    }
    return this.applyLexicalGate(
      query,
      k,
      lastUpdateAt,
      collected,
      weakCollected,
    );
  }

  /**
   * No-result gate over accumulated chunk windows. Runs after collection so
   * widening is unaffected; an emptied answer keeps the semantic shape
   * (`mode: 'semantic'`, null fallback) and never substitutes keyword hits —
   * an empty tier is the engine's real answer, same as the sidecar's own
   * unrelated-hit policy.
   */
  private applyLexicalGate(
    query: string,
    k: number,
    lastUpdateAt: string | null,
    collected: SemanticSidecarChunk[],
    weakCollected: SemanticSidecarChunk[],
  ): SemanticSearchResponse {
    // High-confidence bypass: the best dense score across both tiers sits
    // above the calibrated bar, so the ranking itself is trusted and the
    // gate (including its shadow prediction) stays out of the way.
    const bestScore = Math.max(
      collected[0]?.score ?? Number.NEGATIVE_INFINITY,
      weakCollected[0]?.score ?? Number.NEGATIVE_INFINITY,
    );
    const bypassed = bestScore >= this.lexicalBypassScore;
    const clear = this.toNoticeHitsWithEvidence(collected);
    const weak = this.toNoticeHitsWithEvidence(weakCollected);
    if (this.lexicalGate === 'off') {
      return {
        query,
        mode: 'semantic',
        fallbackReason: null,
        lastUpdateAt,
        results: clear.map(({ hit }) => hit).slice(0, k),
        weakResults: weak.map(({ hit }) => hit).slice(0, k),
      } satisfies SemanticSearchResponse;
    }
    const gatedClear = clear.filter(({ evidence }) => evidence);
    const gatedWeak = weak.filter(({ evidence }) => evidence);
    if (this.lexicalGate === 'shadow') {
      this.logger.log(
        `lexical-gate-shadow clear ${gatedClear.length}/${clear.length} ` +
          `weak ${gatedWeak.length}/${weak.length} ` +
          `wouldEmpty=${gatedClear.length === 0 && gatedWeak.length === 0} ` +
          `bypassed=${bypassed}`,
      );
      return {
        query,
        mode: 'semantic',
        fallbackReason: null,
        lastUpdateAt,
        results: clear.map(({ hit }) => hit).slice(0, k),
        weakResults: weak.map(({ hit }) => hit).slice(0, k),
      } satisfies SemanticSearchResponse;
    }
    const servedClear = bypassed ? clear : gatedClear;
    const servedWeak = bypassed ? weak : gatedWeak;
    return {
      query,
      mode: 'semantic',
      fallbackReason: null,
      lastUpdateAt,
      results: servedClear.map(({ hit }) => hit).slice(0, k),
      weakResults: servedWeak.map(({ hit }) => hit).slice(0, k),
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
    const status = semanticSidecarErrorStatus(error);
    if (status && status >= 400 && status < 500) {
      this.logger.warn(
        `semantic sidecar rejected the request (status ${status}): ${this.describeError(error)}`,
      );
      throw new BadRequestException(
        '의미 검색 요청이 거부되었습니다. 요청 형식을 확인해 주세요.',
      );
    }
    this.logger.warn(
      `semantic sidecar unavailable (${status ?? this.describeError(error)}); falling back to keyword search`,
    );
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
      const response = await measureSemanticSidecarCall(
        '/health',
        (trace) => this.readSidecarHealth(trace),
        this.grpc ? 'grpc' : 'http',
      );
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
      this.chunkCap = Math.min(reported, this.chunkCapCeiling);
    }
  }

  /** A 422 from `/search`: query or k outside the sidecar's accepted bounds. */
  private isChunkWindowRejected(error: unknown): boolean {
    return semanticSidecarErrorStatus(error) === 422;
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
   *
   * Budget policy: the whole loop runs against `totalTimeoutMs`. Each pass
   * shrinks its own axios timeout to the time left, and once the budget is
   * spent the loop stops — partial results when chunks were collected, a
   * propagated timeout error (the caller's fallback path) when nothing was.
   */
  private async collectChunkWindows(
    query: string,
    k: number,
    cap: number,
  ): Promise<{
    chunks: SemanticSidecarChunk[];
    weakChunks: SemanticSidecarChunk[];
    lastUpdateAt: string | null;
    calibrated: boolean;
  }> {
    const collected: SemanticSidecarChunk[] = [];
    const weakCollected: SemanticSidecarChunk[] = [];
    let lastUpdateAt: string | null = null;
    let calibrated = false;
    let hasWindow = false;
    let chunkK = Math.min(k * CHUNK_FETCH_INITIAL_FACTOR, cap);
    const deadline = Date.now() + this.totalTimeoutMs;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        if (!hasWindow) {
          throw new Error(
            `semantic sidecar total budget exceeded (${this.totalTimeoutMs}ms) ` +
              'before any window completed',
          );
        }
        this.logger.warn(
          `semantic sidecar total budget exceeded (${this.totalTimeoutMs}ms); ` +
            `returning partial results from ${collected.length} collected chunks`,
        );
        return {
          chunks: collected,
          weakChunks: weakCollected,
          lastUpdateAt,
          calibrated,
        };
      }
      let window: SemanticSidecarSearchResponse;
      try {
        window = await this.fetchChunks(
          query,
          chunkK,
          Math.min(this.requestTimeout, remainingMs),
        );
      } catch (error) {
        // An empty but successful filtered window is still a semantic answer.
        if (!hasWindow) {
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
          calibrated,
        };
      }
      const nextCalibrated = window.candidateCount != null;
      if (
        hasWindow &&
        (calibrated !== nextCalibrated || lastUpdateAt !== window.lastUpdateAt)
      ) {
        // Do not mix results from different index generations during widening.
        collected.length = 0;
        weakCollected.length = 0;
      }
      calibrated = nextCalibrated;
      hasWindow = true;
      collected.push(...window.results);
      // `weakResults` is contract-required, but the sidecar and this backend
      // deploy as separate containers: tolerate an older sidecar that
      // predates the tiered response rather than failing the whole search.
      const windowWeak = window.weakResults ?? [];
      weakCollected.push(...windowWeak);
      lastUpdateAt = window.lastUpdateAt;
      const hits = this.toNoticeHits(collected);
      const corpusExhausted =
        (window.candidateCount ?? window.results.length + windowWeak.length) <
        chunkK;
      if (hits.length >= k || corpusExhausted || chunkK >= cap) {
        return {
          chunks: collected,
          weakChunks: weakCollected,
          lastUpdateAt,
          calibrated,
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
      const response = await this.readSidecarHealth();
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

  private sidecarHeaders(trace?: SidecarTrace) {
    return trace
      ? {
          [TRACE_HEADER]: trace.traceId,
          [SEARCH_ATTEMPT_HEADER]: String(trace.attempt),
        }
      : undefined;
  }

  private readSidecarHealth(trace?: SidecarTrace) {
    return this.grpc
      ? this.grpc.health(this.requestTimeout, trace)
      : this.http!.get<SemanticSidecarHealthResponse>(
          '/health',
          ...(trace ? [{ headers: this.sidecarHeaders(trace) }] : []),
        );
  }

  private async fetchChunks(
    query: string,
    chunkK: number,
    requestTimeout: number,
  ): Promise<SemanticSidecarSearchResponse> {
    const response = await measureSemanticSidecarCall(
      '/search',
      (trace) =>
        this.grpc
          ? this.grpc.search(query, chunkK, requestTimeout, trace)
          : this.http!.get<SemanticSidecarSearchResponse>('/search', {
              params: { query, k: chunkK },
              timeout: requestTimeout,
              ...(trace && { headers: this.sidecarHeaders(trace) }),
            }),
      this.grpc ? 'grpc' : 'http',
      chunkK,
    );
    return response.data;
  }

  /**
   * Collapse chunk-level hits to notice-level results (best chunk per
   * notice), matching how retrieval quality is measured (notice-level rank).
   */
  private toNoticeHits(chunks: SemanticSidecarChunk[]) {
    return this.toNoticeHitsWithEvidence(chunks).map(({ hit }) => hit);
  }

  /**
   * Notice-deduplicated hits with one evidence flag per notice (OR over ALL
   * its chunks in the window; the best chunk decides the content). A sidecar
   * older than the flag omits it and counts as evidence present (fail-open).
   */
  private toNoticeHitsWithEvidence(chunks: SemanticSidecarChunk[]): Array<{
    hit: SemanticSearchResultItem;
    evidence: boolean;
  }> {
    const byNotice = new Map<
      number,
      { hit: SemanticSearchResultItem; evidence: boolean }
    >();
    for (const chunk of chunks) {
      const known = byNotice.get(chunk.noticeNum);
      const evidence = chunk.lexicalEvidence ?? true;
      if (known) {
        known.evidence = known.evidence || evidence;
        continue;
      }
      byNotice.set(chunk.noticeNum, {
        hit: {
          noticeNum: chunk.noticeNum,
          subject: chunk.subject,
          committee: chunk.committee,
          section: chunk.section,
          score: chunk.score,
          excerpt: chunk.text,
        },
        evidence,
      });
    }
    return [...byNotice.values()];
  }

  private describeError(error: unknown): string {
    return error instanceof AxiosError
      ? (error.code ?? error.message)
      : String((error as Error)?.message ?? error);
  }
}
