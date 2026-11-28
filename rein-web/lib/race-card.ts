// Yahoo race-card row parsing. Yahoo writes geldings as 「せん」 (e.g. "せん5/鹿毛");
// the training data (JRA results) uses the same 「せん」 category, so it is kept as is.
const SEX_AGE = /(牡|牝|せん|セ)\s*(\d+)/;
const SCRATCH = /取消|除外/;
// Yahoo keeps a withdrawn runner on the card as e.g. "11(****)": popularity stays,
// the win odds are hidden. Active runners always show a number once sales open.
const HIDDEN_ODDS = /\(\s*\*{2,}\s*\)/;

export type CardCells = { html: string; cells: string[] };

export function isRunnerRow(row: CardCells) {
  if (!/^\d+$/.test(row.cells[1] || "")) return false;
  return SEX_AGE.test(row.cells.slice(2, 5).join(" ")) || /directory\/horse\/\d+/.test(row.html);
}

export function normalizeSex(value: string | undefined) {
  if (!value) return "";
  return value === "セ" ? "せん" : value;
}

export function parseSexAge(cells: string[]) {
  const match = cells[2]?.match(SEX_AGE) || cells.slice(2, 5).join(" ").match(SEX_AGE);
  return { sex: normalizeSex(match?.[1]), age: +(match?.[2] || 0) };
}

export function horseName(horseCell: string) {
  return (horseCell.match(/^([^ ]+)/)?.[1] || horseCell).replace(/(?:牝|牡|せん|セ)\d+.*$/, "");
}

export function isScratched(row: CardCells) {
  return SCRATCH.test(row.cells.slice(6).join(" ")) || SCRATCH.test(row.cells[2] || "");
}

// A race card may retain "****" odds without marking a withdrawal. The result
// page's status is authoritative. A DNF/disqualification still counts as a starter.
export function withdrawnResultNumbers(rows: CardCells[]) {
  return new Set(rows.filter(row => SCRATCH.test(row.cells[0] || "") && /^\d+$/.test(row.cells[2] || ""))
    .map(row => Number(row.cells[2])));
}

// Withdrawals announced on race day often reach the odds before the card. When the
// win market is open and every other runner has live odds, a runner whose odds are
// hidden ("****") or marked 取消/除外 in the odds table is out of the race. A partly
// read odds table never drops anyone: all remaining runners must have live odds.
export function marketWithdrawnNumbers(cardRows: CardCells[], liveOdds: Map<number, number>, oddsRows: CardCells[] = []) {
  const out = new Set<number>();
  if (liveOdds.size < 2) return out;
  const marked = new Set(oddsRows.filter(row => /^\d+$/.test(row.cells[1] || "") && SCRATCH.test(row.cells.slice(2).join(" ")))
    .map(row => Number(row.cells[1])));
  for (const row of cardRows) {
    const number = Number(row.cells[1]);
    if (liveOdds.has(number)) continue;
    if (marked.has(number) || HIDDEN_ODDS.test(row.cells[7] || "")) out.add(number);
  }
  const remaining = cardRows.filter(row => !out.has(Number(row.cells[1])));
  return remaining.length >= 2 && remaining.every(row => liveOdds.has(Number(row.cells[1]))) ? out : new Set<number>();
}
