# Feature roadmap screening — 2026-09-27

This is an exploratory audit, **not a claim of improvement over exact production output**. No role model, weights, market ranking, or ticket strategy was activated by this work.

`report.json` contains all 7 feature families × 3 target places × 2 audit periods × 4 popularity cohorts, including negative results and day-cluster confidence intervals. It also contains 4 popularity bands × 2 race events, data coverage, and input SHA-256 hashes.

- History: 368,068 runner records through 2026-09-13.
- Eligible races: JRA turf/dirt, more than 5 starters, valid popularity, unique 1st/2nd/3rd finishers.
- Residual models: frozen pre-2025 role models; fit fixed L2 residuals on 2025 H1 (1,657 races), inspect 2025 H2 (1,638), retrospective 2026 audit (2,387). No hyperparameter search on the audit periods.
- Denominator: races whose actual target-place horse meets the popularity threshold. Top5 of the corresponding place model; this is not candidate precision or betting ROI.
- Historical final popularity/odds, not a saved pre-start cutoff. The 2026 period has been used before and is not an untouched holdout.
- `runtime-parity.json` records four spot comparisons. Batch feature arithmetic is not bit-identical to serving; missing jockey identifiers also differ. Small apparent gains must not be promoted until this is reconciled. The sample is not a full race-by-race production replay.
- Opponent quality excludes the horse itself and is shifted to its next race; later opponent results are not used.
- Same-day signals use only earlier race numbers at the same venue/surface. Actual result publication timestamps are not present. Gate position is not the actual inner/outer path.
- No race-segment lap data are available in this archive. Average time per furlong is not a sequence of race laps.

All new numeric role corrections were held. Jockey-conditioned third-place residuals improve some outsider cohorts but lower overall Top5 in 2026. Band-event models improve Brier point estimates yet overpredict the 10+ popularity top3 event and lack pre-start snapshots. “REIN above market” alone was not adopted as a broader hole-selection rule.

New UI features are separate: immutable device-local forecast journal (60 snapshots), exact-place Top5 result review with 4+/6+/10+ filters, saved-odds comparison, rank comparison chart, existing-model reason display, timestamps/sample counts, and horse notes. These improve traceability; they are not measured hit-rate gains. Cancelled fields and tied top3 results are excluded from the simple local journal. Full official archives, payout/ROI dashboards, corner-result matching, notifications and new calibrated probabilities are still pending.

## Reproduction

Use Python with numpy, pandas, scipy, scikit-learn, lightgbm and pyarrow. The workspace must contain the hash-identified `model_bundle/*/data/history.parquet`, `analysis_input/frozen_predictions.csv.gz`, and `market_model_artifact/first/predictions.parquet`. Runtime parity output is preserved separately; the screening script reads it but does not regenerate that expensive serving comparison.

```bash
OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 python scripts/audit_feature_roadmap.py --workspace /path/to/workspace --output reports/feature-roadmap-v1
```

The helper module contains the historical feature builders extracted from prior REIN research scripts. It does not replace serving features. UI tests are `rein-web/tests/prediction-journal.test.mjs`; the synthetic browser fixture is `rein-web/tests/research-features-fixture.tsx` and is not an application route.
