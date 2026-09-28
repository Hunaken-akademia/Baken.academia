import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
async function load(file, replacements=[]){let s=readFileSync(new URL(file,import.meta.url),'utf8');for(const [a,b]of replacements)s=s.replace(a,b);const code=ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));}
const {narRaceKey,narUrl,narVenueCodes,parseNarSchedule,parseNarCard,parseNarResult}=await load('../lib/nar-source.ts');
const {narHistoryInputs,narRank,validateNarModel}=await load('../lib/nar-model.ts',[[/import \{ serverData \} from "\.\/server-snapshots";/,'const serverData=()=>{throw new Error("No network in ranker tests")};']]);
const {expireNarReleaseMetas}=await load('../lib/nar-release.ts');
const entry=(number,gate,info='',market='')=>`<tr class="tBorder">${gate?`<td class="courseNum course_0${gate}">${gate}</td>`:''}<td class="horseNum">${number}</td><a class="horseName" href="/HorseMarkInfo?k_lineageLoginCode=${number}">馬${number}</a><a class="jockeyName" href="/RiderMark?k_riderLicenseNo=2">騎手（所属）</a><td class="odds_weight">${market}</td><table><tr><td>全</td><td>10-9-8-7</td></tr></table><td class="odds_weight">470<br>(-2)</td><td>1:12.3　2-3-4　38.5</td><td class="info">${info}</td></tr>`;
const card=(entries)=>`<h4>2026年9月28日（月） 船 橋 第1競走 14:40発走</h4><section class="raceTitle"><h3>出走表テスト</h3><ul class="dataArea"><li>ダート 1200ｍ（左） 天候：晴 馬場：良</li></ul></section><section class="cardTable"><table>${entries}</table></section>`;
test('NAR identity validates dates/venue, cannot overlap Yahoo JRA IDs',()=>{
 assert.equal(narRaceKey('2606040911'),null);assert.equal(narRaceKey('202613281901'),null);assert.equal(narRaceKey('202602311901'),null);assert.equal(narRaceKey('202609289901'),null);assert.equal(narRaceKey('202609281913'),null);
 assert.deepEqual(narRaceKey('202609281901'),{date:'2026-09-28',code:'19',number:1,venue:'船橋'});
 assert.equal(new URL(narUrl('DebaTable','2026-09-28','03',1)).searchParams.get('k_babaCode'),'3');
});
test('schedule excludes adjacent-date links and respects venue namespace',()=>{
 const html='<title>TodayRaceInfo</title><a href="/KeibaWeb/TodayRaceInfo/RaceList?k_raceDate=2026%2F09%2F28&amp;k_babaCode=19">船橋</a><a href="/KeibaWeb/TodayRaceInfo/RaceList?k_raceDate=2026%2F09%2F27&amp;k_babaCode=11">水沢</a>';
 assert.deepEqual(narVenueCodes(html,'2026-09-28'),['19']);assert.throws(()=>narVenueCodes('<title>エラー</title>','2026-09-28'));
 const schedule=parseNarSchedule('<tr class="data"><td>1R</td><td>14:40</td><td></td><td></td><td>テスト</td><td>左1200m</td></tr>','2026-09-28','19');
 assert.equal(schedule.races[0].raceId,'202609281901');assert.equal(schedule.races[0].status,'発売前');
});
test('nested card, rowspan gates, missing markets, scratches and real passing cells',()=>{
 const r=parseNarCard(card(entry(1,7,'','<span>3.4</span> (2人気)')+entry(2,0)+entry(3,8,'出走取消')),'202609281901');
 assert.equal(r.horses.length,2);assert.equal(r.horses[1].gate,7);assert.equal(r.horses[0].odds,3.4);assert.equal(r.horses[1].odds,null);assert.equal(r.horses[1].popularity,0);assert.equal(r.horses[0].weightChange,-2);
 assert.deepEqual(r.horses[0].mapPositions,['2-3-4']);assert.deepEqual(r.scratched,[{number:3,name:'馬3'}]);assert.equal(r.race.startsAt,Date.parse('2026-09-28T14:40:00+09:00'));
 assert.throws(()=>parseNarCard(card(entry(1,1)+entry(1,1)),'202609281901'));
 assert.throws(()=>parseNarCard(card(entry(1,1)),'202609281902'));
 assert.throws(()=>parseNarCard(card(entry(1,1)),'202509281901'));
 assert.throws(()=>parseNarCard(card(entry(1,1)),'202609281101'));
});
test('result popularity uses exact class o, not gate; cancelled runners separate',()=>{
 const row=(n,finish)=>`<tr class="tBorder"><td class="a">${finish}</td><td class="b courseNum">8</td><td class="c">${n}</td><td class="horseName">馬${n}</td><td class="o popularNum">2</td><td class="p">3.4</td></tr>`;
 const r=parseNarResult(`<section class="gradeTable">${row(1,1)+row(2,'取消')}</section><div class="twoRefundTable"><tr><td class="title">単勝</td><td class="a">1</td><td class="refundMoney">340円</td><td class="c">2人気</td></tr></div>`);
 assert.equal(r.isFinished,true);assert.equal(r.finishers[0].popularity,2);assert.deepEqual(r.scratched,[2]);assert.equal(r.payouts[0].payout,340);assert.equal(parseNarResult('').isFinished,false);
 assert.throws(()=>parseNarResult(`<h4>2025年9月28日 船橋 第1競走</h4><section class="gradeTable">${row(1,1)}</section>`,'202609281901'));
});
const profile={meta:{dateTo:'2026-08-31'},horse:{'1':{n:2,w:2.5/22,t:6.5/22,f:2}},horseSurface:{},horseDistance:{},horseCourse:{},jockey:{},trainer:{},gate:{},horseRecent5:{}};
const context={date:'2026-09-28',racecourse:'船橋',surface:'ダート',distanceM:1200};
const horse=(number)=>({horseId:String(number),jockeyId:'2',trainerId:'3',gate:1,number,name:`馬${number}`,odds:null,popularity:0});
const model={roles:Object.fromEntries([1,2,3].map(t=>[String(t),{mode:'relative',intercept:0,coef:Array.from({length:28},(_,i)=>i===1?1:0)}]))};
test('NAR feature defaults and population-independent relative ranking are finite',()=>{
 const input=narHistoryInputs(profile,horse(1),context);assert.equal(input.values.length,28);assert.equal(input.values[1],2.5/22);assert.equal(input.values[3],2/18);assert.equal(input.values[7],.5);
 const scored=narRank({profile,model},[horse(1),horse(2)],context);
 assert.equal(scored[0].number,1);assert.equal(scored[0].firstSuitability,100);assert.ok(Math.abs(scored.reduce((s,h)=>s+h.firstProbability,0)-1)<1e-12);
 assert.equal(scored[0].probabilityKind,'ranking-share');assert.ok(scored[0].parameterFactors[0].impact>0);
 assert.throws(()=>narRank({profile,model},[horse(1)],{...context,date:'2026-08-31'}));
 assert.deepEqual(narRank({profile,model},[horse(2),horse(3)],context).map(h=>h.firstSuitability),[50,50]);
});
test('NAR form ranks are independent of current popularity and odds',()=>{
 const first=narRank({profile,model},[horse(1),horse(2)],context);
 const second=narRank({profile,model},[{...horse(1),popularity:12,odds:999},{...horse(2),popularity:1,odds:1.1}],context);
 assert.deepEqual(first.map(h=>h.firstProbability),second.map(h=>h.firstProbability));
});
test('released hybrid coefficients must be finite and match each feature vector',()=>{
 const valid={version:'nar-history-ranker-v1',features:Array(28).fill('test'),roles:Object.fromEntries([1,2,3].map(t=>[String(t),{mode:'hybrid',intercept:0,coef:Array(56).fill(0)}]))};
 assert.doesNotThrow(()=>validateNarModel(valid));
 for(const mutate of [m=>m.roles['2'].coef.pop(),m=>m.roles['1'].coef[0]=NaN,m=>m.roles['3'].intercept=Infinity,m=>m.roles['1'].mode='unknown',m=>m.version='unknown',m=>m.features.pop()]){
  const bad=structuredClone(valid);mutate(bad);assert.throws(()=>validateNarModel(bad));
 }
 const ranked=narRank({profile,model:{...valid,release:{validatedRanking:true}}},[horse(1),horse(2)],context);
 assert.equal(ranked[0].verdict,'地方専用ハイブリッド評価');
 assert.equal(ranked[0].probabilityKind,'ranking-share');
});
test('model rollout refreshes future NAR forecasts only, preserving JRA and past audits',()=>{
 const now=Date.parse('2026-09-29T00:00:00Z'),activation='2026-09-28T22:00:00Z';
 const old={generatedAt:'2026-09-28T21:00:00Z',startsAt:now+3600000,final:false,preview:false};
 const entries=[['live:202609291901',old],['preview:202609301901',{...old,preview:true}],['live:2606040911',old],['live:202609291902',{...old,startsAt:now}],['live:202609281901',{...old,final:true}],['live:202609291903',{...old,generatedAt:activation}],['live:202609291904',{...old,startsAt:null}]];
 const metas=new Map(entries);expireNarReleaseMetas(metas,activation,now);
 assert.deepEqual([...metas.keys()],entries.slice(2).map(([k])=>k));
 const invalid=new Map(entries);expireNarReleaseMetas(invalid,'invalid',now);assert.equal(invalid.size,entries.length);
});
