import pytest
import pandas as pd
from scripts.collect_track_conditions import parse_text
from scripts.analyze_jra_cushion import history_features, race_metrics


def weekly(header, days="金曜日 土曜日 日曜日", cushion="8.1 8.2 8.3"):
    return f"第1日・第2日\n{header}\n芝コースクッション値 {cushion}\n場所 {days}\n芝コース含水率 ゴール前 10 11 12\n(パーセント) 4コーナー 13 14 15\nダートコース含水率 ゴール前 1 2 3\n(パーセント) 4コーナー 4 5 6"


def test_postponed_days_are_not_shifted():
    rows = parse_text(weekly("2019年2月8日から11日", "金曜日 日曜日 月曜日"), 2019, "東京", "source")
    assert [r['date'] for r in rows] == ['2019-02-08', '2019-02-10', '2019-02-11']
    assert rows[1]['cushion'] == 8.2


def test_old_weekday_parentheses_and_missing_day_character():
    rows = parse_text(weekly("2018年7月27日(金)から29日(日)"), 2018, "札幌", "source")
    assert rows[-1]['date'] == '2018-07-29'
    assert parse_text(weekly("2021年4月2~4日"), 2021, "阪神", "source")[0]['date'] == '2021-04-02'


def test_cross_month_and_missing_cells_preserve_columns():
    rows = parse_text(weekly("2021年4月30日~5月2日", cushion="9.2 - 9.5"), 2021, "阪神", "source")
    assert rows[1]['date'] == '2021-05-01' and rows[1]['cushion'] is None
    assert rows[2]['cushion'] == 9.5


def test_source_typo_is_flagged_without_guessing():
    rows = parse_text(weekly("2021年4月2日~4日", cushion="9.2 8..8 9.5"), 2021, "阪神", "source")
    assert rows[1]['cushion'] is None
    assert rows[1]['invalid_tokens'] == ['8..8']


def test_mismatched_columns_fail_instead_of_shifting_dates():
    with pytest.raises(ValueError, match='column mismatch'):
        parse_text(weekly("2021年4月2日~4日", cushion="9.2 9.5"), 2021, "阪神", "source")


def test_jra_history_excludes_current_future_and_stale_starts():
    rows=[]
    for i,day in enumerate(['2024-01-01','2024-01-08','2024-01-15','2025-01-01']):
        for n in range(1,10):
            rows.append(dict(race_id=str(i),race_date=day,horse_id=str(n),horse_number=n,corner_positions='[1,2,3,4]' if i<2 else '[9,9,9,9]',finish_position=n))
    data=pd.DataFrame(rows);out=history_features(data)
    assert set(out.loc[out.race_date.eq('2024-01-15'),'prior_style'])=={'front'}
    assert set(out.loc[out.race_date.eq('2025-01-01'),'prior_style'])=={'unknown'}
    data.loc[data.race_date.ge('2024-01-15'),'finish_position']=9
    alternative=history_features(data)
    assert out.loc[out.race_date.eq('2024-01-15'),'prior_win'].equals(alternative.loc[alternative.race_date.eq('2024-01-15'),'prior_win'])


def test_race_metrics_use_one_winner_and_normalized_scores():
    frame=pd.DataFrame(dict(race_id=['a','a'],race_date=['2026-01-01']*2,finish_position=[1,2]))
    result=race_metrics(frame,[3,1])
    assert result.iloc[0]['hit']==1
    assert result.iloc[0]['brier']==pytest.approx(0.125)
