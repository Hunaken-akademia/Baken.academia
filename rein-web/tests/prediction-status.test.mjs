import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/prediction-status.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { missingPredictionItems, nextServerUpdate, updateScheduleText } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const ready = { roleModel: 'ready', overall: 'ready' };
const horse = (weight, odds = 3, popularity = 1) => ({ weight, odds, popularity });

test('lists missing same-day inputs with partial counts', () => {
  assert.deepEqual(missingPredictionItems({ horses: [horse(480), horse(470)], evaluation: ready }), []);
  assert.deepEqual(missingPredictionItems({ horses: [horse(null), horse(null)], evaluation: ready }), ['馬体重（未発表）']);
  assert.deepEqual(
    missingPredictionItems({ horses: [horse(480, null, 0), horse(null)], evaluation: { roleModel: 'unavailable', overall: 'held' } }),
    ['馬体重（1頭未取得）', '人気・オッズ（1頭未取得）', '着順別モデルの評価', '総合評価'],
  );
  assert.deepEqual(missingPredictionItems({ horses: [], evaluation: ready }), ['出走表']);
});

test('next server update follows the JRA and NAR cron minutes inside the 60-minute window', () => {
  const start = Date.parse('2026-10-04T15:40:00+09:00');
  assert.equal(nextServerUpdate(start, Date.parse('2026-10-04T13:00:00+09:00')).phase, 'waiting');
  assert.equal(nextServerUpdate(start, Date.parse('2026-10-04T13:00:00+09:00')).label, '14:40');
  assert.equal(nextServerUpdate(start, Date.parse('2026-10-04T15:01:00+09:00')).label, '15:10');
  assert.equal(nextServerUpdate(start, Date.parse('2026-10-04T15:01:00+09:00'), 'nar').label, '15:05');
  assert.equal(nextServerUpdate(start, Date.parse('2026-10-04T15:31:00+09:00')).phase, 'final');
  assert.equal(nextServerUpdate(start, start).phase, 'started');
  assert.equal(nextServerUpdate(null, Date.now()), null);
  assert.match(updateScheduleText(start, Date.parse('2026-10-04T13:00:00+09:00')), /14:40.*10分ごと/);
  assert.match(updateScheduleText(start, Date.parse('2026-10-04T15:01:00+09:00')), /次の自動更新は15:10ごろ/);
});
