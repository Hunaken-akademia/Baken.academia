"""Collect official JRA daily cushion/moisture PDFs, keeping source provenance.

No value is carried to another day; non-race measurement dates remain labeled.
Missing values and publication-era absence remain null.
"""
from __future__ import annotations
import argparse, concurrent.futures, hashlib, io, json, re, subprocess, threading, time, unicodedata
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urljoin

VENUES={'sapporo':'札幌','hakodate':'函館','fukushima':'福島','niigata':'新潟','tokyo':'東京','nakayama':'中山','chukyo':'中京','kyoto':'京都','hanshin':'阪神','kokura':'小倉'}
BASE='https://www.jra.go.jp/keiba/baba/archive/'
_lock=threading.Lock();_next_request=0.0

def fetch(url: str, path: Path, interval=1.0):
    global _next_request
    if path.exists() and path.stat().st_size>100:return path.read_bytes()
    with _lock:
        pause=max(0,_next_request-time.monotonic());time.sleep(pause);_next_request=time.monotonic()+interval
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.part')
    p=subprocess.run(['curl','--fail','--location','--silent','--show-error','--max-time','60','--retry','1',url,'--output',str(tmp)],capture_output=True)
    if p.returncode:raise RuntimeError(f'HTTP fetch failed for {url}: {p.stderr.decode()[-150:]}')
    b=tmp.read_bytes()
    if url.endswith('.pdf') and not b.startswith(b'%PDF'):raise ValueError('Not PDF: '+url)
    tmp.replace(path);return b

def parse_legacy(text: str, year:int, venue:str, source_url:str):
    """2018–2023 weekly columns. Dates are explicit; no measurement times inferred."""
    text=unicodedata.normalize('NFKC',text)
    pattern=r'(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})(?:日)?(?:\([月火水木金土日]\))?\s*(?:から|~|〜)\s*(?:(\d{4})年)?\s*(?:(\d{1,2})月)?\s*(\d{1,2})日'
    matches=list(re.finditer(pattern,text));rows=[]
    for i,m in enumerate(matches):
        first=date(int(m[1]),int(m[2]),int(m[3]));last=date(int(m[4] or m[1]),int(m[5] or m[2]),int(m[6]))
        count=(last-first).days+1
        if not 1<=count<=7:raise ValueError(f'Unexpected weekly date range: {source_url} {m[0]}')
        block=text[m.end():matches[i+1].start() if i+1<len(matches) else len(text)]
        lines=block.splitlines();moist=[];cushion=None
        header=next((line for line in lines if line.strip().startswith('場所')), '')
        weekdays=re.findall(r'([月火水木金土日])曜日',header)
        dates=[first+timedelta(days=n) for n in range(count)]
        if weekdays:
            # Postponements omit cancelled days. Map the printed weekday columns,
            # rather than assuming every date in the header range was measured.
            mapped=[]
            for weekday in weekdays:
                candidates=[d for d in dates if d.weekday()=='月火水木金土日'.index(weekday)]
                if len(candidates)!=1:raise ValueError('Ambiguous weekly date '+m[0])
                mapped.append(candidates[0])
            dates=mapped;count=len(dates)
        for line in lines:
            if 'クッション値' in line:
                value=line.split('クッション値',1)[1].strip()
                if value:cushion=value.split()
            if re.search(r'ゴール前|4コーナー',line):
                values=re.split(r'ゴール前|4コーナー',line,maxsplit=1)[1].strip().split()
                moist.append(values)
        if len(moist)!=4 or any(len(v)!=count for v in moist) or (cushion is not None and len(cushion)!=count):
            raise ValueError(f'Weekly column mismatch: {source_url} {m[0]}')
        invalid=[]
        def number(value):
            if re.fullmatch(r'[-―—ー]+',value):return None
            if not re.fullmatch(r'\d+(?:\.\d+)?',value):invalid.append(value);return None
            return float(value)
        for col in range(count):
            values=[number(v[col]) for v in moist];cv=number(cushion[col]) if cushion else None
            if any(v is not None and not 0<=v<=100 for v in values) or cv is not None and not 0<cv<30:raise ValueError('Measurement out of range')
            rows.append(dict(league='jra',venue=venue,date=dates[col].isoformat(),race_day=None,course=None,cushion=cv,cushion_time=None,moisture_time=None,turf_moisture_goal=values[0],turf_moisture_turn4=values[1],dirt_moisture_goal=values[2],dirt_moisture_turn4=values[3],source_url=source_url,source_line=m[0],source_format='weekly-columns',invalid_tokens=list(invalid)))
            invalid.clear()
    return rows

def parse_text(text: str, year:int, venue:str, source_url:str):
    rows=[]
    for raw in unicodedata.normalize('NFKC',text).splitlines():
        m=re.search(r'(\d{1,2})月\s*(\d{1,2})日\s*([月火水木金土日])曜日',raw)
        if not m:continue
        day=date(year,int(m[1]),int(m[2])).isoformat()
        times=list(re.finditer(r'\b\d{1,2}:\d{2}\b',raw[m.end():]))
        tail=raw[m.end():]
        if not times:continue
        course=re.search(r'\b([ABCD])\b',tail[:times[0].start()])
        cushion=None;cushion_time=None
        if len(times)>=2:
            value=tail[times[0].end():times[1].start()].strip()
            if re.fullmatch(r'\d+(?:\.\d+)?',value):cushion=float(value)
            cushion_time=times[0].group() if cushion is not None else None
            moisture_time=times[1].group();data=tail[times[1].end():]
        else:
            moisture_time=times[0].group();data=tail[times[0].end():]
        # Four moisture columns can contain dashes. Never shift a later column into a missing one.
        values=re.findall(r'(?<!\w)(?:\d+(?:\.\d+)?|[-－―—]+)(?!\w)',data)
        if len(values)!=4:raise ValueError(f'Expected four moisture cells: {source_url} {raw}')
        moist=[float(x) if re.fullmatch(r'\d+(?:\.\d+)?',x) else None for x in values]
        if cushion is not None and not 0<cushion<30:raise ValueError('Cushion out of range')
        if any(x is not None and not 0<=x<=100 for x in moist):raise ValueError('Moisture out of range')
        rows.append(dict(league='jra',venue=venue,date=day,race_day=bool(re.search(r'第\s*\d+\s*日',raw[:m.start()])),course=course[1] if course else None,cushion=cushion,cushion_time=cushion_time,moisture_time=moisture_time,turf_moisture_goal=moist[0],turf_moisture_turn4=moist[1],dirt_moisture_goal=moist[2],dirt_moisture_turn4=moist[3],source_url=source_url,source_line=raw.strip()))
    return rows or parse_legacy(text,year,venue,source_url)

def collect(out:Path,years,workers=2):
    import pdfplumber
    tasks=[];errors=[];index=[]
    for year in years:
        url=f'{BASE}{year}.html'
        try:
            b=fetch(url,out/'raw'/f'{year}.html');html=b.decode('utf-8',errors='replace')
            links=sorted(set(re.findall(r'href=[\"\']([^\"\']+\.pdf)[\"\']',html,re.I)))
            for link in links:
                full=urljoin(url,link);match=re.search(r'/([a-z]+)(\d+)\.pdf$',full)
                if not match or match[1] not in VENUES:continue
                tasks.append((year,VENUES[match[1]],full,out/'raw'/str(year)/Path(full).name))
            index.append({'year':year,'url':url,'pdfs':sum(t[0]==year for t in tasks)})
        except Exception as e:errors.append({'source':url,'error':str(e)})
    (out/'index.json').write_text(json.dumps(index,ensure_ascii=False,indent=2))
    rows=[];manifests=[]
    def one(task):
        year,venue,url,path=task;b=fetch(url,path)
        with pdfplumber.open(io.BytesIO(b)) as pdf:text='\n'.join(p.extract_text() or '' for p in pdf.pages)
        records=parse_text(text,year,venue,url)
        if not records:raise ValueError('No measurement rows '+url)
        return records,dict(url=url,file=str(path.relative_to(out)),sha256=hashlib.sha256(b).hexdigest(),rows=len(records))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future={pool.submit(one,t):t for t in tasks}
        for n,f in enumerate(concurrent.futures.as_completed(future),1):
            t=future[f]
            try:r,m=f.result();rows.extend(r);manifests.append(m)
            except Exception as e:errors.append({'source':t[2],'error':str(e)});print('ERROR',str(e),flush=True)
            if n%10==0:print(f'{n}/{len(tasks)} PDFs; rows={len(rows)} errors={len(errors)}',flush=True)
    seen={}
    for row in rows:
        key=(row['venue'],row['date'])
        if key in seen and {k:v for k,v in row.items() if not k.startswith('source')}!={k:v for k,v in seen[key].items() if not k.startswith('source')}:
            errors.append({'source':row['source_url'],'error':'Conflicting duplicate '+str(key)});continue
        seen[key]=row
    rows=sorted(seen.values(),key=lambda r:(r['date'],r['venue']))
    (out/'measurements.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
    (out/'manifest.json').write_text(json.dumps(dict(sources=sorted(manifests,key=lambda m:m['url']),errors=errors,years=index,records=len(rows),cushion_records=sum(r['cushion'] is not None for r in rows),race_day_records=sum(r['race_day'] is True for r in rows),unknown_race_day_records=sum(r['race_day'] is None for r in rows)),ensure_ascii=False,indent=2))
    print(json.dumps(dict(pdfs=len(tasks),successful=len(manifests),rows=len(rows),cushion_records=sum(r['cushion'] is not None for r in rows),errors=len(errors))),flush=True)
    return rows

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--start-year',type=int,default=2018);p.add_argument('--end-year',type=int,default=2026);p.add_argument('--workers',type=int,default=2);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True);collect(a.output,range(a.start_year,a.end_year+1),a.workers)
