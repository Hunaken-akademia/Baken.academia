"use client";
import { useState } from "react";
import type { Horse } from "@/lib/horse-types";
import { POPULARITY_GROUPS, popularityGroup, popularityPattern } from "@/lib/race-day-trends";

export function PopularityGroups({ horses, onHorse }: { horses: Horse[]; onHorse: (horse: Horse) => void }) {
  const [selected, setSelected] = useState<number[]>([]);
  const chosen = POPULARITY_GROUPS.flatMap(group => horses.filter(h => selected.includes(h.number) && popularityGroup(h.popularity) === group.id).slice(0, 3));
  const toggle = (horse: Horse) => setSelected(current => {
    const valid = horses.filter(h=>current.includes(h.number));
    if (current.includes(horse.number)) return current.filter(n=>n!==horse.number);
    return valid.filter(h=>popularityGroup(h.popularity)===popularityGroup(horse.popularity)).length < 3 ? [...current,horse.number] : current;
  });
  return <section aria-label="人気グループから候補を選ぶ" className="mb-5 rounded-2xl border border-violet-400/30 bg-[#0c192a] p-4 sm:p-5">
    <h2 className="text-lg font-bold">人気グループから候補を選ぶ</h2><p className="mt-1 text-xs leading-6 text-slate-300">各グループから1〜3頭を選び、組み合わせを考えられます。表示中の人気で分類し、オッズ更新で所属が変わる場合があります。</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">{POPULARITY_GROUPS.map(group=>{
      const members=horses.filter(h=>popularityGroup(h.popularity)===group.id).sort((a,b)=>a.popularity-b.popularity||a.number-b.number);
      const count=chosen.filter(h=>popularityGroup(h.popularity)===group.id).length;
      return <div key={group.id} className="rounded-xl border border-slate-700 p-3"><h3 className="flex justify-between gap-2 font-bold"><span className="text-violet-200">{group.id} <span className="text-sm text-slate-300">{group.label}</span></span><span className="text-xs font-normal text-slate-400">選択 {count}/3頭</span></h3><div className="mt-2 space-y-2">{members.map(h=>{
        const checked=chosen.some(c=>c.number===h.number);
        return <div key={h.number} className="flex items-center gap-2 rounded-lg bg-black/20 p-2"><button type="button" aria-label={`${group.id}グループ ${h.number} ${h.name}を候補${checked?"から外す":"に追加"}`} aria-pressed={checked} disabled={!checked&&count>=3} onClick={()=>toggle(h)} className={`min-h-11 min-w-11 rounded-lg border text-sm font-bold disabled:opacity-40 ${checked?"border-violet-300 bg-violet-300/20 text-violet-100":"border-slate-600 text-slate-200"}`}>{checked?"✓ ":""}{h.number}</button><button type="button" onClick={()=>onHorse(h)} aria-label={`${h.number} ${h.name}の詳細を見る`} className="min-h-11 min-w-0 flex-1 text-left"><span className="block truncate text-sm font-semibold">{h.name}</span><span className="text-xs text-slate-400">{h.popularity}人気 / {typeof h.odds==="number"&&Number.isFinite(h.odds)&&h.odds>0?`${h.odds}倍`:"オッズ未取得"}</span></button></div>;
      })}</div>{!members.length&&<p className="mt-2 text-xs text-slate-500">該当馬なし</p>}</div>;
    })}</div>
    {horses.some(h=>!popularityGroup(h.popularity))&&<p className="mt-3 text-xs text-slate-400">人気未発表の馬はグループ分類を保留しています。</p>}
    <div role="status" className="mt-3 rounded-xl bg-violet-300/10 p-3 text-sm leading-6"><p className="font-semibold text-violet-100">選んだ候補 {chosen.length}頭</p>{POPULARITY_GROUPS.map(g=>{const list=chosen.filter(h=>popularityGroup(h.popularity)===g.id);return list.length?<p key={g.id} className="text-xs text-slate-200">{g.id}：{list.map(h=>`${h.number} ${h.name}`).join(" / ")}</p>:null})}{!chosen.length&&<p className="text-xs text-slate-400">馬番ボタンを押して候補に追加してください。</p>}</div>
    {chosen.length>0&&<button type="button" onClick={()=>setSelected([])} className="mt-2 min-h-11 px-2 text-xs text-slate-300 underline">候補をクリア</button>}
    <p className="mt-2 text-[11px] leading-5 text-slate-400">候補はこの画面内の選択です。人気グループは能力評価のランクではありません。</p>
  </section>;
}

export function PopularityResult({ horses, finishers, finished }: { horses: Horse[]; finishers: Array<{number:number;finish:number;popularity?:number;odds?:number}>; finished:boolean }) {
  const result=finished?popularityPattern(finishers,horses):null;
  return <section aria-label="このレースの人気別決着" className="mb-5 rounded-2xl border border-violet-400/30 bg-[#0c192a] p-4"><h2 className="text-lg font-bold">このレースの人気別決着</h2><p className="mt-2 text-3xl font-black tracking-widest text-violet-200">{result?.pattern??(finished?"判定保留":"結果待ち")}</p><p className="mt-2 text-xs leading-5 text-slate-400">A＝1〜3人気 / B＝4〜6人気 / C＝7〜9人気 / D＝10人気以下。1着→2着→3着の順。</p>{result?<><p className="mt-2 text-xs text-slate-300">{result.finishers.map(f=>`${f.finish}着 ${f.number}番（${f.popularity}人気${typeof f.odds==="number"&&f.odds>0?`・${f.odds}倍`:""}）`).join(" → ")}</p><p className="mt-2 text-[11px] text-slate-400">分類基準：{result.source}。保存時点の人気は確定人気と異なる場合があります。</p></>:finished?<p className="mt-2 text-xs text-slate-400">上位同着・人気未取得など、1〜3着を一意に分類できない場合は保留します。</p>:null}</section>;
}
