from __future__ import annotations
import numpy as np
from rein_core import ReinRuntime as BaseRuntime, market_inputs_valid
from rein_market_score import score_market_difference

class ReinRuntime(BaseRuntime):
    def score(self, race, runners):
        base = super().score(race, runners)
        if self.market_models is None or not market_inputs_valid(runners):
            base["market_difference_ready"] = False
            return base
        full = self._feature_frame_full(race, runners)
        for column in ("racecourse", "going", "race_class", "sex", "surface", "jockey_id", "trainer_id"):
            if column in full:
                full[column] = full[column].astype(object)
        scores = score_market_difference(self, full, race, runners)
        for index, item in enumerate(base["runners"]):
            for kind, prefix in (("market", "market"), ("rein", "rein_market")):
                for role in ("first", "second", "third"):
                    item[f"{prefix}_{role}_probability"] = float(scores[kind][role][index])
        base["market_difference_ready"] = True
        return base
