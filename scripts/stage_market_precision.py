"""Stage market-only float64 aggregation parity; leave legacy role scoring untouched."""
from __future__ import annotations
import ast
from pathlib import Path

HELPERS = r'''

# MARKET_HISTORY_PRECISION_V1: match the frozen research accumulation order.
def _market_precision_cache(runtime):
    cached = getattr(runtime, "_market_precision_cache_v1", None)
    if cached is not None:
        return cached
    ordered = runtime.history.sort_values(
        ["horse_id", "race_date", "race_id", "horse_number"], kind="stable"
    ).reset_index(drop=True)
    horse_ids = ordered["horse_id"].astype(str).to_numpy()
    starts = np.r_[0, np.flatnonzero(horse_ids[1:] != horse_ids[:-1]) + 1]
    ends = np.r_[starts[1:], len(ordered)]
    bounds = {str(horse_ids[start]): (int(start), int(end)) for start, end in zip(starts, ends)} if len(ordered) else {}
    values = {column: pd.to_numeric(ordered[column], errors="coerce").to_numpy(float)
              for column in set(SIGNALS) | {"finish_position", "distance_m", "closing3f_relative",
                  "closing3f_z", "result_strength", "horse_weight", "weight_carried"}}
    values["form_surprise"] = (
        pd.to_numeric(ordered["past_popularity"], errors="coerce").to_numpy(float)
        - values["finish_position"]
    ) / pd.to_numeric(ordered["historical_field_size"], errors="coerce").to_numpy(float)
    prefix = {}
    for column, array in values.items():
        modes = (False, True) if column in ("form_surprise", "speed_relative") else (False,)
        for finite_only in modes:
            valid = np.isfinite(array) if finite_only else ~np.isnan(array)
            prefix[(column, finite_only)] = (
                np.r_[0., np.cumsum(np.where(valid, array, 0.))],
                np.r_[0, np.cumsum(valid)],
            )
    cached = {"bounds": bounds, "dates": ordered["race_date"].to_numpy(dtype="datetime64[ns]"), "prefix": prefix}
    runtime._market_precision_cache_v1 = cached
    return cached


def _align_market_history_precision(runtime, frame, race, runners):
    # Use an independent copy: first/second/third legacy suitability is not modified.
    frame = frame.copy()
    cached = _market_precision_cache(runtime)
    cutoff = np.datetime64(pd.Timestamp(race["race_date"]), "ns")
    normalized_ids = [str(runner.get("horse_id", "0")).lstrip("0") or "0" for runner in runners]
    ranges = []
    for horse_id in normalized_ids:
        start, end = cached["bounds"].get(horse_id, (0, 0))
        stop = start + int(np.searchsorted(cached["dates"][start:end], cutoff, side="left"))
        ranges.append((start, stop))
    def mean(column, window, finite_only=False):
        total, count = cached["prefix"][(column, finite_only)]
        result = []
        for start, stop in ranges:
            left = max(start, stop-window)
            denominator = count[stop]-count[left]
            result.append((total[stop]-total[left])/denominator if denominator else np.nan)
        return np.asarray(result, float)
    for signal in SIGNALS:
        frame["recent3_" + signal] = mean(signal, 3)
    frame["horse_recent5_avg_finish"] = mean("finish_position", 5)
    frame["horse_recent5_win_rate"] = mean("won", 5)
    frame["horse_recent5_top3_rate"] = mean("placed", 5)
    frame["recent3_distance_m"] = mean("distance_m", 3)
    frame["distance_vs_recent3"] = frame["distance_m"]-frame["recent3_distance_m"]
    for signal in ("closing3f_relative", "closing3f_z"):
        for window in (3, 5):
            frame[f"recent{window}_{signal}"] = mean(signal, window)
    frame["recent3_result_strength"] = mean("result_strength", 3)
    for window in (3, 5, 10):
        frame[f"form_surprise_last{window}"] = mean("form_surprise", window, True)
        frame[f"form_speed_last{window}"] = mean("speed_relative", window, True)
    frame["form_speed_trend"] = frame["form_speed_last3"]-frame["form_speed_last10"]
    frame["form_surprise_trend"] = frame["form_surprise_last3"]-frame["form_surprise_last10"]
    frame["body_weight_vs_recent3"] = frame["horse_weight"]-mean("horse_weight", 3)
    frame["body_load_change"] = frame["weight_carried"]-mean("weight_carried", 1)
    frame["closing_pressure_fit"] = -frame["recent3_closing3f_z"]*frame["front_pressure_share"]
    order = np.argsort(np.asarray(normalized_ids, dtype=str), kind="stable")
    groups = np.zeros(len(frame), dtype=np.int8)
    def grouped(column, operation):
        series = frame.iloc[order][column]
        return series.groupby(groups, observed=True, sort=False).transform(operation).reindex(frame.index)
    for column in ("recent3_speed_relative", "recent3_closing3f_z", "horse_win_rate", "horse_top3_rate",
                   "horse_recent5_avg_finish", "recent3_result_strength"):
        frame[column + "_field_rank"] = frame[column].rank(pct=True)
        frame[column + "_field_gap"] = frame[column]-grouped(column, "mean")
    for prefix in ("early", "late"):
        column = "prior_" + prefix + "_pct"
        frame["relative_" + prefix] = frame[column]-grouped(column, "mean")
    for column in ("weight_carried", "horse_weight"):
        frame[column + "_vs_field"] = frame[column]-grouped(column, "mean")
    frame["field_speed_std"] = grouped("recent3_speed_relative", "std")
    frame["market_share"] = frame["market_inv_rank"]/grouped("market_inv_rank", "sum")
    favorite = min(range(len(runners)), key=lambda i: (float(runners[i].get("popularity") or np.inf), int(runners[i]["horse_number"])))
    favorite_index = frame.index[favorite]
    for column in ("recent3_speed_relative", "recent3_closing3f_z", "horse_top3_rate", "prior_early_pct"):
        frame["matchup_" + column] = frame[column]-frame.loc[favorite_index, column]
    month = pd.Timestamp(race["race_date"]).month
    frame["month_sin"] = np.sin(month*2*np.pi/12)
    frame["month_cos"] = np.cos(month*2*np.pi/12)
    return frame
'''


def stage_precision():
    path = Path('rein-web/api/rein_core.py')
    source = path.read_text()
    if '# MARKET_HISTORY_PRECISION_V1:' in source:
        assert HELPERS in source, 'Different precision implementation already exists'
        assert source.count('frame = _align_market_history_precision(self, frame, race, runners)') == 1
        return
    parsed = ast.parse(source)
    cls, = [node for node in parsed.body if isinstance(node, ast.ClassDef) and node.name == 'ReinRuntime']
    method, = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == '_market_feature_frame']
    lines = source.splitlines(keepends=True)
    before = ''.join(lines[:method.lineno-1])
    segment = ''.join(lines[method.lineno-1:method.end_lineno])
    after = ''.join(lines[method.end_lineno:])
    marker = '        for column in CATEGORICAL:\n'
    index = segment.rfind(marker)
    assert index > 0 and 'return frame[columns]' in segment[index:]
    segment = segment[:index] + '        frame = _align_market_history_precision(self, frame, race, runners)\n' + segment[index:]
    source = before + segment + after + HELPERS
    compile(source, str(path), 'exec')
    path.write_text(source)
    print('Staged market-only cumulative aggregation alignment; legacy model scoring unchanged')


if __name__ == '__main__':
    stage_precision()
