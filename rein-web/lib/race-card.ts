// Yahoo race-card row parsing. Yahoo writes geldings as 「せん」 (e.g. "せん5/鹿毛");
// the training data (JRA results) uses the same 「せん」 category, so it is kept as is.
const SEX_AGE = /(牡|牝|せん|セ)\s*(\d+)/;
const SCRATCH = /取消|除外|競走中止/;

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
