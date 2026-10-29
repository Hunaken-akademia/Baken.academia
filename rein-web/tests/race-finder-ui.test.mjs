import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const bundle=await build({entryPoints:[path.join(here,'race-finder-fixture.tsx')],bundle:true,write:false,platform:'browser',jsx:'automatic',alias:{'@':path.resolve(here,'..')},define:{'process.env.NODE_ENV':'"production"'}});
const now=Date.now(),row=(id,kind,offset,extra={})=>({raceId:`2026102836${id}`,venue:'門別',number:Number(id),start:'16:20',startsAt:now+offset*60_000,title:`門別 ${Number(id)}R テスト`,course:'ダート',kind,effective:kind==='rough'?7.2:4.1,field:12,favorite:{name:'人気馬',odds:2.4},oddsAt:new Date(now).toISOString(),result:null,verified:true,...extra});
const rows=[row('01','rough',-60,{result:{payout:23450,selection:'3-8-1',popularity:71}}),row('02','rough',-30,{result:{payout:4200,selection:'1-2-5',popularity:9}}),row('03','rough',-20,{verified:false,result:{payout:51200,selection:'9-1-2',popularity:120}}),row('04','rough',40),row('05','solid',50),row('06',null,70),row('07',null,140)];
test('finder lists upcoming races by kind, reviews finished ones with ○✕ and opens a race',async()=>{
  const dom=new JSDOM('<div id="root"></div><p id="opened"></p>',{runScripts:'outside-only',url:'https://rein.test'});
  try{
    dom.window.fetch=async url=>{assert.equal(url,'/api/nar/race-finder');return {ok:true,json:async()=>({date:'2026-10-28',league:'nar',generatedAt:new Date(now).toISOString(),rows})};};
    dom.window.eval(bundle.outputFiles[0].text);
    const tick=()=>new Promise(r=>setTimeout(r,120));await tick();
    const doc=dom.window.document,section=doc.querySelector('[data-testid="race-finder"]');
    const tab=label=>[...section.querySelectorAll('[aria-label="レースの区分"] button')].find(b=>b.textContent.startsWith(label));
    assert.equal(tab('荒れそう').getAttribute('aria-pressed'),'true');
    assert.match(tab('荒れそう').textContent,/荒れそう1$/);
    assert.match(section.querySelector('[data-testid="finder-reference"]').textContent,/3連単万馬券 73.7%（168\/228R）/);
    assert.equal(section.querySelectorAll('[data-testid="finder-list"] li').length,1);
    assert.match(section.querySelector('[data-testid="finder-list"] li').textContent,/門別4R/);
    const pending=section.querySelector('[data-testid="finder-pending"]');
    assert.match(pending.querySelector('summary').textContent,/判定待ちのレース 2R/);
    // Race 6 starts in 70 minutes, inside the 75-minute refresh window.
    assert.match(pending.textContent,/門別6R\s*オッズ集計中/);
    // Race 7 is 140 minutes away: judged from 75 minutes before post.
    const from=new Date(now+65*60_000+9*3600_000).toISOString().slice(11,16);
    assert.ok(pending.textContent.includes(`門別7R${from}ごろから判定`));
    section.querySelector('input[type="checkbox"]').click();await tick();
    assert.equal(section.querySelectorAll('[data-testid="finder-list"] li').length,4);
    assert.match(section.querySelector('[data-testid="finder-review"]').textContent,/○1\s*✕1（50%）/);
    assert.equal(section.querySelectorAll('[data-finder-hit="hit"]').length,1);
    assert.match(section.textContent,/参考外51,200円/);
    tab('固め').click();await tick();
    assert.match(section.querySelector('[data-testid="finder-list"] li').textContent,/門別5R/);
    section.querySelector('[data-testid="finder-list"] li button').click();
    assert.equal(doc.getElementById('opened').textContent,'202610283605');
  }finally{dom.window.close();}
});
