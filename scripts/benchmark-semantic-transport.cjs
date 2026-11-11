#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const axios = require('axios');
const { loadSync } = require('@grpc/proto-loader');
const {
  SemanticSearchGrpcClient,
} = require('../dist/modules/semantic-search/semantic-search-grpc.client');

const [httpUrl = 'http://127.0.0.1:8300', grpcTarget = '127.0.0.1:8301'] =
  process.argv.slice(2);
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
const http = axios.create({ baseURL: httpUrl, timeout: 30_000, proxy: false });
const grpc = new SemanticSearchGrpcClient(grpcTarget);
const schema = loadSync(
  join(__dirname, '../dist/modules/semantic-search/semantic_search.proto'),
);
const { responseSerialize } =
  schema['lawcast.semantic.v1.SemanticSearch'].Search;

const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];

function signature({ timings: _timings, candidateCount, ...response }) {
  return { ...response, candidateCount: candidateCount ?? null };
}

async function request(transport, query, k) {
  const start = performance.now();
  const response =
    transport === 'HTTP'
      ? await http.get('/search', { params: { query, k } })
      : await grpc.search(query, k, 30_000);
  return { elapsed: performance.now() - start, ...response };
}

async function main() {
  const [{ data: engine }, { data: peer }] = await Promise.all([
    http.get('/health'),
    grpc.health(5_000),
  ]);
  assert.equal(engine.status, 'ready');
  for (const key of Object.keys(peer)) assert.deepEqual(peer[key], engine[key]);
  const windows = [...new Set([Math.min(engine.maxK, 5), engine.maxK])];
  const comparisons = [];
  const payloads = {};
  for (const k of windows) {
    // Pair all queries before timing; warm both protocols and the model.
    const bytes = { HTTP: [], gRPC: [] };
    for (const query of queries) {
      const baseline = await request('HTTP', query, k);
      const candidate = await request('gRPC', query, k);
      assert.deepEqual(signature(candidate.data), signature(baseline.data));
      bytes.HTTP.push(Number(baseline.headers['content-length']));
      bytes.gRPC.push(responseSerialize(baseline.data).length);
    }
    payloads[k] = Object.fromEntries(
      Object.entries(bytes).map(([key, sizes]) => [
        key,
        { p50: percentile(sizes, 0.5), p95: percentile(sizes, 0.95) },
      ]),
    );

    for (const concurrency of [1, 6]) {
      const rows = { HTTP: [], gRPC: [] };
      const wall = { HTTP: 0, gRPC: 0 };
      // ABBA balances temporal drift without having the transports compete.
      for (const order of [
        ['HTTP', 'gRPC'],
        ['gRPC', 'HTTP'],
        ['gRPC', 'HTTP'],
        ['HTTP', 'gRPC'],
      ]) {
        for (const protocol of order) {
          for (let offset = 0; offset < queries.length; offset += concurrency) {
            const start = performance.now();
            const batch = await Promise.all(
              queries
                .slice(offset, offset + concurrency)
                .map((q) => request(protocol, q, k)),
            );
            wall[protocol] += performance.now() - start;
            rows[protocol].push(
              ...batch.map(({ elapsed, data }) => ({
                query: data.query,
                elapsed,
                pipeline: data.timings.totalMs,
              })),
            );
          }
        }
      }
      comparisons.push({
        k,
        concurrency,
        arms: Object.fromEntries(
          Object.entries(rows).map(([protocol, samples]) => {
            const metric = (read) => ({
              p50: percentile(samples.map(read), 0.5),
              p95: percentile(samples.map(read), 0.95),
            });
            return [
              protocol,
              {
                requests: samples.length,
                requestsPerSecond: samples.length / (wall[protocol] / 1000),
                roundTripMs: metric((row) => row.elapsed),
                pipelineMs: metric((row) => row.pipeline),
                residualMs: metric((row) => row.elapsed - row.pipeline),
                samples,
              },
            ];
          }),
        ),
      });
    }
  }
  const { data: after } = await http.get('/health');
  assert.equal(after.generation, engine.generation);
  console.log(
    JSON.stringify(
      {
        engine: {
          model: engine.model,
          device: engine.device,
          generation: engine.generation,
          indexedChunks: engine.indexedChunks,
          lastUpdateAt: engine.lastUpdateAt,
        },
        queries,
        parityPairs: queries.length * windows.length,
        payloadBytes: payloads,
        comparisons,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => grpc.close());
