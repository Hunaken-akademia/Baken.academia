from __future__ import annotations
import numpy as np

ROLE_TARGETS = (("first", 1), ("second", 2), ("third", 3))

def score_market_difference(runtime, full_frame, race, runners):
    if runtime.market_models is None:
        return None
    result = {"market": {}, "rein": {}}
    for role, target in ROLE_TARGETS:
        for kind in ("market", "rein"):
            model = runtime.market_models[role][kind]
            frame = runtime._market_feature_frame(full_frame, race, runners, target, model.feature_name())
            values = np.clip(model.predict(frame), 1e-12, None)
            result[kind][role] = values / values.sum()
    return result
