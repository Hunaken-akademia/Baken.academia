"use client";
import { useEffect,useMemo,useState } from "react";
import { TREND_RULES,TREND_BET_LABELS,ruleMatches,ruleDescription,type OddsTrendData,type TrendItem,type TrendRace,type TrendRunner } from "@/lib/odds-trends";

const pct=(v:number)=>`${(100*v).toFixed(1)}%`;
const stamp=(s:string|null)=>s?new Date(s).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}):"取得待ち";
export function OddsTrendPanel({race,horses}:{race:TrendRace;horses:TrendRunner[]}) {
  const [result,setResult]=useState<OddsTrendData|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0);
  const league=race.league??(race.raceId.length===12?"nar":"jra");
  useEffect(()=>{
    let active=true,busy=false;const abort=new AbortController();setResult(null);setError(false);
    async function load(){if(busy)return;busy=true;try{const url=league==="nar"?"/api/nar/odds-trends":"/api/analyze/odds-trends";const response=await fetch(`${url}?raceId=${race.raceId}`,{signal:abort.signal,cache:"no-store"});if(!response.ok)throw new Error("unavailable");const value=await response.json();if(active){setResult(value);setError(false);}}catch{if(active)setError(true);}finally{busy=false;}}
    void load();const timer=setInterval(()=>{if(document.visibilityState==="visible"&&race.startsAt&&Date.now()<race.startsAt)void load();},60_000);
    return()=>{active=false;abort.abort();clearInterval(timer);};
  },[race.raceId,league,race.startsAt,race.dataTimes?.odds,retry]);
  const initial=useMemo(()=>TREND_RULES.filter(rule=>ruleMatches(rule,race,horses)!==false).map(rule=>({ruleId:rule.id,state:"waiting",selections:[],fetchedAt:null} as TrendItem)),[race,horses]);
  const items=result?.raceId===race.raceId?result.items:initial;
  if(!items.length)return null;
  const historical=result?.phase==="historical",saved=result?.phase==="saved-prestart";
  return <section aria-label="オッズ条件の参考傾向" className="mb-5 rounded-2xl border border-cyan-400/30 bg-cyan-400/[.04] p-4 text-slate-200">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-cyan-200">📊 オッズ条件の参考傾向</h2><span className="rounded-full bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-200">{saved?"発走前の保存あり":historical?"過去レース":result?"暫定判定":"条件照合中"}・{items.length}件</span></div>
    <p className="mt-2 text-xs leading-5 text-slate-400">過去3期間で回収率90%超だった参考条件です。利益や将来の成績を保証するものではありません。</p>
    {error&&<div className="mt-2 flex items-center justify-between gap-2 text-xs text-amber-200"><span>現在オッズの照合を一時的に見合わせています。</span><button type="button" onClick={()=>setRetry(v=>v+1)} className="shrink-0 rounded border border-amber-300/40 px-2 py-1">再取得</button></div>}
    <div className="mt-3 space-y-3">{items.map(item=>{
      const rule=TREND_RULES.find(r=>r.id===item.ruleId);if(!rule)return null;
      const model=rule.policy.includes("EV"),policy=rule.policy.replace("単勝市場比EV","市場比較指標");
      return <article key={item.ruleId} className="rounded-xl border border-slate-700/70 bg-[#0b1727] p-3">
        <p className="text-sm font-bold">{TREND_BET_LABELS[rule.bet]} <span className="font-normal text-slate-300">／ {ruleDescription(rule)}</span></p>
        <p className="mt-1 text-xs text-cyan-200">{model?"単勝オッズとの比較条件・最大3点":policy}</p>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1"><p className="text-xs text-slate-400">過去の回収率 <strong className="ml-1 text-lg text-white">{pct(rule.overall.roi)}</strong></p><p className="text-xs text-slate-400">対象 {rule.overall.races.toLocaleString()}レース</p></div>
        <p className="mt-1 text-[11px] text-slate-400">最大払戻1件を除いても、各期間90%超</p>
        {item.state==="ready"?<details className="mt-3 border-t border-slate-700/60 pt-2"><summary className="cursor-pointer text-sm font-semibold text-cyan-200">{saved?"保存した対象買い目":"対象の買い目を見る"}（{item.selections.length}点）</summary><p className="mt-2 text-xs text-slate-400">オッズ取得：{stamp(item.fetchedAt)} ／ 1点100円の検証条件</p><ul className="mt-2 space-y-1">{item.selections.map(q=><li key={q.numbers.join("-")} className="flex justify-between gap-3 rounded bg-slate-800/60 px-3 py-2 text-sm"><span>{rule.bet==="bracket_quinella"?"枠 ":""}{q.numbers.join("－")}</span><span>{q.odds.toFixed(1)}倍</span></li>)}</ul>{item.saved?<p className="mt-2 text-[11px] text-slate-400">発走前の取得オッズと対象買い目をサーバーに保存済み</p>:<p className="mt-2 text-[11px] text-amber-200">検証用の保存は未確認です</p>}{item.settlement?.status==="settled"&&<p className="mt-2 text-xs text-emerald-200">実払戻 {item.settlement.returnYen?.toLocaleString()}円 ／ 検証購入額 {100*item.selections.length}円</p>}{item.settlement?.status==="excluded"&&<p className="mt-2 text-xs text-slate-400">取消・同着などを含むため、回収率の集計対象外です</p>}</details>:<p className="mt-2 text-xs text-amber-200">{item.note??"必要なオッズ・レース条件を照合しています"}</p>}
        <details className="mt-2"><summary className="cursor-pointer text-xs text-slate-400">詳しい検証結果</summary><div className="mt-2 space-y-2 text-xs">{rule.periods.map(p=><div key={p.label} className="rounded bg-slate-800/60 p-2"><p>{p.label}：{p.date_from}〜{p.date_to}</p><p className="mt-1">回収率 {pct(p.roi)} ／ 最大払戻除外後 {pct(p.roi_without_largest_ticket)} ／ {p.races.toLocaleString()}レース</p></div>)}<p>買い方：{policy}</p>{model&&<p>単勝オッズから計算した参考確率と、この券種のオッズを比較する計算条件です。真の的中確率ではありません。</p>}<p>確定オッズによる履歴から抽出した候補です。現在オッズでの判定は暫定です。低オッズ順に最大3点を選び、同じオッズでは番号順で決定します。</p></div></details>
      </article>;
    })}</div>
    {items.length>1&&<p className="mt-3 text-[11px] text-slate-400">複数の条件に同じ買い目が含まれる場合があります。</p>}
  </section>;
}
