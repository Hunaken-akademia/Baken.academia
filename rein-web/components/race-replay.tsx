"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import type { MarkPick, Picks } from "@/lib/marks";
import {
  TRACK,
  buildReplay,
  cornerRemaining,
  currentOrder,
  replayFrame,
  trackPoint,
  type ReplayHorse,
} from "@/lib/race-replay";

// Same frame colours as the 隊列マップ (index = 枠番).
const frameColors = ["#94a3b8", "#f8fafc", "#171717", "#dc433c", "#3778dc", "#f4d641", "#329249", "#ec9a30", "#d94c90"];
const darkText = new Set([1, 5]);
const PLAY_SECONDS = 30;
const SPEEDS = [0.5, 1, 2];

function pickMark(picks: Picks | undefined, number: number) {
  const hit = [picks?.main, picks?.rival, picks?.longshot].find((pick): pick is MarkPick => pick?.number === number);
  return hit ? { 本命: "◎", 対抗: "○", 穴候補: "☆" }[hit.role] : "";
}

export function RaceReplay({ horses, title, course, raceId, pace, league, picks, roleReady }: {
  horses: ReplayHorse[];
  title: string;
  course: string;
  raceId: string;
  pace: string;
  league?: "jra" | "nar";
  picks?: Picks;
  roleReady: boolean;
}) {
  const plan = useMemo(
    () => buildReplay({ horses, title, course, raceId, pace, league, roleReady }),
    [horses, title, course, raceId, pace, league, roleReady],
  );
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = (time: number) => {
      const previous = last.current ?? time;
      last.current = time;
      setProgress((value) => {
        const next = Math.min(1, value + ((time - previous) / 1000) * speed / PLAY_SECONDS);
        if (next >= 1) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      last.current = null;
    };
  }, [playing, speed]);

  if ("unavailable" in plan) {
    return (
      <section className="mb-5 rounded-2xl border border-slate-700 bg-[#0c192a] p-4 text-sm text-slate-300 sm:p-5" data-testid="race-replay">
        <h2 className="text-xl font-bold text-white">展開ビュー</h2>
        <p className="mt-2 leading-6">{plan.unavailable}</p>
      </section>
    );
  }

  const frame = replayFrame(plan, progress);
  const order = currentOrder(frame);
  const finished = progress >= 1;
  const byNumber = new Map(horses.map((horse) => [horse.number, horse]));
  const line = [...plan.commentary].reverse().find((item) =>
    item.label === "直線"
      ? frame.leaderRemaining <= plan.geometry.homeStraight
      : item.checkpoint <= frame.checkpoint,
  ) ?? plan.commentary[0];
  const markers = plan.checkpoints.map((checkpoint) => ({
    label: checkpoint.label,
    at: 1 - checkpoint.remaining / plan.geometry.distance,
  }));
  const geometry = plan.geometry;
  const { width, height, straight, radius } = TRACK;
  const cx = width / 2, cy = height / 2;
  const goal = trackPoint(geometry, 0, -1.7);
  const goalOuter = trackPoint(geometry, 0, 4.2);
  const start = trackPoint(geometry, geometry.distance, -1.2);
  const startOuter = trackPoint(geometry, geometry.distance, 3.6);
  const cornerLabels = [1, 2, 3, 4].map((stage) => {
    const remaining = cornerRemaining(geometry, stage)!;
    return { stage, point: trackPoint(geometry, remaining, -5.2) };
  });
  const describe = order.map((number) => byNumber.get(number)?.name ?? `${number}番`).slice(0, 3).join("、");

  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-emerald-300/25 bg-[#0c192a] text-white" data-testid="race-replay">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4 sm:p-5">
        <div className="min-w-0">
          <h2 className="text-xl font-bold">展開ビュー</h2>
          <p className="mt-1 text-sm text-slate-300">
            {geometry.venue} {course}・{geometry.rightHanded ? "右回り" : "左回り"}・{horses.length}頭
          </p>
        </div>
        <span className="rounded-full bg-amber-300/10 px-3 py-1 text-xs font-semibold text-amber-200">{pace}想定</span>
      </div>
      <div className="grid gap-4 px-4 pb-4 sm:px-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,.9fr)]">
        <div className="min-w-0">
          <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-[#163d23]">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`展開ビュー。現在の先頭から${describe}`} className="block w-full">
              <rect x="0" y="0" width={width} height={height} fill="#1d4a2a" />
              <rect x={cx - straight / 2 - radius - 48} y={cy - radius - 48} width={straight + 2 * radius + 96} height={2 * radius + 96} rx={radius + 48} fill="#3f7f3a" stroke="#e2e8f0" strokeWidth="2" />
              <rect x={cx - straight / 2 - radius + 6} y={cy - radius + 6} width={straight + 2 * radius - 12} height={2 * radius - 12} rx={radius - 6} fill="#24572d" stroke="#e2e8f0" strokeWidth="2" />
              {cornerLabels.map(({ stage, point }) => (
                <text key={stage} x={point.x} y={point.y} fill="#d1fae5" fontSize="13" textAnchor="middle" dominantBaseline="middle">{stage}角</text>
              ))}
              <line x1={goal.x} y1={goal.y} x2={goalOuter.x} y2={goalOuter.y} stroke="#ef4444" strokeWidth="3" />
              <text x={goal.x} y={goal.y - 8} fill="#fecaca" fontSize="13" fontWeight="800" textAnchor="middle">ゴール</text>
              <line x1={start.x} y1={start.y} x2={startOuter.x} y2={startOuter.y} stroke="#f8fafc" strokeWidth="2" strokeDasharray="4 3" />
              <text x={start.x} y={start.y + (start.y > cy ? -10 : 16)} fill="#f8fafc" fontSize="12" fontWeight="700" textAnchor="middle">S</text>
              {[...frame.runners].sort((a, b) => b.remaining - a.remaining).map((runner) => {
                const horse = byNumber.get(runner.number);
                const point = trackPoint(geometry, runner.remaining, runner.lane);
                const gate = horse?.gate ?? 0;
                return (
                  <g key={runner.number} transform={`translate(${point.x} ${point.y})`}>
                    <circle r="11" fill={frameColors[gate] ?? frameColors[0]} stroke="#0f172a" strokeWidth="1.5" />
                    <text y="0.5" fill={darkText.has(gate) ? "#0f172a" : "#f8fafc"} fontSize="11" fontWeight="800" textAnchor="middle" dominantBaseline="middle">{runner.number}</text>
                  </g>
                );
              })}
            </svg>
            <div className="pointer-events-none absolute right-3 top-2 text-right">
              <p className="text-[10px] font-semibold text-emerald-100">残り</p>
              <p className="text-2xl font-black tabular-nums" aria-live="off">{Math.round(frame.leaderRemaining)}m</p>
            </div>
          </div>
          <div className="mt-3 rounded-xl border border-slate-700 bg-black/15 p-3" aria-live="polite">
            <p className="text-sm leading-6 text-slate-200">
              <span className="mr-2 font-bold text-amber-300">{line?.label}</span>
              {line?.text}
            </p>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3" data-no-swipe>
            <button
              type="button"
              onClick={() => {
                if (finished) setProgress(0);
                setPlaying((value) => !value || finished);
              }}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-amber-300 px-4 font-bold text-[#1f1300] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200"
            >
              {playing ? <Pause className="size-4" /> : finished ? <RotateCcw className="size-4" /> : <Play className="size-4" />}
              {playing ? "一時停止" : finished ? "もう一度" : progress > 0 ? "再開" : "再生"}
            </button>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              速度
              <select
                value={speed}
                onChange={(event) => setSpeed(Number(event.target.value))}
                className="min-h-11 rounded-lg border border-slate-600 bg-[#101f32] px-2 text-white"
              >
                {SPEEDS.map((value) => <option key={value} value={value}>{value}倍</option>)}
              </select>
            </label>
          </div>
          <div className="mt-3" data-no-swipe>
            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round(progress * 1000)}
              onChange={(event) => {
                setPlaying(false);
                setProgress(Number(event.target.value) / 1000);
              }}
              aria-label="レースの進行位置"
              className="w-full accent-amber-300"
            />
            <div className="relative mt-1 h-4 text-[10px] text-slate-400">
              {markers.map((marker) => (
                <span key={marker.label} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${Math.min(97, Math.max(3, marker.at * 100))}%` }}>
                  {marker.label}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="rounded-xl border border-slate-700 bg-black/10 p-3">
            <p className="mb-2 text-xs font-semibold text-slate-400">隊列</p>
            <ol className="space-y-1">
              {order.map((number, index) => {
                const horse = byNumber.get(number);
                const gate = horse?.gate ?? 0;
                return (
                  <li key={number} className="flex min-w-0 items-center gap-2 text-sm">
                    <span className="w-5 shrink-0 text-right text-xs text-slate-500">{index + 1}</span>
                    <span
                      className="grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold"
                      style={{ background: frameColors[gate] ?? frameColors[0], color: darkText.has(gate) ? "#0f172a" : "#f8fafc" }}
                    >
                      {number}
                    </span>
                    <span className="w-4 shrink-0 text-amber-300">{pickMark(picks, number)}</span>
                    <span className="min-w-0 truncate">{horse?.name}</span>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="rounded-xl border border-slate-700 bg-black/10 p-3">
            <p className="text-xs font-semibold text-slate-400">予想着順（1着適性順）</p>
            {finished ? (
              <ol className="mt-2 space-y-1 text-sm">
                {plan.finish.slice(0, 5).map((number, index) => (
                  <li key={number} className="flex min-w-0 gap-2">
                    <span className="text-slate-400">{index + 1}着</span>
                    <span className="text-amber-300">{pickMark(picks, number)}</span>
                    <span className="min-w-0 truncate">{number} {byNumber.get(number)?.name}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-sm text-slate-400">ゴール後に表示します。</p>
            )}
          </div>
        </div>
      </div>
      <p className="border-t border-slate-800 px-4 py-3 text-xs leading-5 text-slate-400 sm:px-5">
        予想のイメージです。実際のレースのシミュレーションではありません。
        {plan.cornerSource === "ai"
          ? "序盤・各コーナーの並びはAI位置取り予測（β、平均誤差約3番手）"
          : "途中の並びは近走の脚質"}
        、ゴールの並びは1着適性順です。馬身差・進路・内外は表しません。コース形状と距離配分は概略です。
      </p>
    </section>
  );
}
