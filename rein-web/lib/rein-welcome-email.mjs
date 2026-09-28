import { createHash } from "node:crypto";

export const REIN_LOGIN_URL = "https://rein-web.vercel.app/login";
export const REIN_EMAIL_FROM = "馬券アカデミア <noreply@hunaken-academia.com>";
export const REIN_OPEN_CHAT_URL = "https://line.me/ti/g2/rmb6j27hkM2VTfK0R_Pd8EU4pVEba1NXlevevw?utm_source=invitation&utm_medium=link_copy&utm_campaign=default";
export const REIN_OPEN_CHAT_CODE = "234234";

const planDetails = {
  nar: { name: "地方競馬プラン", range: "地方競馬の情報・分析をご利用いただけます。" },
  jra: { name: "中央競馬プラン", range: "中央競馬の情報・分析をご利用いただけます。" },
  all: { name: "オールプラン", range: "地方競馬・中央競馬の情報・分析をご利用いただけます。" },
};

export function welcomeIdempotencyKey(memberKey) {
  const digest = createHash("sha256").update(String(memberKey)).digest("hex");
  return `rein-campfire-welcome-${digest}`;
}

export async function sendReinWelcomeEmail({ apiKey, email, memberKey, plan, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("REINのRESEND_API_KEYが未設定です。");
  const safeEmail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) throw new Error("送信先メールアドレスが正しくありません。");
  const details = planDetails[plan];
  if (!details) throw new Error("会員プランを判定できません。");

  const subject = `【馬券アカデミア】${details.name} 登録完了のお知らせ`;
  const text = [
    "馬券アカデミアへのご参加ありがとうございます。",
    "以下の内容でREINへの会員登録が完了しました。",
    `プラン：${details.name}`,
    `ご利用範囲：${details.range}`,
    "",
    `REINはこちら：${REIN_LOGIN_URL}`,
    "備考欄にご記入いただいたGoogleアカウントでログインしてください。",
    "",
    "オープンチャット「馬券アカデミア」",
    REIN_OPEN_CHAT_URL,
    `参加コード：${REIN_OPEN_CHAT_CODE}`,
    "",
    "レインに関する意見・要望や、競馬にまつわる情報交換の場としてご活用ください。",
    "今後ともよろしくお願いいたします。",
    "馬券アカデミア運営事務局",
  ].join("\n");
  const html = `<div style="font-family:Arial,'Noto Sans JP',sans-serif;line-height:1.8;max-width:560px;margin:auto;padding:24px;color:#172033"><p>馬券アカデミアへのご参加ありがとうございます。</p><p>以下の内容でREINへの会員登録が完了しました。</p><p><strong>プラン：</strong>${details.name}<br><strong>ご利用範囲：</strong>${details.range}</p><p style="margin:28px 0"><a href="${REIN_LOGIN_URL}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#0891b2;color:#fff;text-decoration:none;font-weight:700">REINを開く</a></p><p>備考欄にご記入いただいたGoogleアカウントでログインしてください。</p><hr style="border:0;border-top:1px solid #ddd;margin:24px 0"><p><strong>オープンチャット「馬券アカデミア」</strong><br><a href="${REIN_OPEN_CHAT_URL}">参加リンク</a><br>参加コード：${REIN_OPEN_CHAT_CODE}</p><p>レインに関する意見・要望や、競馬にまつわる情報交換の場としてご活用ください。</p><p>今後ともよろしくお願いいたします。<br>馬券アカデミア運営事務局</p></div>`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": welcomeIdempotencyKey(memberKey),
      },
      body: JSON.stringify({ from: REIN_EMAIL_FROM, to: [safeEmail], subject, html, text }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || `Resend送信エラー（HTTP ${response.status}）`);
    if (typeof data?.id !== "string" || !data.id) throw new Error("Resendから送信IDが返りませんでした。");
    return data.id;
  } finally {
    clearTimeout(timeout);
  }
}
