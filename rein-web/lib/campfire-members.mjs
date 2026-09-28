import { createHash } from "node:crypto";

export class CampfireCsvError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "CampfireCsvError";
    this.issues = issues;
  }
}

const norm = (value) => String(value || "").trim().toLowerCase().replace(/[\s　_()（）・/／-]/g, "");
const aliases = {
  remarks: ["備考", "備考欄", "回答", "メモ", "remarks"],
  google: ["google_email", "Googleメールアドレス", "Googleアドレス"],
  email: ["email", "メールアドレス", "登録メールアドレス", "支援者メールアドレス", "e-mail"],
  plan: ["plan", "メンバー特典", "特典内容", "プラン名", "プラン", "支援プラン", "加入プラン", "リターン", "リターン名", "特典", "コース"],
  status: ["status", "メンバーステータス", "会員状態", "支援状況", "ステータス", "状態", "決済状態", "契約状態"],
  id: ["memberid", "memberkey", "会員ID", "支援ID", "支援者ID", "ユーザーID", "メンバーID", "ID", "ユーザー名"],
  name: ["name", "名前", "氏名", "会員名", "支援者名", "ユーザー名", "メンバー名", "ニックネーム"],
  paid: ["最終決済月", "last_payment_month", "決済対象月"],
};
const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+$/i;
const EMAIL_IN_TEXT = /[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;

function readCsv(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { try { text = new TextDecoder("shift_jis", { fatal: true }).decode(bytes); }
    catch { throw new CampfireCsvError("UTF-8またはShift_JISのCSVを選択してください。"); } }
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", quoted = false, closed = false;
  const endCell = () => { row.push(cell); cell = ""; closed = false; };
  const endRow = () => { endCell(); if (row.some(v => v.trim())) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ",") endCell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (closed || c === '"') throw new CampfireCsvError("CSVの引用符または区切りが不正です。");
    else cell += c;
  }
  if (quoted) throw new CampfireCsvError("CSVの引用符が閉じられていません。");
  if (cell || row.length || closed) endRow();
  return rows;
}

/** Exclusive end: first day of the following month at 00:00 Japan time. */
export function paidMonthEnd(value) {
  const s = String(value || "").trim();
  const match = s.match(/^(\d{4})(?:[-/年]?)(\d{2})月?$/);
  if (!match) return null;
  const y = Number(match[1]), m = Number(match[2]);
  if (y < 2000 || y > 2100 || m < 1 || m > 12) return null;
  return new Date(Date.UTC(y, m, 1, -9)).toISOString();
}

function planOf(value) {
  const p = norm(value);
  if (p.includes("オール") || /^(rein)?all(plan)?$/.test(p) || /地方.*中央|中央.*地方/.test(p)) return "all";
  if (p.includes("地方競馬") || p === "地方" || p === "nar") return "nar";
  if (p.includes("中央競馬") || p === "中央" || p === "jra") return "jra";
  return null;
}

function statusOf(value) {
  const s = norm(value);
  // All stop requests end at the paid-month boundary, never at import time.
  if (/退会|解約|キャンセル|取消|終了|停止|休会/.test(s) ||
      ["cancelled", "canceled", "canceling", "cancelling", "inactive", "expired", "paused"].includes(s)) return "cancelled";
  if (["active", "member", "メンバー", "継続", "継続中", "支援継続中", "参加中", "支援中", "有効", "契約中", "加入中", "入会中", "入会済み"].includes(s)) return "active";
  return null;
}

export function parseCampfireMembers(bytes) {
  const rows = readCsv(bytes);
  if (rows.length < 1 || rows.length > 10001) throw new CampfireCsvError("0〜10,000人分の会員一覧CSVを選択してください。");
  const headers = rows[0].map(norm);
  if (new Set(headers).size !== headers.length) throw new CampfireCsvError("CSVに重複する列名があります。");
  const columns = Object.fromEntries(Object.entries(aliases).map(([k, names]) => [k, names.map(norm).map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1]));
  if (columns.plan < 0 || columns.status < 0 || (columns.remarks < 0 && columns.google < 0 && columns.email < 0))
    throw new CampfireCsvError("備考（またはGoogleメール）、メンバー特典、メンバーステータスの列が必要です。");
  const members = [], issues = [], emails = new Set(), keys = new Set();
  const counts = { nar: 0, jra: 0, all: 0, active: 0, cancelled: 0 };
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i], before = issues.length;
    const issue = (message) => issues.push("行" + (i + 1) + ": " + message);
    if (cells.length !== headers.length) { issue("列数が見出しと一致しません。"); continue; }
    const get = (k) => columns[k] < 0 ? "" : (cells[columns[k]] || "").trim();
    const fromRemarks = [...new Set((get("remarks").match(EMAIL_IN_TEXT) || []).map(v => v.toLowerCase()))];
    const google = get("google").toLowerCase();
    const email = google || (columns.remarks >= 0 ? fromRemarks[0] || "" : get("email").toLowerCase());
    if (!EMAIL.test(email) || fromRemarks.length > 1 || (google && fromRemarks.length === 1 && google !== fromRemarks[0]))
      issue("Googleメールを1つに特定できません。備考欄を確認してください。");
    const plan = planOf(get("plan")), status = statusOf(get("status"));
    if (!plan) issue("REINの3プランのいずれかを指定してください。");
    if (!status) issue("会員状態を判定できません。");
    const sourceId = get("id");
    const memberKey = sourceId ? "campfire:" + sourceId : "campfire:email:" + createHash("sha256").update(email).digest("hex").slice(0, 32);
    if (memberKey.length > 240) issue("会員IDが長すぎます。");
    if (emails.has(email) || keys.has(memberKey)) issue("Googleメールまたは会員IDが重複しています。");
    emails.add(email); keys.add(memberKey);
    const paid = get("paid"), end = paidMonthEnd(paid);
    if (paid && !end) issue("最終決済月はYYYYMMまたはYYYY-MM形式で指定してください。");
    if (issues.length !== before) continue;
    members.push({ member_key: memberKey, google_email: email, plan, status, member_name: get("name") || null,
      reward_name: get("plan"), paid_month_end: end, row_number: i + 1 });
    counts[plan]++; counts[status]++;
  }
  if (issues.length) throw new CampfireCsvError("CSVを確認してください。まだ反映していません。", issues.slice(0, 20));
  return { members, counts };
}

const isCampfire = (key) => key.startsWith("campfire:") || key.startsWith("email:");
const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Prepare one atomic upsert; generated normalized_email is deliberately excluded.
 * @param {ReturnType<typeof parseCampfireMembers>["members"]} members
 * @param {Array<any>} existingRows
 */
export function prepareCampfireImport(members, existingRows, now = new Date()) {
  const byKey = new Map(existingRows.map(r => [r.member_key, r]));
  const byEmail = new Map(existingRows.map(r => [String(r.normalized_email || r.google_email).trim().toLowerCase(), r]));
  const records = [], versions = [], issues = [], deadlines = new Map();
  let protectedMembers = 0;
  for (const row of members) {
    const existing = byKey.get(row.member_key) || byEmail.get(row.google_email);
    const owner = byEmail.get(row.google_email);
    const issue = (s) => issues.push("行" + row.row_number + ": " + s);
    if (existing && owner && existing.member_key !== owner.member_key) { issue("変更先メールは別の会員に登録済みです。"); continue; }
    if (existing && !isCampfire(existing.member_key)) { protectedMembers++; continue; }
    let end = row.status === "cancelled" ? row.paid_month_end : null;
    if (row.status === "cancelled") {
      if (existing?.status === "cancelled" && validDate(existing.access_ends_at))
        end = !end || Date.parse(existing.access_ends_at) < Date.parse(end) ? existing.access_ends_at : end;
      if (!end) { issue("停止期限を確定できません。最終決済月を指定してください。"); continue; }
    }
    const jst = new Date(now.getTime() + 9 * 3600000);
    const today = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), -9)).toISOString();
    const monthStart = row.paid_month_end
      ? (() => { const d = new Date(Date.parse(row.paid_month_end) + 9 * 3600000); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1, -9)).toISOString(); })()
      : today;
    const start = existing?.access_starts_at || (Date.parse(monthStart) < Date.parse(today) ? monthStart : today);
    if (!validDate(start) || (end && Date.parse(end) <= Date.parse(start))) { issue("利用開始日と停止期限が矛盾しています。"); continue; }
    const record = {
      member_key: existing?.member_key || row.member_key,
      google_email: row.google_email,
      // Reset the binding so the existing trigger links the new Google account.
      auth_user_id: null,
      plan: row.plan, status: row.status,
      member_name: row.member_name, reward_name: row.reward_name,
      access_starts_at: start, access_ends_at: end,
    };
    if (records.some(r => r.member_key === record.member_key)) { issue("同じ会員への更新が重複しています。"); continue; }
    records.push(record);
    versions.push(existing ? [existing.member_key, existing.updated_at, existing.status, existing.access_ends_at, existing.google_email] : null);
    if (end) deadlines.set(end, (deadlines.get(end) || 0) + 1);
  }
  if (issues.length) throw new CampfireCsvError("停止期限または会員情報を確認してください。まだ反映していません。", issues.slice(0, 20));
  return { records, versions, protectedMembers, deadlines: [...deadlines].sort().map(([at, count]) => ({ at, count })) };
}
