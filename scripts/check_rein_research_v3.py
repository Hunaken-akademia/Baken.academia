import pandas as pd

from rein_research import prepare
from rein_research_v3 import add_v3_features


raw = pd.read_parquet("data/raw/history.parquet")
raw["race_date"] = pd.to_datetime(raw["race_date"])
raw = raw[raw["race_date"].lt("2019-04-01")].copy()
a, columns = add_v3_features(prepare(raw))

cut = pd.Timestamp("2019-03-01")
changed = raw.copy()
future = changed["race_date"].ge(cut)
changed.loc[future, "finish_position"] = 18
changed.loc[future, "finish_time"] = "9:59.9"
changed.loc[future, "corner_positions"] = '["18", "18"]'
changed.loc[future, "avg_1f"] = 99.9
b, _ = add_v3_features(prepare(changed))
pd.testing.assert_frame_equal(
    a.loc[a["race_date"].lt(cut), columns],
    b.loc[b["race_date"].lt(cut), columns],
)

cut = a["race_date"].max()
changed = raw.copy()
target = changed["race_date"].eq(cut)
changed.loc[target, "finish_position"] = 18
changed.loc[target, "finish_time"] = "9:59.9"
changed.loc[target, "corner_positions"] = '["18"]'
changed.loc[target, "avg_1f"] = 99.9
b, _ = add_v3_features(prepare(changed))
pd.testing.assert_frame_equal(
    a.loc[a["race_date"].eq(cut), columns],
    b.loc[b["race_date"].eq(cut), columns],
)
print("PASS: v3 features are invariant to future and target-day outcomes")
