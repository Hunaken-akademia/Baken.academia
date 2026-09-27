import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../lib/prediction-journal.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {makeJournalEntry,addJournalEntry,attachJournalResult,journalSummary,readJournal,marketRankPoints}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const input=()=>({race:{raceId:'qa',title:'テスト',startsAt:Date.parse('2026-09-27T06:00:00Z')},prediction:{phase:'prestart',source:'live',generatedAt:'2026-09-27T05:00:00Z'},model:{version:'frozen-test'},evaluation:{roleModel:'ready'},horses:Array.from({length:12},(_,i)=>({number:i+1,name:`馬${i+1}`,popularity:i+1,odds:i+2,firstProbability:(12-i)/78,secondProbability:(i+1)/78,thirdProbability:(12-i)/78}))});
const result=(data)=>({...data,review:{isFinished:true,finishers:[{number:10,finish:1},{number:11,finish:2},{number:2,finish:3}]}});

test('never records rebuilt or post-start calculations, permits an authentic cached prestart',()=>{
  const d=input();assert.ok(makeJournalEntry(d));
  assert.equal(makeJournalEntry({...d,prediction:{...d.prediction,phase:'final',source:'rebuilt'}}),null);
  assert.equal(makeJournalEntry({...d,prediction:{...d.prediction,generatedAt:'2026-09-27T06:00:00Z'}}),null);
  assert.equal(makeJournalEntry({...d,evaluation:{roleModel:'unavailable'}}),null);
  assert.ok(makeJournalEntry({...d,prediction:{...d.prediction,phase:'final',source:'prestart'}}));
});
test('saving is immutable; a result cannot rewrite the forecast or saved popularity',()=>{
  const d=input(),e=makeJournalEntry(d);let entries=addJournalEntry([],e);
  const changed=structuredClone(e);changed.horses[9].popularity=1;
  assert.equal(addJournalEntry(entries,changed),entries);
  const r=result(d);r.horses=structuredClone(d.horses);r.horses[9].popularity=1;
  const updated=attachJournalResult(entries,r);
  assert.equal(entries[0].finishers,undefined);assert.deepEqual(updated[0].horses,e.horses);
  assert.equal(journalSummary(updated).find(b=>b.minPopularity===10).roles[0].races,1);
});
test('cancellations, ties and invalid result rows cannot enter the audit',()=>{
  const d=input(),entries=[makeJournalEntry(d)],r=result(d);
  assert.deepEqual(attachJournalResult(entries,{...r,horses:r.horses.slice(1)}),entries);
  assert.equal(attachJournalResult(entries,{...r,review:{isFinished:true,finishers:[...r.review.finishers,{number:12,finish:3}]}}),entries);
  assert.equal(attachJournalResult(entries,{...r,review:{isFinished:true,finishers:[...r.review.finishers,{number:9,finish:-1}]}}),entries);
});
test('exact-place top5 uses latest saved race once, saved popularity and stable ties',()=>{
  const d=input(),old=makeJournalEntry(d),later=makeJournalEntry({...d,prediction:{...d.prediction,generatedAt:'2026-09-27T05:30:00Z'}});
  const entries=attachJournalResult([old,later],result(d));const stats=journalSummary(entries);
  assert.deepEqual(stats[0].roles.map(r=>[r.hits,r.races]),[[0,1],[1,1],[1,1]]);
  assert.deepEqual(stats.find(b=>b.minPopularity===4).roles.map(r=>r.races),[1,1,0]);
  const tied=structuredClone(d);tied.horses.forEach(h=>h.firstProbability=1/12);
  assert.deepEqual(marketRankPoints(tied.horses).map(h=>h.number),d.horses.map(h=>h.number));
});
test('malformed storage is discarded and no missing market data becomes a chart',()=>{
  assert.deepEqual(readJournal('{broken'),[]);assert.deepEqual(readJournal('[null,{}]'),[]);
  const d=input(),e=makeJournalEntry(d);assert.deepEqual(readJournal(JSON.stringify([e])),[e]);
  assert.deepEqual(readJournal(JSON.stringify([{...e,roster:'wrong'}])),[]);
  d.horses[0].popularity=0;assert.deepEqual(marketRankPoints(d.horses),[]);
  const entries=attachJournalResult([makeJournalEntry(d)],{...d,review:{isFinished:true,finishers:[{number:1,finish:1},{number:2,finish:2},{number:3,finish:3}]}});
  assert.equal(journalSummary(entries)[0].roles[0].races,1);
  assert.equal(journalSummary(entries)[1].roles[0].races,0);
});
