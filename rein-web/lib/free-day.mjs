// REIN 無料版：毎日「中央1場・地方1場」をログイン無しで公開する。WAKE 無料版（wake-free）と同じ考え方で、
// その日に開催している場から日付（日本時間）を元に全員共通の1場を選ぶ。重賞のある場は除く（重賞は会員版で見てもらう）。
// 全場に重賞がある日だけ、いちばん格の低い場から選ぶ。
// 他の場・他のレースを開けない制限はサーバー側（app/api/free/*）でかける。

// 「ジャパンC(GI)」「JBCクラシック（JpnI）」「(G3)」などから格を読む。数字が小さいほど上の格。
export function raceGradeLevel(title = "") {
  const match = String(title).match(/(?:G|Ｇ|Jpn|ＪＰＮ)\s*(III|II|I|Ⅲ|Ⅱ|Ⅰ|[1-3１-３])(?![A-Za-z])/i);
  if (!match) return null;
  const mark = match[1].toUpperCase();
  return { I: 1, "Ⅰ": 1, "1": 1, "１": 1, II: 2, "Ⅱ": 2, "2": 2, "２": 2, III: 3, "Ⅲ": 3, "3": 3, "３": 3 }[mark] ?? null;
}

// 場の重賞スコア：G1 があれば3、G2 なら2、G3 なら1、重賞なしは0。
export function venueGradeScore(venue) {
  const levels = (venue?.races ?? []).map((race) => raceGradeLevel(race.title)).filter((level) => level !== null);
  return levels.length ? 4 - Math.min(...levels) : 0;
}

function hash(text) {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

// その日の無料公開場を1つ選ぶ。開催が無い日は null。
export function pickFreeVenue(venues, date, league) {
  const open = (venues ?? []).filter((venue) => venue?.eventId && venue.races?.length);
  if (!open.length) return null;
  const lowest = Math.min(...open.map(venueGradeScore));
  const candidates = open.filter((venue) => venueGradeScore(venue) === lowest)
    .sort((a, b) => String(a.eventId).localeCompare(String(b.eventId)));
  return candidates[hash(`${date}:${league}`) % candidates.length];
}

// raceId から中央・地方を判別する（中央は Yahoo の10桁、地方は日付入りの12桁）。
export function freeLeagueOf(raceId) {
  if (/^\d{8}(?:0[1-9]|1[0-2])$/.test(raceId)) return "jra";
  if (/^20\d{10}$/.test(raceId)) return "nar";
  return null;
}

export function venueHasRace(venue, raceId) {
  return !!venue?.races?.some((race) => race.raceId === raceId);
}

// 無料版の返答から有料の中身（参考買い目）を外す。
export function stripPaidAnalysis(body) {
  if (!body || typeof body !== "object") return body;
  const { tickets: _tickets, ...rest } = body;
  return { ...rest, tickets: [], free: true };
}
