import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const url = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const model = JSON.parse(readFileSync(new URL('../lib/corner-reference-model.json', import.meta.url), 'utf8'));
const corner = url(compile(readFileSync(new URL('../lib/corner-reference.ts', import.meta.url), 'utf8')
  .replace('import model from "./corner-reference-model.json";', `const model = ${JSON.stringify(model)};`)));
const marks = url(compile(readFileSync(new URL('../lib/marks.ts', import.meta.url), 'utf8')));
const replaySource = compile(readFileSync(new URL('../lib/race-replay.ts', import.meta.url), 'utf8'))
  .replace('"./corner-reference"', JSON.stringify(corner)).replace('"./marks"', JSON.stringify(marks));
const { buildReplay, replayFrame, currentOrder, replayGeometry, trackPoint } = await import(url(replaySource));

const styles = ['逃げ', '先行', '好位', '差し', '追込'];
const horses = Array.from({ length: 12 }, (_, i) => ({
  number: i + 1, name: `テスト馬${i + 1}`, gate: Math.ceil((i + 1) / 2), popularity: i + 1,
  style: styles[Math.min(4, Math.floor(i / 3))], earlyPosition: i + 1,
  mapPositions: i === 11 ? [] : [`${i + 1}-${i + 1}-${Math.max(1, 12 - i)}-${Math.max(1, 12 - i)}`, `${i + 1}-${i + 1}-${i + 1}-${i + 1}`],
  // 1着適性: horse 9 (a closer) is first, horse 4 second.
  firstProbability: i === 8 ? 0.3 : i === 3 ? 0.2 : 0.05 - i * 0.001,
}));
const race = { horses, title: '中山11R テストS', course: 'ダート・右 1800m', raceId: '2606040911', pace: 'ハイペース寄り', league: 'jra', roleReady: true };

test('finish order is the 1着適性 ranking and corners come from the AI position model', () => {
  const plan = buildReplay(race);
  assert.ok(!('unavailable' in plan));
  assert.equal(plan.cornerSource, 'ai');
  assert.deepEqual(plan.finish.slice(0, 2), [9, 4]);
  assert.deepEqual(plan.checkpoints.map((c) => c.label), ['スタート', '序盤', '1角', '2角', '3角', '4角', 'ゴール']);
  const remaining = plan.checkpoints.map((c) => c.remaining);
  assert.deepEqual([...remaining].sort((a, b) => b - a), remaining, 'checkpoints run from start to post');
  assert.equal(remaining[0], 1800);
  assert.equal(remaining.at(-1), 0);
  for (const checkpoint of plan.checkpoints) {
    assert.deepEqual([...checkpoint.order.map((o) => o.number)].sort((a, b) => a - b), horses.map((h) => h.number));
  }
  // Horse 12 has no passing history: it is placed, but without a model estimate.
  const fourth = plan.checkpoints.find((c) => c.id === 'corner4');
  assert.equal(fourth.order.find((o) => o.number === 12).estimate, null);
  assert.ok(fourth.order.some((o) => o.estimate !== null));
});

test('frames are finite, start abreast and end in the finish order', () => {
  const plan = buildReplay(race);
  for (let step = 0; step <= 100; step += 1) {
    const frame = replayFrame(plan, step / 100);
    for (const runner of frame.runners) {
      assert.ok(Number.isFinite(runner.remaining) && Number.isFinite(runner.lane));
      const point = trackPoint(plan.geometry, runner.remaining, runner.lane);
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
  }
  const start = replayFrame(plan, 0);
  assert.ok(start.runners.every((r) => r.remaining === 1800));
  assert.deepEqual(currentOrder(replayFrame(plan, 1)), plan.finish);
});

test('commentary uses horse names and only checkpoint facts', () => {
  const plan = buildReplay(race);
  const text = plan.commentary.map((line) => line.text).join('\n');
  assert.match(text, /テスト馬9/);
  assert.match(text, /ハイペース寄りの想定/);
  assert.match(plan.commentary.at(-1).text, /^直線308m（概略）。テスト馬9が抜け出し、テスト馬4/);
  assert.ok(!/[A-Za-z_]{3,}/.test(text));
});

test('falls back honestly instead of inventing positions', () => {
  assert.match(buildReplay({ ...race, roleReady: false }).unavailable, /1着適性の評価が保留中/);
  assert.match(buildReplay({ ...race, course: '障害・芝 3000m' }).unavailable, /障害/);
  assert.match(buildReplay({ ...race, course: '芝・直線 1000m' }).unavailable, /直線/);
  const old = buildReplay({ ...race, raceId: '2406040911' });
  assert.equal(old.cornerSource, 'style');
  const missing = horses.map((h, i) => (i === 0 ? { ...h, firstProbability: undefined } : h));
  assert.match(buildReplay({ ...race, horses: missing }).unavailable, /全頭そろっていない/);
});

test('course geometry: left-handed venues mirror, outer turf uses the outer course', () => {
  assert.equal(replayGeometry('東京11R', '芝・左 2400m').rightHanded, false);
  assert.equal(replayGeometry('京都9R', '芝・右・外 1400m').homeStraight, 404);
  assert.equal(replayGeometry('京都9R', '芝・右 1400m').homeStraight, 328);
});

test('runners keep moving forward and do not jump lanes at checkpoints', () => {
  const plan = buildReplay(race);
  let previous = replayFrame(plan, 0);
  for (let step = 1; step <= 2000; step += 1) {
    const next = replayFrame(plan, step / 2000);
    for (const runner of next.runners) {
      const before = previous.runners.find((item) => item.number === runner.number);
      assert.ok(runner.remaining <= before.remaining + 1e-8, `${runner.number} must not run backwards`);
      assert.ok(Math.abs(runner.lane - before.lane) < .03, `${runner.number} must not jump lanes`);
    }
    previous = next;
  }
  for (const cp of plan.checkpoints.slice(1, -1)) {
    const progress = 1 - cp.remaining / plan.geometry.distance;
    const before = replayFrame(plan, progress - 1e-5), at = replayFrame(plan, progress), after = replayFrame(plan, progress + 1e-5);
    for (const runner of at.runners) {
      const left = before.runners.find((r) => r.number === runner.number), right = after.runners.find((r) => r.number === runner.number);
      assert.ok(Math.abs((left.remaining - runner.remaining) - (runner.remaining - right.remaining)) < .001, 'speed should continue through a corner');
    }
  }
});

test('selected scenario owns early and corner orders while finish stays the validated ranking', () => {
 const positions = Object.fromEntries(horses.map(h => [h.number, Object.fromEntries([0,1,2,3,4].map(stage => [stage,13-h.number]))]));
 const plan=buildReplay({...race,scenario:{label:'差しが届く展開',positions}});
 assert.equal(plan.cornerSource,'scenario');
 for(const checkpoint of plan.checkpoints.filter(c=>c.id!=='start'&&c.id!=='finish')) {
  assert.equal(checkpoint.source,'scenario');assert.equal(checkpoint.order[0].number,12);
 }
 assert.deepEqual(plan.finish,buildReplay(race).finish);
 assert.ok(replayFrame(plan,.5).runners.every(r=>Number.isFinite(r.remaining)));
});
