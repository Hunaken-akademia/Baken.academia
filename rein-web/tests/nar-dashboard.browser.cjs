// Standalone, authenticated-shape fixture. Does not bypass production auth.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {gunzipSync} = require('node:zlib');
const ts = require('typescript');
const web = path.resolve(__dirname, '..');
const output = process.env.NAR_QA_DIR;
if (!output) throw new Error('Set NAR_QA_DIR to the local QA data directory');
function moduleUrl(name, replacements=[]) {
  let source = fs.readFileSync(path.join(web,'lib',name+'.ts'),'utf8');
  for (const [a,b] of replacements) source=source.replace(a,b);
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
  return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
}
async function load(name, replacements=[]) {return import(moduleUrl(name,replacements));}
(async()=>{
  const esbuild = require(require.resolve('esbuild',{paths:[process.env.NAR_QA_ESBUILD || web,process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES]}));
  await esbuild.build({entryPoints:[path.join(__dirname,'nar-dashboard-fixture.tsx')],bundle:true,outfile:path.join(output,'dashboard.js'),platform:'browser',jsx:'automatic',alias:{'@':web},define:{'process.env.NODE_ENV':'"production"'}});
  const css=fs.readdirSync(path.join(web,'.next/static/chunks')).filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join(web,'.next/static/chunks',n),'utf8')).join('\n');
  const {parseNarCard,parseNarSchedule}=await load('nar-source');
  const validationUrl=moduleUrl('nar-validation',[[/from "\.\/marks"/,`from ${JSON.stringify(moduleUrl('marks'))}`]]);
  const {narReferenceSignals}=await import(validationUrl);
  const {narRank}=await load('nar-model',[[/import \{ serverData \} from "\.\/server-snapshots";/,'const serverData=()=>{throw new Error("Offline QA")};'],[/from "\.\/nar-validation"/,`from ${JSON.stringify(validationUrl)}`]]);
  const {selectPicks}=await load('marks');
  const profile=JSON.parse(gunzipSync(fs.readFileSync(path.join(output,'model/nar-history-profile.json.gz'))));
  const report=JSON.parse(fs.readFileSync(path.join(output,'model/report.json')));
  report.live_model.release={id:'nar-full-20260929',validatedRanking:true,selectionYear:2025,auditThrough:'2026-09-27'};
  const card=parseNarCard(fs.readFileSync(path.join(output,'card.html'),'utf8'),'202609281901');
  const horses=narRank({profile,model:report.live_model},card.horses,card.context);
  const venue=parseNarSchedule(fs.readFileSync(path.join(output,'schedule.html'),'utf8'),'2026-09-28','19');
  const signals=narReferenceSignals(horses,report.live_model.conditionValidation,card.context);
  const analysis={...card,horses,race:{...card.race,updated:'10:00',dataTimes:{}},model:{...profile.meta,release:report.live_model.release,provisional:false,probabilityKind:'ranking-share',version:'qa-nar-live',roleModes:{1:'hybrid',2:'hybrid',3:'hybrid'}},prediction:{phase:'prestart',source:'live',generatedAt:'2026-09-28T01:00:00Z'},evaluation:{roleModel:'ready',overall:'ready',tickets:'held',held:[]},capture:{complete:true},picks:signals.picks,pace:{label:'先行候補多め',detail:'暫定・精度未検証',leaders:[1,2]},warnings:['地方専用ハイブリッド。％は評価シェアであり的中確率ではありません。'],confidence:signals.confidence,narReference:signals.reference,tickets:[]};
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push({url:req.url,method:req.method});
    const send=(value,type='application/json')=>{res.setHeader('content-type',type);res.end(type==='application/json'?JSON.stringify(value):value);};
    if(req.url.startsWith('/api/nar/races')) return send({date:'2026-09-28',dateLabel:'9月28日（月）',venues:[venue]});
    if(req.url.startsWith('/api/nar/analyze')) return send(analysis);
    if(req.url.startsWith('/api/nar/race-history')) return send({scope:'server',entries:[],races:0,fromDate:null,throughDate:null,summary:[]});
    if(req.url.startsWith('/api/account-data')) return send({userId:'qa-only',notes:{}});
    if(req.url==='/dashboard.js') return send(fs.readFileSync(path.join(output,'dashboard.js')),'application/javascript');
    if(req.url==='/styles.css') return send(css,'text/css');
    if(req.url.startsWith('/fonts/')&&process.env.NAR_QA_FONTS) {const file=path.join(process.env.NAR_QA_FONTS,req.url.slice('/fonts/'.length));if(fs.existsSync(file))return send(fs.readFileSync(file),file.endsWith('.css')?'text/css':'font/woff2');}
    return send('<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fonts/index.css"><style>body,body *{font-family:"Noto Sans JP",sans-serif!important}body{margin:0;background:#07111f;color:white}</style></head><body><div id="root"></div><script src="/dashboard.js"></script></body></html>','text/html');
  });
  await new Promise(r=>server.listen(8149,'127.0.0.1',r));
  if(process.argv.includes('--server-only')) {console.log('QA http://127.0.0.1:8149');return;}
  const {chromium}=require(require.resolve('playwright',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES]}));
  const browser=await chromium.launch({headless:true,...(process.env.NAR_QA_CHROMIUM?{executablePath:process.env.NAR_QA_CHROMIUM}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    await page.goto('http://127.0.0.1:8149');
    await page.getByRole('button',{name:/NAR 船橋/}).click();
    await page.getByRole('button',{name:/1R Ｃ３四/}).click();
    await page.getByText('地方専用ハイブリッド評価').first().waitFor();
    await page.getByText('地方専用・全量履歴 接続済み').waitFor();
    assert.equal(await page.getByRole('button',{name:'この予想を保存',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'AI1角',exact:true}).count(),0);
    if(analysis.narReference){
      await page.getByText('地方の補正検証・採用／見送り結果',{exact:true}).click();
      await page.getByText(/監査期間：2026/).waitFor();
      assert.ok(await page.getByText(/2026年の[\d,]+レース/).count()>0);
      assert.equal(await page.getByText('地方での検証待ち',{exact:true}).count(),0);
    }
    await page.getByRole('button',{name:'暫定4角',exact:true}).click();
    const measurements=[];
    for(const width of [320,360,390,768,1280]){
      await page.setViewportSize({width,height:900});
      const m=await page.evaluate(()=>{
        const group=document.querySelector('[role="group"][aria-label*="隊列"]');
        const rects=[...group.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return {label:e.textContent,x:r.x,y:r.y,right:r.right,bottom:r.bottom};});
        const overlaps=[];rects.forEach((a,i)=>rects.slice(i+1).forEach(b=>{if(a.x<b.right&&a.right>b.x&&a.y<b.bottom&&a.bottom>b.y)overlaps.push([a.label,b.label]);}));
        return {width:innerWidth,scroll:document.documentElement.scrollWidth,overlaps,tabs:rects.length};
      });
      if(m.scroll>width){console.log(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,20).map(e=>({tag:e.tagName,cls:e.className,text:e.textContent.slice(0,100),right:e.getBoundingClientRect().right}))));await page.screenshot({path:path.join(output,'overflow.png'),fullPage:true});}
      assert.equal(m.scroll,width);assert.deepEqual(m.overlaps,[]);measurements.push(m);
    }
    await page.getByText('全レースの成績と、このレースの保存履歴',{exact:true}).click();
    await page.getByText(/地方競馬のみ.*照合済み 0 レース/).waitFor();
    assert.ok(requests.some(r=>r.url.startsWith('/api/nar/race-history')));
    assert.ok(!requests.some(r=>/^\/api\/(races|analyze|race-history)/.test(r.url)));
    assert.equal(requests.filter(r=>r.method==='POST').length,0);
    assert.deepEqual(errors,[]);
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(output,'nar-mobile.png'),fullPage:true});
    await page.locator('section').filter({has:page.locator('[data-testid="formation-controls"]')}).screenshot({path:path.join(output,'nar-formation-mobile.png')});
    const report={measurements,errors,requests,forecastWrites:0,realProfileRanked:horses.length};
    fs.writeFileSync(path.join(output,'browser-checks.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1);});
