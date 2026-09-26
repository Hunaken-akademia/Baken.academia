import { NextRequest, NextResponse } from "next/server";
import { getVercelOidcToken } from "@vercel/oidc";
import { getCache } from "@vercel/functions";
import { createHash, timingSafeEqual } from "node:crypto";
import { loadHistory, scoreHistory } from "@/lib/history";
import { buildTickets } from "@/lib/tickets";
import { responseCache } from "@/lib/response-cache";
import {
  parseMarket,
  parsePopularity,
  parseResultOdds,
} from "@/lib/market-data";
import { parsePayouts } from "@/lib/payouts";
import {
  horseName,
  isRunnerRow,
  isScratched,
  parseSexAge,
} from "@/lib/race-card";
import { selectPicks } from "@/lib/marks";
import { fetchSource } from "@/lib/source-fetch";
import {
  failureCacheHeaders,
  readFailure,
  writeFailure,
} from "@/lib/failure-cache";

const cachedAnalysis = responseCache(15_000);
const sharedCache = getCache({ namespace: "rein-analysis-v1" });
const publicCacheHeaders = {
  "Cache-Control": "public, max-age=0, s-maxage=15, stale-while-revalidate=30",
};
const ROLE_CACHE_VERSION = "2026-09-26-market-top4-v1";
// v2 snapshots carry picks/evaluation/data timestamps; v1 bodies must not be replayed.
const SNAPSHOT_KEY = "snapshot-market-top4-v2";
const PREVIEW_SNAPSHOT_KEY = "snapshot-preview-market-top4-v2";
// Last complete prediction generated before the start time, kept for post-start review.
const PRESTART_KEY = "prestart-v1";

type SourceBody = { body: string; fetchedAt: string | null };

async function fetchCachedSource(
  url: string,
  label: string,
  optional: boolean,
  ttlSeconds: number,
): Promise<SourceBody> {
  // v2 stores the actual fetch time so the screen can show when the data was taken,
  // not when the page happened to be reloaded.
  const key = "source-v2:" + createHash("sha256").update(url).digest("hex");
  try {
    const cached = await sharedCache.get(key);
    if (typeof cached === "string") {
      const parsed = JSON.parse(cached) as Partial<SourceBody>;
      if (typeof parsed.body === "string")
        return { body: parsed.body, fetchedAt: parsed.fetchedAt ?? null };
    }
  } catch (error) {
    console.error(
      "REIN source cache read failed",
      label,
      error instanceof Error ? error.message : "unknown",
    );
  }

  const body = await fetchSource(url, label, optional);
  const fetchedAt = body ? new Date().toISOString() : null;
  try {
    await sharedCache.set(key, JSON.stringify({ body, fetchedAt }), {
      ttl: ttlSeconds,
      tags: ["rein-source"],
      name: `REIN source: ${label}`,
    });
  } catch (error) {
    console.error(
      "REIN source cache write failed",
      label,
      error instanceof Error ? error.message : "unknown",
    );
  }
  return { body, fetchedAt };
}

// A card that is not published yet is an expected, deterministic state, not an upstream
// fault, and the CDN only holds cacheable statuses - a 502 is re-fetched by every
// visitor no matter what its Cache-Control says (measured). Answering 404 lets the edge
// absorb the crowd; the client already branches on response.ok, so the message is
// unchanged. Genuine source failures stay 502.
class RaceNotReadyError extends Error {}

type FixedWeight = { weight: number; change: number };
type FixedWeights = Record<string, FixedWeight>;

export const runtime = "nodejs";
export const maxDuration = 180;
export const dynamic = "force-dynamic";

const decode = (value: string) =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const cleanId = (value = "") => value.replace(/^0+/, "") || "0";
const tableRows = (html: string, minimumCells = 7) =>
  [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => ({
      html: match[1],
      cells: [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
        (cell) => decode(cell[1]),
      ),
    }))
    .filter((row) => row.cells.length >= minimumCells);

function runningStyle(detail: string) {
  const recentPositions = [...detail.matchAll(/\b\d{1,2}(?:-\d{1,2}){1,3}\b/g)]
    .map((match) => match[0])
    .slice(0, 5);
  const earlyPositions = recentPositions.map((value) => {
    const positions = value.split("-").map(Number);
    return positions.length >= 2
      ? (positions[0] + positions[1]) / 2
      : positions[0];
  });
  if (!earlyPositions.length)
    return { style: "自在", earlyPosition: null, recentPositions };
  const weighted = earlyPositions.reduce(
    (sum, value, index) => sum + value * (earlyPositions.length - index),
    0,
  );
  const weights = earlyPositions.reduce(
    (sum, _value, index) => sum + earlyPositions.length - index,
    0,
  );
  const earlyPosition = Math.round((weighted / weights) * 10) / 10;
  const style =
    earlyPosition <= 2.4
      ? "逃げ"
      : earlyPosition <= 4.5
        ? "先行"
        : earlyPosition <= 7.5
          ? "好位"
          : earlyPosition <= 10.5
            ? "差し"
            : "追込";
  return { style, earlyPosition, recentPositions };
}

function pastPerformanceRows(html: string) {
  const table =
    html.match(
      /<table[^>]*id=["']denma_past["'][^>]*>([\s\S]*?)<\/table>/i,
    )?.[1] || "";
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => match[1])
    .filter((row) => /hr-denma__passing/.test(row));
}

function paceAdjustment(style: string, pace: string) {
  if (pace === "ハイペース寄り")
    return (
      (
        { 逃げ: -3, 先行: -1, 好位: 1, 差し: 3, 追込: 2, 自在: 0 } as Record<
          string,
          number
        >
      )[style] || 0
    );
  if (pace === "平均〜やや速い")
    return (
      (
        { 逃げ: -2, 先行: 0, 好位: 1, 差し: 2, 追込: 1, 自在: 0 } as Record<
          string,
          number
        >
      )[style] || 0
    );
  if (pace === "スロー")
    return (
      (
        { 逃げ: 4, 先行: 3, 好位: 1, 差し: -1, 追込: -2, 自在: 0 } as Record<
          string,
          number
        >
      )[style] || 0
    );
  return (
    (
      { 逃げ: 2, 先行: 2, 好位: 1, 差し: 0, 追込: -1, 自在: 0 } as Record<
        string,
        number
      >
    )[style] || 0
  );
}

const jstTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Tokyo",
      })
    : null;

function raceClass(text: string) {
  if (/新馬/.test(text)) return "新馬";
  if (/未勝利/.test(text)) return "未勝利";
  if (/1勝|500万/.test(text)) return "1勝クラス";
  if (/2勝|1000万/.test(text)) return "2勝クラス";
  if (/3勝|1600万/.test(text)) return "3勝クラス";
  return "オープン";
}

export async function GET(request: NextRequest) {
  const raceId = request.nextUrl.searchParams.get("raceId") || "";
  const preview = request.nextUrl.searchParams.get("preview") === "1";
  if (!/^\d{10,12}$/.test(raceId))
    return NextResponse.json(
      { error: "レースIDは10〜12桁で入力してください" },
      { status: 400 },
    );
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  if (forceRefresh && !isCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!forceRefresh) {
    try {
      const snapshot = await sharedCache.get(`${preview ? PREVIEW_SNAPSHOT_KEY : SNAPSHOT_KEY}:${raceId}`);
      if (typeof snapshot === "string") {
        return new NextResponse(snapshot, {
          status: 200,
          headers: {
            ...publicCacheHeaders,
            "content-type": "application/json; charset=utf-8",
            "x-rein-fallback": "0",
            "x-rein-snapshot": "1",
          },
        });
      }
    } catch (error) {
      console.error(
        "REIN snapshot read failed",
        error instanceof Error ? error.message : "unknown",
      );
    }

    const failure = await readFailure(`analyze:${preview ? "preview:" : ""}${raceId}`);
    if (failure) {
      return new NextResponse(failure.body, {
        status: failure.status,
        headers: {
          ...failureCacheHeaders,
          "content-type": "application/json; charset=utf-8",
          "x-rein-snapshot": "0",
          "x-rein-failure-cache": "1",
        },
      });
    }
  }

  const response = forceRefresh
    ? await analyze(request)
    : await cachedAnalysis(`${raceId}:${preview ? "preview" : "market"}`, () => analyze(request));
  if (response.ok && response.headers.get("x-rein-fallback") === "0") {
    try {
      await sharedCache.set(
        `${preview ? PREVIEW_SNAPSHOT_KEY : SNAPSHOT_KEY}:${raceId}`,
        await response.clone().text(),
        {
          ttl:
            preview
              ? 6 * 60 * 60
              : response.headers.get("x-rein-final") === "1"
              ? 24 * 60 * 60
              : 5 * 60,
          tags: [`rein-race-${raceId}`, "rein-live"],
          name: "REIN race analysis",
        },
      );
    } catch (error) {
      console.error(
        "REIN snapshot write failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
  } else if (!response.ok) {
    await writeFailure(
      `analyze:${preview ? "preview:" : ""}${raceId}`,
      { status: response.status, body: await response.clone().text() },
      [`rein-race-${raceId}`, "rein-live"],
    );
  }
  response.headers.set("x-rein-snapshot", "0");
  return response;
}

function isCronRequest(request: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return false;
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

async function analyze(request: NextRequest) {
  const raceId = request.nextUrl.searchParams.get("raceId") || "";
  const preview = request.nextUrl.searchParams.get("preview") === "1";
  if (!/^\d{10,12}$/.test(raceId))
    return NextResponse.json(
      { error: "レースIDは10〜12桁で入力してください" },
      { status: 400 },
    );
  const base = "https://sports.yahoo.co.jp/keiba/race";
  try {
    const [cardSource, detailSource, oddsSource, resultSource, history] = await Promise.all([
      // Card can still change through scratches/jockey changes, so keep it fresh.
      fetchCachedSource(`${base}/denma/${raceId}`, "出馬表", false, 5 * 60),
      // Past-performance detail is effectively static once the card is published.
      fetchCachedSource(
        `${base}/denma/${raceId}?detail=1`,
        "出走履歴",
        false,
        12 * 60 * 60,
      ),
      // Market data is intentionally refreshed on a five-minute cadence.
      fetchCachedSource(
        `${base}/odds/tfw/${raceId}`,
        "単勝オッズ",
        true,
        5 * 60,
      ),
      // Before confirmation this usually 404s; cache that expected state briefly.
      fetchCachedSource(`${base}/result/${raceId}`, "確定結果", true, 5 * 60),
      loadHistory(),
    ]);
    const card = cardSource.body;
    const detail = detailSource.body;
    const odds = oddsSource.body;
    const result = resultSource.body;
    // Geldings are written 「せん」 on Yahoo. The old 「セ」-only filter silently dropped
    // them, and the popularity sanity check then rejected the whole race.
    const allCardRows = tableRows(card).filter(isRunnerRow);
    const scratchedRows = allCardRows.filter(isScratched);
    const cardRows = allCardRows.filter((row) => !isScratched(row));
    const oddsRows = tableRows(odds, 5).filter(
      (row) =>
        /^\d+$/.test(row.cells[1] || "") &&
        /^\d+(\.\d+)?$/.test(row.cells[3] || ""),
    );
    const resultRows = tableRows(result).filter(
      (row) =>
        /^\d+$/.test(row.cells[0] || "") &&
        /^\d+$/.test(row.cells[2] || "") &&
        parseResultOdds(row.cells[7] || "") !== null,
    );
    if (!allCardRows.length)
      throw new RaceNotReadyError(
        "出馬表の形式を読み取れませんでした。発走前の中央競馬レースを指定してください",
      );
    const liveOddsMap = new Map(
      oddsRows.map((row) => [+row.cells[1], +row.cells[3]]),
    );
    const finalOddsMap = new Map(
      resultRows.map((row) => [+row.cells[2], parseResultOdds(row.cells[7])!]),
    );
    const oddsMap = liveOddsMap.size ? liveOddsMap : finalOddsMap;
    const finalPopularity = new Map(
      [...finalOddsMap.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([number], index) => [number, index + 1]),
    );
    const full = decode(card);
    const detailText = decode(detail);
    const pastRows = pastPerformanceRows(detail);
    const racecourse =
      full.match(
        /\d+回(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\d+日/,
      )?.[1] || "";
    const course =
      full.match(
        /(芝|ダート|障害)[・ ]*(?:(?:右|左|直線)(?:[・ ]*(?:内|外))?)?[・ ]*\d{3,4}m/,
      )?.[0] || "コース取得中";
    const surface = course.match(/^(芝|ダート|障害)/)?.[1] || "芝";
    const distanceM = +(course.match(/(\d{3,4})m/)?.[1] || 0);
    const going = full.match(/馬場[：: ]*(良|稍重|重|不良)/)?.[1] || "未発表";
    const className = raceClass(full);
    const dateMatch = full.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
    const raceDate = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`
      : new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());

    let fixedWeights: FixedWeights | undefined;
    try {
      const cachedWeights = await sharedCache.get(`weights:${raceId}`);
      if (cachedWeights && typeof cachedWeights === "object")
        fixedWeights = cachedWeights as FixedWeights;
    } catch (error) {
      console.error(
        "REIN fixed weight read failed",
        error instanceof Error ? error.message : "unknown",
      );
    }

    const marketIssues = new Set<number>();
    const raw = cardRows.map((row) => {
      const cells = row.cells;
      const number = +cells[1];
      const gate = +cells[0] || Math.ceil(number / 2);
      const horseCell = cells[2];
      const name = horseName(horseCell);
      const sexAge = parseSexAge(cells);
      const carriedText = cells.slice(2, 6).join(" ");
      const weightCarried = +(
        carriedText.match(
          /(?:^|\s)(4[8-9](?:\.\d)?|5\d(?:\.\d)?|6[0-1](?:\.\d)?)(?:\s|$)/,
        )?.[1] || 0
      );
      const publishedWeight = +(cells[6].match(/\d+/)?.[0] || 0);
      const publishedChange = +(cells[6].match(/\(([+-]?\d+)\)/)?.[1] || 0);
      const fixedWeight = fixedWeights?.[String(number)];
      const weight = fixedWeight?.weight || publishedWeight;
      const change = fixedWeight ? fixedWeight.change : publishedChange;
      const popOdds = parseMarket(cells[7] || "");
      const publishedPopularity =
        parsePopularity(cells[7] || "") ?? finalPopularity.get(number);
      const popularity = publishedPopularity ?? 0;
      const odd = oddsMap.get(number) ?? popOdds?.odds ?? null;
      // A missing or inconsistent market value only holds the market-dependent parts
      // (overall ranking, tickets, 穴候補). It never blocks the race card itself and is
      // never replaced by a placeholder value.
      if (
        (!preview && !publishedPopularity) ||
        (publishedPopularity !== undefined && publishedPopularity > cardRows.length) ||
        (odd !== null && (!Number.isFinite(odd) || odd < 1))
      )
        marketIssues.add(number);
      const horseId = cleanId(row.html.match(/directory\/horse\/(\d+)/)?.[1]);
      const jockeyId = cleanId(row.html.match(/directory\/jockey\/(\d+)/)?.[1]);
      const trainerId = cleanId(
        row.html.match(/directory\/trainer\/(\d+)/)?.[1],
      );
      const pedigree = cells[5];
      const detailSlice = detailText.slice(
        Math.max(0, detailText.lastIndexOf(name)),
        detailText.lastIndexOf(name) + 900,
      );
      const styleProfile = runningStyle(pastRows[number - 1] || detailSlice);
      const style = styleProfile.style;
      const historical = scoreHistory(history, {
        horseId,
        jockeyId,
        trainerId,
        racecourse,
        surface,
        distanceM,
        going,
        gate,
      });
      const positives = [...historical.reasons];
      const cautions = [...historical.risks];
      let liveAdjustment = 0;
      if (weight >= 440 && weight <= 520) {
        liveAdjustment += 2;
        positives.push("馬格適正");
      } else if (weight < 420) {
        liveAdjustment -= 3;
        cautions.push("小柄");
      }
      if (Math.abs(change) >= 12) {
        liveAdjustment -= 4;
        cautions.push(`馬体重${change > 0 ? "+" : ""}${change}kg`);
      } else if (Math.abs(change) >= 8) {
        liveAdjustment -= 2;
        cautions.push(`馬体重${change > 0 ? "+" : ""}${change}kg`);
      }
      if (
        /キズナ|エピファネイア|ロードカナロア|サートゥルナーリア|モーリス/.test(
          pedigree,
        )
      ) {
        liveAdjustment += 2;
        positives.push("血統適性");
      }
      if (style === "逃げ" || style === "先行") {
        liveAdjustment += 1;
        positives.push("位置取り");
      }
      const marketScore = Math.round(
        publishedPopularity
          ? clamp(96 - (publishedPopularity - 1) * (50 / Math.max(cardRows.length - 1, 1)), 42, 96)
          : 70,
      );
      const reinScore = Math.round(
        clamp(72 + historical.adjustment + liveAdjustment, 45, 95),
      );
      const jockey = decode(
        row.html.match(/directory\/jockey\/\d+\/[^>]*>([^<]+)/i)?.[1] || "",
      );
      const trainer = decode(
        row.html.match(/directory\/trainer\/\d+\/[^>]*>([^<]+)/i)?.[1] || "",
      );
      return {
        number,
        gate,
        name,
        score: reinScore,
        reinScore,
        marketScore,
        odds: odd,
        popularity,
        mark: "",
        style,
        verdict: "",
        historyAdjustment: historical.adjustment,
        historySamples: historical.samples,
        positives: [...new Set(positives)].slice(0, 4),
        cautions: [...new Set(cautions)].slice(0, 4),
        weight,
        weightChange: change,
        pedigree,
        jockey,
        trainer,
        earlyPosition: styleProfile.earlyPosition,
        recentPositions: styleProfile.recentPositions,
        paceAdjustment: 0,
        horseId,
        jockeyId,
        trainerId,
        age: sexAge.age,
        sex: sexAge.sex,
        weightCarried,
        firstProbability: 0,
        secondProbability: 0,
        thirdProbability: 0,
        firstSuitability: 0,
        secondSuitability: 0,
        thirdSuitability: 0,
        marketFirstProbability: null as number | null,
        reinMarketFirstProbability: null as number | null,
        historyFactors: [...historical.components]
          .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
          .slice(0, 5)
          .map((component) => ({
            label: component.label,
            samples: component.samples,
            impact: Math.round(component.signal * 1000) / 10,
            wins: component.wins,
            top3: component.top3,
            winRate: component.winRate,
            top3Rate: component.top3Rate,
            averageFinish: component.averageFinish,
          })),
        roleReasons: {
          first: [] as Array<{ feature: string; contribution: number }>,
          second: [] as Array<{ feature: string; contribution: number }>,
          third: [] as Array<{ feature: string; contribution: number }>,
        },
        parameterFactors: historical.components.map((component) => ({
          label: component.label,
          samples: component.samples,
          impact: Math.round(component.signal * 1000) / 10,
          wins: component.wins,
          top3: component.top3,
          winRate: component.winRate,
          top3Rate: component.top3Rate,
          averageFinish: component.averageFinish,
        })),
      };
    });
    if (!fixedWeights && raw.length && raw.every((horse) => horse.weight > 0)) {
      const captured = Object.fromEntries(
        raw.map((horse) => [
          String(horse.number),
          {
            weight: horse.weight,
            change: horse.weightChange,
          },
        ]),
      );
      try {
        await sharedCache.set(`weights:${raceId}`, captured, {
          // Horse weights do not change after publication. Capture them once and
          // keep using that immutable snapshot for the remainder of the race day.
          ttl: 72 * 60 * 60,
          tags: [`rein-race-${raceId}`, "rein-weights"],
          name: "REIN fixed horse weights",
        });
      } catch (error) {
        console.error(
          "REIN fixed weight write failed",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
    const frontRunners = raw.filter(
      (horse) => horse.style === "逃げ" || horse.style === "先行",
    );
    const escapeCount = raw.filter((horse) => horse.style === "逃げ").length;
    const pace =
      escapeCount >= 2
        ? "ハイペース寄り"
        : frontRunners.length >= 4
          ? "平均〜やや速い"
          : frontRunners.length <= 1
            ? "スロー"
            : "スロー〜平均";
    raw.forEach((horse) => {
      horse.paceAdjustment = paceAdjustment(horse.style, pace);
      horse.reinScore = Math.round(
        clamp(horse.reinScore + horse.paceAdjustment, 45, 95),
      );
      horse.score = horse.reinScore;
      if (horse.paceAdjustment > 0)
        horse.positives = [
          ...new Set([...horse.positives, `展開利 +${horse.paceAdjustment}`]),
        ].slice(0, 5);
      if (horse.paceAdjustment < 0)
        horse.cautions = [
          ...new Set([...horse.cautions, `展開不利 ${horse.paceAdjustment}`]),
        ].slice(0, 5);
    });
    let roleModel = { version: "", feature_count: 0 };
    let roleModelReady = false;
    let marketDifferenceReady = false;
    let marketDifferenceOrder: number[] | null = null;
    try {
      const oidcToken = await getVercelOidcToken();
      if (!oidcToken) throw new Error("Vercel OIDC token is unavailable");
      // Never forward the service identity to a request-controlled Host header.
      const deploymentHost =
        process.env.VERCEL_ENV === "production"
          ? "rein-web.vercel.app"
          : process.env.VERCEL_URL;
      if (
        !deploymentHost ||
        !/^[a-zA-Z0-9.-]+\.vercel\.app$/.test(deploymentHost)
      )
        throw new Error("Trusted inference host unavailable");
      const modelPayload = {
        race: {
          race_date: raceDate,
          racecourse,
          surface,
          distance_m: distanceM,
          going,
          race_class: className,
        },
        runners: raw.map((horse) => ({
          horse_number: horse.number,
          gate: horse.gate,
          horse_id: horse.horseId,
          jockey_id: horse.jockeyId,
          trainer_id: horse.trainerId,
          age: horse.age || null,
          sex: horse.sex || null,
          weight_carried: horse.weightCarried || null,
          horse_weight: horse.weight || null,
          horse_weight_change: horse.weightChange,
          popularity: horse.popularity,
          win_odds: horse.odds,
        })),
      };
      const modelCacheKey = `role:${ROLE_CACHE_VERSION}:${createHash("sha256")
        .update(JSON.stringify(modelPayload))
        .digest("hex")}`;
      type RoleScore = {
        version?: string;
        feature_count?: number;
        market_difference_ready?: boolean;
        runners?: Array<{
          horse_number: number;
          first_probability: number;
          second_probability: number;
          third_probability: number;
          market_first_probability?: number | null;
          market_second_probability?: number | null;
          market_third_probability?: number | null;
          rein_market_first_probability?: number | null;
          rein_market_second_probability?: number | null;
          rein_market_third_probability?: number | null;
          first_reasons?: Array<{ feature: string; contribution: number }>;
          second_reasons?: Array<{ feature: string; contribution: number }>;
          third_reasons?: Array<{ feature: string; contribution: number }>;
          market_difference_score?: number | null;
        }>;
        error?: string;
      };
      let scored = (await sharedCache.get(modelCacheKey)) as RoleScore | null;
      if (!scored?.runners?.length) {
        const modelResponse = await fetch(
          `https://${deploymentHost}/api/rein_score`,
          {
            // Cold starts (bundle download + history load) exceeded 90s in production
            // logs; stay inside this function's 180s budget.
            signal: AbortSignal.timeout(140_000),
            method: "POST",
            cache: "no-store",
            headers: {
              "content-type": "application/json",
              "x-rein-oidc-token": oidcToken,
            },
            body: JSON.stringify(modelPayload),
          },
        );
        scored = (await modelResponse.json()) as RoleScore;
        if (!modelResponse.ok || !scored.runners?.length)
          throw new Error(scored.error || "着順モデルの応答が不正です");
        try {
          await sharedCache.set(modelCacheKey, scored, {
            ttl: 12 * 60 * 60,
            tags: [`rein-race-${raceId}`, "rein-role-model"],
            name: "REIN role-model output",
          });
        } catch (error) {
          console.error(
            "REIN role-model cache write failed",
            error instanceof Error ? error.message : "unknown",
          );
        }
      }
      roleModel = {
        version: scored.version || "REIN role v4",
        feature_count: scored.feature_count || 106,
      };
      const byNumber = new Map(
        scored.runners.map((runner) => [runner.horse_number, runner]),
      );
      const maxima = {
        first: Math.max(
          ...scored.runners.map((runner) => runner.first_probability),
        ),
        second: Math.max(
          ...scored.runners.map((runner) => runner.second_probability),
        ),
        third: Math.max(
          ...scored.runners.map((runner) => runner.third_probability),
        ),
      };
      const market = raw.map((horse) => 1 / Math.max(horse.popularity, 1));
      const marketTotal = market.reduce((sum, value) => sum + value, 0);
      raw.forEach((horse, index) => {
        const role = byNumber.get(horse.number);
        if (!role) return;
        horse.firstProbability = role.first_probability;
        horse.secondProbability = role.second_probability;
        horse.thirdProbability = role.third_probability;
        horse.firstSuitability = Math.round(
          (100 * role.first_probability) / maxima.first,
        );
        horse.secondSuitability = Math.round(
          (100 * role.second_probability) / maxima.second,
        );
        horse.thirdSuitability = Math.round(
          (100 * role.third_probability) / maxima.third,
        );
        horse.roleReasons = {
          first: role.first_reasons || [],
          second: role.second_reasons || [],
          third: role.third_reasons || [],
        };
        (horse as any).marketDifferenceScore = role.market_difference_score ?? null;
        horse.marketFirstProbability = scored.market_difference_ready
          ? role.market_first_probability ?? null
          : null;
        horse.reinMarketFirstProbability = scored.market_difference_ready
          ? role.rein_market_first_probability ?? null
          : null;
        const roleStrength =
          0.5 * role.first_probability +
          0.3 * role.second_probability +
          0.2 * role.third_probability;
        const blended =
          (0.7 * market[index]) / marketTotal + 0.3 * roleStrength;
        horse.reinScore = Math.round(
          clamp(50 + blended * raw.length * 35, 45, 98),
        );
        horse.score = horse.reinScore;
      });
      roleModelReady = raw.every((horse) => byNumber.has(horse.number));
      marketDifferenceReady = Boolean(scored.market_difference_ready);
      if (scored.market_difference_ready) {
        const ranked = scored.runners
          .map((runner) => {
            const market = 0.5 * (runner.market_first_probability ?? NaN)
              + 0.3 * (runner.market_second_probability ?? NaN)
              + 0.2 * (runner.market_third_probability ?? NaN);
            const rein = 0.5 * (runner.rein_market_first_probability ?? NaN)
              + 0.3 * (runner.rein_market_second_probability ?? NaN)
              + 0.2 * (runner.rein_market_third_probability ?? NaN);
            const edge = 0.5 * Math.log((runner.rein_market_first_probability ?? NaN) / (runner.market_first_probability ?? NaN))
              + 0.3 * Math.log((runner.rein_market_second_probability ?? NaN) / (runner.market_second_probability ?? NaN))
              + 0.2 * Math.log((runner.rein_market_third_probability ?? NaN) / (runner.market_third_probability ?? NaN));
            return { number: runner.horse_number, score: market * Math.exp(0.75 * edge), rein };
          })
          .filter((item) => Number.isFinite(item.score))
          .sort((a, b) => b.score - a.score || a.number - b.number);
        if (ranked.length === raw.length) marketDifferenceOrder = ranked.map((item) => item.number);
      }
    } catch (modelError) {
      // No substitute scores: the history-only fallback used to fill 1着/2着/3着 with
      // one shared number, which looked like model output. Hold the evaluation instead.
      console.error(
        "REIN role model unavailable",
        modelError instanceof Error ? modelError.message : "unknown",
      );
      roleModelReady = false;
    }
    raw.sort(
      (a, b) => b.reinScore - a.reinScore || a.popularity - b.popularity,
    );
    // MARKET_TOP4_LEGACY_TAIL_V1: splice once from the untouched legacy order.
    const legacyOrder = [...raw];
    let marketTop4Applied = false;
    if (marketDifferenceOrder && marketDifferenceOrder.length === legacyOrder.length) {
      const byHorseNumber = new Map(legacyOrder.map((horse) => [horse.number, horse]));
      const completeOrder = new Set(marketDifferenceOrder).size === legacyOrder.length
        && marketDifferenceOrder.every((number) => byHorseNumber.has(number));
      const topFour = completeOrder ? marketDifferenceOrder.slice(0, 4).flatMap((number) => {
        const horse = byHorseNumber.get(number);
        return horse ? [horse] : [];
      }) : [];
      if (topFour.length === 4) {
        const selected = new Set(topFour.map((horse) => horse.number));
        raw.splice(0, raw.length, ...topFour,
          ...legacyOrder.filter((horse) => !selected.has(horse.number)));
        marketTop4Applied = true;
        console.info("REIN market-difference Top4 applied", JSON.stringify({
          modelVersion: roleModel.version,
          cacheVersion: ROLE_CACHE_VERSION,
          top4: topFour.map((horse) => horse.number),
          tailCount: raw.length - 4,
        }));
      }
    }
    const popularityComplete = !preview && marketIssues.size === 0 && raw.length > 0;
    // Overall ranking = validated market-difference Top4 + legacy tail. Without the
    // Top4 (missing odds, no market model output) it is held rather than silently
    // replaced by the legacy-only order. The preview keeps its labelled provisional order.
    const overallReady = roleModelReady && (preview || (popularityComplete && marketTop4Applied));
    // Tickets keep their own rule (popularity 70% + role models 30%) and need both inputs.
    const ticketsReady = roleModelReady && (preview || popularityComplete);
    const picks = selectPicks(raw, {
      roleModelReady,
      marketReady: popularityComplete && marketDifferenceReady,
    });
    const pickByNumber = new Map(
      [picks.main, picks.rival, picks.longshot].flatMap((pick) =>
        pick ? [[pick.number, pick] as const] : [],
      ),
    );
    raw.forEach((horse, index) => {
      const pick = pickByNumber.get(horse.number);
      horse.mark = pick ? { 本命: "◎", 対抗: "○", 穴候補: "☆" }[pick.role] : "・";
      horse.verdict = pick
        ? pick.role
        : overallReady
          ? `総合${index + 1}位`
          : "";
    });
    const held: string[] = [];
    if (!roleModelReady)
      held.push("着順別モデルの結果を取得できないため、着順適性・総合順位・印・買い目を保留しています");
    else if (!preview && !popularityComplete)
      held.push(
        `人気・オッズを正常に取得できない馬がいるため（${[...marketIssues].sort((a, b) => a - b).join("・")}番）、総合順位・買い目・穴候補を保留しています`,
      );
    else if (!preview && !marketTop4Applied)
      held.push("市場差式の評価がそろわないため、総合順位を保留しています");
    const raceName = decode(
      card.match(
        /<h2[^>]*class="[^"]*hr-predictRaceInfo__title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i,
      )?.[1] || "",
    );
    const raceNumber = decode(
      card.match(
        /<div[^>]*class="[^"]*hr-predictRaceInfo__raceNumber[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      )?.[1] || "",
    );
    const title =
      `${racecourse}${raceNumber} ${raceName}`.trim() ||
      `${raceId.slice(-2).replace(/^0/, "")}R`;
    const start = full.match(/(\d{1,2}:\d{2})発走/)?.[1] || "--:--";
    const leaderHorses = [...frontRunners]
      .sort((a, b) => (a.earlyPosition ?? 99) - (b.earlyPosition ?? 99))
      .slice(0, 4);
    const leaders = leaderHorses.map((horse) => horse.number);
    const paceDetail = leaderHorses.length
      ? `${leaderHorses.map((horse) => `${horse.number} ${horse.name}（${horse.style}）`).join("・")}が前方候補。逃げ${escapeCount}頭、先行${frontRunners.length - escapeCount}頭から判定。`
      : "明確な逃げ・先行馬が不在。好位勢の出方次第で落ち着く展開を想定。";
    const finishers = resultRows.map((row) => ({
      finish: +row.cells[0],
      number: +row.cells[2],
      name: decode(
        row.html.match(/directory\/horse\/\d+\/[^>]*>([^<]+)/i)?.[1] ||
          row.cells[3].split(" ")[0],
      ),
      odds: parseResultOdds(row.cells[7])!,
    }));
    const payouts = parsePayouts(result);
    const startAt = /^\d{1,2}:\d{2}$/.test(start)
      ? Date.parse(`${raceDate}T${start.padStart(5, "0")}:00+09:00`)
      : NaN;
    const generatedAt = new Date().toISOString();
    const phase: "preview" | "prestart" | "poststart" | "final" = preview
      ? "preview"
      : resultRows.length
        ? "final"
        : Number.isFinite(startAt) && Date.now() >= startAt
          ? "poststart"
          : "prestart";
    const runnerKey = raw.map((horse) => horse.number).sort((a, b) => a - b).join("-");
    const complete = overallReady && ticketsReady && picks.status === "ready";
    const oddsTime = jstTime(oddsSource.fetchedAt || cardSource.fetchedAt);
    const cardTime = jstTime(cardSource.fetchedAt);
    const review = { isFinished: resultRows.length > 0, finishers, payouts };
    const warnings = [
      preview
        ? "前日暫定予想です。人気・オッズ・馬体重・馬場状態は当日に自動更新されます"
        : "",
      !odds ? "単勝オッズ表を取得できず、出馬表の掲載値を使用しています" : "",
      !result ? "確定結果を取得できていません" : "",
      resultRows.length && !payouts.length ? "払戻情報を取得できていません" : "",
      scratchedRows.length
        ? `出走取消・除外：${scratchedRows.map((row) => `${row.cells[1]}番`).join("・")}（評価対象から外しています）`
        : "",
    ].filter(Boolean);
    const body = {
      warnings,
      race: {
        title,
        course,
        condition: going,
        start,
        updated: oddsTime ? `人気・オッズ ${oddsTime}取得` : cardTime ? `出馬表 ${cardTime}取得` : "取得時刻不明",
        dataTimes: {
          card: cardSource.fetchedAt,
          odds: oddsSource.fetchedAt,
          result: resultSource.fetchedAt,
        },
        raceId,
      },
      prediction: {
        phase,
        source: "live" as "live" | "prestart" | "rebuilt",
        generatedAt,
        label:
          phase === "preview"
            ? "前日出走表による暫定予想"
            : phase === "prestart"
              ? `発走前の予想（人気・オッズ ${oddsTime ?? "取得時刻不明"}取得）`
              : phase === "final"
                ? "発走前の予想が保存されていないため、確定オッズで再計算した参考表示です（発走前の予想ではありません）"
                : "発走前の予想が保存されていないため、発走後に取得した情報で再計算した参考表示です（発走前の予想ではありません）",
      },
      evaluation: {
        roleModel: roleModelReady ? "ready" : "unavailable",
        overall: overallReady ? "ready" : "held",
        tickets: ticketsReady ? "ready" : "held",
        held,
      },
      picks,
      scratched: scratchedRows.map((row) => ({
        number: +row.cells[1],
        name: horseName(row.cells[2] || ""),
      })),
      model: {
        ...history.meta,
        version: roleModel.version,
        featureCount: roleModel.feature_count,
        overallPolicy: preview
          ? "総合順位：前日暫定（市場情報は未反映）"
          : "総合順位：上位4頭＝市場差式、5位以下＝従来順",
        strategy: preview
          ? "買い目：着順別REIN（市場情報は未反映）"
          : "買い目：全券種＝人気70%＋着順別REIN30%",
        markPolicy: "本命・対抗＝1着適性1位・2位／穴候補＝1着適性3〜6位で4番人気以下かつ1着評価が市場を上回る馬",
      },
      pace: {
        label: pace,
        detail: paceDetail,
        leaders,
        escapeCount,
        frontCount: frontRunners.length,
      },
      horses: raw,
      tickets: ticketsReady ? buildTickets(raw) : [],
      review,
      runnerKey,
    };
    let responseBody: typeof body = body;
    if (phase === "prestart" && complete) {
      try {
        await sharedCache.set(`${PRESTART_KEY}:${raceId}`, JSON.stringify(body), {
          ttl: 72 * 60 * 60,
          tags: [`rein-race-${raceId}`, "rein-prestart"],
          name: "REIN pre-start prediction",
        });
      } catch (error) {
        console.error("REIN pre-start snapshot write failed", error instanceof Error ? error.message : "unknown");
      }
    } else if (phase === "poststart" || phase === "final") {
      try {
        const saved = await sharedCache.get(`${PRESTART_KEY}:${raceId}`);
        const prestart = typeof saved === "string" ? (JSON.parse(saved) as typeof body) : null;
        if (prestart && prestart.runnerKey === runnerKey) {
          // Show the stored pre-start prediction next to the current result; the
          // result and final odds never rewrite it.
          responseBody = {
            ...prestart,
            warnings: [...new Set([...prestart.warnings.filter((item) => !item.startsWith("確定結果")), ...warnings])],
            prediction: {
              ...prestart.prediction,
              phase,
              source: "prestart",
              label: `発走前に保存した予想を表示（人気・オッズ ${jstTime(prestart.race.dataTimes.odds || prestart.race.dataTimes.card) ?? "取得時刻不明"}取得）`,
            },
            review,
          };
        } else {
          body.prediction.source = "rebuilt";
          if (prestart)
            body.warnings.push("発走前の予想と出走馬構成が一致しないため、保存済みの予想は表示していません");
        }
      } catch (error) {
        console.error("REIN pre-start snapshot read failed", error instanceof Error ? error.message : "unknown");
        body.prediction.source = "rebuilt";
      }
    }
    const usedPrestart = responseBody !== body;
    return NextResponse.json(responseBody, {
      headers: {
        ...publicCacheHeaders,
        // Incomplete evaluations are not cached, so a retry can recover them.
        "x-rein-fallback": usedPrestart || complete ? "0" : "1",
        "x-rein-market-difference": marketTop4Applied ? "1" : "0",
        "x-rein-role-cache-version": ROLE_CACHE_VERSION,
        "x-rein-final": resultRows.length ? "1" : "0",
        "x-rein-phase": phase,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "分析データを取得できませんでした",
      },
      {
        status: error instanceof RaceNotReadyError ? 404 : 502,
        headers: failureCacheHeaders,
      },
    );
  }
}
