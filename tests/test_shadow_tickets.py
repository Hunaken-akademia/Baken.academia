import json
import os
import random
import shutil
import subprocess

import pytest

from baken_academia.shadow_tickets import WEB_CAPS, python_arms, report_sql

COEF = {
    "first": {"log_market": 1.1, "log_role": .45, "log_market_sq": .03, "log_second": .1, "log_third": -.05},
    "second": {"log_market": .8, "log_role": .5, "log_market_sq": .02, "log_first": .15, "log_third": .05},
    "third": {"log_market": .6, "log_role": .55, "log_market_sq": .01, "log_first": .05, "log_second": .1},
}


def _race(rng: random.Random, n: int) -> list[dict]:
    pops = list(range(1, n + 1))
    rng.shuffle(pops)
    horses = []
    for i in range(n):
        horses.append({"number": i + 1, "gate": min(8, 1 + i * 8 // n), "popularity": pops[i],
                       **{f"{r}Probability": rng.random() ** 2 + .01 for r in ("first", "second", "third")}})
    return horses


def _winning(horses: list[dict], order: list[int]) -> list[tuple[str, str]]:
    a, b, c = order[:3]
    gate = {h["number"]: h["gate"] for h in horses}
    s = lambda *x: "-".join(map(str, sorted(x)))
    win = [("単勝", str(a)), ("馬単", f"{a}→{b}"), ("馬連", s(a, b)), ("3連複", s(a, b, c))]
    win += [("複勝", str(x)) for x in (a, b, c)]
    win += [("ワイド", s(x, y)) for x, y in ((a, b), (a, c), (b, c))]
    win.append(("枠連", s(gate[a], gate[b])))  # same-gate brackets are sold but never bought by the web rule
    return win


def test_python_arms_respect_web_caps():
    horses = _race(random.Random(1), 14)
    arms = python_arms(horses, COEF)
    for arm in arms.values():
        assert {k: len(v) for k, v in arm.items()} == {k: sum(v) for k, v in WEB_CAPS.items()}
        assert all(len(set(s.split("-"))) == 2 and s.split("-")[0] != s.split("-")[1] for s in arm["枠連"])
    assert arms["production"] != arms["shadow"]


def test_report_rejects_bad_dates():
    with pytest.raises(ValueError):
        report_sql(COEF, "2026-11-01'; drop table x; --", "2026-11-02")


@pytest.mark.skipif(not shutil.which("psql") or not os.environ.get("REIN_TEST_PGHOST"), reason="needs a scratch Postgres")
def test_sql_report_matches_python_reference():
    rng = random.Random(7)
    rows, expected = [], {}
    for r in range(40):
        n = rng.randint(5, 16)
        race_id, day = f"2611{r:06d}", f"2026-11-{1 + r % 4:02d}"
        horses = _race(rng, n)
        arms = python_arms(horses, COEF)
        order = [h["number"] for h in horses]
        rng.shuffle(order)
        payouts = [{"type": t, "selection": sel, "payout": rng.randint(110, 9000)} for t, sel in _winning(horses, order)]
        saved = [{"type": t, "tiers": [{"group": "本線", "selections": arms["production"][t]}]} for t in WEB_CAPS]
        pre = {"horses": horses, "tickets": saved, "evaluation": {"roleModel": "ready", "tickets": "ready"}}
        live = {"review": {"isFinished": True, "payouts": payouts}, "scratched": []}
        rows += [(race_id, day, "prestart", False, pre), (race_id, day, "live", True, live)]
        paid = {}
        for p in payouts:
            bet = p["type"].replace("3連", "三連")
            key = p["selection"].replace("→", "-")
            paid[(bet, key)] = paid.get((bet, key), 0) + p["payout"]
        for arm, tickets in arms.items():
            for bet, sels in tickets.items():
                cell = expected.setdefault((day, bet), {"races": 0, "production": [0, 0, 0], "shadow": [0, 0, 0]})
                returned = sum(paid.get((bet, s), 0) for s in sels)
                cell[arm][0] += len(sels)
                cell[arm][1] += returned > 0
                cell[arm][2] += returned
                if arm == "production":
                    cell["races"] += 1
    values = ",".join("('{}', date '{}', '{}', {}, '{}'::jsonb)".format(
        i, d, s, str(f).lower(), json.dumps(p, ensure_ascii=False).replace("'", "''")) for i, d, s, f, p in rows)
    setup = ("drop table if exists shadow_fixture; create table shadow_fixture "
             "(race_id text, race_date date, slot text, is_final boolean, payload jsonb); "
             f"insert into shadow_fixture values {values};")
    query = report_sql(COEF, "2026-11-01", "2026-11-30", table="shadow_fixture").strip().rstrip(";")
    sql = setup + f"\nselect json_agg(q) from ({query}) q;"
    env = {**os.environ, "PGHOST": os.environ["REIN_TEST_PGHOST"], "PGPORT": os.environ.get("REIN_TEST_PGPORT", "5432")}
    out = subprocess.run(["psql", "-U", os.environ.get("REIN_TEST_PGUSER", "postgres"), "-v", "ON_ERROR_STOP=1", "-qtA"],
                         input=sql, capture_output=True, text=True, env=env, check=True).stdout
    result = json.loads(out)
    parity = [x for x in result if x["kind"] == "parity"]
    assert parity and all(x["points_production"] == 0 for x in parity), parity
    days = {(x["day"], x["bet"]): x for x in result if x["kind"] == "day"}
    assert set(days) == set(expected)
    for key, cell in expected.items():
        got = days[key]
        assert got["races"] == cell["races"], key
        for arm in ("production", "shadow"):
            assert [got[f"points_{arm}"], got[f"hits_{arm}"], got[f"return_{arm}"]] == cell[arm], (key, arm)


def test_summary_reads_query_rows():
    import importlib.util
    spec = importlib.util.spec_from_file_location("shadow_report", "scripts/rein_shadow_report.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    rows = [{"kind": "day", "day": f"2026-11-0{d}", "bet": "ワイド", "races": 20, "points_production": 280,
             "points_shadow": 280, "hits_production": 17, "hits_shadow": 18 + d % 2, "return_production": 20000,
             "return_shadow": 21000} for d in range(1, 9)]
    rows.append({"kind": "parity", "day": None, "bet": "ワイド", "races": 160, "points_production": 0})
    text = mod.summarize(rows, start="2026-11-05")
    assert "影運用（係数固定後）：2026-11-05〜2026-11-08" in text
    assert "振り返り" in text and "すべて一致" in text
    assert "|ワイド|80|85.0%→92.5%|+7.5" in text
