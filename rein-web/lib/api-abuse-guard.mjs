import { createHmac, timingSafeEqual } from 'node:crypto';

// Database grants small leases atomically. A cold start or another region cannot
// reset the shared allowance. Local leases avoid a database round-trip per request.
export const API_LIMITS = Object.freeze({
  wake: { predict: 120, read: 600, write: 60, login: 30, internal: 120 },
  rein: { predict: 120, read: 240, write: 60, login: 30, internal: 120 },
});
const WINDOW_MS = 60_000;
const LEASE_SIZE = 5;
const MAX_ENTRIES = 5_000;

export function equalSecret(supplied, expected) {
  if (!expected || !supplied) return false;
  const a = Buffer.from(String(supplied)), b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requestBucket(request) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  if (/^\/api\/(?:cron(?:[-/]|$)|internal\/|rein_score$)/.test(path)) return 'internal';
  if (/^\/api\/predict(?:-|$)/.test(path) || /^\/api\/(?:nar\/)?analyze(?:\/|$)/.test(path)) return 'predict';
  if (path === '/api/premium-login') return 'login';
  return ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'read' : 'write';
}

function refusal(status, seconds, app) {
  return new Response(JSON.stringify({
    ok: false,
    error: status === 429
      ? '短時間のアクセス回数が多いため、少し待ってから再度お試しください。'
      : 'アクセス保護を確認しています。少し待ってから再度お試しください。',
  }), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'retry-after': String(Math.max(1, Math.ceil(seconds))),
    'x-api-protection': `${app}-shared-v1`,
  } });
}

export function createApiAbuseGuard({ application, env = process.env,
  fetchImpl = globalThis.fetch, now = Date.now, isTrustedInternal = (_request) => false }) {
  if (!API_LIMITS[application]) throw new Error('Unknown application');
  const leases = new Map(), pending = new Map();
  let unavailableUntil = 0;
  function remember(key, lease) {
    if (leases.size >= MAX_ENTRIES && !leases.has(key)) {
      for (const [id, value] of leases) if (value.resetAt <= now()) leases.delete(id);
      if (leases.size >= MAX_ENTRIES) leases.delete(leases.keys().next().value);
    }
    leases.set(key, lease);
  }
  return async function protect(request, { clientIp = 'unknown', subject = '' } = {}) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return null;
    // Webhooks retain their own signature verification. Never consume or rewrite
    // their raw body. Ordinary callers cannot acquire an internal exemption merely
    // by adding an Origin, User-Agent, Authorization or capture header.
    if (request.method === 'OPTIONS' ||
      (application === 'wake' && url.pathname === '/api/stripe-webhook' && request.method === 'POST') ||
      (!subject && await isTrustedInternal(request))) return null;
    const bucket = requestBucket(request);
    const limit = API_LIMITS[application][bucket];
    const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
    const base = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL ||
      (application === 'rein' ? 'https://dcewdzagnomcnvteokwj.supabase.co' : '')).replace(/\/$/, '');
    // No user address or access token is stored. The keyed hash cannot be reversed
    // by enumerating the IPv4 address space without the server secret.
    const identity = createHmac('sha256', secret || 'local-preview-only')
      .update(`${application}\n${bucket}\n${subject ? `member:${subject}` : `ip:${clientIp}`}`).digest('hex');
    const key = `${bucket}:${identity}`;
    if (!secret || !base) {
      if (env.VERCEL_ENV === 'production') return refusal(503, 10, application);
      // Preview has no production service key. Keep a local protective ceiling;
      // production never falls back to an instance-local allowance.
      let local = leases.get(key);
      if (!local || local.resetAt <= now()) {
        local = { remaining: limit, resetAt: now() + WINDOW_MS };
        remember(key, local);
      }
      if (local.remaining-- > 0) return null;
      return refusal(429, (local.resetAt - now()) / 1_000, application);
    }
    let staleResponses = 0;
    for (;;) {
      const lease = leases.get(key);
      if (lease && lease.resetAt > now()) {
        if (lease.remaining > 0) { lease.remaining--; return null; }
        if (lease.blocked) return refusal(429, (lease.resetAt - now()) / 1_000, application);
      }
      if (unavailableUntil > now()) return refusal(503, (unavailableUntil - now()) / 1_000, application);
      if (pending.has(key)) { await pending.get(key); continue; }
      const work = (async () => {
        try {
          const response = await fetchImpl(`${base}/rest/v1/rpc/reserve_api_budget_v1`, {
            method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(2_000),
            headers: { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
            body: JSON.stringify({ p_application: application, p_bucket: bucket, p_identity: identity, p_take: LEASE_SIZE }),
          });
          if (!response.ok) throw new Error('budget service unavailable');
          const value = await response.json();
          const grant = Number(value?.granted), resetAt = Number(value?.reset_at_ms);
          if (!Number.isInteger(grant) || grant < 0 || grant > LEASE_SIZE ||
            !Number.isFinite(resetAt) || resetAt > now() + WINDOW_MS + 5_000) {
            throw new Error('invalid budget response');
          }
          // A response can cross a window boundary in transit. Retry in the new
          // window without treating this normal timing race as a service outage.
          if (resetAt <= now()) {
            if (++staleResponses > 1) throw new Error('expired budget response');
            leases.delete(key);
            return;
          }
          remember(key, { remaining: grant, resetAt, blocked: grant === 0 });
        } catch {
          // Do not expose secrets or upstream response bodies. Briefly stop costly
          // work instead of silently removing the limit during a database outage.
          unavailableUntil = now() + 5_000;
        }
      })();
      pending.set(key, work);
      await work;
      pending.delete(key);
    }
  };
}
