"use client";
import { useEffect,useState } from "react";
import { TREND_RULES,TREND_BET_LABELS,ruleDescription } from "@/lib/odds-trends";
import { isVenueRule,readyItems,type BoardRace,type OddsTrendBoard as Board } from "@/lib/odds-trend-board";

const ruleOf=(id:string)=>TREND_RULES.find(rule=>rule.id===id);
const venueOnly=(race:BoardRace)=>({...race,items:race.items.filter(item=>{const rule=ruleOf(item.ruleId);return !!rule&&isVenueRule(rule);})});
function settlementLabel(settlement?:{status:string;returnYen:number|null}) {
  if(settlement?.status==="excluded")return {text:"対象外",tone:"text-slate-400"};
  if(settlement?.status!=="settled")return null;
  return settlement.returnYen?{text:`的中 ${settlement.returnYen.toLocaleString()}円`,tone:"text-emerald-300"}:{text:"不的中",tone:"text-slate-400"};
}
export function OddsTrendBoard({ league,onOpen }:{ league:"jra"|"nar"; onOpen:(raceId:string)=>void }) {
  const [board,setBoard]=useState<Board|null>(null),[error,setError]=useState(""),[venueFilter,setVenueFilter]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setBoard(null);setError("");
    async function load(){
      try{
        const response=await fetch(`${league==="nar"?"/api/nar":"/api/analyze"}/odds-trends/board`,{cache:"no-store",signal:controller.signal});
        const body=await response.json().catch(()=>({})) as Board&{error?:string};
        if(!response.ok||!Array.isArray(body.races))throw new Error(body.error||"条件該当レースを取得できませんでした");
        setBoard(body);setError("");
      }catch(value){if(!controller.signal.aborted)setError(value instanceof Error?value.message:"条件該当レースを取得できませんでした");}
    }
    void load();
    const timer=setInterval(()=>{if(document.visibilityState==="visible")void load();},60_000);
    return()=>{controller.abort();clearInterval(timer);};
  },[league]);
  const races=(board?.races??[]).map(race=>venueFilter?venueOnly(race):race).filter(race=>race.items.length>0);
  const ready=races.filter(race=>readyItems(race).length>0);
  const upcoming=races.filter(race=>!readyItems(race).length&&(race.phase==="scheduled"||race.phase==="provisional")&&race.items.some(item=>item.state==="waiting"));
  return <section aria-label="本日の条件該当買い目" data-testid="odds-trend-board" className="mt-5 rounded-2xl border border-cyan-400/30 bg-[#0c192a] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-bold text-cyan-100">📊 本日のオッズ条件 該当買い目</h2>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/20 p-1 text-xs" data-no-swipe>
        {([[false,"すべて"],[true,"場別のみ"]] as const).map(([value,label])=><button key={label} type="button" aria-pressed={venueFilter===value} onClick={()=>setVenueFilter(value)} className={`rounded-md px-3 py-1.5 font-bold ${venueFilter===value?"bg-cyan-300 text-[#07111f]":"text-slate-400"}`}>{label}</button>)}
      </div>
    </div>
    <p className="mt-1 text-xs leading-5 text-slate-400">発走75分前から現在オッズで照合し、条件に当てはまった買い目をまとめます。過去検証に基づく参考で、利益を保証するものではありません。</p>
    {error?<p role="status" className="mt-3 text-sm text-amber-200">{error}</p>
      :!board?<p role="status" className="mt-3 text-sm text-slate-400">確認中…</p>
      :<>
        {board.error&&<p role="status" className="mt-3 text-sm text-amber-200">{board.error}</p>}
        {ready.length?<ul className="mt-3 space-y-3">{ready.map(race=><li key={race.raceId} className="rounded-xl border border-slate-700/70 bg-[#0b1727]">
          <button type="button" onClick={()=>onOpen(race.raceId)} className="flex w-full items-baseline gap-3 px-3 pt-3 text-left hover:text-cyan-200">
            <span className="w-12 shrink-0 text-sm font-semibold text-cyan-200">{race.start||"--:--"}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-bold">{race.venue}{race.number}R <span className="font-normal text-slate-300">{race.title}</span></span>
            <span className="shrink-0 text-[11px] text-slate-400">{race.phase==="saved-prestart"?"発走前に保存":"現在オッズ"}</span>
          </button>
          <div className="space-y-2 p-3">{readyItems(race).map(item=>{const rule=ruleOf(item.ruleId);if(!rule)return null;const settled=settlementLabel(item.settlement);return <div key={item.ruleId}>
            <p className="text-xs text-slate-300"><strong className="text-white">{TREND_BET_LABELS[rule.bet]}</strong> ／ {ruleDescription(rule)}{isVenueRule(rule)&&<span className="ml-1 rounded bg-cyan-300/15 px-1 text-[10px] text-cyan-200">場別</span>}{settled&&<span className={`ml-2 font-semibold ${settled.tone}`}>{settled.text}</span>}</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">{item.selections.map(q=><li key={q.numbers.join("-")} className="rounded bg-slate-800/70 px-2 py-1 text-sm">{rule.bet==="bracket_quinella"?"枠 ":""}{q.numbers.join("－")}<span className="ml-1.5 text-xs text-amber-200">{q.odds.toFixed(1)}倍</span></li>)}</ul>
          </div>;})}</div>
        </li>)}</ul>:<p className="mt-3 text-sm text-slate-400">{races.length?"現時点で条件に当てはまった買い目はありません。":`本日、${venueFilter?"場別条件の":"条件の"}対象になりうるレースはありません。`}</p>}
        {upcoming.length>0&&<details className="mt-3 text-sm"><summary className="cursor-pointer text-xs text-slate-400">これから照合するレース（{upcoming.length}件）</summary>
          <ul className="mt-2 divide-y divide-slate-800">{upcoming.map(race=><li key={race.raceId}><button type="button" onClick={()=>onOpen(race.raceId)} className="flex w-full gap-3 py-2 text-left hover:bg-white/[.03]">
            <span className="w-12 shrink-0 text-cyan-200">{race.start||"--:--"}</span>
            <span className="min-w-0 flex-1 truncate">{race.venue}{race.number}R <span className="text-xs text-slate-400">{[...new Set(race.items.map(item=>{const rule=ruleOf(item.ruleId);return rule?TREND_BET_LABELS[rule.bet]:"";}).filter(Boolean))].join("・")}の条件</span></span>
          </button></li>)}</ul>
        </details>}
      </>}
  </section>;
}
