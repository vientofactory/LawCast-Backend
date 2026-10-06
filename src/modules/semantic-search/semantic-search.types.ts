/**
 * Semantic search API contract.
 *
 * `results` is uniformly notice-deduplicated: semantic hits carry the best
 * chunk per notice (section/score/excerpt populated), keyword fallback hits
 * carry only notice metadata (section/score/excerpt null).
 *
 * `weakResults` carries the engine's weak-relevance tier (cosine score
 * between the sidecar's floor and clear thresholds) — never mixed into
 * `results`, so the frontend can hide them behind an explicit reveal when
 * the clear tier is empty. Keyword fallback responses always carry [].
 */
export type SemanticSearchMode = 'semantic' | 'keyword_fallback';

export interface SemanticSearchResultItem {
  noticeNum: number;
  subject: string;
  committee: string;
  section: string | null;
  score: number | null;
  excerpt: string | null;
}

export interface SemanticSearchResponse {
  query: string;
  mode: SemanticSearchMode;
  fallbackReason: string | null;
  lastUpdateAt: string | null;
  results: SemanticSearchResultItem[];
  weakResults: SemanticSearchResultItem[];
}

/** One ranked chunk returned by the semantic search sidecar. */
export interface SemanticSidecarChunk {
  chunkId: string;
  noticeNum: number;
  subject: string;
  committee: string;
  section: string;
  score: number;
  text: string;
}

export interface SemanticSidecarSearchResponse {
  query: string;
  k: number;
  model: string | null;
  lastUpdateAt: string | null;
  results: SemanticSidecarChunk[];
  /** Weak-band hits (MIN_SIMILARITY <= score < CLEAR_SIMILARITY). */
  weakResults: SemanticSidecarChunk[];
}

/**
 * Engine readiness as reported by the sidecar's `GET /health` `status`
 * field: `loading` while the engine loads, `ready` once it serves,
 * `failed` after an unrecoverable load error.
 */
export type SemanticEngineStatus = 'loading' | 'ready' | 'failed';

/**
 * Engine status fields shown in the frontend 의미 검색 status block and
 * its search-unavailable overlay.
 *
 * Field names are passed through verbatim from the sidecar's `GET /health`
 * payload (`health()` in semantic-search/service/app.py), which carries more
 * observation fields than these — only what the UI displays crosses the API
 * boundary here. `status` is the readiness gate the overlay keys on.
 */
export interface SemanticEngineHealthResponse {
  status: SemanticEngineStatus;
  indexedChunks: number;
  lastUpdateAt: string | null;
  lastUpdateTriggeredAt: string | null;
}
