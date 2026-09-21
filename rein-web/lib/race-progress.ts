type Race = { number: number; start: string; status: string };
export function raceProgress<T extends Race>(races: T[], now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const minute = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const future = races.filter(race => {
    const match = race.start.match(/^(\d{1,2}):(\d{2})$/);
    return match && +match[1] * 60 + +match[2] > minute && race.status !== "確定";
  }).sort((a, b) => a.number - b.number);
  const next = future[0];
  return {
    nextRace: next?.number ?? 13,
    nextStart: next?.start ?? "--:--",
    races: races.map(race => ({ ...race, status: race.status === "確定" ? "確定"
      : race.number === next?.number ? "次レース"
      : future.includes(race) ? "発売前" : "発走時刻経過" })),
  };
}
