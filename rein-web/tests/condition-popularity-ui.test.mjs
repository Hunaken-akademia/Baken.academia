import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const bundle=await build({entryPoints:[path.join(here,'condition-popularity-fixture.tsx')],bundle:true,write:false,platform:'browser',jsx:'automatic',alias:{'@':path.resolve(here,'..')},define:{'process.env.NODE_ENV':'"production"'}});
test('matrix reasons, sparse data and automatic pattern predictions render without manual group picking',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only',url:'https://rein.test'});
 try{
 dom.window.fetch=async()=>({ok:true,json:async()=>({previousRuns:{},trends:{races:[{popularity:{pattern:'A-B-A',source:'結果掲載人気'}}]}})});
 dom.window.eval(bundle.outputFiles[0].text);
 const tick=()=>new Promise(resolve=>setTimeout(resolve,25));await tick();
 const doc=dom.window.document;
 const button=name=>[...doc.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')===name||el.textContent===name);
 button('1 検証馬1・距離 ◎の根拠').click();await tick();assert.match(doc.querySelector('[aria-label="全頭の適性早見表"] [role="status"]').textContent,/10走・3着内率 60.0%・通算比 \+20.0pt/);
 assert.doesNotMatch(doc.querySelector('[aria-label="全頭の適性早見表"] table').textContent,/血統/);
 button('1 検証馬1・騎手との相性 ◎の根拠').click();await tick();assert.match(doc.querySelector('[aria-label="全頭の適性早見表"] [role="status"]').textContent,/騎手1騎手で3-2-1-1・7走/);
 button('2 検証馬2・騎手との相性 —の根拠').click();await tick();assert.match(doc.querySelector('[aria-label="全頭の適性早見表"] [role="status"]').textContent,/騎手2騎手とは初コンビ/);
 const sireRow=[...doc.querySelectorAll('[aria-label="全頭の適性早見表"] tr')].find(tr=>tr.querySelector('th')?.textContent.startsWith('種牡馬'));
 assert.equal(sireRow.querySelectorAll('td')[0].textContent,'フリオーソ（モンテロッソ）');assert.equal(sireRow.querySelectorAll('td')[1].textContent,'—');
 button('1 検証馬1の詳細を見る').click();assert.equal(doc.querySelector('#detail').textContent,'検証馬1');
 assert.match(doc.querySelector('[aria-label="人気パターン予測"]').textContent,/② 適性表だけの参考予測/);
 await tick();
 const daily=doc.querySelector('[aria-label="当日傾向だけの人気パターン"]');
 assert.match(daily.textContent,/A→B→A/);
 assert.match(daily.textContent,/1\/1レース/);
 assert.ok(daily.compareDocumentPosition([...doc.querySelectorAll('h3')].find(h=>h.textContent.includes('② 適性表'))) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
 assert.match(doc.querySelector('[aria-label="人気パターン予測"]').textContent,/③ REIN＋当日傾向の注目パターン/);
 assert.match(doc.querySelector('[aria-label="人気パターン予測"]').textContent,/[ABCD] → [ABCD] → [ABCD]/);
 assert.doesNotMatch(doc.body.textContent,/候補をクリア|グループから候補を選ぶ/);
 assert.match(doc.querySelector('[aria-label="このレースの人気別決着"]').textContent,/A-B-A/);
 }finally{dom.window.close();}
});
