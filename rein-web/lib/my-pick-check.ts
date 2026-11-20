// 自分の予想チェック（2026-11-20 オーナー依頼。WAKE の「自分の予想チェック」を競馬向けにしたもの）。
// 会員が買いたい馬を選ぶと、REIN のデータから「見落とし」「気になる点」を先に出し、そのあとに当たる見込みを出す。買い目は出さない。
// 見込み：参考買い目と同じ「人気70%＋着順別REIN30%」から3着までの並びの確率を作り、過去の結果に合わせて補正したもの。
//   補正：並びの確率を1.4乗して合計1に戻す（2026/10/1〜10/20の発走前保存で決め、10/21〜11/20で確認：
//   1着見込み 7%→実際7.1%、14%→14.6%、23%→23.8%。補正なしだと上位の組が実際の半分ほどに出ていた）。
import { roleProbabilities, type TicketHorse } from "./tickets";

export const CALIBRATION_POWER = 1.4;
export const MAX_PICK = 8;

export type PickHorse = {
  number: number; gate?: number; popularity: number; odds: number | null; reinScore?: number; marketScore?: number;
  firstProbability?: number; secondProbability?: number; thirdProbability?: number;
  name: string;
  cautions?: string[];
  historyFactors?: Array<{ label: string; samples: number; top3Rate?: number }>;
  weightChange?: number;
};
export type PickMarks = { main?: number | null; rival?: number | null; longshot?: number | null };
export type HorseChance = { number: number; win: number; top3: number; winRank: number; top3Rank: number };
export type Chances = { horses: Map<number, HorseChance>; trio: (picked: Set<number>) => number; quinella: (picked: Set<number>) => number; wide: (picked: Set<number>) => number; win: (picked: Set<number>) => number };

// 出走馬（取消を除く、オッズと人気がそろった馬）の3着までの並びの確率から、各馬・各券種の見込みを作る。
export function pickChances(source: PickHorse[]): Chances | null {
  const horses = source.filter(h => typeof h.odds === "number" && h.odds > 0 && h.popularity > 0);
  if (horses.length < 3) return null;
  const roles = roleProbabilities(horses.map((h): TicketHorse => ({ ...h, gate: h.gate ?? 0, reinScore: h.reinScore ?? 0, marketScore: h.marketScore ?? 0 })));
  const orders: Array<[number, number, number, number]> = [];
  let total = 0;
  for (const a of roles) for (const b of roles) {
    if (a.number === b.number) continue;
    const ab = a.first * b.second / Math.max(1 - a.second, 1e-12);
    for (const c of roles) {
      if (c.number === a.number || c.number === b.number) continue;
      const q = Math.pow(ab * c.third / Math.max(1 - a.third - b.third, 1e-12), CALIBRATION_POWER);
      orders.push([a.number, b.number, c.number, q]); total += q;
    }
  }
  if (!(total > 0)) return null;
  const win = new Map<number, number>(), top3 = new Map<number, number>();
  for (const o of orders) {
    o[3] /= total;
    win.set(o[0], (win.get(o[0]) ?? 0) + o[3]);
    for (const n of o.slice(0, 3)) top3.set(n, (top3.get(n) ?? 0) + o[3]);
  }
  const rank = (m: Map<number, number>) => new Map([...m].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([n], i) => [n, i + 1]));
  const wr = rank(win), tr = rank(top3);
  const map = new Map(horses.map(h => [h.number, { number: h.number, win: win.get(h.number) ?? 0, top3: top3.get(h.number) ?? 0, winRank: wr.get(h.number) ?? horses.length, top3Rank: tr.get(h.number) ?? horses.length }]));
  const sum = (ok: (o: [number, number, number, number], s: Set<number>) => boolean) => (s: Set<number>) => orders.reduce((t, o) => ok(o, s) ? t + o[3] : t, 0);
  return {
    horses: map,
    trio: sum((o, s) => s.has(o[0]) && s.has(o[1]) && s.has(o[2])),
    quinella: sum((o, s) => s.has(o[0]) && s.has(o[1])),
    wide: sum((o, s) => [s.has(o[0]), s.has(o[1]), s.has(o[2])].filter(Boolean).length >= 2),
    win: sum((o, s) => s.has(o[0])),
  };
}

export type PickNote = { kind: "miss" | "warn" | "good" | "info"; number: number | null; text: string };
const pct = (v: number) => `${Math.round(v * 100)}%`;
const comb = (n: number, k: number) => k === 2 ? n * (n - 1) / 2 : n * (n - 1) * (n - 2) / 6;

// 返り値：見落とし（miss）を先頭に、気になる点（warn）、良い点（good）の順。最大7つ。
export function checkPick(horses: PickHorse[], selected: number[], marks: PickMarks = {}, scratched: number[] = []): { notes: PickNote[]; chances: { label: string; points: number; value: number }[] } {
  const picked = new Set(selected), out = new Set(scratched);
  const chances = pickChances(horses.filter(h => !out.has(h.number)));
  if (!picked.size || !chances) return { notes: [], chances: [] };
  const byNumber = new Map(horses.map(h => [h.number, h]));
  const live = [...chances.horses.values()], n = live.length;
  const name = (num: number) => `${num}番${byNumber.get(num)?.name ? ` ${byNumber.get(num)?.name}` : ""}`;
  const miss: PickNote[] = [], warn: PickNote[] = [], good: PickNote[] = [];

  for (const num of picked) if (out.has(num)) warn.push({ kind: "warn", number: num, text: `${name(num)}は出走取消です` });

  // 見落とし：選んでいない馬で、3着内の見込みが上位3頭に入る馬・REIN の本命/対抗/穴候補
  const missing = live.filter(h => !picked.has(h.number));
  for (const h of missing.filter(h => h.top3Rank <= 3).sort((a, b) => a.top3Rank - b.top3Rank))
    miss.push({ kind: "miss", number: h.number, text: `見落とし：${name(h.number)}は3着内の見込み${pct(h.top3)}（${n}頭中${h.top3Rank}番目）ですが、入っていません` });
  for (const [key, label] of [["main", "本命"], ["rival", "対抗"], ["longshot", "穴候補"]] as const) {
    const num = marks[key];
    if (num == null || picked.has(num) || out.has(num) || miss.some(m => m.number === num)) continue;
    const h = chances.horses.get(num);
    if (h) miss.push({ kind: "miss", number: num, text: `見落とし：REINの${label}の${name(num)}が入っていません（3着内の見込み${pct(h.top3)}、${byNumber.get(num)?.popularity}番人気）` });
  }
  // 足すと3連複の見込みが一番上がる馬（3頭以上選んだとき）
  if (picked.size >= 3 && picked.size < MAX_PICK) {
    const base = chances.trio(picked);
    const best = missing.map(h => ({ h, gain: chances.trio(new Set([...picked, h.number])) - base })).sort((a, b) => b.gain - a.gain)[0];
    if (best && best.gain >= 0.03) miss.push({ kind: "miss", number: best.h.number, text: `こちらも見落としていませんか：${name(best.h.number)}を足すと、3連複ボックスの見込みが${pct(base)}→${pct(base + best.gain)}になります` });
  }

  // 気になる点：選んだ馬の見込みが低い、成績・馬体重の注意
  for (const num of picked) {
    const h = chances.horses.get(num), horse = byNumber.get(num);
    if (!h || !horse) continue;
    if (h.top3Rank > Math.max(5, Math.ceil(n * 0.6)) && h.top3 < 0.15) warn.push({ kind: "warn", number: num, text: `${name(num)}は3着内の見込み${pct(h.top3)}（${n}頭中${h.top3Rank}番目）です` });
    const weak = (horse.historyFactors ?? []).find(f => ["距離適性", "芝ダ適性", "競馬場適性"].includes(f.label) && f.samples >= 3 && typeof f.top3Rate === "number" && f.top3Rate < 15);
    if (weak) warn.push({ kind: "warn", number: num, text: `${name(num)}は${weak.label.replace("適性", "")}の成績が${weak.samples}走で3着内${Math.round(weak.top3Rate as number)}%です` });
    if (typeof horse.weightChange === "number" && Math.abs(horse.weightChange) >= 10) warn.push({ kind: "warn", number: num, text: `${name(num)}は馬体重が${horse.weightChange > 0 ? "+" : ""}${horse.weightChange}kgです` });
    else if (horse.cautions?.[0]) warn.push({ kind: "warn", number: num, text: `${name(num)}：${horse.cautions[0]}` });
    if (h.winRank === 1) good.push({ kind: "good", number: num, text: `${name(num)}は1着の見込み${pct(h.win)}で、${n}頭の中でいちばん高いです` });
  }

  const k = [...picked].filter(num => !out.has(num)).length;
  const list = [
    { label: "単勝（選んだ馬のどれかが1着）", points: k, value: chances.win(picked) },
    ...(k >= 2 ? [{ label: "ワイド ボックス", points: comb(k, 2), value: chances.wide(picked) }, { label: "馬連 ボックス", points: comb(k, 2), value: chances.quinella(picked) }] : []),
    ...(k >= 3 ? [{ label: "3連複 ボックス", points: comb(k, 3), value: chances.trio(picked) }] : []),
  ];
  return { notes: [...miss, ...warn, ...good].slice(0, 7), chances: list };
}
