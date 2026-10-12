import { NextRequest,NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { getVercelOidcToken } from "@vercel/oidc";
import { createHash } from "node:crypto";
import { storedSnapshot } from "./server-snapshots";
import { SUPABASE_URL } from "./supabase/config";
import { fetchSource } from "./source-fetch";
import { narRaceKey,narUrl,parseNarCard } from "./nar-source";
import { TREND_RULES,TREND_VERSION,ruleMatches,selectTrendTickets,ageTypeFromText,type OddsTrendData,type TrendItem,type TrendRace,type TrendRunner,type TrendBet } from "./odds-trends";
import { parseYahooMarket,parseNarQuinella,marketIsComplete,oddsText } from "./odds-trend-market";

type Snapshot={race:TrendRace;horses:TrendRunner[];scratched?:unknown[];prediction?:{phase?:string;generatedAt?:string}};
type Source={body:string;fetchedAt:string};
const cache=getCache({namespace:"rein-odds-trends-v1"});
const pending=new Map<string,Promise<OddsTrendData>>(),sourcePending=new Map<string,Promise<Source>>();
const headers={"cache-control":"private, no-store"};
async function observationData(action:"read"|"write",raceId:string,items?:TrendItem[]) {
  const token=await getVercelOidcToken();if(!token)throw new Error("Server identity unavailable");
  const response=await fetch(`${SUPABASE_URL}/functions/v1/rein-odds-observations`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({action,raceId,...(items?{items}:{})}),cache:"no-store",signal:AbortSignal.timeout(12_000)});
  if(!response.ok)throw new Error(`Odds observation store ${response.status}`);
  return await response.json() as {items?:TrendItem[];saved?:boolean};
}
async function source(url:string,label:string):Promise<Source> {
  const key="source:"+createHash("sha256").update(url).digest("hex");
  const saved=await cache.get(key).catch(()=>null) as Source|null;if(saved?.body)return saved;
  let job=sourcePending.get(key);
  if(!job){job=fetchSource(url,label,true).then(async body=>{const item={body,fetchedAt:new Date().toISOString()};if(body)await cache.set(key,item,{ttl:60}).catch(()=>{});return item;}).finally(()=>sourcePending.delete(key));sourcePending.set(key,job);}
  return job;
}
function possibleRules(body:Snapshot){return TREND_RULES.filter(r=>ruleMatches(r,body.race,body.horses)!==false);}
async function build(raceId:string,league:"jra"|"nar",provided?:Snapshot):Promise<OddsTrendData> {
  const stored=provided??((await storedSnapshot(raceId,"live")).snapshot?.payload??(await storedSnapshot(raceId,"preview")).snapshot?.payload) as Snapshot|undefined;
  if(!stored?.race||!stored?.horses?.length||stored.race.raceId!==raceId)throw new Error("Snapshot unavailable");
  const body={...stored,race:{...stored.race,league}};
  const now=Date.now(),starts=body.race.startsAt;
  const base={raceId,version:TREND_VERSION,generatedAt:new Date(now).toISOString(),startsAt:starts};
  if(typeof starts!=="number"||!Number.isFinite(starts)||body.prediction?.phase==="preview")return {...base,phase:"provisional",items:possibleRules(body).map(r=>({ruleId:r.id,state:"waiting",selections:[],fetchedAt:null,note:"当日のオッズ公開後に照合します"}))};
  if(now>=starts){
    const saved=await observationData("read",raceId).catch(()=>({items:[] as TrendItem[]}));
    if(saved.items?.length)return {...base,phase:"saved-prestart",items:saved.items};
    return {...base,phase:"historical",items:possibleRules(body).map(r=>({ruleId:r.id,state:"no-prestart",selections:[],fetchedAt:null,note:"発走前の条件別買い目の保存がありません"}))};
  }
  if(!possibleRules(body).length)return {...base,phase:"provisional",items:[]};
  let horses=body.horses;const books=new Map<TrendBet,ReturnType<typeof parseYahooMarket>>(),times=new Map<TrendBet,string>();
  let freshRace=body.race,sourceFinal=false;
  try {
    if(league==="jra") {
      const win=await source(`https://sports.yahoo.co.jp/keiba/race/odds/tfw/${raceId}`,"条件別単勝・枠連オッズ");
      sourceFinal=/確定オッズ|当日最終オッズ/.test(win.body);
      const q=parseYahooMarket(win.body,"win",raceId);if(!marketIsComplete(q,"win",horses))throw new Error("Incomplete win market");
      freshRace={...freshRace,context:{...freshRace.context,ageType:ageTypeFromText(oddsText(win.body))??freshRace.context?.ageType},condition:oddsText(win.body).match(/馬場[：:]?\s*(良|稍重|重|不良)/)?.[1]??freshRace.condition};
      horses=horses.map(h=>({...h,odds:q.find(q=>q.numbers[0]===h.number)!.odds}));books.set("win",q);times.set("win",win.fetchedAt);
      const frames=parseYahooMarket(win.body,"bracket_quinella",raceId);if(marketIsComplete(frames,"bracket_quinella",horses)){books.set("bracket_quinella",frames);times.set("bracket_quinella",win.fetchedAt);}
      if(TREND_RULES.some(r=>r.bet==="trio"&&ruleMatches(r,freshRace,horses)!==false)){
        const trio=await source(`https://sports.yahoo.co.jp/keiba/race/odds/sf/${raceId}?ninki=0`,"条件別3連複オッズ");sourceFinal ||= /確定オッズ|当日最終オッズ/.test(trio.body);
        const tq=parseYahooMarket(trio.body,"trio",raceId);if(marketIsComplete(tq,"trio",horses)){books.set("trio",tq);times.set("trio",trio.fetchedAt);}
      }
    }else{
      const key=narRaceKey(raceId)!;
      const [card,market]=await Promise.all([source(narUrl("DebaTable",key.date,key.code,key.number),"条件別地方単勝"),source(`https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/OddsUmLenFuku?${new URLSearchParams({k_raceDate:key.date.replaceAll("-","/"),k_babaCode:String(Number(key.code)),k_raceNo:String(key.number)})}`,"条件別地方馬連")]);
      const parsed=parseNarCard(card.body,raceId);
      if(parsed.scratched.length||parsed.horses.some(h=>h.odds===null||h.odds<1)||parsed.horses.map(h=>h.number).sort().join()!==horses.map(h=>h.number).sort().join())throw new Error("Roster or win market unavailable");
      horses=parsed.horses;freshRace={...body.race,...parsed.race};sourceFinal=/オッズ\s*[（(]最終[）)]/.test(market.body);
      const nq=parseNarQuinella(market.body,raceId);if(marketIsComplete(nq,"quinella",horses)){books.set("quinella",nq);times.set("quinella",market.fetchedAt);}
    }
  }catch(e){console.warn("REIN condition odds unavailable",e instanceof Error?e.message:"unknown");}
  const items:TrendItem[]=[];
  for(const rule of TREND_RULES){const q=books.get(rule.bet),match=ruleMatches(rule,freshRace,horses,q);if(match===false)continue;
    if(body.scratched?.length||sourceFinal||Date.now()>=starts||!q||match===null){items.push({ruleId:rule.id,state:"waiting",selections:[],fetchedAt:times.get(rule.bet)??null,note:body.scratched?.length?"取消・除外を含むため検証条件の対象外です":sourceFinal||Date.now()>=starts?"発走前オッズを確認できないため買い目を保留しています":"必要なオッズ・レース条件の取得待ちです"});continue;}
    const selections=selectTrendTickets(rule,horses,q);
    items.push({ruleId:rule.id,state:selections.length?"ready":"no-tickets",selections,fetchedAt:times.get(rule.bet)!,note:selections.length?undefined:"現在のオッズに対象の組合せはありません"});
  }
  const ready=items.filter(i=>i.state==="ready");
  if(ready.length){try{const result=await observationData("write",raceId,ready);for(const i of ready)i.saved=result.saved===true;}catch{for(const i of ready)i.saved=false;console.warn("REIN condition tickets not persisted");}}
  return {...base,phase:"provisional",items};
}
export async function captureOddsTrends(payload:Snapshot) {
  const id=payload.race.raceId,league=id.length===12?"nar":"jra";
  if(payload.race.startsAt&&Date.now()>=payload.race.startsAt){await observationData("read",id);return;}
  if(!possibleRules(payload).length)return;
  await getOddsTrends(id,league,payload);
}
export async function getOddsTrends(raceId:string,league:"jra"|"nar",payload?:Snapshot) {
  const key=`${league}:${raceId}:${payload?.prediction?.generatedAt??"view"}`;
  const saved=await cache.get(key).catch(()=>null) as OddsTrendData|null;if(saved&&!(saved.phase==="provisional"&&saved.startsAt&&Date.now()>=saved.startsAt))return saved;
  let job=pending.get(key);if(!job){if(pending.size>=6)throw new Error("Busy");job=build(raceId,league,payload).then(async result=>{await cache.set(key,result,{ttl:60}).catch(()=>{});return result;}).finally(()=>pending.delete(key));pending.set(key,job);}
  return job;
}
export async function oddsTrendsResponse(request:NextRequest,league:"jra"|"nar") {
  const raceId=request.nextUrl.searchParams.get("raceId")??"";
  if(league==="nar"?!narRaceKey(raceId):!/^\d{8}(?:0[1-9]|1[0-2])$/.test(raceId))return NextResponse.json({error:"レースIDが不正です"},{status:400,headers});
  try{return NextResponse.json(await getOddsTrends(raceId,league),{headers});}catch{return NextResponse.json({error:"オッズ条件の情報を取得できませんでした"},{status:503,headers});}
}
