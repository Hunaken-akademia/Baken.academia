import 'server-only';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {NextRequest,NextResponse} from 'next/server';
import {DICTIONARY_KINDS,searchDictionary,type DictionaryLeague,type DictionaryKind,type DictionaryIndex,type DictionaryProfile} from './dictionary';
const cache=new Map<string,Promise<unknown>>();
async function load<T>(name:string):Promise<T>{
 let value=cache.get(name);if(!value){value=readFile(path.join(process.cwd(),'data/dictionary',name+'.json.gz.b64'),'utf8').then(raw=>JSON.parse(gunzipSync(Buffer.from(raw.trim(),'base64'),{maxOutputLength:40_000_000}).toString('utf8')));cache.set(name,value);value.catch(()=>cache.delete(name));if(cache.size>12)cache.delete(cache.keys().next().value!);}return value as Promise<T>;
}
export async function dictionaryRequest(request:NextRequest,league:DictionaryLeague){
 const headers={'cache-control':'private, no-store'};
 const params=request.nextUrl.searchParams,kind=params.get('kind')??'horse',id=params.get('id'),q=params.get('q')??'',minimum=Number(params.get('min')??0),offset=Number(params.get('offset')??0),sort=params.get('sort')??'recent';
 if(!DICTIONARY_KINDS.some(([k])=>k===kind)||q.length>100||(id!==null&&(!id||id.length>150))||!Number.isSafeInteger(minimum)||minimum<0||minimum>100000||!Number.isSafeInteger(offset)||offset<0||offset>1000000||!['recent','starts','win','top3','wins'].includes(sort))return NextResponse.json({error:'検索条件を確認してください。'},{status:400,headers});
 try{
  const index=await load<DictionaryIndex>(league+'-index');
  if(id!==null){const key=kind+':'+id,shard=createHash('sha256').update(key).digest('hex').slice(0,1),profiles=await load<Record<string,DictionaryProfile>>(`${league}-${shard}`),profile=profiles[key];return NextResponse.json(profile?{meta:index.meta,profile}:{error:'辞典に該当する項目がありません。'},{status:profile?200:404,headers});}
  return NextResponse.json(searchDictionary(index,{kind:kind as DictionaryKind,query:q,minimum,offset,sort}),{headers});
 }catch{return NextResponse.json({error:'辞典のデータを取得できませんでした。時間をおいて再取得してください。'},{status:503,headers});}
}
