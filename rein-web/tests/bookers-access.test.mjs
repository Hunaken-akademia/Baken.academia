import test from 'node:test';
import assert from 'node:assert/strict';
import {
  articleText, displayCode, ensureMonthlyCodes, generateCode, jstMonth, memberPostFields,
  normalizeCode, redeemCode, validUntilFor, MAX_FAILED_ATTEMPTS_PER_HOUR,
} from '../lib/bookers-access.mjs';

const NOW = Date.parse('2026-11-20T03:00:00Z');
const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'Member@Example.com' };

function fakeDb({ codes = [], memberships = [], attempts = [], posts = [] } = {}) {
  const state = { codes, memberships, attempts, posts, redemptions: [], patches: [], inserts: [] };
  const params = (path) => new URLSearchParams(path.split('?')[1] || '');
  return {
    state,
    async get(path) {
      const q = params(path);
      if (path.startsWith('/rest/v1/rein_bookers_code_attempts')) return state.attempts.filter(a => !a.ok && `eq.${a.user_id}` === q.get('user_id'));
      if (path.startsWith('/rest/v1/rein_bookers_access_codes')) {
        if (q.get('code')) return state.codes.filter(c => `eq.${c.code}` === q.get('code'));
        return state.codes.filter(c => `eq.${c.plan}` === q.get('plan') && `eq.${c.month}` === q.get('month') && !c.retired_at);
      }
      if (path.startsWith('/rest/v1/rein_bookers_code_posts')) return state.posts;
      if (path.startsWith('/rest/v1/rein_memberships')) return state.memberships.filter(m => m.auth_user_id === USER.id || m.google_email === USER.email.toLowerCase());
      throw new Error(`unexpected get ${path}`);
    },
    async post(path, body) {
      if (path.startsWith('/rest/v1/rein_bookers_code_attempts')) { state.attempts.push({ ...body }); return null; }
      if (path.startsWith('/rest/v1/rein_bookers_redemptions')) { state.redemptions.push(body); return null; }
      if (path.startsWith('/rest/v1/rein_bookers_access_codes')) { const row = { id: `code-${state.codes.length}`, ...body }; state.codes.push(row); return [row]; }
      if (path.startsWith('/rest/v1/rein_memberships')) { state.inserts.push(body); state.memberships.push(body); return null; }
      throw new Error(`unexpected post ${path}`);
    },
    async patch(path, body) {
      state.patches.push({ path, body });
      if (path.startsWith('/rest/v1/rein_memberships')) {
        const key = decodeURIComponent(params(path).get('member_key').slice(3));
        const row = state.memberships.find(m => m.member_key === key);
        Object.assign(row, body);
      }
      if (path.startsWith('/rest/v1/rein_bookers_access_codes')) {
        const id = params(path).get('id').slice(3);
        Object.assign(state.codes.find(c => c.id === id), body);
      }
      return null;
    },
  };
}

const code = (plan, extra = {}) => ({ id: `id-${plan}`, plan, month: '2026-11', code: plan === 'nar' ? 'ABCDEFGH' : plan === 'jra' ? 'JJJJKKKK' : 'ALLLPLAN', valid_until: validUntilFor('2026-11'), retired_at: null, ...extra });

test('month boundaries follow Japan time', () => {
  assert.equal(jstMonth(new Date('2026-11-30T15:00:00Z')), '2026-12');
  assert.equal(jstMonth(new Date('2026-11-30T14:59:59Z')), '2026-11');
  assert.equal(validUntilFor('2026-11'), '2026-11-30T15:00:00.000Z');
  assert.equal(validUntilFor('2026-12'), '2026-12-31T15:00:00.000Z');
});

test('codes are 8 unambiguous characters and input variations are accepted', () => {
  const c = generateCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(normalizeCode('ａｂｃｄ－ｅｆｇｈ '), 'ABCDEFGH');
  assert.equal(displayCode('abcdefgh'), 'ABCD-EFGH');
});

test('member article shows the code, the deadline and the REIN link', () => {
  const text = articleText({ plan: 'jra', month: '2026-11', code: 'ABCDEFGH', validUntil: validUntilFor('2026-11') });
  assert.match(text, /# ABCD-EFGH/);
  assert.match(text, /11月30日まで/);
  assert.match(text, /rein-web\.vercel\.app/);
  const fields = memberPostFields('all', { month: '2026-11', code: 'ABCDEFGH', validUntil: validUntilFor('2026-11') });
  assert.equal(fields.price, 50000);
  assert.equal(fields.category, 2);
  assert.doesNotMatch(fields.description, /ABCD/);
});

test('a new BOOKERS member gets access until the first of next month', async () => {
  const db = fakeDb({ codes: [code('nar')] });
  const result = await redeemCode({ user: USER, code: 'abcd-efgh' }, { db, now: NOW });
  assert.equal(result.status, 'granted');
  assert.equal(result.plan, 'nar');
  const row = db.state.inserts[0];
  assert.equal(row.member_key, `bookers:${USER.id}`);
  assert.equal(row.google_email, 'member@example.com');
  assert.equal(row.access_ends_at, '2026-11-30T15:00:00.000Z');
  assert.equal(row.status, 'active');
  assert.equal(db.state.redemptions.length, 1);
});

test('wrong, retired and expired codes are rejected and counted', async () => {
  const db = fakeDb({ codes: [code('nar', { retired_at: '2026-11-10T00:00:00Z' }), code('jra', { valid_until: '2026-11-01T00:00:00Z' })] });
  assert.equal((await redeemCode({ user: USER, code: 'ZZZZZZZZ' }, { db, now: NOW })).status, 'invalid');
  assert.equal((await redeemCode({ user: USER, code: 'ABCDEFGH' }, { db, now: NOW })).status, 'invalid');
  assert.equal((await redeemCode({ user: USER, code: 'JJJJKKKK' }, { db, now: NOW })).status, 'invalid');
  assert.equal(db.state.attempts.filter(a => !a.ok).length, 3);
  assert.equal(db.state.inserts.length, 0);
});

test('too many failed attempts are limited', async () => {
  const attempts = Array.from({ length: MAX_FAILED_ATTEMPTS_PER_HOUR }, () => ({ user_id: USER.id, ok: false }));
  const db = fakeDb({ codes: [code('nar')], attempts });
  assert.equal((await redeemCode({ user: USER, code: 'ABCDEFGH' }, { db, now: NOW })).status, 'limited');
});

test('an active CAMPFIRE member with a covering plan is left unchanged', async () => {
  const campfire = { member_key: 'campfire:1', google_email: 'member@example.com', auth_user_id: USER.id, plan: 'all', status: 'active', access_starts_at: '2026-10-01T00:00:00Z', access_ends_at: null };
  const db = fakeDb({ codes: [code('jra')], memberships: [campfire] });
  const result = await redeemCode({ user: USER, code: 'JJJJKKKK' }, { db, now: NOW });
  assert.equal(result.status, 'already');
  assert.equal(db.state.patches.length, 0);
  assert.equal(campfire.member_key, 'campfire:1');
});

test('a cancelled CAMPFIRE member moving to BOOKERS is re-keyed so CSV imports no longer overwrite it', async () => {
  const campfire = { member_key: 'campfire:2', google_email: 'member@example.com', auth_user_id: USER.id, plan: 'nar', status: 'cancelled', access_starts_at: '2026-10-01T00:00:00Z', access_ends_at: '2026-11-01T00:00:00Z' };
  const db = fakeDb({ codes: [code('jra')], memberships: [campfire] });
  const result = await redeemCode({ user: USER, code: 'JJJJKKKK' }, { db, now: NOW });
  assert.equal(result.status, 'granted');
  assert.equal(campfire.member_key, `bookers:${USER.id}`);
  assert.equal(campfire.plan, 'jra');
  assert.equal(campfire.status, 'active');
  assert.equal(campfire.access_ends_at, '2026-11-30T15:00:00.000Z');
});

test('an active member entering a second area code gets both areas', async () => {
  const db = fakeDb({ codes: [code('nar'), code('jra')] });
  await redeemCode({ user: USER, code: 'ABCDEFGH' }, { db, now: NOW });
  const result = await redeemCode({ user: USER, code: 'JJJJKKKK' }, { db, now: NOW + 1000 });
  assert.equal(result.plan, 'all');
  assert.equal(db.state.memberships.length, 1);
});

test('monthly codes are created once and written to the member article', async () => {
  const updates = [];
  const bookers = { configured: true, async updatePostText(uuid, text) { updates.push({ uuid, text }); } };
  const db = fakeDb({ posts: [{ plan: 'nar', post_uuid: 'a0bfc2c7-fb4f-43c9-85fb-eb31fe7ed25c' }] });
  const first = await ensureMonthlyCodes({ db, bookers, now: NOW });
  assert.equal(first.month, '2026-11');
  assert.equal(db.state.codes.length, 3);
  assert.equal(updates.length, 1);
  assert.match(updates[0].text, new RegExp(displayCode(db.state.codes[0].code)));
  const second = await ensureMonthlyCodes({ db, bookers, now: NOW + 3600_000 });
  assert.equal(db.state.codes.length, 3);
  assert.equal(updates.length, 1);
  assert.ok(second.results.every(r => !r.created));
});

test('a BOOKERS failure is recorded and retried next run', async () => {
  let fail = true;
  const bookers = { configured: true, async updatePostText() { if (fail) throw new Error('BOOKERS 500'); } };
  const db = fakeDb({ posts: [{ plan: 'all', post_uuid: 'a0bfc2c7-fb4f-43c9-85fb-eb31fe7ed25c' }] });
  const first = await ensureMonthlyCodes({ db, bookers, now: NOW, plans: ['all'] });
  assert.equal(first.results[0].error, 'BOOKERS 500');
  fail = false;
  const second = await ensureMonthlyCodes({ db, bookers, now: NOW + 1000, plans: ['all'] });
  assert.equal(second.results[0].synced, true);
});
