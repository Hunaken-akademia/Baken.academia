import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/race-confidence.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildRaceConfidence, raceConfidenceLevel, RACE_CONFIDENCE_THRESHOLDS } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('frozen validation thresholds map to the four Japanese confidence levels', () => {
  assert.equal(raceConfidenceLevel(RACE_CONFIDENCE_THRESHOLDS.cautious), '慎重');
  assert.equal(raceConfidenceLevel(RACE_CONFIDENCE_THRESHOLDS.cautious + 1e-9), '標準');
  assert.equal(raceConfidenceLevel(RACE_CONFIDENCE_THRESHOLDS.standard), '標準');
  assert.equal(raceConfidenceLevel(RACE_CONFIDENCE_THRESHOLDS.standard + 1e-9), '高め');
  assert.equal(raceConfidenceLevel(RACE_CONFIDENCE_THRESHOLDS.high), '高め');
  assert.equal(raceConfidenceLevel(RACE_CONFIDENCE_THRESHOLDS.high + 1e-9), 'かなり高い');
});

test('confidence is the top-three share of the complete market-difference scores', () => {
  const confidence = buildRaceConfidence([1, 4, 1, 3, 1, 2]);
  assert.deepEqual(confidence, {
    label: 'かなり高い',
    top3Share: 0.75,
    sharePercent: 75,
    detail: '上位3頭への指数集中が非常に強いです。',
    note: '上位3頭への集中度です。期待回収率や賭け金を示すものではありません。',
  });
  assert.deepEqual(buildRaceConfidence([10, 40, 10, 30, 10, 20]), confidence);
});

test('incomplete or invalid score sets are held instead of estimated', () => {
  assert.equal(buildRaceConfidence([4, 3, 2]), null);
  assert.equal(buildRaceConfidence([4, 3, 2, null]), null);
  assert.equal(buildRaceConfidence([4, 3, 2, 0]), null);
  assert.equal(buildRaceConfidence([4, 3, 2, Number.NaN]), null);
});
