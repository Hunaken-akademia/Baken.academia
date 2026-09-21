export type RacePayout = {
  type: string;
  selection: string;
  payout: number;
  popularity: number | null;
};

const LABELS: Array<[string, number, boolean]> = [
  ["単勝", 1, false],
  ["複勝", 1, false],
  ["枠連", 2, false],
  ["馬連", 2, false],
  ["ワイド", 2, false],
  ["馬単", 2, true],
  ["3連複", 3, false],
  ["三連複", 3, false],
  ["3連単", 3, true],
  ["三連単", 3, true],
];

const text = (value: string) => value
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, " ")
  .trim();

function selections(value: string, arity: number): number[][] {
  const clean = value.replace(/[－–—]/g, "-").replace(/[→＞>]/g, "-");
  if (arity === 1) {
    return [...clean.matchAll(/(?<!\d)(\d{1,2})(?!\d)/g)].map((match) => [+match[1]]);
  }
  const pattern = arity === 2
    ? /(\d{1,2})\s*-\s*(\d{1,2})/g
    : /(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})/g;
  return [...clean.matchAll(pattern)].map((match) => match.slice(1).map(Number));
}

export function parsePayouts(html: string): RacePayout[] {
  const payouts: RacePayout[] = [];
  const seen = new Set<string>();
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => text(cell[1]));
    if (cells.length < 2) continue;
    const labelIndex = cells.findIndex((cell) => LABELS.some(([label]) => cell === label));
    if (labelIndex < 0) continue;
    const definition = LABELS.find(([label]) => label === cells[labelIndex]);
    if (!definition) continue;
    const [label, arity, ordered] = definition;
    const values = cells.slice(labelIndex + 1);
    const selectionValues = values
      .filter((value) => !/円|人気/.test(value))
      .flatMap((value) => selections(value, arity))
      .filter((items) => items.every((item) => item >= 1 && item <= 18));
    const payoutValues = values.flatMap((value) =>
      [...value.matchAll(/([\d,]+)\s*円/g)].map((match) => +match[1].replace(/,/g, ""))
    );
    const popularityValues = values.flatMap((value) =>
      [...value.matchAll(/(\d+)\s*番?人気/g)].map((match) => +match[1])
    );
    for (let index = 0; index < Math.min(selectionValues.length, payoutValues.length); index++) {
      const selection = selectionValues[index].join(ordered ? "→" : "-");
      const key = `${label}:${selection}:${payoutValues[index]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      payouts.push({
        type: label.replace("三連", "3連"),
        selection,
        payout: payoutValues[index],
        popularity: popularityValues[index] ?? null,
      });
    }
  }
  return payouts;
}
