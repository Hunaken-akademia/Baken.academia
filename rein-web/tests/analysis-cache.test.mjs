import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/analysis-cache.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { isSnapshotFresh, metaFromBody, planPrecompute, snapshotTtlSeconds } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const now = new Date('2026-09-26T02:00:00Z'); // 11:00 JST
const minutes = (n) => n * 60_000;
const at = (hhmm) => Date.parse(`2026-09-26T${hhmm}:00+09:00`);
const meta = (ageMinutes, extra = {}) => ({
  generatedAt: new Date(now.getTime() - minutes(ageMinutes)).toISOString(),
  startsAt: at('11:30'), final: false, preview: false, ...extra,
});

test('freshness follows the cron cadence: 12 min near the start, 65 min earlier, results forever', () => {
  assert.equal(isSnapshotFresh(meta(11), now.getTime()), true);
  assert.equal(isSnapshotFresh(meta(13), now.getTime()), false);
  assert.equal(isSnapshotFresh(meta(50, { startsAt: at('14:00') }), now.getTime()), true);
  assert.equal(isSnapshotFresh(meta(70, { startsAt: at('14:00') }), now.getTime()), false);
  assert.equal(isSnapshotFresh(meta(600, { final: true }), now.getTime()), true);
  assert.equal(isSnapshotFresh(meta(170, { preview: true }), now.getTime()), true);
  assert.equal(isSnapshotFresh(meta(190, { preview: true }), now.getTime()), false);
  // Snapshots written before startsAt existed are treated as near-start.
  assert.equal(isSnapshotFresh(meta(13, { startsAt: null }), now.getTime()), false);
  assert.ok(snapshotTtlSeconds(meta(0)) * 1000 > minutes(65));
});

test('metadata is read from the analysis body', () => {
  const body = { race: { startsAt: at('11:30') }, prediction: { generatedAt: now.toISOString() }, review: { isFinished: true } };
  assert.deepEqual(metaFromBody(body, false), { generatedAt: now.toISOString(), startsAt: at('11:30'), final: true, preview: false });
  assert.equal(metaFromBody({}, false), null);
});

test('cron plan: near-start first, then missing/stale later races, then results, then previews', () => {
  const races = [
    { raceId: 'later-fresh', start: '14:00', preview: false },
    { raceId: 'later-missing', start: '15:00', preview: false },
    { raceId: 'later-stale', start: '13:00', preview: false },
    { raceId: 'near-2', start: '11:50', preview: false },
    { raceId: 'near-1', start: '11:10', preview: false },
    { raceId: 'running', start: '10:55', preview: false },
    { raceId: 'finished', start: '10:20', preview: false },
    { raceId: 'finished-done', start: '10:00', preview: false },
    { raceId: 'old', start: '09:00', preview: false },
    { raceId: 'tomorrow-missing', start: '10:00', preview: true },
    { raceId: 'tomorrow-fresh', start: '11:00', preview: true },
  ];
  const metas = new Map([
    ['live:later-fresh', meta(20, { startsAt: at('14:00') })],
    ['live:later-stale', meta(56, { startsAt: at('13:00') })],
    ['live:near-1', meta(1)],
    ['live:finished', meta(30, { startsAt: at('10:20') })],
    ['live:finished-done', meta(5, { final: true })],
    ['preview:tomorrow-fresh', meta(10, { preview: true })],
  ]);
  const plan = planPrecompute(races, metas, now);
  assert.deepEqual(plan.map((job) => `${job.raceId}:${job.reason}`), [
    'near-1:near-start', 'near-2:near-start',
    'later-stale:stale', 'later-missing:missing',
    'finished:result',
    'tomorrow-missing:missing',
  ]);
});
