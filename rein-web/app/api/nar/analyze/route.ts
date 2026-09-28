import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { dateJst, serverData, storedSnapshot } from "@/lib/server-snapshots";
import { narCache, refreshNarRace } from "@/lib/nar-live";
import { narRaceKey } from "@/lib/nar-source";
import { isSnapshotFresh, metaFromBody } from "@/lib/analysis-cache";
import { timingSafeEqual } from "node:crypto";
export const dynamic="force-dynamic";
export const maxDuration=180;
const headers={"cache-control":"private, no-store"};
export async function GET(request:NextRequest) {
  const id=request.nextUrl.searchParams.get("raceId")??"",key=narRaceKey(id),preview=request.nextUrl.searchParams.get("preview")==="1";
  if(!key||![dateJst(-1),dateJst(),dateJst(1)].includes(key.date)||preview!==(key.date===dateJst(1)))return NextResponse.json({error:"Invalid race"},{status:400,headers});
  const token=request.headers.get("authorization")??"",secret=process.env.CRON_SECRET;
  const expected=secret?`Bearer ${secret}`:"";
  const internal=!!expected&&Buffer.byteLength(token)===Buffer.byteLength(expected)&&timingSafeEqual(Buffer.from(token),Buffer.from(expected));
  const force=internal&&request.nextUrl.searchParams.get("refresh")==="1";
  try {
    const slot=preview?"preview":"live";
    const cached=await narCache.get(`race:${id}:${slot}`).catch(()=>null);
    const snapshot=typeof cached==="string"?JSON.parse(cached):(await storedSnapshot(id,slot)).snapshot?.payload;
    if(snapshot&&!force){
      const meta=metaFromBody(snapshot,preview),stale=!meta||!isSnapshotFresh(meta,Date.now());
      if(stale)waitUntil(refreshNarRace(id,preview).catch(()=>null));
      return NextResponse.json(snapshot,{headers:{...headers,"x-rein-persisted":"1","x-rein-stale":stale?"1":"0"}});
    }
    // Bound requests to the server's actual schedule; arbitrary IDs cannot cause scraping.
    const {schedule}=await serverData<{schedule:{payload:{venues:Array<{races:Array<{raceId:string}>}>}}|null}>("schedule",{date:key.date,league:"nar"});
    if(!schedule?.payload.venues.some(v=>v.races.some(r=>r.raceId===id)))return NextResponse.json({error:"対象レースの開催情報は未取得です。開催一覧を更新してください。"},{status:404,headers});
    if(!internal){waitUntil(refreshNarRace(id,preview).catch(()=>null));return NextResponse.json({status:"preparing"},{status:202,headers});}
    const body=await refreshNarRace(id,preview);
    if(!body)return NextResponse.json({status:"preparing"},{status:202,headers});
    return NextResponse.json(body,{headers:{...headers,"x-rein-persisted":"1","x-rein-fallback":body.capture.complete?"0":"1"}});
  }catch(e){console.error("NAR analysis",e instanceof Error?e.message:"unknown");return NextResponse.json({error:"地方レースの保存データを取得できませんでした。"},{status:503,headers});}
}
