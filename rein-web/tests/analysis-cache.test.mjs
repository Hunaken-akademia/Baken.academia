import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/analysis-cache.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { backfillPage, isSnapshotFresh, metaFromBody, planPrecompute, snapshotTtlSeconds } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const now = new Date('2026-09-26T02:00:00Z'); // 11:00 JST
const minutes = (n) => n * 60_000;
const at = (hhmm) => Date.parse(`2026-09-26T${hhmm}:00+09:00`);
const meta = (ageMinutes, extra = {}) => ({
  generatedAt: new Date(now.getTime() - minutes(ageMinutes)).toISOString(),
  startsAt: at('11:30'), final: false, preview: false, ...extra,
});

test('freshness follows the cron cadence: 12 min near the start, 180 min earlier, results forever', () => {
  assert.equal(isSnapshotFresh(meta(11), now.getTime()), true);
  assert.equal(isSnapshotFresh(meta(13), now.getTime()), false);
  assert.equal(isSnapshotFresh(meta(50, { startsAt: at('14:00') }), now.getTime()), true);
  assert.equal(isSnapshotFresh(meta(181, { startsAt: at('14:00') }), now.getTime()), false);
  assert.equal(isSnapshotFresh(meta(600, { final: true }), now.getTime()), true);
  assert.equal(isSnapshotFresh(meta(170, { preview: true }), now.getTime()), true);
  assert.equal(isSnapshotFresh(meta(361, { preview: true }), now.getTime()), false);
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
    ['live:later-stale', meta(181, { startsAt: at('13:00') })],
    ['live:near-1', meta(1)],
    ['live:finished', meta(30, { startsAt: at('10:20') })],
    ['live:finished-done', meta(5, { final: true })],
    ['preview:tomorrow-fresh', meta(10, { preview: true })],
  ]);
  const plan = planPrecompute(races, metas, now);
  assert.deepEqual(plan.map((job) => `${job.raceId}:${job.reason}`), [
    'near-2:near-start',
    'later-stale:stale', 'later-missing:missing',
    'finished:result', 'old:result',
    'tomorrow-missing:missing',
  ]);
});

test('a race 65 minutes away is prioritized so the 60-minute forecast is ready', () => {
  const race = { raceId: 'weight-window', start: '12:05', preview: false };
  assert.equal(planPrecompute([race], new Map(), now)[0].reason, 'near-start');
});

test('yesterday result catch-up uses the race date and completed races are not recalculated', () => {
  const race = {raceId: 'yesterday', start: '16:00', date: '2026-09-25', preview:false};
  assert.equal(planPrecompute([race],new Map(),now)[0].reason,'result');
  assert.deepEqual(planPrecompute([race],new Map([['live:yesterday',meta(500,{final:true})]]),now),[]);
});

test('a held card remains displayable but eligible for result refresh', () => {
  const body = {race:{startsAt:at('10:00')},prediction:{generatedAt:now.toISOString()},review:{isFinished:true},capture:{complete:false}};
  const value = metaFromBody(body,false);
  assert.equal(value.final,false);
  assert.equal(isSnapshotFresh(value,now.getTime()),true);
  assert.equal(isSnapshotFresh(value,now.getTime()+minutes(13)),false);
  assert.equal(planPrecompute([{raceId:'held',start:'10:00',preview:false}],new Map([['live:held',value]]),now)[0].reason,'result');
});

test('historical cursor moves past saved cards without results and leaves later races eligible', () => {
  const races = ['202512140309','202512140305','202512140306','202512140310'].map(raceId => ({raceId,start:'16:00',date:'2025-12-14',preview:false}));
  const metas = new Map(races.map(r=>['live:'+r.raceId,meta(1)]));
  const pending = planPrecompute(races,metas,now);
  assert.deepEqual(backfillPage(pending,'').map(r=>r.raceId),['202512140305','202512140306','202512140309','202512140310']);
  assert.deepEqual(backfillPage(pending,'202512140306').map(r=>r.raceId),['202512140309','202512140310']);
  assert.equal(metas.get('live:202512140305').final,false);
  assert.equal(backfillPage(pending,'').length,4);
});
