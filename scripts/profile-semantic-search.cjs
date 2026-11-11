#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { performance } = require('node:perf_hooks');
const {
  SemanticSearchGrpcClient,
} = require('../dist/modules/semantic-search/semantic-search-grpc.client');

const [
  target,
  serverLog,
  label,
  mode = 'replay',
  rawK = '50',
  rawConcurrency = '6',
] = process.argv.slice(2);
const coldK = Number(rawK);
const coldConcurrency = Number(rawConcurrency);
assert(
  target && serverLog && label,
  'Usage: node scripts/profile-semantic-search.cjs TARGET LOG LABEL [replay|cold|widen] [coldK] [coldConcurrency]',
);
assert(['replay', 'cold', 'widen'].includes(mode));
assert([5, 50].includes(coldK) && [1, 6].includes(coldConcurrency));

// Same ordered workload as the HTTP/gRPC transport comparison.
const queries = [
  '전세사기 피해자 지원',
  '아동 학대 예방',
  '개인정보 보호',
  '주차장 전기차 화재',
  '근로시간 단축',
  '교통약자 이동편의',
  '응급의료 인력',
  '소상공인 금융 지원',
  '학교 급식',
  '인공지능 안전 규제',
  '기후위기 대응',
  '지역 의료 격차',
];
const grpc = new SemanticSearchGrpcClient(target);
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const stats = (values) => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
});
const timingLines = () =>
  Array.from(
    readFileSync(serverLog, 'utf8').matchAll(
      /search-timing k=(\d+) .* admission_ms=([\d.]+) rank_wait_ms=([\d.]+)/g,
    ),
    ([, k, admission, rank]) => ({ k: +k, admission: +admission, rank: +rank }),
  );

async function queryOnce(query, k) {
  const start = performance.now();
  const { data } = await grpc.search(query, k, 15_000);
  const elapsed = performance.now() - start;
  const { timings, ...response } = data;
  const dense = timings.denseStages;
  assert(dense, 'Missing dense timing spans');
  return {
    query,
    elapsed,
    ...(mode === 'cold' && {
      ranks: [data.results, data.weakResults].map((tier) =>
        tier.map(({ chunkId, noticeNum, score }) => [
          chunkId,
          noticeNum,
          score,
        ]),
      ),
    }),
    embedding: dense.embedding.durationMs,
    model: dense.embeddingStages?.model.durationMs ?? 0,
    faiss: dense.faiss.durationMs,
    classification: dense.classification.durationMs,
    annotation: timings.annotateMs,
    pipeline: timings.totalMs,
    hash: createHash('sha256').update(JSON.stringify(response)).digest('hex'),
  };
}

async function main() {
  const { data: engine } = await grpc.health(5_000);
  assert.equal(engine.status, 'ready');
  assert(engine.maxK >= 50);
  // Warm the runtime without pre-populating any measured query vector.
  for (const text of [
    '임대 계약 갱신 절차',
    '산업재해 피해 보상',
    '수자원 관리 정책',
  ]) {
    await queryOnce(text, 5);
  }
  const cases =
    mode !== 'replay'
      ? [mode === 'cold' ? [coldK, coldConcurrency] : [50, 6]]
      : [
          [5, 1],
          [5, 6],
          [50, 1],
          [50, 6],
        ];
  const comparisons = [];
  for (const [k, concurrency] of cases) {
    if (mode === 'replay') {
      for (const query of queries) await queryOnce(query, k);
    }
    const logStart = timingLines().length;
    const rows = [];
    let wallMs = 0;
    for (let round = 0; round < (mode === 'replay' ? 4 : 1); round++) {
      for (let offset = 0; offset < queries.length; offset += concurrency) {
        const start = performance.now();
        rows.push(
          ...(await Promise.all(
            queries.slice(offset, offset + concurrency).map(async (text) => {
              if (mode !== 'widen') return queryOnce(text, k);
              const first = await queryOnce(text, 5);
              const second = await queryOnce(text, k);
              return {
                ...second,
                elapsed: first.elapsed + second.elapsed,
                first,
                second,
              };
            }),
          )),
        );
        wallMs += performance.now() - start;
      }
    }
    // Server records are in completion order, not Node's submission order.
    // Report queue percentiles independently; do not join individual samples.
    const queue = timingLines().slice(logStart);
    if (mode === 'widen') {
      assert.equal(queue.filter((row) => row.k === 5).length, rows.length);
      assert.equal(queue.filter((row) => row.k === k).length, rows.length);
      assert.equal(queue.length, 2 * rows.length);
      comparisons.push({
        k,
        concurrency,
        requests: 2 * rows.length,
        twoWindowMs: stats(rows.map((row) => row.elapsed)),
        firstEmbeddingMs: stats(rows.map((row) => row.first.embedding)),
        secondEmbeddingMs: stats(rows.map((row) => row.second.embedding)),
        rows,
        queue,
      });
      continue;
    }
    if (mode === 'cold') {
      assert(
        rows.every((row) => row.model > 0),
        'Every timed request must run the model',
      );
    }
    assert.equal(queue.length, rows.length);
    assert(queue.every((row) => row.k === k));
    comparisons.push({
      k,
      concurrency,
      requests: rows.length,
      requestsPerSecond: rows.length / (wallMs / 1000),
      metrics: Object.fromEntries([
        ...[
          'elapsed',
          'embedding',
          'model',
          'faiss',
          'classification',
          'annotation',
          'pipeline',
        ].map((field) => [field, stats(rows.map((row) => row[field]))]),
        ['workerWait', stats(queue.map((row) => row.admission + row.rank))],
      ]),
      rows,
      queue,
    });
  }
  assert.deepEqual((await grpc.health(5_000)).data, engine);
  console.log(
    JSON.stringify({ label, mode, engine, queries, comparisons }, null, 2),
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => grpc.close());
