import gzip
import json

import pandas as pd

from baken_academia.jra_pedigree import collect, parse_card, parse_horse, yahoo_race_id
from baken_academia.rein_history import build

# Trimmed from the Yahoo! card for the 2024 Japan Cup (2405050812).
CARD = '''<tr><th>馬番</th><th>父馬名 母馬名 (母父馬名)</th></tr>
<tr><td>2</td><td><a href="/keiba/directory/horse/2019105748/">ブローザホーン</a></td>
<td><p>父： <a href="/keiba/directory/horse/2010104155/">エピファネイア</a></p><p>母： オートクレール</p><p>(母父： デュランダル )</p></td></tr>
<tr><td>3</td><td><a href="/keiba/directory/horse/2019105283/">ドウデュース</a></td>
<td>父： ハーツクライ 母：ダストアンドダイヤモンズ (母父：Vindication)</td></tr>
<tr><td>1</td><td><a href="/keiba/directory/horse/2020190005/">ゴリアット</a></td><td>父： 母： (母父：)</td></tr>'''
HORSE = '''<div class="hr-horsePedigree__gen1st hr-horsePedigree__gen1st--sire"> <a href="/x/">ハーツクライ</a> </div>
<div class="hr-horsePedigree__genSecond hr-horsePedigree__genSecond--sire"> サンデーサイレンス </div>
<div class="hr-horsePedigree__genSecond hr-horsePedigree__genSecond--dam"> アイリッシュダンス </div>
<div class="hr-horsePedigree__genSecond hr-horsePedigree__genSecond--sire"> Vindication </div>'''


def test_yahoo_ids_and_pages_parse():
    assert yahoo_race_id("pw01srl10052024050820241124/75", 12) == "2405050812"
    assert yahoo_race_id("broken", 1) is None
    assert parse_card(CARD) == {"2019105748": ["エピファネイア", "デュランダル"],
                                "2019105283": ["ハーツクライ", "Vindication"], "2020190005": ["", ""]}
    assert parse_horse(HORSE) == ["ハーツクライ", "Vindication"]
    assert parse_horse("<html></html>") is None


def runners(race, date, cname, horses):
    return [dict(race_id=race, race_date=pd.Timestamp(date), race_no=12, source_cname=cname, horse_id=h) for h in horses]


def test_collect_reads_newest_cards_skips_covered_races_and_falls_back_to_horse_pages():
    history = pd.DataFrame(
        runners("old", "2019-11-24", "pw01srl10052019050820191124/00", ["2019105283", "0201510"])
        + runners("new", "2024-11-24", "pw01srl10052024050820241124/75", ["2019105748", "2019105283"])
        + runners("same", "2024-10-01", "pw01srl10052024040120241001/00", ["2019105748"]))
    calls, now = [], [0.0]

    def fetch(url):
        calls.append(url)
        if url.endswith("2405050812"):
            return CARD
        if "directory/horse/201510/" in url:
            return HORSE
        return "<html>error</html>"
    store = {}
    first = collect(history, store, 100, fetch=fetch, delay=(4, 4), clock=lambda: now[0],
                    sleep=lambda s: now.__setitem__(0, now[0] + s))
    # The 2024-10 card is skipped (its horse is already covered); the 2019 card is gone.
    assert calls == ["https://sports.yahoo.co.jp/keiba/race/denma/2405050812",
                     "https://sports.yahoo.co.jp/keiba/race/denma/1905050812",
                     "https://sports.yahoo.co.jp/keiba/directory/horse/201510/"]
    assert store["horses"]["201510"] == ["ハーツクライ", "Vindication"] and store["missingCards"] == ["1905050812"]
    assert first["remaining"] == 0 and first["cards"] == 1 and first["horsePages"] == 1
    calls.clear()
    assert collect(history, store, 100, fetch=fetch, clock=lambda: now[0], sleep=lambda s: None)["requests"] == 0
    # The budget stops the run; the rest waits for the next refresh.
    cut = collect(history, {}, 3, fetch=fetch, delay=(4, 4), clock=lambda: now[0],
                  sleep=lambda s: now.__setitem__(0, now[0] + s))
    assert cut["requests"] == 1 and cut["remaining"] == 1


def test_profile_adds_exact_horse_jockey_records_and_sire_progeny(tmp_path):
    rows = [dict(race_id=f"r{i}", race_date=f"2026-01-{i + 1:02d}", horse_number=1, horse_id="0123", jockey_id="0010",
                 trainer_id="1", finish_position=f, surface="芝", distance_m=1600, racecourse="東京", going="良", gate=1)
            for i, f in enumerate([1, 2, 3, 5])]
    rows.append(dict(rows[0], race_id="r9", horse_id="0456", jockey_id="0020", finish_position=2, distance_m=2400))
    source, output = tmp_path / "h.parquet", tmp_path / "p.json.gz"
    pd.DataFrame(rows).to_parquet(source, index=False)
    build(source, output, pedigree={"123": ["ハーツ クライ", "x"], "456": ["ハーツクライ", ""]}, pairs=True)
    payload = json.loads(gzip.decompress(output.read_bytes()))
    assert payload["horseJockey"] == {"123|10": [4, 1, 1, 1], "456|20": [1, 0, 1, 0]}
    assert payload["sire"]["ハーツクライ"]["n"] == 5
    assert payload["sireSurfaceDistance"]["ハーツクライ|芝|8"]["n"] == 4
    assert payload["meta"]["pedigreeCoverage"] == 1.0
    build(source, output)
    assert not {"horseJockey", "sire"} & set(json.loads(gzip.decompress(output.read_bytes())))
