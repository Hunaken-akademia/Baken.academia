"use client";
import { useMemo } from "react";
import type { Horse } from "@/lib/horse-types";
import { buildPopularityForecast, type PatternView } from "@/lib/popularity-forecast";
import { useRaceContext } from "@/components/race-context-panels";

type Race = {raceId:string;title:string;course:string;condition:string;league?:"jra"|"nar"};
function PatternList({title,items,horses,onHorse}:{title:string;items:PatternView[];horses:Horse[];onHorse:(h:Horse)=>void}) {
  return <div className="min-w-0 rounded-xl border border-slate-700 p-3"><h3 className="text-sm font-bold">{title}</h3>{items.length?<ol className="mt-3 space-y-3">{items.map(item=><li key={item.pattern} className="rounded-lg bg-black/20 p-3"><p className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xl tracking-wide text-violet-200">{item.pattern.replaceAll("-"," → ")}</strong><span className="text-[10px] text-slate-400">{item.rank}位・相対指数 {item.relativeScore}</span></p><p className="mt-1 text-[11px] text-slate-400">この型に合う馬の組み合わせ例（1着→2着→3着）</p><div className="mt-1 flex flex-wrap gap-1">{item.examples.map((n,i)=>{const h=horses.find(h=>h.number===n);return h?<button key={n} type="button" onClick={()=>onHorse(h)} aria-label={`${title} ${item.pattern} ${i+1}着候補 ${n} ${h.name}の詳細`} className="min-h-11 max-w-full rounded border border-violet-300/20 px-2 text-left text-xs text-slate-200">{i+1}着 {n} {h.name}<span className="block text-[10px] text-slate-400">{h.popularity}人気 / {h.odds?`${h.odds}倍`:"未取得"}</span></button>:null})}</div></li>)}</ol>:<p className="mt-3 text-xs text-slate-400">取得できたデータでは順位を算出できません。</p>}</div>;
}
export function PopularityForecast({horses,race,rolesReady,finished,predictionSafe,onHorse}:{horses:Horse[];race:Race;rolesReady:boolean;finished:boolean;predictionSafe:boolean;onHorse:(h:Horse)=>void}) {
  const state=useRaceContext(race);
  const forecast=useMemo(()=>buildPopularityForecast(horses,{rolesReady,trends:state.data?.trends,finished,predictionSafe}),[horses,rolesReady,state.data?.trends,finished,predictionSafe]);
  return <section aria-label="人気パターン予測" className="mb-5 min-w-0 rounded-2xl border border-violet-400/30 bg-[#0c192a] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-bold">今回の注目・人気パターン予測</h2><span className="rounded bg-amber-300/10 px-2 py-1 text-[10px] text-amber-200">試験表示・長期検証前</span></div>
    <p className="mt-2 text-xs leading-6 text-slate-300">A＝1〜3人気 / B＝4〜6人気 / C＝7〜9人気 / D＝10人気以下。1着→2着→3着の型を、今回の出走馬から比較します。</p>
    {forecast.review&&<p className="mt-2 rounded bg-amber-300/10 p-2 text-xs text-amber-100">発走前の保存データによる振り返りです。発走前に記録したパターンそのものではありません。</p>}
    {forecast.reason?<p role="status" className="mt-3 text-sm text-amber-100">{forecast.reason}</p>:<>
      <div className="mt-4 grid gap-3 lg:grid-cols-2"><PatternList title="① 適性表だけの参考予測" items={forecast.table} horses={horses} onHorse={onHorse}/><PatternList title="② REIN＋当日傾向の注目パターン" items={forecast.combined} horses={horses} onHorse={onHorse}/></div>
      <p className="mt-3 text-xs leading-6 text-slate-300">①は取得済みの{forecast.tableRows.join("・")||"条件別実績"}を使用（{forecast.tableKnown}/{forecast.total}頭に実績あり）。②の基礎は{forecast.basis}です。{forecast.model[0]&&`当日補正前の最上位は ${forecast.model[0].pattern.replaceAll("-","→")}。`}</p>
    </>}
    <div className="mt-4 rounded-xl border border-slate-700 p-3"><h3 className="text-sm font-bold">このレースより前の、当日の決着傾向</h3>{state.loading?<p className="mt-2 text-xs text-slate-400">同場・同じ芝／ダートの先行結果を確認中…</p>:state.error?<p role="status" className="mt-2 text-xs text-amber-100">当日傾向を取得できず、今回の適性だけで表示しています。<button type="button" onClick={state.retry} className="ml-2 min-h-11 underline">再取得</button></p>:<><p className="mt-2 text-xs leading-6 text-slate-300">確定人気を確認できた{forecast.dayRaces}レース。{forecast.dayApplied?"3レース以上あるため、頻出型を小さく補助加点しています。":"少数または該当結果なしのため、当日補正は加えていません。"}</p>{forecast.observations.length>0&&<ul className="mt-2 flex flex-wrap gap-2 text-xs">{forecast.observations.slice(0,5).map(row=><li key={row.pattern} className="rounded bg-violet-300/10 px-3 py-2"><strong>{row.pattern.replaceAll("-","→")}</strong>：{row.count}/{forecast.dayRaces}レース</li>)}</ul>}</>}
      <p className="mt-2 text-[11px] leading-5 text-slate-400">現在・後続レースを除外し、選択レースの発走前に保存された先行結果だけを使用。少数の当日傾向が次も続くとは限りません。</p>
    </div>
    <details className="mt-3 text-xs leading-6 text-slate-400"><summary className="min-h-8 cursor-pointer font-semibold">予測の仕組みと限界</summary><p>①は適性表の勝率・3着内率を少数補正して、着順別の参考スコアに変換します。通算と条件別実績は重複するので出走数は合算しません。未取得項目は除外し、全項目未取得の馬は出走馬平均の中立スコアで計算します。</p><p>②は既存AIの1〜3着適性を使い、同じ馬が重複しない全組み合わせを人気パターン別に集約します。着順間の相互作用を学習した専用モデルではありません。当日3レース以上ある場合だけ、頻出型に上限30%の参考加点をします。</p><p>相対指数は各表示内の最上位を100とする比較値で、的中確率ではありません。①と②の指数は直接比較できません。このパターン選定・当日補正の長期的な的中率と回収率は未検証です。</p></details>
  </section>;
}
