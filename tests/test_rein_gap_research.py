import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import rein_gap_research as g  # noqa: E402


def synthetic(races=400, field=10, seed=1):
    rng = np.random.default_rng(seed)
    rows = []
    for r in range(races):
        date = pd.Timestamp("2021-01-03") + pd.Timedelta(days=int(r * 3.5))
        odds = np.sort(rng.uniform(1.5, 120, field))
        winner = rng.integers(0, field)
        order = rng.permutation(field)
        for i in range(field):
            rows.append({"race_id": f"R{r}", "race_date": date, "horse_number": i + 1, "win_odds": odds[i],
                         "popularity": i + 1, "finish_position": int(np.where(order == i)[0][0]) + 1,
                         "p_role": rng.random(), "p_market": rng.random(), "p_rein": rng.random()})
    e = pd.DataFrame(rows)
    for c in ("p_role", "p_market", "p_rein"):
        e[c] = e[c] / e.groupby("race_id")[c].transform("sum")
    return e


def test_market_features_are_normalised():
    e = g.add_market_features(synthetic(5))
    assert np.allclose(e.groupby("race_id")["implied"].sum(), 1)
    assert e["odds_rank"].min() == 1


def test_selections_and_baseline():
    e = synthetic()
    r = g.evaluate(e)
    s = r["selections"]
    assert s["全馬"]["horses"] == len(e)
    # Excess over the same-odds-band baseline is zero for all horses by construction.
    assert abs(s["全馬"]["x_win"]["mean"]) < 1e-9
    assert abs(s["全馬"]["x_top3"]["mean"]) < 1e-9
    one = s["穴候補（本番と同じ決め方・1頭）"]
    allc = s["穴候補（条件に合う全頭）"]
    assert one["horses"] <= allc["horses"]
    assert one["per_race"] <= 1
    assert len(r["ratio_deciles_popularity4plus"]) == 10
    assert "| 全馬 |" in g.summary_markdown(r)
