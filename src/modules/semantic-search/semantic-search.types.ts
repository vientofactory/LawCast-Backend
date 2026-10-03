/**
 * Semantic search API contract.
 *
 * `results` is uniformly notice-deduplicated: semantic hits carry the best
 * chunk per notice (section/score/excerpt populated), keyword fallback hits
 * carry only notice metadata (section/score/excerpt null).
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
}

/**
 * Engine status fields shown in the frontend 의미 검색 status block.
 *
 * Field names are passed through verbatim from the sidecar's `GET /health`
 * payload (`health()` in semantic-search/service/app.py), which carries more
 * observation fields than these three — only what the UI displays crosses
 * the API boundary here.
 */
export interface SemanticEngineHealthResponse {
  indexedChunks: number;
  lastUpdateAt: string | null;
  lastUpdateTriggeredAt: string | null;
}
