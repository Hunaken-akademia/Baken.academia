import { NextRequest, NextResponse } from "next/server";
import { raceHistory } from "@/lib/server-snapshots";
import { narRaceKey } from "@/lib/nar-source";
export const dynamic="force-dynamic";
const headers={"cache-control":"private, no-store"};
export async function GET(request:NextRequest){
 const id=request.nextUrl.searchParams.get("raceId")??"";
 if(!narRaceKey(id))return NextResponse.json({error:"Invalid race"},{status:400,headers});
 try{return NextResponse.json(await raceHistory(id,"nar"),{headers});}
 catch{return NextResponse.json({error:"地方の保存履歴を取得できませんでした"},{status:503,headers});}
}
