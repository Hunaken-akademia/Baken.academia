import { getCache } from "@vercel/functions";
import { fetchSource } from "./source-fetch";
import { serverData, storedSnapshot, saveSnapshot, claimCapture, releaseCapture } from "./server-snapshots";
import { parseNarCard, parseNarResult, parseNarSchedule, narVenueCodes, narRaceKey, narUrl, narScheduleIndexUrl, type NarHorse } from "./nar-source";
import { loadNarRuntime, narRank } from "./nar-model";
import { raceProgress } from "./race-progress";
import { selectPicks } from "./marks";
import { narReferenceSignals } from "./nar-validation";

export const narCache = getCache({namespace:"rein-nar-live-v2"});
export async function refreshNarSchedule(date:string) {
  const lease=await claimCapture(`race:nar-schedule:${date}`,120);
  if(!lease.acquired || !lease.token) return null;
  try {
    const index=await fetchSource(narScheduleIndexUrl(date),"地方開催一覧");
    const codes=narVenueCodes(index,date),venues=[];
    for (const code of codes) {
      const html=await fetchSource(narUrl("RaceList",date,code),"地方レース一覧");
      const venue=parseNarSchedule(html,date,code);
      const isToday = date===new Date(Date.now()+9*3600_000).toISOString().slice(0,10);
      venues.push(isToday?{...venue,...raceProgress(venue.races)}:venue);
    }
    const payload={date,dateLabel:new Date(`${date}T12:00:00+09:00`).toLocaleDateString("ja-JP",{timeZone:"Asia/Tokyo",month:"long",day:"numeric",weekday:"short"}),updatedAt:new Date().toISOString(),venues,league:"nar"};
    await serverData("save-schedule",{date,league:"nar",payload});
    await narCache.set(`schedule:${date}`,JSON.stringify(payload),{ttl:600}).catch(()=>{});
    return payload;
  } finally {await releaseCapture(`race:nar-schedule:${date}`,lease.token).catch(()=>{});}
}

export async function refreshNarRace(raceId:string, preview=false, expectedRelease?:string) {
  const key=narRaceKey(raceId);if(!key)throw new Error("Invalid NAR race");
  const lock=`race:nar:${raceId}:${preview?"preview":"live"}`;
  const lease=await claimCapture(lock,150);if(!lease.acquired||!lease.token)return null;
  try {
    const html=await fetchSource(narUrl("DebaTable",key.date,key.code,key.number),"地方出走表");
    const card=parseNarCard(html,raceId), fetchedAt=new Date().toISOString();
    const after=Date.now()>=card.race.startsAt;
    const result=after&&!preview?parseNarResult(await fetchSource(narUrl("RaceMarkTable",key.date,key.code,key.number),"地方結果",true),raceId):null;
    if(result?.finishers.some(h=>!card.horses.some(c=>c.number===h.number))) throw new Error("地方結果と出走表の馬番が一致しません");
    if(result?.scratched.length){for(const h of card.horses.filter(h=>result.scratched.includes(h.number)))card.scratched.push({number:h.number,name:h.name});card.horses=card.horses.filter(h=>!result.scratched.includes(h.number));}
    // Results annotate the immutable prestart forecast. Never re-score it using
    // final market values or a newly trained model after the start.
    const prior=after&&!preview?await storedSnapshot(raceId,"prestart").catch(()=>({snapshot:null})):null;
    if(prior?.snapshot && prior.snapshot.payload.horses.map((h:NarHorse)=>h.number).sort().join()===card.horses.map(h=>h.number).sort().join()) {
      const body={...prior.snapshot.payload,review:result??undefined,prediction:{...prior.snapshot.payload.prediction,phase:result?.isFinished?"final":"poststart",source:"prestart"},capture:{complete:true},race:{...prior.snapshot.payload.race,updated:new Date().toLocaleTimeString("ja-JP",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit"})}};
      await saveSnapshot(body,false);
      await narCache.set(`race:${raceId}:live`,JSON.stringify(body),{ttl:result?.isFinished?86400:300}).catch(()=>{});
      return body;
    }
    const held:string[]=[], warnings:string[]=[];
    let runtime=await loadNarRuntime().catch(e=>{held.push(e.message);return null;});
    // Release warming can reach a different server instance with an old model cache.
    // Reload only on a mismatch; never save an old-model forecast as a new release.
    if(expectedRelease && runtime?.model.release?.id!==expectedRelease)runtime=await loadNarRuntime(true);
    if(expectedRelease && runtime?.model.release?.id!==expectedRelease)throw new Error("地方モデルの切り替え待ちです");
    let scored:ReturnType<typeof narRank>|null=null;
    if(runtime) {try{scored=narRank(runtime,card.horses,card.context);}catch(e){held.push(e instanceof Error?e.message:"地方評価を保留しています");}}
    const horses=scored??card.horses.map(h=>({...h,score:0,mark:"",verdict:"履歴モデル待ち",positives:[] as string[],cautions:[] as string[]}));
    const signals=scored&&runtime?narReferenceSignals(scored,runtime.model.conditionValidation,card.context):null;
    const leaders=card.horses.filter(h=>h.earlyPosition!==null&&h.earlyPosition<=3).map(h=>h.number);
    const pace=key.code==="03"?{label:"ばんえい：平地ペース対象外",detail:"障害越えと馬場水分の影響が大きいため、平地の隊列・ペースは適用しません。",leaders:[]}:{label:leaders.length>=4?"先行候補多め":leaders.length<=1?"先行候補少なめ":"先行候補は平均的",detail:"近走の通過順からの参考分類。地方でのペース精度は未検証です。",leaders};
    warnings.push(runtime?.model.release?.validatedRanking?"地方専用の履歴・相対評価を組み合わせています。％は未校正の評価シェアで、的中確率ではありません。人気順より高い的中率を保証するものではありません。":"地方版は取得済みデータによる暫定評価です。％は未校正の評価シェアで、的中確率ではありません。補正は追加検証後に改訂します。");
    if(after)warnings.push("発走前の保存予想がないため、参考再計算です。的中率の集計には含めません。");
    const comparison=runtime?structuredClone(runtime.model.comparison):undefined;
    if(comparison&&runtime){for(const [role,result] of Object.entries(runtime.model.conditionValidation?.ranking??{})){
      const audit=result.candidates?.[result.selectedKind]?.audit;
      if(result.status==="adopted"&&audit)comparison[role][runtime.model.roles[role].mode]={...comparison[role][runtime.model.roles[role].mode],audit2026:audit};
    }}
    const complete=!!scored
      && card.horses.every(h=>typeof h.weight==="number"&&h.weight>0)
      && card.horses.every(h=>h.odds!==null&&h.odds>0&&h.popularity>0);
    const model=runtime?{...runtime.profile.meta,version:`${runtime.model.version}:${runtime.sha.slice(0,12)}`,release:runtime.model.release,probabilityKind:"ranking-share",strategy:runtime.model.conditionValidation?"地方専用ハイブリッド＋検証済みの着順別・場別補正。順位モデルに当日人気とオッズは不使用":runtime.model.release?.validatedRanking?"地方専用ハイブリッド・当日人気とオッズは評価に不使用":"地方専用・当日人気とオッズは評価に不使用",overallPolicy:"1〜3着の相対順位を均等合成",markPolicy:signals?.reference?"本命・対抗は1着適性順。穴候補は地方の人気順位差を検証した参考条件":"1着適性順。市場モデル未検証のため穴の印は保留",snapshotPolicy:"サーバーで一括保存",provisional:!runtime.model.release?.validatedRanking,validation:comparison,roleModes:Object.fromEntries(Object.entries(runtime.model.roles).map(([k,v])=>[k,v.mode]))}:undefined;
    const body={...card,race:{...card.race,updated:new Date(fetchedAt).toLocaleTimeString("ja-JP",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit"}),dataTimes:{card:fetchedAt,odds:card.horses.some(h=>h.odds!==null)?fetchedAt:null}},horses,model,pace,warnings,narReference:signals?.reference??null,
      prediction:{phase:preview?"preview":result?.isFinished?"final":after?"poststart":"prestart",source:after?"rebuilt":"live",generatedAt:fetchedAt,label:preview?"前日参考":after?"発走後・参考再計算":runtime?.model.release?.validatedRanking?"発走前・地方専用評価":"発走前・地方暫定"},
      evaluation:{roleModel:scored?"ready":"unavailable",overall:scored?"ready":"held",tickets:"held",held},capture:{complete},
      confidence:signals?.confidence??null,picks:signals?.picks??selectPicks(horses,{roleModelReady:!!scored,marketReady:false}),tickets:[],review:result??undefined,
    };
    await saveSnapshot(body,preview);
    await narCache.set(`race:${raceId}:${preview?"preview":"live"}`,JSON.stringify(body),{ttl:result?.isFinished&&scored?86400:300}).catch(()=>{});
    return body;
  } finally {await releaseCapture(lock,lease.token).catch(()=>{});}
}
