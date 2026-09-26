// User-facing Japanese labels for model features. Every label was written from the
// feature's definition in api/rein_core.py (ReinRuntime._feature_frame_full and
// _market_feature_frame). Internal names are never shown: an unknown feature falls
// back to OTHER_FEATURE_LABEL instead of its variable name.

export const OTHER_FEATURE_LABEL = "その他の評価要因";

const SIGNAL_LABELS: Record<string, string> = {
  // distance / finish_time (m/s)
  speed: "走破速度",
  // speed minus the median speed of the same race
  speed_relative: "走破速度（同レースの中央値との差）",
  // first corner position / field size
  early_pct: "序盤の位置取り（最初のコーナー通過順÷頭数）",
  // last corner position / field size
  late_pct: "終盤の位置取り（最後のコーナー通過順÷頭数）",
  // late_pct - finish / field size
  position_gain: "最後のコーナーからの着順の押し上げ",
  // finish position / field size (smaller is better)
  finish_pct: "着順（着順÷出走頭数）",
  // sum of the race's first three lap times
  race_first3_laps: "レース序盤3ハロンのラップ合計",
  // popularity rank in that past race
  past_popularity: "人気順位",
  won: "1着になったか",
  placed: "3着以内に入ったか",
};

const RATE_SCOPES: Record<string, string> = {
  horse: "通算",
  jockey: "騎手の過去",
  trainer: "厩舎の過去",
  horse_surface: "同じ馬場種別（芝・ダート・障害）での",
  horse_distance: "同じ距離帯（200m刻み）での",
  horse_course: "同じ競馬場での",
};

const RATE_METRICS: Record<string, string> = {
  starts: "出走数",
  // (wins + 1.5) / (starts + 20)
  win_rate: "勝率（少数補正あり）",
  // (top3 + 4.5) / (starts + 20)
  top3_rate: "3着内率（少数補正あり）",
  avg_finish: "平均着順",
};

const FIELD_BASE_LABELS: Record<string, string> = {
  recent3_speed_relative: "近3走の走破速度（同レース中央値との差）",
  recent3_closing3f_z: "近3走の上がり（同レース内の標準化値）",
  horse_win_rate: "通算勝率",
  horse_top3_rate: "通算3着内率",
  horse_recent5_avg_finish: "近5走の平均着順",
  recent3_result_strength: "近3走の成績指数（着順とクラスから算出）",
};

const FIT_LABELS: Record<string, string> = {
  fit_surface: "同じ馬場種別での該当着順率",
  fit_distance: "同じ距離帯での該当着順率",
  fit_course: "同じ競馬場での該当着順率",
  fit_wet: "同じ馬場区分（重・不良か否か）での該当着順率",
  gate_course_bias: "同じ競馬場・馬場種別・距離帯・枠番の過去傾向",
  pace_course_style: "同じ競馬場・馬場種別での同脚質の過去傾向",
};

const FIXED: Record<string, string> = {
  racecourse: "競馬場",
  surface: "馬場種別（芝・ダート・障害）",
  distance_m: "距離",
  horse_number: "馬番",
  gate: "枠番",
  age: "馬齢",
  sex: "性別",
  weight_carried: "斤量",
  going: "馬場状態",
  race_class: "クラス",
  // Categorical IDs: the model learned an effect for the ID, not an ability rating.
  jockey_id: "騎手に関する評価",
  trainer_id: "厩舎に関する評価",
  horse_weight: "馬体重",
  horse_weight_change: "馬体重の増減",
  field_size: "出走頭数",
  horse_number_pct: "馬番の位置（馬番÷頭数）",
  gate_pct: "枠番の位置（枠番÷最大枠番）",
  weight_carried_vs_field: "斤量（出走馬平均との差）",
  horse_weight_vs_field: "馬体重（出走馬平均との差）",
  horse_wet_prior_starts: "同じ馬場区分（重・不良か否か）での出走数",
  horse_wet_prior_top3_rate: "同じ馬場区分（重・不良か否か）での3着内率（少数補正あり）",
  days_since_last_start: "前走からの間隔",
  distance_change_m: "前走からの距離変化",
  same_surface_as_last: "前走と同じ馬場種別か",
  same_course_as_last: "前走と同じ競馬場か",
  horse_recent5_avg_finish: "近5走の平均着順",
  horse_recent5_win_rate: "近5走の勝率",
  horse_recent5_top3_rate: "近5走の3着内率",
  jockey_id_recent90_win: "騎手の直近90日の勝率（少数補正あり）",
  jockey_id_recent90_place: "騎手の直近90日の3着内率（少数補正あり）",
  trainer_id_recent90_win: "厩舎の直近90日の勝率（少数補正あり）",
  trainer_id_recent90_place: "厩舎の直近90日の3着内率（少数補正あり）",
  class_tier: "今回のクラス",
  prior_class_tier: "前走のクラス",
  class_change: "前走からのクラス変化",
  class_rise: "昇級の幅",
  class_drop: "降級の幅",
  recent5_max_class: "近5走で出走した最高クラス",
  class_vs_recent_max: "今回と近5走最高クラスの差",
  prior_distance_m: "前走の距離",
  recent3_distance_m: "近3走の平均距離",
  distance_abs_change: "前走との距離差",
  stretching_out: "距離延長の幅",
  shortening: "距離短縮の幅",
  distance_vs_recent3: "近3走平均距離との差",
  prior_closing3f_relative: "前走の上がり（同レース中央値との差）",
  recent3_closing3f_relative: "近3走の上がり（同レース中央値との差）",
  recent5_closing3f_relative: "近5走の上がり（同レース中央値との差）",
  prior_closing3f_z: "前走の上がり（同レース内の標準化値）",
  recent3_closing3f_z: "近3走の上がり（同レース内の標準化値）",
  recent5_closing3f_z: "近5走の上がり（同レース内の標準化値）",
  recent3_result_strength: "近3走の成績指数（着順とクラスから算出）",
  expected_front_count: "前走で前方にいた馬の頭数",
  relative_early: "前走序盤の位置取り（出走馬平均との差）",
  relative_late: "前走終盤の位置取り（出走馬平均との差）",
  front_style: "前走で前方（先行）",
  stalk_style: "前走で中団",
  closer_style: "前走で後方",
  front_pressure_count: "先行した馬の頭数",
  front_pressure_share: "先行した馬の割合",
  known_style_share: "脚質を判定できた馬の割合",
  front_under_pressure: "先行脚質と先行争いの組み合わせ",
  closer_pressure_help: "後方脚質と先行争いの組み合わせ",
  closing_pressure_fit: "上がりと先行争いの組み合わせ",
  form_speed_trend: "走破速度の変化（近3走と近10走の差）",
  form_surprise_trend: "人気以上の着順の変化（近3走と近10走の差）",
  body_change_abs: "馬体重の増減幅",
  body_change_pct: "馬体重の増減率",
  body_load_ratio: "斤量÷馬体重",
  body_weight_vs_recent3: "馬体重（近3走平均との差）",
  body_load_change: "前走からの斤量変化",
  month_sin: "開催時期",
  month_cos: "開催時期",
  history_coverage: "過去データのある出走馬の割合",
  field_speed_std: "出走馬の走破速度のばらつき",
  market_rank: "今回の人気順位",
  market_logrank: "今回の人気順位",
  market_inv_rank: "今回の人気順位",
  market_share: "今回の人気順位（出走馬内の比率）",
  market_rank_fraction: "今回の人気順位（頭数比）",
  market_field_size: "出走頭数",
  odds_log_win: "今回の単勝オッズ",
  odds_win_share: "単勝オッズから見た支持率",
  odds_favorite_share: "1番人気の支持率",
  odds_entropy: "単勝オッズの分散度",
  odds_concentration: "単勝オッズの集中度",
  odds_relative_to_favorite: "1番人気との支持率の差",
  odds_log_rank: "単勝オッズの順位",
};

function historyExact(feature: string) {
  const match = feature.match(/^history_exact_([123])_last(5|10)$/);
  return match ? `近${match[2]}走で${match[1]}着だった割合` : null;
}

function priorSignal(feature: string) {
  const match = feature.match(/^(prior|recent3)_(.+)$/);
  if (!match) return null;
  const signal = SIGNAL_LABELS[match[2]];
  if (!signal) return null;
  return match[1] === "prior" ? `前走の${signal}` : `近3走平均の${signal}`;
}

function rate(feature: string) {
  for (const scope of Object.keys(RATE_SCOPES).sort((a, b) => b.length - a.length)) {
    if (!feature.startsWith(scope + "_")) continue;
    const metric = RATE_METRICS[feature.slice(scope.length + 1)];
    if (metric) return `${RATE_SCOPES[scope]}${metric}`;
  }
  return null;
}

function field(feature: string) {
  const match = feature.match(/^(.+)_field_(rank|gap)$/);
  if (!match || !FIELD_BASE_LABELS[match[1]]) return null;
  const base = FIELD_BASE_LABELS[match[1]].replace(/（.*）$/, "");
  return `${base}（${match[2] === "rank" ? "出走馬内の順位" : "出走馬平均との差"}）`;
}

function form(feature: string) {
  const match = feature.match(/^form_(surprise|speed)_last(3|5|10)$/);
  if (!match) return null;
  return match[1] === "surprise"
    ? `近${match[2]}走で人気より上の着順だった度合い`
    : `近${match[2]}走の走破速度（同レース中央値との差）`;
}

function fit(feature: string) {
  const match = feature.match(/^(.+)_(starts|rate)$/);
  if (!match || !FIT_LABELS[match[1]]) return null;
  return match[2] === "rate" ? FIT_LABELS[match[1]] : FIT_LABELS[match[1]].replace(/での該当着順率$|の過去傾向$/, "") + "の過去件数";
}

function matchup(feature: string) {
  const match = feature.match(/^matchup_(.+)$/);
  if (!match) return null;
  const base = FIXED[match[1]] || FIELD_BASE_LABELS[match[1]] || priorSignal(match[1]);
  return base ? `1番人気馬との差：${base}` : null;
}

export function featureLabel(feature: string): string {
  return (
    FIXED[feature] ||
    historyExact(feature) ||
    field(feature) ||
    priorSignal(feature) ||
    rate(feature) ||
    form(feature) ||
    fit(feature) ||
    matchup(feature) ||
    OTHER_FEATURE_LABEL
  );
}

export type RoleReason = { feature: string; contribution: number };
export type ReasonView = { label: string; direction: "up" | "down" };

// Direction means the effect on this model's evaluation (SHAP contribution sign), not
// whether the feature value is large. Duplicate labels (e.g. several unknown features)
// are merged so the list never repeats the same text.
export function reasonViews(reasons: RoleReason[] | undefined, limit = 4): ReasonView[] {
  const output: ReasonView[] = [];
  const seen = new Set<string>();
  for (const item of reasons ?? []) {
    if (!Number.isFinite(item.contribution) || item.contribution === 0) continue;
    const label = featureLabel(item.feature);
    const direction = item.contribution > 0 ? "up" : "down";
    const key = `${label}:${direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ label, direction });
    if (output.length >= limit) break;
  }
  return output;
}
