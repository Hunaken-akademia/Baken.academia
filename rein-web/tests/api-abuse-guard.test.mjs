import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiAbuseGuard, equalSecret, requestBucket } from '../lib/api-abuse-guard.mjs';

const env = { VERCEL_ENV: 'production', SUPABASE_URL: 'https://budget.invalid', SUPABASE_SERVICE_KEY: 'test-server-secret' };
const req = (path = '/api/predict', method = 'POST', headers = {}) => new Request(`https://app.invalid${path}`, { method, headers });
function server(clock) {
  const counts = new Map(), bodies = [];
  let calls = 0;
  return { bodies, get calls() { return calls; }, async fetch(_url, options) {
    calls++;
    const body = JSON.parse(options.body); bodies.push(body);
    assert.equal(options.headers.authorization, 'Bearer test-server-secret');
    const end = (Math.floor(clock.time / 60000) + 1) * 60000;
    const id = `${body.p_application}/${body.p_bucket}/${body.p_identity}/${end}`;
    const limit = body.p_bucket === 'predict' ? 120 : body.p_application === 'wake' ? 600 : 240;
    const used = counts.get(id) || 0, granted = Math.min(body.p_take, Math.max(0, limit - used));
    counts.set(id, used + granted);
    await Promise.resolve();
    return new Response(JSON.stringify({ granted, reset_at_ms: end }));
  } };
}
test('independent instances and concurrent requests share the exact budget', async () => {
  const clock = { time: 60001 }, db = server(clock);
  const guards = Array.from({ length: 6 }, () => createApiAbuseGuard({ application: 'wake', env, now: () => clock.time, fetchImpl: db.fetch }));
  const results = await Promise.all(Array.from({ length: 160 }, (_, i) => guards[i % 6](req(), { clientIp: '203.0.113.8' })));
  assert.equal(results.filter(x => x === null).length, 120);
  assert.equal(results.filter(x => x?.status === 429).length, 40);
  assert.ok(db.calls <= 30, 'leases avoid one DB call per request');
  const before = db.calls;
  for (let i = 0; i < 10; i++) assert.equal((await guards[0](req(), { clientIp: '203.0.113.8' })).status, 429);
  assert.equal(db.calls, before, 'blocked retries do not hit the database');
  clock.time = 120001;
  assert.equal(await guards[0](req(), { clientIp: '203.0.113.8' }), null);
});
test('hashes identities and keeps applications, IPs and members separate', async () => {
  const clock = { time: 60001 }, db = server(clock);
  for (const app of ['wake', 'rein']) {
    const guard = createApiAbuseGuard({ application: app, env, now: () => clock.time, fetchImpl: db.fetch });
    await guard(req(), { clientIp: '203.0.113.9' });
    await guard(req(), { subject: 'verified-member-id' });
  }
  assert.equal(new Set(db.bodies.map(x => x.p_identity)).size, 4);
  for (const body of db.bodies) assert.match(body.p_identity, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(db.bodies).includes('203.0.113.9'));
  assert.ok(!JSON.stringify(db.bodies).includes('verified-member-id'));
});
test('origin, fake credentials and capture headers alone grant no exemption', async () => {
  let calls = 0;
  const guard = createApiAbuseGuard({ application: 'wake', env, isTrustedInternal: r => equalSecret(r.headers.get('x-internal'), 'actual-secret'),
    fetchImpl: async () => { calls++; return new Response('unavailable', { status: 503 }); } });
  const result = await guard(req('/api/yoso', 'GET', { origin: 'https://newhunaken456.vercel.app', authorization: 'Bearer fake', 'x-capture-token': 'fake' }));
  assert.equal(result.status, 503); assert.equal(calls, 1);
  assert.equal(await guard(req('/api/yoso', 'GET', { 'x-internal': 'actual-secret' })), null);
});
test('failure is closed, has retry guidance, and suppresses repeated DB calls', async () => {
  let calls = 0;
  const guard = createApiAbuseGuard({ application: 'rein', env, fetchImpl: async () => { calls++; throw new Error('private secret in upstream failure'); } });
  for (let i = 0; i < 3; i++) {
    const result = await guard(req('/api/analyze', 'GET'), { clientIp: '203.0.113.10' });
    assert.equal(result.status, 503); assert.ok(result.headers.has('retry-after'));
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.ok(!(await result.text()).includes('private secret'));
  }
  assert.equal(calls, 1);
  const missing = createApiAbuseGuard({ application: 'wake', env: { VERCEL_ENV: 'production' } });
  assert.equal((await missing(req())).status, 503);
});
test('preflights, pages and signed-payment route preserve their body and contract', async () => {
  const guard = createApiAbuseGuard({ application: 'wake', env, fetchImpl: () => { throw new Error('unexpected fetch'); } });
  assert.equal(await guard(req('/api/predict', 'OPTIONS')), null);
  assert.equal(await guard(req('/index.html', 'GET')), null);
  const webhook = new Request('https://app.invalid/api/stripe-webhook', { method: 'POST', body: 'original-signature-body' });
  assert.equal(await guard(webhook), null);
  assert.equal(await webhook.text(), 'original-signature-body');
});
test('preview has a bounded fallback while production never falls back', async () => {
  const guard = createApiAbuseGuard({ application: 'wake', env: { VERCEL_ENV: 'preview' } });
  for (let i = 0; i < 120; i++) assert.equal(await guard(req()), null);
  assert.equal((await guard(req())).status, 429);
});
test('a response crossing the window boundary retries without disabling protection', async () => {
  const clock = { time: 119999 }; let calls = 0;
  const guard = createApiAbuseGuard({ application: 'wake', env, now: () => clock.time, fetchImpl: async () => {
    calls++;
    if (calls === 1) { clock.time = 120001; return new Response(JSON.stringify({ granted: 5, reset_at_ms: 120000 })); }
    return new Response(JSON.stringify({ granted: 5, reset_at_ms: 180000 }));
  } });
  assert.equal(await guard(req()), null); assert.equal(calls, 2);
});
test('bucket selection treats internal inference separately and writes more strictly', () => {
  assert.equal(requestBucket(req('/api/predict/')), 'predict');
  assert.equal(requestBucket(req('/api/rein_score')), 'internal');
  assert.equal(requestBucket(req('/api/cron/rein-live', 'GET')), 'internal');
  assert.equal(requestBucket(req('/api/stats', 'GET')), 'read');
  assert.equal(requestBucket(req('/api/account-data', 'POST')), 'write');
  assert.equal(requestBucket(req('/api/premium-login', 'POST')), 'login');
});
