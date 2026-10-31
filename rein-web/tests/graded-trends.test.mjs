import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../lib/graded-trends.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {baselineRate,isStrong,top3Rate,sectionsFor}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const trend={sections:[{title:'人気別',note:'',rows:[{label:'1番人気',record:[7,1,0,2]},{label:'10番人気以下',record:[0,0,1,54]}]},{title:'東京芝2000mの実績',note:'',rows:[]}]};
test('highlights only buckets well above the race baseline with at least five runners',()=>{
  // 9 placed of 65 runners.
  assert.ok(Math.abs(baselineRate(trend)-9/65)<1e-12);
  assert.equal(isStrong([7,1,0,2],9/65),true);
  assert.equal(isStrong([1,0,0,1],9/65),false);
  assert.equal(isStrong([0,0,1,54],9/65),false);
  assert.equal(top3Rate([0,0,0,0]),null);
  assert.deepEqual(sectionsFor(trend,['*の実績']).map(s=>s.title),['東京芝2000mの実績']);
});
