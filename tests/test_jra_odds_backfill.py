from baken_academia.jra_odds_backfill import (
    parse_odds_cname,
    parse_odds_cnames,
    parse_win_odds_page,
)


def test_parse_odds_cnames_from_official_result_action():
    payload = """
    <a onclick="return doAction('/JRADB/accessO.html', 'pw151ou1009202604040120260913Z/36');">オッズ</a>
    """.encode("cp932")
    assert parse_odds_cnames(payload) == ["pw151ou1009202604040120260913Z/36"]
    parsed = parse_odds_cname(parse_odds_cnames(payload)[0])
    assert parsed["race_no"] == 1
    assert parsed["race_date"].isoformat() == "2026-09-13"


def test_parse_win_odds_page_handles_normal_and_scratched_runner():
    payload = """
    <table class="basic narrow-xy tanpuku"><tbody>
      <tr><td class="num">4</td><td class="horse">ウンディーネ</td><td class="odds_tan">2.8</td></tr>
      <tr><td class="num">7</td><td class="horse">取消馬</td><td class="odds_tan">取消</td></tr>
    </tbody></table>
    """.encode("cp932")
    rows = parse_win_odds_page(payload)
    assert rows[0]["horse_number"] == 4
    assert rows[0]["win_odds"] == 2.8
    assert rows[1]["win_odds"] is None
    assert rows[1]["odds_status"] == "取消"
