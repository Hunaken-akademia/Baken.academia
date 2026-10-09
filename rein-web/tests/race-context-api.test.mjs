import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const uri = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const compile = name => ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const cache = new Map();
let reads = 0, fetches = 0, failSource = false;
globalThis.__reinContextQA = {
  getCache: ({ namespace }) => ({ get: async k => cache.get(namespace + k), set: async (k, v) => { cache.set(namespace + k, v); } }),
  serverData: async (action, { raceId }) => {
    reads++; assert.equal(action, 'race-context');
    return { target: { raceId, date: '2026-10-10', course: '芝1600m', startsAt: Date.parse('2026-10-10T05:00:00Z'), horses: [{ number: 1, horseId: '00101', name: 'テスト馬' }] }, races: [] };
  },
  fetchSource: async url => {
    fetches++; if (failSource) throw new Error('upstream down');
    const raceId = new URL(url).pathname.split('/').at(-1);
    return `<meta property="og:url" content="https://sports.yahoo.co.jp/keiba/race/denma/${raceId}?detail=1"><table id="denma_latest"><tr><td><p class="hr-denma__number">1</p><a href="/keiba/directory/horse/101/">テスト馬</a></td></tr></table><table id="denma_past"><tr><td class="hr-tableScroll__data--race"><p class="hr-denma__date">2026/09/27 東京</p><p class="hr-denma__date">芝・左1800m 良</p></td></tr></table>`;
  },
};
let code = compile('race-context-server')
  .replace('import { NextRequest, NextResponse } from "next/server";', 'const NextResponse = {json: (v, init) => Response.json(v, init)};')
  .replace('import { NextResponse } from "next/server";', 'const NextResponse = {json: (v, init) => Response.json(v, init)};')
  .replace('import { getCache } from "@vercel/functions";', 'const { getCache } = globalThis.__reinContextQA;')
  .replace('import { serverData } from "./server-snapshots";', 'const { serverData } = globalThis.__reinContextQA;')
  .replace('import { fetchSource } from "./source-fetch";', 'const { fetchSource } = globalThis.__reinContextQA;');
for (const dep of ['nar-source', 'previous-run', 'race-day-trends']) code = code.replace(JSON.stringify('./' + dep), JSON.stringify(uri(compile(dep))));
const { raceContextResponse } = await import(uri(code));
const request = id => ({ nextUrl: new URL(`https://example.com/api/analyze/context?raceId=${id}`) });
test('context API validates IDs, joins facts, deduplicates requests and never starts model inference', async () => {
  assert.equal((await raceContextResponse(request('bogus'), 'jra')).status, 400);
  assert.equal((await raceContextResponse(request('202610103111'), 'jra')).status, 400);
  assert.equal((await raceContextResponse(request('2605040308'), 'nar')).status, 400);
  assert.equal(reads, 0);
  const results = await Promise.all(Array.from({ length: 4 }, () => raceContextResponse(request('2605040308'), 'jra')));
  assert.equal(reads, 1); assert.equal(fetches, 1);
  const body = await results[0].json();
  assert.equal(body.previousRuns[1].distanceM, 1800); assert.equal(body.trends.raceCount, 0);
  assert.equal(results[0].headers.get('cache-control'), 'private, no-store');
  await raceContextResponse(request('2605040308'), 'jra'); assert.equal(reads, 1);
});
test('source failure preserves independent day trends and reports missing previous data', async () => {
  failSource = true;
  const response = await raceContextResponse(request('2605040309'), 'jra'), body = await response.json();
  assert.equal(response.status, 200); assert.match(body.previousError, /取得できません/); assert.equal(body.trends.raceCount, 0); assert.deepEqual(body.previousRuns, {});
});
