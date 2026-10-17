"""Build descriptive, exact-count REIN dictionaries from licensed result rows.
No inference scores or betting rules are changed. League namespaces stay separate.
Outputs are private server assets, split into an index and bounded detail shards.
"""
from pathlib import Path
import argparse, base64, gzip, hashlib, json, re, unicodedata
from datetime import datetime, timezone
import numpy as np
import pandas as pd

COURSES={3:'帯広',10:'盛岡',11:'水沢',18:'浦和',19:'船橋',20:'大井',21:'川崎',22:'金沢',23:'笠松',24:'名古屋',27:'園田',28:'姫路',31:'高知',32:'佐賀',36:'門別'}
BASE_GROUPS=['venue','surface','distance','going','turn','gate','venueDistance','season','year','popularity','position']
KINDS=['horse','jockey','trainer','course','graded']
VERSION='rein-dictionary-v1'
ROOT=Path(__file__).resolve().parents[1]

def text(x):
    return '' if x is None or pd.isna(x) else unicodedata.normalize('NFKC',str(x)).strip()

def identifier(x):
    s=text(x)
    if re.fullmatch(r'\d+\.0',s):s=s[:-2]
    return s.lstrip('0') if re.fullmatch(r'\d+',s) else ''

def first_corner(value):
    try:
        a=json.loads(value) if isinstance(value,str) else value
        if not isinstance(a,(list,tuple,np.ndarray)) or not len(a): return None
        m=re.fullmatch(r'\d+',str(a[0]).strip())
        return int(m[0]) if m else None
    except (TypeError,ValueError): return None

def prepare(frame,league,as_of):
    d=frame.copy();d['date']=pd.to_datetime(d.race_date,errors='coerce').dt.strftime('%Y-%m-%d')
    d=d.loc[d.date.notna()&d.date.le(as_of)].copy()
    d=d.drop_duplicates(['race_id','horse_number'],keep='last').sort_values(['date','race_id','horse_number'])
    before=len(d)
    if league=='nar':
        codes=pd.to_numeric(d.get('baba_code',pd.Series(index=d.index,dtype=float)),errors='coerce')
        d['racecourse']=codes.map(COURSES).fillna(d.racecourse)
        d.loc[codes.eq(3),'surface']='ばんえい'
    # Banei has a different race structure; no inferred comparability with flat races.
    d=d.loc[d.surface.ne('ばんえい')].copy()
    f=pd.to_numeric(d.finish_position,errors='coerce');status=d.get('finish_status',pd.Series('',index=d.index)).fillna('').astype(str)
    starters=(f.gt(0)|status.str.contains('中止|失格|タイムオーバー'))&~status.str.contains('取消|除外')
    d=d.loc[starters].copy();f=pd.to_numeric(d.finish_position,errors='coerce')
    # Ignore incomplete/unsettled races lacking a recorded winner.
    winners=set(d.loc[f.eq(1),'race_id']);d=d.loc[d.race_id.isin(winners)].copy();f=pd.to_numeric(d.finish_position,errors='coerce')
    d['n']=1;d['w']=f.eq(1).astype(int);d['p']=f.between(1,2).astype(int);d['t']=f.between(1,3).astype(int)
    for kind in ['horse','jockey','trainer']:
        d[kind+'Id']=d.get(kind+'_id',pd.Series('',index=d.index)).map(identifier)
        d[kind+'Name']=d.get(kind+'_name',pd.Series('',index=d.index)).map(text)
    d['venue']=d.racecourse.map(text).replace('','不明');d['surface']=d.surface.map(text).replace('','不明')
    d['distance']=pd.to_numeric(d.distance_m,errors='coerce').astype('Int64').astype(str).replace('<NA>','不明')
    d['going']=d.going.map(text).replace('','不明')
    direction=d.get('direction',d.get('course_detail',pd.Series('',index=d.index))).fillna('').astype(str)
    d['turn']=np.select([direction.str.contains('左'),direction.str.contains('右'),direction.str.contains('直')],['左回り','右回り','直線'],default='不明')
    gate=pd.to_numeric(d.gate,errors='coerce');d['gate']=gate.where(gate.between(1,8)).astype('Int64').astype(str).replace('<NA>','不明')
    d['venueDistance']=d.venue+'|'+d.surface+'|'+d.distance
    d['year']=d.date.str[:4];months=d.date.str[5:7].astype(int)
    d['season']=np.select([months.isin([3,4,5]),months.isin([6,7,8]),months.isin([9,10,11])],['春（3〜5月）','夏（6〜8月）','秋（9〜11月）'],default='冬（12〜2月）')
    pop=pd.to_numeric(d.get('popularity',pd.Series(index=d.index,dtype=float)),errors='coerce')
    d['popularity']=np.select([pop.eq(1),pop.between(2,3),pop.between(4,6),pop.ge(7)],['1番人気','2〜3番人気','4〜6番人気','7番人気以下'],default='不明')
    corner=pd.to_numeric(d.get('corner_positions',pd.Series('',index=d.index)).map(first_corner),errors='coerce')
    field=d.groupby('race_id').horse_number.transform('size')
    d['position']=np.select([corner.eq(1),corner.gt(1)&corner.le(3),corner.gt(3)&corner.le(field/2),corner.gt(field/2)],['先頭','2〜3番手','中団前','中団後'],default='記録なし')
    gap=pd.to_datetime(d.date).groupby(d.horseId).diff().dt.days
    d['interval']=np.select([gap.le(14),gap.between(15,42),gap.between(43,90),gap.gt(90)],['14日以内','15〜42日','43〜90日','91日以上'],default='前走未収録')
    for kind in ['jockey','trainer']:
        d[kind+'Pair']=np.where(d[kind+'Id'].ne(''),d[kind+'Name']+'（ID:'+d[kind+'Id']+'）','不明')
    d['courseId']=d.venue+'|'+d.surface+'|'+d.distance;d['courseName']=d.venue+' '+d.surface+d.distance+'m'
    return d,{'inputRows':before,'excludedRows':before-len(d),'definition':'取消・除外・ばんえい・勝ち馬未確認のレースを除外。中止・失格は出走数に含む。同着は各馬の確定着順を集計。未収録の出走は含まない。'}

def counts(g):return [int(x) for x in g[['n','w','p','t']].sum()]

def aggregate(d,kind):
    col=kind+'Id';valid=d.loc[d[col].ne('')].copy();profiles={}
    totals=valid.groupby(col,sort=False)[['n','w','p','t']].sum()
    names=valid.groupby(col,sort=False)[kind+'Name'].last()
    dates=valid.groupby(col,sort=False).date.agg(['first','last'])
    recent=valid.groupby(col,sort=False).tail(5 if kind=='horse' else 30).groupby(col,sort=False)[['n','w','p','t']].sum()
    for row in totals.itertuples():
        ident=row[0]
        profiles[ident]={'id':ident,'kind':kind,'name':names[ident] or f'ID {ident}','counts':[int(x) for x in row[1:]],'from':dates.loc[ident,'first'],'to':dates.loc[ident,'last'],'recentCounts':[int(x) for x in recent.loc[ident]],'groups':{}}
    if kind=='horse':
        for r in valid.groupby(col,sort=False).tail(5).iloc[::-1].itertuples():
            profiles[r.horseId].setdefault('recent',[]).append({'date':r.date,'race':text(r.race_name),'course':r.courseName,'finish':int(r.finish_position) if pd.notna(r.finish_position) else None,'status':text(r.finish_status),'jockey':r.jockeyName,'trainer':r.trainerName})
    groups=BASE_GROUPS+(['interval','jockeyPair','trainerPair'] if kind=='horse' else ['trainerPair'] if kind=='jockey' else ['jockeyPair'] if kind=='trainer' else [])
    for group in groups:
        agg=valid.groupby([col,group],observed=True)[['n','w','p','t']].sum()
        for row in agg.itertuples():
            ident,key=row[0];profiles[ident]['groups'].setdefault(group,{})[str(key)]=[int(x) for x in row[1:]]
    return profiles

def editions_from_rows(d):
    editions=[]
    for _,g in d.groupby('race_id',sort=False):
        r=g.iloc[0];w=g.loc[g.w.eq(1)];placed=g.loc[g.t.eq(1)]
        known=lambda col:[int(x) for x in pd.to_numeric(w[col],errors='coerce').dropna()]
        editions.append({'date':r.date,'venue':r.venue,'surface':r.surface,'distanceM':int(r.distance_m),'going':r.going,'grade':r.get('grade',''),'officialName':text(r.race_name),'fieldSize':len(g),'winnerNames':w.horseName.tolist(),'winnerPopularities':known('popularity_raw'),'winnerGates':known('gate'),'placedPopularities':[int(x) for x in pd.to_numeric(placed.popularity_raw,errors='coerce').dropna()],'sourceUrl':text(r.get('source_url',''))})
    return sorted(editions,key=lambda e:e['date'],reverse=True)

def nar_graded_identity(name,known_names):
    title=text(name)
    # Promotional race titles also contain GI / Jpn; a grade substring is insufficient.
    if not re.search(r'第\s*\d+\s*回',title):return None
    match=re.search(r'(Jpn|G)(III|II|I|[123])(?![A-Za-z])',title)
    if not match:return None
    prefix=re.sub(r'第\s*\d+\s*回','',title[:match.start()])
    prefix=re.sub(r'[（(【\[][^(（）)】\]]*[）)】\]]','',prefix)
    prefix=re.sub(r'[\s（(【\[]','',prefix).replace('農林水産大臣賞典','')
    key=next((name for name in sorted(known_names,key=len,reverse=True) if name in prefix),None)
    if not key:return None
    grade=('Jpn' if match[1]=='Jpn' else 'G')+(str(len(match[2])) if not match[2].isdigit() else match[2])
    return key,grade

def graded(d,league):
    rows=d.drop_duplicates('race_id'); assignments={};catalog={}
    if league=='jra':
        # Existing official lineage handles the 2025 reuse of several race names.
        from scripts.rebuild_jra_graded_history import series_key
        ref=json.loads((ROOT/'rein-web/lib/jra-condition-reference.json').read_text())
        for r in ref['gradedRaces']:catalog[r['key']]={'name':r['name'],'grade':r['grades'][0],'editions':r['editions']}
        for r in rows.itertuples():
            key=series_key(text(r.race_name),int(r.year))
            if key in catalog:assignments[r.race_id]=(key,catalog[key]['grade'])
    else:
        cal=json.loads((ROOT/'rein-web/lib/nar-graded-catalog.json').read_text())
        known_names=sorted({e['name'] for e in cal['editions']},key=len,reverse=True)
        known_names+=['TCK女王盃','ジャパンダートダービー','北海道2歳優駿']
        for r in rows.itertuples():
            identity=nar_graded_identity(r.race_name,known_names)
            if not identity:continue
            key,grade=identity
            catalog[key]={'name':key,'grade':grade,'editions':[]}
            assignments[r.race_id]=(key,grade)
    q=d.loc[d.race_id.isin(assignments)].copy()
    q['gradedId']=q.race_id.map(lambda x:assignments[x][0]);q['gradedName']=q.gradedId.map(lambda k:catalog[k]['name'])
    q['grade']=q.race_id.map(lambda x:assignments[x][1])
    profiles=aggregate(q,'graded') if len(q) else {}
    for key,c in catalog.items():
        g=q.loc[q.gradedId.eq(key)]
        actual=editions_from_rows(g) if len(g) else []
        # Official JRA detailed result snapshots fill editions even if the raw name differs.
        bydate={e['date']:e for e in actual}
        for e in c['editions']:
            if e['date']>d.date.max():continue
            if e['date'] not in bydate:
                bydate[e['date']]={**e,'winnerPopularities':[e['winnerPopularity']] if e['winnerPopularity'] else [],'winnerGates':[e['winnerGate']] if e['winnerGate'] else []}
            else:bydate[e['date']].update({'grade':e['grade'],'sourceUrl':e.get('sourceUrl',''),'officialName':e.get('officialName',c['name'])})
        editions=sorted(bydate.values(),key=lambda e:e['date'],reverse=True)
        if not editions:continue
        if key not in profiles:profiles[key]={'id':key,'kind':'graded','name':c['name'],'counts':[0,0,0,0],'from':editions[-1]['date'],'to':editions[0]['date'],'recentCounts':[0,0,0,0],'groups':{}}
        p=profiles[key];p['editions']=editions;p['grade']=c['grade'];p['editionCount']=len(editions)
        p['from']=editions[-1]['date'];p['to']=editions[0]['date']
        p['conditionChanges']=len({(e['venue'],e['surface'],e['distanceM']) for e in editions})>1
    return profiles

def shard_key(key):return hashlib.sha256(key.encode()).hexdigest()[:1]
def encoded(value):return base64.b64encode(gzip.compress(json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode(),mtime=0)).decode()+'\n'

def build(frame,league,out,as_of):
    d,audit=prepare(frame,league,as_of)
    # Preserve numeric final popularity separately; display grouping is categorical.
    raw=frame.drop_duplicates(['race_id','horse_number'],keep='last').set_index(['race_id','horse_number'])
    d['popularity_raw']=pd.MultiIndex.from_frame(d[['race_id','horse_number']]).map(pd.to_numeric(raw.popularity,errors='coerce'))
    if not len(d):raise ValueError('Empty dictionary cannot replace a valid release')
    meta={'version':VERSION,'league':league,'dateFrom':d.date.min(),'dateTo':d.date.max(),'races':int(d.race_id.nunique()),'starts':len(d),'generatedAt':datetime.now(timezone.utc).isoformat(),'definition':audit['definition'],'source': 'JRA公式の保存結果' if league=='jra' else '地方競馬情報サイトの保存結果','sourceUrl':'https://www.jra.go.jp/datafile/seiseki/replay/' if league=='jra' else 'https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/TodayRaceInfoTop','coverage':{str(y):{'races':int(g.race_id.nunique()),'starts':len(g)} for y,g in d.groupby('year')}}
    index={};shards={format(i,'x'):{} for i in range(16)};totals={}
    for kind in KINDS:
        print('Building',league,kind,flush=True)
        profiles=graded(d,league) if kind=='graded' else aggregate(d,kind)
        index[kind]=[]
        for ident,p in profiles.items():
            p['league']=league
            item={k:p[k] for k in ['id','kind','league','name','counts','from','to']}
            if kind=='graded':item.update({'grade':p['grade'],'editionCount':p['editionCount']})
            index[kind].append(item);shards[shard_key(kind+':'+ident)][kind+':'+ident]=p
        totals[kind]=len(profiles)
    meta['entities']=totals
    out.mkdir(parents=True,exist_ok=True)
    (out/f'{league}-index.json.gz.b64').write_text(encoded({'meta':meta,'entries':index}))
    for key,payload in shards.items():(out/f'{league}-{key}.json.gz.b64').write_text(encoded(payload))
    report={**meta,'audit':audit,'encodedBytes':sum(p.stat().st_size for p in out.glob(f'{league}-*.b64'))}
    (out/f'{league}-manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False),flush=True)
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--league',choices=['jra','nar'],required=True);p.add_argument('--output',default='rein-web/data/dictionary');p.add_argument('--as-of',required=True);a=p.parse_args()
    build(pd.read_parquet(a.input),a.league,Path(a.output),a.as_of)
