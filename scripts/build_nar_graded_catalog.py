"""Read official NAR annual graded calendars, preserving date/venue/grade per year."""
import json,re,unicodedata,urllib.request
from pathlib import Path
from lxml import html
from urllib.parse import urljoin
VENUES=['門別','盛岡','水沢','浦和','船橋','大井','川崎','金沢','笠松','名古屋','園田','姫路','高知','佐賀']

def fetch_year(year):
    url=f'https://www.keiba.go.jp/dirtgraderace/{year}/racelist/index.html'
    payload=urllib.request.urlopen(url,timeout=40).read();doc=html.fromstring(payload.decode('utf-8-sig'))
    entries=[]
    for item in doc.xpath('//li[contains(concat(" ",normalize-space(@class)," ")," js-item ")]'):
        titles=item.xpath('.//h4');ps=item.xpath('.//p')
        if not titles or len(ps)<2:continue
        txt=lambda n:unicodedata.normalize('NFKC',' '.join(n.itertext())).strip()
        name=txt(titles[0]);grade=titles[0].get('class','');detail=txt(ps[-1]);date=re.search(r'(\d+)月(\d+)日',txt(ps[0]));course=re.search(r'('+'|'.join(VENUES)+r')\s*[左右直]+\s*([\d,]+)m',detail)
        if not date or not course:continue
        if grade not in ['g1','g2','g3','jpn1','jpn2','jpn3']:continue
        g=('Jpn' if grade.startswith('jpn') else 'G')+grade[-1]
        links=item.xpath('.//a/@href')
        entries.append({'name':name,'grade':g,'date':f'{year}-{int(date[1]):02d}-{int(date[2]):02d}','venue':course[1],'distanceM':int(course[2].replace(',','')),'sourceUrl':urljoin(url,links[0]) if links else url})
    if len(entries)<30:raise ValueError(f'Incomplete official calendar: {year}, {len(entries)}')
    print(year,len(entries),flush=True);return entries
if __name__=='__main__':
    entries=[e for y in [2026] for e in fetch_year(y)]
    out=Path('rein-web/lib/nar-graded-catalog.json');out.write_text(json.dumps({'version':'nar-official-graded-calendar-v1','sourceUrl':'https://www.keiba.go.jp/dirtgraderace/2026/racelist/index.html','editions':entries},ensure_ascii=False,separators=(',',':'))+'\n')
