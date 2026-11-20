"use client";
import { useMemo, useState } from "react";
import { compactSelections, type Ticket } from "@/lib/tickets";
import { allTabStats, buildBetTabs, naviBase, naviKey, naviStat, NAVI_LABELS, raceType, statsPeriod, tabStats, type TabKey } from "@/lib/bet-tabs";
import { checkPick, MAX_PICK, type PickHorse, type PickMarks } from "@/lib/my-pick-check";
import type { League } from "@/lib/race-finder";

const markTone: Record<string, string> = { "◎": "text-amber-300", "○": "text-sky-200", "△": "text-slate-300", "✕": "text-rose-300" };
const roiTone = (roi: number) => roi >= 85 ? "text-amber-300 font-bold" : roi < 70 ? "text-rose-300" : "text-slate-100";
const naviTone = { teppan: "border-amber-300/60 bg-amber-300/[.07]", solid: "border-sky-300/40 bg-sky-300/[.05]", middle: "border-slate-500/50 bg-white/[.02]", rough: "border-rose-400/50 bg-rose-400/[.06]" };

type Horse = { number: number; odds: number | null };

// 狙い目ナビ：このレースの型と、同じ型のレースの過去の傾向。
export function RaceNavi({ league, horses, main }: { league: League; horses: Horse[]; main: number | null | undefined }) {
  const type = raceType(league, horses, main);
  if (!type) return <section aria-label="狙い目ナビ" data-testid="race-navi" className="mt-3 rounded-xl border border-slate-700 bg-[#0c192a] p-3 text-xs text-slate-400">🎯 狙い目ナビ：全頭の単勝オッズがそろうと、このレースの型を判定します。</section>;
  const key = naviKey(league, type), meta = NAVI_LABELS[key], s = naviStat(league, key), base = naviBase(league);
  return <section aria-label="狙い目ナビ" data-testid="race-navi" data-navi={key} className={`mt-3 rounded-xl border p-3 ${naviTone[key]}`}>
    <p className="text-xs text-slate-300">🎯 狙い目ナビ</p>
    <p className="mt-1 text-lg font-bold text-white">{meta.icon} {meta.label}</p>
    <p className="text-xs leading-5 text-slate-300">{meta.text}</p>
    <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
      <div className="rounded-lg bg-black/20 p-2"><dt className="text-[10px] text-slate-400">1番人気の勝率</dt><dd className="text-base font-bold">{s.favWin}%</dd><dd className="text-[10px] text-slate-500">全体 {base.favWin}%</dd></div>
      <div className="rounded-lg bg-black/20 p-2"><dt className="text-[10px] text-slate-400">1番人気の3着内</dt><dd className="text-base font-bold">{s.favTop3}%</dd><dd className="text-[10px] text-slate-500">全体 {base.favTop3}%</dd></div>
      <div className="rounded-lg bg-black/20 p-2"><dt className="text-[10px] text-slate-400">3連複が万馬券</dt><dd className="text-base font-bold">{s.trioMan}%</dd><dd className="text-[10px] text-slate-500">全体 {base.trioMan}%</dd></div>
    </dl>
    <p className="mt-2 text-[10px] leading-4 text-slate-500">同じ型だった過去{s.races.toLocaleString()}R（{statsPeriod(league).range}）。型は今のオッズで判定するので、発走までに変わることがあります。{league === "jra" ? "中央はREINの本命が1番人気かどうかで差が出なかったため、鉄板の判定はしていません。" : ""}</p>
  </section>;
}

// 買い方タブ：今の参考買い目を目的別に組み替え、同じ型のレースでの過去の成績と印を付ける。
export function BetTabs({ league, horses, main, tickets, held }: { league: League; horses: Horse[]; main: number | null | undefined; tickets: Ticket[]; held: boolean }) {
  const type = raceType(league, horses, main);
  const built = useMemo(() => type ? buildBetTabs(league, tickets, type) : null, [league, tickets, type?.kind, type?.teppan]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<TabKey | null>(null);
  if (held) return null;
  if (!type || !built) return <section aria-label="買い方タブ" data-testid="bet-tabs" className="mt-3 rounded-xl border border-slate-700 bg-[#0c192a] p-3 text-xs text-slate-400">買い方タブ：全頭の単勝オッズがそろうと表示します。</section>;
  const active = built.tabs.find(t => t.key === (picked ?? built.recommended ?? "single")) ?? built.tabs[0];
  const period = statsPeriod(league), rows = tabStats(league, type.statKinds), all = allTabStats(league);
  return <section aria-label="買い方タブ" data-testid="bet-tabs" className="mt-3 rounded-xl border border-amber-300/30 bg-[#0c192a] p-3">
    <div className="flex items-baseline justify-between gap-2">
      <h2 className="text-sm font-bold text-amber-100">買い方タブ</h2>
      <span className="text-[11px] text-slate-400">このレースは<b className="text-white">{type.teppan && league === "nar" ? "鉄板" : type.label}</b></span>
    </div>
    <div role="tablist" aria-label="買い方" className="mt-2 flex gap-1 overflow-x-auto pb-1" data-no-swipe>
      {built.tabs.map(t => <button key={t.key} role="tab" type="button" aria-selected={active.key === t.key} onClick={() => setPicked(t.key)}
        className={`min-h-11 shrink-0 rounded-lg border px-3 text-sm ${active.key === t.key ? "border-amber-300 bg-amber-300/15 font-bold text-amber-100" : "border-slate-700 text-slate-300"} ${t.skip ? "opacity-50" : ""}`}>
        {t.key === built.recommended && <span className="mr-1 text-[10px] text-amber-300">おすすめ</span>}{t.label}{t.mark && <span className={`ml-1 ${markTone[t.mark]}`}>{t.mark}</span>}
      </button>)}
    </div>
    <div role="tabpanel" className="mt-2 rounded-lg border border-slate-800 bg-black/15 p-3" data-testid="bet-tab-panel">
      <p className="text-xs text-slate-400">{active.detail}</p>
      {active.skip ? <p className="mt-2 text-sm text-slate-300">{active.skip}</p> : <>
        <p className="mt-2 text-xs text-slate-300">{active.type}・{active.selections.length}点</p>
        <p className="mt-1 font-mono text-sm leading-7 text-white">{compactSelections(active.selections).join(" / ")}</p>
      </>}
      {active.stat && <p className="mt-2 text-xs text-slate-300">同じ型のレースで 的中率 <b className="text-white">{active.stat.hitRate}%</b>・回収率 <b className={roiTone(active.stat.roi)}>{active.stat.roi}%</b><span className="text-slate-500">（{active.stat.races.toLocaleString()}R）</span></p>}
    </div>
    <details className="mt-2" data-testid="bet-tab-stats">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-amber-200">この型のレースで、タブの成績を比べる</summary>
      <table className="w-full text-xs">
        <thead><tr className="text-slate-400"><th className="py-1 text-left font-normal">買い方</th><th className="text-right font-normal">レース</th><th className="text-right font-normal">的中率</th><th className="text-right font-normal">回収率</th><th className="text-right font-normal">全レース</th></tr></thead>
        <tbody>{rows.map(r => { const t = built.tabs.find(x => x.key === r.key), a = all.find(x => x.key === r.key);
          return <tr key={r.key} className={`border-t border-slate-800 ${r.key === active.key ? "bg-amber-300/10" : ""}`}>
            <td className="py-1.5">{r.label}{t?.mark && <span className={`ml-1 ${markTone[t.mark]}`}>{t.mark}</span>}{r.few && <span className="text-slate-500">†</span>}</td>
            <td className="text-right">{r.races.toLocaleString()}</td><td className="text-right">{r.hitRate}%</td><td className={`text-right ${roiTone(r.roi)}`}>{r.roi}%</td>
            <td className="text-right text-slate-400">{a ? `${a.roi}%` : "—"}</td>
          </tr>; })}</tbody>
      </table>
      <p className="mt-2 text-[10px] leading-4 text-slate-500">{period.range}・1点100円・払戻は実際の配当。{period.note ? `${period.note}。` : ""}印は同じ型での回収率が高い順に◎○△、70%未満は✕。†はレース数が少なく参考程度。過去の成績で、これからも同じになるとは限りません。</p>
    </details>
  </section>;
}

// 自分の予想チェック：選んだ馬について、見落とし→気になる点→当たる見込みの順に出す（買い目は出さない）。
export function MyPickCheck({ horses, marks, scratched }: { horses: PickHorse[]; marks: PickMarks; scratched: number[] }) {
  const [selected, setSelected] = useState<number[]>([]);
  const out = new Set(scratched);
  const result = useMemo(() => checkPick(horses, selected, marks, scratched), [horses, selected, marks, scratched]);
  const toggle = (n: number) => setSelected(s => s.includes(n) ? s.filter(x => x !== n) : s.length >= MAX_PICK ? s : [...s, n].sort((a, b) => a - b));
  const tone = { miss: "border-amber-300/40 bg-amber-300/[.07] text-amber-100", warn: "border-rose-400/30 bg-rose-400/[.05] text-rose-100", good: "border-emerald-400/30 bg-emerald-400/[.05] text-emerald-100", info: "border-slate-600 text-slate-300" };
  const icon = { miss: "👀", warn: "⚠️", good: "✅", info: "ℹ️" };
  return <section aria-label="自分の予想チェック" data-testid="my-pick-check" className="mt-4 rounded-xl border border-cyan-300/30 bg-[#0c192a] p-3">
    <h2 className="text-sm font-bold text-cyan-100">📝 自分の予想チェック</h2>
    <p className="mt-1 text-xs leading-5 text-slate-400">買いたい馬を選ぶと（最大{MAX_PICK}頭）、REINのデータから見落としと気になる点を教えます。決めるのはあなたです。</p>
    <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="馬を選ぶ">
      {[...horses].sort((a, b) => a.number - b.number).map(h => <button key={h.number} type="button" aria-pressed={selected.includes(h.number)} disabled={out.has(h.number)} onClick={() => toggle(h.number)}
        className={`min-h-11 min-w-11 rounded-lg border px-2 text-sm font-bold ${selected.includes(h.number) ? "border-cyan-300 bg-cyan-300/20 text-white" : "border-slate-600 text-slate-300"} disabled:opacity-30`}>{h.number}</button>)}
    </div>
    {!selected.length ? <p className="mt-3 text-xs text-slate-500">馬番を押して選んでください。</p> : <>
      <ul className="mt-3 space-y-1.5" data-testid="pick-notes">{result.notes.map((n, i) => <li key={i} data-kind={n.kind} className={`rounded-lg border px-3 py-2 text-xs leading-5 ${tone[n.kind]}`}>{icon[n.kind]} {n.text}</li>)}
        {!result.notes.length && <li className="text-xs text-slate-400">気になる点は見つかりませんでした。</li>}</ul>
      {result.chances.length > 0 && <div className="mt-3 rounded-lg bg-black/20 p-3" data-testid="pick-chances">
        <p className="text-xs font-semibold text-slate-200">選んだ{selected.filter(n => !out.has(n)).length}頭で当たる見込み</p>
        <ul className="mt-1 divide-y divide-slate-800">{result.chances.map(c => <li key={c.label} className="flex justify-between py-1.5 text-xs"><span className="text-slate-300">{c.label}<span className="ml-1 text-slate-500">{c.points}点</span></span><b className="text-base text-white">{Math.round(c.value * 100)}%</b></li>)}</ul>
        <p className="mt-1 text-[10px] leading-4 text-slate-500">人気とREINの着順別評価から計算し、過去の結果に合わせて補正した見込みです（10/21〜11/20の確認で、見込み14%の馬が実際14.6%勝っています）。回収率や利益を示すものではありません。</p>
      </div>}
    </>}
  </section>;
}
