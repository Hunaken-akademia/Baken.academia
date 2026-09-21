export function parseMarket(value: string) {
  const match = value.match(/^\s*(\d+)\s*\(\s*(\d+(?:\.\d+)?)\s*\)\s*$/);
  if (!match) return null;
  const popularity = Number(match[1]);
  const odds = Number(match[2]);
  return popularity >= 1 && popularity <= 18 && Number.isFinite(odds) && odds >= 1
    ? { popularity, odds } : null;
}

export function parsePopularity(value: string) {
  const match = value.match(/^\s*(\d+)\s*\(/);
  const rank = match ? Number(match[1]) : 0;
  return rank >= 1 && rank <= 18 ? rank : null;
}
