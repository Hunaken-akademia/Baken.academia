import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const uri=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const compile=name=>ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const core=uri(compile('odds-trends').replace(/import catalog from "\.\/odds-trend-catalog.json";/,`const catalog=${readFileSync(new URL('../lib/odds-trend-catalog.json',import.meta.url),'utf8')};`));
const boardCode=compile('odds-trend-board').replace('"./odds-trends"',JSON.stringify(core)).replace('"./nar-source"',JSON.stringify(uri(compile('nar-source'))));
const board=await import(uri(boardCode));

test('schedule races keep only venue rules for their own venue and are ordered by post time',()=>{
  const jra=board.scheduledBoardRaces('2026-10-18','jra',[
    {number:11,start:'15:40',raceId:'2606040311',title:'メイン',course:'ダ1800m'},
    {number:1,start:'9:50',raceId:'2607040301',title:'未勝利',course:'芝1600m'},
    {number:2,start:'10:20',raceId:'bad',title:'壊れた行'},
  ]);
  assert.deepEqual(jra.map(r=>[r.raceId,r.venue]),[['2607040301','中京'],['2606040311','中山']]);
  const ids=race=>race.rules.map(r=>r.id);
  assert.ok(ids(jra[1]).includes('odds90-2026101701')&&ids(jra[1]).includes('odds90-43158'));
  assert.ok(!ids(jra[1]).includes('odds90-46606')&&!ids(jra[1]).includes('odds90-683'));
  assert.ok(ids(jra[0]).includes('odds90-46606'));
  assert.ok(jra.every(race=>race.rules.every(r=>r.league==='jra')));
  assert.equal(jra[0].startsAt,Date.parse('2026-10-18T09:50:00+09:00'));
});
test('NAR board only lists venues that have a NAR condition',()=>{
  const nar=board.scheduledBoardRaces('2026-10-18','nar',[
    {number:3,start:'15:05',raceId:'202610180303',title:'ばんえい'},
    {number:3,start:'15:10',raceId:'202610182003',title:'大井'},
    {number:1,start:'15:00',raceId:'2606040301',title:'JRA形式のID'},
  ]);
  assert.deepEqual(nar.map(r=>[r.raceId,r.venue,r.rules.map(x=>x.id)]),[['202610180303','帯広',['odds90-2537']]]);
});
test('tickets are looked up only within 75 minutes of post time, and only ready selections count',()=>{
  const now=Date.parse('2026-10-18T12:00:00+09:00');
  assert.equal(board.needsLookup(now+75*60_000,now),true);
  assert.equal(board.needsLookup(now+76*60_000,now),false);
  assert.equal(board.needsLookup(now-3600_000,now),true);
  assert.equal(board.needsLookup(null,now),true);
  const race={items:[{ruleId:'odds90-683',state:'ready',selections:[{numbers:[3],odds:25}]},{ruleId:'odds90-7354',state:'ready',selections:[]},{ruleId:'odds90-6337',state:'waiting',selections:[]}]};
  assert.deepEqual(board.readyItems(race).map(i=>i.ruleId),['odds90-683']);
});
test('board server reuses per-race lookups near post time and skips far races without fetching',async()=>{
  const now=Date.parse('2026-10-18T12:00:00+09:00'),realNow=Date.now;Date.now=()=>now;
  const hm=t=>new Date(t+9*3600_000).toISOString().slice(11,16),date='2026-10-18',near=now+10*60_000,far=now+5*3600_000;
  const lookups=[];const store=new Map();
  globalThis.__boardQA={
    getCache:()=>({get:async k=>store.get(k),set:async(k,v)=>store.set(k,v)}),
    dateJst:()=>date,
    serverData:async(action,params)=>{assert.equal(action,'schedule');assert.equal(params.league,'jra');return {schedule:{payload:{venues:[{races:[{number:1,start:hm(near),raceId:'2604040301',title:'新潟1R'},{number:12,start:hm(far),raceId:'2604040312',title:'新潟12R'}]}]}}};},
    getOddsTrends:async(raceId,league)=>{lookups.push([raceId,league]);return {phase:'provisional',items:[{ruleId:'odds90-683',state:'ready',selections:[{numbers:[5],odds:31.2}],fetchedAt:new Date(now).toISOString()}]};},
    mapWithConcurrency:async(items,_n,worker)=>Promise.all(items.map(worker)),
  };
  const code=compile('odds-trend-board-server')
    .replace(/import \{[^;]+\} from "next\/server";/,'const NextResponse={json:(b,i)=>Response.json(b,i)};')
    .replace(/import \{[^;]+\} from "@vercel\/functions";/,'const {getCache}=globalThis.__boardQA;')
    .replace(/import \{[^;]+\} from "\.\/server-snapshots";/,'const {dateJst,serverData}=globalThis.__boardQA;')
    .replace(/import \{[^;]+\} from "\.\/odds-trends-server";/,'const {getOddsTrends}=globalThis.__boardQA;')
    .replace(/import \{[^;]+\} from "\.\/rein-live";/,'const {mapWithConcurrency}=globalThis.__boardQA;')
    .replace('"./odds-trends"',JSON.stringify(core)).replace('"./odds-trend-board"',JSON.stringify(uri(boardCode)));
  const server=await import(uri(code));
  try{
  const [a,b]=await Promise.all([server.getOddsTrendBoard('jra'),server.getOddsTrendBoard('jra')]);
  assert.equal(a,b);
  assert.deepEqual(lookups,[['2604040301','jra']]);
  assert.equal(a.races[0].phase,'provisional');assert.equal(a.races[0].items[0].selections[0].odds,31.2);
  assert.equal(a.races[1].phase,'scheduled');assert.ok(a.races[1].items.length>0&&a.races[1].items.every(i=>i.state==='waiting'));
  assert.ok(a.races[1].items.some(i=>i.ruleId==='odds90-683')&&!a.races[1].items.some(i=>i.ruleId==='odds90-46606'));
  await server.getOddsTrendBoard('jra');assert.equal(lookups.length,1,'cached for a minute');
  }finally{Date.now=realNow;}
});
