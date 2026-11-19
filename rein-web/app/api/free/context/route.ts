import { NextRequest, NextResponse } from "next/server";
import { checkFreeRace, memberRequest } from "@/lib/free-access";
import { raceContextResponse } from "@/lib/race-context-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 無料版の前走比較・当日傾向：本日の無料公開場のレースだけ。
export async function GET(request: NextRequest) {
  const checked = await checkFreeRace(request);
  if (checked instanceof NextResponse) return checked;
  const path = checked.league === "nar" ? "/api/nar/analyze/context" : "/api/analyze/context";
  return raceContextResponse(memberRequest(request, path, checked.raceId), checked.league);
}
