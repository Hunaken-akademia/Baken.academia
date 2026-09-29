import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../lib/jra-reference.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {jraReferenceForRace,jraRaceNameKey,jraConditionKey}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const metric={samples:100,hits:40,rate:.4};
const period={races:100,winners:100,favoriteWinner:metric,top3PopularityWinner:{...metric,rate:.8},tenPlusWinner:{...metric,rate:.02},frontWinner:{samples:80,hits:32,rate:.4}};
const data={version:'jra-condition-reference-v1',periods:{selection:'2025',audit:'2026'},coverage:{dateFrom:'2019-01-01',dateTo:'2026-09-18',races:1000,racecourses:10},conditions:[
 {kind:'course',key:'中山|芝',selection:period,audit:period},{kind:'courseDistance',key:'中山|芝|short',selection:period,audit:period},{kind:'courseGoing',key:'中山|芝|良',selection:period,audit:period}],gradedRaces:[{key:'スプリンターズS',name:'スプリンターズステークス',grades:['G1'],editions:Array.from({length:8},(_,i)=>({date:`${2018+i}-09-30`,year:2018+i,venue:i===2?'新潟':'中山',grade:'G1',surface:'芝',distanceM:1200,going:'良',fieldSize:16,winnerPopularity:i%3+1,winnerGate:4,winnerFirstCorner:i%5+1,placedPopularities:[1,3,i===1?10:5],placedFirstCorners:[1,4,7]}))}],limitations:[]};
test('JRA keys normalize grade names and distance boundaries',()=>{
 assert.equal(jraRaceNameKey('第60回 スプリンターズステークス（ＧⅠ）'),'スプリンターズS');
 assert.equal(jraRaceNameKey('スプリンターズステークス'),jraRaceNameKey('スプリンターズS'));
 assert.equal(jraRaceNameKey('東京優駿（日本ダービー）'),jraRaceNameKey('東京優駿'));
 assert.equal(jraRaceNameKey('日本ダービー'),jraRaceNameKey('東京優駿'));
 assert.notEqual(jraRaceNameKey('天皇賞（春）'),jraRaceNameKey('天皇賞（秋）'));
 assert.equal(jraConditionKey('中山','芝',1400,'良','courseDistance'),'中山|芝|mile');
});
test('JRA reference uses only prior editions and exact conditions',()=>{
 const result=jraReferenceForRace(data,{raceName:'第60回 スプリンターズステークス（GⅠ）',venue:'中山',surface:'芝',distanceM:1200,going:'良',year:2026});
 assert.equal(result.conditions.length,3);assert.match(result.conditions[0].detail,/2026年の100レース/);
 assert.equal(result.graded.editions,8);assert.equal(result.graded.yearTo,2025);assert.equal(result.graded.recent.length,5);assert.equal(result.graded.venueChanges,true);
 const noLeak=jraReferenceForRace(data,{raceName:'スプリンターズステークス',venue:'中山',surface:'芝',distanceM:1200,going:'良',year:2023});
 assert.equal(noLeak.graded.editions,5);assert.equal(noLeak.graded.yearTo,2022);
});
