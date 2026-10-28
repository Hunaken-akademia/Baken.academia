import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../lib/race-finder.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {effectiveContenders,classifyRace,finderHit,trifectaResult,finderRow,FINDER_REFERENCE}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('effective contenders match the SQL used for validation and reject incomplete markets',()=>{
  // Niigata 1R on 2026-10-25: the validation query gives 8.38157004909969.
  const niigata=[2.6,5.3,5.2,9,10.4,15.3,27.9,14.1,25.2,30.1,43,64.7,97.9];
  assert.ok(Math.abs(effectiveContenders(niigata)-8.38157004909969)<1e-9);
  assert.ok(Math.abs(effectiveContenders([8,8,8,8,8])-5)<1e-12);
  assert.equal(effectiveContenders([2,3,4,5]),null);
  assert.equal(effectiveContenders([2,3,null,5,6]),null);
  assert.equal(effectiveContenders([2,3,0.9,5,6]),null);
  assert.equal(classifyRace('jra',niigata).kind,'middle');
});
test('cut-offs are inclusive for 固め and 荒れそう by league',()=>{
  const even=n=>Array(n).fill(10);
  assert.equal(classifyRace('nar',even(5)).kind,'solid');
  assert.equal(classifyRace('nar',even(6)).kind,'middle');
  assert.equal(classifyRace('nar',even(7)).kind,'rough');
  assert.equal(classifyRace('jra',even(6)).kind,'solid');
  assert.equal(classifyRace('jra',even(8)).kind,'middle');
  assert.equal(classifyRace('jra',even(9)).kind,'rough');
});
test('○ rules follow each kind and the published audit counts are consistent',()=>{
  assert.equal(finderHit('solid',9_990),true);assert.equal(finderHit('solid',10_000),false);
  assert.equal(finderHit('middle',2_990),false);assert.equal(finderHit('middle',3_000),true);
  assert.equal(finderHit('rough',9_990),false);assert.equal(finderHit('rough',10_000),true);
  for(const ref of Object.values(FINDER_REFERENCE)){
    const kinds=Object.values(ref.kinds);
    assert.equal(kinds.reduce((s,k)=>s+k.races,0),ref.total);assert.equal(kinds.reduce((s,k)=>s+k.jackpots,0),ref.jackpots);
    assert.equal(ref.kinds.solid.hits,ref.kinds.solid.races-ref.kinds.solid.jackpots);assert.equal(ref.kinds.rough.hits,ref.kinds.rough.jackpots);
  }
});
test('trifecta is read under both league labels; rows judge only prestart-saved odds',()=>{
  assert.deepEqual(trifectaResult([{type:'三連単',payout:19960,selection:'6-7-12',popularity:58}]),{payout:19960,selection:'6-7-12',popularity:58});
  assert.equal(trifectaResult([{type:'3連単',payout:4210,selection:'1-2-3'}]).popularity,null);
  assert.equal(trifectaResult([{type:'馬連',payout:500}]),null);
  const horses=[2.1,6.3,58.4,9,12,20].map((odds,i)=>({number:i+1,name:`馬${i+1}`,odds}));
  const payload=(source,generatedAt)=>({race:{raceId:'202610203604',title:'門別 4R ３歳以上',course:'ダート1000m',start:'16:20',startsAt:Date.parse('2026-10-20T07:20:00Z'),dataTimes:{odds:'2026-10-20T07:15:10Z'}},horses,prediction:{source,generatedAt},review:{isFinished:true,payouts:[{type:'三連単',payout:19960,selection:'6-7-12',popularity:58}]}});
  const row=finderRow('202610203604','nar','門別',payload('prestart','2026-10-20T07:15:10Z'));
  assert.equal(row.number,4);assert.equal(row.verified,true);assert.deepEqual(row.favorite,{name:'馬1',odds:2.1});assert.equal(row.result.payout,19960);assert.equal(row.field,6);
  assert.equal(finderRow('202610203604','nar','門別',payload('rebuilt','2026-10-20T08:00:00Z')).verified,false);
  assert.equal(finderRow('202610203604','nar','門別',{...payload('prestart','2026-10-20T07:15:10Z'),horses:horses.slice(0,4)}).kind,null);
});
