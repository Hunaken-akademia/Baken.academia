import { NextRequest, NextResponse } from "next/server";
import { dateJst, scheduleCalendar } from "@/lib/server-snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, max-age=300, stale-while-revalidate=600" };

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get("month") ?? "";
  const league = request.nextUrl.searchParams.get("league") ?? "jra";
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || !["jra", "nar"].includes(league)) {
    return NextResponse.json({ error: "開催月を確認してください" }, { status: 400, headers });
  }

  const [year, monthNumber] = month.split("-").map(Number);
  const monthStart = month + "-01";
  const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const oldest = dateJst(-365);
  const today = dateJst();
  if (monthStart > today || monthEnd < oldest) {
    return NextResponse.json({ error: "過去1年分の開催月を指定してください" }, { status: 400, headers });
  }

  const from = monthStart < oldest ? oldest : monthStart;
  const to = monthEnd > today ? today : monthEnd;
  try {
    const { schedules } = await scheduleCalendar(from, to, league as "jra" | "nar");
    const days = schedules
      .map((item) => ({ date: item.race_date, venues: item.payload?.venues ?? [] }))
      .filter((item) => item.venues.length > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
    return NextResponse.json({ month, days }, { headers });
  } catch {
    return NextResponse.json({ error: "開催一覧を取得できませんでした" }, { status: 503, headers });
  }
}
