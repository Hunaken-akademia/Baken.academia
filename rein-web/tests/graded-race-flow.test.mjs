import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const moduleUrl=(name)=>'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64');
const source=readFileSync(new URL('../lib/graded-race-flow.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText.replace('"./jra-reference"',JSON.stringify(moduleUrl('jra-reference')));
const {historicalPosition,historicalPace,gradedEditionFlow}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const flow=(year,laps=[12,11,12,12,12,12])=>({sourceUrl:'https://www.jra.go.jp/datafile/seiseki/replay/2025/001.html',date:`${year}-09-30`,venue:'中山',surface:'芝',distanceM:1200,going:'良',fieldSize:16,laps,runners:[{finish:1,number:5,name:'Winner',corners:[12,8,4],stages:['2コーナー','3コーナー','4コーナー']}]});
const edition={date:'2025-09-30',year:2025,venue:'中山',surface:'芝',distanceM:1200,going:'良',fieldSize:16,winnerFirstCorner:1};
test('passing position is descriptive and rejects invalid records',()=>{
 assert.equal(historicalPosition(1,16),'逃げ（先頭）');assert.equal(historicalPosition(3,16),'先行');
 assert.equal(historicalPosition(12,16),'後方（差し・追込の位置）');
 for(const v of [null,0,-1,17,1.5,NaN])assert.equal(historicalPosition(v,16),'記録なし');
 assert.equal(historicalPosition(3,4),'後方（差し・追込の位置）');
});
test('pace compares measured same-condition laps, never infers pace from corners',()=>{
 const peers=[flow(2022),flow(2023),flow(2024)];
 assert.equal(historicalPace(flow(2025,[13,11,12,12,12,12]),peers).kind,'slow');
 assert.equal(historicalPace(flow(2025,[11,11,12,12,12,12]),peers).kind,'fast');
 assert.equal(historicalPace(flow(2025),peers).kind,'average');
 assert.equal(historicalPace(flow(2025),peers.slice(0,2)).kind,'unknown');
 assert.equal(historicalPace(flow(2025,[]),peers).earlySeconds,null);
 assert.equal(historicalPace(flow(2025),peers.map(p=>({...p,going:'重'}))).samples,0);
 assert.equal(historicalPace(flow(2025),peers.map(p=>({...p,venue:'京都'}))).samples,0);
 const odd={...flow(2025,[6,12,12,12,12,12,12]),distanceM:1300};
 assert.equal(historicalPace(odd,[]).earlyMeters,500);
 assert.equal(historicalPace(odd,[]).earlySeconds,30);
});
test('future editions and mismatched courses cannot affect a historical comparison',()=>{
 const key='スプリンターズS';
 const entries=Object.fromEntries([2022,2023,2024,2025,2026,2027].map(y=>[`${key}|${y}-09-30`,flow(y,y>2025?[8,8,8,8,8,8]:undefined)]));
 const data={version:'jra-graded-flow-v1',entries};
 const result=gradedEditionFlow(data,'スプリンターズステークス',edition,2026);
 assert.equal(result.pace.samples,3);assert.equal(result.pace.kind,'average');
 assert.equal(result.position,'後方（差し・追込の位置）');assert.equal(result.scenario,'closers');
 assert.equal(gradedEditionFlow(data,key,edition,2025).flow,null);
 assert.equal(gradedEditionFlow(data,key,{...edition,distanceM:1600},2026).flow,null);
});
