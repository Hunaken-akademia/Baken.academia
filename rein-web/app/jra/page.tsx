"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Clock3,
  Database,
  Gauge,
  Layers3,
  RefreshCw,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { compactSelections } from "@/lib/tickets";
import { raceProgress } from "@/lib/race-progress";
import { reasonViews } from "@/lib/feature-labels";
import { roleOrder, type Picks, type MarkPick } from "@/lib/marks";

type HistoryFactor = {
  label: string;
  samples: number;
  impact: number;
  wins?: number;
  top3?: number;
  winRate?: number;
  top3Rate?: number;
  averageFinish?: number;
};
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
  age?: number;
  sex?: string;
  weightCarried?: number;
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
  marketFirstProbability?: number | null;
  reinMarketFirstProbability?: number | null;
  historyFactors?: HistoryFactor[];
  parameterFactors?: HistoryFactor[];
  roleReasons?: {
    first?: Array<{ feature: string; contribution: number }>;
    second?: Array<{ feature: string; contribution: number }>;
    third?: Array<{ feature: string; contribution: number }>;
  };
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
  prediction?: {
    phase: "preview" | "prestart" | "poststart" | "final";
    source: "live" | "prestart" | "rebuilt";
    generatedAt: string;
    label: string;
  };
  evaluation?: {
    roleModel: "ready" | "unavailable";
    overall: "ready" | "held";
    tickets: "ready" | "held";
    held: string[];
  };
  picks?: Picks;
  scratched?: Array<{ number: number; name: string }>;
  model?: {
    version: string;
    dateFrom: string;
    dateTo: string;
    races: number;
    runners: number;
    horses: number;
    strategy: string;
    overallPolicy?: string;
    markPolicy?: string;
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
  // The race whose detail failed to load, so the error banner can offer a retry.
  const [failedRace, setFailedRace] = useState<string | null>(null);
  // Set while an older snapshot is shown and the server refreshes it in the background.
  const [refreshing, setRefreshing] = useState(false);
  const staleRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      setFailedRace(null);
    }
    try {
      const response = await fetch(`/api/analyze?raceId=${race.raceId}${scheduleDay === "tomorrow" ? "&preview=1" : ""}`);
      const result = (await response.json().catch(() => ({}))) as Analysis & { error?: string };
      if (!response.ok || !result.race) throw new Error(result.error || "レース情報を取得できませんでした");
      const stale = response.headers.get("x-rein-stale") === "1";
      if (staleRetry.current) clearTimeout(staleRetry.current);
      staleRetry.current = null;
      setRefreshing(stale);
      // Pick up the refreshed snapshot once; the CDN keeps responses for 15s.
      if (stale && !background)
        staleRetry.current = setTimeout(() => void analyze(race, true), 25_000);
      setData(result);
      setActiveHorse((current) =>
        background && current ? result.horses.find((horse) => horse.number === current.number) ?? null : null,
      );
    } catch (value) {
      if (!background) {
        setError(value instanceof Error ? value.message : "レース情報を取得できませんでした");
        setFailedRace(race.raceId);
      }
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
    if (staleRetry.current) clearTimeout(staleRetry.current);
    staleRetry.current = null;
    setRefreshing(false);
    setError("");
    setFailedRace(null);
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
              会員版
            </Badge>
          </div>
        </header>
        {error && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-200">
            <AlertTriangle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">
              {failedRace ? `${Number(failedRace.slice(-2))}Rを開けませんでした：${error}` : error}
            </span>
            {failedRace && (
              <Button
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => void analyze({ raceId: failedRace })}
                className="border-rose-300/40 bg-transparent text-rose-100 hover:bg-rose-400/20"
              >
                再取得
              </Button>
            )}
          </div>
        )}
        {data && refreshing && (
          <p className="mb-3 flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-3 text-sm text-cyan-100">
            <RefreshCw className="size-4 shrink-0 animate-spin" />
            <span className="min-w-0 break-words">
              {data.race.updated}の情報を表示中です。最新の情報を計算しており、まもなく自動で切り替わります。
            </span>
          </p>
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
            onSelect={(item) => {
              setError("");
              setFailedRace(null);
              setVenue(item);
            }}
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
            loading={loading}
            onRetry={() => void analyze({ raceId: data.race.raceId })}
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
        <p className="text-sm font-semibold text-cyan-300">{day === "today" ? "本日の中央競馬" : "明日の中央競馬"}</p>
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

const venueTraits: Record<string, string> = {
  札幌: "小回りで直線は短め。平坦で、器用さと好位で運ぶ力が重要。",
  函館: "小回り・直線短め。コーナーで動ける機動力と持続力を重視。",
  福島: "小回りで高低差があり、早めに動ける持続力とコーナー適性が鍵。",
  新潟: "広いコース。外回りは長い直線、内回りは位置取りと持続力が重要。",
  東京: "直線が長く坂もある。末脚の持続力と直線での加速力を重視。",
  中山: "小回りで起伏が大きい。器用さ、位置取り、急坂をこなす力が重要。",
  中京: "左回りで直線に坂がある。持続力と坂を越えて伸びる力を重視。",
  京都: "3〜4コーナーの坂が特徴。下りから加速し、脚を長く使える馬が有利。",
  阪神: "直線に坂がある。外回りは末脚、内回りは位置取りと持続力を重視。",
  小倉: "小回りで平坦。先行力、コーナー加速、ロスなく運ぶ器用さが重要。",
};

function courseGuide(race: Analysis["race"]) {
  const venue = Object.keys(venueTraits).find((name) => race.title.includes(name));
  const distance = +(race.course.match(/(\d{3,4})m/)?.[1] || 0);
  const distanceTrait = distance <= 1200
    ? "短距離：序盤の加速、先行力、スピードの持続が中心。"
    : distance <= 1400
      ? "1400m前後：短距離の速さに加え、折り合いと終盤の持続力も必要。"
      : distance <= 1600
        ? "マイル：位置取り、折り合い、直線の加速力のバランスが重要。"
        : distance <= 1800
          ? "1800m前後：コーナー運びと折り合い、長く脚を使う力を重視。"
          : distance <= 2000
            ? "2000m前後：先行力・持続力・スタミナの総合力が問われる。"
            : distance <= 2400
              ? "中長距離：折り合い、スタミナ、仕掛けどころへの対応が重要。"
              : "長距離：スタミナと折り合いを最優先。瞬発力だけでなく持続力が必要。";
  const layout = [
    race.course.includes("左") ? "左回り" : race.course.includes("右") ? "右回り" : "",
    race.course.includes("外") ? "外回り" : race.course.includes("内") ? "内回り" : "",
    race.course.startsWith("芝") ? "芝" : race.course.startsWith("ダート") ? "ダート" : "",
  ].filter(Boolean).join("・");
  return {
    venue: venue || "コース",
    venueTrait: venue ? venueTraits[venue] : "当日のコース形状と脚質の相性を比較。",
    distanceTrait,
    layout: `${layout || race.course}。馬場は${race.condition || "未発表"}。`,
  };
}

function visibleMark(mark: string | undefined) {
  return mark === "消" ? "・" : mark || "・";
}

function visibleVerdict(verdict: string | undefined) {
  return verdict === "見送り" ? "候補" : verdict || "候補";
}

function overallReady(data: Analysis) {
  return data.evaluation?.overall !== "held";
}

function roleReady(data: Analysis) {
  return data.evaluation?.roleModel !== "unavailable";
}

// data.horses is already in overall-ranking order (market Top4 + legacy tail).
function overallRankOf(data: Analysis, horse: Horse) {
  return overallReady(data)
    ? data.horses.findIndex((item) => item.number === horse.number) + 1
    : null;
}

function AnalysisScreen({
  data,
  activeHorse,
  danger,
  loading,
  onRetry,
  onBack,
  onHorse,
}: {
  data: Analysis;
  activeHorse: Horse | null;
  danger: Horse | undefined;
  loading: boolean;
  onRetry: () => void;
  onBack: () => void;
  onHorse: (horse: Horse) => void;
}) {
  const top3 = data.review?.finishers.slice(0, 3) ?? [];
  const guide = courseGuide(data.race);
  const insights = raceInsights(data);
  const held = data.evaluation?.held ?? [];
  const rolesReady = roleReady(data);
  const rankingReady = overallReady(data);
  const listHorses = rankingReady
    ? data.horses
    : [...data.horses].sort((a, b) => a.number - b.number);
  const firstOrder = rolesReady ? roleOrder(data.horses, "first") : [];
  const firstRank = (horse: Horse) =>
    firstOrder.findIndex((item) => item.number === horse.number) + 1;
  return (
    <>
      {data.model && (
        <section className="mb-4 flex flex-wrap gap-x-4 gap-y-1 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-4 py-2 text-xs text-slate-400">
          <span className="font-semibold text-cyan-300">8年履歴 接続済み</span>
          <span>
            {data.model.races.toLocaleString()}レース・
            {data.model.runners.toLocaleString()}走
          </span>
          {data.model.overallPolicy && <span>{data.model.overallPolicy}</span>}
          <span>{data.model.strategy}</span>
          {data.model.markPolicy && <span>印：{data.model.markPolicy}</span>}
          {data.prediction ? <span>{data.prediction.label}</span> : <span>{data.model.snapshotPolicy}</span>}
        </section>
      )}
      {held.length > 0 && (
        <section className="mb-4 rounded-xl border border-amber-400/30 bg-amber-400/[.07] p-3 text-sm text-amber-100">
          <div className="flex flex-wrap items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1 space-y-1 break-words">
              {held.map((item) => (
                <p key={item}>{item}</p>
              ))}
              <p className="text-xs text-amber-200/70">
                出走表・馬情報・履歴は表示しています。保留中の評価は、推定値で補わずに取得後に表示します。
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={onRetry}
              className="border-amber-300/40 bg-transparent text-amber-100 hover:bg-amber-400/20"
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              再取得
            </Button>
          </div>
        </section>
      )}
      {data.review?.isFinished && (
        <section className="mb-4 rounded-2xl border border-emerald-400/30 bg-emerald-400/[.07] p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold tracking-widest text-emerald-300">
                結果照合
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
                      {visibleMark(predicted?.mark)}
                    </span>
                    {predicted && overallRankOf(data, predicted)
                      ? `・総合${overallRankOf(data, predicted)}位`
                      : ""}
                    {predicted && rolesReady ? `・1着適性${firstRank(predicted)}位` : ""}
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
            {data.prediction && data.prediction.phase !== "prestart" && (
              <p className="mt-1 text-xs leading-5 text-amber-200">{data.prediction.label}</p>
            )}
            <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
              {data.race.title}
            </h1>
            <p className="mt-1 text-slate-400">
              {data.race.course}　{data.race.condition}
            </p>
            <PickCards data={data} onHorse={onHorse} />
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
                  {!rankingReady ? "評価保留" : danger ? `${danger.number} ${danger.name}` : "該当なし"}
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  {!rankingReady ? "総合評価の取得後に表示します" : danger?.cautions.join("・") || "人気と評価が一致"}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>
      <section className="mb-5 rounded-2xl border border-cyan-400/20 bg-[#0c192a] p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-widest text-cyan-300">コースガイド</p>
            <h2 className="mt-1 text-lg font-bold">{guide.venue}・この条件の特徴</h2>
          </div>
          <Badge className="bg-cyan-400/10 text-cyan-300">予想の前提</Badge>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-3">
          <div className="rounded-xl border border-slate-800 bg-black/10 p-3">
            <p className="text-xs font-semibold text-amber-300">競馬場</p>
            <p className="mt-1 text-sm leading-6 text-slate-300">{guide.venueTrait}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-black/10 p-3">
            <p className="text-xs font-semibold text-emerald-300">距離</p>
            <p className="mt-1 text-sm leading-6 text-slate-300">{guide.distanceTrait}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-black/10 p-3">
            <p className="text-xs font-semibold text-violet-300">今回の条件</p>
            <p className="mt-1 text-sm leading-6 text-slate-300">{guide.layout}</p>
          </div>
        </div>
      </section>
      <RaceIntelligence data={data} insights={insights} />
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
          <p className="mb-3 text-xs leading-5 text-slate-500">
            {rankingReady
              ? "順位は総合順位（上位4頭＝市場差式、5位以下＝従来の総合評価順）。ptは従来方式の総合評価点で、上限98のため上位馬は同点になることがあり、上位4頭の並びとは一致しません。"
              : "総合順位は保留中のため、馬番順で表示しています。"}
          </p>
          <div className="overflow-hidden rounded-2xl border border-slate-700 bg-[#0c192a]">
            {listHorses.map((horse, index) => {
              const expanded = activeHorse?.number === horse.number;
              return (
                <Fragment key={horse.number}>
                  <button
                    onClick={() => onHorse(horse)}
                    aria-expanded={expanded}
                    className={`grid w-full grid-cols-[28px_36px_minmax(0,1fr)_58px_20px] items-center gap-2 border-b border-slate-800 px-3 py-3 text-left transition sm:grid-cols-[32px_40px_minmax(0,1fr)_105px_60px_20px] ${expanded ? "bg-cyan-400/8" : "hover:bg-white/[.03]"}`}
                  >
                    <span className="text-center text-sm text-slate-500">
                      {rankingReady ? index + 1 : "－"}
                    </span>
                    <span className="grid size-8 place-items-center rounded-md bg-white font-bold text-slate-900">
                      {horse.number}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-semibold">
                        {visibleMark(horse.mark)} {horse.name}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {[horse.style, visibleVerdict(horse.verdict)].filter(Boolean).join("・")}
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
                      {rankingReady ? (
                        <>
                          {horse.score}
                          <span className="text-xs text-slate-500">pt</span>
                        </>
                      ) : (
                        <span className="text-xs font-normal text-slate-500">保留</span>
                      )}
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
                      <HorseDetails horse={horse} data={data} />
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </TabsContent>
        <TabsContent value="roles">
          {rolesReady ? (
            <RoleRankings horses={data.horses} onHorse={onHorse} />
          ) : (
            <HeldPanel text="着順別モデルの結果を取得できないため、着順適性ランキングを保留しています。" />
          )}
        </TabsContent>
        <TabsContent value="tickets">
          {data.evaluation?.tickets === "held" && (
            <HeldPanel text="買い目は保留中です。人気・着順別モデルの結果がそろってから生成します。" />
          )}
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
                <HorseDetails horse={activeHorse} data={data} />
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-[#0c192a] p-8 text-center text-slate-400">
              全頭評価か着順適性から馬を選ぶと詳細診断を表示します
            </div>
          )}
        </TabsContent>
      </Tabs>
      {rolesReady && <MarketReinComparison data={data} horses={listHorses} />}
      <DetailedComparison data={data} horses={listHorses} />
      {rankingReady && <OverallAssessment data={data} insights={insights} onHorse={onHorse} />}
    </>
  );
}

type RaceInsights = {
  leaders: Horse[];
  styles: Array<{ label: string; count: number }>;
  roleLeaders: Array<{ label: string; horse: Horse; value: number }>;
  courseLeaders: Horse[];
  scoreGap: number;
  confidence: string;
  difficulty: string;
  oddsCoverage: number;
  weightCoverage: number;
  core: Horse[];
  rivals: Horse[];
  sleepers: Horse[];
};

function raceInsights(data: Analysis): RaceInsights {
  const horses = data.horses;
  // Overall-ranking order as delivered by the API (not the saturated legacy pt).
  const sorted = horses;
  const top = sorted[0];
  const second = sorted[1];
  const scoreGap = top && second ? Math.max(0, top.score - second.score) : 0;
  const styleGroups = [
    { label: "逃げ", match: (style: string) => style.includes("逃") },
    { label: "先行", match: (style: string) => style.includes("先") || style.includes("好位") },
    { label: "差し", match: (style: string) => style.includes("差") || style.includes("中団") },
    { label: "追込", match: (style: string) => style.includes("追") || style.includes("後方") },
  ];
  const styles = styleGroups.map(({ label, match }) => ({
    label,
    count: horses.filter((horse) => match(horse.style)).length,
  }));
  const roleKeys = [
    { label: "1着適性", key: "firstSuitability" as const },
    { label: "2着適性", key: "secondSuitability" as const },
    { label: "3着適性", key: "thirdSuitability" as const },
  ];
  const roleLeaders = roleReady(data)
    ? roleKeys.flatMap(({ label, key }) => {
        const role = key === "firstSuitability" ? "first" : key === "secondSuitability" ? "second" : "third";
        const horse = roleOrder(horses, role)[0];
        return horse ? [{ label, horse, value: horse[key] ?? 0 }] : [];
      })
    : [];
  const courseLeaders = [...horses]
    .sort((a, b) => horseParameters(b)[3].value - horseParameters(a)[3].value)
    .slice(0, 3);
  const oddsCoverage = horses.length
    ? Math.round((horses.filter((horse) => horse.odds !== null).length / horses.length) * 100)
    : 0;
  const weightCoverage = horses.length
    ? Math.round((horses.filter((horse) => Boolean(horse.weight)).length / horses.length) * 100)
    : 0;
  const confidence = scoreGap >= 8 ? "上位明確" : scoreGap >= 4 ? "上位やや優勢" : "接戦";
  const difficulty = scoreGap >= 8 && roleLeaders.filter((item) => item.horse.number === top?.number).length >= 2
    ? "比較的読みやすい"
    : scoreGap <= 2
      ? "混戦"
      : "標準";
  const core = sorted.slice(0, 2);
  const rivals = sorted.slice(2, 5);
  const sleepers = sorted
    .filter((horse) => horse.popularity >= 4 || horse.popularity <= 0)
    .sort((a, b) => {
      const aRole = Math.max(a.firstSuitability ?? 0, a.secondSuitability ?? 0, a.thirdSuitability ?? 0);
      const bRole = Math.max(b.firstSuitability ?? 0, b.secondSuitability ?? 0, b.thirdSuitability ?? 0);
      return bRole + horseParameters(b)[3].value - (aRole + horseParameters(a)[3].value);
    })
    .slice(0, 3);
  return {
    leaders: data.pace.leaders
      .map((number) => horses.find((horse) => horse.number === number))
      .filter((horse): horse is Horse => Boolean(horse)),
    styles,
    roleLeaders,
    courseLeaders,
    scoreGap,
    confidence,
    difficulty,
    oddsCoverage,
    weightCoverage,
    core,
    rivals,
    sleepers,
  };
}

function RaceIntelligence({ data, insights }: { data: Analysis; insights: RaceInsights }) {
  return (
    <section className="mb-5">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-widest text-cyan-300">レース分析</p>
          <h2 className="mt-1 text-xl font-bold">レース情報ボード</h2>
        </div>
        <Badge className="bg-white/10 text-slate-300">判断材料</Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <InfoPanel icon={<Layers3 className="size-5 text-amber-300" />} title="展開構成">
          <p className="font-bold text-white">{data.pace.label}</p>
          <p className="mt-1 text-sm leading-5 text-slate-400">{data.pace.detail}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {insights.styles.map((style) => (
              <Badge key={style.label} variant="outline" className="border-slate-700 text-slate-300">
                {style.label} {style.count}頭
              </Badge>
            ))}
          </div>
        </InfoPanel>
        <InfoPanel icon={<TrendingUp className="size-5 text-cyan-300" />} title="前で運ぶ候補">
          {insights.leaders.length ? insights.leaders.map((horse) => (
            <HorseLine key={horse.number} horse={horse} suffix={horse.style} />
          )) : <p className="text-sm text-slate-400">明確な先導役は未確定</p>}
        </InfoPanel>
        <InfoPanel icon={<Target className="size-5 text-emerald-300" />} title="着順適性トップ">
          {insights.roleLeaders.length ? insights.roleLeaders.map((item) => (
            <HorseLine key={item.label} horse={item.horse} prefix={item.label} suffix={`${item.value}pt`} />
          )) : <p className="text-sm text-slate-400">着順別モデルの結果を取得後に表示します</p>}
        </InfoPanel>
        <InfoPanel icon={<Database className="size-5 text-violet-300" />} title="当日データ">
          <DataCoverage label="オッズ" value={insights.oddsCoverage} />
          <DataCoverage label="馬体重" value={insights.weightCoverage} />
          <p className="mt-3 text-xs leading-5 text-slate-500">
            未発表項目は評価に混ぜず、取得後の再分析で更新します。
          </p>
        </InfoPanel>
      </div>
    </section>
  );
}

function InfoPanel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-700 bg-[#0c192a] p-4">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h3 className="font-semibold text-slate-200">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function HorseLine({ horse, prefix, suffix }: { horse: Horse; prefix?: string; suffix?: string }) {
  return (
    <div className="flex items-center gap-2 border-t border-slate-800 py-2 first:border-t-0 first:pt-0">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white text-sm font-bold text-slate-900">{horse.number}</span>
      <div className="min-w-0 flex-1">
        {prefix ? <p className="text-[11px] text-slate-500">{prefix}</p> : null}
        <p className="truncate text-sm font-semibold text-slate-200">{horse.name}</p>
      </div>
      {suffix ? <span className="shrink-0 text-xs text-cyan-300">{suffix}</span> : null}
    </div>
  );
}

function DataCoverage({ label, value }: { label: string; value: number }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex justify-between text-xs"><span className="text-slate-400">{label}</span><span className="text-slate-200">{value}%</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-cyan-400" style={{ width: `${value}%` }} /></div>
    </div>
  );
}

function OverallAssessment({ data, insights, onHorse }: { data: Analysis; insights: RaceInsights; onHorse: (horse: Horse) => void }) {
  const list = (horses: Horse[], color: string) => (
    <div className="mt-3 flex flex-wrap gap-2">
      {horses.map((horse) => (
        <button key={horse.number} onClick={() => onHorse(horse)} className={`rounded-lg border px-3 py-2 text-left transition hover:-translate-y-0.5 ${color}`}>
          <span className="mr-2 font-black">{horse.number}</span>
          <span className="text-sm font-semibold">{horse.name}</span>
          <span className="ml-2 text-xs opacity-70">総合{overallRankOf(data, horse)}位</span>
        </button>
      ))}
    </div>
  );
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-cyan-400/30 bg-gradient-to-br from-[#11304a] via-[#0d2237] to-[#081522]">
      <div className="border-b border-cyan-400/15 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black">総合評価</h2>
          </div>
        </div>
        <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-300">
          {data.pace.label}想定。
          着順適性・コース相性・展開を別々に確認し、順位を固定せず候補を広く表示しています。
        </p>
      </div>
      <div className="grid gap-px bg-cyan-400/10 md:grid-cols-3">
        <div className="bg-[#0b1b2c] p-5">
          <p className="text-sm font-bold text-cyan-300">軸候補</p>
          <p className="mt-1 text-xs text-slate-500">総合順位1・2位</p>
          {list(insights.core, "border-cyan-400/30 bg-cyan-400/10 text-cyan-100")}
        </div>
        <div className="bg-[#0b1b2c] p-5">
          <p className="text-sm font-bold text-amber-300">相手候補</p>
          <p className="mt-1 text-xs text-slate-500">総合順位3〜5位</p>
          {list(insights.rivals, "border-amber-400/25 bg-amber-400/[.07] text-amber-100")}
        </div>
        <div className="bg-[#0b1b2c] p-5">
          <p className="text-sm font-bold text-rose-300">注目候補</p>
          <p className="mt-1 text-xs text-slate-500">着順適性・コース評価から拾う馬</p>
          {list(insights.sleepers, "border-rose-400/25 bg-rose-400/[.07] text-rose-100")}
        </div>
      </div>
      <div className="grid gap-3 border-t border-cyan-400/15 p-5 sm:grid-cols-3 sm:p-6">
        {insights.courseLeaders.map((horse, index) => (
          <button key={horse.number} onClick={() => onHorse(horse)} className="flex items-center gap-3 rounded-xl border border-slate-700 bg-black/15 p-3 text-left hover:border-cyan-400/40">
            <span className="text-xs font-bold text-emerald-300">コース適性 {index + 1}位</span>
            <span className="grid size-7 place-items-center rounded-md bg-white text-sm font-bold text-slate-900">{horse.number}</span>
            <span className="min-w-0 truncate text-sm font-semibold">{horse.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function MarketReinComparison({ data, horses }: { data: Analysis; horses: Horse[] }) {
  const ranked = horses;
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-violet-400/25 bg-[#0c192a]">
      <div className="border-b border-slate-700 p-4 sm:p-5">
        <p className="text-xs font-semibold tracking-widest text-violet-300">市場 × REIN</p>
        <h2 className="mt-1 text-xl font-bold">人気と着順適性の比較</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">人気のコピーではなく、着順ごとにREINがどこを上げ下げしたかを一覧化。</p>
      </div>
      <div className="grid gap-2 p-3 md:hidden">
        {ranked.map((horse) => (
          <div key={horse.number} className="rounded-xl border border-slate-700 bg-black/10 p-3">
            <div className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-md bg-white font-bold text-slate-900">{horse.number}</span>
              <span className="min-w-0 flex-1 truncate font-semibold">{horse.name}</span>
              <span className="text-xs text-slate-400">{horse.popularity > 0 ? horse.popularity + "人気" : "人気未発表"}</span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {(["firstSuitability","secondSuitability","thirdSuitability"] as const).map((key, i) => {
                const item=marketRoleComparison(horse,data.horses,key);
                return <div key={key} className="rounded-lg bg-white/[.04] p-2 text-center"><p className="text-[11px] text-slate-500">{i+1}着</p><p className="text-sm font-bold">REIN {item.reinRank}位</p><p className={"mt-1 text-[11px] font-semibold "+item.tone}>{item.label}</p></div>
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-black/20 text-xs text-slate-400"><tr><TableHead>馬</TableHead><TableHead>人気</TableHead><TableHead>1着</TableHead><TableHead>2着</TableHead><TableHead>3着</TableHead></tr></thead>
          <tbody>{ranked.map((horse)=><tr key={horse.number} className="border-t border-slate-800"><td className="p-3 font-semibold">{horse.number} {horse.name}</td><td className="p-3">{horse.popularity>0?horse.popularity+"位":"未発表"}</td>{(["firstSuitability","secondSuitability","thirdSuitability"] as const).map(key=>{const item=marketRoleComparison(horse,data.horses,key);return <td key={key} className="p-3"><span className="font-bold">REIN {item.reinRank}位</span><span className={"ml-2 text-xs font-semibold "+item.tone}>{item.label}</span></td>})}</tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function DetailedComparison({ data, horses }: { data: Analysis; horses: Horse[] }) {
  const ranked = horses;
  const rankingReady = overallReady(data);
  const rolesReady = roleReady(data);
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-slate-700 bg-[#0c192a]">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-700 p-4 sm:p-5">
        <div>
          <p className="text-xs font-semibold tracking-widest text-cyan-300">全頭比較</p>
          <h2 className="mt-1 text-xl font-bold">全頭詳細比較</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            適性ptはレース内相対評価、確率は着順専用モデルの推定値です。
          </p>
        </div>
        <Badge className="bg-white/10 text-slate-300">全{horses.length}頭</Badge>
      </div>
      <div className="grid gap-2 p-3 md:hidden">
        {ranked.map((horse, index) => {
          const parameters = horseParameters(horse);
          return (
            <article key={horse.number} className="rounded-xl border border-slate-700 bg-black/10 p-3">
              <div className="flex items-center gap-3">
                <span className="w-8 text-center text-sm font-black text-cyan-300">{rankingReady ? `${index + 1}位` : "－"}</span>
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white font-black text-slate-900">{horse.number}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold text-slate-100">{horse.name}</p>
                  <p className="text-xs text-slate-500">
                    {horse.sex || "－"}{horse.age || "－"}・{horse.weightCarried ? `${horse.weightCarried}kg` : "斤量未取得"}・{horse.popularity > 0 ? `${horse.popularity}人気` : "人気未発表"}
                  </p>
                </div>
                {rankingReady ? <p className="text-xl font-black text-cyan-300">{horse.score}<span className="text-[10px] text-slate-500">pt</span></p> : null}
              </div>
              {rolesReady ? <div className="mt-3 grid grid-cols-3 gap-1.5">
                <CompactStat label={`1着・${roleRankOf(data.horses, horse, "firstSuitability")}位`} value={`${horse.firstSuitability ?? 0}pt`} sub={formatProbability(horse.firstProbability)} color="text-cyan-300" />
                <CompactStat label={`2着・${roleRankOf(data.horses, horse, "secondSuitability")}位`} value={`${horse.secondSuitability ?? 0}pt`} sub={formatProbability(horse.secondProbability)} color="text-amber-300" />
                <CompactStat label={`3着・${roleRankOf(data.horses, horse, "thirdSuitability")}位`} value={`${horse.thirdSuitability ?? 0}pt`} sub={formatProbability(horse.thirdProbability)} color="text-rose-300" />
              </div> : <p className="mt-3 text-xs text-slate-500">着順適性：保留中</p>}
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                <CompactStat label="コース" value={`${parameters[3].value}`} />
                <CompactStat label="近走" value={`${parameters[4].value}`} />
                <CompactStat label="展開" value={signedNumber(horse.paceAdjustment)} />
                <CompactStat label="履歴" value={signedNumber(horse.historyAdjustment)} sub={`${horse.historySamples ?? 0}走`} />
              </div>
              <p className="mt-3 rounded-lg bg-cyan-400/[.06] px-3 py-2 text-sm leading-5 text-slate-300">
                <span className="mr-1 font-semibold text-cyan-300">一言：</span>{horseMemo(horse, data)}
              </p>
            </article>
          );
        })}
      </div>
      <div className="hidden overflow-x-auto md:block" data-no-swipe>
        <table className="min-w-[1180px] w-full border-collapse text-sm">
          <thead className="bg-black/20 text-xs text-slate-400">
            <tr>
              <TableHead sticky>総合</TableHead>
              <TableHead>馬</TableHead>
              <TableHead>性齢</TableHead>
              <TableHead>斤量</TableHead>
              <TableHead>人気</TableHead>
              <TableHead>単勝</TableHead>
              <TableHead>1着適性</TableHead>
              <TableHead>1着確率</TableHead>
              <TableHead>2着適性</TableHead>
              <TableHead>2着確率</TableHead>
              <TableHead>3着適性</TableHead>
              <TableHead>3着確率</TableHead>
              <TableHead>コース</TableHead>
              <TableHead>近走</TableHead>
              <TableHead>展開補正</TableHead>
              <TableHead>履歴補正</TableHead>
              <TableHead>履歴母数</TableHead>
            </tr>
          </thead>
          <tbody>
            {ranked.map((horse, index) => {
              const parameters = horseParameters(horse);
              return (
                <tr key={horse.number} className="border-t border-slate-800 hover:bg-white/[.025]">
                  <TableCell sticky>
                    <span className="font-black text-cyan-300">{rankingReady ? `${index + 1}位` : "－"}</span>
                    {rankingReady ? <span className="ml-1 text-xs text-slate-500">{horse.score}pt</span> : null}
                  </TableCell>
                  <TableCell>
                    <span className="mr-2 inline-grid size-7 place-items-center rounded-md bg-white font-bold text-slate-900">{horse.number}</span>
                    <span className="font-semibold text-slate-100">{horse.name}</span>
                  </TableCell>
                  <TableCell>{horse.sex || "－"}{horse.age || "－"}</TableCell>
                  <TableCell>{horse.weightCarried ? `${horse.weightCarried}kg` : "未取得"}</TableCell>
                  <TableCell>{horse.popularity > 0 ? `${horse.popularity}人気` : "未発表"}</TableCell>
                  <TableCell>{horse.odds === null ? "未発表" : `${horse.odds}倍`}</TableCell>
                  {rolesReady ? (
                    <>
                      <RoleCell value={horse.firstSuitability ?? 0} rank={roleRankOf(data.horses, horse, "firstSuitability")} />
                      <ProbabilityCell value={horse.firstProbability} />
                      <RoleCell value={horse.secondSuitability ?? 0} rank={roleRankOf(data.horses, horse, "secondSuitability")} />
                      <ProbabilityCell value={horse.secondProbability} />
                      <RoleCell value={horse.thirdSuitability ?? 0} rank={roleRankOf(data.horses, horse, "thirdSuitability")} />
                      <ProbabilityCell value={horse.thirdProbability} />
                    </>
                  ) : (
                    [0, 1, 2, 3, 4, 5].map((cell) => <TableCell key={cell}>保留</TableCell>)
                  )}
                  <TableCell>{parameters[3].value}pt</TableCell>
                  <TableCell>{parameters[4].value}pt</TableCell>
                  <SignedCell value={horse.paceAdjustment} />
                  <SignedCell value={horse.historyAdjustment} />
                  <TableCell>{horse.historySamples ? `${horse.historySamples}走` : "0走"}</TableCell>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Same ordering as the API's card selection (probability, ties keep overall order).
function roleRankOf(
  horses: Horse[],
  horse: Horse,
  key: "firstSuitability" | "secondSuitability" | "thirdSuitability",
) {
  const role = key === "firstSuitability" ? "first" : key === "secondSuitability" ? "second" : "third";
  return roleOrder(horses, role).findIndex((item) => item.number === horse.number) + 1;
}

function formatProbability(value: number | undefined) {
  return value === undefined ? "未取得" : `${(value * 100).toFixed(1)}%`;
}

function signedNumber(value: number | undefined) {
  const safe = value ?? 0;
  return `${safe > 0 ? "+" : ""}${safe}`;
}

function horseMemo(horse: Horse, data: Analysis) {
  const horses = data.horses;
  const rank = overallRankOf(data, horse);
  if (!roleReady(data)) return "着順別モデルの結果を取得後に表示します。";
  const roles = [
    { label: "1着", value: horse.firstSuitability ?? 0, probability: horse.firstProbability, rank: roleRankOf(horses, horse, "firstSuitability") },
    { label: "2着", value: horse.secondSuitability ?? 0, probability: horse.secondProbability, rank: roleRankOf(horses, horse, "secondSuitability") },
    { label: "3着", value: horse.thirdSuitability ?? 0, probability: horse.thirdProbability, rank: roleRankOf(horses, horse, "thirdSuitability") },
  ].sort((a, b) => a.rank - b.rank || b.value - a.value);
  const best = roles[0];
  const weakest = [...roles].sort((a, b) => b.rank - a.rank || a.value - b.value)[0];
  const parameters = horseParameters(horse);
  const course = parameters[3].value;
  const recent = parameters[4].value;
  const pace = horse.paceAdjustment ?? 0;
  const samples = horse.historySamples ?? 0;
  const popularity = horse.popularity > 0 ? horse.popularity : null;
  const probability = best.probability === undefined
    ? ""
    : `・推定${(best.probability * 100).toFixed(1)}%`;

  const sentences: string[] = [];
  const overall = rank ? `総合${rank}位。` : "";
  const marketGap = popularity ? popularity - best.rank : 0;
  const marketView = !popularity
    ? ""
    : marketGap >= 3
      ? `${popularity}番人気を${marketGap}段階上回る評価`
      : marketGap <= -3
        ? `${popularity}番人気に対して${Math.abs(marketGap)}段階低い評価`
        : `${popularity}番人気と大きな差はない評価`;
  sentences.push(
    `${overall}${best.label}適性${best.rank}位（${best.value}pt${probability}）が3つの着順適性で最上位${marketView ? `、${marketView}` : ""}。`,
  );

  const strengths: string[] = [];
  if (course >= 75) strengths.push(`コース${course}pt`);
  if (recent >= 70) strengths.push(`近走${recent}pt`);
  if (pace > 0) strengths.push(`展開補正+${pace}`);
  if (strengths.length) {
    sentences.push(`${strengths.join("・")}が強み。`);
  } else {
    sentences.push(`コース${course}pt・近走${recent}pt。`);
  }

  const cautions: string[] = [];
  if (weakest.rank - best.rank >= 5) {
    cautions.push(`${weakest.label}適性は${weakest.rank}位`);
  }
  if (pace <= -2) cautions.push("先行争いの負荷に注意");
  if (samples > 0 && samples < 10) cautions.push(`履歴${samples}走の少数評価`);
  if (cautions.length) {
    sentences.push(`${cautions.join("、")}。`);
  } else if (samples > 0) {
    sentences.push(`履歴${samples}走を含め、着順ごとの適性差まで確認したい。`);
  }
  return sentences.join("");
}

function CompactStat({ label, value, sub, color = "text-slate-100" }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-[#081522] px-2 py-2 text-center">
      <p className="truncate text-[10px] text-slate-500">{label}</p>
      <p className={`mt-0.5 text-sm font-black ${color}`}>{value}</p>
      {sub ? <p className="text-[10px] text-slate-600">{sub}</p> : null}
    </div>
  );
}

function TableHead({ children, sticky = false }: { children: React.ReactNode; sticky?: boolean }) {
  return <th className={`whitespace-nowrap px-3 py-3 text-left font-semibold ${sticky ? "sticky left-0 z-20 bg-[#091522]" : ""}`}>{children}</th>;
}

function TableCell({ children, sticky = false }: { children: React.ReactNode; sticky?: boolean }) {
  return <td className={`whitespace-nowrap px-3 py-3 text-slate-300 ${sticky ? "sticky left-0 z-10 bg-[#0c192a]" : ""}`}>{children}</td>;
}

function RoleCell({ value, rank }: { value: number; rank: number }) {
  return <TableCell><span className="font-bold text-slate-100">{value}pt</span><span className="ml-1 text-[11px] text-slate-500">({rank}位)</span></TableCell>;
}

function ProbabilityCell({ value }: { value: number | undefined }) {
  return <TableCell>{value === undefined ? "未取得" : `${(value * 100).toFixed(1)}%`}</TableCell>;
}

function SignedCell({ value }: { value: number | undefined }) {
  const safe = value ?? 0;
  return <TableCell><span className={safe > 0 ? "text-cyan-300" : safe < 0 ? "text-rose-300" : "text-slate-400"}>{safe > 0 ? "+" : ""}{safe}</span></TableCell>;
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

function marketRoleComparison(horse: Horse, horses: Horse[], key: "firstSuitability" | "secondSuitability" | "thirdSuitability") {
  const reinRank = roleRankOf(horses, horse, key);
  const marketRank = horse.popularity > 0 ? horse.popularity : null;
  const gap = marketRank ? marketRank - reinRank : 0;
  const label = !marketRank ? "人気未発表" : gap >= 3 ? "★ 注目" : gap >= 1 ? "↑ 人気以上" : gap <= -2 ? "↓ 慎重評価" : "≒ 評価一致";
  const tone = gap >= 3 ? "text-amber-300" : gap >= 1 ? "text-emerald-300" : gap <= -2 ? "text-rose-300" : "text-slate-300";
  return { reinRank, marketRank, gap, label, tone };
}

function reinEvidence(horse: Horse) {
  const factors = [...(horse.parameterFactors ?? []), ...(horse.historyFactors ?? [])]
    .filter((item) => item.samples > 0)
    .sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0))
    .slice(0, 3);
  if (factors.length) return factors.map((item) => ({ label: item.label, samples: item.samples }));
  const fallback = [
    { label: "近走", value: horseParameters(horse)[4].value },
    { label: "コース", value: horseParameters(horse)[3].value },
    { label: "展開", value: horse.paceAdjustment ?? 0 },
  ].sort((a, b) => b.value - a.value);
  return fallback.slice(0, 3).map((item) => ({ label: item.label, samples: 0 }));
}

function MarketReinPanel({ horse, horses }: { horse: Horse; horses: Horse[] }) {
  const roles = [
    { label: "1着", key: "firstSuitability" as const },
    { label: "2着", key: "secondSuitability" as const },
    { label: "3着", key: "thirdSuitability" as const },
  ];
  const evidence = reinEvidence(horse);
  const samples = horse.historySamples ?? Math.max(0, ...evidence.map((item) => item.samples));
  const reliability = samples >= 50 ? "高" : samples >= 20 ? "中" : samples > 0 ? "参考" : "算出中";
  return (
    <section className="mt-4 rounded-xl border border-violet-400/25 bg-violet-400/[.06] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-widest text-violet-300">REIN × 人気</p>
          <p className="mt-1 text-sm text-slate-400">人気順位と着順別モデルの順位を比較</p>
        </div>
        <Badge className="bg-white/10 text-slate-300">信頼度 {reliability}</Badge>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {roles.map(({ label, key }) => {
          const item = marketRoleComparison(horse, horses, key);
          return (
            <div key={label} className="rounded-lg border border-slate-700 bg-black/15 p-3">
              <p className="font-bold text-slate-100">{label}適性 {item.reinRank}位</p>
              <p className="mt-1 text-xs text-slate-400">{item.marketRank ? `${item.marketRank}番人気` : "人気未発表"} → REIN {item.reinRank}位</p>
              <p className={"mt-2 text-sm font-bold " + item.tone}>{item.label}</p>
            </div>
          );
        })}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {(["first","second","third"] as const).map((role, index) => {
          const items = reasonViews(horse.roleReasons?.[role]);
          return <div key={role} className="min-w-0 rounded-lg bg-black/15 px-3 py-2">
            <p className="text-xs font-semibold text-slate-300">{index + 1}着適性モデルの主な要因</p>
            {items.length ? items.map((item, i) => <p key={i} className={"mt-1 break-words text-xs leading-5 " + (item.direction === "up" ? "text-emerald-300" : "text-rose-300")}>{item.direction === "up" ? "↑" : "↓"} {item.label}</p>) : <p className="mt-1 text-xs text-slate-500">要因を取得できていません</p>}
          </div>
        })}
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">矢印は今回のモデル評価への影響を示します（↑押し上げ・↓押し下げ）。値の大小ではありません。各着順適性の順位を出したモデルと同じモデルから算出しています。</p>
      <div className="mt-3 rounded-lg bg-black/15 px-3 py-2">
        <p className="text-xs font-semibold text-slate-300">履歴の参考材料</p>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
          {evidence.map((item) => <span key={item.label}>{item.label}{item.samples ? `（${item.samples}走）` : ""}</span>)}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-slate-500">評価差は判断材料です。「★ 注目」「慎重評価」だけで買い・消しを確定しません。</p>
      </div>
    </section>
  );
}

function HorseDetails({ horse, data }: { horse: Horse; data: Analysis }) {
  const horses = data.horses;
  const rolesReady = roleReady(data);
  const signed = (value: number | undefined) =>
    `${value && value > 0 ? "+" : ""}${value ?? 0}`;
  const parameters = horseParameters(horse);
  const overallRank = overallRankOf(data, horse);
  const probability = (value: number | undefined) =>
    value === undefined ? "未取得" : `${(value * 100).toFixed(1)}%`;
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-bold sm:text-xl">
            {visibleMark(horse.mark)} {horse.number} {horse.name}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {horse.gate}枠・{horse.popularity > 0 ? `${horse.popularity}人気` : "人気未発表"}・単勝{" "}
            {horse.odds === null ? "未取得" : `${horse.odds}倍`}　
            {horse.jockey || "騎手取得中"}
          </p>
        </div>
        {overallRank ? (
          <p className="shrink-0 text-right text-3xl font-black text-cyan-300">
            {overallRank}
            <span className="text-xs font-normal text-slate-500">位</span>
            <span className="block text-[10px] font-normal text-slate-500">総合順位</span>
          </p>
        ) : null}
      </div>
      <div className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-400/[.06] p-3 text-sm leading-6 text-slate-200">
        <span className="mr-2 font-bold text-cyan-300">REIN一言メモ</span>
        {horseMemo(horse, data)}
      </div>
      {rolesReady ? (
        <>
          <MarketReinPanel horse={horse} horses={horses} />
          <ParameterRadar horse={horse} horses={horses} />
        </>
      ) : null}
      <section className="mt-4 rounded-xl border border-slate-800 bg-black/10 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-slate-200">詳細データ</p>
            <p className="mt-1 text-xs text-slate-500">モデル出力と当日情報を分けて表示</p>
          </div>
          <Badge className="bg-white/10 text-slate-300">{overallRank ? `総合 ${overallRank}位 / ${horses.length}頭` : "総合順位 保留"}</Badge>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="1着推定確率" value={rolesReady ? probability(horse.firstProbability) : "保留"} />
          <Metric label="2着推定確率" value={rolesReady ? probability(horse.secondProbability) : "保留"} />
          <Metric label="3着推定確率" value={rolesReady ? probability(horse.thirdProbability) : "保留"} />
          <Metric label="従来方式の総合評価点" value={overallRank ? `${horse.reinScore ?? horse.score}pt` : "保留"} />
          <Metric label="コース評価" value={`${parameters[3].value}pt`} />
          <Metric label="近走状態" value={`${parameters[4].value}pt`} />
          <Metric label="市場評価" value={horse.popularity > 0 ? `${horse.marketScore ?? "－"}pt` : "未発表"} />
          <Metric label="履歴母数" value={`${horse.historySamples ?? 0}走`} />
        </div>
      </section>
      {rolesReady ? (
        <div className="mt-4 grid grid-cols-3 gap-2">
          <Metric label="1着適性" value={`${horse.firstSuitability ?? 0}pt`} />
          <Metric label="2着適性" value={`${horse.secondSuitability ?? 0}pt`} />
          <Metric label="3着適性" value={`${horse.thirdSuitability ?? 0}pt`} />
        </div>
      ) : null}
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="性齢" value={`${horse.sex || "－"}${horse.age || "－"}`} />
        <Metric label="負担重量" value={horse.weightCarried ? `${horse.weightCarried}kg` : "未取得"} />
        <Metric label="枠番" value={horse.gate ? `${horse.gate}枠` : "未取得"} />
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
      {horse.parameterFactors?.length || horse.historyFactors?.length ? (
        <div className="mt-3 rounded-xl border border-slate-700 p-4">
          <div className="mb-3">
            <p className="text-sm font-semibold">8年履歴・項目別成績</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              通算・近走・芝ダ・距離・競馬場は馬自身、騎手・厩舎は該当人物の集計です。
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {(horse.parameterFactors ?? horse.historyFactors ?? []).map((item) => (
              <HistoryFactorCard key={item.label} item={item} />
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-5 text-slate-600">
            1〜2走は参考値です。母数が少ない項目だけで評価を決めず、着順適性・騎手・厩舎・枠傾向と合わせて総合評価しています。
          </p>
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

function HistoryFactorCard({ item }: { item: HistoryFactor }) {
  const reliability = item.samples >= 50
    ? { label: "母数十分", style: "bg-emerald-400/10 text-emerald-300" }
    : item.samples >= 10
      ? { label: "参考可", style: "bg-amber-400/10 text-amber-300" }
      : { label: "少数参考", style: "bg-slate-700 text-slate-300" };
  const signed = `${item.impact > 0 ? "+" : ""}${item.impact}`;
  return (
    <div className="rounded-xl border border-slate-800 bg-black/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-slate-200">{item.label}</p>
        <Badge className={reliability.style}>{reliability.label}</Badge>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div><p className="text-[10px] text-slate-500">母数</p><p className="mt-0.5 text-sm font-bold">{item.samples}走</p></div>
        <div><p className="text-[10px] text-slate-500">勝利</p><p className="mt-0.5 text-sm font-bold">{item.wins ?? "－"}勝</p></div>
        <div><p className="text-[10px] text-slate-500">3着内</p><p className="mt-0.5 text-sm font-bold">{item.top3 ?? "－"}回</p></div>
        <div><p className="text-[10px] text-slate-500">勝率</p><p className="mt-0.5 text-sm font-bold text-cyan-300">{item.winRate ?? "－"}%</p></div>
        <div><p className="text-[10px] text-slate-500">3着内率</p><p className="mt-0.5 text-sm font-bold text-cyan-300">{item.top3Rate ?? "－"}%</p></div>
        <div><p className="text-[10px] text-slate-500">平均着順</p><p className="mt-0.5 text-sm font-bold">{item.averageFinish ?? "－"}着</p></div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-slate-800 pt-2 text-xs">
        <span className="text-slate-500">総合点への補正</span>
        <span className={item.impact >= 0 ? "font-bold text-cyan-300" : "font-bold text-rose-300"}>{signed}</span>
      </div>
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
      role: "first" as const,
      key: "firstSuitability" as const,
      probability: "firstProbability" as const,
      color: "text-cyan-300",
    },
    {
      title: "2着適性",
      role: "second" as const,
      key: "secondSuitability" as const,
      probability: "secondProbability" as const,
      color: "text-amber-300",
    },
    {
      title: "3着適性",
      role: "third" as const,
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
              {roleOrder(horses, role.role)
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

function HeldPanel({ text }: { text: string }) {
  return (
    <div className="mb-3 rounded-2xl border border-dashed border-amber-400/40 bg-amber-400/[.05] p-5 text-sm leading-6 text-amber-100">
      {text}
    </div>
  );
}

function PickCards({ data, onHorse }: { data: Analysis; onHorse: (horse: Horse) => void }) {
  const picks = data.picks;
  const byNumber = (pick: MarkPick | null | undefined) =>
    pick ? data.horses.find((horse) => horse.number === pick.number) : undefined;
  if (!picks || picks.status !== "ready") {
    return (
      <p className="mt-5 rounded-xl border border-dashed border-slate-600 p-3 text-sm text-slate-400">
        {picks?.reason ?? "印の選定を保留しています"}
      </p>
    );
  }
  const candidates = picks.longshotCandidates ?? (picks.longshot ? [picks.longshot] : []);
  const roleRanks = {
    second: new Map<number, number>(roleOrder(data.horses, "second").map((horse, index): [number, number] => [horse.number, index + 1])),
    third: new Map<number, number>(roleOrder(data.horses, "third").map((horse, index): [number, number] => [horse.number, index + 1])),
  };
  const slots: Array<{ title: string; pick: MarkPick | null; empty?: string }> = [
    { title: "本命", pick: picks.main },
    { title: "対抗", pick: picks.rival },
    {
      title: "穴候補",
      pick: picks.longshot,
      empty: picks.longshotStatus === "unavailable" ? "データ不足" : "該当なし",
    },
  ];
  return (
    <>
      <div className="mt-5 grid grid-cols-3 gap-2">
        {slots.map(({ title, pick, empty }, index) => {
          const horse = byNumber(pick);
          const body = (
            <>
              <span className="text-xs text-slate-400">{title}</span>
              {horse && pick ? (
                <>
                  <div className="mt-1 flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white font-bold text-slate-900">
                      {horse.number}
                    </span>
                    <span className="line-clamp-2 break-all text-xs font-semibold leading-4 sm:text-sm">{horse.name}</span>
                  </div>
                  <p className="mt-2 font-black leading-tight text-cyan-300">
                    <span className="block text-[11px] font-semibold text-cyan-200/80">1着適性</span>
                    <span className="text-xl sm:text-2xl">{pick.firstRank}位</span>
                  </p>
                  <p className="mt-1 break-words text-[11px] leading-4 text-slate-400">
                    推定1着率 {formatProbability(horse.firstProbability)}
                    {pick.role === "穴候補" && pick.marketRatio
                      ? `・${horse.popularity}番人気・市場モデル比${pick.marketRatio.toFixed(1)}倍`
                      : ""}
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm font-bold text-slate-400">{empty ?? "該当なし"}</p>
              )}
            </>
          );
          const style = `min-w-0 rounded-xl border p-3 text-left ${index === 0 ? "border-cyan-400/60 bg-cyan-400/10" : "border-slate-700 bg-black/10"}`;
          return horse ? (
            <button key={title} onClick={() => onHorse(horse)} className={style}>
              {body}
            </button>
          ) : (
            <div key={title} className={style}>
              {body}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">
        本命・対抗は1着適性ランキングの1位・2位。穴候補は1着適性3〜6位のうち、4番人気以下で1着評価が市場評価を上回る馬です。
        {picks.longshotReason ? `（${picks.longshotReason}）` : ""}
      </p>
      <section className="mt-4 rounded-2xl border border-rose-400/25 bg-rose-400/[.04] p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-bold text-rose-200">穴候補一覧・評価</h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              買い目とは別に、人気よりREIN評価が高い馬を確認できます。
            </p>
          </div>
          <Badge className="bg-rose-400/10 text-rose-200">
            {candidates.length ? `${candidates.length}頭` : "候補なし"}
          </Badge>
        </div>
        {candidates.length ? (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {candidates.map((pick, index) => {
              const horse = byNumber(pick);
              if (!horse) return null;
              const secondRank = roleRanks.second.get(horse.number);
              const thirdRank = roleRanks.third.get(horse.number);
              return (
                <button
                  key={horse.number}
                  onClick={() => onHorse(horse)}
                  className="rounded-xl border border-rose-400/20 bg-black/15 p-3 text-left transition hover:border-rose-300/50 hover:bg-white/[.03]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white font-bold text-slate-900">
                        {horse.number}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-slate-100">{horse.name}</span>
                        <span className="mt-0.5 block text-xs text-slate-400">
                          {horse.popularity}番人気・単勝{horse.odds === null ? "未取得" : `${horse.odds}倍`}
                        </span>
                      </span>
                    </div>
                    <Badge className={index === 0 ? "shrink-0 bg-rose-400/15 text-rose-200" : "shrink-0 bg-white/10 text-slate-300"}>
                      {index === 0 ? "穴候補筆頭" : "穴候補"}
                    </Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Metric label="1着適性" value={`${pick.firstRank}位・推定${formatProbability(horse.firstProbability)}`} />
                    <Metric label="市場モデルとの差" value={typeof pick.marketGap === "number" ? `+${(pick.marketGap * 100).toFixed(1)}ポイント` : "算出中"} />
                    <Metric label="2着適性順位" value={secondRank ? `${secondRank}位` : "算出中"} />
                    <Metric label="3着適性順位" value={thirdRank ? `${thirdRank}位` : "算出中"} />
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed border-slate-700 px-3 py-3 text-sm text-slate-400">
            {picks.longshotStatus === "unavailable"
              ? picks.longshotReason ?? "人気・市場評価を取得できないため、穴候補を保留しています。"
              : picks.longshotReason ?? "今回の条件に合う穴候補はいません。"}
          </p>
        )}
        <p className="mt-3 text-[11px] leading-5 text-slate-500">
          選定条件：4番人気以下、1着適性3〜6位、REIN市場モデル評価が市場評価を上回る馬。候補一覧は評価確認用で、買い目や総合順位は変更しません。
        </p>
      </section>
    </>
  );
}
