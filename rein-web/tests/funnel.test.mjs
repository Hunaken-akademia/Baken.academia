import assert from "node:assert/strict";
import test from "node:test";
import { classifySource, normalizeSource, handleFunnel, bumpFunnel, PLAN_URLS } from "../lib/funnel.mjs";

test("入口の判定：?from= を優先、無ければ referrer", () => {
  assert.equal(classifySource("x", ""), "x");
  assert.equal(classifySource("", "https://t.co/abc"), "x");
  assert.equal(classifySource(null, "https://m.youtube.com/watch?v=1"), "yt");
  assert.equal(classifySource("", "https://rein-lp.vercel.app/"), "lp");
  assert.equal(classifySource("", "https://wakekyotei.com/"), "wake");
  assert.equal(classifySource("", "https://www.google.co.jp/"), "search");
  assert.equal(classifySource("", "https://bookers.tech/magazine/x"), "bookers");
  assert.equal(classifySource("", ""), "direct");
  assert.equal(classifySource("", "https://rein-web.vercel.app/free", "rein-web.vercel.app"), "direct");
  assert.equal(classifySource("zzz", "https://example.com/"), "other");
  assert.equal(normalizeSource("<script>"), "other");
});

test("プランへの移動：数えて BOOKERS へ。入口は cookie、無ければ Referer", async () => {
  const calls = [];
  const bump = async (row) => { calls.push(row); return true; };
  assert.deepEqual(await handleFunnel({ search: "?go=nar", cookieSrc: "yt", referer: "https://rein-lp.vercel.app/" }, { bump }), { status: 302, location: PLAN_URLS.nar });
  await handleFunnel({ search: "?go=all", cookieSrc: null, referer: "https://rein-lp.vercel.app/" }, { bump });
  assert.deepEqual(calls, [{ event: "plan_click", src: "yt", detail: "nar" }, { event: "plan_click", src: "lp", detail: "all" }]);
  // 知らない行き先は移動しない（よそへの転送に使わせない）
  assert.deepEqual(await handleFunnel({ search: "?go=https://evil" }, { bump }), { status: 204 });
  // 数えるのに失敗しても移動は止めない
  assert.equal((await handleFunnel({ search: "?go=jra" }, { bump: async () => { throw new Error("db"); } })).status, 302);
});

test("無料版の閲覧：決まったページだけ数える", async () => {
  const calls = [];
  const bump = async (row) => { calls.push(row); return true; };
  await handleFunnel({ search: "?e=free_view&page=nar&src=x" }, { bump });
  await handleFunnel({ search: "?e=free_view&page=admin&src=x" }, { bump });
  await handleFunnel({ search: "?e=plan_click&page=nar" }, { bump });
  assert.deepEqual(calls, [{ event: "free_view", src: "x", detail: "nar" }]);
});

test("Supabase の rpc を呼ぶ", async () => {
  let seen;
  const ok = await bumpFunnel({ event: "free_view", src: "evil", detail: "free" }, { url: "https://db", key: "k", fetchImpl: async (u, o) => { seen = { u, body: JSON.parse(o.body) }; return { ok: true }; } });
  assert.equal(ok, true);
  assert.deepEqual(seen, { u: "https://db/rest/v1/rpc/rein_funnel_bump", body: { p_event: "free_view", p_src: "other", p_detail: "free" } });
  assert.equal(await bumpFunnel({ event: "nope" }, { url: "x", key: "k" }), false);
});
