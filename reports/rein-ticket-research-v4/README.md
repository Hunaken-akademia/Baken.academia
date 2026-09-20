# REIN all-bet ticket research v4

This is an offline comparison. It does not change the deployed REIN application.

## Design

- Train three separate models for first, second and third place with data through 2024.
- Inputs include time-safe horse/jockey/trainer history, closing 3F relative to the
  race, class movement, distance change, running style and expected front pressure.
- Select the ticket mix on 2025 races and audit the frozen choice on 2026 races.
- Use flat races only because `avg_1f` has different semantics for obstacle races.
- Keep the current main/counter/longshot point caps unchanged.
- Compare current probability generation, pure popularity and several market/REIN mixes.

Popularity in this archive is closing/result-page popularity. It approximates the
late market and must not be described as a morning-time result.

## 2026 audit

The recommended rule is pure popularity for win/place and 70% popularity plus 30%
role-specific REIN probability for every multi-horse bet. Win/place did not show a
repeatable gain from adding REIN, while all six multi-horse types improved in both
2025 and 2026.

| Bet type | Current | Popularity | Recommended | Change vs current | Average points |
|---|---:|---:|---:|---:|---:|
| Win | 53.62% | 65.72% | 65.72% | +12.10 pp | 3.00 |
| Place | 94.18% | 97.34% | 97.34% | +3.16 pp | 4.00 |
| Bracket quinella | 74.02% | 78.69% | 81.87% | +7.85 pp | 12.00 |
| Quinella | 68.14% | 71.59% | 78.00% | +9.86 pp | 18.96 |
| Wide | 84.94% | 81.82% | 91.01% | +6.07 pp | 15.98 |
| Exacta | 60.44% | 64.48% | 71.30% | +10.86 pp | 29.98 |
| Trio | 56.57% | 61.65% | 67.39% | +10.82 pp | 36.83 |
| Trifecta | 32.07% | 39.60% | 43.84% | +11.77 pp | 66.99 |

The average point count is fractionally below the maximum in small fields where the
full number of distinct selections does not exist. Current and candidate generators
use the same caps and effectively identical counts.

## Improvement over popularity on multi-horse bets

| Bet type | 2025 | 2026 |
|---|---:|---:|
| Bracket quinella | +6.00 pp | +3.18 pp |
| Quinella | +7.01 pp | +6.41 pp |
| Wide | +8.82 pp | +9.19 pp |
| Exacta | +7.75 pp | +6.82 pp |
| Trio | +4.64 pp | +5.74 pp |
| Trifecta | +3.90 pp | +4.24 pp |

## Decision

Promote the multi-horse policy to a production implementation candidate. Keep win
and place anchored to popularity. The current web history bundle cannot reproduce
the role-specific LightGBM probabilities yet, so do not replace `tickets.ts` with an
unvalidated approximation. Export or serve the exact role model first, then run a
prospectively frozen shadow comparison before switching the user-visible tickets.

Exact period, tier and strategy metrics are in `report.json`.
