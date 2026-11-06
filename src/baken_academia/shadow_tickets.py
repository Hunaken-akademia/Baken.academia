"""Shadow operation: production web tickets versus the frozen market stacker.

The production arm reproduces ``rein-web/lib/tickets.ts`` (70% reciprocal
popularity + 30% REIN role probability, nine-runner support, role Harville,
the web caps and no same-gate brackets).  The shadow arm only swaps the role
probabilities for the frozen conditional-logit stacker
(``rein-web/lib/market-stack-v1.json``).  Both arms read the same saved
pre-start predictions, so the comparison uses nothing known after the start.

``report_sql`` renders one read-only query that does the whole comparison in
the database and returns per-day totals; ``python_arms`` is the reference the
query is tested against.
"""
from __future__ import annotations

import itertools
import math
from typing import Iterable

ROLES = ("first", "second", "third")
WEB_CAPS = {"単勝": (1, 1, 1), "複勝": (1, 1, 1), "枠連": (3, 4, 4), "馬連": (5, 6, 6),
            "ワイド": (4, 5, 5), "馬単": (8, 10, 10), "三連複": (10, 12, 12)}
SUPPORT = 9
EPS = 1e-6


def _normalize(values: Iterable[float], floor: float) -> list[float]:
    safe = [max(v if math.isfinite(v) else 0.0, floor) for v in values]
    total = sum(safe)
    return [v / total for v in safe]


def market(horses: list[dict]) -> list[float]:
    """Reciprocal popularity normalised in the race; missing or 0 popularity gets the fallback."""
    pops = [h.get("popularity") or 0 for h in horses]
    fallback = max(max(pops), len(horses)) + 1
    return _normalize([1 / max(p or fallback, 1) for p in pops], 1e-9)


def production_roles(horses: list[dict]) -> list[dict[str, float]]:
    m = market(horses)
    learned = {r: _normalize([h[f"{r}Probability"] for h in horses], 1e-9) for r in ROLES}
    return [{r: .7 * m[i] + .3 * learned[r][i] for r in ROLES} for i in range(len(horses))]


def stack_roles(horses: list[dict], coefficients: dict[str, dict[str, float]]) -> list[dict[str, float]]:
    lm = [math.log(max(v, EPS)) for v in market(horses)]
    lr = {r: [math.log(v) for v in _normalize([h[f"{r}Probability"] for h in horses], EPS)] for r in ROLES}
    out: list[dict[str, float]] = [{} for _ in horses]
    for role in ROLES:
        c = coefficients[role]
        scores = []
        for i in range(len(horses)):
            s = c.get("log_market", 0) * lm[i] + c.get("log_role", 0) * lr[role][i] + c.get("log_market_sq", 0) * lm[i] ** 2
            s += sum(c.get(f"log_{o}", 0) * lr[o][i] for o in ROLES if o != role)
            scores.append(s)
        peak = max(scores)
        e = [math.exp(s - peak) for s in scores]
        total = sum(e)
        for i, v in enumerate(e):
            out[i][role] = v / total
    return out


def tickets(horses: list[dict], roles: list[dict[str, float]]) -> dict[str, list[str]]:
    """Selections in the web app's order (本線, 対抗, 穴 concatenated)."""
    rows = [{"number": h["number"], "gate": h["gate"], **r} for h, r in zip(horses, roles)]
    # The web app renormalises only when it prunes; otherwise the roles already sum to 1.
    rows = sorted(rows, key=lambda x: -max(x["first"], x["second"], x["third"]))[:SUPPORT]
    norm = {r: _normalize([x[r] for x in rows], 1e-9) for r in ROLES}
    rows = [{**x, **{r: norm[r][i] for r in ROLES}} for i, x in enumerate(rows)]
    values: dict[str, dict[str, float]] = {t: {} for t in WEB_CAPS}

    def add(bet: str, sel: Iterable[int], p: float) -> None:
        key = "-".join(map(str, sel))
        values[bet][key] = values[bet].get(key, 0.0) + p

    for h in rows:
        add("単勝", [h["number"]], h["first"])
        add("複勝", [h["number"]], h["first"] + h["second"] + h["third"])
    for a, b in itertools.permutations(rows, 2):
        p = a["first"] * b["second"] / max(1 - a["second"], 1e-12)
        add("馬単", [a["number"], b["number"]], p)
        add("馬連", sorted([a["number"], b["number"]]), p)
        if a["gate"] != b["gate"]:
            add("枠連", sorted([a["gate"], b["gate"]]), p)
    for a, b, c in itertools.permutations(rows, 3):
        p = (a["first"] * b["second"] / max(1 - a["second"], 1e-12)
             * c["third"] / max(1 - a["third"] - b["third"], 1e-12))
        add("三連複", sorted([a["number"], b["number"], c["number"]]), p)
        for x, y in ((a, b), (a, c), (b, c)):
            add("ワイド", sorted([x["number"], y["number"]]), p)
    return {bet: [k for k, _ in sorted(values[bet].items(), key=lambda kv: -kv[1])][:sum(WEB_CAPS[bet])]
            for bet in WEB_CAPS}


def python_arms(horses: list[dict], coefficients: dict) -> dict[str, dict[str, list[str]]]:
    return {"production": tickets(horses, production_roles(horses)),
            "shadow": tickets(horses, stack_roles(horses, coefficients))}


# ------------------------------------------------------------------ SQL
def _coef_sql(coefficients: dict[str, dict[str, float]]) -> str:
    rows = []
    for k, role in enumerate(ROLES, start=1):
        c = coefficients[role]
        others = [o for o in ROLES if o != role]
        rows.append(f"({k}, {c.get('log_market', 0)!r}::float8, {c.get('log_role', 0)!r}::float8, "
                    f"{c.get('log_market_sq', 0)!r}::float8, {ROLES.index(others[0]) + 1}, {c.get(f'log_{others[0]}', 0)!r}::float8, "
                    f"{ROLES.index(others[1]) + 1}, {c.get(f'log_{others[1]}', 0)!r}::float8)")
    return ",\n    ".join(rows)


def report_sql(coefficients: dict, date_from: str, date_to: str, table: str = "rein_race_snapshots") -> str:
    """Read-only query: per race day and bet type, races, points, hit races and payout for both arms.

    Also returns one ``parity`` row per bet type counting races where the
    recomputed production tickets differ from the saved ones.
    """
    for d in (date_from, date_to):
        if len(d) != 10 or d[4] != "-" or d[7] != "-" or not d.replace("-", "").isdigit():
            raise ValueError("dates must be YYYY-MM-DD")
    caps = ", ".join(f"('{t}', {sum(v)})" for t, v in WEB_CAPS.items())
    return f"""
with coef(role, w_market, w_role, w_sq, o1, w_o1, o2, w_o2) as (values
    {_coef_sql(coefficients)}),
caps(bet, cap) as (values {caps}),
pre as (
  select race_id, race_date, payload from {table}
  where slot = 'prestart' and race_id ~ '^[0-9]{{10}}$'
    and race_date between date '{date_from}' and date '{date_to}'
    and payload->'evaluation'->>'roleModel' = 'ready' and payload->'evaluation'->>'tickets' = 'ready'),
races as (
  select p.race_id, p.race_date, p.payload, l.payload->'review' as review
  from pre p join {table} l on l.race_id = p.race_id and l.slot = 'live'
  where l.is_final and (l.payload->'review'->>'isFinished')::boolean
    and coalesce(jsonb_array_length(l.payload->'scratched'), 0) = 0
    and coalesce(jsonb_array_length(l.payload->'review'->'payouts'), 0) > 0),
h0 as (
  select r.race_id, t.ord, (t.x->>'number')::int as num, (t.x->>'gate')::int as gate,
         coalesce((t.x->>'popularity')::float8, 0) as pop,
         array[(t.x->>'firstProbability')::float8, (t.x->>'secondProbability')::float8, (t.x->>'thirdProbability')::float8] as p
  from races r, jsonb_array_elements(r.payload->'horses') with ordinality as t(x, ord)),
h1 as (
  select *, count(*) over w as n, greatest(max(pop) over w, count(*) over w) + 1 as fallback from h0
  window w as (partition by race_id)),
h2 as (
  select *, 1 / greatest(case when pop > 0 then pop else fallback end, 1) as m_raw from h1),
h3 as (
  select race_id, ord, num, gate, k,
         greatest(m_raw, 1e-9) / sum(greatest(m_raw, 1e-9)) over (partition by race_id, k) as m9,
         greatest(p[k], 1e-9) / sum(greatest(p[k], 1e-9)) over (partition by race_id, k) as l9,
         greatest(p[k], 1e-6) / sum(greatest(p[k], 1e-6)) over (partition by race_id, k) as l6
  from h2, generate_series(1, 3) as k),
feat as (
  select a.race_id, a.ord, a.num, a.gate, a.k, a.m9, a.l9,
         ln(greatest(a.m9, {EPS})) as lm,
         ln(a.l6) as lr
  from h3 a),
stack_score as (
  select f.race_id, f.ord, f.k,
         c.w_market * f.lm + c.w_role * f.lr + c.w_sq * f.lm * f.lm + c.w_o1 * o1.lr + c.w_o2 * o2.lr as s
  from feat f join coef c on c.role = f.k
  join feat o1 on o1.race_id = f.race_id and o1.ord = f.ord and o1.k = c.o1
  join feat o2 on o2.race_id = f.race_id and o2.ord = f.ord and o2.k = c.o2),
arms as (
  select 'production' as arm, race_id, ord, num, gate, k, .7 * m9 + .3 * l9 as a from feat
  union all
  select 'shadow', e.race_id, e.ord, f.num, f.gate, e.k, e.e / sum(e.e) over (partition by e.race_id, e.k)
  from (select race_id, ord, k, exp(s - max(s) over (partition by race_id, k)) as e from stack_score) e
  join feat f using (race_id, ord, k)),
wide_roles as (
  select arm, race_id, ord, num, gate,
         max(a) filter (where k = 1) as a1, max(a) filter (where k = 2) as a2, max(a) filter (where k = 3) as a3
  from arms group by arm, race_id, ord, num, gate),
ranked as (
  select *, row_number() over (partition by arm, race_id order by greatest(a1, a2, a3) desc, ord) as rk from wide_roles),
sup2 as (
  select arm, race_id, ord, num, gate,
         greatest(a1, 1e-9) / sum(greatest(a1, 1e-9)) over g as a1,
         greatest(a2, 1e-9) / sum(greatest(a2, 1e-9)) over g as a2,
         greatest(a3, 1e-9) / sum(greatest(a3, 1e-9)) over g as a3
  from ranked where rk <= {SUPPORT}
  window g as (partition by arm, race_id)),
pairs as (
  select a.arm, a.race_id, a.num as n1, b.num as n2, a.gate as g1, b.gate as g2,
         a.a1 * b.a2 / greatest(1 - a.a2, 1e-12) as p
  from sup2 a join sup2 b on a.arm = b.arm and a.race_id = b.race_id and a.num <> b.num),
triples as (
  select x.arm, x.race_id, x.n1, x.n2, c.num as n3,
         x.p * c.a3 / greatest(1 - ai.a3 - bj.a3, 1e-12) as p
  from pairs x
  join sup2 ai on ai.arm = x.arm and ai.race_id = x.race_id and ai.num = x.n1
  join sup2 bj on bj.arm = x.arm and bj.race_id = x.race_id and bj.num = x.n2
  join sup2 c on c.arm = x.arm and c.race_id = x.race_id and c.num not in (x.n1, x.n2)),
cand as (
  select arm, race_id, '単勝' as bet, num::text as sel, a1 as p from sup2
  union all select arm, race_id, '複勝', num::text, a1 + a2 + a3 from sup2
  union all select arm, race_id, '馬単', n1 || '-' || n2, p from pairs
  union all select arm, race_id, '馬連', least(n1, n2) || '-' || greatest(n1, n2), p from pairs
  union all select arm, race_id, '枠連', least(g1, g2) || '-' || greatest(g1, g2), p from pairs where g1 <> g2
  union all select arm, race_id, '三連複', array_to_string(array(select unnest(array[n1, n2, n3]) order by 1), '-'), p from triples
  union all select arm, race_id, 'ワイド', least(n1, n2) || '-' || greatest(n1, n2), p from triples
  union all select arm, race_id, 'ワイド', least(n1, n3) || '-' || greatest(n1, n3), p from triples
  union all select arm, race_id, 'ワイド', least(n2, n3) || '-' || greatest(n2, n3), p from triples),
summed as (select arm, race_id, bet, sel, sum(p) as p from cand group by arm, race_id, bet, sel),
picked as (
  select s.* from (
    select *, row_number() over (partition by arm, race_id, bet order by p desc, sel) as rk from summed) s
  join caps c on c.bet = s.bet where s.rk <= c.cap),
paid_raw as (
  select r.race_id, replace(x->>'type', '3連', '三連') as bet, x->>'selection' as raw, (x->>'payout')::float8 as payout
  from races r, jsonb_array_elements(r.review->'payouts') as x),
paid as (
  select race_id, bet,
         case when bet = '馬単' then array_to_string(nums, '-')
              else array_to_string(array(select unnest(nums) order by 1), '-') end as sel,
         sum(payout) as payout
  from (select race_id, bet, payout,
               array(select v::int from unnest(regexp_split_to_array(raw, '[-→>＞－]')) as v where trim(v) ~ '^[0-9]+$') as nums
        from paid_raw) z
  group by 1, 2, 3),
sold as (select distinct race_id, bet from paid),
per_race as (
  select k.arm, k.race_id, k.bet, count(*) as points, coalesce(sum(p.payout), 0) as returned
  from picked k join sold s using (race_id, bet)
  left join paid p on p.race_id = k.race_id and p.bet = k.bet and p.sel = k.sel
  group by k.arm, k.race_id, k.bet),
saved as (
  select r.race_id, t->>'type' as bet, s.value #>> '{{}}' as sel
  from races r, jsonb_array_elements(r.payload->'tickets') as t,
       jsonb_array_elements(t->'tiers') as tier, jsonb_array_elements(tier->'selections') as s),
parity as (
  select bet, count(*) filter (where differs) as mismatched, count(*) as races from (
    select coalesce(a.race_id, b.race_id) as race_id, coalesce(a.bet, b.bet) as bet,
           a.sels is distinct from b.sels as differs
    from (select race_id, bet, array_agg(sel order by sel) as sels from picked where arm = 'production' group by 1, 2) a
    full join (select race_id, bet, array_agg(sel order by sel) as sels from saved group by 1, 2) b using (race_id, bet)) q
  group by bet)
select 'day' as kind, r.race_date::text as day, x.bet,
       count(*) filter (where x.arm = 'production') as races,
       sum(x.points) filter (where x.arm = 'production') as points_production,
       sum(x.points) filter (where x.arm = 'shadow') as points_shadow,
       count(*) filter (where x.arm = 'production' and x.returned > 0) as hits_production,
       count(*) filter (where x.arm = 'shadow' and x.returned > 0) as hits_shadow,
       sum(x.returned) filter (where x.arm = 'production') as return_production,
       sum(x.returned) filter (where x.arm = 'shadow') as return_shadow
from per_race x join races r using (race_id)
group by r.race_date, x.bet
union all
select 'parity', null, bet, races, mismatched, null, null, null, null, null from parity
order by 1, 2, 3;
"""
