import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { serverData } from "./server-snapshots";
import type { HistoryBundle } from "./history";
import type { NarHorse } from "./nar-source";

export type NarModel = {status:string;version:string;features:string[];roles:Record<string,{mode:"absolute"|"relative"|"hybrid";intercept:number;coef:number[]}>;comparison:Record<string,Record<string,{audit2026:Record<string,{races:number;hits:number;rate:number|null}>}>>;note:string;release?:{id:string;validatedRanking:boolean;selectionYear:number;auditThrough:string}};
export type NarRuntime = {profile:HistoryBundle;model:NarModel;sha:string;updatedAt:string};
export function validateNarModel(model:NarModel) {
  if(model?.version!=="nar-history-ranker-v1" || model.features?.length!==28) throw new Error("地方モデルの形式を確認できません");
  for(const target of ["1","2","3"]) {
    const role=model.roles?.[target];
    if(!role || !["absolute","relative","hybrid"].includes(role.mode) || !Number.isFinite(role.intercept) || role.coef?.length!==(role.mode==="hybrid"?56:28) || !role.coef.every(Number.isFinite)) throw new Error("地方モデルの係数を確認できません");
  }
}
let cached:{until:number;value:Promise<NarRuntime>}|undefined;
export function loadNarRuntime(force=false):Promise<NarRuntime> {
  if (!force && cached && cached.until>Date.now()) return cached.value;
  const value = (async()=>{
    const {analysis,signed_url} = await serverData<{analysis:{report:{profileSha:string;live_model:NarModel};updated_at:string}|null;signed_url:string|null}>("nar-profile");
    if (!signed_url || !analysis || analysis.report.live_model?.status!=="provisional") throw new Error("地方専用モデルを準備中です");
    validateNarModel(analysis.report.live_model);
    const response = await fetch(signed_url,{cache:"no-store",signal:AbortSignal.timeout(20_000)});
    if (!response.ok) throw new Error("地方履歴の読み込みに失敗しました");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length>16_000_000 || createHash("sha256").update(bytes).digest("hex")!==analysis.report.profileSha) throw new Error("地方履歴の整合性を確認できません");
    const profile = JSON.parse(gunzipSync(bytes,{maxOutputLength:120_000_000}).toString("utf8")) as HistoryBundle;
    return {profile,model:analysis.report.live_model,sha:analysis.report.profileSha,updatedAt:analysis.updated_at};
  })();
  cached={until:Date.now()+300_000,value};
  value.catch(()=>{if(cached?.value===value)cached=undefined;});
  return value;
}
const groups = ["horse","horseSurface","horseDistance","horseCourse","jockey","trainer","gate"] as const;
const labels = ["通算成績","芝ダ適性","距離適性","競馬場適性","騎手傾向","厩舎傾向","枠傾向"];
const clean = (id:string)=>id.replace(/^0+/,"")||"0";
export function narHistoryInputs(profile:HistoryBundle,horse:NarHorse,context:{racecourse:string;surface:string;distanceM:number}) {
  const h=clean(horse.horseId),bucket=Math.floor(context.distanceM/200);
  const keys=[h,`${h}|${context.surface}`,`${h}|${bucket}`,`${h}|${context.racecourse}`,clean(horse.jockeyId),clean(horse.trainerId),`${context.racecourse}|${context.surface}|${bucket}|${horse.gate}`];
  const rates=groups.map((g,i)=>profile[g]?.[keys[i]]);
  const values=rates.flatMap(r=>r ? [Math.min(Math.log1p(r.n)/Math.log(101),2),r.w,r.t,r.f/18] : [0,1.5/20,4.5/20,.5]);
  const factors=rates.flatMap((r,i)=>{
    if(!r)return [];
    const wins=Math.max(0,Math.round(r.w*(r.n+20)-1.5)),top3=Math.max(0,Math.round(r.t*(r.n+20)-4.5));
    return [{label:labels[i],samples:r.n,impact:0,wins,top3,winRate:Math.round(wins/r.n*1000)/10,top3Rate:Math.round(top3/r.n*1000)/10,averageFinish:r.f}];
  });
  return {values,factors,samples:rates[0]?.n??0};
}
export function narRank(runtime:NarRuntime,horses:NarHorse[],context:{racecourse:string;surface:string;distanceM:number;date:string}) {
  // A rolling aggregate must never be used to reconstruct a date inside its own
  // training period. Historical reviews use authentic stored prestart snapshots.
  if(runtime.profile.meta.dateTo>=context.date) throw new Error("この日付は学習期間内のため、予測の再構築は行いません");
  const rows=horses.map(h=>narHistoryInputs(runtime.profile,h,context));
  const width=rows[0].values.length, n=rows.length;
  const means=Array.from({length:width},(_,j)=>rows.reduce((s,r)=>s+r.values[j],0)/n);
  const stds=means.map((m,j)=>Math.max(.01,Math.sqrt(rows.reduce((s,r)=>s+(r.values[j]-m)**2,0)/Math.max(n-1,1))));
  const scores=[1,2,3].map(target=>{
    const model=runtime.model.roles[String(target)];
    return rows.map(row=>{
      const relative=row.values.map((v,j)=>(v-means[j])/stds[j]);
      const features=model.mode==="absolute"?row.values:model.mode==="relative"?relative:[...row.values,...relative];
      if(features.length!==model.coef.length)throw new Error("地方モデルの特徴量が一致しません");
      return model.intercept+features.reduce((s,v,j)=>s+v*model.coef[j],0);
    });
  });
  const shares=scores.map(values=>{const weights=values.map(v=>1/(1+Math.exp(-v))),total=weights.reduce((s,v)=>s+v,0);return weights.map(v=>v/total);});
  return horses.map((horse,i)=>{
    const pts=scores.map(values=>Math.round(100*(values.filter(v=>v<values[i]).length+.5*(values.filter(v=>v===values[i]).length-1))/Math.max(n-1,1)));
    // Reference factor ranks are the smoothed top-three rate minus this field's
    // average, in percentage points. They are NOT an extra score adjustment.
    const factors=rows[i].factors.map(f=>{const j=labels.indexOf(f.label)*4+2;return {...f,impact:Math.round((rows[i].values[j]-means[j])*1000)/10};});
    const recent=runtime.profile.horseRecent5[clean(horse.horseId)];
    if(recent){const all=horses.map(h=>runtime.profile.horseRecent5[clean(h.horseId)]?.t??4.5/20);const wins=Math.max(0,Math.round(recent.w*(recent.n+20)-1.5)),top3=Math.max(0,Math.round(recent.t*(recent.n+20)-4.5));factors.push({label:"近5走",samples:recent.n,impact:Math.round((recent.t-all.reduce((s,v)=>s+v,0)/n)*1000)/10,wins,top3,winRate:Math.round(wins/recent.n*1000)/10,top3Rate:Math.round(top3/recent.n*1000)/10,averageFinish:recent.f});}
    return {...horse,probabilityKind:"ranking-share" as const,score:Math.round((pts[0]+pts[1]+pts[2])/3),firstProbability:shares[0][i],secondProbability:shares[1][i],thirdProbability:shares[2][i],firstSuitability:pts[0],secondSuitability:pts[1],thirdSuitability:pts[2],historySamples:rows[i].samples,historyFactors:factors,parameterFactors:factors,positives:factors.filter(f=>f.samples>=5&&f.impact>0).sort((a,b)=>b.impact-a.impact).slice(0,3).map(f=>`${f.label} ${f.samples}走・3着内${f.top3Rate}%`),cautions:rows[i].samples<5?["取得済みの地方履歴が少ないため参考評価"]:[],verdict:runtime.model.release?.validatedRanking?"地方専用ハイブリッド評価":"地方履歴からの暫定評価",mark:""};
  }).sort((a,b)=>b.score-a.score||a.number-b.number);
}
