import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile = name => ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const uri = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const { longshotRoleOrder } = await import(uri(compile('longshot-roles').replace('"./marks"', JSON.stringify(uri(compile('marks'))))));
const horses = Array.from({length: 10}, (_, i) => ({number:i+1,popularity:i+1,firstProbability:10-i,secondProbability:i,thirdProbability:i===5?20:i}));
test('roles independently select outsiders, preserving global and outsider ranks', () => {
  assert.deepEqual(longshotRoleOrder(horses,'first').candidates.map(c=>c.horse.number),[4,5,6]);
  assert.deepEqual(longshotRoleOrder(horses,'second').candidates.map(c=>c.horse.number),[10,9,8]);
  assert.equal(longshotRoleOrder(horses,'third').candidates[0].horse.number,6);
  assert.equal(longshotRoleOrder(horses,'first').candidates[0].overallRank,4);
  assert.equal(longshotRoleOrder(horses,'first').candidates[0].outsiderRank,1);
});
test('popularity thresholds and small fields can return fewer candidates or none', () => {
  assert.deepEqual(longshotRoleOrder(horses,'second',10).candidates.map(c=>c.horse.number),[10]);
  assert.equal(longshotRoleOrder(horses.slice(0,5),'first',6).candidates.length,0);
});
test('incomplete or duplicate popularity is held; incomplete role only holds that role', () => {
  assert.equal(longshotRoleOrder(horses.map((h,i)=>i===0?{...h,popularity:0}:h),'first').status,'unavailable');
  assert.equal(longshotRoleOrder(horses.map((h,i)=>i===0?{...h,popularity:2}:h),'first').status,'unavailable');
  const missing=horses.map((h,i)=>i===0?{...h,secondProbability:NaN}:h);
  assert.equal(longshotRoleOrder(missing,'second').status,'unavailable');
  assert.equal(longshotRoleOrder(missing,'first').status,'ready');
  assert.equal(longshotRoleOrder([],'first').status,'unavailable');
});
test('ties keep canonical incoming order and source is not mutated', () => {
  const tied=horses.map(h=>({...h,thirdProbability:1}));
  const before=JSON.stringify(tied);
  assert.deepEqual(longshotRoleOrder(tied,'third').candidates.map(c=>c.horse.number),[4,5,6]);
  assert.equal(JSON.stringify(tied),before);
});
