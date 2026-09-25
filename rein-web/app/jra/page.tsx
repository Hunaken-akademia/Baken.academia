"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Clock3,
  Gauge,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { compactSelections } from "@/lib/tickets";
import { raceProgress } from "@/lib/race-progress";

type HistoryFactor = { label: string; samples: number; impact: number };
type Horse = {
  number: number;
  gate?: number;
  name: string;
  score: number;
  odds: number | null;
  popularity: number;
  mark: string;
  style: string;
  verdict: string;
  historyAdjustment?: number;
  historySamples?: number;
  positives: string[];
  cautions: string[];
  weight?: number;
  weightChange?: number;
  pedigree?: string;
  jockey?: string;
  trainer?: string;
  earlyPosition?: number | null;
  recentPositions?: string[];
  paceAdjustment?: number;
  marketScore?: number;
  reinScore?: number;
  firstProbability?: number;
  secondProbability?: number;
  thirdProbability?: number;
  firstSuitability?: number;
  secondSuitability?: number;
  thirdSuitability?: number;
  historyFactors?: HistoryFactor[];
  parameterFactors?: HistoryFactor[];
};
type TicketTier = {
  group: "本線" | "対抗" | "穴";
  points: number;
  selections: string[];
};
type Ticket = { type: string; tiers: TicketTier[] };
type RacePayout = {
  type: string;
  selection: string;
  payout: number;
  popularity: number | null;
};
type Analysis = {
  warnings?: string[];
  race: {
    title: string;
    course: string;
    condition: string;
    start: string;
    updated: string;
    raceId: string;
  };
  model?: {
    version: string;
    dateFrom: string;
    dateTo: string;
    races: number;
    runners: number;
    horses: number;
    strategy: string;
    snapshotPolicy?: string;
    featureCount?: number;
  };
  pace: { label: string; detail: string; leaders: number[] };
  horses: Horse[];
  tickets: Ticket[];
  review?: {
    isFinished: boolean;
    finishers: Array<{
      finish: number;
      number: number;
      name: string;
      odds: number;
    }>;
    payouts: RacePayout[];
  };
};
type Race = {
  number: number;
  start: string;
  raceId: string;
  title: string;
  course: string;
  status: "確定" | "次レース" | "発売前" | "発走時刻経過";
};
type Venue = {
  name: string;
  eventId: string;
  nextRace: number;
  nextStart: string;
  races: Race[];
};
type Schedule = { dateLabel: string; updatedAt: string; venues: Venue[] };
type ScheduleDay = "today" | "tomorrow";

const groupStyle = {
  本線: "bg-sky-100 text-sky-800",
  対抗: "bg-amber-100 text-amber-800",
  穴: "bg-rose-100 text-rose-800",
};

export default function Home() {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [scheduleDay, setScheduleDay] = useState<ScheduleDay>("today");
  const [venue, setVenue] = useState<Venue | null>(null);
  const [data, setData] = useState<Analysis | null>(null);
  const [activeHorse, setActiveHorse] = useState<Horse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const danger = useMemo(
    () => data?.horses.find((h) => h.popularity > 0 && h.popularity <= 3 && h.score < 78),
    [data],
  );

  async function loadSchedule(day: ScheduleDay = scheduleDay, background = false) {
    if (!background) {
      setLoading(true);
      setError("");
    }
    try {
      const response = await fetch(`/api/races?day=${day}`);
      const result = (await response.json()) as Schedule & { error?: string };
      if (!response.ok)
        throw new Error(result.error || "開催情報を取得できませんでした");
      setSchedule(result);
      setVenue((current) =>
        current
          ? result.venues.find((item) => item.eventId === current.eventId) ||
            null
          : null,
      );
    } catch (value) {
      setError(
        value instanceof Error
          ? value.message
          : "開催情報を取得できませんでした",
      );
    } finally {
      if (!background) setLoading(false);
    }
  }

  async function analyze(race: Pick<Race, "raceId">, background = false) {
    if (!background) {
      setLoading(true);
      setError("");
    }
    try {
      const response = await fetch(`/api/analyze?raceId=${race.raceId}${scheduleDay === "tomorrow" ? "&preview=1" : ""}`);
      const result = (await response.json()) as Analysis & { error?: string };
      if (!response.ok) throw new Error(result.error || "分析できませんでした");
      setData(result);
      setActiveHorse(null);
    } catch (value) {
      if (!background)
        setError(value instanceof Error ? value.message : "分析に失敗しました");
    } finally {
      if (!background) setLoading(false);
    }
  }

  useEffect(() => {
    void loadSchedule(scheduleDay);
    const refresh = () => {
      if (document.visibilityState === "visible") void loadSchedule(scheduleDay, true);
    };
    const timer = setInterval(refresh, 300_000);
    const clock = setInterval(() => {
      if (scheduleDay !== "today") return;
      const update = (item: Venue) =>
        ({ ...item, ...raceProgress(item.races) }) as Venue;
      setSchedule((current) =>
        current ? { ...current, venues: current.venues.map(update) } : null,
      );
      setVenue((current) => (current ? update(current) : null));
    }, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [scheduleDay]);

  useEffect(() => {
    const raceId = data?.race.raceId;
    if (!raceId || data?.review?.isFinished) return;
    const refresh = () => {
      if (document.visibilityState === "visible")
        void analyze({ raceId }, true);
    };
    const timer = setInterval(refresh, 300_000);
    return () => clearInterval(timer);
  }, [data?.race.raceId, data?.review?.isFinished]);

  const back = () => {
    if (data) {
      setData(null);
      setActiveHorse(null);
    } else setVenue(null);
  };
  const showBack = Boolean(venue || data);
  const pageSwipeStart = useRef<{ x: number; y: number; time: number } | null>(
    null,
  );
  const suppressPageClickUntil = useRef(0);

  return (
    <main
      className="min-h-screen bg-[#07111f] text-slate-100"
      style={{ touchAction: "pan-y pinch-zoom" }}
      onTouchStart={(event) => {
        pageSwipeStart.current = null;
        suppressPageClickUntil.current = 0;
        const touch = event.touches[0];
        const target = event.target as Element;
        if (
          !showBack ||
          event.touches.length !== 1 ||
          touch.clientX < 24 ||
          touch.clientX > window.innerWidth - 24 ||
          target.closest(
            '[data-slot="tabs"],input,textarea,select,[data-no-swipe]',
          )
        )
          return;
        pageSwipeStart.current = {
          x: touch.clientX,
          y: touch.clientY,
          time: Date.now(),
        };
      }}
      onTouchMove={(event) => {
        if (!pageSwipeStart.current) return;
        if (
          event.touches.length !== 1 ||
          Math.abs(event.touches[0].clientY - pageSwipeStart.current.y) > 35
        )
          pageSwipeStart.current = null;
      }}
      onTouchCancel={() => {
        pageSwipeStart.current = null;
      }}
      onTouchEnd={(event) => {
        const origin = pageSwipeStart.current;
        pageSwipeStart.current = null;
        if (!origin || !event.changedTouches.length) return;
        const dx = event.changedTouches[0].clientX - origin.x;
        const dy = event.changedTouches[0].clientY - origin.y;
        if (Date.now() - origin.time > 800 || dx < 70 || dx < Math.abs(dy) * 2)
          return;
        event.preventDefault();
        suppressPageClickUntil.current = Date.now() + 400;
        back();
      }}
      onClickCapture={(event) => {
        if (event.detail > 0 && Date.now() < suppressPageClickUntil.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressPageClickUntil.current = 0;
        }
      }}
    >
      <div className="mx-auto max-w-6xl px-4 pb-20 pt-5 sm:px-6">
        <header className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {showBack && (
              <Button
                aria-label="戻る"
                variant="ghost"
                size="icon"
                onClick={back}
                className="text-slate-300 hover:bg-white/10 hover:text-white"
              >
                <ArrowLeft />
              </Button>
            )}
            <div className="grid size-10 place-items-center rounded-xl bg-cyan-400 text-xl font-black text-[#07111f]">
              R
            </div>
            <div>
              <p className="text-lg font-bold tracking-[.12em]">REIN</p>
              <p className="text-xs text-slate-400">馬券アカデミア</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              aria-label={
                data ? "最新の馬体重・馬場・オッズで再分析" : "開催情報を更新"
              }
              variant="ghost"
              size="icon"
              onClick={() => {
                if (data) void analyze({ raceId: data.race.raceId });
                else void loadSchedule(scheduleDay);
              }}
              disabled={loading}
              className="text-slate-400 hover:bg-white/10 hover:text-white"
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
            </Button>
            <Badge className="border-cyan-400/25 bg-cyan-400/10 text-cyan-300">
              PERSONAL
            </Badge>
          </div>
        </header>
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-200">
            <AlertTriangle className="size-4" />
            {error}
          </div>
        )}
        {data?.warnings?.map((warning) => (
          <p
            key={warning}
            className="mb-3 rounded-xl border border-amber-400/30 p-3 text-sm text-amber-200"
          >
            {warning}
          </p>
        ))}

        {!venue && !data && (
          <VenueScreen
            schedule={schedule}
            day={scheduleDay}
            loading={loading}
            onSelect={setVenue}
            onDay={(day) => {
              if (day === scheduleDay) return;
              setSchedule(null);
              setVenue(null);
              setData(null);
              setScheduleDay(day);
            }}
          />
        )}
        {venue && !data && (
          <RaceScreen venue={venue} day={scheduleDay} loading={loading} onAnalyze={analyze} />
        )}
        {data && (
          <AnalysisScreen
            data={data}
            activeHorse={activeHorse}
            danger={danger}
            onBack={back}
            onHorse={(horse) =>
              setActiveHorse((current) =>
                current?.number === horse.number ? null : horse,
              )
            }
          />
        )}
      </div>
    </main>
  );
}

function VenueScreen({
  schedule,
  day,
  loading,
  onSelect,
  onDay,
}: {
  schedule: Schedule | null;
  day: ScheduleDay;
  loading: boolean;
  onSelect: (venue: Venue) => void;
  onDay: (day: ScheduleDay) => void;
}) {
  return (
    <>
      <section className="mb-5 rounded-2xl border border-slate-700 bg-gradient-to-br from-[#10233a] to-[#0b1727] p-5">
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-black/20 p-1" data-no-swipe>
          {(["today", "tomorrow"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onDay(value)}
              aria-pressed={day === value}
              className={`rounded-lg px-4 py-2 text-sm font-bold transition ${day === value ? "bg-cyan-300 text-[#07111f]" : "text-slate-400 hover:text-white"}`}
            >
              {value === "today" ? "今日" : "明日"}
            </button>
          ))}
        </div>
        <p className="text-sm font-semibold text-cyan-300">{day === "today" ? "TODAY'S JRA" : "TOMORROW'S JRA"}</p>
        <h1 className="mt-1 text-2xl font-black">開催場を選択</h1>
        <p className="mt-2 text-sm text-slate-400">
          {schedule?.dateLabel || `${day === "today" ? "本日" : "明日"}の開催情報を取得中`}
        </p>
      </section>
      {loading && !schedule ? (
        <div className="grid min-h-56 place-items-center rounded-2xl border border-slate-800 bg-[#0c192a]">
          <RefreshCw className="size-8 animate-spin text-cyan-300" />
        </div>
      ) : schedule?.venues.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {schedule.venues.map((item) => (
            <button
              key={item.eventId}
              onClick={() => onSelect(item)}
              className="group rounded-2xl border border-slate-700 bg-[#0c192a] p-5 text-left transition hover:-translate-y-0.5 hover:border-cyan-400/60 hover:bg-[#10233a]"
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-semibold tracking-widest text-cyan-300">
                    JRA
                  </p>
                  <h2 className="mt-1 text-3xl font-black">{item.name}</h2>
                </div>
                <ChevronRight className="text-slate-600 transition group-hover:translate-x-1 group-hover:text-cyan-300" />
              </div>
              <div className="mt-6 flex items-end justify-between">
                <div>
                  <p className="text-xs text-slate-500">次レース</p>
                  <p className="text-xl font-bold">
                    {item.nextRace > 12
                      ? "本日の発走予定なし"
                      : `${item.nextRace}R`}{" "}
                    <span className="text-sm font-normal text-slate-400">
                      {item.nextStart}
                    </span>
                  </p>
                </div>
                <Badge className="bg-cyan-400/10 text-cyan-300">
                  全{item.races.length}R
                </Badge>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-700 bg-[#0c192a] p-8 text-center text-slate-400">
          {day === "today" ? "本日" : "明日"}のJRA開催はありません
        </div>
      )}
    </>
  );
}

function RaceScreen({
  venue,
  day,
  loading,
  onAnalyze,
}: {
  venue: Venue;
  day: ScheduleDay;
  loading: boolean;
  onAnalyze: (race: Pick<Race, "raceId">) => void;
}) {
  return (
    <>
      <section className="mb-5 flex items-end justify-between rounded-2xl border border-slate-700 bg-gradient-to-br from-[#10233a] to-[#0b1727] p-5">
        <div>
          <p className="text-sm font-semibold text-cyan-300">開催場</p>
          <h1 className="mt-1 text-3xl font-black">{venue.name}</h1>
          <p className="mt-2 text-sm text-slate-400">
            {day === "tomorrow"
              ? "前日出走表による暫定予想です。人気・オッズ・馬体重・馬場は当日に更新します"
              : "発走前は予想、確定後は着順・予想印・買い目を照合できます"}
          </p>
        </div>
        <Badge className="bg-white/10 text-white">
          {venue.races.length}レース
        </Badge>
      </section>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {venue.races.map((race) => (
          <button
            key={race.raceId}
            onClick={() => onAnalyze(race)}
            disabled={loading}
            className={`rounded-2xl border p-4 text-left transition hover:border-cyan-400/60 ${race.status === "次レース" ? "border-cyan-400/60 bg-cyan-400/10" : "border-slate-700 bg-[#0c192a]"}`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <span className="grid size-11 place-items-center rounded-xl bg-white text-lg font-black text-[#07111f]">
                  {race.number}R
                </span>
                <div>
                  <p className="font-bold">{race.title}</p>
                  <p className="mt-1 line-clamp-1 text-xs text-slate-500">
                    {race.course}
                  </p>
                </div>
              </div>
              <ChevronRight className="size-4 text-slate-600" />
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="flex items-center gap-1 text-sm text-slate-300">
                <Clock3 className="size-4" />
                {race.start}
              </span>
              <Badge
                className={
                  race.status === "次レース"
                    ? "bg-cyan-300 text-[#07111f]"
                    : race.status === "確定"
                      ? "bg-emerald-400/10 text-emerald-300"
                      : "bg-amber-400/10 text-amber-300"
                }
              >
                {race.status === "確定" ? "確定・復習" : race.status}
              </Badge>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function AnalysisScreen({
  data,
  activeHorse,
  danger,
  onBack,
  onHorse,
}: {
  data: Analysis;
  activeHorse: Horse | null;
  danger: Horse | undefined;
  onBack: () => void;
  onHorse: (horse: Horse) => void;
}) {
  const top3 = data.review?.finishers.slice(0, 3) ?? [];
  return (
    <>
      {data.model && (
        <section className="mb-4 flex flex-wrap gap-x-4 gap-y-1 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-4 py-2 text-xs text-slate-400">
          <span className="font-semibold text-cyan-300">8年履歴 接続済み</span>
          <span>
            {data.model.races.toLocaleString()}レース・
            {data.model.runners.toLocaleString()}走
          </span>
          <span>{data.model.strategy}</span>
          <span>{data.model.snapshotPolicy}</span>
        </section>
      )}
      {data.review?.isFinished && (
        <section className="mb-4 rounded-2xl border border-emerald-400/30 bg-emerald-400/[.07] p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold tracking-widest text-emerald-300">
                REVIEW MODE
              </p>
              <h2 className="mt-1 text-lg font-bold">確定結果と予想を照合</h2>
            </div>
            <Badge className="bg-emerald-300 text-emerald-950">確定</Badge>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {top3.map((finisher) => {
              const predicted = data.horses.find(
                (horse) => horse.number === finisher.number,
              );
              return (
                <button
                  key={finisher.finish}
                  onClick={() => predicted && onHorse(predicted)}
                  className="rounded-xl border border-emerald-400/20 bg-black/15 p-3 text-left"
                >
                  <p className="text-xs text-emerald-300">
                    {finisher.finish}着
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white font-bold text-slate-900">
                      {finisher.number}
                    </span>
                    <span className="truncate text-sm font-semibold">
                      {finisher.name}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-400">
                    予想{" "}
                    <span className="font-bold text-white">
                      {predicted?.mark ?? "－"}
                    </span>
                    ・{predicted?.score ?? "－"}pt
                  </p>
                </button>
              );
            })}
          </div>
          {data.review.payouts?.length ? (
            <div className="mt-5 border-t border-emerald-400/20 pt-4">
              <div className="mb-3 flex items-end justify-between">
                <h3 className="font-bold">払戻金</h3>
                <span className="text-[11px] text-slate-500">100円あたり</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {data.review.payouts.map((item, index) => (
                  <div
                    key={`${item.type}-${item.selection}-${index}`}
                    className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-slate-700/70 bg-black/15 px-3 py-2 text-sm"
                  >
                    <span className="text-xs font-semibold text-emerald-300">
                      {item.type}
                    </span>
                    <span className="font-mono font-semibold text-slate-200">
                      {item.selection}
                    </span>
                    <span className="text-right font-bold text-white">
                      {item.payout.toLocaleString("ja-JP")}円
                      {item.popularity ? (
                        <small className="ml-1 font-normal text-slate-500">
                          {item.popularity > 0 ? `${item.popularity}人気` : "人気未発表"}
                        </small>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      )}
      <section className="mb-5 grid gap-4 lg:grid-cols-[1.45fr_.55fr]">
        <Card className="border-slate-700 bg-gradient-to-br from-[#10233a] to-[#0b1727] text-white">
          <CardContent className="p-5 sm:p-6">
            <p className="text-sm text-cyan-300">
              {data.race.start}発走 ・ {data.race.updated}
            </p>
            <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
              {data.race.title}
            </h1>
            <p className="mt-1 text-slate-400">
              {data.race.course}　{data.race.condition}
            </p>
            <div className="mt-5 grid grid-cols-3 gap-2">
              {data.horses.slice(0, 3).map((horse, index) => (
                <button
                  key={horse.number}
                  onClick={() => onHorse(horse)}
                  className={`rounded-xl border p-3 text-left ${index === 0 ? "border-cyan-400/60 bg-cyan-400/10" : "border-slate-700 bg-black/10"}`}
                >
                  <span className="text-xs text-slate-400">
                    {index === 0 ? "本命" : index === 1 ? "対抗" : "単穴"}
                  </span>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="grid size-7 place-items-center rounded-md bg-white font-bold text-slate-900">
                      {horse.number}
                    </span>
                    <span className="truncate text-sm font-semibold">
                      {horse.name}
                    </span>
                  </div>
                  <p className="mt-3 text-2xl font-black text-cyan-300">
                    {horse.score}
                    <span className="ml-1 text-xs font-normal text-slate-500">
                      pt
                    </span>
                  </p>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
        <div className="grid gap-4">
          <Card className="border-slate-700 bg-[#0c192a] text-white">
            <CardContent className="flex gap-3 p-4">
              <Gauge className="text-amber-300" />
              <div>
                <p className="text-xs text-slate-400">展開予測</p>
                <p className="font-bold">{data.pace.label}</p>
                <p className="mt-1 text-sm text-slate-400">
                  {data.pace.detail}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-slate-700 bg-[#0c192a] text-white">
            <CardContent className="flex gap-3 p-4">
              <AlertTriangle className="text-rose-300" />
              <div>
                <p className="text-xs text-slate-400">危険人気馬</p>
                <p className="font-bold">
                  {danger ? `${danger.number} ${danger.name}` : "該当なし"}
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  {danger?.cautions.join("・") || "人気と評価が一致"}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>
      <Tabs defaultValue="ranking" onSwipeBack={onBack}>
        <TabsList className="mb-4 grid h-auto min-h-11 w-full grid-cols-4 bg-[#0c192a]">
          <TabsTrigger value="ranking" className="px-1 text-xs sm:text-sm">
            全頭評価
          </TabsTrigger>
          <TabsTrigger value="roles" className="px-1 text-xs sm:text-sm">
            着順適性
          </TabsTrigger>
          <TabsTrigger value="tickets" className="px-1 text-xs sm:text-sm">
            買い目
          </TabsTrigger>
          <TabsTrigger value="detail" className="px-1 text-xs sm:text-sm">
            診断
          </TabsTrigger>
        </TabsList>
        <TabsContent value="ranking">
          <div className="overflow-hidden rounded-2xl border border-slate-700 bg-[#0c192a]">
            {data.horses.map((horse, index) => {
              const expanded = activeHorse?.number === horse.number;
              return (
                <Fragment key={horse.number}>
                  <button
                    onClick={() => onHorse(horse)}
                    aria-expanded={expanded}
                    className={`grid w-full grid-cols-[28px_36px_minmax(0,1fr)_58px_20px] items-center gap-2 border-b border-slate-800 px-3 py-3 text-left transition sm:grid-cols-[32px_40px_minmax(0,1fr)_105px_60px_20px] ${expanded ? "bg-cyan-400/8" : "hover:bg-white/[.03]"}`}
                  >
                    <span className="text-center text-sm text-slate-500">
                      {index + 1}
                    </span>
                    <span className="grid size-8 place-items-center rounded-md bg-white font-bold text-slate-900">
                      {horse.number}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-semibold">
                        {horse.mark} {horse.name}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {horse.style}・{horse.verdict}
                        <span className="hidden sm:inline">
                          　履歴 {horse.historySamples ?? 0}走 / 補正{" "}
                          {horse.historyAdjustment &&
                          horse.historyAdjustment > 0
                            ? "+"
                            : ""}
                          {horse.historyAdjustment ?? 0}
                        </span>
                      </p>
                    </div>
                    <p className="text-right text-lg font-black text-cyan-300">
                      {horse.score}
                      <span className="text-xs text-slate-500">pt</span>
                    </p>
                    <span className="hidden text-right text-sm text-slate-400 sm:block">
                      {horse.popularity > 0 ? `${horse.popularity}人気` : "人気未発表"}
                    </span>
                    <ChevronRight
                      className={`size-4 text-slate-600 transition ${expanded ? "rotate-90 text-cyan-300" : ""}`}
                    />
                  </button>
                  {expanded && (
                    <div className="border-b border-slate-700 bg-[#091522] p-3 sm:p-5">
                      <HorseDetails horse={horse} horses={data.horses} />
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </TabsContent>
        <TabsContent value="roles">
          <RoleRankings horses={data.horses} onHorse={onHorse} />
        </TabsContent>
        <TabsContent value="tickets">
          <div className="grid gap-3 sm:grid-cols-2">
            {data.tickets.map((ticket) => (
              <Card
                key={ticket.type}
                className="border-slate-700 bg-[#0c192a] text-white"
              >
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{ticket.type}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {ticket.tiers.map((item) => (
                    <div
                      key={item.group}
                      className="rounded-lg border border-slate-800 bg-black/10 p-3"
                    >
                      <div className="mb-2 flex justify-between">
                        <Badge className={groupStyle[item.group]}>
                          {item.group}
                        </Badge>
                        <Badge
                          variant="outline"
                          className="border-slate-600 text-slate-300"
                        >
                          {item.points}点
                        </Badge>
                      </div>
                      <p className="font-mono text-xs leading-6 text-slate-200">
                        {compactSelections(item.selections).join(" / ") ||
                          "該当なし"}
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="detail">
          {activeHorse ? (
            <Card className="border-slate-700 bg-[#0c192a] text-white">
              <CardContent className="p-5">
                <HorseDetails horse={activeHorse} horses={data.horses} />
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-[#0c192a] p-8 text-center text-slate-400">
              全頭評価か着順適性から馬を選ぶと詳細診断を表示します
            </div>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

type HorseParameter = {
  label: string;
  value: number;
  samples: number;
  detail: string;
};

function parameterValue(horse: Horse, labels: string[], multiplier: number) {
  const factors = (horse.parameterFactors ?? horse.historyFactors ?? []).filter(
    (item) => labels.includes(item.label),
  );
  const impact = factors.reduce((sum, item) => sum + item.impact, 0);
  return {
    value: Math.round(Math.max(5, Math.min(100, 50 + impact * multiplier))),
    samples: factors.reduce((sum, item) => sum + item.samples, 0),
  };
}

function horseParameters(horse: Horse): HorseParameter[] {
  const course = parameterValue(
    horse,
    ["芝ダ適性", "距離適性", "競馬場適性"],
    2.2,
  );
  const recent = parameterValue(horse, ["近5走"], 3);
  const recentValue = Math.round(
    Math.max(5, Math.min(100, recent.value + (horse.paceAdjustment ?? 0) * 4)),
  );
  return [
    {
      label: "1着適性",
      value: horse.firstSuitability ?? 0,
      samples: horse.historySamples ?? 0,
      detail: "勝ち切る力",
    },
    {
      label: "2着適性",
      value: horse.secondSuitability ?? 0,
      samples: horse.historySamples ?? 0,
      detail: "連対する力",
    },
    {
      label: "3着適性",
      value: horse.thirdSuitability ?? 0,
      samples: horse.historySamples ?? 0,
      detail: "3着に残る力",
    },
    {
      label: "コース",
      value: course.value,
      samples: course.samples,
      detail: "芝ダ・距離・競馬場",
    },
    {
      label: "近走状態",
      value: recentValue,
      samples: recent.samples,
      detail: "近5走と今回の展開",
    },
  ];
}

function ParameterRadar({ horse, horses }: { horse: Horse; horses: Horse[] }) {
  const parameters = horseParameters(horse);
  const center = 110;
  const radius = 76;
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / parameters.length;
    const distance = (radius * value) / 100;
    return [
      center + Math.cos(angle) * distance,
      center + Math.sin(angle) * distance,
    ];
  };
  const polygon = (value: number) =>
    parameters.map((_, index) => point(index, value).join(",")).join(" ");
  const dataPoints = parameters
    .map((item, index) => point(index, item.value).join(","))
    .join(" ");
  const labels = parameters.map((item, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / parameters.length;
    return {
      item,
      x: center + Math.cos(angle) * (radius + 26),
      y: center + Math.sin(angle) * (radius + 22),
    };
  });
  return (
    <section className="mt-4 rounded-xl border border-cyan-400/20 bg-gradient-to-br from-cyan-400/[.07] to-transparent p-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="font-semibold text-cyan-200">能力パラメーター</p>
          <p className="mt-1 text-xs text-slate-500">
            このレースの出走馬内で0〜100点に換算
          </p>
        </div>
        <Badge className="bg-cyan-400/10 text-cyan-300">5項目</Badge>
      </div>
      <div className="mt-3 grid items-center gap-4 md:grid-cols-[260px_1fr]">
        <svg
          viewBox="0 0 220 220"
          role="img"
          aria-label={`${horse.name}の能力パラメーター`}
          className="mx-auto w-full max-w-[260px] overflow-visible"
        >
          {[20, 40, 60, 80, 100].map((value) => (
            <polygon
              key={value}
              points={polygon(value)}
              fill="none"
              stroke={value === 100 ? "#475569" : "#1e3a4a"}
              strokeWidth={value === 100 ? 1.5 : 1}
            />
          ))}
          {parameters.map((_, index) => (
            <line
              key={index}
              x1={center}
              y1={center}
              x2={point(index, 100)[0]}
              y2={point(index, 100)[1]}
              stroke="#334155"
              strokeWidth="1"
            />
          ))}
          <polygon
            points={dataPoints}
            fill="rgba(34,211,238,.22)"
            stroke="#22d3ee"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          {parameters.map((item, index) => {
            const [x, y] = point(index, item.value);
            return (
              <circle
                key={item.label}
                cx={x}
                cy={y}
                r="3.5"
                fill="#67e8f9"
                stroke="#07111f"
                strokeWidth="1.5"
              />
            );
          })}
          {labels.map(({ item, x, y }) => (
            <text
              key={item.label}
              x={x}
              y={y}
              textAnchor={
                x < center - 5 ? "end" : x > center + 5 ? "start" : "middle"
              }
              dominantBaseline="middle"
              fill="#cbd5e1"
              fontSize="10"
              fontWeight="600"
            >
              {item.label}
            </text>
          ))}
        </svg>
        <div className="grid gap-2 sm:grid-cols-2">
          {parameters.map((item, index) => {
            const rank =
              1 +
              horses.filter(
                (other) => horseParameters(other)[index].value > item.value,
              ).length;
            return (
              <div
                key={item.label}
                className="rounded-lg border border-slate-800 bg-black/10 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-200">
                    {item.label}
                  </p>
                  <p className="font-black text-cyan-300">
                    {item.value}
                    <span className="ml-0.5 text-[10px] font-normal text-slate-500">
                      pt
                    </span>
                  </p>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs">
                  <span className="text-slate-500">{item.detail}</span>
                  <span className="text-slate-300">
                    {rank}位 / {horses.length}頭
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-600">
                  母数 {item.samples}走
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HorseDetails({ horse, horses }: { horse: Horse; horses: Horse[] }) {
  const signed = (value: number | undefined) =>
    `${value && value > 0 ? "+" : ""}${value ?? 0}`;
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-bold sm:text-xl">
            {horse.mark} {horse.number} {horse.name}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {horse.gate}枠・{horse.popularity > 0 ? `${horse.popularity}人気` : "人気未発表"}・単勝{" "}
            {horse.odds === null ? "未取得" : `${horse.odds}倍`}　
            {horse.jockey || "騎手取得中"}
          </p>
        </div>
        <p className="shrink-0 text-3xl font-black text-cyan-300">
          {horse.score}
          <span className="text-xs font-normal text-slate-500">pt</span>
        </p>
      </div>
      <ParameterRadar horse={horse} horses={horses} />
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Metric label="1着適性" value={`${horse.firstSuitability ?? 0}pt`} />
        <Metric label="2着適性" value={`${horse.secondSuitability ?? 0}pt`} />
        <Metric label="3着適性" value={`${horse.thirdSuitability ?? 0}pt`} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric
          label="脚質"
          value={
            horse.earlyPosition
              ? `${horse.style}（前半${horse.earlyPosition}番手）`
              : horse.style
          }
        />
        <Metric label="展開補正" value={signed(horse.paceAdjustment)} />
        <Metric label="履歴補正" value={signed(horse.historyAdjustment)} />
        <Metric
          label="馬体重"
          value={
            horse.weight
              ? `${horse.weight}kg（${signed(horse.weightChange)}）`
              : "未発表"
          }
        />
      </div>
      {horse.recentPositions?.length ? (
        <div className="mt-3 rounded-lg border border-slate-800 bg-black/10 px-3 py-2">
          <p className="text-xs text-slate-500">直近の通過順位</p>
          <p className="mt-1 font-mono text-sm text-slate-200">
            {horse.recentPositions.join(" / ")}
          </p>
        </div>
      ) : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-cyan-400/8 p-4">
          <p className="mb-2 flex items-center gap-2 font-semibold text-cyan-300">
            <Sparkles className="size-4" />
            プラス補正
          </p>
          {horse.positives.length ? (
            horse.positives.map((value) => (
              <p key={value} className="py-1 text-sm">
                ＋ {value}
              </p>
            ))
          ) : (
            <p className="text-sm text-slate-400">大きな加点なし</p>
          )}
        </div>
        <div className="rounded-xl bg-rose-400/8 p-4">
          <p className="mb-2 flex items-center gap-2 font-semibold text-rose-300">
            <Activity className="size-4" />
            リスク
          </p>
          {horse.cautions.length ? (
            horse.cautions.map((value) => (
              <p key={value} className="py-1 text-sm">
                − {value}
              </p>
            ))
          ) : (
            <p className="text-sm text-slate-400">大きな減点なし</p>
          )}
        </div>
      </div>
      {horse.historyFactors?.length ? (
        <div className="mt-3 rounded-xl border border-slate-800 p-4">
          <p className="mb-3 text-sm font-semibold">8年履歴の主な評価材料</p>
          <div className="space-y-2">
            {horse.historyFactors.map((item) => (
              <div
                key={item.label}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-3 text-xs"
              >
                <span className="text-slate-300">{item.label}</span>
                <span className="text-slate-500">{item.samples}走</span>
                <span
                  className={
                    item.impact >= 0 ? "text-cyan-300" : "text-rose-300"
                  }
                >
                  {signed(item.impact)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {horse.trainer || horse.pedigree ? (
        <p className="mt-3 text-xs leading-5 text-slate-500">
          調教師：{horse.trainer || "取得中"}
          <br />
          血統：{horse.pedigree || "取得中"}
        </p>
      ) : null}
    </div>
  );
}

function RoleRankings({
  horses,
  onHorse,
}: {
  horses: Horse[];
  onHorse: (horse: Horse) => void;
}) {
  const roles = [
    {
      title: "1着適性",
      key: "firstSuitability" as const,
      probability: "firstProbability" as const,
      color: "text-cyan-300",
    },
    {
      title: "2着適性",
      key: "secondSuitability" as const,
      probability: "secondProbability" as const,
      color: "text-amber-300",
    },
    {
      title: "3着適性",
      key: "thirdSuitability" as const,
      probability: "thirdProbability" as const,
      color: "text-rose-300",
    },
  ];
  return (
    <div>
      <p className="mb-3 text-sm text-slate-400">
        各着順専用モデルが、同じレース内での適性を比較したランキングです。
      </p>
      <div className="grid gap-3 lg:grid-cols-3">
        {roles.map((role) => (
          <Card
            key={role.title}
            className="border-slate-700 bg-[#0c192a] text-white"
          >
            <CardHeader className="pb-2">
              <CardTitle className={`text-base ${role.color}`}>
                {role.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {[...horses]
                .sort((a, b) => (b[role.key] ?? 0) - (a[role.key] ?? 0))
                .map((horse, index) => (
                  <button
                    key={horse.number}
                    onClick={() => onHorse(horse)}
                    className="grid w-full grid-cols-[24px_32px_minmax(0,1fr)_auto] items-center gap-2 border-t border-slate-800 px-4 py-3 text-left hover:bg-white/[.03]"
                  >
                    <span className="text-center text-xs text-slate-500">
                      {index + 1}
                    </span>
                    <span className="grid size-8 place-items-center rounded-md bg-white font-bold text-slate-900">
                      {horse.number}
                    </span>
                    <span className="truncate text-sm font-semibold">
                      {horse.name}
                    </span>
                    <span className={`text-right font-black ${role.color}`}>
                      {horse[role.key] ?? 0}
                      <span className="text-xs font-normal text-slate-500">
                        pt
                      </span>
                      <span className="block text-[10px] font-normal text-slate-500">
                        {((horse[role.probability] ?? 0) * 100).toFixed(1)}%
                      </span>
                    </span>
                  </button>
                ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-black/10 p-3">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-200">{value}</p>
    </div>
  );
}
