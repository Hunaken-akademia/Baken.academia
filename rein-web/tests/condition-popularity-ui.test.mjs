import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const bundle=await build({entryPoints:[path.join(here,'condition-popularity-fixture.tsx')],bundle:true,write:false,platform:'browser',jsx:'automatic',alias:{'@':path.resolve(here,'..')},define:{'process.env.NODE_ENV':'"production"'}});
test('matrix reasons, horse details and independent group selection work through rendered controls',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only',url:'https://rein.test'});
 try{
 dom.window.eval(bundle.outputFiles[0].text);
 const tick=()=>new Promise(resolve=>setTimeout(resolve,25));await tick();
 const doc=dom.window.document;
 const button=name=>[...doc.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')===name||el.textContent===name);
 button('1 検証馬1・距離 ◎の根拠').click();await tick();assert.match(doc.querySelector('[aria-label="全頭の適性早見表"] [role="status"]').textContent,/10走・3着内率 60.0%・通算比 \+20.0pt/);
 button('1 検証馬1・血統 —の根拠').click();await tick();assert.match(doc.querySelector('[aria-label="全頭の適性早見表"] [role="status"]').textContent,/実績未取得/);
 button('1 検証馬1の詳細を見る').click();assert.equal(doc.querySelector('#detail').textContent,'検証馬1');
 for(const n of [10,11,12]){button(`Dグループ ${n} 検証馬${n}を候補に追加`).click();await tick();}
 assert.equal(button('Dグループ 13 検証馬13を候補に追加').disabled,true);
 button('Aグループ 1 検証馬1を候補に追加').click();await tick();assert.match(doc.querySelector('[aria-label="人気グループから候補を選ぶ"] [role="status"]').textContent,/選んだ候補 4頭/);
 button('候補をクリア').click();await tick();assert.match(doc.querySelector('[aria-label="人気グループから候補を選ぶ"] [role="status"]').textContent,/選んだ候補 0頭/);
 assert.match(doc.querySelector('[aria-label="このレースの人気別決着"]').textContent,/A-B-A/);
 }finally{dom.window.close();}
});
