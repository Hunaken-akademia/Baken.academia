# REIN research v3

This is an offline experiment, not the deployed REIN scoring engine.

## Question

Can closing speed, class movement, distance change and expected pace pressure add
stable information to closing popularity?

## Protocol

- Train: 2019-2022
- Select features/blend weight: 2023 flat races (3,329 races)
- Chronological audit after selection: 2024 flat races
- 2025-2026: retrospective only, because these years were inspected previously
- Exclude only explicit cancellation/exclusion; keep non-finishers in denominators
- Treat `avg_1f` as final 3F only on turf/dirt. Obstacle races use different semantics.
- Derive pace pressure from prior corner position because archived `lap_times` is empty.
- Keep the research model independent of current popularity, then blend its within-race
  probability with reciprocal popularity rank.

## Selected candidate

Both the win and place objectives selected 20% model / 80% popularity on 2023.
The improvement was extremely small. On the untouched 2024 flat audit, it did not
repeat.

| 2024 change vs popularity | Win model blend | Place model blend |
|---|---:|---:|
| Rank 1 win rate | 0.00 pp | 0.00 pp |
| Rank 1 top-3 rate | 0.00 pp | 0.00 pp |
| Winner captured in top 3 | -0.27 pp | -0.06 pp |
| At least two placed in top 3 | -0.51 pp | -0.15 pp |
| All three placed in top 3 | -0.15 pp | -0.12 pp |

## Decision

Reject this candidate for production. These historical signals are useful for
explanation and identifying disagreement, but the present archive does not show a
stable accuracy gain over closing popularity. Do not present the 2023 uplift as a
REIN improvement.

The next useful evaluation is value/return after odds coverage is complete, plus a
prospectively frozen prediction log. Return can improve even when raw hit rate does
not, if REIN identifies mispriced runners.

Exact metrics, candidate weights and period definitions are in `report.json`.
