import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const uri=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const cache=new Map();
function compile(name){if(cache.has(name))return cache.get(name);let s=ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;s=s.replace(/from "\.\/([\w-]+)"/g,(_,dep)=>'from '+JSON.stringify(compile(dep)));const result=uri(s);cache.set(name,result);return result;}
const {rankPopularityPatterns,tableRoleWeights,buildPopularityForecast,patternPredictionSafe}=await import(compile('popularity-forecast'));
const horses=Array.from({length:7},(_,i)=>({number:i+1,popularity:i+1,name:`馬${i+1}`,firstProbability:i<3?.24:.07,secondProbability:i<3?.20:.10,thirdProbability:i<3?.18:.115,parameterFactors:[{label:'通算成績',samples:4,wins:2,top3:3,impact:0},{label:'距離適性',samples:1,wins:i%2,top3:1,impact:0}]}));
test('all distinct finishes are counted once; pattern mass sums to one and examples fit the pattern',()=>{
 const rows=rankPopularityPatterns(horses,[horses.map(h=>h.firstProbability),horses.map(h=>h.secondProbability),horses.map(h=>h.thirdProbability)]);
 assert.ok(Math.abs(rows.reduce((sum,r)=>sum+r.weight,0)-1)<1e-9);
 for(const r of rows){assert.equal(new Set(r.best.numbers).size,3);assert.equal(r.best.numbers.map(n=>n<=3?'A':n<=6?'B':'C').join('-'),r.pattern);}
 assert.ok(!rows.some(r=>r.pattern==='C-C-C'));
});
test('one-start observed conditions contribute, missing conditions are excluded and unknown popularity is held',()=>{
 const table=tableRoleWeights(horses);assert.equal(table.known,7);assert.ok(table.weights);assert.ok(table.rows.includes('距離'));assert.ok(!table.rows.includes('血統'));
 assert.ok(buildPopularityForecast(horses,{rolesReady:false}).table.length);
 assert.equal(buildPopularityForecast(horses.map((h,i)=>i===0?{...h,popularity:0}:h),{rolesReady:true}).combined.length,0);
});
test('day observations use exact final popularity, sparse samples do not change the base, repeated patterns can break close ties',()=>{
 const base=buildPopularityForecast(horses,{rolesReady:true});const alternate=base.model[1].pattern;
 const race={popularity:{pattern:alternate,source:'結果掲載人気'}};
 const two=buildPopularityForecast(horses,{rolesReady:true,trends:{races:[race,race]}});
 assert.equal(two.dayApplied,false);assert.deepEqual(two.combined.map(r=>r.pattern),base.combined.map(r=>r.pattern));
 const eight=buildPopularityForecast(horses,{rolesReady:true,trends:{races:Array(8).fill(race)}});assert.equal(eight.dayApplied,true);assert.equal(eight.dayRaces,8);assert.ok(eight.dayStrength<=.15);assert.equal(eight.observations[0].count,8);
 const saved=buildPopularityForecast(horses,{rolesReady:true,trends:{races:[{popularity:{pattern:'A-B-A',source:'保存時点の人気'}}]}});assert.equal(saved.dayRaces,0);
});
test('safe historical review is explicit; final/rebuilt predictions cannot become hindsight recommendations',()=>{
 const startsAt=Date.parse('2026-10-21T10:00:00Z');
 assert.equal(patternPredictionSafe({phase:'prestart',source:'live',generatedAt:'2026-10-21T09:00:00Z'},startsAt,false),true);
 assert.equal(patternPredictionSafe({phase:'final',source:'live',generatedAt:'2026-10-21T11:00:00Z'},startsAt,true),false);
 assert.equal(patternPredictionSafe({phase:'poststart',source:'prestart',generatedAt:'2026-10-21T09:00:00Z'},startsAt,true),true);
 assert.equal(patternPredictionSafe({phase:'prestart',source:'rebuilt',generatedAt:'2026-10-21T09:00:00Z'},startsAt,false),false);
 assert.equal(buildPopularityForecast(horses,{rolesReady:true,predictionSafe:false}).combined.length,0);
});
