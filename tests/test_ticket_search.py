import numpy as np
import pandas as pd

from baken_academia.all_bet_hit_rate import BET_CAPS
from baken_academia.bet_strategy_comparison import GROUPS, build_outcomes
from baken_academia.race_scenarios import mixture_candidates, pick_tickets
from baken_academia.ticket_search import RaceArrays, evaluate_hits


def _races(R=40, seed=3):
    rng = np.random.default_rng(seed)
    rows, roles, weights = [], [], []
    N = 18
    mask = np.zeros((R, N), bool); gate = np.zeros((R, N), int); finish = np.zeros((R, N), int)
    role_arr = np.zeros((R, N, 3, 3)); w_arr = np.zeros((R, 3)); field = np.zeros(R, int)
    for r in range(R):
        n = int(rng.integers(6, 17))
        field[r] = n
        mask[r, :n] = True
        gate[r, :n] = [min(8, 1 + i * 8 // n) for i in range(n)]
        order = rng.permutation(n)
        finish[r, :n] = order + 1
        for s in range(3):
            for k in range(3):
                v = rng.random(n) ** 2 + .01
                role_arr[r, :n, s, k] = v / v.sum()
        w = rng.random(3); w_arr[r] = w / w.sum()
        for i in range(n):
            rows.append({"race_id": f"r{r}", "horse_number": i + 1, "gate": int(gate[r, i]),
                         "finish_position": int(finish[r, i])})
    return RaceArrays(mask, gate, finish, field), role_arr, w_arr, pd.DataFrame(rows)


def test_vectorised_hits_match_ticket_tables():
    races, roles, weights, frame = _races()
    hits = evaluate_hits(races, roles, weights, support=9)
    outcomes, eligible = build_outcomes(frame)
    checked_races = 0
    for r in range(len(races.field)):
        n = races.field[r]
        if n > 9:  # no support pruning, so both paths see the same runners
            continue
        horses = frame.loc[frame.race_id.eq(f"r{r}")].reset_index(drop=True)
        scen = {s: weights[r, i] for i, s in enumerate(("front", "neutral", "closer"))}
        flat = {k: np.ones(n) for k in ("first", "second", "third")}
        tilts = {s: {k: roles[r, :n, i, j] for j, k in enumerate(flat)} for i, s in enumerate(scen)}
        frames = mixture_candidates(horses, scen, flat, tilts)
        tickets = pick_tickets(frames, BET_CAPS, GROUPS).assign(race_id=f"r{r}")
        checked = tickets.merge(outcomes.assign(hit=True), on=["race_id", "bet_type", "selection"], how="left")
        for bet in hits:
            if f"r{r}" not in eligible[bet]:
                continue
            expected = bool(checked.loc[checked.bet_type.eq(bet), "hit"].eq(True).any())
            assert hits[bet][r] == float(expected), (r, bet)
        checked_races += 1
    assert checked_races >= 5


def test_hits_are_nan_when_not_eligible():
    races, roles, weights, _ = _races(R=5)
    races.finish[0, :] = np.where(races.mask[0], 1, 0)  # every runner "1st": dead heat
    hits = evaluate_hits(races, roles, weights)
    assert all(np.isnan(hits[bet][0]) for bet in hits)
