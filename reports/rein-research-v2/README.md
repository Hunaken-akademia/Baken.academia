# REIN research v2

This is an offline research experiment, not the production REIN scoring engine.
The production route computes a hand-written history/weight/pace score; the
previous reports evaluated a different LightGBM model. Neither historical report
is a measurement of the production web score.

## Data and validation

- Existing JRA result archive: 368,068 runner rows before exclusions.
- Explicit non-starters (取消/除外) excluded; DNF runners remain in ranking denominators.
- Train before 2023; early stopping in 2023; independent chronological audit in 2024.
- 2025–2026 results are retrospective, not fresh holdout evidence: prior experiments
  already inspected them. A future frozen prediction log is needed for prospective claims.
- Popularity originates in result pages (closing popularity). These experiments
  assume closing-market information and are not evidence for morning prediction quality.
- No contemporaneous finish time, corner position, lap or finishing rank enters features.
  Horse-performance features are shifted to previous starts. Entity rates exclude the target day.
- `avg_1f` is not interpreted as a 1-furlong time. Race last 3f/4f columns are all missing.
- Three-first-lap sum is a historical descriptive feature, not a normalized pace index:
  opening fractional distances can differ across courses/distances.

## Experiments

Compare market-only, market-plus-existing-history, and market-plus-rich-history
for two separate outcomes (win and top-three). Hyperparameters are fixed before
reading the new audit. Market-only ranking is also reported directly.

Rich features: preceding and recent-three speed, within-race relative speed,
normalized early/late positions, position gain, finish percentile, historical
popularity, first-three-lap time; prior-90-day jockey/trainer rates; projected
front-runner count. These are candidate signals, not a guarantee of improvement.

Run `python scripts/rein_research.py` with `data/raw/history.parquet` downloaded
from the authorized source artifact. Run `python scripts/check_rein_research.py`
for target-day and future-outcome invariance checks. Results go to report.json.

No production model or ticket logic is changed by this experiment.
