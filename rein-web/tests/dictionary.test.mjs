import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url),web=fileURLToPath(new URL('..',import.meta.url));
function loader(stubs={}){const cache=new Map();function load(file){const full=['.tsx','.ts','.json',''].map(ext=>file+ext).find(existsSync);if(!full)throw Error(file);if(cache.has(full))return cache.get(full).exports;const m={exports:{}};cache.set(full,m);if(full.endsWith('.json')){m.exports=JSON.parse(readFileSync(full,'utf8'));return m.exports;}const code=ts.transpileModule(readFileSync(full,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;new Function('require','module','exports',code)(n=>n in stubs?stubs[n]:n==='server-only'?{}:n.startsWith('@/')?load(path.join(web,n.slice(2))):n.startsWith('.')?load(path.resolve(path.dirname(full),n)):require(n),m,m.exports);return m.exports;}return load;}
const load=loader(),lib=load(path.join(web,'lib/dictionary'));
test('dictionary search normalizes Japanese, filters samples and bounds pages',()=>{
 const base={kind:'horse',league:'jra',counts:[20,4,6,8],from:'2020-01-01',to:'2026-09-13'};
 const index={meta:{league:'jra'},entries:{horse:[{...base,id:'1',name:'テスト ホース'},{...base,id:'2',name:'別馬',counts:[1,1,1,1]}]}};
 assert.equal(lib.searchDictionary(index,{kind:'horse',query:'てすとほーす'}).entries[0].id,'1');
 assert.equal(lib.searchDictionary(index,{kind:'horse',minimum:10}).total,1);
 assert.equal(lib.searchDictionary(index,{kind:'horse',offset:2}).entries.length,0);
 assert.equal(lib.dictionaryRate([10,2,3,4],2),30);assert.equal(lib.dictionaryRate([0,0,0,0]),null);
 assert.equal(lib.dictionaryHighlights({...base,groups:{going:{重:[2,2,2,2]}}}).length,0);
});
test('graded summaries use known race denominators and preserve dead-heat categories',()=>{
 const editions=[{winnerPopularities:[1,2],winnerGates:[1,6]},{winnerPopularities:[7],winnerGates:[]},{winnerPopularities:[],winnerGates:[8]}];
 assert.deepEqual(lib.editionTrends(editions).map(x=>[x.hits,x.n]),[[1,2],[1,2],[1,2],[1,2]]);
});
test('dictionary API reads real league files, loads details and rejects invalid input',async()=>{
 const {dictionaryRequest}=load(path.join(web,'lib/dictionary-server')),{NextRequest}=require('next/server');
 for(const league of ['jra','nar']){
  const response=await dictionaryRequest(new NextRequest('https://rein.invalid/?kind=jockey&min=100&sort=starts'),league);
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');const body=await response.json();assert.equal(body.entries.length,30);assert.equal(body.meta.league,league);
  const e=body.entries[0],detail=await dictionaryRequest(new NextRequest('https://rein.invalid/?kind=jockey&id='+e.id),league);assert.equal(detail.status,200);const p=(await detail.json()).profile;assert.deepEqual(p.counts,e.counts);assert.equal(p.league,league);assert.ok(p.groups.venueDistance);
  assert.equal((await dictionaryRequest(new NextRequest('https://rein.invalid/?kind=secret'),league)).status,400);
  assert.equal((await dictionaryRequest(new NextRequest('https://rein.invalid/?id=../../secrets'),league)).status,404);
  assert.equal((await dictionaryRequest(new NextRequest('https://rein.invalid/?offset=-1'),league)).status,400);
 }
});
test('dictionary routes retain authentication and league membership boundaries',async()=>{
 let plan='jra',signed=true;
 const stub={createServerClient:()=>({auth:{getClaims:async()=>({data:{claims:signed?{sub:'test-user'}:null}})},from:()=>({select:()=>({maybeSingle:async()=>({data:{plan,status:'active',access_starts_at:'2020-01-01',access_ends_at:null}})})})})};
 const l=loader({'@supabase/ssr':stub}),{updateSessionAndAuthorize}=l(path.join(web,'lib/supabase/proxy')),{NextRequest}=require('next/server');const request=p=>new NextRequest('https://rein.invalid'+p);
 assert.equal((await updateSessionAndAuthorize(request('/api/analyze/dictionary'))).status,200);
 assert.equal((await updateSessionAndAuthorize(request('/api/nar/dictionary'))).status,403);
 plan='nar';assert.equal((await updateSessionAndAuthorize(request('/api/analyze/dictionary'))).status,403);
 plan='all';assert.equal((await updateSessionAndAuthorize(request('/api/nar/dictionary'))).status,200);
 signed=false;assert.equal((await updateSessionAndAuthorize(request('/api/analyze/dictionary'))).status,401);
 assert.equal((await updateSessionAndAuthorize(request('/dictionary'))).status,307);
 assert.ok(readFileSync(path.join(web,'proxy.ts'),'utf8').includes('"/dictionary/:path*"'));
});
test('course profiles identify whose rates are shown and omit pooled course summaries',async()=>{
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{NextRequest}=require('next/server');
 const {dictionaryRequest}=load(path.join(web,'lib/dictionary-server'));
 const response=await dictionaryRequest(new NextRequest('https://rein.invalid/?kind=course&id='+encodeURIComponent('佐賀|ダート|1400')),'nar');
 assert.equal(response.status,200);const {profile}=await response.json();
 const {ProfileDetail}=loader()(path.join(web,'components/rein-dictionary'));
 const dom=new JSDOM(renderToStaticMarkup(React.createElement(ProfileDetail,{profile}))),doc=dom.window.document;
 try{
  const summary=doc.querySelector('[aria-label="コースの収録規模と1番人気の成績"]');assert.ok(summary);
  assert.match(summary.textContent,/53,513.*頭分/);
  assert.match(summary.textContent,/このコースの1番人気の馬.*5,286走/);
  assert.match(summary.textContent,/47\.0%/);assert.doesNotMatch(summary.textContent,/9\.9%/);
  assert.doesNotMatch(doc.body.textContent,/収録期間全体 \/|直近30出走|収録内で好成績の条件/);
  assert.match(doc.querySelector('tbody').textContent,/1枠の馬/);
  assert.equal(doc.querySelector('thead th').textContent,'対象の馬');assert.ok(doc.querySelector('tbody th').classList.contains('sticky'));
  const groups=[...doc.querySelector('[aria-label="辞典詳細の集計条件"]').options].map(o=>o.value);
  assert.ok(groups.includes('popularity'));assert.ok(!groups.includes('venueDistance'));assert.ok(!groups.includes('position'));
  assert.equal(lib.dictionaryCourseSubject('popularity','1番人気'),'1番人気の馬');assert.equal(lib.dictionaryCourseSubject('year','2026'),'2026年の出走馬');
  assert.deepEqual(lib.dictionaryHighlights({...profile,groups:{going:{重:[100,60,70,80]}}}),[]);
  const missing={...profile,groups:{...profile.groups,popularity:{不明:profile.counts}}};
  assert.match(renderToStaticMarkup(React.createElement(ProfileDetail,{profile:missing})),/1番人気の成績は未取得/);
 }finally{dom.window.close();}
});
test('dictionary UI loads profiles, switches conditions and shows fetch failures',async()=>{
 const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost',pretendToBeVisual:true});
 for(const n of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','CustomEvent','Event'])Object.defineProperty(globalThis,n,{value:dom.window[n],configurable:true});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;dom.window.HTMLElement.prototype.scrollIntoView=function(){};
 const React=require('react'),{createRoot}=require('react-dom/client'),h=React.createElement,{NextRequest}=require('next/server');
 const {dictionaryRequest}=load(path.join(web,'lib/dictionary-server'));const oldFetch=globalThis.fetch;let fail=false;
 globalThis.fetch=async url=>fail?Response.json({error:'取得テスト失敗'},{status:503}):dictionaryRequest(new NextRequest('https://rein.invalid'+url),url.startsWith('/api/nar')?'nar':'jra');
 const ui=loader({'next/link':{__esModule:true,default:({children,href,...props})=>h('a',{href,...props},children)}})(path.join(web,'components/rein-dictionary'));const root=createRoot(document.getElementById('app'));
 const settle=async()=>{await React.act(async()=>{await new Promise(r=>setTimeout(r,80));});};
 try{
  await React.act(async()=>root.render(h(ui.ReinDictionary,{plan:'jra',initialKind:'jockey'})));await settle();
  const buttons=[...document.querySelectorAll('[aria-label="辞典の競馬区分"] button')];assert.equal(buttons.find(b=>b.textContent==='中央').disabled,false);assert.equal(buttons.filter(b=>b.disabled).length,2);
  const entry=document.querySelector('[aria-label="辞典の検索結果"] button');assert.ok(entry);
  await React.act(async()=>entry.click());await settle();
  assert.match(document.body.textContent,/収録期間全体/);assert.match(document.body.textContent,/収録内の直近30出走/);
  const select=document.querySelector('[aria-label="辞典詳細の集計条件"]');assert.ok(select);
  await React.act(async()=>{select.value='going';select.dispatchEvent(new Event('change',{bubbles:true}));});assert.match(document.querySelector('caption').textContent,/馬場状態/);
  await React.act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='閉じる').click());assert.equal(document.querySelector('[aria-label="辞典詳細の集計条件"]'),null);
  const searchSort=document.querySelector('[aria-label="辞典の並べ替え"]');
  await React.act(async()=>{searchSort.value='win';searchSort.dispatchEvent(new Event('change',{bubbles:true}));});await settle();
  await React.act(async()=>[...document.querySelectorAll('[aria-label="辞典の種類"] button')].find(b=>b.textContent==='コース').click());await settle();
  const courseEntry=document.querySelector('[aria-label="辞典の検索結果"] button');assert.match(courseEntry.textContent,/延べ出走頭数/);assert.doesNotMatch(courseEntry.textContent,/勝率|3着内率|%/);
  assert.deepEqual([...searchSort.options].map(o=>o.value),['recent','starts']);assert.equal(searchSort.value,'recent');
  await React.act(async()=>courseEntry.click());await settle();
  const courseCondition=document.querySelector('[aria-label="辞典詳細の集計条件"]');
  await React.act(async()=>{courseCondition.value='popularity';courseCondition.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.match(document.querySelector('tbody').textContent,/1番人気の馬/);
  fail=true;await React.act(async()=>[...document.querySelectorAll('[aria-label="辞典の種類"] button')].find(b=>b.textContent==='厩舎').click());await settle();assert.match(document.querySelector('[role="alert"]').textContent,/取得テスト失敗/);
 }finally{await React.act(async()=>root.unmount());dom.window.close();globalThis.fetch=oldFetch;}
});
