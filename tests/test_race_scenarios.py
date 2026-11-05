import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from baken_academia.race_scenarios import (
    day_bias, first_corner_share, label_scenarios, mixture_candidates, race_number, race_shape,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))


def test_first_corner_share_and_race_number():
    corners = pd.Series([json.dumps(["3", "2"]), json.dumps([]), "bad", json.dumps(["20"])])
    share = first_corner_share(corners, pd.Series([10, 10, 10, 10]))
    assert share.iloc[0] == 0.3 and share.iloc[1:].isna().all()
    assert race_number(pd.Series(["20260105-中山-11", "202601050307"])).tolist() == [11, 7]


def _day(venue, date, early_by_race):
    rows = []
    for r, early in enumerate(early_by_race, 1):
        for pos in range(1, 11):
            corner = early[pos - 1] if pos <= 3 else 5
            rows.append({"race_id": f"{date.replace('-', '')}-{venue}-{r:02d}", "race_date": pd.Timestamp(date),
                         "racecourse": venue, "surface": "芝", "finish_position": pos,
                         "corner_positions": json.dumps([str(corner)])})
    return rows


def test_day_bias_uses_only_earlier_races_and_gates_weak_days():
    closer_day = _day("東京", "2025-01-05", [[9, 8, 10]] * 5)
    mixed_day = _day("中山", "2025-01-05", [[9, 8, 10], [1, 2, 1], [9, 8, 10], [1, 2, 1], [5, 5, 5]])
    shape = race_shape(pd.DataFrame(closer_day + mixed_day))
    bias = day_bias(shape, reference_mean=0.5).set_index("race_id")
    first = bias.loc["20250105-東京-01"]
    assert first["bias_races"] == 0 and first["bias_shrunk"] == 0 and first["bias_gated"] == 0
    # Two earlier races: shrunk bias is on, but the gate needs three.
    assert bias.loc["20250105-東京-03", "bias_shrunk"] > 0
    assert bias.loc["20250105-東京-03", "bias_gated"] == 0
    # Consistent closer days pass the gate; alternating days never do.
    assert bias.loc["20250105-東京-05", "bias_gated"] > 0
    assert (bias.loc[bias.index.str.contains("中山"), "bias_gated"] == 0).all()


def test_label_scenarios_terciles():
    shape = pd.DataFrame({"race_date": pd.to_datetime(["2020-01-01"] * 6), "top3_early": [.1, .2, .3, .5, .7, .9]})
    labels, cuts = label_scenarios(shape, "2021-12-31")
    assert labels.iloc[0] == "front" and labels.iloc[-1] == "closer"
    assert cuts["front_max"] < cuts["closer_min"]


def _field(n=10, seed=0):
    rng = np.random.default_rng(seed)
    horses = pd.DataFrame({"horse_number": range(1, n + 1), "gate": [(i // 2) + 1 for i in range(n)]})
    marginals = {r: (lambda v: v / v.sum())(rng.random(n) + .05) for r in ("first", "second", "third")}
    return horses, marginals


def test_mixture_without_tilt_matches_research_v4_candidates():
    from rein_ticket_research_v4 import candidates
    horses, marginals = _field()
    group = horses.assign(win_probability=marginals["first"], popularity=range(1, 11),
                          v4_first_probability=marginals["first"], v4_second_probability=marginals["second"],
                          v4_third_probability=marginals["third"])
    ours = mixture_candidates(horses, {}, marginals, None)
    theirs = candidates(group, (0.0, 0.0, 1.0))
    for bet in ("win", "quinella", "trio", "trifecta", "wide", "bracket_quinella"):
        a = ours[bet].set_index("selection")["probability"].sort_index()
        b = theirs[bet].set_index("selection")["probability"].sort_index()
        assert np.allclose(a.to_numpy(), b.reindex(a.index).to_numpy())


def test_scenario_mixture_correlates_runners_who_share_a_shape():
    horses, _ = _field(n=6)
    flat = np.full(6, 1 / 6)
    marginals = {r: flat for r in ("first", "second", "third")}
    up = np.array([2, 2, 2, .01, .01, .01]); down = np.array([.01, .01, .01, 2, 2, 2])
    tilts = {"front": {r: up for r in marginals}, "closer": {r: down for r in marginals},
             "neutral": {r: np.ones(6) for r in marginals}}
    mixed = mixture_candidates(horses, {"front": .5, "closer": .5, "neutral": 0}, marginals, tilts)
    plain = mixture_candidates(horses, {}, marginals, None)
    trio = mixed["trio"].set_index("selection")["probability"]
    assert trio[(1, 2, 3)] > plain["trio"].set_index("selection")["probability"][(1, 2, 3)] * 5
    assert trio[(1, 2, 4)] < trio[(1, 2, 3)]
