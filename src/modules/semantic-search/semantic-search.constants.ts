/**
 * Semantic search wire contract limits — the single owner on the backend side.
 *
 * The sidecar counterpart lives in `semantic-search/lawcast_semantic/config.py`
 * (`MAX_K`, `DEFAULT_K`, env-injectable defaults); the wire models stay in
 * `semantic-search/service/app.py`. `semantic-search.contract.spec.ts` pins
 * both declarations together so cross-language drift fails the test suite.
 * Do not duplicate these numbers anywhere else.
 */

/** Default number of notice-level results returned by the API endpoint. */
export const DEFAULT_K = 5;

/** Maximum k accepted from API clients (notice count). */
export const MAX_K = 50;

/**
 * Fallback chunk-window cap: the value the sidecar hardcodes when it is too
 * old to report `maxK` from `/health` (`MAX_K` in
 * `semantic-search/lawcast_semantic/config.py`). The sidecar ranks chunks
 * while the API returns notices, so the service over-requests chunks to fill
 * k after chunk-to-notice dedup — normally clamped to the cap the sidecar
 * reports at runtime (SemanticSearchService.resolveChunkCap), not to this
 * constant; keep them equal so an env change on the sidecar needs no backend
 * deploy (the contract spec pins both defaults together).
 */
export const SIDE_CAR_MAX_CHUNK_K = 100;

/** First chunk window request: k * factor, clamped to the sidecar cap. */
export const CHUNK_FETCH_INITIAL_FACTOR = 3;

/** Chunk window growth per widening pass. */
export const CHUNK_FETCH_GROWTH = 2;
