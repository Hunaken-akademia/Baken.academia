import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
async function load(name) {
  const source=readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const {raceProgress}=await load('race-progress');
const {fetchSource}=await load('source-fetch');
test('next race advances at start time without claiming a confirmed result',()=>{
  const races=[{number:4,start:'11:35',status:'次レース'},{number:5,start:'12:25',status:'発売前'}];
  assert.equal(raceProgress(races,new Date('2026-09-21T02:34:00Z')).nextRace,4);
  const next=raceProgress(races,new Date('2026-09-21T02:35:00Z'));
  assert.equal(next.nextRace,5);
  assert.equal(next.races[0].status,'発走時刻経過');
  assert.equal(raceProgress(races,new Date('2026-09-21T03:25:00Z')).nextRace,13);
});
test('transient fetch retries once; optional failure does not block; required failure is explicit',async()=>{
  const original=globalThis.fetch;
  const warn=console.warn;
  console.warn=()=>{};
  try{
    let calls=0;
    globalThis.fetch=async()=>{if(++calls===1)throw new TypeError('fetch failed');return new Response('valid');};
    assert.equal(await fetchSource('https://example.com/card','出馬表'),'valid');
    assert.equal(calls,2);
    calls=0;
    globalThis.fetch=async()=>{calls++;throw new TypeError('fetch failed');};
    assert.equal(await fetchSource('https://example.com/result','結果',true),'');
    assert.equal(calls,2);
    await assert.rejects(fetchSource('https://example.com/card','出馬表'),/出馬表の取得に失敗/);
  }finally{globalThis.fetch=original;console.warn=warn;}
});
