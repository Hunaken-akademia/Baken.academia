import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const uri = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const compile = name => ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { historyFactors, historyRate, careerDifference, roleRanks, filterHorses } = await import(uri(compile('horse-research').replace('"./marks"', JSON.stringify(uri(compile('marks'))))));
const horses = [
  { number: 8, name: 'テストホース', jockey: '騎手Ａ', popularity: 4, firstProbability: .3, secondProbability: .1 },
  { number: 2, name: '先行', popularity: 1, firstProbability: .3, secondProbability: .5 },
  { number: 5, name: '差し', popularity: 0, firstProbability: .1, secondProbability: .2 },
];
const options = { query: '', filter: 'all', sort: 'first', role: 'first', selected: [], rolesReady: true, overallReady: true };
test('comparison uses canonical full-field ranks and stable model ties without mutating inputs', () => {
  const before = JSON.stringify(horses);
  assert.deepEqual([...roleRanks(horses, 'first', true)], [[8, 1], [2, 2], [5, 3]]);
  assert.deepEqual(filterHorses(horses, { ...options, filter: 'longshot' }).map(h => h.number), [8]);
  assert.equal(roleRanks(horses, 'first', true).get(8), 1);
  assert.equal(JSON.stringify(horses), before);
});
test('switching roles changes ordering; unknown popularity sorts last and is not a longshot', () => {
  assert.deepEqual(filterHorses(horses, { ...options, sort: 'second' }).map(h => h.number), [2, 5, 8]);
  assert.deepEqual(filterHorses(horses, { ...options, sort: 'popularity' }).map(h => h.number), [2, 8, 5]);
});
test('held or partially missing models do not produce fabricated ranks or top-five matches', () => {
  assert.equal(roleRanks(horses, 'first', false).size, 0);
  for (const value of [undefined, null, NaN, Infinity, -0.1, 1.1]) {
    const incomplete = horses.map((h, i) => i === 0 ? { ...h, firstProbability: value } : h);
    assert.equal(roleRanks(incomplete, 'first', true).size, 0);
    assert.deepEqual(filterHorses(incomplete, { ...options, filter: 'top5' }), []);
  }
});
test('search normalizes full-width input, selected filter respects the current field', () => {
  assert.deepEqual(filterHorses(horses, { ...options, query: '８' }).map(h => h.number), [8]);
  assert.deepEqual(filterHorses(horses, { ...options, query: '騎手a' }).map(h => h.number), [8]);
  assert.deepEqual(filterHorses(horses, { ...options, filter: 'selected', selected: [5, 99] }).map(h => h.number), [5]);
});
test('empty parameter factors preserve older snapshot history and duplicate labels are merged once', () => {
  const old = { label: '通算成績', samples: 20, winRate: 10, top3Rate: 40 };
  assert.deepEqual(historyFactors({ parameterFactors: [], historyFactors: [old] }), [old]);
  const latest = { ...old, samples: 25, top3Rate: 44 };
  assert.deepEqual(historyFactors({ parameterFactors: [latest], historyFactors: [old] }), [latest]);
  assert.deepEqual(historyFactors({ parameterFactors: [{ ...old, samples: 0 }], historyFactors: [old] }), [old]);
});
test('missing rates stay unknown while real zero percent and count-based rates are preserved', () => {
  assert.equal(historyRate(undefined, 'top3'), null);
  assert.equal(historyRate({ samples: 0, top3Rate: 0 }, 'top3'), null);
  assert.equal(historyRate({ samples: 10 }, 'top3'), null);
  assert.equal(historyRate({ samples: 10, top3Rate: 0 }, 'top3'), 0);
  assert.equal(historyRate({ samples: 10, wins: 2 }, 'win'), 20);
  assert.equal(historyRate({ samples: 10, top3: 11 }, 'top3'), null);
});
test('career differences use percentage points and never compare jockey totals against a horse', () => {
  const career = { label: '通算成績', samples: 20, top3Rate: 40 };
  assert.equal(careerDifference({ label: '距離適性', samples: 6, top3Rate: 50 }, career), 10);
  assert.equal(careerDifference({ label: '近5走', samples: 5, top3Rate: 0 }, career), -40);
  assert.equal(careerDifference({ label: '騎手傾向', samples: 100, top3Rate: 50 }, career), null);
  assert.equal(careerDifference({ label: '距離適性', samples: 0, top3Rate: 0 }, career), null);
  assert.equal(careerDifference(career, career), null);
});
