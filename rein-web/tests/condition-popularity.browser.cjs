const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const esbuild=require('esbuild');
const {chromium}=require(require.resolve('playwright',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES]}));
const web=path.resolve(__dirname,'..'),out=process.env.REIN_FEATURE_QA_DIR;
if(!out)throw new Error('REIN_FEATURE_QA_DIR required');
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 await esbuild.build({entryPoints:[path.join(__dirname,'condition-popularity-fixture.tsx')],bundle:true,outfile:path.join(out,'app.js'),platform:'browser',jsx:'automatic',alias:{'@':web},define:{'process.env.NODE_ENV':'"production"'}});
 const css=fs.readdirSync(path.join(web,'.next/static/chunks')).filter(f=>f.endsWith('.css')).map(f=>fs.readFileSync(path.join(web,'.next/static/chunks',f),'utf8')).join('\n');
 const server=http.createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(fs.readFileSync(path.join(out,'app.js')));}else{res.setHeader('content-type','text/html');res.end(`<html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{background:#071220}</style><div id="root"></div><script src="/app.js"></script></html>`)}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});
 try{for(const width of [320,390,1280]){
  const page=await browser.newPage({viewport:{width,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
  const matrix=page.getByRole('region',{name:'全頭の適性早見表',exact:true});
  await matrix.getByRole('button',{name:'1 検証馬1・距離 ◎の根拠',exact:true}).click();await matrix.getByRole('status').filter({hasText:'10走・3着内率 60.0%・通算比 +20.0pt'}).waitFor();
  assert.equal(await matrix.getByRole('button',{name:'1 検証馬1・血統 —の根拠',exact:true}).count(),1);
  const region=matrix.getByRole('region',{name:'全頭適性表・横スクロール'});await region.evaluate(e=>e.scrollLeft=500);assert.ok(await region.evaluate(e=>e.scrollLeft)>0);
  await region.evaluate(e=>e.scrollLeft=0);await matrix.getByRole('button',{name:'1 検証馬1の詳細を見る',exact:true}).click();assert.equal(await page.locator('#detail').textContent(),'検証馬1');
  const groups=page.getByRole('region',{name:'人気グループから候補を選ぶ',exact:true});
  for(const n of [10,11,12])await groups.getByRole('button',{name:`Dグループ ${n} 検証馬${n}を候補に追加`,exact:true}).click();
  assert.equal(await groups.getByRole('button',{name:'Dグループ 13 検証馬13を候補に追加',exact:true}).isDisabled(),true);
  await groups.getByRole('button',{name:'Aグループ 1 検証馬1を候補に追加',exact:true}).click();await groups.getByRole('status').filter({hasText:'選んだ候補 4頭'}).waitFor();
  await groups.getByRole('button',{name:'候補をクリア',exact:true}).click();await groups.getByRole('status').filter({hasText:'選んだ候補 0頭'}).waitFor();
  assert.match(await page.getByRole('region',{name:'このレースの人気別決着',exact:true}).innerText(),/A-B-A/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(out,`matrix-${width}.png`)});await page.close();console.log(`PASS ${width}px: matrix, reasons, scroll, group selection cap, result`);
 }}finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
