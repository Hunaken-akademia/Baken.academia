/** Facts from the previous-run column, independent of any ranking model. */
export type PreviousRun = {
  date: string; venue?: string; surface?: string; distanceM?: number; going?: string;
  jockey?: string; weightCarried?: number; bodyWeight?: number;
  finish?: number; result?: string; fieldSize?: number; raceName?: string; passing?: string;
};
export type PreviousRunner = { number: number; horseId: string; name: string; previous: PreviousRun | null };
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const tagged = (s: string, tag: string, cls: string) => [...s.matchAll(new RegExp(`<${tag}\\b[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map(m => m[1]);
const table = (s: string, id: string) => s.match(new RegExp(`<table\\b[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/table>`, "i"))?.[1] ?? "";
const rows = (s: string) => [...s.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]).filter(s => /<td\b/i.test(s));
const number = (s: string | undefined, min: number, max: number) => s && Number.isFinite(Number(s)) && Number(s) >= min && Number(s) <= max ? Number(s) : undefined;
const id = (s: string) => s.replace(/^0+/, "") || "0";
export function beforeRaceDate(date: string, raceDate: string) {
  return /^20\d{2}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date && date < raceDate;
}
export function daysBetween(previous: string, current: string) {
  return beforeRaceDate(previous, current) && Number.isFinite(Date.parse(current)) ? Math.round((Date.parse(current) - Date.parse(previous)) / 86400000) : null;
}

export function parseJraPreviousRuns(html: string, raceDate: string): PreviousRunner[] {
  // Both tables contain one row per declared horse, including empty history rows.
  // Never filter by passing-order availability before joining them.
  const names = rows(table(html, "denma_latest")), history = rows(table(html, "denma_past"));
  if (!names.length || names.length !== history.length) return [];
  const runners = names.map((row, index) => {
    const horse = row.match(/directory\/horse\/(\d+)\/[^>]*>([\s\S]*?)<\/a>/i);
    const runner: PreviousRunner = { number: Number(text(tagged(row, "p", "hr-denma__number")[0] ?? "")), horseId: id(horse?.[1] ?? ""), name: text(horse?.[2] ?? ""), previous: null };
    const cell = tagged(history[index], "td", "hr-tableScroll__data--race")[0] ?? "";
    const dates = tagged(cell, "p", "hr-denma__date").map(text);
    const match = dates[0]?.match(/(20\d{2})\/(\d{2})\/(\d{2})\s+(.+)/);
    if (!match) return runner;
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    if (!beforeRaceDate(date, raceDate)) return runner;
    const conditions = dates[1] ?? "", jockey = tagged(cell, "p", "hr-denma__jockey")[0] ?? "";
    const result = text(tagged(cell, "span", "hr-denma__arrival")[0] ?? "");
    runner.previous = {
      date, venue: match[4], surface: conditions.match(/^(芝|ダート|障害)/)?.[1],
      distanceM: number(conditions.match(/(\d{3,4})m/)?.[1], 100, 6000), going: conditions.match(/(不良|稍重|良|重)\s*$/)?.[1],
      jockey: text(jockey.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "") || undefined,
      weightCarried: number(text(jockey).match(/\(([\d.]+)\)/)?.[1], 40, 1000),
      bodyWeight: number(text(tagged(cell, "span", "hr-denma__horseWeight")[0] ?? "").match(/^(\d+)/)?.[1], 200, 1500),
      finish: number(result, 1, 30), result: result || undefined, fieldSize: number(text(cell).match(/(\d+)頭/)?.[1], 1, 30),
      raceName: text(cell.match(/race\/index\/\d+[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "") || undefined,
      passing: text(tagged(cell, "p", "hr-denma__passing")[0] ?? "") || undefined,
    };
    return runner;
  });
  return runners.every(r => r.number > 0 && r.horseId !== "0" && r.name) && new Set(runners.map(r => r.number)).size === runners.length ? runners : [];
}

export function parseNarPreviousRuns(html: string, raceDate: string): PreviousRunner[] {
  const section = html.match(/<section\b[^>]*class=["'][^"']*\bcardTable\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/i)?.[1] ?? "";
  return section.split(/<tr\s+class=["']tBorder["'][^>]*>/i).slice(1).map(block => {
    const runner: PreviousRunner = { number: Number(text(tagged(block, "td", "horseNum")[0] ?? "")), horseId: id(block.match(/k_lineageLoginCode=(\d+)/)?.[1] ?? ""), name: text(tagged(block, "a", "horseName")[0] ?? ""), previous: null };
    const info = tagged(block, "div", "raceInfo")[0] ?? "", clean = text(info);
    const dateMatch = clean.match(/(?:^|\s)(\d{2})\.(\d{2})\.(\d{2})(?:\s|$)/);
    if (!dateMatch) return runner;
    const date = `20${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    if (!beforeRaceDate(date, raceDate)) return runner;
    // The first entry in each of the five-column rows corresponds to the same run.
    // Anchor to the full personnel row; never skip an empty first column.
    const personnelRow = block.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?TrainerMark(?:(?!<\/tr>)[\s\S])*?<\/tr>/i)?.[0] ?? "";
    const cells = [...personnelRow.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => text(m[1]));
    const personnel = cells[3]?.match(/^(?:\d+人\s+)?(\d+|－|-)\s+(.+?)\s+([\d.]+)$/);
    const result = text(tagged(info, "span", "pastRank")[0] ?? "");
    const course = clean.match(/頭\s+(.+?)\s+(芝)?(右|左|直)\s*(\d{3,4})/);
    const venue = course?.[1]?.replace(/^[ＪJ]/, "");
    // NAR represents dirt with direction only; turf is explicitly prefixed 芝.
    const surface = venue === "帯広" ? "ばんえい" : course ? course[2] ? "芝" : "ダート" : undefined;
    runner.previous = { date, venue, surface, distanceM: number(course?.[4], 100, 6000),
      going: clean.match(/\d{2}\.\d{2}\.\d{2}\s+(不良|稍重|良|重)/)?.[1],
      finish: number(result, 1, 30), result: result || undefined, fieldSize: number(clean.match(/(\d+)頭/)?.[1], 1, 30),
      bodyWeight: number(personnel?.[1], 200, 1500), jockey: personnel?.[2], weightCarried: number(personnel?.[3], 40, 1000),
    };
    return runner;
  }).filter(r => r.number > 0 && r.horseId !== "0" && r.name);
}

export function matchPreviousRuns(parsed: PreviousRunner[], horses: Array<{ number: number; horseId?: string; name: string }>) {
  return Object.fromEntries(horses.map(h => {
    const matches = parsed.filter(p => p.number === h.number && (h.horseId && id(h.horseId) !== "0" ? p.horseId === id(h.horseId) : p.name.replace(/\s/g, "") === h.name.replace(/\s/g, "")));
    return [h.number, matches.length === 1 ? matches[0].previous : null];
  }));
}
