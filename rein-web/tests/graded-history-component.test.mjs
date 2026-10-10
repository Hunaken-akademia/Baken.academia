import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import ts from 'typescript';
const require=createRequire(import.meta.url),web=fileURLToPath(new URL('..',import.meta.url)),cache=new Map();
function load(file){
 const full=['.tsx','.ts','.json',''].map(ext=>file+ext).find(existsSync);if(!full)throw new Error(`Missing ${file}`);
 if(cache.has(full))return cache.get(full).exports;
 const module={exports:{}};cache.set(full,module);
 if(full.endsWith('.json')){module.exports=JSON.parse(readFileSync(full,'utf8'));return module.exports;}
 const compiled=ts.transpileModule(readFileSync(full,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 new Function('require','module','exports',compiled)(name=>name.startsWith('@/')?load(path.join(web,name.slice(2))):name.startsWith('.')?load(path.resolve(path.dirname(full),name)):require(name),module,module.exports);
 return module.exports;
}
test('past edition launches this year scenario and map/replay stay synchronized',async()=>{
 const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost',pretendToBeVisual:true});
 for(const name of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','CustomEvent','Event'])Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true});
 globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const React=require('react'),{createRoot}=require('react-dom/client'),h=React.createElement;
 const {GradedRaceHistory}=load(path.join(web,'components/graded-race-history')),{PaceScenarioExplorer}=load(path.join(web,'components/pace-scenario-explorer'));
 const reference=load(path.join(web,'lib/jra-condition-reference.json')),flow=load(path.join(web,'lib/jra-graded-flow.json'));
 const {jraReferenceForRace}=load(path.join(web,'lib/jra-reference')),{gradedEditionFlow}=load(path.join(web,'lib/graded-race-flow'));
 const race=reference.gradedRaces.find(r=>r.key==='毎日王冠');assert.ok(race);
 const edition=race.editions.filter(e=>e.year<2026).sort((a,b)=>b.date.localeCompare(a.date))[0];
 const graded=jraReferenceForRace(reference,{raceName:race.name,venue:edition.venue,surface:edition.surface,distanceM:edition.distanceM,going:edition.going,year:2026}).graded;
 const horses=Array.from({length:8},(_,i)=>({number:i+1,gate:i+1,name:`検証馬${i+1}`,style:i<2?'逃げ':i<4?'先行':'差し',earlyPosition:i+1,firstSuitability:100-i*4,secondSuitability:90-i*3,thirdSuitability:80-i*2,positives:[],cautions:[],mapPositions:[String(i+1)],mark:'・'}));
 function Harness(){const [selection,setSelection]=React.useState(null);return selection?h(PaceScenarioExplorer,{key:selection.label,horses,title:'東京11R 毎日王冠',course:'芝1800m',raceId:'2605040911',pace:'標準',league:'jra',roleReady:true,initialScenario:selection.id,historicalContext:selection.label}):h(GradedRaceHistory,{graded,currentYear:2026,onSimulate:(id,label)=>setSelection({id,label})});}
 const root=createRoot(document.getElementById('app'));
 try{
 await React.act(async()=>root.render(h(Harness)));
 const years=[...document.querySelectorAll('[aria-label="過去の重賞開催年"] button')];assert.equal(years.length,5);
 assert.ok(years.every(b=>!b.textContent.includes('2026')));
 const selectedEdition=graded.recent.at(-1);
 await React.act(async()=>years.at(-1).click());
 assert.equal(years.at(-1).getAttribute('aria-pressed'),'true');
 const expected=gradedEditionFlow(flow,graded.name,selectedEdition,2026);
 assert.ok(expected.flow,'selected historical edition must have official passing records');
 assert.ok(expected.flow.laps.length,'selected edition must have measured laps');
 assert.ok(document.querySelector('[data-testid="graded-history"]').textContent.includes(expected.pace.label));
 if(expected.flow){for(const r of expected.flow.runners)assert.ok(document.body.textContent.includes(r.name));}
 const simulate=[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('この年をヒント'));
 await React.act(async()=>simulate.click());
 assert.equal(document.querySelector('[data-testid="graded-history"]'),null);
 assert.equal(document.querySelector(`[data-scenario="${expected.scenario}"]`).getAttribute('aria-pressed'),'true');
 assert.ok(document.body.textContent.includes(`${selectedEdition.year}年 毎日王冠`));
 assert.ok(document.querySelector('[data-testid="race-replay"]'));
 assert.equal(document.querySelector(`[data-replay-scenario="${expected.scenario}"]`).getAttribute('aria-pressed'),'true');
 await React.act(async()=>document.querySelector('[data-replay-scenario="duel"]').click());
 assert.equal(document.querySelector('[data-scenario="duel"]').getAttribute('aria-pressed'),'true');
 assert.equal(document.querySelectorAll('[aria-label="前へ行く馬"] [aria-pressed="true"]').length,2);
 await React.act(async()=>document.querySelector('[data-scenario="lone"]').click());
 assert.equal(document.querySelector('[data-replay-scenario="lone"]').getAttribute('aria-pressed'),'true');
 assert.equal(document.querySelectorAll('[aria-label="前へ行く馬"] [aria-pressed="true"]').length,1);
 }finally{await React.act(async()=>root.unmount());dom.window.close();}
});
