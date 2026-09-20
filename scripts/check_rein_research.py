import pandas as pd
from rein_research import prepare
raw=pd.read_parquet('data/raw/history.parquet')
raw['race_date']=pd.to_datetime(raw.race_date)
cut=pd.Timestamp('2019-03-01')
raw=raw[raw.race_date.lt('2019-04-01')].copy()
a=prepare(raw)
changed=raw.copy();future=changed.race_date.ge(cut)
changed.loc[future,'finish_position']=18
changed.loc[future,'finish_time']='9:59.9'
changed.loc[future,'corner_positions']='["18", "18"]'
changed.loc[future,'lap_times']='[99,99,99]'
b=prepare(changed)
cols=[c for c in a if c.startswith(('prior_','recent3_')) or '_recent90_' in c]+['expected_front_count','relative_early']
pd.testing.assert_frame_equal(a.loc[a.race_date.lt(cut),cols],b.loc[b.race_date.lt(cut),cols])
# Alter the result of a target day and ensure its pre-race features stay identical.
cut=a.race_date.max();changed=raw.copy();target=changed.race_date.eq(cut)
changed.loc[target,'finish_position']=18;changed.loc[target,'finish_time']='9:59.9';changed.loc[target,'corner_positions']='["18"]'
b=prepare(changed)
pd.testing.assert_frame_equal(a.loc[a.race_date.eq(cut),cols],b.loc[b.race_date.eq(cut),cols])
print('PASS: future and target-day outcomes cannot change pre-race research features')
