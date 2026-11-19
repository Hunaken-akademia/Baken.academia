// BOOKERS（bookers.tech）会員の「合言葉」方式の利用権付与。WAKE（newhunaken456 の lib/bookers-access.js）と同じ仕組み。
// BOOKERS には加入・解約を知らせる Webhook や会員一覧 API が無いため、各プランの会員限定記事に「今月の合言葉」を載せ、
// 会員が REIN で入力すると rein_memberships に利用権が付く。合言葉は毎月1日（日本時間）に作り直し、記事も API で書き換える。
// 利用権は翌月1日0時に切れ、続けている会員は記事で新しい合言葉を見て入れ直す。解約した人は記事が読めないので止まる。
import crypto from "node:crypto";
import { REIN_OPEN_CHAT_CODE, REIN_OPEN_CHAT_URL } from "./rein-welcome-email.mjs";

export const BOOKERS_PLANS = ["nar", "jra", "all"];
export const MAX_FAILED_ATTEMPTS_PER_HOUR = 10;
export const BOOKERS_MEMBER_PREFIX = "bookers:";
const REIN_URL = "https://rein-web.vercel.app/";
const CONTACT_EMAIL = "hunaken.akademia@gmail.com";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 0/O・1/I など見間違えやすい字は使わない

const LABELS = { nar: "REIN 地方競馬", jra: "REIN 中央競馬", all: "REIN オール" };
const RANGES = { nar: "地方競馬", jra: "中央競馬", all: "中央競馬・地方競馬の両方" };

export function planLabel(plan) {
  return LABELS[plan] || plan;
}

// 日本時間の「YYYY-MM」
export function jstMonth(now = new Date()) {
  const d = new Date(now.getTime() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// その月の合言葉で付く利用権の期限：翌月1日0時（日本時間）。猶予なし（WAKE と同じ）。
export function validUntilFor(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1, -9, 0, 0)).toISOString();
}

export function generateCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

// 入力のゆれ（全角・小文字・ハイフン・空白）を吸収して8文字にそろえる
export function normalizeCode(value) {
  return String(value || "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function displayCode(code) {
  const c = normalizeCode(code);
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function jstDateLabel(iso) {
  const d = new Date(Date.parse(iso) + 9 * 3600 * 1000 - 1000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

// 会員限定記事の有料部分（マークダウン）
export function articleText({ plan, month, code, validUntil }) {
  const [, m] = month.split("-").map(Number);
  return [
    `## ${m}月のREIN合言葉（${planLabel(plan)}）`,
    "",
    `# ${displayCode(code)}`,
    "",
    `この合言葉で使えるのは **${jstDateLabel(validUntil)}まで** です。`,
    "",
    "## 使い方",
    `1. [REINを開く](${REIN_URL}) からREINを開いて、Googleでログインします。`,
    "2. 「BOOKERSでご加入の方」の欄に、上の合言葉を入れて「合言葉で利用開始」を押します。",
    `3. すぐにREIN（${RANGES[plan]}）が使えるようになります。`,
    "",
    "## リンク",
    `- REIN：[${REIN_URL}](${REIN_URL})`,
    `- 会員オープンチャット「馬券アカデミア」：[参加する](${REIN_OPEN_CHAT_URL})　参加コード **${REIN_OPEN_CHAT_CODE}**`,
    "",
    "今後のお知らせや更新情報は、主にオープンチャットでご案内します。",
    "",
    "## 毎月の更新",
    "合言葉は毎月1日0時に新しくなり、その時点で前の月の合言葉での利用は止まります。月が変わったら、この記事で新しい合言葉を確かめて、もう一度入れてください。",
    "",
    "※合言葉とオープンチャットの参加コードは、ご本人だけでお使いください。ほかの人に教えないでください。",
    "",
    "## お問い合わせ",
    `合言葉が使えない・ログインできないなど、お困りのことがあれば ${CONTACT_EMAIL} までお問い合わせください。`,
  ].join("\n");
}

// 会員以外が単品で買うと翌月以降の合言葉も読めてしまうため、単品価格は上限にしておく（会員はメンバーシップで無料で読める）。
export const MEMBER_POST_PRICE = 50000;

export function memberPostFields(plan, { month, code, validUntil }) {
  return {
    title: `【${planLabel(plan)}会員専用】REIN合言葉（毎月1日更新）`,
    category: 2,
    description: [
      `BOOKERS「${planLabel(plan)}」メンバーシップ会員専用の記事です。会員の方は無料で読めます。`,
      "",
      "この先に、REIN（馬券アカデミアの競馬AI予想ツール）を使うための今月の合言葉があります。",
      "合言葉は毎月1日0時に新しくなります。",
      "",
      "※この記事を単品で購入する必要はありません。メンバーシップにご加入ください。",
      "",
      `お問い合わせ：${CONTACT_EMAIL}`,
    ].join("\n"),
    text: articleText({ plan, month, code, validUntil }),
    price: MEMBER_POST_PRICE,
  };
}

const covers = (have, want) => have === "all" || have === want;
const mergePlan = (a, b) => (a === b ? a : "all");

function isActive(row, now) {
  if (!row || !BOOKERS_PLANS.includes(row.plan)) return false;
  if (row.status !== "active" && !(row.status === "cancelled" && row.access_ends_at)) return false;
  if (Date.parse(row.access_starts_at) > now) return false;
  return !row.access_ends_at || Date.parse(row.access_ends_at) > now;
}

export function createServiceDb({ url, key, fetchImpl = (...a) => fetch(...a) }) {
  async function request(path, { method = "GET", body, prefer } = {}) {
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;
    const r = await fetchImpl(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(15000) });
    const text = await r.text().catch(() => "");
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 200)}`);
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }
  return {
    get: (path) => request(path),
    post: (path, body, prefer = "return=representation") => request(path, { method: "POST", body, prefer }),
    patch: (path, body) => request(path, { method: "PATCH", body, prefer: "return=representation" }),
  };
}

export async function recentFailedAttempts(userId, { db, now = Date.now() }) {
  const since = new Date(now - 3600 * 1000).toISOString();
  const rows = await db.get(`/rest/v1/rein_bookers_code_attempts?select=id&user_id=eq.${userId}&ok=eq.false&at=gte.${encodeURIComponent(since)}&limit=${MAX_FAILED_ATTEMPTS_PER_HOUR + 1}`);
  return Array.isArray(rows) ? rows.length : 0;
}

// 合言葉を使って REIN の利用権を付ける。戻り値の status：
//  granted … 利用権を付けた／延ばした   already … CAMPFIRE など別の経路で同等以上の利用権がある（変更しない）
//  invalid … 合言葉が違う・期限切れ     limited … 短時間に何度も間違えた
export async function redeemCode({ user, code }, { db, now = Date.now() }) {
  const email = normalizeEmail(user?.email);
  if (!user?.id || !email) throw Object.assign(new Error("Googleログイン情報を確認できませんでした。"), { status: 401 });
  if (await recentFailedAttempts(user.id, { db, now }) >= MAX_FAILED_ATTEMPTS_PER_HOUR) return { status: "limited" };

  const normalized = normalizeCode(code);
  const rows = normalized.length === 8
    ? await db.get(`/rest/v1/rein_bookers_access_codes?select=id,plan,month,valid_until,retired_at&code=eq.${normalized}&limit=1`)
    : [];
  const found = Array.isArray(rows) ? rows[0] : null;
  const usable = Boolean(found && !found.retired_at && Date.parse(found.valid_until) > now);
  await db.post("/rest/v1/rein_bookers_code_attempts", { user_id: user.id, ok: usable }, "return=minimal");
  if (!usable) return { status: "invalid" };

  const { plan, month } = found;
  const validUntil = found.valid_until;
  const nowIso = new Date(now).toISOString();
  const memberKey = `${BOOKERS_MEMBER_PREFIX}${user.id}`;

  const existingRows = await db.get(`/rest/v1/rein_memberships?select=member_key,plan,status,access_starts_at,access_ends_at&or=(auth_user_id.eq.${user.id},normalized_email.eq.${encodeURIComponent(email)})&limit=2`);
  const list = Array.isArray(existingRows) ? existingRows : [];
  if (list.length > 1) throw new Error("同じ利用者に会員情報が2件あります。");
  const existing = list[0] || null;
  const active = isActive(existing, now);
  const fromBookers = Boolean(existing?.member_key?.startsWith(BOOKERS_MEMBER_PREFIX));

  // CAMPFIRE や手動登録で、このプランを含み期限も同じか長い利用権がすでにある → 何も変えない
  if (existing && !fromBookers && active && covers(existing.plan, plan)
    && (!existing.access_ends_at || Date.parse(existing.access_ends_at) >= Date.parse(validUntil))) {
    await recordRedemption(db, found, user.id, email, validUntil);
    return { status: "already", plan: existing.plan, planLabel: planLabel(existing.plan), expiresAt: existing.access_ends_at || null };
  }

  const newPlan = active ? mergePlan(existing.plan, plan) : plan;
  const keepLonger = active && fromBookers && existing.access_ends_at && Date.parse(existing.access_ends_at) > Date.parse(validUntil);
  const expiresAt = keepLonger ? existing.access_ends_at : validUntil;
  const record = {
    member_key: memberKey,
    google_email: email,
    auth_user_id: user.id,
    plan: newPlan,
    status: "active",
    access_starts_at: active ? existing.access_starts_at : nowIso,
    access_ends_at: expiresAt,
    free_period_ends_at: null,
    first_month_free: false,
    reward_name: `BOOKERS ${planLabel(newPlan)}`,
    last_imported_at: nowIso,
  };

  if (existing) {
    // CAMPFIRE の行も BOOKERS の会員キーに付け替える（CSV 取込は campfire:/email: 以外の行を変更しないため、以後上書きされない）
    await db.patch(`/rest/v1/rein_memberships?member_key=eq.${encodeURIComponent(existing.member_key)}`, record);
  } else {
    await db.post("/rest/v1/rein_memberships", record, "return=minimal");
  }
  await recordRedemption(db, found, user.id, email, expiresAt);
  return { status: "granted", plan: newPlan, planLabel: planLabel(newPlan), expiresAt };
}

async function recordRedemption(db, code, userId, email, expiresAt) {
  await db.post("/rest/v1/rein_bookers_redemptions?on_conflict=user_id,code_id", {
    code_id: code.id, user_id: userId, email, plan: code.plan, month: code.month, expires_at: expiresAt,
  }, "resolution=ignore-duplicates,return=minimal");
}

export function createBookersClient({ token = process.env.BOOKERS_API_TOKEN, fetchImpl = (...a) => fetch(...a) } = {}) {
  return {
    configured: Boolean(token),
    async updatePostText(postUuid, text) {
      if (!token) throw new Error("BOOKERS_API_TOKEN が未設定です。");
      const r = await fetchImpl(`https://bookers.tech/api/postupdate/${postUuid}/`, {
        method: "PATCH", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error(`BOOKERS ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    },
  };
}

// 今月の合言葉がなければ作り、記事にまだ反映していなければ書き換える。何度呼んでも同じ結果になる。
export async function ensureMonthlyCodes({ db, bookers = createBookersClient(), now = Date.now(), randomBytes = crypto.randomBytes, plans = BOOKERS_PLANS, force = false }) {
  const month = jstMonth(new Date(now));
  const posts = await db.get("/rest/v1/rein_bookers_code_posts?select=plan,post_uuid");
  const postByPlan = new Map((Array.isArray(posts) ? posts : []).map(p => [p.plan, p.post_uuid]));
  const results = [];
  for (const plan of plans) {
    const rows = await db.get(`/rest/v1/rein_bookers_access_codes?select=id,code,valid_until,post_synced_at&plan=eq.${plan}&month=eq.${month}&retired_at=is.null&limit=1`);
    let row = Array.isArray(rows) ? rows[0] : null;
    let created = false;
    if (!row) {
      const inserted = await db.post("/rest/v1/rein_bookers_access_codes", { plan, month, code: generateCode(randomBytes), valid_until: validUntilFor(month) });
      row = Array.isArray(inserted) ? inserted[0] : inserted;
      created = true;
    }
    const postUuid = postByPlan.get(plan) || "";
    let synced = Boolean(row.post_synced_at);
    let error = null;
    if (postUuid && bookers.configured && (force || !synced)) {
      try {
        await bookers.updatePostText(postUuid, articleText({ plan, month, code: row.code, validUntil: row.valid_until }));
        await db.patch(`/rest/v1/rein_bookers_access_codes?id=eq.${row.id}`, { post_synced_at: new Date(now).toISOString(), post_error: null });
        synced = true;
      } catch (e) {
        error = String(e?.message || e).slice(0, 300);
        await db.patch(`/rest/v1/rein_bookers_access_codes?id=eq.${row.id}`, { post_error: error });
      }
    }
    results.push({ plan, month, created, synced, error, hasPost: Boolean(postUuid) });
  }
  return { month, results };
}
