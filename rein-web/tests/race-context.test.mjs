import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const load = async name => import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64'));
const { parseJraPreviousRuns, parseNarPreviousRuns, matchPreviousRuns, daysBetween } = await load('previous-run');
const { buildDayTrends } = await load('race-day-trends');
const raceDate = '2026-10-10';
const jraName = (n, id = String(100 + n)) => `<tr><td><p class="hr-denma__number">${n}</p></td><td><a href="/keiba/directory/horse/${id}/">テスト馬${n}</a></td></tr>`;
const pastCell = (date = '2026/09/27') => `<td class="hr-tableScroll__data hr-tableScroll__data--race"><p class="hr-denma__date"><span>${date}</span> <span>阪神</span></p><p class="hr-denma__date">ダート・右1800m 良</p><span class="hr-denma__arrival hr-denma__arrival--DGf">6</span><p><span class="hr-denma__horseWeight">556(+14)</span>9頭 8番</p><p class="hr-denma__jockey"><a href="/keiba/directory/jockey/01178/">テスト 騎手</a>(55.0)</p></td>`;
const jraHtml = (history, names = [1, 2, 3]) => `<table id="denma_latest"><tr><th>head</th></tr>${names.map(n => jraName(n)).join('')}</table><table id="denma_past"><tr><th>head</th></tr>${history.map(h => `<tr><td class="hr-tableScroll__data--name">現在の騎手</td>${h}</tr>`).join('')}</table>`;
test('JRA joins empty history and scratched declaration rows without shifting horses', () => {
  const parsed = parseJraPreviousRuns(jraHtml([pastCell(), '<td class="hr-tableScroll__data--race"></td>', pastCell('2026/10/03')]), raceDate);
  assert.equal(parsed.length, 3); assert.equal(parsed[1].previous, null); assert.equal(parsed[2].previous.date, '2026-10-03');
  assert.deepEqual(parsed[0].previous, { date: '2026-09-27', venue: '阪神', surface: 'ダート', distanceM: 1800, going: '良', jockey: 'テスト 騎手', weightCarried: 55, bodyWeight: 556, finish: 6, result: '6', fieldSize: 9, raceName: undefined, passing: undefined });
  const matched = matchPreviousRuns(parsed, [{ number: 3, horseId: '00103', name: 'テスト馬3' }]);
  assert.equal(matched[3].date, '2026-10-03');
  assert.equal(matchPreviousRuns(parsed, [{ number: 3, horseId: '999', name: 'テスト馬3' }])[3], null);
  assert.equal(matchPreviousRuns([...parsed, parsed[2]], [{ number: 3, horseId: '103', name: 'テスト馬3' }])[3], null);
  assert.deepEqual(parseJraPreviousRuns(jraHtml([pastCell()], [1, 2]), raceDate), []);
});
test('previous-run facts reject future, same-day and impossible dates; do not substitute the second column', () => {
  for (const date of ['2026/10/10', '2026/10/11', '2026/02/31']) assert.equal(parseJraPreviousRuns(jraHtml([pastCell(date) + pastCell('2026/09/27')], [1]), raceDate)[0].previous, null);
  assert.equal(daysBetween('2026-09-27', raceDate), 13); assert.equal(daysBetween(raceDate, raceDate), null);
});
const narHtml = (personnel = '4人　472　テスト騎手 57.0', info = '26.09.27　不良　10頭<br>高知　右1300　7番') => `<section class="cardTable"><tr class="tBorder"><td class="horseNum">1</td><a class="horseName" href="HorseMarkInfo?k_lineageLoginCode=300001">地方テスト馬</a><td><table><tr><td>全</td><td>1-2-3-4</td></tr></table></td><td><div class="raceInfo"><span class="pastRank rank_02">2</span>${info}</div></td><td><div class="raceInfo"><span class="pastRank">3</span>26.09.01 良 9頭 高知 右1400 3番</div></td></tr><tr><td>父</td><td><a href="TrainerMark">調教師</a></td><td class="odds_weight">480</td><td>${personnel}</td><td>2人 500 別の騎手 55.0</td></tr></section>`;
test('NAR nested result tables cannot contaminate previous personnel and course', () => {
  const p = parseNarPreviousRuns(narHtml(), raceDate)[0];
  assert.equal(p.horseId, '300001'); assert.equal(p.previous.distanceM, 1300); assert.equal(p.previous.bodyWeight, 472); assert.equal(p.previous.weightCarried, 57); assert.equal(p.previous.jockey, 'テスト騎手'); assert.equal(p.previous.surface, 'ダート');
  const missing = parseNarPreviousRuns(narHtml(''), raceDate)[0].previous;
  assert.equal(missing.jockey, undefined); assert.equal(missing.weightCarried, undefined); assert.equal(missing.bodyWeight, undefined);
  const turf = parseNarPreviousRuns(narHtml('4人 480 テスト 57.0', '26.09.27 良 16頭 Ｊ東京 芝左1800 4番'), raceDate)[0].previous;
  assert.equal(turf.venue, '東京'); assert.equal(turf.surface, '芝');
  assert.equal(parseNarPreviousRuns(narHtml('', '26.10.10 良 10頭 高知 右1300 7番'), raceDate)[0].previous, null);
});
const target = { raceId: '2605040308', date: raceDate, course: '芝1600m', startsAt: Date.parse('2026-10-10T05:00:00Z') };
const finished = (n, patch = {}) => ({ raceId: `26050403${String(n).padStart(2, '0')}`, date: raceDate, title: `東京${n}R`, course: '芝1800m', condition: '良', startsAt: Date.parse('2026-10-10T02:00:00Z'), capturedAt: '2026-10-10T02:15:00Z', isFinished: true, horses: [{ number: 1, gate: 1, style: '逃げ' }, { number: 2, gate: 4, style: '差し' }, { number: 3, gate: 8, style: '好位' }, { number: 4, gate: 8, style: '不明' }], finishers: [{ number: 2, finish: 1 }, { number: 3, finish: 2 }, { number: 1, finish: 3 }], ...patch });
test('day trends strictly exclude current/later/other day/venue and late-observed results', () => {
  const input = [finished(1), finished(2, { capturedAt: '2026-10-10T05:00:00Z' }), finished(3, { course: 'ダート1800m' }), finished(4, { isFinished: false }), finished(5, { capturedAt: 'bad' }), finished(6, { finishers: [{ number: 999, finish: 1 }] }), finished(8), finished(9), finished(1, { raceId: '2608040301' }), finished(2, { date: '2026-10-09' })];
  const out = buildDayTrends(target, input, Date.parse('2026-10-11T00:00:00Z'));
  assert.equal(out.raceCount, 1); assert.equal(out.runnerCount, 4);
  assert.deepEqual(out.excluded, { missing: 1, pending: 1, afterCutoff: 2, otherSurface: 1, invalid: 1 });
  assert.deepEqual(out.races.map(r => r.raceId), ['2605040301']);
  assert.equal(out.cutoff, '2026-10-10T05:00:00.000Z');
});
test('rates use starters as denominator, keep real zero, exclude unknown categories and avoid double counts', () => {
  const out = buildDayTrends(target, [finished(1), finished(1)], target.startsAt);
  assert.equal(out.raceCount, 1); assert.equal(out.gates[0].winRate, 0); assert.equal(out.gates[0].top3Rate, 100);
  assert.equal(out.gates[2].runners, 2); assert.equal(out.gates[2].top3Rate, 50);
  assert.equal(out.styles[1].winRate, 100); assert.equal(out.unknownStyle, 1);
  const empty = buildDayTrends(target, [], target.startsAt);
  assert.equal(empty.gates[0].winRate, null);
  assert.equal(buildDayTrends({ ...target, startsAt: null }, [finished(1)], target.startsAt).raceCount, 0);
  assert.equal(buildDayTrends({ ...target, course: 'ばんえい200m' }, [finished(1)], target.startsAt).supported, false);
  assert.equal(buildDayTrends(target, [finished(1)], Date.parse('2026-10-10T02:14:00Z')).raceCount, 0);
  assert.equal(buildDayTrends(target, [finished(1, { startsAt: Date.parse('2026-10-09T02:00:00Z') })], target.startsAt).raceCount, 0);
});
test('new routes inherit the existing league entitlement gate', () => {
  const proxy = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8'), auth = readFileSync(new URL('../lib/supabase/proxy.ts', import.meta.url), 'utf8');
  assert.match(proxy, /"\/api\/analyze\/:path\*"/); assert.match(proxy, /"\/api\/nar\/:path\*"/);
  assert.match(auth, /pathname\.startsWith\("\/api\/analyze\/"\)/); assert.match(auth, /pathname\.startsWith\("\/api\/nar\/"\)/);
});
