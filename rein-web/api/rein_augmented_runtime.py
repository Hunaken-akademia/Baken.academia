from __future__ import annotations
import numpy as np
from rein_core import ReinRuntime as BaseRuntime
from rein_market_score import score_market_difference

class ReinRuntime(BaseRuntime):
    def score(self, race, runners):
        base = super().score(race, runners)
        if self.market_models is None:
            base["market_difference_ready"] = False
            return base
        full = self._feature_frame_full(race, runners)
        scores = score_market_difference(self, full, race, runners)
        for index, item in enumerate(base["runners"]):
            for kind, prefix in (("market", "market"), ("rein", "rein_market")):
                for role in ("first", "second", "third"):
                    item[f"{prefix}_{role}_probability"] = float(scores[kind][role][index])
        base["market_difference_ready"] = True
        return base
