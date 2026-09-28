import test from "node:test";
import assert from "node:assert/strict";
import { REIN_EMAIL_FROM, REIN_LOGIN_URL, REIN_OPEN_CHAT_CODE, REIN_OPEN_CHAT_URL, sendReinWelcomeEmail, welcomeIdempotencyKey } from "../lib/rein-welcome-email.mjs";

test("sends a concise registration email to the registered Google account", async () => {
  let request;
  const id = await sendReinWelcomeEmail({
    apiKey: "test-secret",
    email: " Test.User@example.com ",
    memberKey: "campfire:member-1",
    plan: "nar",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ id: "re_test123" }) };
    },
  });
  assert.equal(id, "re_test123");
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.options.headers.Authorization, "Bearer test-secret");
  assert.equal(request.options.headers["Idempotency-Key"], welcomeIdempotencyKey("campfire:member-1"));
  const body = JSON.parse(request.options.body);
  assert.equal(body.from, REIN_EMAIL_FROM);
  assert.deepEqual(body.to, ["test.user@example.com"]);
  assert.match(body.text, new RegExp(REIN_LOGIN_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(body.text, /地方競馬プラン/);
  assert.match(body.text, /地方競馬の情報・分析/);
  assert.match(body.text, new RegExp(REIN_OPEN_CHAT_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(body.text, new RegExp(`参加コード：${REIN_OPEN_CHAT_CODE}`));
  assert.match(body.text, /意見・要望/);
});

test("includes the correct scope for all three plans", async () => {
  for (const [plan, planName, scope] of [
    ["nar", "地方競馬プラン", "地方競馬の情報・分析をご利用いただけます。"],
    ["jra", "中央競馬プラン", "中央競馬の情報・分析をご利用いただけます。"],
    ["all", "オールプラン", "地方競馬・中央競馬の情報・分析をご利用いただけます。"],
  ]) {
    let payload;
    await sendReinWelcomeEmail({
      apiKey: "test-secret", email: "test@example.com", memberKey: plan, plan,
      fetchImpl: async (_url, options) => {
        payload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ id: `re_${plan}` }) };
      },
    });
    assert.match(payload.subject, new RegExp(planName));
    assert.ok(payload.text.includes(scope));
    assert.ok(payload.html.includes(scope));
  }
});

test("uses stable idempotency keys and reports Resend failures", async () => {
  assert.equal(welcomeIdempotencyKey("x"), welcomeIdempotencyKey("x"));
  await assert.rejects(() => sendReinWelcomeEmail({
    apiKey: "test-secret", email: "x@example.com", memberKey: "x", plan: "jra",
    fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ message: "invalid recipient" }) }),
  }), /invalid recipient/);
  await assert.rejects(() => sendReinWelcomeEmail({
    apiKey: "test-secret", email: "bad-address", memberKey: "x", plan: "all", fetchImpl: async () => assert.fail("must not send"),
  }), /メールアドレス/);
  await assert.rejects(() => sendReinWelcomeEmail({
    apiKey: "test-secret", email: "x@example.com", memberKey: "x", plan: "other", fetchImpl: async () => assert.fail("must not send"),
  }), /プラン/);
});
