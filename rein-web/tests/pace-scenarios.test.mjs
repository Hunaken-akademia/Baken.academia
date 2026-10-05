import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=n=>ts.transpileModule(readFileSync(new URL(`../lib/${n}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const uri=c=>`data:text/javascript;base64,${Buffer.from(c).toString('base64')}`;
const corner=compile('corner-reference').replace('"./corner-reference-model.json"',JSON.stringify(uri(`export default ${readFileSync(new URL('../lib/corner-reference-model.json',import.meta.url),'utf8')}`)));
const {scenarioView,escapeCandidates,scenarioRanking}=await import(uri(compile('pace-scenarios').replace('"./corner-reference"',JSON.stringify(uri(corner))).replace('"./marks"',JSON.stringify(uri(compile('marks'))))));
const horses=[{number:1,name:'逃げ',style:'逃げ',popularity:1,mapPositions:['1-1-1-2']},{number:2,name:'先行',style:'先行',popularity:2,mapPositions:['2-2-2-3']},{number:3,name:'差し',style:'差し',popularity:8,mapPositions:['7-6-4-2']},{number:4,name:'不明',style:'不明',popularity:4,mapPositions:[]}];
test('different pace assumptions change fit independently from popularity and model ranks',()=>{
 const before=JSON.stringify(horses),slow=scenarioView(horses,'lone',[1]),fast=scenarioView(horses,'duel',[1,2]);
 assert.equal(slow.rows[0].fit,'追い風');assert.equal(slow.rows[2].fit,'注意');assert.equal(fast.rows[0].fit,'注意');assert.equal(fast.rows[2].fit,'追い風');assert.equal(JSON.stringify(horses),before);
 assert.deepEqual(fast.rows.map(r=>r.fit),scenarioView(horses.map(h=>({...h,popularity:99})), 'duel',[1,2]).rows.map(r=>r.fit));
});
test('selected leader affects early order; missing history is explicit and ordinal slots bounded',()=>{
 const v=scenarioView(horses,'lone',[3]);assert.equal(v.rows[2].positions[0],1);assert.equal(v.rows[3].positions[0],null);assert.equal(v.rows[3].fit,'未判定');
 for(const stage of [0,1,2,3,4]){const positions=v.rows.map(r=>r.positions[stage]).filter(p=>p!==null);assert.equal(new Set(positions).size,positions.length);assert.ok(positions.every(p=>Number.isInteger(p)&&p>=1&&p<=horses.length));}
 assert.ok(v.warnings.some(w=>w.includes('逃げ以外')));
});
test('progress evidence and invalid assumptions are held visibly',()=>{
 const v=scenarioView(horses,'sustain',[]);assert.equal(v.rows[2].fit,'追い風');assert.equal(v.rows[3].fit,'未判定');assert.ok(scenarioView(horses,'duel',[999]).warnings.length);assert.ok(scenarioView(horses,'lone',[1,2]).warnings.length);assert.deepEqual(escapeCandidates(horses).map(h=>h.number),[1,2]);
});

test('conditional candidate rank changes for front and closer scenarios without changing model inputs',()=>{
 const h=horses.map((h,i)=>({...h,firstProbability:.3-i*.04})),before=JSON.stringify(h);
 assert.equal(scenarioRanking(h,'lone',[1],true)[0].horse.number,1);
 assert.equal(scenarioRanking(h,'closers',[1],true)[0].horse.number,3);
 assert.deepEqual(scenarioRanking(h,'baseline',[1],true).map(r=>r.horse.number),[1,2,3,4]);
 assert.equal(JSON.stringify(h),before);assert.deepEqual(scenarioRanking(h,'lone',[1],false),[]);
 assert.deepEqual(scenarioRanking(h.map((v,i)=>({...v,firstProbability:i===0?undefined:v.firstProbability})),'lone',[1],true),[]);
});
