import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

const destination = path.join(process.cwd(), "data", "history-profile.json.gz");
const temporary = `${destination}.tmp`;
const source = process.env.REIN_HISTORY_PROFILE_URL
  || "https://rein-web.vercel.app/api/internal/history-profile";

async function validate(file) {
  const payload = JSON.parse(gunzipSync(await readFile(file)).toString("utf8"));
  if (!payload?.meta?.version || !payload?.horse || !payload?.jockey) {
    throw new Error("REIN history profile is invalid");
  }
  return payload.meta;
}

try {
  await access(destination);
  const meta = await validate(destination);
  console.log(`Using REIN history profile ${meta.version} through ${meta.dateTo}`);
} catch (localError) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) {
    throw new Error(`History profile is missing and CRON_SECRET is unavailable: ${localError}`);
  }
  const response = await fetch(source, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`History profile download failed: ${response.status}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  const meta = await validate(temporary);
  await rename(temporary, destination);
  console.log(`Downloaded REIN history profile ${meta.version} through ${meta.dateTo}`);
}
