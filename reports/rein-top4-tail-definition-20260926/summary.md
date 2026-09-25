# REIN Top4 splice definition audit — 2026-09-26

Fixed-policy re-evaluation only. No model fitting, parameter search, production changes or racing-site downloads.
Run 36201827994 succeeded. Source commit b4c9f46c8bbfffe3661adeb30ec2bf3dd535378b.

## Correction to previous baseline labeling
The earlier 2026 Top5=82.15% baseline was a research 70/30 blend of newly trained real-win-odds market and REIN models. It was NOT the deployed production ranking.
Production formula verified from rein-web/app/api/analyze/route.ts, blob 8d786e37f23c8420b5158f79346dba207eeb4ea0: 70% normalized inverse popularity + 30% (.5*old_first + .3*old_second + .2*old_third), with 45..98 clamp, integer half-up points and popularity tie-break. Reconstructs 2026 Top5=1942/2387=81.36%.
Research baseline: .7*(.5*new_market_first+.3*new_market_second+.2*new_market_third)+.3*(.5*new_REIN_first+.3*new_REIN_second+.2*new_REIN_third), raw score, Top5=1961/2387=82.15%.

## Fixed policy
Take the market-difference ranking's first four horses from the entire field. Append every remaining horse in the specified baseline's relative order, excluding duplicates. Top1..Top4 equal the market-difference ranking exactly. Original rank numbers after fourth are NOT fixed. This does not mathematically guarantee unchanged Top5 membership or accuracy.
Market-difference coefficients remain .75, with first/second/third log score-ratio weights .5/.3/.2. No coefficients were reselected.

## 2026 retrospective cohort — 2387 races
Values are exact first-finisher capture counts for Top1,Top2,Top3,Top4,Top5 respectively.
|Method|Top1|Top2|Top3|Top4|Top5|
|---|---:|---:|---:|---:|---:|
|Actual production reconstruction|810|1267|1569|1792|1942|
|Research 70/30 baseline|807|1274|1569|1795|1961|
|Market-difference full ranking|816|1277|1576|1797|1959|
|Market-difference Top4 + remaining production order|816|1277|1576|1797|1947|
|Market-difference Top4 + remaining research 70/30 order|816|1277|1576|1797|1961|
|Popularity only|810|1266|1571|1795|1957|

Proposed literal production-tail version rates: 34.19%,53.50%,66.02%,75.28%,81.57%.
Actual production rates: 33.93%,53.08%,65.73%,75.07%,81.36%.

## 2025H2 retrospective cohort — 1638 races
|Method|Top1|Top2|Top3|Top4|Top5|
|---|---:|---:|---:|---:|---:|
|Actual production reconstruction|531|886|1091|1224|1339|
|Research 70/30 baseline|527|873|1092|1238|1349|
|Market-difference full ranking|529|876|1095|1240|1344|
|Market-difference Top4 + remaining production order|529|876|1095|1240|1343|
|Market-difference Top4 + remaining research 70/30 order|529|876|1095|1240|1349|
|Popularity only|531|884|1092|1234|1347|

Literal production-tail Top5: 81.75% -> 81.99%, +4 races. But Top1:32.42% ->32.30%; Top2:54.09% ->53.48%. Do not claim improvements at every rank in both periods.

## Uncertainty and interpretation
Literal production-tail Top5 minus actual production: H2 +0.2442pp, day-cluster 95% interval [-0.0628,+0.6006]pp; 2026 +0.2095pp, interval [-0.0831,+0.5063]pp. Both include zero.
Research-tail Top5 is exactly equal to research baseline on H2; 2026 has 1 newly captured and 1 lost race, equal overall count. This is not the selected fifth-boundary policy that had 6 gains/6 losses.
Market-difference Top4 plus research tail is a simple candidate preserving the research baseline's observed Top5 rate, but is not a production-tail-preserving change.
All new-model inputs use historical final win odds. No 10-minute pre-race snapshot claim. H2 and 2026 have been repeatedly inspected; this proposal is retrospective and post-selection. Bootstrap intervals do not correct repeated research. No profitability claim or automatic production adoption.

## Integrity
Read-only Actions downloaded preserved outputs of runs 36135569462 and 36126760897; download digests verified. Original production and earlier research Top1..Top5 counts exactly reproduced. 11364 top-four/tail-order invariant checks passed across 5682 races. Local independent winner-position checks:39774; aggregate checks:168; all matched. Artifact 10892501458 contains report.json, rank_orders.csv.gz, races.csv. Source hashes and Top1..Top8 comparisons retained.
