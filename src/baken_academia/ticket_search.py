"""Vectorised ticket hit evaluation for large configuration searches.

``evaluate_hits`` scores many races at once.  For each race it builds the
same probabilities as ``race_scenarios.mixture_candidates`` (per-scenario
role Harville, mixed by scenario weight, over the strongest ``support``
runners) and decides whether the production caps would have hit: a race hits
when some winning selection ranks inside the bet type's total cap.  This
matches picking main/counter/longshot in probability order, which is how the
research ticket generators fill the caps, so thousands of configurations can
be compared without building ticket tables.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

BET_TYPES = ("win", "place", "bracket_quinella", "quinella", "wide", "exacta", "trio", "trifecta")
TOTAL_CAPS = {"win": 3, "place": 4, "bracket_quinella": 12, "quinella": 19,
              "wide": 16, "exacta": 30, "trio": 37, "trifecta": 67}
# The web app (rein-web/lib/tickets.ts) uses smaller caps, no trifecta, and
# skips same-gate brackets.
WEB_CAPS = {"win": 3, "place": 3, "bracket_quinella": 11, "quinella": 17,
            "wide": 14, "exacta": 28, "trio": 34}
MIN_FIELD = {"win": 2, "place": 5, "bracket_quinella": 9, "quinella": 3,
             "wide": 4, "exacta": 3, "trio": 4, "trifecta": 4}


@dataclass
class RaceArrays:
    """Padded per-race arrays. Index ``-1`` marks padding."""
    mask: np.ndarray        # (R, N) bool, real runner
    gate: np.ndarray        # (R, N) int, 1..8
    finish: np.ndarray      # (R, N) int, finish position, 0 when unknown
    field: np.ndarray       # (R,) int

    @property
    def eligible(self) -> np.ndarray:
        """Races with exactly one 1st, 2nd and 3rd finisher."""
        return np.stack([(self.finish == p).sum(axis=1) == 1 for p in (1, 2, 3)]).all(axis=0)


def _rank_hit(prob: np.ndarray, winner_prob: np.ndarray, cap: int) -> np.ndarray:
    """True when fewer than ``cap`` selections have a strictly higher probability."""
    flat = prob.reshape(prob.shape[0], -1)
    higher = (flat > winner_prob[:, None] + 1e-15).sum(axis=1)
    return (higher < cap) & (winner_prob > 0)


def evaluate_hits(
    races: RaceArrays,
    roles: np.ndarray,
    weights: np.ndarray | None = None,
    support: int = 10,
    caps: dict[str, int] | None = None,
    same_gate_bracket: bool = True,
) -> dict[str, np.ndarray]:
    """Per-race hit flags (NaN when the race is not eligible for that bet).

    ``roles`` is (R, N, 3) for one scenario or (R, N, S, 3) with ``weights``
    (R, S).  Role vectors are renormalised over the support runners.
    ``caps`` overrides the total ticket count per bet type (bet types it leaves
    out are not scored); ``same_gate_bracket=False`` drops same-gate brackets
    as the web app does.
    """
    caps = TOTAL_CAPS if caps is None else caps
    if roles.ndim == 3:
        roles = roles[:, :, None, :]
        weights = np.ones((roles.shape[0], 1))
    R, N, S, _ = roles.shape
    roles = np.where(races.mask[:, :, None, None], np.clip(roles, 0, None), 0.0)
    marginal = (roles * weights[:, None, :, None]).sum(axis=2)
    strength = np.where(races.mask, marginal.max(axis=2), -1.0)
    K = min(support, N)
    keep = np.argsort(-strength, axis=1, kind="stable")[:, :K]
    take = lambda a: np.take_along_axis(a, keep.reshape(R, K, *([1] * (a.ndim - 2))), axis=1)
    sub = take(roles)                                         # (R, K, S, 3)
    valid = np.take_along_axis(races.mask, keep, axis=1)       # (R, K)
    sub = np.where(valid[:, :, None, None], sub, 0.0)
    sub = sub / np.clip(sub.sum(axis=1, keepdims=True), 1e-15, None)
    gate = np.take_along_axis(races.gate, keep, axis=1)
    finish = np.where(valid, np.take_along_axis(races.finish, keep, axis=1), 0)

    f, g, h = sub[..., 0], sub[..., 1], sub[..., 2]            # (R, K, S)
    eye = np.eye(K, dtype=bool)
    # exacta[i, j] per scenario: f_i g_j / (1 - g_i)
    ex = f[:, :, None, :] * g[:, None, :, :] / np.clip(1 - g[:, :, None, :], 1e-12, None)
    ex = np.where(eye[None, :, :, None], 0.0, ex)
    denom = np.clip(1 - h[:, :, None, :] - h[:, None, :, :], 1e-12, None)   # (R,K,K,S)
    tri = ex[:, :, :, None, :] * h[:, None, None, :, :] / denom[:, :, :, None, :]
    distinct = ~(eye[:, :, None] | eye[:, None, :] | eye[None, :, :])
    tri = np.where(distinct[None, :, :, :, None], tri, 0.0)
    w = weights[:, None, None, :]
    exacta = (ex * w).sum(axis=3)
    trifecta = (tri * weights[:, None, None, None, :]).sum(axis=4)
    win = (f * weights[:, None, :]).sum(axis=2)
    place = ((f + g + h) * weights[:, None, :]).sum(axis=2)
    quinella = exacta + exacta.transpose(0, 2, 1)
    trio = sum(trifecta.transpose(0, *p) for p in
               ((1, 2, 3), (1, 3, 2), (2, 1, 3), (2, 3, 1), (3, 1, 2), (3, 2, 1)))
    wide = trifecta.sum(axis=3) + trifecta.sum(axis=2) + trifecta.sum(axis=1)
    wide = wide + wide.transpose(0, 2, 1)
    upper = np.triu(np.ones((K, K), dtype=bool), 1)
    quinella = np.where(upper, quinella, 0.0)
    wide = np.where(upper, wide, 0.0)
    i3 = np.arange(K)
    sorted3 = (i3[:, None, None] < i3[None, :, None]) & (i3[None, :, None] < i3[None, None, :])
    trio = np.where(sorted3, trio, 0.0)
    bracket = np.zeros((R, 9, 9))
    rr = np.repeat(np.arange(R), K * K)
    gi = np.repeat(gate, K, axis=1).ravel()
    gj = np.tile(gate, (1, K)).ravel()
    lo, hi = np.minimum(gi, gj), np.maximum(gi, gj)
    np.add.at(bracket, (rr, lo, hi), (exacta + exacta.transpose(0, 2, 1)).ravel() / 2)
    keep_bracket = np.triu(np.ones((9, 9), dtype=bool), 0 if same_gate_bracket else 1)
    bracket = np.where(keep_bracket[None], bracket, 0.0)

    pos = {p: np.where(finish == p, 1, 0).argmax(axis=1) for p in (1, 2, 3)}
    present = {p: (finish == p).any(axis=1) for p in (1, 2, 3)}
    a, b, c = pos[1], pos[2], pos[3]
    r = np.arange(R)
    out: dict[str, np.ndarray] = {}
    ok12 = present[1] & present[2]
    ok123 = ok12 & present[3]
    out["win"] = _rank_hit(win, np.where(present[1], win[r, a], 0), caps.get("win", 0))
    out["exacta"] = _rank_hit(exacta, np.where(ok12, exacta[r, a, b], 0), caps.get("exacta", 0))
    lo2, hi2 = np.minimum(a, b), np.maximum(a, b)
    out["quinella"] = _rank_hit(quinella, np.where(ok12, quinella[r, lo2, hi2], 0), caps.get("quinella", 0))
    out["trifecta"] = _rank_hit(trifecta, np.where(ok123, trifecta[r, a, b, c], 0), caps.get("trifecta", 0))
    s3 = np.sort(np.stack([a, b, c], axis=1), axis=1)
    out["trio"] = _rank_hit(trio, np.where(ok123, trio[r, s3[:, 0], s3[:, 1], s3[:, 2]], 0), caps.get("trio", 0))
    # Brackets are gates: the winning gate pair can be covered by other
    # support runners in the same gates, so read the finishers' gates from the
    # full field, not from the pruned support.
    full_finish = np.where(races.mask, races.finish, 0)
    full_gate = {p: np.where(full_finish == p, races.gate, 0).max(axis=1) for p in (1, 2)}
    full_ok12 = ((full_finish == 1).any(axis=1) & (full_finish == 2).any(axis=1)
                 & (full_gate[1] > 0) & (full_gate[2] > 0))
    ga, gb = np.clip(full_gate[1], 0, 8), np.clip(full_gate[2], 0, 8)
    out["bracket_quinella"] = _rank_hit(bracket, np.where(full_ok12, bracket[r, np.minimum(ga, gb), np.maximum(ga, gb)], 0),
                                        caps.get("bracket_quinella", 0))
    # Multi-answer bets: hit when the best-ranked winning selection is inside
    # the cap.  A wide pair only needs its own two runners in the support.
    wide_best = np.zeros(R)
    for (px, x), (py, y) in (((1, a), (2, b)), ((1, a), (3, c)), ((2, b), (3, c))):
        lo3, hi3 = np.minimum(x, y), np.maximum(x, y)
        both = present[px] & present[py]
        wide_best = np.maximum(wide_best, np.where(both, wide[r, lo3, hi3], 0))
    out["wide"] = _rank_hit(wide, wide_best, caps.get("wide", 0))
    place_count = np.where(races.field >= 8, 3, np.where(races.field >= 5, 2, 0))
    placed = (finish > 0) & (finish <= place_count[:, None])
    place_best = np.where(placed, place, 0).max(axis=1)
    out["place"] = _rank_hit(place, place_best, caps.get("place", 0))

    eligible = races.eligible
    result = {}
    for bet in BET_TYPES:
        if bet not in caps:
            continue
        ok = eligible & (races.field >= MIN_FIELD[bet])
        result[bet] = np.where(ok, out[bet].astype(float), np.nan)
    return result


def pad_races(frame, columns: dict[str, str], max_runners: int = 18):
    """Pack a long runner frame (sorted by race) into padded arrays.

    ``columns`` maps output names to frame columns; returns (race_ids, arrays).
    """
    import pandas as pd
    codes, race_ids = pd.factorize(frame["race_id"], sort=False)
    slot = frame.groupby(codes).cumcount().to_numpy()
    keep = slot < max_runners
    R = len(race_ids)
    arrays = {}
    for name, column in columns.items():
        values = frame[column].to_numpy(float)
        a = np.zeros((R, max_runners))
        a[codes[keep], slot[keep]] = values[keep]
        arrays[name] = a
    mask = np.zeros((R, max_runners), dtype=bool)
    mask[codes[keep], slot[keep]] = True
    return np.asarray(race_ids), mask, arrays
