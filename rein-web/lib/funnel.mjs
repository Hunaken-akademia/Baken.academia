// REIN の入口を数える（2026-11-20 オーナー依頼「記録してないれいんは」）。WAKE の lib/funnel.js と同じ考え方。
// 個人は記録しない。日（日本時間）×イベント×入口×場所 の回数だけ（表 rein_funnel_source_daily）。
//   free_view  … 無料版を開いた（detail = free / jra / nar）
//   plan_click … BOOKERS のプランへ移動した（detail = nar / jra / all）
export const FUNNEL_EVENTS = ["free_view", "plan_click"];
export const FUNNEL_SOURCES = ["x", "yt", "bookers", "lp", "search", "note", "line", "wake", "other", "direct"];
export const VIEW_PAGES = ["free", "jra", "nar"];
// プランの移動先は1か所（販売ページが変わったらここだけ直す）
export const PLAN_URLS = {
  nar: "https://bookers.tech/magazine/9aee480f-e4f7-4d14-b4b5-8ae381512a8f/",
  jra: "https://bookers.tech/magazine/4d1af8db-e934-46fe-b22c-9cfdbeee18b5/",
  all: "https://bookers.tech/magazine/c9b4b8a8-f00f-4097-8cf4-334ec5ba62bd/",
};

export function normalizeSource(src) {
  const v = String(src || "").trim().toLowerCase();
  return FUNNEL_SOURCES.includes(v) ? v : "other";
}

// ?from= が付いていればそれ、無ければ来る前のページ（referrer）で決める。ownHost は REIN 自身（中の移動は direct）。
export function classifySource(from, referrer, ownHost = "") {
  const f = String(from || "").trim().toLowerCase();
  if (FUNNEL_SOURCES.includes(f) && f !== "other") return f;
  let host = "";
  try { host = referrer ? new URL(referrer).hostname.toLowerCase() : ""; } catch { host = ""; }
  if (!host) return "direct";
  if (/(^|\.)(t\.co|x\.com|twitter\.com)$/.test(host)) return "x";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "yt";
  if (/bookers/.test(host)) return "bookers";
  if (/^rein-lp\.vercel\.app$/.test(host)) return "lp";
  if (/(^|\.)wakekyotei\.com$|^(newhunaken456|wake-free)\.vercel\.app$/.test(host)) return "wake";
  if (/(^|\.)(google\.[a-z.]+|bing\.com|yahoo\.co\.jp|search\.yahoo\.com|duckduckgo\.com)$/.test(host)) return "search";
  if (/(^|\.)note\.com$/.test(host)) return "note";
  if (/(^|\.)line\.me$/.test(host)) return "line";
  if (ownHost && host === String(ownHost).toLowerCase()) return "direct";
  return "other";
}

export async function bumpFunnel({ event, src, detail }, { url, key, fetchImpl = fetch }) {
  if (!FUNNEL_EVENTS.includes(event)) return false;
  const response = await fetchImpl(`${url}/rest/v1/rpc/rein_funnel_bump`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_event: event, p_src: normalizeSource(src), p_detail: String(detail || "") }),
    signal: AbortSignal.timeout(4000),
  });
  return response.ok;
}

// GET /api/funnel の中身（テストしやすいように Next から切り離す）。
//   ?go=nar|jra|all → 数えて BOOKERS へ 302（入口は cookie rein_src、無ければ Referer）
//   ?e=free_view&page=free|jra|nar&src=… → 数えて 204
export async function handleFunnel({ search, cookieSrc, referer, ownHost }, { bump }) {
  const params = new URLSearchParams(search);
  const go = params.get("go");
  if (go && Object.hasOwn(PLAN_URLS, go)) {
    const src = cookieSrc ? normalizeSource(cookieSrc) : classifySource(null, referer, ownHost);
    await bump({ event: "plan_click", src, detail: go }).catch(() => {});
    return { status: 302, location: PLAN_URLS[go] };
  }
  const page = params.get("page");
  if (params.get("e") === "free_view" && VIEW_PAGES.includes(page)) {
    await bump({ event: "free_view", src: params.get("src"), detail: page }).catch(() => {});
  }
  return { status: 204 };
}
