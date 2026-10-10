"""Build every current JRA graded series from published official annual results.

The 2025 lineage rules follow JRA's program-change document. Name reuse is
resolved by year; equal names are never merged across the changed competitions.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin
import json,re,unicodedata
from scripts.enrich_jra_graded_flow import fetch,text,parse_result,BASE

CACHE=Path('/tmp/rein-jra-graded-flow')
SPONSORS=r'^(?:農林水産省賞典|日刊スポーツ賞|スポーツニッポン賞|KBS京都賞|MBS賞|サンケイスポーツ杯|サンケイスポーツ賞|テレビ東京杯|テレビ西日本賞|フジテレビ賞|中日スポーツ賞|北海道新聞杯|報知杯|ローレル競馬場賞|産経賞|夕刊フジ賞|関西テレビ放送賞|読売)'
def name_key(name):
    s=unicodedata.normalize('NFKC',name)
    s=re.sub(r'第\s*\d+\s*回','',s)
    s=re.sub(r'^(?:J[・･.]?\s*)?G\s*(?:[123]|I{1,3})\s*','',s,flags=re.I)
    s=re.sub(SPONSORS,'',s)
    s=re.sub(r'^朝日杯(?=セントライト)','',s);s=re.sub(r'^ラジオNIKKEI杯(?=京都2歳)','',s)
    s=re.sub(r'天皇賞[（(](春|秋)[)）]',r'天皇賞\1',s)
    s=s.replace('弥生賞ディープインパクト記念','弥生賞')
    s=s.replace('東京優駿(日本ダービー)','東京優駿').replace('優駿牝馬(オークス)','優駿牝馬')
    s=re.sub(r'[（(][^()（）]*[)）]','',s)
    for a,b in [('日本ダービー','東京優駿'),('オークス','優駿牝馬'),('アメリカジョッキークラブカップ','AJCC'),('ニュージーランドトロフィー','NZT'),('ニュージーランドT','NZT'),('京王杯スプリングカップ','京王杯SC'),('京王杯スプリングC','京王杯SC'),('フューチュリティステークス','FS'),('ジュベナイルフィリーズ','JF'),('ジュベナイルF','JF'),('フィリーズレビュー','FR'),('フューチュリティS','FS'),('アメリカJCC','AJCC'),('ステークス','S'),('カップ','C'),('トロフィー','T'),('京成杯オータムH','京成杯オータムハンデキャップ'),('東スポ杯2歳S','東京スポーツ杯2歳S')]:s=s.replace(a,b)
    return re.sub(r'\s+','',s)

def series_key(name,year):
    key=name_key(name)
    reused={'愛知杯':'小倉牝馬S','東海S':'プロキオンS','プロキオンS':'東海S','府中牝馬S':'アイルランドT'}
    former={'アイルランドT府中牝馬S':'アイルランドT','京都牝馬S':'愛知杯','マーメイドS':'府中牝馬S','アーリントンC':'チャーチルダウンズC','小倉2歳S':'中京2歳S','小倉サマージャンプ':'小倉ジャンプS'}
    return reused[key] if year<2025 and key in reused else former.get(key,key)

def rows(year):
    doc=fetch(f'{BASE}/datafile/seiseki/replay/{year}/jyusyo.html',CACHE)
    result=[]
    for row in doc.xpath('//tr'):
        cells=row.xpath('./td')
        if len(cells)<8:continue
        day=re.search(r'(\d+)月(\d+)日',text(cells[0]));label=unicodedata.normalize('NFKC',text(cells[1]))
        grade=re.match(r'(J[・･.]?)?G(I{1,3}|[123])(.+)',label)
        if grade: name=grade[3];g=('J・' if grade[1] else '')+'G'+(str(len(grade[2])) if 'I' in grade[2] else grade[2])
        elif label.startswith('重賞') and '葵' in label:name=label.replace('重賞','',1);g='重賞'
        else:continue
        distance=re.search(r'([\d,]+)',text(cells[4]))
        if not day or not distance:continue
        course=text(cells[4]);surface='障害' if course.startswith('障') else '芝' if course.startswith('芝') else 'ダート' if course.startswith('ダ') else None
        if not surface:continue
        links=[a.get('href') for a in row.xpath('.//a[@href]') if 'レース結果' in text(a)]
        result.append({'key':series_key(name,year),'officialName':name,'date':f'{year}-{int(day[1]):02d}-{int(day[2]):02d}','year':year,'venue':text(cells[2]),'grade':g,'surface':surface,'distanceM':int(distance[1].replace(',','')),'url':urljoin(BASE,links[0]) if len(links)==1 else None})
    return result

def result(job):
    doc=fetch(job['url'],CACHE)
    conditions=doc.xpath("//div[contains(concat(' ',normalize-space(@class),' '),' baba ')]//li[@class='turf' or @class='durt']//span[@class='txt']")
    if not conditions:raise ValueError('Official going missing')
    e={**job,'going':text(conditions[0]),'fieldSize':18}
    flow=parse_result(doc,e,job['url'])
    finish_rows=doc.xpath("//tr[td[contains(concat(' ',normalize-space(@class),' '),' place ')]]")
    placed=[]
    for row in finish_rows:
        cell=lambda n:row.xpath(f"./td[contains(concat(' ',normalize-space(@class),' '),' {n} ')]")
        p=text(cell('place')[0])
        if p not in ('1','2','3'):continue
        pops=cell('pop');poptxt=text(pops[0]) if pops else '';pop=int(poptxt) if poptxt.isdigit() else None
        gate=None
        for alt in row.xpath('./td[@class="waku"]//img/@alt'):
            m=re.search(r'枠(\d)',unicodedata.normalize('NFKC',alt))
            if m:gate=int(m[1])
        corners=cell('corner');nums=[int(text(li)) for li in corners[0].xpath('.//li') if text(li).isdigit()] if corners else []
        placed.append({'finish':int(p),'pop':pop,'gate':gate,'first':nums[0] if nums else None})
    wins=[p for p in placed if p['finish']==1]
    known=lambda field:[p[field] for p in wins if p[field] is not None]
    edition={k:e[k] for k in ['date','year','venue','grade','surface','distanceM','going']}
    edition.update({'officialName':job['officialName'],'sourceUrl':job['url'],'fieldSize':flow['fieldSize'],'winnerPopularity':min(known('pop')) if known('pop') else None,'winnerGate':min(known('gate')) if known('gate') else None,'winnerFirstCorner':min(known('first')) if known('first') else None,'placedPopularities':[p['pop'] for p in placed if p['pop'] is not None],'placedFirstCorners':[p['first'] for p in placed if p['first'] is not None]})
    return edition,flow

def main():
    CACHE.mkdir(exist_ok=True)
    current=rows(2026)
    assert len(current)==140 and len({r['key'] for r in current})==140
    all_rows=[r for y in range(2019,2026) for r in rows(y)]
    catalog={r['key']:{'key':r['key'],'name':r['officialName'],'grades':[r['grade']],'editions':[]} for r in current}
    jobs=[r for r in all_rows if r['key'] in catalog and r['url']]
    # Serve the reported case first, then retrieve all remaining published editions.
    jobs.sort(key=lambda r:(r['key']!='アイルランドT',r['year']))
    entries={};failures=[]
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(result,r):r for r in jobs}
        for i,f in enumerate(as_completed(futures),1):
            r=futures[f]
            try:
                e,flow=f.result();catalog[r['key']]['editions'].append(e);entries[f"{r['key']}|{r['date']}"]=flow
            except Exception as ex:failures.append({'key':r['key'],'date':r['date'],'reason':str(ex)})
            if i%40==0:print(json.dumps({'done':i,'total':len(jobs),'accepted':len(entries),'failed':len(failures)}),flush=True)
    for race in catalog.values():race['editions'].sort(key=lambda e:e['date'])
    output={'version':'jra-graded-catalog-v1','sourceUrl':f'{BASE}/datafile/seiseki/replay/2026/jyusyo.html','lineageSourceUrl':'https://www.jra.go.jp/keiba/program/2025/pdf/henkou.pdf','year':2026,'races':[{k:v for k,v in r.items() if k!='editions'} for r in catalog.values()],'failures':failures}
    Path('rein-web/lib/jra-graded-catalog.json').write_text(json.dumps(output,ensure_ascii=False,separators=(',',':'))+'\n')
    Path('/tmp/rein-jra-full-history.json').write_text(json.dumps({'version':'jra-condition-reference-v1','gradedRaces':list(catalog.values())},ensure_ascii=False,separators=(',',':'))+'\n')
    Path('/tmp/rein-jra-full-flow.json').write_text(json.dumps({'version':'jra-graded-flow-v1','generatedAt':datetime.now(timezone.utc).isoformat(),'entries':entries,'failures':failures},ensure_ascii=False,separators=(',',':'))+'\n')
    if failures or any(not r['editions'] for r in catalog.values()):
        raise RuntimeError('Incomplete official history; application datasets were not replaced')
    reference_path=Path('rein-web/lib/jra-condition-reference.json')
    reference=json.loads(reference_path.read_text())
    assert reference['version']=='jra-condition-reference-v1'
    reference['gradedRaces']=list(catalog.values())
    reference_path.write_text(json.dumps(reference,ensure_ascii=False,separators=(',',':'))+'\n')
    Path('rein-web/lib/jra-graded-flow.json').write_text(Path('/tmp/rein-jra-full-flow.json').read_text())
    keys=json.dumps(sorted(catalog),ensure_ascii=False)
    Path('rein-web/lib/graded-race-catalog.ts').write_text('// Generated by scripts/rebuild_jra_graded_history.py from the official JRA schedule.\nimport {jraGradedRaceKey} from "./jra-reference";\nconst keys=new Set(KEYS);\nexport function hasGradedRaceHistory(race:{league?:string;title:string;raceId?:string}) {\n  const year=race.raceId?.length===10?2000+Number(race.raceId.slice(0,2)):race.raceId?.length===12?Number(race.raceId.slice(0,4)):2026;\n  return race.league!=="nar" && keys.has(jraGradedRaceKey(race.title,year));\n}\n'.replace('KEYS',keys))
    print(json.dumps({'races':len(catalog),'editions':len(entries),'missingRaces':[k for k,r in catalog.items() if not r['editions']],'failures':failures},ensure_ascii=False),flush=True)

if __name__=='__main__':main()
