import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const load = async path => {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
};
const { applyJraRoleAdjustment, THIRD_SUPPORT_VERSION } = await load('../lib/role-adjustments.ts');
const { buildTickets } = await load('../lib/tickets.ts');
const race = { racecourse: '阪神', surface: 'ダート', going: '良' };
const score = () => ({ version: 'frozen', runners: [1,2,3,4,5,6].map((n,i) => ({
  horse_number: n, first_probability: [0.4,0.25,0.15,0.1,0.06,0.04][i],
  second_probability: [0.5,0.25,0.1,0.08,0.05,0.02][i],
  third_probability: [0.01,0.02,0.03,0.04,0.1,0.8][i], third_reasons: [{feature:'prior_speed',contribution:.1}],
})) });

test('conditional support changes third ranking and ticket inputs consistently, preserves raw evidence and applies once', () => {
  const before = score(), saved = structuredClone(before), after = applyJraRoleAdjustment(before, race);
  assert.deepEqual(before,saved);
  assert.equal(after.roleAdjustment.version,THIRD_SUPPORT_VERSION);
  assert.equal(after.roleAdjustment.experimental,true);
  assert.ok(Math.abs(after.runners.reduce((s,r)=>s+r.third_probability,0)-1)<1e-12);
  assert.equal(after.runners[0].third_probability,.1325);
  assert.equal(after.runners[0].third_probability_before_support,.01);
  assert.deepEqual(after.runners.map(r=>r.first_probability),before.runners.map(r=>r.first_probability));
  assert.deepEqual(after.runners.map(r=>r.second_probability),before.runners.map(r=>r.second_probability));
  assert.strictEqual(applyJraRoleAdjustment(after,race),after);
  const top5 = x => x.runners.toSorted((a,b)=>b.third_probability-a.third_probability).slice(0,5).map(r=>r.horse_number);
  assert.ok(!top5(before).includes(1)); assert.ok(top5(after).includes(1));
  const tickets = x => buildTickets(x.runners.map(r=>({number:r.horse_number,gate:r.horse_number,popularity:r.horse_number,
    odds:r.horse_number*3,reinScore:70,marketScore:70,firstProbability:r.first_probability,secondProbability:r.second_probability,thirdProbability:r.third_probability})));
  const a=tickets(before),b=tickets(after);
  assert.ok(a.find(t=>t.type==='馬連'));assert.ok(b.find(t=>t.type==='馬連'));
  assert.deepEqual(a.find(t=>t.type==='馬連'),b.find(t=>t.type==='馬連'));
  assert.ok(a.find(t=>t.type==='三連複'));assert.ok(b.find(t=>t.type==='三連複'));
  assert.notDeepEqual(a.find(t=>t.type==='三連複'),b.find(t=>t.type==='三連複'));
});

test('other venues, non-good going, jumps, scratches, small or invalid fields keep original scores', () => {
  for (const r of [{...race,racecourse:'中山'},{...race,going:'稍重'},{...race,surface:'障害'}]) {
    const s=score();assert.strictEqual(applyJraRoleAdjustment(s,r),s);
  }
  const s=score();assert.strictEqual(applyJraRoleAdjustment(s,race,true),s);
  const small={...s,runners:s.runners.slice(0,5)};assert.strictEqual(applyJraRoleAdjustment(small,race),small);
  for (const bad of [NaN,Infinity,-.1]) {const s=score();s.runners[0].second_probability=bad;assert.strictEqual(applyJraRoleAdjustment(s,race),s);}
  const empty={version:'frozen'};assert.strictEqual(applyJraRoleAdjustment(empty,race),empty);
  const zero=score();zero.runners.forEach(r=>r.second_probability=0);assert.strictEqual(applyJraRoleAdjustment(zero,race),zero);
});
