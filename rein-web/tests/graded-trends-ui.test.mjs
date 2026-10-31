import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const bundle=await build({entryPoints:[path.join(here,'graded-trends-fixture.tsx')],bundle:true,write:false,platform:'browser',jsx:'automatic',alias:{'@':path.resolve(here,'..')},define:{'process.env.NODE_ENV':'"production"'}});
// Built by scripts/build_graded_trends.py from tests/test_build_graded_trends.py's synthetic history.
const fixture=JSON.parse(readFileSync(new URL('./fixtures/graded-trends.json',import.meta.url),'utf8'));
test('graded trend cards show tiles, highlight strong buckets and switch pages',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only',url:'https://rein.test'});
  try{
    let requested='';
    dom.window.fetch=async url=>{requested=url;return {ok:true,json:async()=>({trend:fixture.races['天皇賞秋'],limitations:fixture.limitations})};};
    dom.window.eval(bundle.outputFiles[0].text);
    const tick=()=>new Promise(r=>setTimeout(r,120));await tick();
    assert.match(requested,/raceId=2605050811/);
    const section=dom.window.document.querySelector('[data-testid="graded-trends"]');
    assert.match(section.querySelector('h2').textContent,/天皇賞\(秋\)過去5年の傾向/);
    assert.match(section.textContent,/1番人気の成績5勝3着以内 5回／5年/);
    assert.match(section.textContent,/4番人気以下の勝ち0回/);
    // Overall top-3 rate is 100%: no bucket can be 1.25x above it, so nothing is yellow.
    const popularity=[...section.querySelectorAll('h3')].find(h=>h.textContent==='人気別').parentElement;
    assert.match(popularity.textContent,/1番人気100%5勝 5\/5/);
    const tab=label=>[...section.querySelectorAll('[role="tab"]')].find(b=>b.textContent.includes(label));
    tab('前走').click();await tick();
    assert.ok([...section.querySelectorAll('h3')].some(h=>h.textContent==='前走からの間隔'));
    tab('馬と騎手').click();await tick();
    assert.ok([...section.querySelectorAll('h3')].some(h=>h.textContent==='東京芝2000mの実績'));
    tab('血統と体').click();await tick();
    assert.match(section.textContent,/父（種牡馬）.*キタサンブラック5-0-0-0/s);
    tab('過去の1〜3着').click();await tick();
    assert.match(section.textContent,/2023年・良・3頭/);
    assert.match(section.textContent,/馬1 牡4父 キタサンブラック・前走 札幌記念 1着/);
    assert.equal(section.querySelector('[aria-selected="true"]').textContent,'⑤ 過去の1〜3着');
  }finally{dom.window.close();}
});
test('nothing renders when the race has no trend',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only',url:'https://rein.test'});
  try{dom.window.fetch=async()=>({ok:true,json:async()=>({trend:null})});dom.window.eval(bundle.outputFiles[0].text);await new Promise(r=>setTimeout(r,120));
    assert.equal(dom.window.document.querySelector('[data-testid="graded-trends"]'),null);}finally{dom.window.close();}
});
