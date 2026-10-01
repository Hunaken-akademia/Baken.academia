import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { dateJst, serverData } from "@/lib/server-snapshots";
import { narCache, refreshNarSchedule } from "@/lib/nar-live";
export const dynamic="force-dynamic";
export const maxDuration=120;
const headers={"cache-control":"private, no-store"};
export async function GET(request:NextRequest) {
  const requested=request.nextUrl.searchParams.get("date")??"";
  const today=dateJst(),oldest=dateJst(-365);
  if(requested&&(!/^20\\d{2}-\\d{2}-\\d{2}$/.test(requested)||requested<oldest||requested>today))return NextResponse.json({error:"過去1年分の日付を指定してください"},{status:400,headers});
  const date=requested||dateJst(request.nextUrl.searchParams.get("day")==="tomorrow"?1:0);
  try {
    const cached=await narCache.get(`schedule:${date}`).catch(()=>null);
    if(typeof cached==="string")return new NextResponse(cached,{headers:{...headers,"content-type":"application/json"}});
    const {schedule}=await serverData<{schedule:{payload:unknown;generated_at:string}|null}>("schedule",{date,league:"nar"});
    if(schedule){
      if(Date.now()-Date.parse(schedule.generated_at)>1800_000)waitUntil(refreshNarSchedule(date).catch(()=>null));
      return NextResponse.json(schedule.payload,{headers});
    }
    const payload=await refreshNarSchedule(date);
    return NextResponse.json(payload??{error:"開催情報を準備中です。少し待って更新してください。"},{status:payload?200:503,headers});
  }catch{return NextResponse.json({error:"地方開催情報を取得できませんでした。時間をおいて更新してください。"},{status:503,headers});}
}
