import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function load(name) {
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const { featureLabel, reasonViews, OTHER_FEATURE_LABEL } = await load('feature-labels');
const { selectPicks, roleOrder } = await load('marks');
const { isRunnerRow, isScratched, parseSexAge, horseName } = await load('race-card');

const secondSchema = JSON.parse(readFileSync(new URL('../api/models/second_joint_v5.schema.json', import.meta.url), 'utf8'));
const marketFeatures = readFileSync(new URL('../api/models/market_difference/first_rein.txt', import.meta.url), 'utf8')
  .match(/feature_names=(.*)/)[1].split(' ');
// Units such as "200m" are fine; variable names (underscores, English words) are not.
const ascii = /_|[A-Za-z]{2,}/;

test('every packaged model feature has a Japanese label without internal names', () => {
  for (const feature of [...secondSchema.feature_order, ...marketFeatures]) {
    const label = featureLabel(feature);
    assert.notEqual(label, OTHER_FEATURE_LABEL, feature);
    assert.ok(!ascii.test(label), `${feature} -> ${label}`);
  }
});

test('labels follow the computed definitions from the screenshot items', () => {
  assert.equal(featureLabel('jockey_id'), '騎手に関する評価');
  assert.equal(featureLabel('trainer_id'), '厩舎に関する評価');
  assert.equal(featureLabel('field_size'), '出走頭数');
  assert.equal(featureLabel('horse_recent5_avg_finish'), '近5走の平均着順');
  assert.equal(featureLabel('horse_surface_avg_finish'), '同じ馬場種別（芝・ダート・障害）での平均着順');
  assert.equal(featureLabel('prior_past_popularity'), '前走の人気順位');
  assert.equal(featureLabel('prior_finish_pct'), '前走の着順（着順÷出走頭数）');
  assert.equal(featureLabel('prior_speed_relative'), '前走の走破速度（同レースの中央値との差）');
  assert.equal(featureLabel('recent3_result_strength_field_gap'), '近3走の成績指数（出走馬平均との差）');
  assert.ok(!featureLabel('prior_finish_pct').includes('好走率'));
  assert.ok(!featureLabel('horse_surface_avg_finish').includes('同条件'));
});

test('unknown features never expose their variable name', () => {
  assert.equal(featureLabel('brand_new_feature_x'), OTHER_FEATURE_LABEL);
  const views = reasonViews([
    { feature: 'unknown_a', contribution: 0.3 },
    { feature: 'unknown_b', contribution: 0.2 },
    { feature: 'jockey_id', contribution: -0.1 },
  ]);
  assert.deepEqual(views, [
    { label: OTHER_FEATURE_LABEL, direction: 'up' },
    { label: '騎手に関する評価', direction: 'down' },
  ]);
  for (const view of views) assert.ok(!ascii.test(view.label));
});

const horse = (number, first, popularity, market, rein) => ({
  number, popularity, firstProbability: first,
  marketFirstProbability: market, reinMarketFirstProbability: rein,
});

test('本命・対抗 are exactly 1着適性 1st and 2nd; ties keep the incoming order', () => {
  const horses = [horse(5, .10, 1), horse(3, .30, 2), horse(9, .30, 3), horse(1, .20, 4)];
  const picks = selectPicks(horses, { roleModelReady: true, marketReady: false });
  const order = roleOrder(horses, 'first').map((item) => item.number);
  assert.deepEqual(order, [3, 9, 1, 5]);
  assert.equal(picks.main.number, 3);
  assert.equal(picks.rival.number, 9);
  assert.equal(picks.longshot, null);
  assert.equal(picks.longshotStatus, 'unavailable');
});

test('穴候補 is the best-ranked 3〜6th horse that is 4th favourite or lower and beats the market', () => {
  const horses = [
    horse(1, .30, 1, .3, .3), horse(2, .20, 2, .2, .2),
    horse(3, .15, 3, .1, .3),   // 3rd: popular -> excluded
    horse(4, .12, 6, .1, .08),  // 4th: below market -> excluded
    horse(5, .10, 8, .04, .06), // 5th: selected
    horse(6, .08, 9, .02, .09), // 6th
    horse(7, .05, 12, .01, .2), // 7th: outside 3〜6
  ];
  const picks = selectPicks(horses, { roleModelReady: true, marketReady: true });
  assert.deepEqual([picks.main.number, picks.rival.number, picks.longshot.number], [1, 2, 5]);
  assert.equal(picks.longshot.firstRank, 5);
  assert.deepEqual(picks.longshotCandidates.map((item) => item.number), [5, 6]);
  assert.ok(Math.abs(picks.longshot.marketRatio - 1.5) < 1e-9);
  assert.ok(Math.abs(picks.longshot.marketGap - .02) < 1e-9);
  assert.equal(new Set([picks.main.number, picks.rival.number, picks.longshot.number]).size, 3);
});

test('no qualifying horse gives 該当なし; missing market data never forces a pick', () => {
  const horses = [horse(1, .4, 5, .1, .4), horse(2, .3, 6, .1, .3), horse(3, .2, 1, .5, .6), horse(4, .1, 2, .3, .1)];
  const none = selectPicks(horses, { roleModelReady: true, marketReady: true });
  assert.equal(none.longshot, null);
  assert.deepEqual(none.longshotCandidates, []);
  assert.equal(none.longshotStatus, 'none');
  const missing = [...horses, horse(5, .05, 9, null, null)];
  assert.equal(selectPicks(missing, { roleModelReady: true, marketReady: true }).longshotStatus, 'none');
  const held = selectPicks(horses, { roleModelReady: false, marketReady: true });
  assert.equal(held.status, 'unavailable');
  assert.equal(held.main, null);
});

test('Yahoo gelding rows (せん) are runners and map to the training category', () => {
  const row = { html: '<a href="/keiba/directory/horse/2021104567/">', cells: ['2', '2', 'メイショウソムリエ せん5/鹿毛', '大江原 圭 60.0', '蛯名 正義 (美浦)', '父', '506(-10)', '2( 3.5 )'] };
  assert.ok(isRunnerRow(row));
  assert.deepEqual(parseSexAge(row.cells), { sex: 'せん', age: 5 });
  assert.equal(horseName(row.cells[2]), 'メイショウソムリエ');
  assert.ok(!isScratched(row));
  const header = { html: '', cells: ['枠番', '馬番', '馬名 性齢/毛色', '騎手名 斤量', '調教師名', '父', '馬体重', '人気(オッズ)'] };
  assert.ok(!isRunnerRow(header));
  const scratched = { html: '<a href="/keiba/directory/horse/1/">', cells: ['3', '5', 'テスト 牡4/鹿毛', '騎手 57.0', '調教師', '父', '', '取消'] };
  assert.ok(isScratched(scratched));
  assert.deepEqual(parseSexAge(['1', '1', 'ウマ 牝3/栗毛']), { sex: '牝', age: 3 });
});
