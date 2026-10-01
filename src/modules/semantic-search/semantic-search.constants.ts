/**
 * Semantic search wire contract limits — the single owner on the backend side.
 *
 * The sidecar counterpart lives in `semantic-search/service/app.py`
 * (`MAX_K`, `DEFAULT_K`); `semantic-search.contract.spec.ts` pins both
 * declarations together so cross-language drift fails the test suite.
 * Do not duplicate these numbers anywhere else.
 */

/** Default number of notice-level results returned by the API endpoint. */
export const DEFAULT_K = 5;

/** Maximum k accepted from API clients (notice count). */
export const MAX_K = 50;

/**
 * Maximum chunk window the sidecar accepts on `/search` (`MAX_K` in
 * `service/app.py`). The sidecar ranks chunks while the API returns
 * notices, so the service over-requests chunks to fill k after
 * chunk-to-notice dedup.
 */
export const SIDE_CAR_MAX_CHUNK_K = 200;

/** First chunk window request: k * factor, clamped to the sidecar cap. */
export const CHUNK_FETCH_INITIAL_FACTOR = 3;

/** Chunk window growth per widening pass. */
export const CHUNK_FETCH_GROWTH = 2;
