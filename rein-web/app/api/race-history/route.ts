import { NextRequest, NextResponse } from "next/server";
import { raceHistory } from "@/lib/server-snapshots";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("raceId") ?? "";
  if (!/^\d{10,12}$/.test(id)) return NextResponse.json({error:"Invalid race"},{status:400,headers});
  try { return NextResponse.json(await raceHistory(id),{headers}); }
  catch { return NextResponse.json({error:"保存履歴を取得できませんでした"},{status:503,headers}); }
}
