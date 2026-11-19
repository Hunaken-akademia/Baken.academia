import { NextRequest, NextResponse } from "next/server";
import { freeHeaders, freeVenueToday } from "@/lib/free-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 無料版の開催一覧：本日の無料公開場だけを返す。
export async function GET(request: NextRequest) {
  const league = request.nextUrl.searchParams.get("league") === "nar" ? "nar" : "jra";
  try {
    const { date, schedule, venue } = await freeVenueToday(league, request.nextUrl.origin);
    return NextResponse.json({
      dateLabel: schedule.dateLabel ?? "本日の開催",
      updatedAt: schedule.updatedAt ?? new Date().toISOString(),
      venues: venue ? [venue] : [],
      free: { date, league, totalVenues: schedule.venues?.length ?? 0 },
    }, { headers: freeHeaders });
  } catch (error) {
    console.error("REIN free schedule", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "本日の無料公開場を確認できませんでした。少し待って再読み込みしてください。" }, { status: 503, headers: freeHeaders });
  }
}
