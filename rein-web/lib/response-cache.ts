// Best-effort per-instance cache. This is not a distributed rate limiter.
// No stale responses: odds/results are reused for at most the explicit TTL.
export function responseCache(ttlMs: number, maxEntries = 64) {
  const cache = new Map<string, { expires: number; response: Response }>();
  const pending = new Map<string, Promise<Response>>();
  return async (key: string, run: () => Promise<Response>): Promise<Response> => {
    const now = Date.now();
    for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
    const hit = cache.get(key);
    if (hit) return hit.response.clone();
    const running = pending.get(key);
    if (running) return (await running).clone();
    // Shedding buys nothing while every shed request still reaches an instance, so let
    // the CDN hold the refusal for the same few seconds the client is asked to wait.
    if (pending.size >= 8) return Response.json(
      { error: "アクセスが集中しています。少し待って再試行してください。" },
      { status: 503, headers: { "Retry-After": "5", "Cache-Control": "public, max-age=0, s-maxage=5" } },
    );
    const work = Promise.resolve().then(run).then((response) => {
      if (response.ok && response.headers.get("x-rein-fallback") !== "1") {
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
        cache.set(key, { expires: Date.now() + ttlMs, response: response.clone() });
      }
      return response;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return (await work).clone();
  };
}
