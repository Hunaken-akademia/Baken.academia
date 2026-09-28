import test from "node:test";
import assert from "node:assert/strict";
import { REIN_EMAIL_FROM, REIN_LOGIN_URL, sendReinWelcomeEmail, welcomeIdempotencyKey } from "../lib/rein-welcome-email.mjs";

test("sends a concise registration email to the registered Google account", async () => {
  let request;
  const id = await sendReinWelcomeEmail({
    apiKey: "test-secret",
    email: " Test.User@example.com ",
    memberKey: "campfire:member-1",
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
});

test("uses stable idempotency keys and reports Resend failures", async () => {
  assert.equal(welcomeIdempotencyKey("x"), welcomeIdempotencyKey("x"));
  await assert.rejects(() => sendReinWelcomeEmail({
    apiKey: "test-secret", email: "x@example.com", memberKey: "x",
    fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ message: "invalid recipient" }) }),
  }), /invalid recipient/);
  await assert.rejects(() => sendReinWelcomeEmail({
    apiKey: "test-secret", email: "bad-address", memberKey: "x", fetchImpl: async () => assert.fail("must not send"),
  }), /メールアドレス/);
});
