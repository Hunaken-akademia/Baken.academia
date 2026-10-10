import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../lib/jra-reference.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {gradedHistoryForRace,jraReferenceForRace,jraRaceNameKey,jraConditionKey}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const metric={samples:100,hits:40,rate:.4};
const period={races:100,winners:100,favoriteWinner:metric,top3PopularityWinner:{...metric,rate:.8},tenPlusWinner:{...metric,rate:.02},frontWinner:{samples:80,hits:32,rate:.4}};
const data={version:'jra-condition-reference-v1',periods:{selection:'2025',audit:'2026'},coverage:{dateFrom:'2019-01-01',dateTo:'2026-09-18',races:1000,racecourses:10},conditions:[
 {kind:'course',key:'中山|芝',selection:period,audit:period},{kind:'courseDistance',key:'中山|芝|short',selection:period,audit:period},{kind:'courseGoing',key:'中山|芝|良',selection:period,audit:period}],gradedRaces:[{key:'スプリンターズS',name:'スプリンターズステークス',grades:['G1'],editions:Array.from({length:8},(_,i)=>({date:`${2018+i}-09-30`,year:2018+i,venue:i===2?'新潟':'中山',grade:'G1',surface:'芝',distanceM:1200,going:'良',fieldSize:16,winnerPopularity:i%3+1,winnerGate:4,winnerFirstCorner:i%5+1,placedPopularities:[1,3,i===1?10:5],placedFirstCorners:[1,4,7]}))}],limitations:[]};
test('JRA keys normalize grade names and distance boundaries',()=>{
 assert.equal(jraRaceNameKey('第60回 スプリンターズステークス（ＧⅠ）'),'スプリンターズS');
 assert.equal(jraRaceNameKey('スプリンターズステークス'),jraRaceNameKey('スプリンターズS'));
 assert.equal(jraRaceNameKey('東京優駿（日本ダービー）'),jraRaceNameKey('東京優駿'));
 assert.equal(jraRaceNameKey('日本ダービー'),jraRaceNameKey('東京優駿'));
 assert.notEqual(jraRaceNameKey('天皇賞（春）'),jraRaceNameKey('天皇賞（秋）'));
 assert.equal(jraConditionKey('中山','芝',1400,'良','courseDistance'),'中山|芝|mile');
});
test('JRA reference uses only prior editions and exact conditions',()=>{
 const result=jraReferenceForRace(data,{raceName:'第60回 スプリンターズステークス（GⅠ）',venue:'中山',surface:'芝',distanceM:1200,going:'良',year:2026});
 assert.equal(result.conditions.length,3);assert.match(result.conditions[0].detail,/2026年の100レース/);
 assert.equal(result.graded.editions,8);assert.equal(result.graded.yearTo,2025);assert.equal(result.graded.recent.length,5);assert.equal(result.graded.venueChanges,true);
 const noLeak=jraReferenceForRace(data,{raceName:'スプリンターズステークス',venue:'中山',surface:'芝',distanceM:1200,going:'良',year:2023});
 assert.equal(noLeak.graded.editions,5);assert.equal(noLeak.graded.yearTo,2022);
});

test('saved-card titles with unparenthesized grades resolve without embedded references',()=>{
 const actual=JSON.parse(readFileSync(new URL('../lib/jra-condition-reference.json',import.meta.url),'utf8'));
 for(const title of ['京都11R 京都大賞典 GII','京都１１Ｒ 京都大賞典 ＧⅡ','京都11R 第61回 京都大賞典（GⅡ）']){
  const history=gradedHistoryForRace(actual,{league:'jra',title,raceId:'2608040111'});
  assert.equal(history.graded.name,'京都大賞典');assert.equal(history.currentYear,2026);
  assert.ok(history.graded.recent.every(e=>e.year<2026));
 }
 const old=gradedHistoryForRace(actual,{league:'jra',title:'京都11R 京都大賞典 GII',raceId:'2508040111'});
 assert.ok(old.graded.recent.every(e=>e.year<2025));
 assert.equal(gradedHistoryForRace(actual,{league:'nar',title:'京都11R 京都大賞典 GII',raceId:'2608040111'}),null);
 assert.equal(gradedHistoryForRace(actual,{league:'jra',title:'京都11R 未勝利',raceId:'2608040111'}),null);
 assert.equal(gradedHistoryForRace(actual,{league:'jra',title:'京都大賞典予選 GII',raceId:'2608040111'}),null);
 assert.equal(gradedHistoryForRace(actual,{league:'jra',title:'京都大賞典 GII',raceId:'invalid'}),null);
 for(const race of actual.gradedRaces){
  const h=gradedHistoryForRace(actual,{league:'jra',title:`京都11R ${race.name} ${race.grades[0]}`,raceId:'2608040111'});
  assert.equal(h?.graded.name,race.name);
 }
});

test('all 140 official series resolve, including Ireland and year-specific name reuse',()=>{
 const actual=JSON.parse(readFileSync(new URL('../lib/jra-condition-reference.json',import.meta.url),'utf8'));
 const catalog=JSON.parse(readFileSync(new URL('../lib/jra-graded-catalog.json',import.meta.url),'utf8'));
 assert.equal(catalog.races.length,140);assert.equal(catalog.failures.length,0);
 assert.equal(actual.gradedRaces.length,140);
 const lookup=(title,year=2026)=>gradedHistoryForRace(actual,{title,raceId:`${String(year).slice(-2)}05040111`}).graded;
 assert.equal(lookup('デイリー杯2歳ステークス GII').name,'デイリー杯2歳S');
 assert.equal(lookup('報知杯弥生賞ディープインパクト記念 GII').name,'弥生賞');
 assert.equal(lookup('読売マイラーズカップ GII').name,'マイラーズC');
 const ireland=lookup('東京11R アイルランドトロフィー GII');
 assert.equal(ireland.name,'アイルランドT');assert.equal(ireland.editions,7);
 assert.ok(ireland.recent.some(e=>e.officialName.includes('府中牝馬')));
 assert.ok(ireland.recent.every(e=>e.distanceM===1800&&e.venue==='東京'));
 assert.equal(lookup('府中牝馬S',2024).name,'アイルランドT');
 assert.ok(lookup('府中牝馬S').recent.some(e=>e.officialName==='マーメイドS'));
 assert.ok(lookup('愛知杯').recent.every(e=>e.distanceM===1400));
 assert.ok(lookup('愛知杯',2024).recent.every(e=>e.distanceM===2000));
 assert.ok(lookup('プロキオンS').recent.every(e=>e.distanceM===1800));
 assert.ok(lookup('東海S').recent.some(e=>e.distanceM===1400));
 const newRace=lookup('しらさぎステークス GIII');
 assert.equal(newRace.editions,1);assert.equal(newRace.favoriteWinRate,null);
});
