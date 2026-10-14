import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const load = async (path) => {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
};
const { summarizePerformance, performanceRange } = await load('../lib/performance.ts');
const { favoriteMatches, jockeyKey, validJockeyKey } = await load('../lib/favorites.ts');

const payouts = [
  { type: '単勝', selection: '10', payout: 1220 },
  { type: '複勝', selection: '10', payout: 400 }, { type: '複勝', selection: '12', payout: 540 }, { type: '複勝', selection: '9', payout: 540 },
  { type: '馬連', selection: '10-12', payout: 7350 },
  { type: 'ワイド', selection: '9-10', payout: 3880 }, { type: 'ワイド', selection: '10-12', payout: 2160 },
  { type: '馬単', selection: '10→12', payout: 13460 },
  { type: '3連複', selection: '9-10-12', payout: 60280 },
];
const finishers = [{ number: 10, finish: 1 }, { number: 12, finish: 2 }, { number: 9, finish: 3 }, { number: 1, finish: 4 }];
const race = (over = {}) => ({
  raceId: '2608040512', date: '2026-10-12', title: 'テスト', generatedAt: '2026-10-12T07:20:00Z',
  picks: { main: 10, rival: 1, longshot: 12 },
  tickets: [
    { type: '単勝', tiers: [{ group: '本線', selections: ['10'] }, { group: '対抗', selections: ['1'] }, { group: '穴', selections: [] }] },
    { type: '馬単', tiers: [{ group: '本線', selections: ['12-10', '10-12'] }] },
    { type: 'ワイド', tiers: [{ group: '本線', selections: ['10-9', '10-12', '1-10'] }] },
    { type: '三連複', tiers: [{ group: '本線', selections: ['9-10-12'] }] },
    { type: '枠連', tiers: [{ group: '本線', selections: ['5-6'] }] },
  ],
  final: true, finishers, payouts, scratched: 0, ...over,
});

test('scores marks and tickets with exact payout matching and 100-yen points', () => {
  const summary = summarizePerformance([race()]);
  assert.equal(summary.counted, 1);
  const main = summary.marks.find(m => m.key === 'main');
  assert.deepEqual([main.races, main.wins, main.top3, main.winReturn, main.placeReturn], [1, 1, 1, 1220, 400]);
  const rival = summary.marks.find(m => m.key === 'rival');
  assert.deepEqual([rival.wins, rival.top3, rival.winReturn], [0, 0, 0]);
  const longshot = summary.marks.find(m => m.key === 'longshot');
  assert.deepEqual([longshot.top2, longshot.placeReturn], [1, 540]);
  const byType = Object.fromEntries(summary.tickets.map(t => [t.type, t]));
  assert.deepEqual(byType['単勝'].tiers['本線'], { races: 1, points: 1, hitRaces: 1, stake: 100, returned: 1220 });
  assert.deepEqual(byType['単勝'].tiers['対抗'], { races: 1, points: 1, hitRaces: 0, stake: 100, returned: 0 });
  assert.equal(byType['単勝'].tiers['穴'].races, 0);
  assert.deepEqual(byType['単勝'].total, { races: 1, points: 2, hitRaces: 1, stake: 200, returned: 1220 });
  // Ordered: only 10→12 is paid; 12→10 loses.
  assert.equal(byType['馬単'].total.returned, 13460);
  assert.equal(byType['馬単'].total.points, 2);
  // Unordered selections are normalized; two wide hits.
  assert.equal(byType['ワイド'].total.returned, 3880 + 2160);
  assert.equal(byType['3連複'].total.returned, 60280);
  // 枠連 has no payout rows in this race, so it is not scored as a loss.
  assert.equal(byType['枠連'], undefined);
  assert.deepEqual(summary.tickets.map(t => t.type), ['単勝', 'ワイド', '馬単', '3連複']);
});

test('excludes pending, scratched and payout-less races, and held tickets', () => {
  const summary = summarizePerformance([
    race({ raceId: 'a', final: false, finishers: [], payouts: [] }),
    race({ raceId: 'b', scratched: 1 }),
    race({ raceId: 'c', payouts: [] }),
    race({ raceId: 'd', tickets: null, picks: null }),
  ]);
  assert.deepEqual(summary.excluded, { pending: 1, scratched: 1, noPayout: 1 });
  assert.equal(summary.counted, 1);
  assert.equal(summary.marks[0].races, 0);
  assert.deepEqual(summary.tickets, []);
});

test('performance range is an inclusive JST window', () => {
  assert.deepEqual(performanceRange(7, Date.parse('2026-10-14T20:00:00Z')), { from: '2026-10-09', to: '2026-10-15' });
});

test('favorite matches combine watched horses and league-scoped jockeys', () => {
  const races = [
    { raceId: '2', title: '2R', start: '10:30', horses: [{ number: 3, name: '馬C', horseId: '300', jockey: '騎手 甲', jockeyId: '01' }] },
    { raceId: '1', title: '1R', start: '10:00', horses: [
      { number: 5, name: '馬B', horseId: '200', jockey: '騎手乙', jockeyId: '02' },
      { number: 1, name: '馬A', horseId: '100', jockey: '騎手甲', jockeyId: '01' },
    ] },
  ];
  const matches = favoriteMatches('jra', races, ['100'], ['jra:01', 'nar:02']);
  assert.deepEqual(matches.map(m => m.raceId), ['1', '2']);
  assert.deepEqual(matches[0].items, [{ number: 1, horse: '馬A', jockey: '騎手甲', reasons: ['horse', 'jockey'] }]);
  assert.deepEqual(matches[1].items[0].reasons, ['jockey']);
  assert.deepEqual(favoriteMatches('jra', races, [], []), []);
  assert.equal(jockeyKey('nar', '38090'), 'nar:38090');
  assert.equal(jockeyKey('jra', 'bad id'), null);
  assert.equal(validJockeyKey('jra:1091'), true);
  assert.equal(validJockeyKey('x:1'), false);
});
