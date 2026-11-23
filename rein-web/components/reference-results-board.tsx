"use client";
import { useEffect, useState } from "react";
import { filterReferenceRaces, type ReferenceBoard } from "@/lib/reference-results";
export function ReferenceResultsBoard({ league, onOpen }: { league: "jra" | "nar"; onOpen: (id: string) => void }) {
  const [board,setBoard] = useState<ReferenceBoard | null>(null), [error,setError] = useState(""), [hitsOnly,setHitsOnly] = useState(false);
  const [venue,setVenue] = useState(""), [betType,setBetType] = useState(""), [group,setGroup] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setBoard(null); setError(""); setVenue(""); setBetType(""); setGroup("");
    async function load() {
      try {
        const response = await fetch(`${league === "nar" ? "/api/nar" : "/api/analyze"}/reference-results`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.races)) throw new Error(body.error || "参考買い目の結果を取得できませんでした");
        setBoard(body); setError("");
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "取得できませんでした"); }
    }
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); },60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [league]);
  const allRaces = board?.races ?? [];
  const venues = [...new Set(allRaces.map(r => r.venue).filter(Boolean))];
  const betTypes = [...new Set(allRaces.flatMap(r => r.lines.map(l => l.type)))];
  const races = filterReferenceRaces(allRaces, { venue, type: betType, group, hitsOnly });
  const filtered = !!venue || !!betType || !!group || hitsOnly;
  return <section aria-label="本日のREIN参考買い目の的中結果" className="mt-5 rounded-2xl border border-cyan-400/30 bg-[#0c192a] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-bold text-cyan-100">📊 本日のREIN参考買い目 的中結果</h2>
      <div className="flex gap-1 rounded-lg bg-black/20 p-1 text-sm" data-no-swipe>{([false,true] as const).map(value => <button type="button" key={String(value)} aria-pressed={hitsOnly === value} onClick={() => setHitsOnly(value)} className={`rounded-md px-3 py-2 font-bold ${hitsOnly === value ? "bg-cyan-300 text-[#07111f]" : "text-slate-400"}`}>{value ? "的中のみ" : "すべて"}</button>)}</div>
    </div>
    <p className="mt-2 text-sm leading-6 text-slate-400">発走前に保存した参考買い目（本線・対抗・穴）を確定結果と照合します。払戻は各買い目100円購入時の合計です。</p>
    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3" data-no-swipe>
      {[{ label: "競馬場", value: venue, change: setVenue, options: venues, all: "すべての場" },
        { label: "券種", value: betType, change: setBetType, options: betTypes, all: "すべての券種" },
        { label: "買い目区分", value: group, change: setGroup, options: ["本線","対抗","穴"], all: "本線・対抗・穴すべて" }].map(field => <label key={field.label} className="min-w-0 text-sm text-slate-300">
          <span>{field.label}</span>
          <span className="relative mt-1 block"><select aria-label={field.label} value={field.value} onChange={e => field.change(e.target.value)} className="min-h-11 w-full appearance-none rounded-lg border border-slate-600 bg-[#0b1727] py-2 pl-3 pr-9 text-base text-white focus:border-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-300">
            <option value="">{field.all}</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}
          </select><svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"><path d="m5 7 5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
        </label>)}
    </div>
    {board && <div className="mt-2 flex items-center justify-between gap-2 text-sm text-slate-400"><p aria-live="polite">{races.length}レースを表示</p>{filtered && <button type="button" className="min-h-11 rounded-lg px-3 text-cyan-200 hover:bg-white/5" onClick={() => { setVenue(""); setBetType(""); setGroup(""); setHitsOnly(false); }}>絞り込みを解除</button>}</div>}
    {error && <p role="status" className="mt-3 text-sm text-amber-200">{error}</p>}
    {!board && !error && <p role="status" className="mt-3 text-sm text-slate-400">確認中…</p>}
    {board && !races.length && <p className="mt-3 text-sm text-slate-400">{filtered ? "選択した条件に該当する参考買い目はありません。" : "本日の参考買い目は準備中です。"}</p>}
    <ul className="mt-3 space-y-3">{races.map(race => <li key={race.raceId} className="rounded-xl border border-slate-700/70 bg-[#0b1727] p-3">
      <button type="button" onClick={() => onOpen(race.raceId)} className="flex w-full gap-3 text-left hover:text-cyan-200"><span className="shrink-0 text-cyan-200">{race.start}</span><span className="min-w-0 truncate font-bold">{race.venue}{race.number}R <span className="font-normal text-slate-300">{race.title}</span></span></button>
      {!race.saved ? <p className="mt-2 text-sm text-slate-400">{race.finished || (race.startsAt !== null && race.startsAt <= Date.now()) ? "発走前の参考買い目の保存なし" : "参考買い目の保存待ち"}</p> : <>
        <p className="mt-1 text-sm text-slate-400">発走前に保存</p>
        <div className="mt-2 space-y-2">{race.lines.map(line => <div key={`${line.type}:${line.group}`} className="text-sm">
          <p><strong>{line.type} ／ {line.group}</strong><span className={`ml-2 font-semibold ${line.status === "hit" ? "text-emerald-300" : "text-slate-400"}`}>{line.status === "hit" ? `的中 ${line.returnYen.toLocaleString()}円` : line.status === "miss" ? "不的中" : line.status === "excluded" ? "取消・除外あり（判定対象外）" : line.status === "unavailable" ? "払戻確認中" : "結果待ち"}</span></p>
          <p className="mt-1 break-words text-slate-300">{line.selections.join(" ／ ")}</p>
        </div>)}</div>
      </>}
    </li>)}</ul>
  </section>;
}
