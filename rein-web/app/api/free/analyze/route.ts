import { NextRequest, NextResponse } from "next/server";
import { checkFreeRace, freeHeaders, memberRequest } from "@/lib/free-access";
import { stripPaidAnalysis } from "@/lib/free-day.mjs";
import { GET as jraAnalyze } from "@/app/api/analyze/route";
import { GET as narAnalyze } from "@/app/api/nar/analyze/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

// 無料版のレース分析：本日の無料公開場のレースだけ。参考買い目は外して返す。
export async function GET(request: NextRequest) {
  const checked = await checkFreeRace(request);
  if (checked instanceof NextResponse) return checked;
  const { league, raceId } = checked;
  const response = league === "nar"
    ? await narAnalyze(memberRequest(request, "/api/nar/analyze", raceId))
    : await jraAnalyze(memberRequest(request, "/api/analyze", raceId));
  const body = await response.json().catch(() => null);
  const headers: Record<string, string> = { ...freeHeaders };
  const stale = response.headers.get("x-rein-stale");
  if (stale) headers["x-rein-stale"] = stale;
  if (response.status !== 200) return NextResponse.json(body ?? { error: "レース情報を取得できませんでした" }, { status: response.status, headers });
  return NextResponse.json(stripPaidAnalysis(body), { headers });
}
