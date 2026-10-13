import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const uri = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const notice = await import(uri(compile('../lib/update-notice.ts')));
let owner = 'account-a', fail = false, writes = 0;
const rows = new Set();
const db = {
  auth: { getClaims: async () => ({ data: { claims: { sub: owner } } }) },
  from: table => {
    assert.equal(table, 'rein_notice_acknowledgements');
    const filters = {};
    const query = { select: () => query, eq: (key, value) => { filters[key] = value; return query; }, maybeSingle: async () => ({ data: rows.has(filters.user_id + ':' + filters.notice_id) ? { notice_id: filters.notice_id } : null, error: fail ? {} : null }) };
    return { ...query, upsert: async (row, options) => { writes++; assert.equal(options.ignoreDuplicates, true); if (!fail) rows.add(row.user_id + ':' + row.notice_id); return { error: fail ? {} : null }; } };
  },
};
globalThis.__noticeDb = db;
let source = compile('../app/api/update-notice/route.ts')
  .replace(/import \{ NextResponse \} from "next\/server";/, 'const NextResponse={json:(body,init)=>Response.json(body,init)};')
  .replace(/import \{ createClient \} from "@\/lib\/supabase\/server";/, 'const createClient=async()=>globalThis.__noticeDb;')
  .replace('"@/lib/update-notice"', JSON.stringify(uri(compile('../lib/update-notice.ts'))));
const api = await import(uri(source));
function request(body, origin = 'https://rein.test') {
  const req = new Request('https://rein.test/api/update-notice', { method: 'POST', headers: { origin }, body: JSON.stringify(body) });
  req.nextUrl = new URL(req.url); return req;
}
test('confirmation persists across reads and repeated clicks, stays scoped to the signed-in account', async () => {
  assert.equal((await (await api.GET()).json()).acknowledged, false);
  const body = { noticeId: notice.UPDATE_NOTICE.id, userId: 'account-b' };
  assert.equal((await api.POST(request(body))).status, 200);
  assert.equal((await api.POST(request(body))).status, 200);
  assert.equal(rows.size, 1);
  assert.equal((await (await api.GET()).json()).acknowledged, true);
  owner = 'account-b';
  assert.equal((await (await api.GET()).json()).acknowledged, false);
  owner = 'account-a';
  assert.equal((await (await api.GET()).json()).acknowledged, true);
});
test('failed persistence is not reported as confirmed; cross-origin and unknown notice writes are rejected', async () => {
  fail = true;
  assert.equal((await api.POST(request({ noticeId: notice.UPDATE_NOTICE.id }))).status, 500);
  fail = false;
  const before = writes;
  assert.equal((await api.POST(request({ noticeId: notice.UPDATE_NOTICE.id }, 'https://other.test'))).status, 403);
  assert.equal((await api.POST(request({ noticeId: 'unknown' }))).status, 400);
  owner = '';
  assert.equal((await api.GET()).status, 401);
  assert.equal((await api.POST(request({ noticeId: notice.UPDATE_NOTICE.id }))).status, 401);
  assert.equal(writes, before);
});
