import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { hasBearerSecret } from "@/lib/internal-auth";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!hasBearerSecret(request.headers.get("authorization"), process.env.CRON_SECRET || "")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const profile = await readFile(path.join(process.cwd(), "data", "history-profile.json.gz"));
    return new NextResponse(profile, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-length": String(profile.byteLength),
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("REIN history profile unavailable", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "History profile unavailable" }, { status: 503 });
  }
}
