# REIN JRA market-edge research — 2026-09-25

Research only. No merge to main, production activation, Supabase/authentication or NAR acquisition changes.

## Scope and provenance
- Historical input: 2019-01-05..2026-09-13, 26,675 races and 368,068 runner records.
- New models trained on eligible 2019..2024 history: 19,818 races / 274,036 runners.
- Candidate selection: 2025H1 (1,657 races); confirmation: 2025H2 (1,638); retrospective audit: 2026 (2,387).
- Cohort: JRA flat turf/dirt, >5 actual starters, valid popularity, unique finishers at 1/2/3.
- 171 features: 165 non-market features in nine families and six popularity-rank/field-size features. No actual odds in this input bundle.
- 72 main model fits plus 6 matched controls = 78 fits; 27 score candidates per role = 81; 405 selective-swap settings.
- 8 existing + 5 new tests passed; 12-race production-feature parity passed. Independent local recount matched 1,458 aggregates. Frozen production probability checks differed by less than 1e-15.
- Main run succeeded: https://github.com/Hunaken-akademia/Baken.academia/actions/runs/36129404198 (commit 702e787b6b79d7d415e0bc38142d5724e59c01a6).
- Matched-control run succeeded: https://github.com/Hunaken-akademia/Baken.academia/actions/runs/36129865881 (commit fedd0e1d7feb7620200068cf7ff1c6f13bf92e63).

## Primary endpoint: Top5 exact-finisher capture
Candidates were selected by 2025H1 Top5, then Top3, then Top1. 2026 was not used to choose them.

|Ranking|Selected candidate|2026 popularity hits|2026 selected hits|2026 difference pp|2025H2 difference pp|
|---|---|---:|---:|---:|---:|
|Overall|add_condition_fit|1957/2387|1957/2387|0.0000|-0.1221|
|First|all_l15|1957/2387|1956/2387|-0.0419|-0.2442|
|Second|add_pace|1751/2387|1752/2387|+0.0419|0.0000|
|Third|residual_0.5|1547/2387|1547/2387|0.0000|-0.1832|

No stable superiority to popularity-only Top5 was established. Overall new scores are raw .5/.3/.2 role-probability aggregates, not the production rounded-point ranking.

Selective popular-top4 plus outsider replacement of popularity5:
- First: 1965/2387 (82.32%), +0.3352pp in 2026, 16 gained / 8 lost; 2025H2 -0.1832pp. Day-cluster 95% interval [-0.0846,+0.7650]pp.
- Second: 1756/2387 (73.57%), +0.2095pp, 15 gained / 10 lost; 2025H2 -0.2442pp. Interval [-0.1260,+0.5499]pp.
- Third: 1500/2387 (62.84%), -1.9690pp, 117 gained / 164 lost; 2025H2 -1.5873pp. Interval [-3.4101,-0.5430]pp.
These policies are not recommended for production adoption. Forced outsider insertion also underperformed popularity-top5 in all three roles.

## Secondary, exploratory endpoint — added AFTER reviewing primary results
This does not turn the failed primary endpoint into a success. The already-trained candidate with the smallest 2025H1 log loss was without_people for each role. This is a 151-feature market-informed model excluding 20 jockey/trainer/partnership features, NOT an independent popularity-free model.

Matched baseline/full controls used 180 trees, 15 leaves and identical remaining hyperparameters. Lower log loss is better; it is not hit rate, ROI or proof of perfect calibration.

|Role|2026 matched market log loss|2026 candidate log loss|2025H2 improvement|
|---|---:|---:|---:|
|First|1.990916|1.976631|0.017906|
|Second|2.248998|2.227781|0.009337|
|Third|2.371707|2.349393|0.009312|

Brier scores also improved in each role in H2 and 2026. The 45-feature recent-form family improved log loss versus a matched market-only baseline for every role in both periods. Removing the 20 people features improved log loss versus matched full-feature models; this does not establish that jockey/trainer information is generally irrelevant.

For each role/popularity rank 1..8, upper/lower quartile boundaries of log(candidate_probability / matched_market_probability) were fixed on 2025H1 and applied unchanged later. Middle groups exist. Later periods need not have exactly 25% in either group.

Illustrative 2026 exact-finisher rates (not top-three-place rates):
|Popularity / target|Higher-rated hits/runners|Higher rate|Lower-rated hits/runners|Lower rate|
|---|---:|---:|---:|---:|
|Popularity1 / first|203/528|38.45%|143/545|26.24%|
|Popularity6 / third|60/576|10.42%|36/571|6.30%|
|Popularity7 / third|49/586|8.36%|27/599|4.51%|
|Popularity8 / third|46/558|8.24%|24/591|4.06%|

Popularity1 first-place rates in 2025H2: 162/396=40.91% higher, 71/286=24.83% lower. The 2026 difference is 12.21pp with an unadjusted day-cluster 95% interval [6.46,18.24]pp. Popularity6..8 third-place groups had the same direction in H2. These are selected illustrations from 24 exploratory groups; the complete tables are retained. Intervals do not fully correct multiple comparisons or the secondary, post-primary analysis.

## Interpretation and limitations
Promising development direction: preserve a market baseline and explain condition-driven confidence within the same popularity rank; add exact-role support and historical sample sizes, without forcing outsiders or hiding lower-ranked horses.
Actual odds vary even within the same popularity rank. Because no actual odds were inputs here, these differences may partly reflect odds strength; superiority over an odds-informed market benchmark is NOT established. Neither profitability nor exclusive industry superiority is established.
2026 has been used in previous research and in this primary analysis: it is retrospective, not an untouched final test. Popularity is historical final popularity, not 60/10-minute snapshots. Training/workout, detailed pedigree, paddock, and specified-anchor conditional opponent models are not evaluated. No production/UI deployment was made. Require a stronger actual-odds benchmark and genuinely unused, prospectively saved predictions before adoption.

## Reproducibility
- scripts/rein_market_edge_research.py
- scripts/test_rein_market_edge.py
- scripts/rein_market_edge_controls.py
- Existing immutable model/data bundle: rein-role-v4-189820badb8b7689b1da27435d2e2ba28c967fc3.
- Existing second-place comparison uses rein-second-joint-v5-20260922.
- All candidate prediction CSVs are in the main Actions artifacts (30-day retention). The without_people Booster itself was not exported, but is retrainable from fixed source/data/seed.
