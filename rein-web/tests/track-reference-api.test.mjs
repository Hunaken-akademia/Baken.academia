import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile=name=>ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const uri=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const cache=new Map();let reads=0,fail=false,cutoff,venue;
const builder = {
 select(){return this;},
 eq(column,value){if(column==='venue')venue=value;return this;},
 lte(column,value){assert.equal(column,'reference_date');cutoff=value;return this;},
 order(){return this;},
 async limit(n){assert.equal(n,6);reads++;return fail?{error:new Error('down')}:{data:[{reference_date:'2020-09-13',source_url:'https://www.jra.go.jp/',payload:{kind:'measurement',cushion:9.4}}]};}
};
globalThis.trackApiQA={getCache:()=>({get:async k=>cache.get(k),set:async(k,v)=>cache.set(k,v)}),createClient:async()=>({from:()=>Object.create(builder)})};

let code=compile('track-reference-server').replace('import { NextResponse } from "next/server";','const NextResponse={json:(value,init)=>Response.json(value,init)};').replace('import { getCache } from "@vercel/functions";','const {getCache}=globalThis.trackApiQA;').replace('import { createClient } from "./supabase/server";','const {createClient}=globalThis.trackApiQA;');
for(const dep of ['track-reference','nar-source'])code=code.replace(JSON.stringify('./'+dep),JSON.stringify(uri(compile(dep))));
const {trackReferenceResponse}=await import(uri(code));
const request=(v,d)=>({nextUrl:new URL(`https://rein.test/api/races/track-reference?${new URLSearchParams({venue:v,date:d})}`)});
test('reference API rejects unbounded input, selects only dates on or before target and caches results',async()=>{
 for(const [v,d] of [['bogus','2026-01-01'],['東京','2026-02-30'],['東京','2017-01-01'],['東京','2099-01-01']])assert.equal((await trackReferenceResponse(request(v,d),'jra')).status,400);
 assert.equal(reads,0);
 const res=await trackReferenceResponse(request('東京','2020-09-14'),'jra'),body=await res.json();
 assert.equal(res.status,200);assert.equal(cutoff,'2020-09-14');assert.equal(venue,'東京');assert.equal(body.live,null);assert.equal(body.records[0].reference_date,'2020-09-13');assert.equal(res.headers.get('cache-control'),'private, no-store');
 await trackReferenceResponse(request('東京','2020-09-14'),'jra');assert.equal(reads,1);
 fail=true;assert.equal((await trackReferenceResponse(request('京都','2020-09-14'),'jra')).status,503);
});
