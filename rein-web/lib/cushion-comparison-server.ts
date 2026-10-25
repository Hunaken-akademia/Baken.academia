import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";
import { JRA_TRACK_VENUES, validTrackDate } from "./track-reference";
let dataset: Promise<any> | undefined;
export async function comparisonResponse(request: NextRequest) {
 const q=request.nextUrl.searchParams,venue=q.get('venue')??'',date=q.get('date')??'',distance=Number(q.get('distance')),value=Number(q.get('value'));
 const headers={'cache-control':'private, no-store'};
 if(!JRA_TRACK_VENUES.includes(venue)||!validTrackDate(date)||!Number.isFinite(value)||value<0||value>20||!Number.isInteger(distance)||distance<1000||distance>4000)return NextResponse.json({error:'条件を確認してください'},{status:400,headers});
 try {
 dataset??=readFile(process.cwd()+'/data/cushion-comparisons.json.gz.b64','utf8').then(s=>JSON.parse(gunzipSync(Buffer.from(s,'base64')).toString())).catch(e=>{dataset=undefined;throw e;});
 const data=await dataset;
 const profile=data.profiles.find((p:any)=>p.venue===venue&&p.distance===distance&&p.center===Math.round(value*2)/2&&p.date_to<date);
 return NextResponse.json({profile:profile??null},{headers});
 }catch{return NextResponse.json({error:'比較データを取得できませんでした'},{status:503,headers});}
}
