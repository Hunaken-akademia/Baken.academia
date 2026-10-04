import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import ts from 'typescript';
let source=readFileSync(new URL('../../supabase/functions/rein-server-data/index.ts',import.meta.url),'utf8').replace(/^import .*\n/gm,'');
const start=source.indexOf('async function identity('),end=source.indexOf('function checked',start);
source=source.slice(0,start)+'const identity = async () => testIdentity;\n'+source.slice(end);
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2022}}).outputText;
function setup(role='github-nar-analysis'){
 let handler,updated;
 const profile=new Blob(['new-profile']),state=new Blob(['new-state']);
 const sha=blob=>createHash('sha256').update(blob).digest('hex');
 const profileSha=sha('new-profile'),stateSha=sha('new-state'),oldSha='a'.repeat(64);
 const report={profileSha:oldSha,coverage:{date_to:'2026-09-27'},live_model:{roles:{'1':{coef:[1,2]}},release:{auditThrough:'2026-09-27'}}};
 const storage={download:async path=>({data:path.includes('profile-state')?state:profile}),createSignedUrl:async path=>({data:{signedUrl:'https://example.invalid/'+path}}),createSignedUploadUrl:async path=>({data:{signedUrl:'https://example.invalid/'+path}})};
 const client={storage:{from:()=>storage},from:()=>({select:()=>({eq:()=>({single:async()=>({data:{report,activated_at:'old'}})})}),update:value=>{updated=value.report;const chain={eq:()=>chain,select:async()=>({data:[{id:true}]})};return chain;}})};
 new Function('Deno','createClient','createRemoteJWKSet','testIdentity','crypto',code)({env:{get:()=>''},serve:h=>handler=h},()=>client,()=>null,role,webcrypto);
 return {profileSha,stateSha,oldSha,report,get updated(){return updated},call:body=>handler(new Request('https://example.invalid',{method:'POST',body:JSON.stringify(body)}))};
}
test('history publication changes profile pointer while preserving released coefficients and audit coverage',async()=>{
 const s=setup();assert.equal((await s.call({action:'publish-nar-history',previousSha:s.oldSha,profileSha:s.profileSha,stateSha:s.stateSha,meta:{dateTo:'2026-10-04'}})).status,200);
 assert.deepEqual(s.updated.live_model,s.report.live_model);assert.deepEqual(s.updated.coverage,s.report.coverage);assert.equal(s.updated.profileSha,s.profileSha);assert.equal(s.updated.profileRefresh.historyThrough,'2026-10-04');
});
test('stale, backwards or corrupt updates are held; daily downloads are scoped to NAR',async()=>{
 const s=setup();const request={action:'publish-nar-history',previousSha:s.oldSha,profileSha:s.profileSha,stateSha:s.stateSha,meta:{dateTo:'2026-10-04'}};
 assert.equal((await s.call({...request,previousSha:'b'.repeat(64)})).status,409);
 assert.equal((await s.call({...request,meta:{dateTo:'2026-09-20'}})).status,400);
 assert.equal((await s.call({...request,stateSha:'c'.repeat(64)})).status,400);
 assert.equal((await s.call({action:'nar-daily-download',path:'daily/jra/2026/2026-10-04.tar.gz'})).status,400);
 assert.equal((await s.call({action:'nar-daily-download',path:'daily/nar/2026/2026-10-04.tar.gz'})).status,200);
 assert.equal((await setup('production').call(request)).status,400);
});
