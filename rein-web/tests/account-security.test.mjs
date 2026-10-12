import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const moduleUrl=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
let source=ts.transpileModule(readFileSync(new URL('../app/api/account-data/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const mocks={
 'next/server':moduleUrl('export const NextResponse={json:(data,init)=>Response.json(data,init)};'),
 '@/lib/supabase/server':moduleUrl('export const createClient=async()=>{globalThis.__accountSecurity.authCalls++;return {auth:{getClaims:async()=>({data:{claims:globalThis.__accountSecurity.claims}})},from:()=>{throw Error("unexpected data access")}}};'),
 '@/lib/prediction-journal':moduleUrl('export const JOURNAL_LIMIT=100;export const readJournal=()=>[];'),
};
for(const [name,url] of Object.entries(mocks)) source=source.replaceAll(JSON.stringify(name),JSON.stringify(url));
const {GET,POST}=await import(moduleUrl(source));
function request(origin){const r=new Request('https://rein.invalid/api/account-data',{method:'POST',headers:origin?{origin}:{},body:'{}'});r.nextUrl=new URL(r.url);return r;}
test('cross-origin account writes are rejected before identity or data access',async()=>{
 globalThis.__accountSecurity={authCalls:0,claims:{sub:'user-a'}};
 assert.equal((await POST(request('https://untrusted.invalid'))).status,403);
 assert.equal(globalThis.__accountSecurity.authCalls,0);
});
test('unauthenticated account reads and same-origin writes fail closed',async()=>{
 globalThis.__accountSecurity={authCalls:0,claims:null};
 assert.equal((await GET(request())).status,401);
 const response=await POST(request('https://rein.invalid'));
 assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'private, no-store');
});
