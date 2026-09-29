import { roleOrder, selectPicks, type MarkHorse, type MarkPick } from "./marks";

type Rate = {samples:number;hits:number;rate:number|null};
type SignalAudit = Rate & {baseline:number|null;difference:number|null;differenceCI:number[]|null;win:Rate;tenPlus:Rate};
type Signal = {status:"adopted"|"rejected";gap:number|null;audit:SignalAudit|null};
type Period = {races:number;favoriteWinner:Rate;top3PopularityWinner:Rate;tenPlusWinner:Rate};
export type NarConditionValidation = {
  version:string;periods:{train:string;selection:string;audit:string};limitations:string[];
  ranking:Record<string,{status:string;selectedKind:string;auditGain:number;auditGainCI:number[]|null;candidates?:Record<string,{audit:Record<string,{races:number;hits:number;rate:number|null}>}>}>;
  signals:{danger:Signal;longshot:Signal;confidence:{status:string;thresholds:number[];minimumFieldSize:number;bins:Array<{bin:number;audit:{winner:Rate;twoPlaced:Rate}}>}};
  tendencies:Array<{kind:string;key:string;selection:Period;audit:Period}>;
  pace:{status:string;cornerRows:number;reason:string};
};
export type NarConditionContext = {racecourse:string;surface:string;distanceM:number;going?:string};
export function narConditionKey(context:NarConditionContext,kind:string) {
  const course=`${context.racecourse}|${context.surface}`;
  if(kind==="courseDistance")return `${course}|${context.distanceM<1400?"short":context.distanceM<=1800?"mile":"long"}`;
  if(kind==="courseGoing")return `${course}|${context.going||"不明"}`;
  return course;
}
const pct=(value:number|null|undefined)=>typeof value==="number"?`${(value*100).toFixed(1)}%`:"母数不足";
const conditionNames:Record<string,string>={course:"場別",courseDistance:"場×距離別",courseGoing:"場×馬場別"};

export function narReferenceSignals(horses:MarkHorse[],validation:NarConditionValidation|undefined,context:NarConditionContext) {
  const picks=selectPicks(horses,{roleModelReady:horses.every(h=>Number.isFinite(h.firstProbability)),marketReady:false});
  const order=roleOrder(horses,"first");
  const fullRanking=order.length===horses.length&&horses.length>=2;
  // No selection from partial popularity: rankings can move when missing odds arrive.
  const marketReady=fullRanking&&horses.every(h=>Number.isInteger(h.popularity)&&h.popularity>=1&&h.popularity<=horses.length)&&new Set(horses.map(h=>h.popularity)).size===horses.length;
  if(!validation || validation.version!=="nar-conditions-v1")return {picks,confidence:null,reference:null};
  const danger=validation.signals.danger,longshot=validation.signals.longshot;
  const dangerNumbers=marketReady&&danger.status==="adopted"&&danger.gap!==null?order.filter((h,i)=>h.popularity<=3&&i+1>=h.popularity+danger.gap!).map(h=>h.number):[];
  const rule=longshot.status==="adopted"?`4番人気以下・1着適性5位以内・人気順位より${longshot.gap}位以上高い馬。確定人気での監査であり、現在の人気は変動します。`:
    "地方データで改善基準を満たさなかったため、穴候補は採用していません。";
  if(longshot.status==="adopted" && marketReady && picks.status==="ready") {
    const candidates:MarkPick[]=order.flatMap((h,i)=>h.popularity>=4&&i<5&&longshot.gap!==null&&h.popularity-(i+1)>=longshot.gap?[{number:h.number,role:"穴候補",firstRank:i+1}]:[]);
    picks.longshotCandidates=candidates;picks.longshot=candidates[0]??null;
    picks.longshotStatus=candidates.length?"selected":"none";
    picks.longshotReason=candidates.length?"地方の確定人気を用いた履歴監査に基づく参考候補。期待値・買い推奨ではありません。":"検証した地方の条件に該当する馬はいません。";
  } else picks.longshotReason=!marketReady?"全頭の人気がそろっていないため、地方の穴候補を保留しています。":rule;
  const signalText=(signal:Signal)=>signal.audit?`監査対象${signal.audit.samples.toLocaleString("ja-JP")}頭・3着内${pct(signal.audit.rate)}（同場・同人気・同頭数帯の基準${pct(signal.audit.baseline)}）。確定人気による事後監査で、回収率は未検証。`:"選択期間・監査期間の改善基準を満たしていません。";
  const reference={
    version:validation.version,auditPeriod:validation.periods.audit,
    danger:{status:!fullRanking?"held":!marketReady?"market-missing":danger.status,numbers:dangerNumbers,detail:signalText(danger)},
    longshot:{rule,detail:signalText(longshot)},
    conditions:["course","courseDistance","courseGoing"].map(kind=>{
      const entry=validation.tendencies.find(t=>t.kind===kind&&t.key===narConditionKey(context,kind));
      return {kind,label:conditionNames[kind],detail:entry?`2026年の${entry.audit.races.toLocaleString("ja-JP")}レース。勝ち馬に占める割合：1番人気${pct(entry.audit.favoriteWinner.rate)}、1〜3番人気${pct(entry.audit.top3PopularityWinner.rate)}、10番人気以下${pct(entry.audit.tenPlusWinner.rate)}（同着を含む${entry.audit.favoriteWinner.samples}頭）。2025年の1番人気の割合は${pct(entry.selection.favoriteWinner.rate)}。`:
        "この条件は選択年・監査年とも100レース以上という集計基準を満たしていません。類似条件の数字を代用しません。"};
    }),
    ranking:[1,2,3].map(role=>{const result=validation.ranking[String(role)];return {role,status:result?.status??"insufficient",detail:result?`${conditionNames[result.selectedKind]??result.selectedKind}：共通モデルに対する監査Top5的中率差 ${(result.auditGain*100).toFixed(2)}ポイント。${result.status==="adopted"?"採用":"改善基準に達せず共通モデルを維持"}`:"検証結果なし"};}),
    confidenceStatus:validation.signals.confidence.status,
    note:"場・距離・馬場の数字は過去の傾向で、今回の的中確率ではありません。2026年は過去モデルの監査にも使用しています。",
  };
  const c=validation.signals.confidence,n=horses.length;
  if(!fullRanking||c.status!=="adopted"||n<c.minimumFieldSize)return {picks,confidence:null,reference};
  const total=order.reduce((s,h)=>s+(h.firstProbability??0),0);
  if(total<=0)return {picks,confidence:null,reference};
  const share=order.slice(0,3).reduce((s,h)=>s+(h.firstProbability??0),0)/total;
  const excess=(share-3/n)/(1-3/n), bin=c.thresholds.filter(threshold=>excess>=threshold).length;
  const record=c.bins.find(b=>b.bin===bin);
  if(!record)return {picks,confidence:null,reference};
  const labels=["慎重","標準","高め","かなり高い"] as const;
  return {picks,reference,confidence:{label:labels[bin],top3Share:share,sharePercent:share*100,
    detail:`頭数を補正した集中度で分類。同区分の監査${record.audit.winner.samples.toLocaleString("ja-JP")}レースでは、1着適性上位3頭に勝ち馬が含まれた割合${pct(record.audit.winner.rate)}・2頭以上が3着内${pct(record.audit.twoPlaced.rate)}。`,
    note:"過去の同区分の実績であり、このレースの的中確率・回収率ではありません。5頭以下は対象外。"}};
}

export type NarReference = NonNullable<ReturnType<typeof narReferenceSignals>["reference"]>;
