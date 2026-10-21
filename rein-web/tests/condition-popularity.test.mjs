import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const uri=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const compile=name=>ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const research=uri(compile('horse-research').replace('"./marks"',JSON.stringify(uri(compile('marks')))));
const {conditionSymbol}=await import(uri(compile('condition-symbols').replace('"./horse-research"',JSON.stringify(research))));
const {popularityGroup,popularityPattern,buildDayTrends}=await import(uri(compile('race-day-trends')));
const horse=(rate,samples=10,career=20)=>({parameterFactors:[{label:'通算成績',samples:career,top3Rate:40},{label:'距離適性',samples,top3Rate:rate}]});
test('condition symbols show sparse observed data with reference labels and shrinkage',()=>{
  for(const [rate,symbol] of [[55,'◎'],[45,'○'],[35,'△'],[34.9,'×'],[0,'×']])assert.equal(conditionSymbol(horse(rate),'距離適性').symbol,symbol);
  assert.notEqual(conditionSymbol(horse(80,9),'距離適性').symbol,'—');
  assert.equal(conditionSymbol(horse(80,9),'距離適性').confidence,'standard');
  assert.equal(conditionSymbol(horse(80,5),'距離適性').confidence,'standard');
  assert.equal(conditionSymbol(horse(80,4),'距離適性').confidence,'reference');
  assert.notEqual(conditionSymbol(horse(80,10,19),'距離適性').symbol,'—');
  assert.equal(conditionSymbol(horse(100,1,4),'距離適性').confidence,'reference');
  assert.equal(conditionSymbol(horse(80),'馬場適性').symbol,'—');
  assert.equal(conditionSymbol({historyFactors:[{label:'騎手傾向',samples:500,top3Rate:80}]},'騎手相性').symbol,'—');
  const pair=conditionSymbol({jockey:'服部茂 ',historyFactors:[{label:'通算成績',samples:14,top3Rate:85.7},{label:'騎手相性',samples:7,wins:3,top3:6,top3Rate:85.7,record:'3-2-1-1'}]},'騎手相性');
  assert.equal(pair.symbol,'◎');assert.match(pair.detail,/^服部茂騎手で3-2-1-1・7走・3着内率 85.7%・実績率による参考評価$/);
  const sire=conditionSymbol({historyFactors:[{label:'通算成績',samples:20,top3Rate:90},{label:'血統適性',samples:40,top3Rate:40,baseline:30,subject:'フリオーソ産駒・1600〜1799m'}]},'血統適性');
  assert.equal(sire.symbol,'○');assert.equal(sire.detail,'フリオーソ産駒・1600〜1799m 40走・3着内率 40.0%・産駒全体（30.0%）比 +10.0pt');
  const first=conditionSymbol({jockey:'小野楓',historyFactors:[{label:'騎手相性',samples:0,top3Rate:0,record:'0-0-0-0'}]},'騎手相性');
  assert.equal(first.symbol,'—');assert.equal(first.detail,'小野楓騎手とは初コンビ（騎乗実績なし）');
});
test('popularity boundaries cover A to D and never invent missing popularity',()=>{
  for(const [value,group] of [[1,'A'],[3,'A'],[4,'B'],[6,'B'],[7,'C'],[9,'C'],[10,'D'],[18,'D']]) assert.equal(popularityGroup(value),group);
  for(const value of [0,-1,1.5,19,NaN,Infinity,null,undefined,'3'])assert.equal(popularityGroup(value),null);
});
const finishers=[{number:1,finish:1,popularity:3},{number:5,finish:2,popularity:5},{number:3,finish:3,popularity:1}];
test('example result is A-B-A in finish order and rejects ambiguous or incomplete results',()=>{
  assert.equal(popularityPattern([...finishers].reverse()).pattern,'A-B-A');
  assert.equal(popularityPattern(finishers).source,'結果掲載人気');
  assert.equal(popularityPattern(finishers.slice(0,2)),null);
  assert.equal(popularityPattern([...finishers,{number:9,finish:3,popularity:2}]),null);
  assert.equal(popularityPattern([...finishers,{number:1,finish:4,popularity:2}]),null);
  assert.equal(popularityPattern(finishers.map(f=>({...f,popularity:undefined}))),null);
  assert.equal(popularityPattern(finishers.map(f=>({...f,popularity:undefined})),finishers).source,'保存時点の人気');
});
test('day patterns use only earlier same-venue results captured before target cutoff',()=>{
  const target={raceId:'202610213008',date:'2026-10-21',course:'ダート1000m',startsAt:Date.parse('2026-10-21T10:00:00Z')};
  const race={...target,raceId:'202610213001',title:'門別1R',condition:'重',startsAt:target.startsAt-3600000,capturedAt:'2026-10-21T09:30:00Z',isFinished:true,horses:finishers,finishers};
  const out=buildDayTrends(target,[race,{...race,raceId:target.raceId},{...race,raceId:'202610213002',capturedAt:'2026-10-21T11:00:00Z'}],target.startsAt);
  assert.equal(out.raceCount,1);assert.equal(out.races[0].popularity.pattern,'A-B-A');
});
