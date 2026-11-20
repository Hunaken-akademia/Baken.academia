"use client";
// 無料版を開いた回数を、ページごとに1セッション1回だけ数える（個人は記録しない、/api/funnel）。
// 最初の入口（X・YouTube など）を覚えておき、プランのボタンを押したときにも同じ入口で数える（cookie rein_src）。
import { useEffect } from "react";
import { classifySource } from "@/lib/funnel.mjs";

export default function FreeFunnelBeacon({ page }: { page: "free" | "jra" | "nar" }) {
  useEffect(() => {
    try {
      let src = sessionStorage.getItem("rein_src");
      if (!src) {
        src = classifySource(new URLSearchParams(window.location.search).get("from"), document.referrer, window.location.hostname);
        sessionStorage.setItem("rein_src", src);
        document.cookie = `rein_src=${encodeURIComponent(src)}; path=/; max-age=86400; samesite=lax; secure`;
      }
      const seen = `rein_free_view_${page}`;
      if (!sessionStorage.getItem(seen)) {
        sessionStorage.setItem(seen, "1");
        fetch(`/api/funnel?e=free_view&page=${page}&src=${encodeURIComponent(src)}`, { keepalive: true }).catch(() => {});
      }
    } catch {
      /* 計測できなくても表示は続ける */
    }
  }, [page]);
  return null;
}
