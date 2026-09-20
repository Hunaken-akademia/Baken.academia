import { NextRequest, NextResponse } from "next/server";
import { loadHistory, scoreHistory } from "@/lib/history";
import { buildTickets } from "@/lib/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decode = (value: string) => value.replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const cleanId = (value = "") => value.replace(/^0+/, "") || "0";
const tableRows = (html: string) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => ({
  html: match[1],
  cells: [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => decode(cell[1])),
})).filter((row) => row.cells.length >= 7);

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

export async function GET(request: NextRequest) {
  const raceId = request.nextUrl.searchParams.get("raceId") || "";
  if (!/^\d{10,12}$/.test(raceId)) return NextResponse.json({ error: "レースIDは10〜12桁で入力してください" }, { status: 400 });
  const base = "https://sports.yahoo.co.jp/keiba/race";
  try {
    const headers = { "user-agent": "Mozilla/5.0 (compatible; REIN/0.2; personal analysis)" };
    const [cardRes, detailRes, oddsRes, history] = await Promise.all([
      fetch(`${base}/denma/${raceId}`, { headers, cache: "no-store" }),
      fetch(`${base}/denma/${raceId}?detail=1`, { headers, cache: "no-store" }),
      fetch(`${base}/odds/tfw/${raceId}`, { headers, cache: "no-store" }),
      loadHistory(),
    ]);
    if (!cardRes.ok || !oddsRes.ok) throw new Error("出馬表またはオッズを取得できませんでした");
    const [card, detail, odds] = await Promise.all([cardRes.text(), detailRes.text(), oddsRes.text()]);
    const cardRows = tableRows(card).filter((row) => /^\d+$/.test(row.cells[1] || "") && /\d+\([+-]?\d+\)/.test(row.cells[6] || ""));
    const oddsRows = tableRows(odds).filter((row) => /^\d+$/.test(row.cells[1] || "") && /^\d+(\.\d+)?$/.test(row.cells[3] || ""));
    if (!cardRows.length) throw new Error("出馬表の形式を読み取れませんでした。発走前の中央競馬レースを指定してください");
    const oddsMap = new Map(oddsRows.map((row) => [+row.cells[1], +row.cells[3]]));
    const full = decode(card);
    const detailText = decode(detail);
    const pastRows = pastPerformanceRows(detail);
    const racecourse = full.match(/\d+回(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\d+日/)?.[1] || "";
    const course = full.match(/(芝|ダート|障害)[・ ]*(?:右|左|直線)?[・ ]*\d{3,4}m/)?.[0] || "コース取得中";
    const surface = course.match(/^(芝|ダート|障害)/)?.[1] || "芝";
    const distanceM = +(course.match(/(\d{3,4})m/)?.[1] || 0);
    const going = full.match(/馬場[：: ]*(良|稍重|重|不良)/)?.[1] || "未発表";

    const raw = cardRows.map((row) => {
      const cells = row.cells;
      const number = +cells[1];
      const gate = +cells[0] || Math.ceil(number / 2);
      const horseCell = cells[2];
      const name = (horseCell.match(/^([^ ]+)/)?.[1] || horseCell).replace(/牝\d|牡\d|セ\d/, "");
      const weight = +(cells[6].match(/\d+/)?.[0] || 0);
      const change = +(cells[6].match(/\(([+-]?\d+)\)/)?.[1] || 0);
      const popOdds = cells[7].match(/(\d+)\((\d+(?:\.\d+)?)\)/);
      const popularity = popOdds ? +popOdds[1] : 99;
      const odd = oddsMap.get(number) ?? (popOdds ? +popOdds[2] : 999);
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
        paceAdjustment: 0,
        historyFactors: [...historical.components]
          .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
          .slice(0, 5)
          .map((component) => ({ label: component.label, samples: component.samples, impact: Math.round(component.signal * 1000) / 10 })),
      };
    });
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
    return NextResponse.json({
      race: { title, course, condition: going, start, updated: `${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })}更新`, raceId },
      model: { ...history.meta, strategy: "本線=人気順 / 対抗=人気75%+REIN25% / 穴=人気50%+REIN50%" },
      pace: { label: pace, detail: paceDetail, leaders, escapeCount, frontCount: frontRunners.length },
      horses: raw,
      tickets: buildTickets(raw),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "分析データを取得できませんでした" }, { status: 502 });
  }
}
