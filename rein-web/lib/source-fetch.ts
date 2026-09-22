export async function fetchSource(url: string, label: string, optional = false): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; REIN/0.4; member analytics)" },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (optional && response.status === 404) return "";
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
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
