import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../../supabase/functions/github-rein-model/index.ts',import.meta.url),'utf8').replace(/^import .*\n/gm,'');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2022}}).outputText;
const repository='Hunaken-akademia/Baken.academia';
function setup(changes={}){
 let handler;
 const model={version:'rein-role-v4-abcdef0',manifest_path:'rein/models/v4/rein-role-v4-abcdef0/manifest.json'};
 const storage={createSignedUrl:async path=>({data:{signedUrl:'https://example.invalid/'+path}}),createSignedUploadUrl:async path=>({data:{path,signedUrl:'https://example.invalid/'+path}})};
 const client={storage:{from:()=>storage},from:()=>({select:()=>({eq:()=>({single:async()=>({data:model})})})})};
 new Function('Deno','createClient','createRemoteJWKSet','jwtVerify',code)({env:{get:k=>k==='SUPABASE_SECRET_KEYS'?'{"default":"test"}':'https://example.invalid'},serve:h=>handler=h},()=>client,()=>null,async()=>({payload:{repository,ref:'refs/heads/main',workflow_ref:repository+'/.github/workflows/rein-role-model-to-supabase.yml@refs/heads/main',...changes}}));
 return body=>handler(new Request('https://example.invalid',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(body)}));
}
test('authorized model workflow can read current immutable bundle and upload only its profile path',async()=>{
 const call=setup();const current=await call({action:'current'});assert.equal(current.status,200);assert.match((await current.json()).bundle_url,/bundle.tar.gz$/);
 assert.equal((await call({action:'sign-upload',path:'rein/models/v4/rein-role-v4-abcdef0/history-profile.json.gz'})).status,200);
 for(const path of ['daily/jra/2026/2026-10-04.tar.gz','rein/models/v4/../../other','nar/profiles/other.gz']) assert.equal((await call({action:'sign-upload',path})).status,400);
});
test('current model read keeps repository, branch and existing workflow authorization boundaries',async()=>{
 for(const change of [{repository:'other/repo'},{ref:'refs/heads/other'},{workflow_ref:repository+'/.github/workflows/other.yml@refs/heads/main'}])assert.equal((await setup(change)({action:'current'})).status,401);
 const augment=setup({workflow_ref:repository+'/.github/workflows/rein-augment-market-model.yml@refs/heads/main'});
 assert.equal((await augment({action:'current'})).status,200);
});
