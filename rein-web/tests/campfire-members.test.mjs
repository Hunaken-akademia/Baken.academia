import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCampfireMembers as parse, prepareCampfireImport as prepare, paidMonthEnd } from '../lib/campfire-members.mjs';
import { createPreviewToken, verifyPreviewToken } from '../lib/campfire-preview.mjs';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const accessCode = ts.transpileModule(readFileSync(new URL('../lib/rein-access.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { hasActiveReinAccess, canAccessReinArea } = await import('data:text/javascript;base64,' + Buffer.from(accessCode).toString('base64'));
const bytes = s => new TextEncoder().encode(s);
const csv = (status='退会申請中', month='202609', plan='REIN 地方競馬プラン') => bytes('支援ID,備考,メールアドレス,メンバー特典,メンバーステータス,最終決済月\n1,Google: user@example.com,other@example.com,'+plan+','+status+','+month);
const members = (...args) => parse(csv(...args)).members;
const now = new Date('2026-09-28T00:00:00Z');
const record = (...args) => prepare(members(...args), [], now).records[0];
test('actual Shift_JIS Campfire export with header only reads as zero members', () => {
 const source = readFileSync(new URL('./fixtures/campfire-empty-shift-jis.csv', import.meta.url));
 const parsed = parse(source);
 assert.equal(parsed.members.length, 0);
 assert.deepEqual(parsed.counts, { nar: 0, jra: 0, all: 0, active: 0, cancelled: 0 });
});
test('WAKE headers prioritize remarks Google email and exclude generated column', () => {
 const r=record(); assert.equal(r.google_email,'user@example.com'); assert.equal(r.member_key,'campfire:1');
 assert.equal(r.access_ends_at,'2026-09-30T15:00:00.000Z'); assert.ok(!('normalized_email' in r));
});
for (const [name,plan] of [['地方競馬','nar'],['中央競馬','jra'],['オール','all']]) {
 test(plan+' keeps paid access until exactly next month JST midnight',()=>{
 const r=record('解約','202609','REIN '+name+'プラン');assert.equal(r.plan,plan);
 const before=new Date('2026-09-30T14:59:59.999Z'),end=new Date('2026-09-30T15:00:00Z');
 assert.equal(hasActiveReinAccess(r,before),true);assert.equal(hasActiveReinAccess(r,end),false);
 for(const area of ['nar','jra']) { assert.equal(canAccessReinArea(r,area,before),plan==='all'||plan===area); assert.equal(canAccessReinArea(r,area,end),false); }
 });
}
test('December rollover and leap year use Japan timezone',()=>{
 assert.equal(paidMonthEnd('202612'),'2026-12-31T15:00:00.000Z');
 assert.equal(paidMonthEnd('2024-02'),'2024-02-29T15:00:00.000Z');
 for(const v of ['202613','202600','bad']) assert.equal(paidMonthEnd(v),null);
});
test('repeat import never extends scheduled end and old file stays expired',()=>{
 const r=record(); assert.equal(prepare(members('退会','202610'),[r],now).records[0].access_ends_at,r.access_ends_at);
 assert.equal(hasActiveReinAccess(prepare(members(),[],new Date('2026-11-01')).records[0],new Date('2026-11-01')),false);
});
test('missing paid month blocks new cancellation but preserves existing deadline',()=>{
 assert.throws(()=>record('退会',''));assert.equal(prepare(members('退会',''),[record()],now).records[0].access_ends_at,record().access_ends_at);
});
test('rejoin clears scheduled cancellation',()=>{const r=prepare(members('active'),[record()],now).records[0]; assert.equal(r.status,'active');assert.equal(r.access_ends_at,null);});
test('manual memberships protected and email change relinks auth identity',()=>{
 const r=record();assert.equal(prepare(members(),[{...r,member_key:'rein-friend-1'}],now).records.length,0);
 const changed=members();changed[0].google_email='new@example.com';const result=prepare(changed,[{...r,auth_user_id:'old-user'}],now).records[0];assert.equal(result.member_key,r.member_key);assert.equal(result.auth_user_id,null);
 assert.throws(()=>prepare(changed,[r,{...r,member_key:'campfire:2',google_email:'new@example.com'}],now));
});
test('unknown, missing status and malformed CSV rejected',()=>{
 assert.throws(()=>parse(csv('unknown')));assert.throws(()=>parse(bytes('email,plan\na@example.com,nar')));
 assert.throws(()=>parse(bytes('email,plan,status\n"a@example.com,nar,active')));
 assert.throws(()=>parse(bytes('email,plan,status\na@example.com,nar,active\na@example.com,jra,active')));
 assert.equal(record('inactive').status,'cancelled');assert.equal(record('paused').status,'cancelled');
});
test('invalid dates, missing cancellation end and paused fail closed',()=>{
 const r=record();for(const override of [{access_ends_at:'invalid'},{access_ends_at:null},{access_starts_at:'invalid'},{status:'paused'}]) assert.equal(hasActiveReinAccess({...r,...override},now),false);
});
test('signed preview bound to user, contents and ten minute lifetime',()=>{
 const token=createPreviewToken('key','admin','snapshot',1000);
 assert.equal(verifyPreviewToken(token,'key','admin','snapshot',1001),true);
 for(const args of [[token,'key','other','snapshot',1001],[token,'key','admin','changed',1001],[token,'key','admin','snapshot',601000],['','key','admin','snapshot',1001]]) assert.equal(verifyPreviewToken(...args),false);
});
