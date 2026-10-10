const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),ts=require('typescript');
const web=path.resolve(__dirname,'..'),output=process.env.JRA_QA_DIR;if(!output)throw new Error('Set JRA_QA_DIR');
function moduleUrl(name){const source=fs.readFileSync(path.join(web,'lib',name+'.ts'),'utf8');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');}
(async()=>{
 const esbuild=require(require.resolve('esbuild',{paths:[process.env.JRA_QA_ESBUILD||web,process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES]}));
 fs.mkdirSync(output,{recursive:true});
 await esbuild.build({entryPoints:[path.join(__dirname,'jra-dashboard-fixture.tsx')],bundle:true,outfile:path.join(output,'dashboard.js'),platform:'browser',jsx:'automatic',alias:{'@':web},define:{'process.env.NODE_ENV':'"production"'}});
 const css=fs.readdirSync(path.join(web,'.next/static/chunks')).filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join(web,'.next/static/chunks',n),'utf8')).join('\n');
 const {jraReferenceForRace}=await import(moduleUrl('jra-reference'));
 const referenceData=JSON.parse(fs.readFileSync(path.join(web,'lib/jra-condition-reference.json'),'utf8'));
 const gradedRace=referenceData.gradedRaces.find(r=>r.editions.filter(e=>e.year<2026).length>=5);
 assert.ok(gradedRace,'annual graded reference must contain at least one five-edition race');
 const latestEdition=gradedRace.editions.filter(e=>e.year<2026).sort((a,b)=>b.date.localeCompare(a.date))[0];
 const fixtureName=gradedRace.name,fixtureVenue=latestEdition.venue;
 const jraReference=jraReferenceForRace(referenceData,{raceName:fixtureName,venue:fixtureVenue,surface:latestEdition.surface,distanceM:latestEdition.distanceM,going:latestEdition.going,year:2026});
 assert.ok(jraReference,'JRA reference data must match fixture');assert.ok(jraReference.graded,'graded trend must match fixture');
 const horses=Array.from({length:12},(_,i)=>({number:i+1,gate:Math.ceil((i+1)/2),name:`検証馬${i+1}`,score:95-i*2,odds:2+i,popularity:i+1,mark:i===0?'◎':i===1?'○':i===5?'☆':'・',style:i<2?'先行':'差し',verdict:i===0?'本命':i===1?'対抗':i===5?'穴候補':`総合${i+1}位`,positives:['検証表示'],cautions:[],firstProbability:.2-i*.005,secondProbability:.15-i*.003,thirdProbability:.12-i*.002,jockey:`検証騎手${i+1}`,historyFactors:[{label:'騎手傾向',samples:100,winRate:12.5,top3Rate:35}],firstSuitability:100-i*4,secondSuitability:95-i*3,thirdSuitability:90-i*2,earlyPosition:i+1,mapPositions:[String(i+1)]}));
 const analysis={jraReference,warnings:[],race:{league:'jra',title:`${fixtureVenue}11R ${fixtureName}`,course:`${latestEdition.surface}${latestEdition.distanceM}m`,condition:latestEdition.going,start:'15:40',updated:'人気・オッズ 15:00取得',raceId:'2606040911',startsAt:Date.parse('2026-10-04T15:40:00+09:00'),dataTimes:{}},prediction:{phase:'prestart',source:'live',generatedAt:'2026-10-04T06:00:00Z',label:'発走前の予想'},evaluation:{roleModel:'ready',overall:'ready',tickets:'ready',held:[]},confidence:null,picks:{status:'ready',main:{number:1,role:'本命',firstRank:1},rival:{number:2,role:'対抗',firstRank:2},longshot:{number:6,role:'穴候補',firstRank:6},longshotCandidates:[{number:6,role:'穴候補',firstRank:6}],longshotStatus:'selected',longshotReason:'検証'},model:{version:'qa',dateFrom:'2019-01-05',dateTo:'2026-09-18',races:26675,runners:368068,horses:43486,strategy:'JRA検証表示',overallPolicy:'検証',markPolicy:'検証'},pace:{label:'先行候補は平均的',detail:'表示検証',leaders:[1,2]},horses,tickets:[]};
 const schedule={dateLabel:'10月4日（日）',updatedAt:new Date().toISOString(),venues:[{name:fixtureVenue,eventId:'qa',nextRace:11,nextStart:'15:40',races:[{number:11,start:'15:40',raceId:'2606040911',title:fixtureName,course:`${latestEdition.surface}${latestEdition.distanceM}m`,status:'次レース'}]}]};
 const jockeyFixture={meta:{league:'jra',dateFrom:'2019-01-01',dateTo:'2026-09-13',starts:480,races:100,jockeys:12,definition:'検証'},profiles:Object.fromEntries(horses.map(h=>[String(h.number),{name:h.jockey,groups:{all:{'':[40,h.number+2,14,18]},venueSurface:{[`${fixtureVenue}|${latestEdition.surface}`]:[40,5,10,14]},venueDistance:{[`${fixtureVenue}|${latestEdition.surface}|${latestEdition.distanceM}`]:[40,5,10,14]},turn:{'右回り':[40,5,10,14]},gate:{'内枠（1〜2）':[40,5,10,14]},surface:{[latestEdition.surface]:[40,5,10,14]},distance:{[String(latestEdition.distanceM)]:[40,5,10,14]},venue:{[fixtureVenue]:[40,5,10,14]}}}]))};
 const server=http.createServer((req,res)=>{const send=(v,t='application/json')=>{res.setHeader('content-type',t+'; charset=utf-8');res.end(t==='application/json'?JSON.stringify(v):v)};if(req.url.endsWith('/jockey-reference'))return send(jockeyFixture);if(req.url.startsWith('/api/races'))return send(schedule);if(req.url.startsWith('/api/analyze'))return send(analysis);if(req.url.startsWith('/api/race-history'))return send({scope:'server',entries:[],races:0,fromDate:null,throughDate:null,summary:[]});if(req.url.startsWith('/api/account-data'))return send({userId:'qa',notes:{}});if(req.url==='/dashboard.js')return send(fs.readFileSync(path.join(output,'dashboard.js')),'application/javascript');if(req.url==='/styles.css')return send(css,'text/css');return send('<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:#07111f;color:white}</style></head><body><div id="root"></div><script src="/dashboard.js"></script></body></html>','text/html')});
 await new Promise(r=>server.listen(8150,'127.0.0.1',r));
 const {chromium}=require(require.resolve('playwright',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES]})),browser=await chromium.launch({headless:true,...(process.env.JRA_QA_CHROMIUM?{executablePath:process.env.JRA_QA_CHROMIUM}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
 try{const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.goto('http://127.0.0.1:8150');await page.getByText(fixtureVenue).first().click();await page.getByText(fixtureName).first().click();await page.getByRole('tab', {name:'予想',exact:true}).waitFor();
 await page.getByTestId('graded-history').waitFor();
 assert.equal(await page.getByTestId('race-replay').count(),0);
 await page.getByTestId('graded-history').getByRole('button',{name:/この年をヒントに展開を比較/}).click();
 assert.equal(await page.getByRole('tab',{name:'展開',exact:true}).getAttribute('aria-selected'),'true');
 await page.getByText('参考にした過去開催',{exact:true}).waitFor();
 await page.getByRole('tab',{name:'予想',exact:true}).click();
 for(const tab of ['展開','馬の詳細','騎手','結果','予想']) {
   await page.getByRole('tab',{name:tab,exact:true}).click();
   assert.equal(await page.getByRole('tab',{name:tab,exact:true}).getAttribute('aria-selected'),'true');
   if(tab==='展開') {
     const explorer=page.getByTestId('pace-explorer');await explorer.waitFor();
     assert.equal(await explorer.locator('tbody tr').count(),12);
     for(const scenario of ['lone','steady','duel','sustain','closers']) {
       await explorer.locator(`[data-scenario="${scenario}"]`).click();
       assert.equal(await explorer.locator(`[data-scenario="${scenario}"]`).getAttribute('aria-pressed'),'true');
       await page.getByTestId('race-replay').getByText(/途中の並びは「/).waitFor();
       await page.getByTestId('formation-controls').getByRole('button',{name:'条件・序盤',exact:true}).waitFor();
     }
     const near=page.getByTestId('replay-scenarios');
     assert.equal(await near.getByRole('button').count(),6);
     await near.locator('[data-replay-scenario="closers"]').click();
     assert.equal(await explorer.locator('[data-scenario="closers"]').getAttribute('aria-pressed'),'true');
     await near.getByText(/基本3位 → 条件1位/).waitFor();
     await page.getByLabel('レースの進行位置').fill('1000');
     await page.getByTestId('race-replay').getByText('候補1',{exact:true}).waitFor();
     await near.locator('[data-replay-scenario="lone"]').click();
     assert.equal(await page.getByLabel('レースの進行位置').inputValue(),'0');
     await explorer.locator('[data-scenario="lone"]').click();
     const leaders=explorer.getByRole('group',{name:'前へ行く馬',exact:true});
     for(const button of await leaders.locator('[aria-pressed="true"]').all()) await button.click();
     await leaders.getByRole('button',{name:'3 検証馬3',exact:true}).click();
     assert.equal(await page.locator('[data-formation-horse]').first().getAttribute('data-formation-horse'),'3');
     await page.getByLabel("レースの進行位置").fill("50");
     await explorer.locator('[data-scenario="steady"]').click();
     assert.equal(await page.getByLabel("レースの進行位置").inputValue(),"0");
     await explorer.locator('[data-scenario="baseline"]').click();
     await page.getByTestId('race-replay').waitFor();await page.getByRole('button',{name:'再生',exact:true}).click();await page.getByRole('button',{name:'一時停止',exact:true}).click();}
   if(tab==='馬の詳細') {await page.getByLabel('詳細を見る馬').selectOption('3');assert.equal(await page.getByTestId('graded-history').count(),0);}
   if(tab==='騎手') {
 await page.setViewportSize({width:390,height:844});
 const wrapper=page.getByRole('table').filter({has:page.getByText('出走馬・騎手の比較（横にスクロール）',{exact:true})}).locator('..');
 await wrapper.evaluate(el=>{el.scrollLeft=0;el.scrollIntoView({block:'start'});});const box=await wrapper.boundingBox();const cdp=await page.context().newCDPSession(page);
 const y=Math.max(20,box.y+100),x=box.x+box.width-35;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-i*30,y}]});await page.waitForTimeout(30);}
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(100);
 assert.ok(await wrapper.evaluate(el=>el.scrollLeft)>0,`native touch scroll moves table ${JSON.stringify(box)}`);
 assert.equal(await page.getByRole('tab',{name:'騎手',exact:true}).getAttribute('aria-selected'),'true');await cdp.detach();await page.setViewportSize({width:1280,height:900});
await page.getByLabel('騎手・馬を検索').fill('検証騎手3');assert.equal(await page.getByRole('tabpanel',{name:'騎手',exact:true}).locator('details').count(),1);await page.getByText('12.5%',{exact:true}).first().waitFor();await page.getByLabel('騎手の集計条件').selectOption('turn');await page.getByText('右回り',{exact:true}).first().waitFor();await page.getByLabel('騎手実績の最低出走数').selectOption('100');await page.getByText('指定した出走数を満たす実績がありません。').waitFor();await page.getByLabel('騎手実績の最低出走数').selectOption('0');await page.getByLabel('騎手・馬を検索').fill('');await page.getByLabel('騎手比較の並べ替え').selectOption('wins');assert.match(await page.getByRole('table').filter({has:page.getByText('出走馬・騎手の比較（横にスクロール）',{exact:true})}).locator('tbody tr').first().innerText(),/12 検証馬12/);await page.getByLabel('騎手・馬を検索').fill('検証騎手3');}
   if(tab==='予想') {const panel=page.getByRole('region',{name:'着順別の穴馬適性'}); for(const role of ['1着','2着','3着']) {await panel.getByRole('button',{name:role+'の穴',exact:true}).click(); await panel.getByLabel('穴馬の人気条件').selectOption('10');assert.equal(await panel.getByRole('button').count(),6);await panel.getByText(role+'適性 全頭中10位',{exact:true}).waitFor();} await panel.getByLabel('穴馬の人気条件').selectOption('4');}
   if(tab==='結果') await page.getByText('確定結果の取得後に、全着順と保存した予想を比較できます。').waitFor();
   for (const width of [320,390,768,1280]) {await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,tab+' width '+width);}
 }
 assert.deepEqual(errors,[]);await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:path.join(output,'rein-tabs-mobile.png'),fullPage:false});
 console.log(JSON.stringify({race:fixtureName,conditions:jraReference.conditions.length,editions:jraReference.graded.editions,errors}));}finally{await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exit(1)});
