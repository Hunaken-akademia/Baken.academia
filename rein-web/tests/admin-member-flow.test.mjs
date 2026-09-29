import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ADMIN_MEMBERS_PATH, loginDestination, safeNextPath } from '../lib/rein-auth-navigation.mjs';

const dataModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const transpile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const fileModule = path => new URL(path, import.meta.url).href;
const mocks = {
  'next/server': dataModule('export const NextResponse = { json: (data, init) => Response.json(data, init) };'),
  '@/lib/supabase/server': dataModule('export const createClient = async () => ({ auth: { getClaims: async () => ({data: {claims: globalThis.__reinImportTest.claims}}) } });'),
  '@supabase/supabase-js': dataModule('export const createClient = () => globalThis.__reinImportTest.admin;'),
  '@/lib/supabase/config': dataModule('export const SUPABASE_URL = "https://test.invalid";'),
  '@/lib/rein-admin': dataModule(transpile(readFileSync(new URL('../lib/rein-admin.ts', import.meta.url), 'utf8'))),
  '@/lib/rein-welcome-email.mjs': dataModule('export const sendReinWelcomeEmail = async args => { const state=globalThis.__reinImportTest; state.sends.push(args); if(state.mailFails) throw new Error("test send failed"); return "test-message-id"; };'),
  ...Object.fromEntries(['campfire-members','campfire-preview','campfire-import-preview'].map(name => [`@/lib/${name}.mjs`,fileModule(`../lib/${name}.mjs`)])),
};
let source = transpile(readFileSync(new URL('../app/api/admin/members/import/route.ts', import.meta.url),'utf8'));
for (const [name,url] of Object.entries(mocks)) source = source.replaceAll(JSON.stringify(name), JSON.stringify(url));
const { POST } = await import(dataModule(source));

const email = 'test-member@example.com';
function setup() {
  process.env.REIN_ADMIN_EMAILS='test-admin@example.com';
  process.env.SUPABASE_SERVICE_ROLE_KEY='test-service-key';
  process.env.RESEND_API_KEY='test-resend-key';
  const state={claims:{sub:'admin-test-id',email:'test-admin@example.com'},members:[],outbox:[],sends:[],writes:0,mailFails:false};
  function query(table) {
    const rows = table==='rein_memberships' ? state.members : state.outbox;
    let predicates=[], operation='select', payload, options={}, single=false;
    const builder={
      select(){return builder}, in(k,v){predicates.push(r=>v.includes(r[k]));return builder},
      eq(k,v){predicates.push(r=>r[k]===v);return builder}, limit(){return builder},
      upsert(data,opts={}){operation='upsert';payload=data;options=opts;return builder},
      update(data){operation='update';payload=data;return builder}, maybeSingle(){single=true;return builder},
      then(resolve,reject){return Promise.resolve().then(()=>{
        let selected=rows.filter(r=>predicates.every(p=>p(r)));
        if(operation==='upsert') {
          state.writes++;
          for(const item of Array.isArray(payload)?payload:[payload]) {
            const found=rows.find(r=>r.member_key===item.member_key);
            if(found && options.ignoreDuplicates) continue;
            const saved={...item};
            if(table==='rein_memberships') saved.normalized_email=item.google_email;
            if(found) Object.assign(found,saved); else rows.push(saved);
          }
          selected=[];
        } else if(operation==='update') { state.writes++; selected.forEach(row=>Object.assign(row,payload)); }
        return {data:single?(selected[0]||null):selected.map(r=>({...r})),error:null};
      }).then(resolve,reject)},
    };
    return builder;
  }
  state.admin={from:query,rpc:async()=>({data:true,error:null})};
  globalThis.__reinImportTest=state;
  return state;
}
function request(mode='preview',token='',csv=`ユーザー名,備考,特典内容,メンバーステータス,最終決済月\nTestMember,${email},中央競馬（JRA）版,有効,202609`,origin='https://rein.invalid') {
  const body=new FormData();body.set('file',new File([csv],'test.csv'));body.set('mode',mode);if(token)body.set('previewToken',token);
  const req=new Request('https://rein.invalid/api/admin/members/import',{method:'POST',body,headers:{origin}});
  req.nextUrl=new URL(req.url);return req;
}
async function apply(csv) {
  const preview=await POST(request('preview','',csv));assert.equal(preview.status,200);
  const info=await preview.json();
  const response=await POST(request('apply',info.previewToken,csv));assert.equal(response.status,200);
  return response.json();
}

test('admin destination survives OAuth without accepting an external redirect',()=>{
  assert.equal(loginDestination(null,ADMIN_MEMBERS_PATH),ADMIN_MEMBERS_PATH);
  assert.equal(loginDestination('/jra',undefined),'/jra');
  for(const value of ['https://evil.invalid','//evil.invalid','/\\evil.invalid','/\nevil.invalid',null]) assert.equal(safeNextPath(value),'/');
  assert.equal(loginDestination(null,'https://evil.invalid'),'/');
});
test('unauthenticated, non-admin and cross-origin imports cannot read or write members',async()=>{
  const s=setup();s.claims=null;assert.equal((await POST(request())).status,401);
  s.claims={sub:'member',email};assert.equal((await POST(request())).status,403);
  assert.equal((await POST(request('apply','','x','https://evil.invalid'))).status,403);
  assert.equal(s.writes,0);assert.equal(s.sends.length,0);
});
test('preview shows recipient and plan, and apply without confirmation never writes',async()=>{
  const s=setup();const preview=await (await POST(request())).json();
  assert.equal(preview.rows[0].email,email);assert.equal(preview.rows[0].plan,'jra');assert.equal(preview.rows[0].action,'new');
  assert.equal(s.writes,0);assert.equal(s.sends.length,0);
  assert.equal((await POST(request('apply'))).status,409);assert.equal(s.writes,0);
});
test('registration saves the member then automatically sends; repeated CSV skips sent mail',async()=>{
  const s=setup();const first=await apply();
  assert.equal(first.imported,1);assert.equal(first.emailSent,1);assert.equal(first.rows[0].emailStatus,'sent');
  assert.equal(s.members[0].plan,'jra');assert.equal(s.outbox[0].status,'sent');
  assert.equal(s.sends[0].email,email);
  const again=await apply();assert.equal(again.emailSent,0);assert.equal(again.emailSkipped,1);assert.equal(s.sends.length,1);
});
test('an already registered member with pending welcome mail is sent on the next import',async()=>{
  const s=setup();s.members.push({member_key:'campfire:TestMember',google_email:email,normalized_email:email,status:'active',access_starts_at:'2026-08-31T15:00:00Z',access_ends_at:null,updated_at:'2026-09-29T00:00:00Z'});
  s.outbox.push({member_key:'campfire:TestMember',recipient_email:email,status:'pending'});
  const r=await apply();assert.equal(r.rows[0].action,'update');assert.equal(r.emailSent,1);assert.equal(s.members.length,1);
});
test('mail failure keeps registration and is retried after preview',async()=>{
  const s=setup();s.mailFails=true;const failed=await apply();
  assert.equal(failed.imported,1);assert.equal(failed.emailFailed,1);assert.equal(failed.rows[0].emailStatus,'failed');assert.equal(s.members.length,1);
  s.mailFails=false;const retry=await apply();assert.equal(retry.emailSent,1);assert.equal(s.outbox[0].status,'sent');
});
test('manual members and cancellations do not receive welcome emails',async()=>{
  const s=setup();s.members.push({member_key:'friend-test',google_email:email,normalized_email:email,status:'active'});
  const protectedResult=await apply();assert.equal(protectedResult.imported,0);assert.equal(protectedResult.rows[0].action,'protected');assert.equal(s.sends.length,0);
  setup();const cancelled=await apply(`ユーザー名,備考,特典内容,メンバーステータス,最終決済月\nTestMember,${email},中央競馬（JRA）版,退会,202609`);
  assert.equal(cancelled.imported,1);assert.equal(cancelled.rows[0].emailStatus,'not_applicable');assert.equal(globalThis.__reinImportTest.sends.length,0);
});
