import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from build_graded_trends import build  # noqa: E402


def runner(race_id, date, name, horse, finish, pop, *, cls="", venue="東京", dist=2000, jockey="J1", corner='["5","5","4"]', up=34.0,
           weight=480, age=4, sex="牡", gate=1, status=None):
    return dict(race_id=race_id, race_date=date, racecourse=venue, race_name=name, race_class=cls, race_category="", surface="芝",
                distance_m=dist, going="良", horse_id=horse, horse_name=f"馬{horse}", finish_position=finish, finish_status=status or str(finish),
                popularity=pop, gate=gate, horse_number=gate, sex=sex, age=age, jockey_id=jockey, corner_positions=corner, avg_1f=up,
                horse_weight=weight)


def history():
    rows = []
    for i, year in enumerate(range(2019, 2024)):
        prev = f"{year}-08-20"
        # Prior starts: H1 wins a GI 70 days earlier with the same jockey; H2 runs a 3-win race 4 weeks earlier.
        rows += [runner(f"p{year}a", prev, "札幌記念(GII)", "1", 1, 1, cls="G2", venue="札幌", jockey="J1"),
                 runner(f"p{year}b", f"{year}-09-29", "3勝クラス", "2", 4, 2, venue="中山", jockey="J9"),
                 runner(f"g{year}", f"{year}-06-01", "宝塚記念(GI)", "1", 1, 2, cls="G1", venue="阪神", jockey="J1") if year == 2019 else None]
        race = f"r{year}"
        date = f"{year}-10-27"
        rows += [runner(race, date, "天皇賞(秋)(GI)", "1", 1, 1, cls="G1", jockey="J1", corner='["3","3","2"]', up=33.0, gate=3),
                 runner(race, date, "天皇賞(秋)(GI)", "2", 2, 7, cls="G1", jockey="J2", corner='["10","10","12"]', up=33.5, gate=5, sex="牝"),
                 runner(race, date, "天皇賞(秋)(GI)", "3", 3, 2, cls="G1", jockey="J3", up=34.5, gate=8, age=6),
                 runner(race, date, "天皇賞(秋)(GI)", "4", None, 3, cls="G1", jockey="J4", status="取消", gate=2)]
    return pd.DataFrame([r for r in rows if r])


REFERENCE = {"gradedRaces": [{"key": "天皇賞秋", "name": "天皇賞(秋)", "editions": [
    {"date": f"{y}-10-27", "year": y, "venue": "東京", "grade": "G1", "surface": "芝", "distanceM": 2000, "going": "良"} for y in range(2019, 2024)]}]}


def sections(race):
    return {s["title"]: {r["label"]: r["record"] for r in s["rows"]} for s in race["sections"]}


def test_trend_buckets_use_only_facts_before_each_edition():
    payload = build(history(), REFERENCE, {"1": ["キタサンブラック", "サクラバクシンオー"], "2": ["ディープインパクト", ""]}, 2023)
    race = payload["races"]["天皇賞秋"]
    s = sections(race)
    assert race["editions"] == 5 and race["yearFrom"] == 2019 and race["yearTo"] == 2023
    # Scratched horse 4 is not a starter.
    assert s["人気別"] == {"1番人気": [5, 0, 0, 0], "2番人気": [0, 0, 5, 0], "7〜9番人気": [0, 5, 0, 0]}
    assert race["summary"] == {"favorite": [5, 0, 0, 0], "winnersPopularity4Plus": 0, "maxWinnerPopularity": 1}
    assert s["上がり3ハロンの順位"] == {"上がり1位": [5, 0, 0, 0], "上がり2〜3位": [0, 5, 5, 0]}
    assert s["4コーナーの位置"] == {"4角1〜3番手": [5, 0, 0, 0], "4角4〜7番手": [0, 0, 5, 0], "4角12番手以下": [0, 5, 0, 0]}
    # Horse 3 only runs this race, so from 2020 its previous start is last year's edition.
    assert s["前走のレース"] == {"札幌記念": [5, 0, 0, 0], "3勝クラス": [0, 5, 0, 0], "天皇賞秋": [0, 0, 4, 0]}
    assert s["前走の格"] == {"前走G1": [0, 0, 4, 0], "前走G2": [5, 0, 0, 0], "前走G3以下": [0, 5, 0, 0]}
    # 札幌 08-20 → 10-27 is 68 days (中5〜9週); 09-29 → 28 days (中4週以内).
    assert s["前走からの間隔"] == {"中4週以内": [0, 5, 0, 0], "中5〜9週": [5, 0, 0, 0], "中10週以上": [0, 0, 4, 0]}
    # H1 won the 2019 宝塚記念 before its first edition here.
    assert s["GI勝ちの実績"] == {"GI勝ちあり": [5, 0, 0, 0], "GI勝ちなし": [0, 5, 5, 0]}
    assert s["性別"] == {"牡馬・セン馬": [5, 0, 5, 0], "牝馬": [0, 5, 0, 0]}
    assert s["年齢"]["6歳"] == [0, 0, 5, 0]
    assert s["騎手"] == {"前走と同じ騎手": [5, 0, 4, 0], "乗り替わり": [0, 5, 0, 0]}
    # H1's 2019 edition is its 3rd ride with J1 (after 宝塚記念 and 札幌記念); later years are 4th and more.
    assert s["騎手との相性"]["4戦目以上"][0] == 4 and s["騎手との相性"]["2〜3戦目"][0] == 1
    assert s["東京芝2000mの実績"] == {"3着内あり": [4, 4, 4, 0], "初出走": [1, 1, 1, 0]}
    assert race["sires"][0] == {"name": "キタサンブラック", "record": [5, 0, 0, 0]}
    assert race["damSires"] == [{"name": "サクラバクシンオー", "record": [5, 0, 0, 0]}]
    first = race["results"][0]
    assert first["year"] == 2019 and first["field"] == 3
    assert first["rows"][0] == {"finish": 1, "name": "馬1", "sexAge": "牡4", "sire": "キタサンブラック", "popularity": 1,
                                "prior": "札幌記念 1着", "corner4": 2, "last3fRank": 1}


def test_races_with_fewer_than_five_editions_are_skipped():
    payload = build(history(), REFERENCE, {}, 2022)
    assert payload["races"] == {}
    assert json.dumps(payload, ensure_ascii=False)


def test_recent_runs_are_newest_first_without_scratches():
    from build_graded_trends import recent_runs
    runs = recent_runs(history())
    one = runs["1"]
    # Horse 1: 2019 宝塚記念 plus five 天皇賞(秋) wins (all G1) and five 札幌記念 starts; last five, newest first.
    assert one["g1"] == 6
    assert [r[0] for r in one["runs"]] == ["2023-10-27", "2023-08-20", "2022-10-27", "2022-08-20", "2021-10-27"]
    assert one["runs"][0] == ["2023-10-27", "天皇賞秋", "G1", 1, 1, 2, "J1"]
    assert one["runs"][1][1:3] == ["札幌記念", "G2"]
    # Horse 4 was only ever scratched.
    assert "4" not in runs
