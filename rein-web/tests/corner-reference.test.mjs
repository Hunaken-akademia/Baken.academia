import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const model = JSON.parse(readFileSync(new URL('../lib/corner-reference-model.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../lib/corner-reference.ts', import.meta.url), 'utf8').replace('import model from "./corner-reference-model.json";', `const model = ${JSON.stringify(model)};`);
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { parseSequence, extractMapPositions, stagePosition, cornerFeatures, predictCorner, courseStages, mapSlot } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('passing parser reads the dedicated cells and rejects unrelated dates, invalid ranks and malformed sequences', () => {
  assert.deepEqual(extractMapPositions('<div>09-12</div><p class="hr-denma__passing">2-3-4-5</p><p class="hr-denma__passing">--</p><p class="hr-denma__passing">1-19</p>'), ['2-3-4-5']);
  for (const value of ['', '2026-09-12', '0-2', '2-19', '1-2-3-4-5', 'NaN-2']) assert.deepEqual(parseSequence(value), []);
});
test('two-corner sequences never become 1st or 2nd corner history', () => {
  assert.equal(stagePosition([8,4],1), null);
  assert.equal(stagePosition([8,4],2), null);
  assert.equal(stagePosition([8,4],3), 8);
  assert.equal(stagePosition([8,4],4), 4);
  assert.equal(stagePosition([7,6,5],2), 7);
  assert.equal(stagePosition([7,6,5],0), 7);
});
test('runtime features and prediction match the Python training golden example', () => {
  const history=[[2,3,4,5],[1,2,2,3],[4,5],[3,4,3]];
  const expected=[.3125,.25892857142857145,.0625,.8,.15625,.25,.09375,.8888888888888888,.9,0,.75];
  const actual=cornerFeatures(history,4,16,1800,false,6);
  actual.forEach((value,i) => assert.ok(Math.abs(value-expected[i])<1e-12));
  const horse={number:1,name:'test',gate:6,style:'先行',mapPositions:history.map((r)=>r.join('-'))};
  assert.ok(Math.abs(predictCorner(horse,4,16,'芝右1800m').position-6.190914203638902)<1e-10);
  assert.equal(predictCorner({...horse,mapPositions:[]},4,16,'芝右1800m'),null);
  assert.equal(predictCorner(horse,4,16,'障害3000m'),null);
});
test('actual course stage metadata hides nonexistent corners and unknown courses', () => {
  assert.deepEqual(courseStages('中山 11R','芝右外1200m'),[3,4]);
  assert.deepEqual(courseStages('東京 11R','芝左1800m'),[2,3,4]);
  assert.deepEqual(courseStages('中山 11R','ダート右1800m'),[1,2,3,4]);
  assert.equal(courseStages('園田 11R','ダート右1400m'),null);
  assert.deepEqual(courseStages('新潟 11R','芝1000m'),[]);
});
test('all horse dots fit within the diagram with distinct positions for up to 18 runners', () => {
  for (let n=1;n<=18;n++) for (const curved of [false,true]) {
    const points=Array.from({length:n},(_,i)=>mapSlot(i,n,curved));
    assert.equal(new Set(points.map((p)=>`${p.x},${p.y}`)).size,n);
    for (const p of points) assert.ok(p.x>=18 && p.x<=382 && p.y>=18 && p.y<=312);
  }
});
