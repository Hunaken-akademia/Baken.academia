# Popularity-pattern reference: 2026-10-21

The initial release misunderstood the request as manual selection within popularity bands. This revision removes that selector and compares automatic ordered popularity-pattern candidates from (1) the visible condition statistics alone and (2) existing REIN first/second/third role scores, with an explicitly experimental daily-pattern adjustment.

## Sparse condition display

Observed condition rates are no longer discarded by a hard 20-career/10-condition-start cutoff. Records of 1–4 starts remain visible with a sparse-sample label; five or more starts use normal labels. Career-relative differences are multiplied by min(1, starts/5). When a career-relative comparison is unavailable, the rate is shrunk toward 33.3% using five pseudo-observations. Conditions missing for every horse are omitted, and missing cells remain unknown. No pedigree, going or horse/jockey combination statistics are fabricated.

## Forecast construction

Evaluate all ordered triples of distinct horses. For each successive finishing role, normalize its weight over the remaining horses; aggregate the resulting approximate score by A (1–3), B (4–6), C (7–9), D (10+). This approximation is not a learned joint finish model or a calibrated probability. The displayed index makes the leading pattern 100 within each panel. Group size affects aggregate mass; D includes more than three horses in large fields.

Condition-only weights use wins/places from the same fields displayed by the matrix, shrink sparse records, and average rather than add overlapping sample sizes. Missing conditions are omitted. A horse missing every condition receives the field's neutral average only for this experimental forecast, never a fabricated cell value.

Daily adjustment uses only earlier, same-venue, same-surface, final-popularity results observed before the target race's start. At least three such races are required. The multiplier is at most 1.30. This is a bounded heuristic, not evidence that a day's common pattern will recur. Missing data or request failure preserves the base estimate. Completed races require an authentic prestart saved prediction and are explicitly labeled retrospective; rebuilt/final-only predictions are held.

## Small retrospective sanity check (not model selection)

24 NAR races on 2026-10-20, using existing prestart snapshots with generated_at < starts_at. Actual finish groups were assigned using each horse's popularity at prediction time, not hindsight final popularity. No parameter was selected from these results.

| Method | Leading pattern correct | Actual pattern among top 3 |
| --- | ---: | ---: |
| Condition table only | 2/24 | 5/24 |
| Existing REIN role-score aggregation | 5/24 | 9/24 |

The sample is small, one day and NAR only. It does not establish an accuracy improvement, JRA performance, profitability, or the value of the daily adjustment (not audited in this sample). Both displays remain explicitly experimental. Examples: Monbetsu 11R on 2026-10-20 returned A-A-B and both methods ranked A-A-B first; Monbetsu 12R returned A-B-B, which neither method placed in its top three.

Validation: targeted logic and DOM interaction tests; full web test suite and production build. Live signed-in browser behavior requires a member session.

## Display follow-up

The daily-only pattern frequency panel is placed first, independent of REIN or condition scores and even when those estimates are held. It shows prior observed result counts for one or more races, respects ties, and does not choose horses. This does not change the three-race requirement for the separate combined estimate’s daily adjustment. Cushion value data is not currently collected or used by REIN.
