"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type Race = { number: number; raceId: string; title: string; course: string; start: string; status: "確定" | "次レース" | "発売前" | "発走時刻経過" };
type Venue = { name: string; eventId: string; nextRace: number; nextStart: string; races: Race[] };
type CalendarDay = { date: string; venues: Venue[] };

const JRA_GRADES: Array<[string, string]> = [
  ["フェブラリーステークス", "GⅠ"], ["高松宮記念", "GⅠ"], ["大阪杯", "GⅠ"], ["桜花賞", "GⅠ"], ["皐月賞", "GⅠ"],
  ["天皇賞（春）", "GⅠ"], ["天皇賞(春)", "GⅠ"], ["NHKマイルカップ", "GⅠ"], ["ヴィクトリアマイル", "GⅠ"],
  ["優駿牝馬", "GⅠ"], ["東京優駿", "GⅠ"], ["日本ダービー", "GⅠ"], ["安田記念", "GⅠ"], ["宝塚記念", "GⅠ"],
  ["スプリンターズステークス", "GⅠ"], ["秋華賞", "GⅠ"], ["菊花賞", "GⅠ"], ["天皇賞（秋）", "GⅠ"], ["天皇賞(秋)", "GⅠ"],
  ["エリザベス女王杯", "GⅠ"], ["マイルチャンピオンシップ", "GⅠ"], ["ジャパンカップ", "GⅠ"], ["チャンピオンズカップ", "GⅠ"],
  ["阪神ジュベナイルフィリーズ", "GⅠ"], ["朝日杯フューチュリティステークス", "GⅠ"], ["有馬記念", "GⅠ"], ["ホープフルステークス", "GⅠ"],
  ["京都大賞典", "GⅡ"], ["毎日王冠", "GⅡ"], ["アイルランドトロフィー", "GⅡ"], ["府中牝馬ステークス", "GⅢ"],
  ["札幌記念", "GⅡ"], ["阪神カップ", "GⅡ"], ["中山記念", "GⅡ"], ["金鯱賞", "GⅡ"], ["京都記念", "GⅡ"],
  ["日経新春杯", "GⅡ"], ["AJCC", "GⅡ"], ["アメリカジョッキークラブカップ", "GⅡ"], ["阪急杯", "GⅢ"],
  ["シリウスステークス", "GⅢ"], ["サウジアラビアロイヤルカップ", "GⅢ"], ["アルテミスステークス", "GⅢ"],
  ["府中牝馬ステークス", "GⅢ"], ["富士ステークス", "GⅡ"], ["スワンステークス", "GⅡ"], ["京成杯オータムハンデ", "GⅢ"],
  ["紫苑ステークス", "GⅡ"], ["京王杯2歳ステークス", "GⅡ"], ["デイリー杯2歳ステークス", "GⅡ"],
];

const NAR_GRADES: Array<[string, string]> = [
  ["川崎記念", "JpnⅠ"], ["かしわ記念", "JpnⅠ"], ["帝王賞", "JpnⅠ"], ["ジャパンダートクラシック", "JpnⅠ"],
  ["JBCクラシック", "JpnⅠ"], ["JBCスプリント", "JpnⅠ"], ["JBCレディスクラシック", "JpnⅠ"],
  ["全日本2歳優駿", "JpnⅠ"], ["東京大賞典", "JpnⅠ"], ["マイルチャンピオンシップ南部杯", "JpnⅠ"],
  ["南部杯", "JpnⅠ"], ["羽田盃", "JpnⅠ"], ["東京ダービー", "JpnⅠ"], ["兵庫チャンピオンシップ", "JpnⅡ"], ["関東オークス", "JpnⅡ"], ["浦和記念", "JpnⅡ"],
  ["日本テレビ盃", "JpnⅡ"], ["東京盃", "JpnⅡ"], ["レディスプレリュード", "JpnⅡ"],
  ["名古屋グランプリ", "JpnⅡ"], ["兵庫ゴールドトロフィー", "JpnⅢ"], ["クイーン賞", "JpnⅢ"],
  ["エンプレス杯", "JpnⅡ"], ["黒船賞", "JpnⅢ"], ["北海道スプリントカップ", "JpnⅢ"],
];

function gradeOf(title: string, area: "jra" | "nar") {
  const source = area === "nar" ? NAR_GRADES : JRA_GRADES;
  return source.find(([name]) => title.replace(/\s/g, "").includes(name.replace(/\s/g, "")))?.[1] ?? null;
}

function dateLabel(value: string) {
  const date = new Date(value + "T12:00:00+09:00");
  const weekday = new Intl.DateTimeFormat("ja-JP", { weekday: "short", timeZone: "Asia/Tokyo" }).format(date);
  return { day: value.slice(8), weekday };
}

function shiftMonth(value: string, delta: number) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + delta, 1)).toISOString().slice(0, 7);
}

export function RaceCalendar({
  area,
  selectedDate,
  onSelect,
}: {
  area: "jra" | "nar";
  selectedDate: string;
  onSelect: (date: string, venue: Venue) => void;
}) {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const oldest = new Date(Date.now() + 9 * 3600_000 - 365 * 86400_000).toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  const minimumMonth = oldest.slice(0, 7);
  const [month, setMonth] = useState(selectedDate ? selectedDate.slice(0, 7) : currentMonth);
  const [days, setDays] = useState<CalendarDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (selectedDate) setMonth(selectedDate.slice(0, 7));
  }, [selectedDate]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch("/api/race-calendar?month=" + month + "&league=" + area, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "開催一覧を取得できませんでした");
        setDays(result.days ?? []);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setDays([]);
          setError(cause instanceof Error ? cause.message : "開催一覧を取得できませんでした");
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [month, area]);

  const grouped = useMemo(() => days.map((day) => ({ ...day, label: dateLabel(day.date) })), [days]);

  return (
    <section className="mt-5 overflow-hidden rounded-2xl border border-slate-700 bg-[#0c192a]">
      <header className="flex items-center justify-between border-b border-slate-800 bg-gradient-to-r from-emerald-950/80 to-[#10233a] px-4 py-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="size-5 text-emerald-300" />
          <h2 className="font-black text-white">開催一覧</h2>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="前の月" disabled={month <= minimumMonth} onClick={() => setMonth((value) => shiftMonth(value, -1))}
            className="rounded-lg p-2 text-slate-300 hover:bg-white/10 disabled:opacity-30">
            <ChevronLeft className="size-5" />
          </button>
          <span className="min-w-28 text-center font-bold text-white">{month.replace("-", "年")}月</span>
          <button type="button" aria-label="次の月" disabled={month >= currentMonth} onClick={() => setMonth((value) => shiftMonth(value, 1))}
            className="rounded-lg p-2 text-slate-300 hover:bg-white/10 disabled:opacity-30">
            <ChevronRight className="size-5" />
          </button>
        </div>
      </header>

      {loading ? (
        <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-slate-400">
          <LoaderCircle className="size-4 animate-spin" />開催情報を読み込み中
        </div>
      ) : error ? (
        <p role="alert" className="p-6 text-center text-sm text-rose-300">{error}</p>
      ) : grouped.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-400">この月の開催情報はまだありません</p>
      ) : (
        <div className="divide-y divide-slate-800">
          {grouped.map((day) => (
            <div key={day.date} className="grid grid-cols-[58px_minmax(0,1fr)] gap-3 px-3 py-3 sm:grid-cols-[72px_minmax(0,1fr)] sm:px-4">
              <div className="pt-2 text-center">
                <p className="text-xl font-black leading-none text-white">{Number(day.label.day)}</p>
                <p className={"mt-1 text-xs font-semibold " + (day.label.weekday === "日" ? "text-rose-300" : day.label.weekday === "土" ? "text-sky-300" : "text-slate-400")}>{day.label.weekday}</p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {day.venues.map((venue) => {
                  const graded = venue.races
                    .map((race) => ({ race, grade: gradeOf(race.title, area) }))
                    .filter((item): item is { race: Race; grade: string } => Boolean(item.grade));
                  const feature = graded[0] ?? venue.races
                    .map((race) => ({ race, grade: null }))
                    .find((item) => !/^(サラ系|サラ)/.test(item.race.title) && !/(未勝利|新馬)/.test(item.race.title));
                  return (
                    <button key={venue.eventId} type="button" onClick={() => onSelect(day.date, venue)}
                      className={"min-h-24 rounded-xl border p-3 text-left transition hover:border-emerald-300/70 hover:bg-white/5 " + (selectedDate === day.date ? "border-emerald-300 bg-emerald-950/30" : "border-slate-700 bg-slate-900/60")}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-lg font-black text-white">{venue.name}</span>
                        <ChevronRight className="size-4 shrink-0 text-slate-500" />
                      </div>
                      {feature ? (
                        <div className="mt-2 flex items-start gap-2">
                          {feature.grade && <Badge className="shrink-0 bg-emerald-400 text-emerald-950">{feature.grade}</Badge>}
                          <span className="line-clamp-2 text-sm font-semibold text-slate-200">{feature.race.title}</span>
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-slate-400">開催 {venue.races.length}レース</p>
                      )}
                      <p className="mt-2 text-xs text-slate-500">全{venue.races.length}R</p>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500">グレード表記はレース名から照合できた競走に表示しています。</p>
    </section>
  );
}
