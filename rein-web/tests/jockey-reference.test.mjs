import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../lib/jockey-reference.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {jockeyPercent,jockeyInterval,jockeyContext,matchJockey}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('exact rate and sparse interval preserve counts and distinguish missing values',()=>{
 assert.equal(jockeyPercent([10,1,2,3],3),30);assert.equal(jockeyPercent(undefined,3),null);assert.equal(jockeyPercent([0,0,0,0],1),null);
 const ci=jockeyInterval([2,1,1,1]);assert.ok(ci[0]<20&&ci[1]>80);assert.equal(jockeyInterval(undefined),null);
});
test('context uses exact metres, frame not horse number, and never guesses unknown turns',()=>{
 const c=jockeyContext('中山11R','芝2000m 右',8);assert.equal(c.venueDistance,'中山|芝|2000');assert.equal(c.gate,'外枠（7〜8）');assert.equal(c.turn,'右回り');assert.equal(jockeyContext('大井1R','ダート1600m').turn,'');
});
test('IDs take precedence and ambiguous normalized names stay unavailable',()=>{
 const a={name:'テスト 騎手',groups:{}},b={name:'テスト騎手',groups:{}},r={jockeys:{1:a,2:b}};assert.equal(matchJockey(r,'001','テスト騎手'),a);assert.equal(matchJockey(r,undefined,'テスト騎手'),null);
});
test('bundled JRA and NAR exact condition counts reconcile with all starts',()=>{
 for(const league of ['jra','nar']){const r=JSON.parse(gunzipSync(Buffer.from(readFileSync(new URL(`../data/${league}-jockey-reference.json.gz.b64`,import.meta.url),'utf8').trim(),'base64')));assert.equal(r.meta.league,league);let total=0;for(const p of Object.values(r.jockeys)){const c=p.groups.all[''];assert.ok(c[0]>=c[3]&&c[3]>=c[2]&&c[2]>=c[1]);assert.equal(Object.values(p.groups.venue).reduce((s,v)=>s+v[0],0),c[0]);total+=c[0];}assert.equal(total,r.meta.starts);}
});
