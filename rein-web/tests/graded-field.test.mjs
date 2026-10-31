import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile=n=>ts.transpileModule(readFileSync(new URL(`../lib/${n}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const uri=c=>'data:text/javascript;base64,'+Buffer.from(c).toString('base64');
const trends=uri(compile('graded-trends'));
const {checkItems,checklist,longshots,popularityReach,runnerBuckets,speedTable}=await import(uri(compile('graded-field').replace('"./graded-trends"',JSON.stringify(trends))));
// 人気別: 23 placed of 141 runners, baseline 16.3%; strong = 20.4% or more with 5+ runners.
const trend={editions:7,sections:[
  {title:'人気別',note:'',rows:[{label:'1番人気',record:[5,1,1,0]},{label:'10番人気以下',record:[0,0,1,60]},{label:'4〜6番人気',record:[2,5,8,58]}]},
  {title:'上がり3ハロンの順位',note:'',rows:[{label:'上がり1位',record:[3,2,2,1]},{label:'上がり2〜3位',record:[3,3,2,8]},{label:'上がり6位以下',record:[1,2,3,80]}]},
  {title:'前走の格',note:'',rows:[{label:'前走G1',record:[5,3,4,20]},{label:'前走G3以下',record:[0,0,0,16]}]},
  {title:'前走からの間隔',note:'',rows:[{label:'中10週以上',record:[5,4,4,30]},{label:'中4週以内',record:[1,1,1,40]}]},
  {title:'年齢',note:'',rows:[{label:'4歳',record:[3,3,3,20]},{label:'7歳以上',record:[0,0,0,17]}]},
  {title:'騎手との相性',note:'',rows:[{label:'初コンビ',record:[1,1,2,30]}]},
],results:[{year:2024,rows:[{finish:1,popularity:2},{finish:2,popularity:9},{finish:3,popularity:8}]},{year:2025,rows:[{finish:1,popularity:1},{finish:2,popularity:3},{finish:3,popularity:12}]}]};
const run=(date,name,grade,finish,rank,corner,jockey='11')=>[date,name,grade,finish,rank,corner,jockey];
const horse=(number,popularity,age,runs,extra={})=>({number,name:`馬${number}`,popularity,age,sex:'牡',gate:1,weight:490,jockeyId:'11',jockey:'騎手A ',recent:{g1:0,runs},parameterFactors:[{label:'騎手相性',samples:3,record:'1-1-0-1',impact:0}],...extra});
const horses=[
  horse(1,1,4,[run('2026-06-28','宝塚記念','G1',2,1,4),run('2026-04-05','大阪杯','G1',1,2,3)]),
  horse(2,9,4,[run('2026-08-17','札幌記念','G2',3,3,6),run('2026-06-01','安田記念','G1',5,1,9)]),
  horse(3,12,7,[run('2026-10-05','毎日王冠','G2',8,9,2,'99'),run('2026-08-01','3勝クラス','',1,1,1,'99')],{parameterFactors:[{label:'騎手相性',samples:0,record:'0-0-0-0',impact:0}]}),
];
test('runner buckets use only pre-race facts and match trend labels',()=>{
  const b=runnerBuckets(horses[0],'2026-11-01');
  assert.equal(b['前走の格'],'前走G1');assert.equal(b['前走からの間隔'],'中10週以上');assert.equal(b['年齢'],'4歳');
  assert.equal(b['騎手'],'前走と同じ騎手');assert.equal(b['騎手との相性'],'4戦目以上');assert.equal(b['上がり3ハロンの順位'],'近5走で上がり3位以内');
  const c=runnerBuckets(horses[2],'2026-11-01');
  assert.equal(c['前走の格'],'前走G2');assert.equal(c['前走からの間隔'],'中4週以内');assert.equal(c['騎手'],'乗り替わり');assert.equal(c['騎手との相性'],'初コンビ');
  assert.equal(runnerBuckets({number:9,name:'x',popularity:1},'2026-11-01')['前走の格'],null);
});
test('checklist columns are strong pre-race buckets, highest rate first',()=>{
  // 上がり1位+2〜3位 15/24, 前走G1 12/32, 4歳 9/29, 中10週以上 13/43; 初コンビ 4/34 is below the bar.
  const items=checkItems(trend);
  assert.deepEqual(items.map(i=>i.label),['近5走で上がり3位以内','前走G1','4歳','中10週以上']);
  const {rows}=checklist(trend,horses,'2026-11-01');
  // Horse 3 has a 上がり1位 in a 3勝クラス race among its last runs.
  assert.deepEqual(rows.map(r=>r.count),[4,3,1]);
});
test('speed table stars by graded average; longshots need popularity 5+ and two matches',()=>{
  const table=speedTable(horses);
  assert.deepEqual(table.map(r=>[r.horse.number,r.gradedAvg,r.top3,r.star]),[[1,1.5,2,true],[2,2,2,true],[3,null,1,false]]);
  const picks=longshots(trend,horses,'2026-11-01');
  assert.deepEqual(picks.map(p=>p.horse.number),[2]);
  assert.match(picks[0].reasons[0],/傾向チェック3項目（上がり3位内・4歳・中10週以上）/);
  assert.match(picks[0].reasons[2],/騎手Aとは1-1-0-1/);
  assert.deepEqual(popularityReach(trend),[2,9,12]);
});
