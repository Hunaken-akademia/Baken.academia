import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
const uri=c=>'data:text/javascript;base64,'+Buffer.from(c).toString('base64');
const compile=name=>ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const core=compile('odds-trends').replace(/import catalog from "\.\/odds-trend-catalog.json";/,`const catalog=${readFileSync(new URL('../lib/odds-trend-catalog.json',import.meta.url),'utf8')};`);
const store=new Map();let reads=0,fetches=0,writes=0,observations=[];
const now=Date.now(),starts=now+3600000;
const payload={race:{raceId:'2605040308',title:'東京11R テスト GII',course:'芝・左1600m',condition:'良',league:'jra',startsAt:starts},horses:[{number:1,gate:1,odds:3},{number:2,gate:1,odds:3},{number:3,gate:2,odds:3}],prediction:{phase:'prestart'}};
const matrix=(prefix,values)=>`<table class="hr-tableLeftTop--oddsW"><thead><tr><th>${prefix}</th></tr></thead><tbody>${values.map(([n,o])=>`<tr><th>${n}</th><td>${o}</td></tr>`).join('')}</tbody></table>`;
const meta='<meta property="og:url" content="https://sports.yahoo.co.jp/keiba/race/odds/tfw/2605040308">';
const win=meta+'<table class="hr-tableValue"><thead><tr><th>単勝</th></tr></thead><tbody>'+payload.horses.map(h=>`<tr><td>${h.gate}</td><td>${h.number}</td><td>馬</td><td>${h.odds}</td><td>1.1 - 1.2</td></tr>`).join('')+'</tbody></table>'+matrix(1,[[1,12],[2,15]]);
globalThis.__oddsQA={getCache:()=>({get:async k=>store.get(k),set:async(k,v)=>store.set(k,v)}),getVercelOidcToken:async()=> 'test-server-identity',storedSnapshot:async()=>{reads++;return {snapshot:{payload}};},fetchSource:async url=>{fetches++;return url.includes('/sf/')?meta+matrix('1－2',[[3,8]]):win;}};
globalThis.fetch=async(url,init)=>{assert.match(String(url),/rein-odds-observations$/);assert.equal(init.headers.authorization,'Bearer test-server-identity');const b=JSON.parse(init.body);if(b.action==='write'){writes++;observations=b.items.map(i=>({...i,saved:true}));return Response.json({saved:true});}return Response.json({items:observations});};
let code=compile('odds-trends-server')
 .replace(/import \{[^;]+\} from "next\/server";/,'const NextResponse={json:(b,i)=>Response.json(b,i)};')
 .replace(/import \{[^;]+\} from "@vercel\/functions";/,'const {getCache}=globalThis.__oddsQA;')
 .replace(/import \{[^;]+\} from "@vercel\/oidc";/,'const {getVercelOidcToken}=globalThis.__oddsQA;')
 .replace(/import \{[^;]+\} from "\.\/server-snapshots";/,'const {storedSnapshot}=globalThis.__oddsQA;')
 .replace(/import \{[^;]+\} from "\.\/source-fetch";/,'const {fetchSource}=globalThis.__oddsQA;')
 .replace(/import \{[^;]+\} from "\.\/supabase\/config";/,'const SUPABASE_URL="https://test.invalid";');
for(const [name,s] of [['odds-trends',core],['odds-trend-market',compile('odds-trend-market')],['nar-source',compile('nar-source')]])code=code.replaceAll(JSON.stringify('./'+name),JSON.stringify(uri(s)));
const api=await import(uri(code));
test('member route rejects invalid IDs without reads; concurrent loads verify markets and durably save selected tickets',async()=>{
 const invalid=await api.oddsTrendsResponse({nextUrl:new URL('https://test.invalid/?raceId=wrong')},'jra');assert.equal(invalid.status,400);assert.equal(reads,0);
 const values=await Promise.all([api.getOddsTrends(payload.race.raceId,'jra'),api.getOddsTrends(payload.race.raceId,'jra')]);
 assert.equal(reads,1);assert.equal(fetches,2);assert.equal(writes,1);assert.ok(values[0].items.length>0);assert.ok(values[0].items.every(i=>i.saved&&i.state==='ready'));assert.ok(values[0].items.every(i=>i.selections.length<=3));
 assert.equal(JSON.stringify(values[0]).includes('test-server-identity'),false);
});
test('start-time cache transition returns saved prestart selections without fetching final odds or rewriting records',async()=>{
 const old=Date.now;Date.now=()=>starts+1;
 try{const fetched=fetches,saved=writes;const body=await api.getOddsTrends(payload.race.raceId,'jra');assert.equal(body.phase,'saved-prestart');assert.deepEqual(body.items,observations);assert.equal(fetches,fetched);assert.equal(writes,saved);}finally{Date.now=old;}
});
