"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CORNER_AUDIT_MAE, CORNER_MODEL_VERSION, courseStages, horseSequences, mapSlot, predictCorner, stagePosition, type MapHorse } from "@/lib/corner-reference";

const frameColors = ["#94a3b8", "#f8fafc", "#171717", "#dc433c", "#3778dc", "#f4d641", "#329249", "#ec9a30", "#d94c90"];
const styleOrder: Record<string, number> = { "逃げ": 1, "先行": 2, "好位": 3, "差し": 4, "追込": 5 };

export function RaceFormationMap({ horses, title, course, raceId, pace }: {
  horses: MapHorse[]; title: string; course: string; raceId: string; pace: string;
}) {
  const [mode, setMode] = useState("ai0");
  const [selected, setSelected] = useState<number | null>(null);
  const stages = courseStages(title, course);
  const year = raceId.length === 10 ? 2000 + Number(raceId.slice(0, 2)) : Number(raceId.slice(0, 4));
  const eligible = year >= 2025 && !!stages?.length;
  const options = [
    { id: "style", label: "脚質" },
    ...(eligible ? [{ id: "ai0", label: "AI序盤" }, ...stages.map((n) => ({ id: `ai${n}`, label: `AI${n}角` }))] : []),
    ...(stages?.length ? [{ id: "past3", label: "前走3角" }, { id: "past4", label: "前走4角" }] : []),
  ];
  const active = options.some((item) => item.id === mode) ? mode : "style";
  const ai = active.startsWith("ai");
  const past = active.startsWith("past");
  const corner = ai ? Number(active.slice(2)) : past ? Number(active.slice(4)) : 0;
  const curved = corner > 0;
  const projected = horses.map((horse) => {
    const estimate = ai ? predictCorner(horse, corner, horses.length, course) : null;
    const prior = past ? stagePosition(horseSequences(horse)[0] ?? [], corner) : null;
    const value = ai ? estimate?.position ?? null : past ? prior : styleOrder[horse.style] ?? null;
    return { horse, value, estimate };
  });
  const visible = projected.filter((p) => p.value !== null).sort((a,b) => a.value! - b.value! || a.horse.number-b.horse.number);
  const unknown = projected.filter((p) => p.value === null);
  const current = projected.find((p) => p.horse.number === selected);
  const tops = [...horses].filter((h) => (h.firstSuitability ?? 0) > 0).sort((a,b) => (b.firstSuitability ?? 0)-(a.firstSuitability ?? 0)).slice(0,3).map((h) => h.number);
  const modeLabel = options.find((item) => item.id === active)?.label;
  const legacy = horses.some((h) => h.mapPositions === undefined);

  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-emerald-400/25 bg-[#0c192a] text-white">
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-bold">隊列マップ</h2>
          <span className="rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200">{ai ? "AI位置取り予測 β" : past ? "前走の通過順位" : "近走の脚質傾向"}</span>
        </div>
        <p className="mt-2 text-sm text-slate-300">ペース想定：{pace}</p>
        <Tabs value={active} onValueChange={(next) => { setMode(next); setSelected(null); }} className="mt-4">
          <TabsList aria-label="隊列マップの場面" className="flex h-auto w-full flex-wrap justify-start gap-1 bg-[#071220] p-1">
            {options.map((option) => <TabsTrigger key={option.id} value={option.id} className="min-h-10 px-3 text-sm data-[state=active]:bg-emerald-600 data-[state=active]:text-white">{option.label}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
          {["逃げ", "先行", "好位", "差し", "追込"].map((style) => {
            const count = horses.filter((h) => h.style === style).length;
            return count ? <span key={style} className="rounded-full bg-white/5 px-2 py-1">{style} {count}頭</span> : null;
          })}
          <span className="rounded-full bg-white/5 px-2 py-1">{modeLabel}：{visible.length}/{horses.length}頭を配置</span>
        </div>
      </div>
      <div className="grid gap-5 px-4 pb-5 sm:px-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)]">
        <div className="min-w-0">
          <div className="relative mx-auto aspect-[400/330] w-full max-w-[640px] overflow-hidden rounded-2xl bg-[#78ac44]" aria-label={`${modeLabel}の隊列。先頭側から${visible.map((p) => p.horse.number).join("、")}番。間隔と横位置は表示上の配置です。`}>
            <svg viewBox="0 0 400 330" className="absolute inset-0 h-full w-full" aria-hidden="true">
              <rect width="400" height="330" fill="#91be59" />
              {curved ? <>
                <path d="M 165 18 A 147 147 0 0 1 18 165 L 0 165 L 0 0 L 165 0 Z" fill="#487e38" />
                <path d="M 165 0 L 165 18 A 147 147 0 0 1 18 165 L 0 165" fill="none" stroke="#fff" strokeWidth="4" />
                <path d="M 340 18 A 322 322 0 0 1 18 340" fill="none" stroke="#dcecbe" strokeWidth="2" strokeDasharray="7 6" />
                <path d="M 211 18 A 193 193 0 0 1 18 211 M 267 18 A 249 249 0 0 1 18 267" fill="none" stroke="#c6de99" strokeWidth="1" />
                <text x="29" y="60" fill="#e7f2dd" fontSize="15" fontWeight="700">{corner}コーナー</text>
                <text x="29" y="83" fill="#d4e5c6" fontSize="11">形状は模式図</text>
                <text x="28" y="124" fill="#f0f7e8" fontSize="14" fontWeight="700">↓ 先頭側</text>
                <text x="294" y="38" fill="#183422" fontSize="14" fontWeight="700">後方側</text>
              </> : <>
                <rect width="400" height="63" fill="#cfe5eb" />
                <path d="M0 69 H400" stroke="#fff" strokeWidth="5" />
                <path d="M0 286 H400" stroke="#dcecbe" strokeWidth="3" strokeDasharray="9 7" />
                <text x="23" y="39" fill="#173e40" fontSize="15" fontWeight="700">← 先頭側</text>
                <text x="317" y="39" fill="#173e40" fontSize="15" fontWeight="700">後方側</text>
                <text x="200" y="316" textAnchor="middle" fill="#183422" fontSize="12">{active === "style" ? "脚質の傾向順" : "最初の通過地点の位置取り"}</text>
              </>}
            </svg>
            {visible.map((entry, index) => {
              const { horse } = entry;
              const point = mapSlot(index, visible.length, curved);
              const topIndex = tops.indexOf(horse.number);
              const ring = topIndex >= 0 ? ["#fb7185", "#fb923c", "#fde047"][topIndex] : "transparent";
              return <button key={horse.number} type="button" aria-pressed={selected === horse.number} aria-label={`${horse.number}番 ${horse.name} ${ai && entry.estimate ? `推定${entry.estimate.position.toFixed(1)}番手` : past ? `前走${entry.value}番手` : horse.style}`} onClick={() => setSelected(horse.number)} className="absolute flex h-[44px] w-[44px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-cyan-700" style={{ left: `${point.x/4}%`, top: `${point.y/3.3}%` }}>
                <span className="flex size-7 items-center justify-center rounded-full border-2 border-white text-sm font-extrabold shadow-md sm:size-11 sm:text-xl" style={{ background: frameColors[horse.gate ?? 0] ?? frameColors[0], color: horse.gate === 1 || horse.gate === 5 || horse.gate === 7 ? "#111827" : "#fff", boxShadow: `0 0 0 ${selected === horse.number ? 5 : 3}px ${selected === horse.number ? "#164e63" : ring}, 0 3px 7px #173e4055` }}>{horse.number}</span>
              </button>;
            })}
            {!visible.length && <div className="absolute inset-x-6 top-1/2 rounded-xl bg-[#10233a]/95 p-4 text-center text-sm leading-6">この場面を推定できる通過順データがありません。<br/>データのない馬は無理に配置しません。</div>}
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-400">丸の色＝枠色。赤・橙・黄のリング＝1着適性の上位3頭。馬番をタップで詳細。前後の順を図示し、間隔・内外の配置は見やすさのための調整です。</p>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="rounded-xl border border-slate-700 bg-black/10 p-4" aria-live="polite">
            {current ? <>
              <p className="font-bold">{current.horse.number}　{current.horse.name}</p>
              <p className="mt-2 text-sm text-emerald-200">{current.estimate ? `推定 ${current.estimate.position.toFixed(1)}番手 / 目安 ${current.estimate.low}〜${current.estimate.high}番手` : past ? current.value === null ? "該当コーナーの記録なし" : `前走 ${current.value}番手` : `近走の脚質：${current.horse.style}`}</p>
              <p className="mt-2 break-words text-xs leading-5 text-slate-400">近走通過順（新しい順）：{horseSequences(current.horse).map((s) => s.join("-")).join(" / ") || "未取得"}</p>
              {current.estimate && <p className="mt-1 text-xs text-slate-400">この地点の履歴 {current.estimate.samples}走。履歴が少ない馬は参考度が下がります。</p>}
            </> : <><p className="font-semibold">位置取りの根拠を見る</p><p className="mt-2 text-sm leading-6 text-slate-400">馬番をタップすると、推定番手と近走の通過順を確認できます。</p></>}
          </div>
          {unknown.length > 0 && <div className="rounded-xl border border-slate-700 p-3"><p className="text-xs text-slate-400">この場面は未判定</p><div className="mt-2 flex flex-wrap gap-2">{unknown.map(({horse}) => <button key={horse.number} type="button" onClick={() => setSelected(horse.number)} className="min-h-10 rounded-lg bg-white/5 px-3 text-sm">{horse.number} {horse.name}</button>)}</div></div>}
          <details className="rounded-xl border border-slate-700 p-4 text-sm">
            <summary className="cursor-pointer font-semibold">予測の見方・検証結果</summary>
            <div className="mt-3 space-y-2 text-xs leading-5 text-slate-400">
              <p>AIは2019〜2024年の過去データで学習した位置取りモデルです。近走通過順・頭数・距離・芝ダート・枠から地点別に推定します。当日オッズ・人気・今回の着順結果は使いません。</p>
              <p>2026年データの4角検証では平均誤差 {CORNER_AUDIT_MAE.toFixed(2)}番手。目安幅は2025年の検証誤差から算出したもので、各馬に同じ確率を保証するものではありません。</p>
              <p>序盤は最初の記録地点の予測で、発馬直後ではありません。1・2角を通らないコースでは該当タブを出しません。直線・障害・未登録コースではAIコーナー予測を保留します。</p>
              <p>内外の進路・馬身差・想定タイムはまだ予測対象外です。前走タブは各馬の別レースの通過順位を比較する参考図です。</p>
              <p>総合評価・1〜3着適性・買い目は変更していません。{legacy ? "一部は既存保存データの通過順を使用しています。" : ""}</p>
              <p>モデル：{CORNER_MODEL_VERSION} / 検証期間：2026年1月〜9月13日</p>
            </div>
          </details>
          {!eligible && <p className="text-xs leading-5 text-amber-200">このコースまたは日付はAI予測対象外のため、脚質を表示しています。</p>}
        </div>
      </div>
    </section>
  );
}
