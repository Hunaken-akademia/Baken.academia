"use client";

import { useCallback, useEffect, useState } from "react";
import { Star } from "lucide-react";
import { jockeyKey, type FavoriteJockey, type FavoriteMatch, type League } from "@/lib/favorites";

type Saved = { jockeys: FavoriteJockey[]; horses: Array<{ horseId: string; name: string }> };
type Today = Saved & { date: string; matches: FavoriteMatch[] };
const base = (league: League) => (league === "nar" ? "/api/nar/favorites" : "/api/analyze/favorites");
// One shared copy per league so moving between races does not refetch the account's favorites.
const shared = new Map<League, { value: Saved; at: number }>();
const listeners = new Set<() => void>();

async function readJson<T>(response: Response) {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "お気に入りを読み込めませんでした");
  return body;
}

export function useFavorites(league: League) {
  const [saved, setSaved] = useState<Saved | null>(() => shared.get(league)?.value ?? null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    const sync = () => setSaved(shared.get(league)?.value ?? null);
    listeners.add(sync);
    const cached = shared.get(league);
    if (!cached || Date.now() - cached.at > 60_000) {
      fetch(base(league), { cache: "no-store" })
        .then((response) => readJson<Saved>(response))
        .then((value) => { shared.set(league, { value, at: Date.now() }); listeners.forEach((listener) => listener()); })
        .catch(() => setStatus("お気に入りを読み込めませんでした"));
    }
    return () => { listeners.delete(sync); };
  }, [league]);
  const toggleJockey = useCallback(async (key: string, name: string) => {
    const active = shared.get(league)?.value.jockeys.some((jockey) => jockey.key === key);
    setStatus("保存中…");
    try {
      const value = await readJson<Saved>(await fetch(base(league), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: active ? "remove" : "add", key, name }), cache: "no-store" }));
      shared.set(league, { value, at: Date.now() });
      listeners.forEach((listener) => listener());
      setStatus(active ? "お気に入りから外しました" : "お気に入りに追加しました");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存できませんでした");
    }
  }, [league]);
  return {
    ready: !!saved,
    status,
    jockeys: saved?.jockeys ?? [],
    isHorse: (horseId: string | undefined) => !!horseId && !!saved?.horses.some((horse) => horse.horseId === horseId),
    isJockey: (jockeyId: string | undefined) => { const key = jockeyKey(league, jockeyId); return !!key && !!saved?.jockeys.some((jockey) => jockey.key === key); },
    toggleJockey,
  };
}

export function FavoriteJockeyPicker({ league, horses }: { league: League; horses: Array<{ number: number; jockey?: string; jockeyId?: string }> }) {
  const favorites = useFavorites(league);
  const riders = [...new Map(horses.flatMap((horse) => {
    const key = jockeyKey(league, horse.jockeyId);
    const name = horse.jockey?.replace(/\s+/g, " ").trim();
    return key && name ? [[key, { key, name, jockeyId: horse.jockeyId, numbers: horses.filter((item) => item.jockeyId === horse.jockeyId).map((item) => item.number) }] as const] : [];
  })).values()];
  if (!riders.length) return null;
  return (
    <section aria-label="お気に入り騎手" data-testid="favorite-jockeys" className="mb-4 rounded-2xl border border-amber-300/25 bg-amber-300/[.04] p-4">
      <h2 className="font-bold text-amber-100">お気に入り騎手</h2>
      <p className="mt-1 text-xs leading-5 text-slate-400">☆を押すと登録され、開催場の選択画面で「今日のお気に入り出走」に表示されます。</p>
      <div className="mt-3 flex flex-wrap gap-2" data-no-swipe>
        {riders.map((rider) => {
          const active = favorites.isJockey(rider.jockeyId);
          return (
            <button key={rider.key} type="button" aria-pressed={active} disabled={!favorites.ready} onClick={() => void favorites.toggleJockey(rider.key, rider.name)}
              className={`flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm ${active ? "border-amber-300 bg-amber-300/15 text-amber-100" : "border-slate-600 text-slate-300"} disabled:opacity-50`}>
              <Star aria-hidden="true" className={`size-4 ${active ? "fill-amber-300 text-amber-300" : ""}`} />
              {rider.name}<span className="text-xs text-slate-500">{rider.numbers.join("・")}番</span>
            </button>
          );
        })}
      </div>
      {favorites.status && <p role="status" className="mt-2 text-xs text-slate-400">{favorites.status}</p>}
    </section>
  );
}

export function FavoriteEntries({ league, day, onOpen }: { league: League; day: "today" | "tomorrow"; onOpen: (raceId: string) => void }) {
  const [data, setData] = useState<Today | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError("");
    fetch(`${base(league)}?day=${day}`, { cache: "no-store", signal: controller.signal })
      .then((response) => readJson<Today>(response))
      .then(setData)
      .catch((value) => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : "お気に入りを読み込めませんでした"); });
    return () => controller.abort();
  }, [league, day]);
  const label = day === "today" ? "今日" : "明日";
  return (
    <section aria-label={`${label}のお気に入り出走`} data-testid="favorite-entries" className="mt-5 rounded-2xl border border-amber-300/25 bg-[#0c192a] p-4 sm:p-5">
      <div className="flex items-center gap-2"><Star aria-hidden="true" className="size-5 fill-amber-300 text-amber-300" /><h2 className="font-bold">{label}のお気に入り出走</h2></div>
      {error ? <p role="status" className="mt-2 text-sm text-amber-200">{error}</p>
        : !data ? <p role="status" className="mt-2 text-sm text-slate-400">確認中…</p>
        : !data.horses.length && !data.jockeys.length ? <p className="mt-2 text-sm leading-6 text-slate-400">馬の詳細で「次走も注目する」を付けた馬と、騎手タブで☆を付けた騎手の出走をここにまとめます。</p>
        : !data.matches.length ? <p className="mt-2 text-sm text-slate-400">{label}の出走表には、お気に入りの馬・騎手はいません（馬{data.horses.length}頭・騎手{data.jockeys.length}人を登録中）。</p>
        : <ul className="mt-3 divide-y divide-slate-800">
          {data.matches.map((race) => (
            <li key={race.raceId}>
              <button type="button" onClick={() => onOpen(race.raceId)} className="flex w-full items-start gap-3 py-3 text-left hover:bg-white/[.03]">
                <span className="w-12 shrink-0 text-sm font-semibold text-cyan-200">{race.start || "--:--"}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{race.title}</span>
                  {race.items.map((item) => (
                    <span key={item.number} className="mt-1 block text-xs text-slate-300">
                      {item.number} {item.horse}<span className="text-slate-500">（{item.jockey || "騎手未定"}）</span>
                      {item.reasons.includes("horse") && <span className="ml-1 rounded bg-amber-300/15 px-1 text-[10px] text-amber-200">注目馬</span>}
                      {item.reasons.includes("jockey") && <span className="ml-1 rounded bg-cyan-300/15 px-1 text-[10px] text-cyan-200">騎手</span>}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>}
    </section>
  );
}
