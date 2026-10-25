import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const code=ts.transpileModule(readFileSync(new URL('../lib/track-reference.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {cushionDescription,cushionImpact,parseLiveCushion,validTrackDate,safeTrackSource,displayTrackEntries}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('official classifications, calendar validation and source link allowlist',()=>{
  for(const [value,label] of [[12,'硬め'],[10,'やや硬め'],[8,'標準'],[7.1,'やや軟らかめ'],[7,'軟らかめ'],[6.9,'軟らかめ']])assert.equal(cushionDescription(value),label);
  assert.equal(validTrackDate('2026-02-30'),false);assert.equal(validTrackDate('2024-02-29'),true);
  assert.equal(safeTrackSource('https://www.jra.go.jp/keiba/baba/'),true);
  assert.equal(safeTrackSource('https://blog.f-keiba.com/info/2022/03/post-cd66.html'),true);
  for(const url of ['javascript:alert(1)','https://www.jra.go.jp.evil.example/','http://www.jra.go.jp/'])assert.equal(safeTrackSource(url),false);
});
test('impact explains physical rebound without inventing pace, style or horse suitability',()=>{
 assert.match(cushionImpact(10.5).effect,/反発が比較的大きく/);
 assert.match(cushionImpact(9).effect,/標準的/);
 assert.match(cushionImpact(7).effect,/反発は比較的小さく/);
 assert.match(cushionImpact(7).check,/パワー型向きとは決められません/);
 for(const value of [null,undefined,NaN,Infinity,-1,21])assert.equal(cushionImpact(value),null);
});
test('live fragment stays venue-specific and preserves yearless source time',()=>{
 const html='<div id="cushion_data_list"><div id="rcA" title="東京"><div class="unit"><div class="time">10月24日（土曜）7時00分</div><div class="cushion">9.5</div></div></div><div id="rcB" title="京都"><div class="unit"><div class="time">10月24日（土曜）7時00分</div><div class="cushion">10.2</div></div></div></div>';
 assert.deepEqual(parseLiveCushion(html,'東京'),{observedTime:'10月24日(土曜)7時00分',value:9.5});
 assert.equal(parseLiveCushion(html,'京都').value,10.2);assert.equal(parseLiveCushion(html,'阪神'),null);
 assert.equal(parseLiveCushion(html.replace('9.5','99.5'),'東京'),null);
});
test('sand specifications, adjustment notices and forecasts remain distinct',()=>{
 const rows=displayTrackEntries([{metric:'sand_depth_cm',kind:'adjustment_notice',value_min:10,value_max:11},{metric:'turf_height_cm',kind:'forecast',value_min:10,value_max:11},{metric:'cushion',kind:'measurement_missing_year',value:9}]);
 assert.equal(rows.length,2);assert.match(rows[0],/砂厚 ・ 調整告知 ・ 10〜11cm/);assert.match(rows[1],/芝高 ・ 見込み/);
});
const bundle=await build({stdin:{contents:`import {createRoot} from 'react-dom/client';import {TrackReferencePanel} from './components/track-reference-panel';window.renderRace=r=>{window.trackRoot??=createRoot(document.getElementById('root'));window.trackRoot.render(<TrackReferencePanel race={r}/>)};`,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',jsx:'automatic',alias:{'@':root},define:{'process.env.NODE_ENV':'"production"'}});
test('panel distinguishes past measurements, yearless live data, sand notices and failures',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only',url:'https://rein.test'});
 const measurement={reference_date:'2026-09-27',source_url:'https://www.jra.go.jp/keiba/baba/archive/2026pdf/tokyo01.pdf',payload:{kind:'measurement',cushion:9.5,cushion_time:'07:00',moisture_time:'05:00',course:'A',turf_moisture_goal:12,turf_moisture_turn4:13,dirt_moisture_goal:4,dirt_moisture_turn4:5}};
 let fail=false,requests=[];
 dom.window.fetch=async url=>{requests.push(url);const q=new URL(url,'https://rein.test').searchParams;return {ok:!fail,json:async()=>fail?{error:'一時的に取得できません'}:{venue:q.get('venue'),date:q.get('date'),records:q.get('venue')==='東京'?[measurement]:[{reference_date:'2026-03-16',source_url:'https://www.sonoda-himeji.jp/news/detail/2550',payload:{kind:'notice',entries:[{metric:'sand_depth_cm',kind:'reported_track_profile',value:14,segment:'1コーナー',distance_from_inner_m:1}]}}],live:q.get('venue')==='東京'?{value:9.8,observedTime:'10月25日(日曜)7時00分',sourceUrl:'https://www.jra.go.jp/keiba/baba/_data_cushion.html',fetchedAt:'2026-10-25T00:00:00Z'}:null}}};
 try{
 dom.window.eval(bundle.outputFiles[0].text);const tick=()=>new Promise(r=>setTimeout(r,40));
 dom.window.renderRace({raceId:'2605040308',title:'東京8R',course:'ダート1600m',league:'jra',startsAt:Date.parse('2026-10-25T05:00:00Z')});await tick();await tick();
 let text=dom.window.document.body.textContent;
 assert.match(text,/過去の測定記録（対象日の値ではありません）/);assert.match(text,/2026-09-27/);assert.match(text,/ダート含水率：ゴール前 4.0%/);assert.match(text,/原文に年の記載がない/);assert.match(text,/これは芝の測定値です/);assert.doesNotMatch(text,/予想での見方：/);assert.match(text,/予想スコア・買い目への加点は行っていません/);
 assert.equal(dom.window.document.querySelectorAll('[aria-label="馬場の参考情報"]').length,1);
 dom.window.renderRace({raceId:'2605040308',title:'東京8R',course:'芝1600m',league:'jra',startsAt:Date.parse('2026-10-25T05:00:00Z')});await tick();
 text=dom.window.document.body.textContent;assert.match(text,/走りへの影響・見るポイント/);assert.match(text,/展開への影響：逃げ・先行・差しの有利不利は/);assert.equal(dom.window.document.querySelectorAll('[aria-label="クッション値による影響の参考"]').length,1);
 dom.window.renderRace({raceId:'202610252701',title:'園田1R',course:'ダート1400m',league:'nar'});await tick();await tick();
 text=dom.window.document.body.textContent;assert.match(text,/当日の実測ではありません/);assert.match(text,/砂厚 ・ 掲載仕様 ・ 1コーナー ・ 内側から1m ・ 14cm/);assert.doesNotMatch(text,/9.8/);assert.match(requests.at(-1),/^\/api\/nar\/track-reference/);
 fail=true;dom.window.renderRace({raceId:'202610252801',title:'姫路1R',course:'ダート1400m',league:'nar'});await tick();await tick();assert.match(dom.window.document.body.textContent,/一時的に取得できません/);assert.doesNotMatch(dom.window.document.body.textContent,/14cm/);
 }finally{dom.window.close();}
});
