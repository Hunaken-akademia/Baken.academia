"""Point-in-time feature helpers preserved from the earlier REIN audits.

Research batch arithmetic is not bit-identical to the serving runtime.
Do not use this helper to replace production feature calculation.
"""
from __future__ import annotations
import numpy as np
import pandas as pd

def numeric(s):
    return pd.to_numeric(s, errors='coerce').astype(float)

def prior_rates(x, keys, prefix):
    """Historical rows strictly before the race day, including entity ties."""
    d = x.groupby(keys + ['race_date'], observed=True, dropna=False).agg(
        n=('finish_numeric', 'count'), wins=('won', 'sum'), places=('placed', 'sum'),
        total_finish=('finish_numeric', 'sum')).reset_index()
    d = d.sort_values(keys + ['race_date']).reset_index(drop=True)
    cols = ['n', 'wins', 'places', 'total_finish']
    prior = d.groupby(keys, observed=True, dropna=False)[cols].cumsum() - d[cols]
    d[f'{prefix}_starts'] = prior.n
    d[f'{prefix}_win_rate'] = (prior.wins + 1.5) / (prior.n + 20)
    d[f'{prefix}_top3_rate'] = (prior.places + 4.5) / (prior.n + 20)
    d[f'{prefix}_avg_finish'] = prior.total_finish / prior.n.replace(0, np.nan)
    outcols = [f'{prefix}_{c}' for c in ('starts','win_rate','top3_rate','avg_finish')]
    return x[keys + ['race_date']].merge(d[keys + ['race_date'] + outcols],
        on=keys+['race_date'], how='left', sort=False, validate='many_to_one')[outcols]

def prior_90(x, key):
    d = x.groupby([key, 'race_date'], observed=True, dropna=False).agg(
        n=('horse_id','size'), wins=('won','sum'), places=('placed','sum')).reset_index()
    d = d.sort_values([key,'race_date']).reset_index(drop=True)
    totals = np.zeros((len(d),3))
    for _, idx in d.groupby(key, observed=True, sort=False).indices.items():
        idx = np.asarray(idx)
        sub = d.iloc[idx]
        dates = sub.race_date.to_numpy(dtype='datetime64[D]')
        left = np.searchsorted(dates, dates-np.timedelta64(90,'D'), side='left')
        c = np.vstack([np.zeros((1,3)),np.cumsum(sub[['n','wins','places']].to_numpy(float),axis=0)])
        totals[idx] = c[np.arange(len(idx))] - c[left]
    d[f'{key}_recent90_win'] = (totals[:,1]+1.5)/(totals[:,0]+20)
    d[f'{key}_recent90_place'] = (totals[:,2]+4.5)/(totals[:,0]+20)
    cols = [f'{key}_recent90_win',f'{key}_recent90_place']
    return x[[key,'race_date']].merge(d[[key,'race_date']+cols],on=[key,'race_date'],
        how='left',sort=False,validate='many_to_one')[cols]

def build_features(raw, core):
    """Vectorized deployed _feature_frame_full, checked against original."""
    x = core.prepare_inference_history(raw)
    x = x.sort_values(['horse_id','race_date','race_id','horse_number'],kind='stable').reset_index(drop=True)
    x['finish_numeric'] = numeric(x.finish_position)
    x['wet_key'] = x.going.isin(['重','不良'])
    n = len(x); idx = np.arange(n)
    horse_new = x.horse_id.ne(x.horse_id.shift()).to_numpy()
    group_start = np.maximum.accumulate(np.where(horse_new,idx,0))
    day_new = horse_new | x.race_date.ne(x.race_date.shift()).to_numpy()
    stop = np.maximum.accumulate(np.where(day_new,idx,0))
    have_prior = stop > group_start
    previous = np.maximum(stop-1,0)
    def prior(values):
        a = numeric(values).to_numpy()
        return np.where(have_prior, a[previous], np.nan)
    def mean(values, window):
        a = numeric(values).to_numpy(); valid = ~np.isnan(a)
        c = np.r_[0.0,np.cumsum(np.where(valid,a,0.0))]
        cnt = np.r_[0,np.cumsum(valid)]
        start = np.maximum(group_start,stop-window)
        total=c[stop]-c[start]; count=cnt[stop]-cnt[start]
        return np.divide(total,count,out=np.full(n,np.nan),where=count>0)
    f = pd.DataFrame(index=x.index)
    for col in core.CATEGORICAL: f[col] = x[col]
    for col in ('distance_m','horse_number','gate'): f[col] = numeric(x[col])
    for col in ('age','weight_carried','horse_weight'): f[col] = numeric(x[col]).replace(0,np.nan)
    f['horse_weight_change'] = numeric(x.horse_weight_change)
    field = x.groupby('race_id',observed=True).horse_id.transform('size').astype(float)
    f['field_size'] = field
    f['horse_number_pct'] = f.horse_number / field
    f['gate_pct'] = f.gate / f.gate.groupby(x.race_id,observed=True).transform('max').clip(lower=1)
    f['weight_carried_vs_field'] = f.weight_carried - f.weight_carried.groupby(x.race_id,observed=True).transform('mean')
    f['horse_weight_vs_field'] = f.horse_weight - f.horse_weight.groupby(x.race_id,observed=True).transform('mean')
    for keys,prefix in [(['horse_id'],'horse'),(['jockey_id'],'jockey'),(['trainer_id'],'trainer'),
        (['horse_id','surface'],'horse_surface'),(['horse_id','distance_bucket'],'horse_distance'),
        (['horse_id','racecourse'],'horse_course')]:
        f = pd.concat([f,prior_rates(x,keys,prefix)],axis=1)
    wet = prior_rates(x,['horse_id','wet_key'],'horse_wet_prior')
    f['horse_wet_prior_starts'] = wet.horse_wet_prior_starts
    f['horse_wet_prior_top3_rate'] = wet.horse_wet_prior_top3_rate
    days=x.race_date.to_numpy(dtype='datetime64[D]').astype('int64')
    f['days_since_last_start'] = np.where(have_prior,days-days[previous],np.nan)
    f['distance_change_m'] = f.distance_m-prior(x.distance_m)
    f['same_surface_as_last'] = np.where(have_prior,x.surface.to_numpy()==x.surface.to_numpy()[previous],False).astype(float)
    f['same_course_as_last'] = np.where(have_prior,x.racecourse.to_numpy()==x.racecourse.to_numpy()[previous],False).astype(float)
    f['horse_recent5_avg_finish'] = mean(x.finish_numeric,5)
    f['horse_recent5_win_rate'] = mean(x.won,5)
    f['horse_recent5_top3_rate'] = mean(x.placed,5)
    for position in (1,2,3):
        for w in (5,10):
            f[f'history_exact_{position}_last{w}'] = mean(x.finish_numeric.eq(position).astype(float),w)
    for signal in core.SIGNALS:
        f[f'prior_{signal}'] = prior(x[signal])
        f[f'recent3_{signal}'] = mean(x[signal],3)
    for key in ('jockey_id','trainer_id'): f = pd.concat([f,prior_90(x,key)],axis=1)
    f['class_tier'] = x.race_class.map(core.CLASS_TIER).astype(float)
    f['prior_class_tier'] = prior(x.class_tier_result)
    f['class_change'] = f.class_tier-f.prior_class_tier
    f['class_rise'] = f.class_change.clip(lower=0)
    f['class_drop'] = (-f.class_change).clip(lower=0)
    ct=x.class_tier_result.to_numpy(float); recentmax=np.full(n,np.nan)
    for j in range(1,6):
        valid=stop-j>=group_start
        candidate=np.where(valid,ct[np.maximum(stop-j,0)],np.nan)
        recentmax=np.fmax(recentmax,candidate)
    f['recent5_max_class']=recentmax
    f['class_vs_recent_max']=f.class_tier-f.recent5_max_class
    f['prior_distance_m']=prior(x.distance_m)
    f['recent3_distance_m']=mean(x.distance_m,3)
    f['distance_abs_change']=(f.distance_m-f.prior_distance_m).abs()
    f['stretching_out']=(f.distance_m-f.prior_distance_m).clip(lower=0)
    f['shortening']=(f.prior_distance_m-f.distance_m).clip(lower=0)
    f['distance_vs_recent3']=f.distance_m-f.recent3_distance_m
    for signal in ('closing3f_relative','closing3f_z'):
        f[f'prior_{signal}']=prior(x[signal])
        for w in (3,5): f[f'recent{w}_{signal}']=mean(x[signal],w)
    f['recent3_result_strength']=mean(x.result_strength,3)
    early=f.prior_early_pct
    f['expected_front_count']=early.le(.25).groupby(x.race_id,observed=True).transform('sum').astype(float)
    f['relative_early']=early-early.groupby(x.race_id,observed=True).transform('mean')
    f['front_style']=early.le(.25).astype(float)
    f['stalk_style']=early.between(.25,.50,inclusive='right').astype(float)
    f['closer_style']=early.gt(.50).astype(float)
    f['front_pressure_count']=f.expected_front_count
    f['front_pressure_share']=f.front_pressure_count/field
    f['known_style_share']=early.groupby(x.race_id,observed=True).transform('count')/field
    f['front_under_pressure']=f.front_style*f.front_pressure_share
    f['closer_pressure_help']=f.closer_style*f.front_pressure_share
    f['relative_late']=f.prior_late_pct-f.prior_late_pct.groupby(x.race_id,observed=True).transform('mean')
    f['closing_pressure_fit']=-f.recent3_closing3f_z*f.front_pressure_share
    for col in ('recent3_speed_relative','recent3_closing3f_z','horse_win_rate','horse_top3_rate','horse_recent5_avg_finish','recent3_result_strength'):
        v=f[col]; g=v.groupby(x.race_id,observed=True)
        f[f'{col}_field_rank']=g.rank(pct=True)
        f[f'{col}_field_gap']=v-g.transform('mean')
    for col in core.CATEGORICAL: f[col]=f[col].fillna('__missing__').astype('category')
    return x,f

def prior_context_stats(x: pd.DataFrame, keys: list[str], prefix: str) -> pd.DataFrame:
    """Point-in-time jockey statistics, adjusted for historical popularity."""
    columns = keys + ["race_date"]
    day = (
        x.groupby(columns, observed=True, dropna=False)
        .agg(
            n=("horse_id", "size"),
            wins=("won", "sum"),
            places=("placed", "sum"),
            win_resid=("market_win_resid", "sum"),
            top3_resid=("market_top3_resid", "sum"),
            rank_surprise=("rank_surprise", "sum"),
        )
        .reset_index()
        .sort_values(columns)
        .reset_index(drop=True)
    )
    values = ["n", "wins", "places", "win_resid", "top3_resid", "rank_surprise"]
    prior = day.groupby(keys, observed=True, dropna=False)[values].cumsum() - day[values]
    day[f"{prefix}_starts"] = prior["n"]
    day[f"{prefix}_win_rate"] = (prior["wins"] + 1.5) / (prior["n"] + 20.0)
    day[f"{prefix}_top3_rate"] = (prior["places"] + 4.5) / (prior["n"] + 20.0)
    day[f"{prefix}_win_edge"] = prior["win_resid"] / (prior["n"] + 50.0)
    day[f"{prefix}_top3_edge"] = prior["top3_resid"] / (prior["n"] + 50.0)
    day[f"{prefix}_rank_edge"] = prior["rank_surprise"] / (prior["n"] + 50.0)
    out = [
        f"{prefix}_starts",
        f"{prefix}_win_rate",
        f"{prefix}_top3_rate",
        f"{prefix}_win_edge",
        f"{prefix}_top3_edge",
        f"{prefix}_rank_edge",
    ]
    return x[columns].merge(
        day[columns + out], on=columns, how="left", sort=False, validate="many_to_one"
    )[out]

def add_context_jockey_features(x: pd.DataFrame, base: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    z = x.copy()
    field = z.groupby("race_id", observed=True)["horse_id"].transform("size").astype(float)
    inv = 1.0 / pd.to_numeric(z["popularity"], errors="coerce").clip(lower=1.0)
    market_share = inv / inv.groupby(z["race_id"], observed=True).transform("sum")
    z["market_win_resid"] = z["won"].astype(float) - market_share
    z["market_top3_resid"] = z["placed"].astype(float) - (3.0 * market_share).clip(upper=1.0)
    z["rank_surprise"] = (
        pd.to_numeric(z["popularity"], errors="coerce")
        - pd.to_numeric(z["finish_numeric"], errors="coerce")
    ) / field
    z["going_group"] = np.where(z["going"].isin(["重", "不良"]), "wet", "dry")

    specs = [
        (["jockey_id", "racecourse", "surface"], "jockey_course_surface"),
        (["jockey_id", "distance_bucket", "surface"], "jockey_distance_surface"),
        (["jockey_id", "going_group", "surface"], "jockey_going_surface"),
    ]
    additions = []
    out = base.copy()
    for keys, prefix in specs:
        frame = prior_context_stats(z, keys, prefix)
        for column in frame:
            out[column] = pd.to_numeric(frame[column], errors="coerce").astype("float32")
            additions.append(column)
    return out, additions

def make_cohort(x, f):
    q=x.loc[x.surface.isin(['芝','ダート'])].copy()
    q['popularity']=pd.to_numeric(q.popularity,errors='coerce')
    sizes=q.groupby('race_id',observed=True).size()
    invalid=q.loc[~np.isfinite(q.popularity)|q.popularity.lt(1)|q.popularity.gt(q.race_id.map(sizes)),'race_id'].unique()
    counts=q.groupby('race_id',observed=True).finish_numeric.agg(lambda a:all(a.eq(k).sum()==1 for k in (1,2,3)))
    keep=sizes.index[(sizes>5)&counts.reindex(sizes.index)&~sizes.index.isin(invalid)]
    ids=q.loc[q.race_id.isin(keep)].sort_values(['race_date','race_id','horse_number']).index
    return x.loc[ids].reset_index(drop=True),f.loc[ids].reset_index(drop=True)

