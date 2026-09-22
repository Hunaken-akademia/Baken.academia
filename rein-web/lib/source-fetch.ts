import { createHash } from "node:crypto";
import { getCache } from "@vercel/functions";

const sharedSourceCache = getCache({ namespace: "rein-source-v1" });

function cacheKey(url: string) {
  return "src:" + createHash("sha256").update(url).digest("hex");
}

export async function fetchSource(
  url: string,
  label: string,
  optional = false,
  cacheTtlSeconds = 0,
): Promise<string> {
  const key = cacheKey(url);

  if (cacheTtlSeconds > 0) {
    try {
      const cached = await sharedSourceCache.get(key);
      if (typeof cached === "string") return cached;
    } catch (error) {
      console.error("REIN source cache read failed", label, error instanceof Error ? error.message : "unknown");
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; REIN/0.4; member analytics)" },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });

      if (optional && response.status === 404) {
        if (cacheTtlSeconds > 0) {
          try {
            await sharedSourceCache.set(key, "", {
              ttl: cacheTtlSeconds,
              name: `REIN source: ${label}`,
            });
          } catch {}
        }
        return "";
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();

      if (cacheTtlSeconds > 0) {
        try {
          await sharedSourceCache.set(key, body, {
            ttl: cacheTtlSeconds,
            name: `REIN source: ${label}`,
          });
        } catch (error) {
          console.error("REIN source cache write failed", label, error instanceof Error ? error.message : "unknown");
        }
      }
      return body;
    } catch (error) {
      console.warn(JSON.stringify({
        event: "race_source_failed",
        label,
        attempt: attempt + 1,
        path: new URL(url).pathname,
        error: error instanceof Error ? error.message : "unknown",
      }));
      if (attempt === 1) {
        if (optional) return "";
        throw new Error(`${label}の取得に失敗しました。時間をおいて更新してください`);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  return "";
}
