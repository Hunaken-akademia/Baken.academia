"use client";
import type { Horse } from "@/lib/horse-types";
import { popularityPattern } from "@/lib/race-day-trends";

export function PopularityResult({ horses, finishers, finished }: { horses: Horse[]; finishers: Array<{number:number;finish:number;popularity?:number;odds?:number}>; finished:boolean }) {
  const result=finished?popularityPattern(finishers,horses):null;
  return <section aria-label="このレースの人気別決着" className="mb-5 rounded-2xl border border-violet-400/30 bg-[#0c192a] p-4"><h2 className="text-lg font-bold">このレースの人気別決着</h2><p className="mt-2 text-3xl font-black tracking-widest text-violet-200">{result?.pattern??(finished?"判定保留":"結果待ち")}</p><p className="mt-2 text-xs leading-5 text-slate-400">A＝1〜3人気 / B＝4〜6人気 / C＝7〜9人気 / D＝10人気以下。1着→2着→3着の順。</p>{result?<><p className="mt-2 text-xs text-slate-300">{result.finishers.map(f=>`${f.finish}着 ${f.number}番（${f.popularity}人気${typeof f.odds==="number"&&f.odds>0?`・${f.odds}倍`:""}）`).join(" → ")}</p><p className="mt-2 text-[11px] text-slate-400">分類基準：{result.source}。保存時点の人気は確定人気と異なる場合があります。</p></>:finished?<p className="mt-2 text-xs text-slate-400">上位同着・人気未取得など、1〜3着を一意に分類できない場合は保留します。</p>:null}</section>;
}
