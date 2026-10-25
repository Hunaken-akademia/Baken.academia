"""Descriptive comparisons, never causal estimates. Output stays outside git."""
import argparse,json
from pathlib import Path
import numpy as np
import pandas as pd

def counts(d):
 return dict(starts=len(d),top3=int(d.finish_position.le(3).sum()),wins=int(d.finish_position.eq(1).sum()),races=int(d.race_id.nunique()),days=int(d.race_date.nunique()))
def run(source,out):
 p=pd.read_parquet(source).drop_duplicates(['race_id','horse_number'])
 p['year']=p.race_date.str[:4]
 p['gate_group']=np.select([p.gate.le(2),p.gate.ge(7)],['内1〜2枠','外7〜8枠'],default='中3〜6枠')
 p['pop_group']=np.select([p.popularity.le(3),p.popularity.le(6),p.popularity.le(9)],['1〜3人気','4〜6人気','7〜9人気'],default='10人気以下')
 profiles=[]
 for (venue,distance),g in p.groupby(['racecourse','distance_m']):
  for center in np.arange(6,13.1,.5):
   near=g.cushion.between(center-.5,center+.5)
   a,b=g[near],g[~near]
   if a.empty:continue
   rows=[]
   for col in ['gate_group','prior_style','pop_group']:
    for label in sorted(g[col].dropna().unique()):
     if label=='unknown':continue
     aa,bb=a[a[col].eq(label)],b[b[col].eq(label)]
     years=[]
     for year in sorted(g.year.unique()):
      x,y=aa[aa.year.eq(year)],bb[bb.year.eq(year)]
      years.append(dict(year=year,near=counts(x),other=counts(y)))
     rows.append(dict(factor=col,label=label,near=counts(aa),other=counts(bb),years=years))
   profiles.append(dict(venue=venue,distance=int(distance),center=float(center),minimum=float(center-.5),maximum=float(center+.5),date_from=g.race_date.min(),date_to=g.race_date.max(),near=counts(a),other=counts(b),rows=rows))
 out.mkdir(parents=True,exist_ok=True)
 (out/'comparisons.json').write_text(json.dumps(dict(version=1,description='同じ競馬場・同じ距離。範囲内と範囲外の事後集計。季節・人気・馬場状態の構成差は未調整。',profiles=profiles),ensure_ascii=False))
 coverage=[dict(venue=v,races=int(g.race_id.nunique()),days=int(g.race_date.nunique()),distances=sorted(map(int,g.distance_m.unique()))) for v,g in p.groupby('racecourse')]
 (out/'coverage.json').write_text(json.dumps(coverage,ensure_ascii=False,indent=2))
 print(json.dumps(dict(profiles=len(profiles),coverage=coverage),ensure_ascii=False))
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--source',type=Path,required=True);a.add_argument('--out',type=Path,required=True);v=a.parse_args();run(v.source,v.out)
