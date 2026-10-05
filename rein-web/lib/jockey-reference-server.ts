import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {NextRequest,NextResponse} from 'next/server';
import {matchJockey,type JockeyReference} from './jockey-reference';
const profiles=new Map<string,Promise<JockeyReference>>();
function load(league:'jra'|'nar'){
 let value=profiles.get(league);if(!value){value=readFile(path.join(process.cwd(),'data',`${league}-jockey-reference.json.gz.b64`),'utf8').then(raw=>JSON.parse(gunzipSync(Buffer.from(raw.trim(),'base64'),{maxOutputLength:30_000_000}).toString('utf8')) as JockeyReference);profiles.set(league,value);value.catch(()=>profiles.delete(league));}return value;
}
export async function jockeyReferenceRequest(request:NextRequest,league:'jra'|'nar'){
 const headers={'cache-control':'private, no-store'};
 try{
  if(Number(request.headers.get('content-length')??0)>10000)return NextResponse.json({error:'入力が大きすぎます'},{status:400,headers});
  const text=await request.text();if(text.length>10000)throw new Error('Invalid input');
  const {riders}=JSON.parse(text);if(!Array.isArray(riders)||riders.length>18||!riders.every(r=>Number.isInteger(r.number)&&r.number>=1&&r.number<=18&&(r.id===undefined||typeof r.id==='string'&&/^\d{1,12}$/.test(r.id))&&typeof r.name==='string'&&r.name.length<=80))return NextResponse.json({error:'入力が正しくありません'},{status:400,headers});
  const reference=await load(league);return NextResponse.json({meta:reference.meta,profiles:Object.fromEntries(riders.map(r=>[String(r.number),matchJockey(reference,r.id,r.name)]))},{headers});
 }catch{return NextResponse.json({error:'騎手の条件別履歴を取得できませんでした'},{status:503,headers});}
}
