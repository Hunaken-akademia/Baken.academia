// Do not parse platform error/login pages as model or snapshot JSON.
export async function serverJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw new Error(`${label} ${response.status}`);
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && !type?.endsWith("+json")) {
    throw new Error(`${label} returned non-JSON (${response.status})`);
  }
  return await response.json() as T;
}

// Retry reads only: claim/save requests can have committed before a timeout.
export async function snapshotResponse(
  action: string,
  request: () => Promise<Response>,
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
): Promise<Response> {
  const reads = new Set(["read", "schedule", "metas", "history", "calendar"]);
  const attempts = reads.has(action) ? 3 : 1;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await request();
      if (attempt + 1 >= attempts || ![429, 502, 503, 504].includes(response.status)) return response;
      await response.body?.cancel();
    } catch (error) {
      if (attempt + 1 >= attempts) throw error;
    }
    await pause(250 * 2 ** attempt + Math.floor(Math.random() * 100));
  }
}
