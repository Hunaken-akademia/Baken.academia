import { NextRequest, NextResponse } from "next/server";
import { getVercelOidcToken } from "@vercel/oidc";
import { getCache } from "@vercel/functions";
import { timingSafeEqual } from "node:crypto";
import { loadHistory, scoreHistory } from "@/lib/history";
import { buildTickets } from "@/lib/tickets";
import { responseCache } from "@/lib/response-cache";
import { parseMarket, parsePopularity, parseResultOdds } from "@/lib/market-data";
import { parsePayouts } from "@/lib/payouts";
import { fetchSource } from "@/lib/source-fetch";
import { failureCacheHeaders, readFailure, writeFailure } from "@/lib/failure-cache";

const cachedAnalysis = responseCache(15_000);
const sharedCache = getCache({ namespace: "rein-analysis-v1" });
const publicCacheHeaders = {
  "Cache-Control": "public, max-age=0, s-maxage=15, stale-while-revalidate=15",
};

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

const decode = (value: string) => value.replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const cleanId = (value = "") => value.replace(/^0+/, "") || "0";
const tableRows = (html: string, minimumCells = 7) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => ({
  html: match[1],
  cells: [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => decode(cell[1])),
})).filter((row) => row.cells.length >= minimumCells);

function runningStyle(detail: string) {
  const recentPositions = [...detail.matchAll(/\b\d{1,2}(?:-\d{1,2}){1,3}\b/g)]
    .map((match) => match[0])
    .slice(0, 5);
  const earlyPositions = recentPositions.map((value) => {
    const positions = value.split("-").map(Number);
    return positions.length >= 2 ? (positions[0] + positions[1]) / 2 : positions[0];
  });
  if (!earlyPositions.length) return { style: "自在", earlyPosition: null, recentPositions };
  const weighted = earlyPositions.reduce((sum, value, index) => sum + value * (earlyPositions.length - index), 0);
  const weights = earlyPositions.reduce((sum, _value, index) => sum + earlyPositions.length - index, 0);
  const earlyPosition = Math.round((weighted / weights) * 10) / 10;
  const style = earlyPosition <= 2.4 ? "逃げ" : earlyPosition <= 4.5 ? "先行" : earlyPosition <= 7.5 ? "好位" : earlyPosition <= 10.5 ? "差し" : "追込";
  return { style, earlyPosition, recentPositions };
}

function pastPerformanceRows(html: string) {
  const table = html.match(/<table[^>]*id=["']denma_past["'][^>]*>([\s\S]*?)<\/table>/i)?.[1] || "";
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => match[1])
    .filter((row) => /hr-denma__passing/.test(row));
}

function paceAdjustment(style: string, pace: string) {
  if (pace === "ハイペース寄り") return ({ 逃げ: -3, 先行: -1, 好位: 1, 差し: 3, 追込: 2, 自在: 0 } as Record<string, number>)[style] || 0;
  if (pace === "平均〜やや速い") return ({ 逃げ: -2, 先行: 0, 好位: 1, 差し: 2, 追込: 1, 自在: 0 } as Record<string, number>)[style] || 0;
  if (pace === "スロー") return ({ 逃げ: 4, 先行: 3, 好位: 1, 差し: -1, 追込: -2, 自在: 0 } as Record<string, number>)[style] || 0;
  return ({ 逃げ: 2, 先行: 2, 好位: 1, 差し: 0, 追込: -1, 自在: 0 } as Record<string, number>)[style] || 0;
}

function mark(index: number) { return ["◎", "○", "▲", "☆", "△", "注"][index] || (index < 8 ? "・" : "消"); }

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
  if (!/^\d{10,12}$/.test(raceId)) return NextResponse.json({ error: "レースIDは10〜12桁で入力してください" }, { status: 400 });
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  if (forceRefresh && !isCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!forceRefresh) {
    try {
      const snapshot = await sharedCache.get(`snapshot-market-v2:${raceId}`);
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
      console.error("REIN snapshot read failed", error instanceof Error ? error.message : "unknown");
    }

    const failure = await readFailure(`analyze:${raceId}`);
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
    : await cachedAnalysis(raceId, () => analyze(request));
  if (response.ok && response.headers.get("x-rein-fallback") === "0") {
    try {
      await sharedCache.set(`snapshot-market-v2:${raceId}`, await response.clone().text(), {
        ttl: 15 * 60,
        tags: [`rein-race-${raceId}`, "rein-live"],
        name: "REIN race analysis",
      });
    } catch (error) {
      console.error("REIN snapshot write failed", error instanceof Error ? error.message : "unknown");
    }
  } else if (!response.ok) {
    await writeFailure(
      `analyze:${raceId}`,
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
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function analyze(request: NextRequest) {
  const raceId = request.nextUrl.searchParams.get("raceId") || "";
  if (!/^\d{10,12}$/.test(raceId)) return NextResponse.json({ error: "レースIDは10〜12桁で入力してください" }, { status: 400 });
  const base = "https://sports.yahoo.co.jp/keiba/race";
  try {
    const [card, detail, odds, result, history] = await Promise.all([
      fetchSource(`${base}/denma/${raceId}`, "出馬表"),
      fetchSource(`${base}/denma/${raceId}?detail=1`, "出走履歴"),
      fetchSource(`${base}/odds/tfw/${raceId}`, "単勝オッズ", true),
      fetchSource(`${base}/result/${raceId}`, "確定結果", true),
      loadHistory(),
    ]);
    const cardRows = tableRows(card).filter((row) => /^\d+$/.test(row.cells[1] || "") && /\d+\([+-]?\d+\)/.test(row.cells[6] || ""));
    const oddsRows = tableRows(odds, 5).filter((row) => /^\d+$/.test(row.cells[1] || "") && /^\d+(\.\d+)?$/.test(row.cells[3] || ""));
    const resultRows = tableRows(result).filter((row) =>
      /^\d+$/.test(row.cells[0] || "") && /^\d+$/.test(row.cells[2] || "") && parseResultOdds(row.cells[7] || "") !== null
    );
    if (!cardRows.length) throw new RaceNotReadyError("出馬表の形式を読み取れませんでした。発走前の中央競馬レースを指定してください");
    const liveOddsMap = new Map(oddsRows.map((row) => [+row.cells[1], +row.cells[3]]));
    const finalOddsMap = new Map(resultRows.map((row) => [
      +row.cells[2],
      parseResultOdds(row.cells[7])!,
    ]));
    const oddsMap = liveOddsMap.size ? liveOddsMap : finalOddsMap;
    const finalPopularity = new Map(
      [...finalOddsMap.entries()].sort((a, b) => a[1] - b[1]).map(([number], index) => [number, index + 1])
    );
    const full = decode(card);
    const detailText = decode(detail);
    const pastRows = pastPerformanceRows(detail);
    const racecourse = full.match(/\d+回(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\d+日/)?.[1] || "";
    const course = full.match(/(芝|ダート|障害)[・ ]*(?:(?:右|左|直線)(?:[・ ]*(?:内|外))?)?[・ ]*\d{3,4}m/)?.[0] || "コース取得中";
    const surface = course.match(/^(芝|ダート|障害)/)?.[1] || "芝";
    const distanceM = +(course.match(/(\d{3,4})m/)?.[1] || 0);
    const going = full.match(/馬場[：: ]*(良|稍重|重|不良)/)?.[1] || "未発表";
    const className = raceClass(full);
    const dateMatch = full.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
    const raceDate = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`
      : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

    let fixedWeights: FixedWeights | undefined;
    try {
      const cachedWeights = await sharedCache.get(`weights:${raceId}`);
      if (cachedWeights && typeof cachedWeights === "object") fixedWeights = cachedWeights as FixedWeights;
    } catch (error) {
      console.error("REIN fixed weight read failed", error instanceof Error ? error.message : "unknown");
    }

    const raw = cardRows.map((row) => {
      const cells = row.cells;
      const number = +cells[1];
      const gate = +cells[0] || Math.ceil(number / 2);
      const horseCell = cells[2];
      const name = (horseCell.match(/^([^ ]+)/)?.[1] || horseCell).replace(/牝\d|牡\d|セ\d/, "");
      const sexAge = horseCell.match(/(牡|牝|セ)\s*(\d+)/) || cells.slice(2, 5).join(" ").match(/(牡|牝|セ)\s*(\d+)/);
      const carriedText = cells.slice(2, 6).join(" ");
      const weightCarried = +(carriedText.match(/(?:^|\s)(4[8-9](?:\.\d)?|5\d(?:\.\d)?|6[0-1](?:\.\d)?)(?:\s|$)/)?.[1] || 0);
      const publishedWeight = +(cells[6].match(/\d+/)?.[0] || 0);
      const publishedChange = +(cells[6].match(/\(([+-]?\d+)\)/)?.[1] || 0);
      const fixedWeight = fixedWeights?.[String(number)];
      const weight = fixedWeight?.weight || publishedWeight;
      const change = fixedWeight ? fixedWeight.change : publishedChange;
      const popOdds = parseMarket(cells[7] || "");
      const popularity = parsePopularity(cells[7] || "") ?? finalPopularity.get(number);
      const odd = oddsMap.get(number) ?? popOdds?.odds ?? null;
      if (!popularity || popularity > cardRows.length || (odd !== null && (!Number.isFinite(odd) || odd < 1))) {
        throw new Error("人気・オッズを正常に取得できないため、評価と買い目の生成を保留しています。時間をおいて更新してください");
      }
      const horseId = cleanId(row.html.match(/directory\/horse\/(\d+)/)?.[1]);
      const jockeyId = cleanId(row.html.match(/directory\/jockey\/(\d+)/)?.[1]);
      const trainerId = cleanId(row.html.match(/directory\/trainer\/(\d+)/)?.[1]);
      const pedigree = cells[5];
      const detailSlice = detailText.slice(Math.max(0, detailText.lastIndexOf(name)), detailText.lastIndexOf(name) + 900);
      const styleProfile = runningStyle(pastRows[number - 1] || detailSlice);
      const style = styleProfile.style;
      const historical = scoreHistory(history, { horseId, jockeyId, trainerId, racecourse, surface, distanceM, going, gate });
      const positives = [...historical.reasons];
      const cautions = [...historical.risks];
      let liveAdjustment = 0;
      if (weight >= 440 && weight <= 520) { liveAdjustment += 2; positives.push("馬格適正"); }
      else if (weight < 420) { liveAdjustment -= 3; cautions.push("小柄"); }
      if (Math.abs(change) >= 12) { liveAdjustment -= 4; cautions.push(`馬体重${change > 0 ? "+" : ""}${change}kg`); }
      else if (Math.abs(change) >= 8) { liveAdjustment -= 2; cautions.push(`馬体重${change > 0 ? "+" : ""}${change}kg`); }
      if (/キズナ|エピファネイア|ロードカナロア|サートゥルナーリア|モーリス/.test(pedigree)) { liveAdjustment += 2; positives.push("血統適性"); }
      if (style === "逃げ" || style === "先行") { liveAdjustment += 1; positives.push("位置取り"); }
      const marketScore = Math.round(clamp(96 - (popularity - 1) * (50 / Math.max(cardRows.length - 1, 1)), 42, 96));
      const reinScore = Math.round(clamp(72 + historical.adjustment + liveAdjustment, 45, 95));
      const jockey = decode(row.html.match(/directory\/jockey\/\d+\/[^>]*>([^<]+)/i)?.[1] || "");
      const trainer = decode(row.html.match(/directory\/trainer\/\d+\/[^>]*>([^<]+)/i)?.[1] || "");
      return {
        number, gate, name, score: reinScore, reinScore, marketScore, odds: odd, popularity,
        mark: "", style, verdict: "", historyAdjustment: historical.adjustment,
        historySamples: historical.samples, positives: [...new Set(positives)].slice(0, 4),
        cautions: [...new Set(cautions)].slice(0, 4), weight, weightChange: change, pedigree,
        jockey, trainer, earlyPosition: styleProfile.earlyPosition,
        recentPositions: styleProfile.recentPositions,
        paceAdjustment: 0, horseId, jockeyId, trainerId,
        age: +(sexAge?.[2] || 0), sex: sexAge?.[1] || "",
        weightCarried,
        firstProbability: 0, secondProbability: 0, thirdProbability: 0,
        firstSuitability: 0, secondSuitability: 0, thirdSuitability: 0,
        historyFactors: [...historical.components]
          .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
          .slice(0, 5)
          .map((component) => ({ label: component.label, samples: component.samples, impact: Math.round(component.signal * 1000) / 10 })),
      };
    });
    if (!fixedWeights && raw.length && raw.every((horse) => horse.weight > 0)) {
      const captured = Object.fromEntries(raw.map((horse) => [String(horse.number), {
        weight: horse.weight,
        change: horse.weightChange,
      }]));
      try {
        await sharedCache.set(`weights:${raceId}`, captured, {
          ttl: 12 * 60 * 60,
          tags: [`rein-race-${raceId}`, "rein-weights"],
          name: "REIN fixed horse weights",
        });
      } catch (error) {
        console.error("REIN fixed weight write failed", error instanceof Error ? error.message : "unknown");
      }
    }
    const frontRunners = raw.filter((horse) => horse.style === "逃げ" || horse.style === "先行");
    const escapeCount = raw.filter((horse) => horse.style === "逃げ").length;
    const pace = escapeCount >= 2 ? "ハイペース寄り" : frontRunners.length >= 4 ? "平均〜やや速い" : frontRunners.length <= 1 ? "スロー" : "スロー〜平均";
    raw.forEach((horse) => {
      horse.paceAdjustment = paceAdjustment(horse.style, pace);
      horse.reinScore = Math.round(clamp(horse.reinScore + horse.paceAdjustment, 45, 95));
      horse.score = horse.reinScore;
      if (horse.paceAdjustment > 0) horse.positives = [...new Set([...horse.positives, `展開利 +${horse.paceAdjustment}`])].slice(0, 5);
      if (horse.paceAdjustment < 0) horse.cautions = [...new Set([...horse.cautions, `展開不利 ${horse.paceAdjustment}`])].slice(0, 5);
    });
    let roleModel = { version: "履歴補正フォールバック", feature_count: 0 };
    try {
      const oidcToken = await getVercelOidcToken();
      if (!oidcToken) throw new Error("Vercel OIDC token is unavailable");
      // Never forward the service identity to a request-controlled Host header.
      const deploymentHost = process.env.VERCEL_ENV === "production" ? "rein-web.vercel.app" : process.env.VERCEL_URL;
      if (!deploymentHost || !/^[a-zA-Z0-9.-]+\.vercel\.app$/.test(deploymentHost)) throw new Error("Trusted inference host unavailable");
      const modelResponse = await fetch(`https://${deploymentHost}/api/rein_score`, {
        signal: AbortSignal.timeout(90_000),
        method: "POST", cache: "no-store", headers: {
          "content-type": "application/json",
          "x-rein-oidc-token": oidcToken,
        },
        body: JSON.stringify({
          race: {
            race_date: raceDate,
            racecourse, surface, distance_m: distanceM, going, race_class: className,
          },
          runners: raw.map((horse) => ({
            horse_number: horse.number, gate: horse.gate, horse_id: horse.horseId,
            jockey_id: horse.jockeyId, trainer_id: horse.trainerId,
            age: horse.age || null, sex: horse.sex || null,
            weight_carried: horse.weightCarried || null, horse_weight: horse.weight || null,
            horse_weight_change: horse.weightChange,
          })),
        }),
      });
      const scored = await modelResponse.json() as { version?: string; feature_count?: number; runners?: Array<{horse_number:number;first_probability:number;second_probability:number;third_probability:number}>; error?:string };
      if (!modelResponse.ok || !scored.runners?.length) throw new Error(scored.error || "着順モデルの応答が不正です");
      roleModel = { version: scored.version || "REIN role v4", feature_count: scored.feature_count || 106 };
      const byNumber = new Map(scored.runners.map((runner) => [runner.horse_number, runner]));
      const maxima = {
        first: Math.max(...scored.runners.map((runner) => runner.first_probability)),
        second: Math.max(...scored.runners.map((runner) => runner.second_probability)),
        third: Math.max(...scored.runners.map((runner) => runner.third_probability)),
      };
      const market = raw.map((horse) => 1 / Math.max(horse.popularity, 1));
      const marketTotal = market.reduce((sum, value) => sum + value, 0);
      raw.forEach((horse, index) => {
        const role = byNumber.get(horse.number);
        if (!role) return;
        horse.firstProbability = role.first_probability;
        horse.secondProbability = role.second_probability;
        horse.thirdProbability = role.third_probability;
        horse.firstSuitability = Math.round(100 * role.first_probability / maxima.first);
        horse.secondSuitability = Math.round(100 * role.second_probability / maxima.second);
        horse.thirdSuitability = Math.round(100 * role.third_probability / maxima.third);
        const roleStrength = .5 * role.first_probability + .3 * role.second_probability + .2 * role.third_probability;
        const blended = .70 * market[index] / marketTotal + .30 * roleStrength;
        horse.reinScore = Math.round(clamp(50 + blended * raw.length * 35, 45, 98));
        horse.score = horse.reinScore;
      });
    } catch (modelError) {
      console.error("REIN role model fallback", modelError);
      const fallback = raw.map((horse) => Math.max(horse.reinScore, 1));
      const total = fallback.reduce((sum, value) => sum + value, 0);
      raw.forEach((horse, index) => {
        const probability = fallback[index] / total;
        horse.firstProbability = horse.secondProbability = horse.thirdProbability = probability;
        horse.firstSuitability = horse.secondSuitability = horse.thirdSuitability = Math.round(100 * horse.reinScore / Math.max(...fallback));
      });
    }
    raw.sort((a, b) => b.reinScore - a.reinScore || a.popularity - b.popularity);
    raw.forEach((horse, index) => {
      horse.mark = mark(index);
      horse.verdict = index === 0 ? "軸" : index < 3 ? "相手" : index === 3 ? "穴" : index < 7 ? "連下" : "見送り";
    });
    const raceName = decode(card.match(/<h2[^>]*class="[^"]*hr-predictRaceInfo__title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || "");
    const raceNumber = decode(card.match(/<div[^>]*class="[^"]*hr-predictRaceInfo__raceNumber[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
    const title = `${racecourse}${raceNumber} ${raceName}`.trim() || `${raceId.slice(-2).replace(/^0/, "")}R`;
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
      name: decode(row.html.match(/directory\/horse\/\d+\/[^>]*>([^<]+)/i)?.[1] || row.cells[3].split(" ")[0]),
      odds: parseResultOdds(row.cells[7])!,
    }));
    const payouts = parsePayouts(result);
    return NextResponse.json({
      warnings: [!odds ? "単勝オッズ表を取得できず、出馬表の掲載値を使用しています" : "", !result ? "確定結果を取得できていません" : "", resultRows.length && !payouts.length ? "払戻情報を取得できていません" : ""].filter(Boolean),
      race: { title, course, condition: going, start, updated: `${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })}更新`, raceId },
      model: { ...history.meta, version: roleModel.version, featureCount: roleModel.feature_count, strategy: "全券種=人気70%+着順別REIN 30%", snapshotPolicy: resultRows.length ? "最終オッズから復習用予想を再構成" : "発走前の最新情報で分析" },
      pace: { label: pace, detail: paceDetail, leaders, escapeCount, frontCount: frontRunners.length },
      horses: raw,
      tickets: buildTickets(raw),
      review: { isFinished: resultRows.length > 0, finishers, payouts },
    }, { headers: {
      ...publicCacheHeaders,
      "x-rein-fallback": roleModel.feature_count ? "0" : "1",
    } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "分析データを取得できませんでした" },
      { status: error instanceof RaceNotReadyError ? 404 : 502, headers: failureCacheHeaders },
    );
  }
}
