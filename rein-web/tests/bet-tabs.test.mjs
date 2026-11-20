import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile = name => ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const uri = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const json = readFileSync(new URL('../lib/bet-tab-stats.json', import.meta.url), 'utf8');
const finder = uri(compile('race-finder'));
const tabs = await import(uri(compile('bet-tabs').replace('import stats from "./bet-tab-stats.json";', `const stats = ${json};`).replace('"./race-finder"', JSON.stringify(finder))));
const pick = await import(uri(compile('my-pick-check').replace('"./tickets"', JSON.stringify(uri(compile('tickets'))))));

// 1番人気1.3倍の固いレース（有効頭数が小さい）
const solidOdds = [1.3, 6, 9, 15, 25, 40, 60, 80, 120, 150];
const horses = solidOdds.map((odds, i) => ({ number: i + 1, odds, popularity: i + 1, name: `H${i + 1}`, firstProbability: 10 - i, secondProbability: 10 - i, thirdProbability: 10 - i }));
const tickets = [
  { type: '複勝', tiers: [{ group: '本線', points: 1, selections: ['1'] }, { group: '対抗', points: 1, selections: ['2'] }, { group: '穴', points: 1, selections: ['5'] }] },
  { type: 'ワイド', tiers: [{ group: '本線', points: 2, selections: ['1-2', '1-3'] }, { group: '穴', points: 1, selections: ['2-5'] }] },
  { type: '馬連', tiers: [{ group: '本線', points: 1, selections: ['1-2'] }] },
  { type: '三連複', tiers: [{ group: '本線', points: 1, selections: ['1-2-3'] }] },
];

test('race type: solid race with REIN main = favorite is teppan only for nar navi', () => {
  const t = tabs.raceType('nar', horses, 1);
  assert.equal(t.kind, 'solid'); assert.equal(t.teppan, true); assert.deepEqual(t.statKinds, ['solidT']);
  assert.equal(tabs.naviKey('nar', t), 'teppan');
  const j = tabs.raceType('jra', horses, 1);
  assert.equal(tabs.naviKey('jra', j), 'solid'); assert.deepEqual(j.statKinds, ['solidT', 'solidO']);
  assert.equal(tabs.raceType('nar', horses, 2).teppan, false);
  assert.equal(tabs.raceType('nar', horses.map((h, i) => i === 3 ? { ...h, odds: null } : h), 1), null);
});

test('tabs reuse current tickets; 自信レース is skipped outside solid races', () => {
  const t = tabs.raceType('nar', horses, 1);
  const { tabs: list, recommended } = tabs.buildBetTabs('nar', tickets, t);
  assert.deepEqual(list.find(x => x.key === 'single').selections, ['1']);
  assert.deepEqual(list.find(x => x.key === 'ana').selections, ['2-5']);
  assert.equal(list.find(x => x.key === 'confident').skip, null);
  assert.ok(recommended);
  const rough = { kind: 'rough', label: '荒れそう', teppan: false, statKinds: ['rough'] };
  const r = tabs.buildBetTabs('nar', tickets, rough).tabs.find(x => x.key === 'confident');
  assert.match(r.skip, /見送り/); assert.deepEqual(r.selections, []);
});

test('marks: one ◎, at most two ○, ✕ below 70% recovery', () => {
  for (const lg of ['jra', 'nar']) for (const k of [['solidT'], ['solidO'], ['middle'], ['rough']]) {
    const marks = Object.values(tabs.tabMarks(lg, k));
    assert.ok(marks.filter(m => m === '◎').length <= 1);
    assert.ok(marks.filter(m => m === '○').length <= 2);
    const stats = tabs.tabStats(lg, k);
    for (const s of stats) if (!s.few && s.roi < 70) assert.equal(tabs.tabMarks(lg, k)[s.key], '✕');
  }
});

test('navi stats show the REIN agreement edge in nar', () => {
  const t = tabs.naviStat('nar', 'teppan'), s = tabs.naviStat('nar', 'solid');
  assert.ok(t.favWin > s.favWin);
  assert.ok(tabs.naviStat('nar', 'rough').trioMan > tabs.naviBase('nar').trioMan);
});

test('pick check: overlooked horses come first, then chances', () => {
  const res = pick.checkPick(horses, [5, 6, 7], { main: 1, rival: 2, longshot: 4 });
  assert.equal(res.notes[0].kind, 'miss');
  assert.ok(res.notes.some(n => n.number === 1 && /見落とし/.test(n.text)));
  assert.ok(res.notes.some(n => /見落としていませんか/.test(n.text)));
  const trio = res.chances.find(c => c.label.startsWith('3連複'));
  assert.equal(trio.points, 1);
  const strong = pick.checkPick(horses, [1, 2, 3], {}).chances.find(c => c.label.startsWith('3連複'));
  assert.ok(strong.value > trio.value);
});

test('pick check probabilities are normalized and monotone in the selection', () => {
  const c = pick.pickChances(horses);
  const all = new Set(horses.map(h => h.number));
  assert.ok(Math.abs(c.trio(all) - 1) < 1e-9);
  assert.ok(Math.abs([...c.horses.values()].reduce((s, h) => s + h.win, 0) - 1) < 1e-9);
  assert.ok(c.wide(new Set([1, 2, 3])) >= c.quinella(new Set([1, 2, 3])));
  assert.equal(pick.checkPick(horses, [2], {}, [2]).notes[0].kind, 'miss');
  assert.ok(pick.checkPick(horses, [2], {}, [2]).notes.some(n => /取消/.test(n.text)));
});

const rf = await import(finder);
test('race finder marks nar teppan rows and the favorite finish', () => {
  const payload = { race: { start: '15:00', startsAt: 1 }, horses, picks: { main: { number: 1 } }, review: { isFinished: true, finishers: [{ number: 1, finish: 2 }], payouts: [] } };
  const row = rf.finderRow('202611200101', 'nar', '園田', payload);
  assert.equal(row.teppan, true); assert.equal(row.favoriteFinish, 2);
  assert.equal(rf.finderRow('2611200101', 'jra', '東京', payload).teppan, false);
  assert.equal(rf.finderRow('202611200101', 'nar', '園田', { ...payload, picks: { main: { number: 2 } } }).teppan, false);
});
