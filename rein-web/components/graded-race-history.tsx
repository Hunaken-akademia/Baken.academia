"use client";

import {useState} from "react";
import {gradedEditionFlow,historicalPosition,type GradedFlowData} from "@/lib/graded-race-flow";
import {PACE_SCENARIOS,type PaceScenarioId} from "@/lib/pace-scenarios";
import {gradedHistoryForRace,type JraReferenceData,type JraRaceReference} from "@/lib/jra-reference";
import referenceData from "@/lib/jra-condition-reference.json";
import flowData from "@/lib/jra-graded-flow.json";

type Graded = NonNullable<NonNullable<JraRaceReference>["graded"]>;
const percent=(n:number|null)=>typeof n==="number"?`${(n*100).toFixed(1)}%`:"母数不足";

export function SavedGradedRaceHistory({race,onSimulate}:{race:{league?:string;title:string;raceId:string};onSimulate:(id:PaceScenarioId,label:string)=>void}) {
  const history=gradedHistoryForRace(referenceData as JraReferenceData,race);
  return history?<GradedRaceHistory key={race.raceId} {...history} onSimulate={onSimulate}/>:null;
}

export function GradedRaceHistory({graded,currentYear,onSimulate}:{graded:Graded;currentYear:number;onSimulate:(id:PaceScenarioId,label:string)=>void}) {
  const [selected,setSelected]=useState(graded.recent[0]?.date??"");
  const edition=graded.recent.find(e=>e.date===selected)??graded.recent[0];
  if(!edition)return null;
  const view=gradedEditionFlow(flowData as GradedFlowData,graded.name,edition,currentYear);
  const fieldSize=view.flow?.fieldSize??edition.fieldSize;
  const scenario=PACE_SCENARIOS.find(s=>s.id===view.scenario)!;
  const historicalLabel=`${edition.year}年 ${graded.name}：勝ち馬は${view.position}、序盤は${view.pace.label}`;
  const changed=edition.venue!==graded.recent[0].venue||edition.distanceM!==graded.recent[0].distanceM||edition.surface!==graded.recent[0].surface;
  return <section aria-label="重賞の過去傾向と展開" data-testid="graded-history" className="mb-5 min-w-0 rounded-2xl border border-amber-400/30 bg-gradient-to-br from-[#151d2b] to-[#0c192a] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-bold text-amber-300">定例重賞・過去傾向</p><h2 className="mt-1 text-lg font-bold">{graded.grade}・{graded.name}</h2></div><span className="rounded-full bg-amber-400/10 px-3 py-1 text-xs text-amber-200">当年を除く直近{graded.editions}回</span></div>
    <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-5">{[["1番人気の勝利",graded.favoriteWinRate],["1〜3番人気の勝利",graded.top3PopularityWinRate],["6番人気以下の勝利",graded.sixPlusWinRate],["10番人気以下が3着内",graded.tenPlusPlacedRate],["1〜4枠の勝利",graded.innerGateWinRate]].map(([label,value])=><div key={String(label)} className="min-w-0 rounded-xl border border-slate-700 bg-black/15 p-3"><p className="text-xs text-slate-400">{label}</p><p className="mt-1 text-lg font-bold">{percent(value as number|null)}</p></div>)}</div>
    <p className="mt-3 text-xs leading-5 text-slate-300">勝ち馬が最初の通過地点で3番手以内：{percent(graded.frontWinRate)}（通過順あり{graded.frontSamples}回）。</p>
    {(graded.venueChanges||graded.courseChanges)&&<p className="mt-2 text-xs text-amber-200">開催場・距離の変更年を含みます。年別の条件も確認してください。</p>}
    <h3 className="mt-4 font-bold">過去はどんな展開だった？</h3>
    <div role="group" aria-label="過去の重賞開催年" className="mt-3 flex flex-wrap gap-2" data-no-swipe>{graded.recent.map(e=><button type="button" key={e.date} aria-pressed={e.date===edition.date} onClick={()=>setSelected(e.date)} className={`min-h-11 rounded-lg border px-4 py-2 text-sm ${e.date===edition.date?"border-amber-300 bg-amber-300 font-bold text-slate-950":"border-slate-600 text-slate-200"}`}>{e.year}年</button>)}</div>
    <div className="mt-3 rounded-xl border border-slate-700 bg-black/15 p-4" aria-live="polite">
      <p className="text-sm font-semibold">{edition.year}年・{edition.venue} {edition.surface}{edition.distanceM}m・{edition.going}・{fieldSize}頭</p>
      {edition.officialName&&edition.officialName!==graded.name&&<p className="mt-1 text-xs text-amber-200">当時の名称：{edition.officialName}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2"><div className="rounded-lg bg-slate-900 p-3"><p className="text-xs text-slate-400">勝ち馬の最初の記録位置</p><p className="mt-1 font-bold text-cyan-200">{view.position}</p>{view.winner&&<p className="mt-1 text-xs">{view.winner.number} {view.winner.name}</p>}</div><div className="rounded-lg bg-slate-900 p-3"><p className="text-xs text-slate-400">序盤のペース</p><p className="mt-1 font-bold text-amber-200">{view.pace.label}</p><p className="mt-1 text-xs">前半{view.pace.earlyMeters}m {view.pace.earlySeconds?.toFixed(1)??"—"}秒 ／ 後半600m {view.pace.lateSeconds?.toFixed(1)??"—"}秒</p></div></div>
      <p className="mt-2 text-xs leading-5 text-slate-400">ペースは同じ重賞・場・芝ダート・距離・馬場状態の他年{view.pace.samples}回との比較です。前半{view.pace.earlyMeters}mが中央値より0.6秒以上遅ければ「ゆっくり」、0.6秒以上速ければ「速め」。3回未満は判定を保留します。</p>
      {view.pace.median!==null&&<p className="mt-1 text-xs text-slate-300">比較基準 {view.pace.median.toFixed(1)}秒 ／ この年は{view.pace.difference!>0?"+":""}{view.pace.difference!.toFixed(1)}秒</p>}
      {view.flow&&<p className="mt-3 text-sm text-cyan-100">上位馬の序盤：{view.flow.runners.map(r=>`${r.finish}着 ${historicalPosition(r.corners[0],fieldSize)}`).join(" ／ ")}</p>}
      {edition.surface!=="障害"&&<button type="button" onClick={()=>onSimulate(view.scenario,historicalLabel)} className="mt-4 min-h-12 w-full rounded-xl border border-violet-300 bg-violet-300/15 px-4 py-3 text-left text-sm font-bold text-violet-100">この年をヒントに展開を比較 → {scenario.label}</button>}
      {edition.surface==="障害"?<p className="mt-2 text-xs text-slate-400">障害重賞は過去結果を表示します。展開シミュレーションは平地競走に対応しています。</p>:<p className="mt-2 text-xs leading-5 text-slate-400">今年の出走馬で仮定を切り替えます。過去の実際の隊列は上の通過順位、シミュレーションは今年の参考想定です。前へ行く馬は変更できます。</p>}
      {view.flow ? <>
        <details className="mt-4 rounded-lg border border-slate-700 p-3"><summary className="min-h-9 cursor-pointer text-sm font-semibold">上位3頭の位置取り・実際のラップを見る</summary><div className="mt-3 space-y-2">{view.flow.runners.map(r=><div key={`${r.finish}:${r.number}`} className="rounded-lg border border-slate-700 p-3"><div className="flex flex-wrap gap-2 text-sm"><span className="font-bold text-cyan-200">{r.finish}着</span><span>{r.number} {r.name}</span><span className="text-xs text-slate-400">{historicalPosition(r.corners[0],fieldSize)}</span></div><p className="mt-2 text-xs text-slate-300">{r.corners.length?r.corners.map((n,i)=>`${r.stages[i]?.replace("通過順位","")||`${i+1}地点`}：${n}番手`).join(" → "):"通過順位の記録なし"}</p></div>)}</div>
        {view.flow.laps.length>0&&<details className="mt-3 rounded-lg border border-slate-700 p-3"><summary className="min-h-8 cursor-pointer text-sm font-semibold">実際のラップを確認する</summary><div className="mt-3 flex flex-wrap gap-2">{view.flow.laps.map((lap,i)=><div key={i} className="rounded-md bg-slate-900 px-3 py-2 text-center text-xs"><p className="text-slate-400">{(edition.distanceM%200||200)+i*200}m</p><p className="mt-1 font-bold text-cyan-200">{lap.toFixed(1)}秒</p></div>)}</div><p className="mt-2 text-xs text-slate-400">各区間の先頭通過ラップ。各馬個別の時計ではありません。</p></details>}
        <a href={view.flow.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block min-h-9 text-xs text-cyan-200 underline">JRA公式の結果・通過順位を確認</a></details>
      </>:<p className="mt-3 text-xs text-slate-400">公式の各コーナー記録・ラップは未取得です。保存済みの勝ち馬の通過位置を参考表示しています。</p>}
      <p className="mt-3 text-xs text-slate-300">勝ち馬 {edition.winnerPopularity?`${edition.winnerPopularity}番人気`:"人気不明"} ／ 3着内の人気 {edition.placedPopularities.join("・")||"不明"}</p>
      {changed&&<p className="mt-2 text-xs text-amber-200">最新の収録年と開催条件が異なる年です。今回のコースへそのまま当てはめないでください。</p>}
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-500">{graded.yearFrom}〜{graded.yearTo}年を集計。今回のレースの開催年以後の結果は集計に含めません。位置の区分は最初に記録されたコーナーによるものです。過去傾向は今回の的中確率ではありません。</p>
  </section>;
}
