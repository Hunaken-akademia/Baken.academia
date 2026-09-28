import { createHash } from "node:crypto";

export const REIN_LOGIN_URL = "https://rein-web.vercel.app/login";
export const REIN_EMAIL_FROM = "馬券アカデミア <noreply@hunaken-academia.com>";

export function welcomeIdempotencyKey(memberKey) {
  const digest = createHash("sha256").update(String(memberKey)).digest("hex");
  return `rein-campfire-welcome-${digest}`;
}

export async function sendReinWelcomeEmail({ apiKey, email, memberKey, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("REINのRESEND_API_KEYが未設定です。");
  const safeEmail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) throw new Error("送信先メールアドレスが正しくありません。");

  const subject = "【馬券アカデミア】REINの会員登録が完了しました";
  const text = [
    "馬券アカデミアへのご参加ありがとうございます。",
    "備考欄にご記入いただいたメールアドレスをREINに登録しました。",
    "以下のリンクから、備考欄に記入したGoogleアカウントでログインしてご利用ください。",
    "",
    `REIN: ${REIN_LOGIN_URL}`,
    "",
    "今後ともよろしくお願いいたします。",
    "馬券アカデミア運営事務局",
  ].join("\n");
  const html = `<div style="font-family:Arial,'Noto Sans JP',sans-serif;line-height:1.8;max-width:560px;margin:auto;padding:24px;color:#172033"><p>馬券アカデミアへのご参加ありがとうございます。</p><p>備考欄にご記入いただいたメールアドレスをREINに登録しました。</p><p>以下のリンクから、備考欄に記入したGoogleアカウントでログインしてご利用ください。</p><p style="margin:28px 0"><a href="${REIN_LOGIN_URL}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#0891b2;color:#fff;text-decoration:none;font-weight:700">REINを開く</a></p><p>今後ともよろしくお願いいたします。<br>馬券アカデミア運営事務局</p></div>`;
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
