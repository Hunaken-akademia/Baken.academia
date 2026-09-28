const HEADER_ALIASES = {
  email: ["email", "メールアドレス", "登録メールアドレス", "支援者メールアドレス", "e-mail", "mail"],
  plan: ["plan", "プラン", "支援プラン", "加入プラン", "リターン", "特典", "コース"],
  status: ["status", "会員状態", "支援状況", "ステータス", "契約状態", "利用状況"],
  memberId: ["memberid", "memberkey", "会員id", "支援者id", "ユーザーid", "メンバーid"],
  name: ["name", "会員名", "支援者名", "ユーザー名", "メンバー名", "ニックネーム"],
  joinedAt: ["joinedat", "参加日時", "支援開始日", "加入日", "参加日"],
};

const normalizeHeader = (value) => String(value || "").trim().toLowerCase().replace(/[\s　_‐‑–—-]/g, "");
const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

export class CampfireCsvError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "CampfireCsvError";
    this.issues = issues;
  }
}

function decodeCsv(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    try {
      return new TextDecoder("shift_jis", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      throw new CampfireCsvError("CSVをUTF-8またはShift_JISとして読み取れませんでした。");
    }
  }
}

function readCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new CampfireCsvError("CSVの引用符が閉じられていません。");
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  return rows;
}

function findColumn(headers, aliases) {
  const wanted = new Set(aliases.map(normalizeHeader));
  return headers.findIndex((header) => wanted.has(normalizeHeader(header)));
}

function getPlan(value) {
  const plan = String(value || "").trim().toLowerCase().replace(/[\s　]/g, "");
  if (!plan) return null;
  if (plan.includes("オール") || plan.includes("all") || /地方.*中央|中央.*地方/.test(plan)) return "all";
  if (plan.includes("地方") || plan === "nar") return "nar";
  if (plan.includes("中央") || plan === "jra") return "jra";
  return null;
}

function getStatus(value, hasStatusColumn) {
  if (!hasStatusColumn) return "active";
  const status = String(value || "").trim().toLowerCase().replace(/[\s　]/g, "");
  if (!status) return null;
  if (/退会|解約|キャンセル|取消|終了|停止|未決済|cancell?ed|expired|inactive/.test(status)) return "cancelled";
  if (/休会|保留|一時停止|paused|pending|確認中/.test(status)) return "paused";
  if (/継続|参加中|支援中|有効|契約中|active|member|加入中/.test(status)) return "active";
  return null;
}

/**
 * Parse an exported Campfire member CSV without retaining the uploaded file.
 * Rows must include an email address and one of the three REIN plan names.
 */
export function parseCampfireMembers(bytes) {
  const rows = readCsvRows(decodeCsv(bytes));
  if (rows.length < 2) throw new CampfireCsvError("会員データが見つかりません。ヘッダーと会員行を含むCSVを選択してください。");
  if (rows.length > 10001) throw new CampfireCsvError("一度に取り込める会員数は10,000人までです。");

  const headers = rows[0].map((value) => value.trim());
  const emailColumn = findColumn(headers, HEADER_ALIASES.email);
  const planColumn = findColumn(headers, HEADER_ALIASES.plan);
  const statusColumn = findColumn(headers, HEADER_ALIASES.status);
  const memberIdColumn = findColumn(headers, HEADER_ALIASES.memberId);
  const nameColumn = findColumn(headers, HEADER_ALIASES.name);
  const joinedAtColumn = findColumn(headers, HEADER_ALIASES.joinedAt);

  if (emailColumn < 0 || planColumn < 0) {
    throw new CampfireCsvError("メールアドレス列とプラン列を特定できません。Campfireの会員一覧CSVを確認してください。");
  }

  const members = [];
  const issues = [];
  const seenEmails = new Set();
  const counts = { nar: 0, jra: 0, all: 0, active: 0, paused: 0, cancelled: 0 };

  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    const line = i + 1;
    const email = normalizeEmail(cells[emailColumn]);
    const plan = getPlan(cells[planColumn]);
    const status = getStatus(cells[statusColumn], statusColumn >= 0);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) issues.push(`行${line}: メールアドレスが空か形式不正です。`);
    if (!plan) issues.push(`行${line}: プランを判定できません。`);
    if (!status) issues.push(`行${line}: 会員状態を判定できません。`);
    if (email && seenEmails.has(email)) issues.push(`行${line}: 同じメールアドレスが複数行あります。`);
    if (email) seenEmails.add(email);
    if (!email || !plan || !status || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) continue;

    const externalId = memberIdColumn >= 0 ? String(cells[memberIdColumn] || "").trim() : "";
    const name = nameColumn >= 0 ? String(cells[nameColumn] || "").trim().slice(0, 200) : "";
    let joinedAt = null;
    const joinedAtText = joinedAtColumn >= 0 ? String(cells[joinedAtColumn] || "").trim() : "";
    if (joinedAtText) {
      const timestamp = Date.parse(joinedAtText);
      if (Number.isFinite(timestamp)) joinedAt = new Date(timestamp).toISOString();
    }

    members.push({
      member_key: externalId ? `campfire:${externalId}` : `email:${email}`,
      google_email: email,
      normalized_email: email,
      plan,
      status,
      member_name: name || null,
      reward_name: String(cells[planColumn] || "").trim().slice(0, 200),
      campfire_joined_at: joinedAt,
      access_ends_at: null,
    });
    counts[plan] += 1;
    counts[status] += 1;
  }

  if (issues.length) throw new CampfireCsvError("CSVに確認が必要な行があります。内容を直して再度アップロードしてください。", issues.slice(0, 20));
  if (!members.length) throw new CampfireCsvError("取り込める会員行がありません。");
  return { members, counts };
}
