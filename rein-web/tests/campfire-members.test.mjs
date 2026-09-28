import assert from "node:assert/strict";
import test from "node:test";
import { CampfireCsvError, parseCampfireMembers } from "../lib/campfire-members.mjs";

const csv = (value) => new TextEncoder().encode(value);

test("parses all three REIN plans and maps active status", () => {
  const result = parseCampfireMembers(csv("メールアドレス,プラン,会員状態,支援者ID,支援者名\\nA@example.jp,REIN 地方競馬プラン,支援中,cf-1,テスト\\nb@example.jp,REIN 中央競馬プラン,有効,cf-2,\\nc@example.jp,REIN オールプラン,継続中,,ユーザー"));
  assert.deepEqual(result.counts, { nar: 1, jra: 1, all: 1, active: 3, paused: 0, cancelled: 0 });
  assert.equal(result.members[0].normalized_email, "a@example.jp");
  assert.equal(result.members[0].member_key, "campfire:cf-1");
  assert.equal(result.members[2].member_key, "email:c@example.jp");
});

test("handles quoted commas and CRLF", () => {
  const result = parseCampfireMembers(csv('Email,Plan,Status,Name\\r\\na@example.jp,"REIN オールプラン",active,"苗字, 名前"\\r\\n'));
  assert.equal(result.members[0].member_name, "苗字, 名前");
});

test("defaults rows to active only when no status column is present", () => {
  const result = parseCampfireMembers(csv("メールアドレス,プラン\\na@example.jp,地方競馬\\n"));
  assert.equal(result.members[0].status, "active");
});

test("rejects ambiguous or duplicated member rows without returning email addresses", () => {
  assert.throws(
    () => parseCampfireMembers(csv("email,plan,status\\na@example.jp,地方競馬,active\\na@example.jp,中央競馬,active\\nb@example.jp,unknown,active")),
    (error) => error instanceof CampfireCsvError && error.issues.length === 2 && !error.issues.some((issue) => issue.includes("@")),
  );
});

test("rejects malformed CSV quoting", () => {
  assert.throws(() => parseCampfireMembers(csv('email,plan\\na@example.jp,"地方競馬')), CampfireCsvError);
});
