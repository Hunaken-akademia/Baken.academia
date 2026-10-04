from datetime import date
import pandas as pd
import pytest
from scripts.refresh_rein_history import merge_history


def row(day,horse=1):
    return dict(race_id=f'{day}-race',horse_number=horse,horse_id=f'horse{horse}',race_date=day,finish_position=horse)


def test_merge_preserves_old_rows_and_uses_only_completed_requested_dates():
    base=pd.DataFrame([row('2026-09-13')]);fresh=pd.DataFrame([row('2026-09-19'),row('2026-09-20')])
    result=merge_history(base,fresh,date(2026,9,14),date(2026,9,20))
    assert len(result)==3
    assert result.iloc[0].race_id==base.iloc[0].race_id
    assert result.race_date.max()==pd.Timestamp('2026-09-20')
    with pytest.raises(ValueError,match='Unexpected'):
        merge_history(base,pd.DataFrame([row('2026-09-21')]),date(2026,9,14),date(2026,9,20))


def test_duplicate_or_unidentified_fresh_runners_stop_refresh():
    base=pd.DataFrame([row('2026-09-13')])
    with pytest.raises(ValueError,match='Duplicate'):
        merge_history(base,pd.DataFrame([row('2026-09-19'),row('2026-09-19')]),date(2026,9,14),date(2026,9,20))
    fresh=pd.DataFrame([row('2026-09-19')]);fresh['horse_id']=None
    with pytest.raises(ValueError,match='Missing horse'):
        merge_history(base,fresh,date(2026,9,14),date(2026,9,20))
