import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const source=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8').replace('import { serverData } from "./server-snapshots";','const serverData = (...args: unknown[]) => (globalThis as any).__historyBroker(...args);');
let serial=0;
async function load(){const code=ts.transpileModule(source+'\n// '+serial++,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));}
const profile=date=>({meta:{version:'history-v2',dateTo:date},horse:{},jockey:{}});

test('history reads authenticated immutable profile, reuses warm cache and sees updates after five minutes',async t=>{
 let date='2026-09-27',now=1_000_000,calls=0;
 t.mock.method(Date,'now',()=>now);
 globalThis.__historyBroker=async action=>{assert.equal(action,'jra-profile');calls++;const bytes=gzipSync(JSON.stringify(profile(date)));return {signed_url:'https://example.invalid/profile',sha:createHash('sha256').update(bytes).digest('hex'),dateTo:date};};
 t.mock.method(globalThis,'fetch',async()=>new Response(gzipSync(JSON.stringify(profile(date)))));
 const {loadHistory}=await load();assert.equal((await loadHistory()).meta.dateTo,date);
 await loadHistory();assert.equal(calls,1);
 date='2026-10-04';now+=301_000;assert.equal((await loadHistory()).meta.dateTo,date);assert.equal(calls,2);
});

test('corrupt or wrong-date profiles are rejected and failed promises do not poison later loads',async t=>{
 const bytes=gzipSync(JSON.stringify(profile('2026-10-04')));
 let sha='wrong',dateTo='2026-10-04';
 globalThis.__historyBroker=async()=>({signed_url:'https://example.invalid/profile',sha,dateTo});
 t.mock.method(globalThis,'fetch',async()=>new Response(bytes));
 const {loadHistory}=await load();await assert.rejects(loadHistory(),/checksum/);
 sha=createHash('sha256').update(bytes).digest('hex');dateTo='2026-10-03';await assert.rejects(loadHistory(),/invalid/);
 dateTo='2026-10-04';assert.equal((await loadHistory()).meta.dateTo,dateTo);
});
