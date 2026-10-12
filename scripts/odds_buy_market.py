"""Strict parsers for saved official final odds; no odds inferred from payouts."""
from collections import defaultdict
import re,unicodedata,itertools
from lxml import html
import numpy as np

UNORDERED={'bracket_quinella','quinella','wide','trio'}
LABELS={'単勝':'win','複勝':'place','枠連':'bracket_quinella','枠連複':'bracket_quinella','枠連単':'bracket_exacta','馬連':'quinella','馬連複':'quinella','馬単':'exacta','馬連単':'exacta','ワイド':'wide','三連複':'trio','3連複':'trio','三連単':'trifecta','3連単':'trifecta'}
ARITY={'win':1,'place':1,'bracket_quinella':2,'bracket_exacta':2,'quinella':2,'exacta':2,'wide':2,'trio':3,'trifecta':3}

def text(n):return ' '.join(n.text_content().split()) if n is not None else ''
def odds_range(s):
 s=unicodedata.normalize('NFKC',s).replace(',','').replace('－','-').strip()
 if not re.fullmatch(r'\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?',s):return None
 a=[float(v) for v in re.findall(r'\d+(?:\.\d+)?',s)]
 return (a[0],a[-1]) if 1<=a[0]<=a[-1] else None

def add(out,bet,selection,value):
 if not value or len(selection)!=ARITY[bet] or any(not 1<=n<=18 for n in selection):return
 if not bet.startswith('bracket') and len(set(selection))!=len(selection):return
 sel=tuple(sorted(selection)) if bet in UNORDERED else tuple(selection)
 old=out[bet].get(sel)
 if old and old!=value:raise ValueError('Conflicting repeated odds')
 out[bet][sel]=value

def parse_jra(payload,bet):
 d=html.fromstring(payload.decode('cp932',errors='replace'));out=defaultdict(dict)
 if bet=='win_place':
  for row in d.xpath('//table[contains(@class,"tanpuku")]//tr'):
   nums=row.xpath('./td[contains(@class,"num")]');a=row.xpath('./td[contains(@class,"odds_tan")]');b=row.xpath('./td[contains(@class,"odds_fuku")]')
   if nums and text(nums[0]).isdigit():
    sel=(int(text(nums[0])),)
    if a:add(out,'win',sel,odds_range(text(a[0])))
    if b:add(out,'place',sel,odds_range(text(b[0])))
  return dict(out)
 table_class={'bracket_quinella':'waku','quinella':'umaren','wide':'wide','exacta':'umatan','trio':'fuku3','trifecta':'tan3'}[bet]
 for table in d.xpath(f'//table[contains(concat(" ",normalize-space(@class)," ")," {table_class} ")]'):
  if bet=='trifecta':prefix=[int(text(n)) for n in table.getparent().xpath('./div[contains(@class,"p_line")]//div[@class="num"]') if text(n).isdigit()]
  else:
   captions=table.xpath('./caption');s=text(captions[0]) if captions else ''
   if bet=='bracket_quinella' and captions:s+=' '.join(captions[0].xpath('.//img/@alt'))
   prefix=[int(n) for n in re.findall(r'\d+',s)]
  if len(prefix)!=ARITY[bet]-1:continue
  for row in table.xpath('./tbody/tr|./tr'):
   cells=row.xpath('./th|./td')
   if len(cells)!=2 or not text(cells[0]).isdigit():continue
   add(out,bet,(*prefix,int(text(cells[0]))),odds_range(text(cells[1])))
 return dict(out)

def parse_nar(payload,bet):
 d=html.fromstring(payload.decode('utf-8-sig',errors='replace'));out=defaultdict(dict)
 if bet=='win_place':
  for table in d.xpath('//table[contains(@class,"odd_popular_table_02")]'):
   if '単勝' not in text(table):continue
   for row in table.xpath('./tbody/tr'):
    cells=row.xpath('./td');a=[text(c) for c in cells]
    if len(a)<6:continue
    # Source table preserves the frame cell even for grouped frames.
    if not a[1].isdigit():continue
    sel=(int(a[1]),);add(out,'win',sel,odds_range(a[3]));add(out,'place',sel,odds_range(a[4]+a[5]))
  return dict(out)
 if bet=='bracket_quinella':
  # Official frame page uses a section title to distinguish ordered/unordered.
  for table in d.xpath('//table'):
   rows=table.xpath('./tbody/tr|./tr');prefix=None
   heading=''
   for anc in table.iterancestors():
    if anc.tag=='ul' and 'odd_horse_number_list' in (anc.get('class') or ''):
     headers=anc.xpath('preceding-sibling::*[1]//h4|preceding-sibling::h4[1]')
     heading=' '.join(text(h) for h in headers);break
   b='bracket_exacta' if '枠連単' in heading else 'bracket_quinella'
   for row in rows:
    cells=row.xpath('./th|./td');a=[text(c) for c in cells]
    if len(a)==1 and a[0].isdigit():prefix=int(a[0])
    elif prefix and len(a)==2 and a[0].isdigit():add(out,b,(prefix,int(a[0])),odds_range(a[1]))
  return dict(out)
 for row in d.xpath('//table//tr'):
  cells=row.xpath('./th|./td')
  if len(cells)<2:continue
  s=unicodedata.normalize('NFKC',text(cells[0])).replace('－','-').replace('→','-')
  if not re.fullmatch(r'\d{1,2}(?:\s*-\s*\d{1,2}){'+str(ARITY[bet]-1)+r'}',s):continue
  sel=tuple(map(int,re.findall(r'\d+',s)));add(out,bet,sel,odds_range(text(cells[1])))
 return dict(out)

def payout_key(row,league):
 if league=='jra':
  bet=str(row['bet_type']);sel=tuple(int(row[k]) for k in ['selection_1','selection_2','selection_3'] if row.get(k) is not None and not __import__('pandas').isna(row[k]));value=float(row['payout_yen_per_100'])
 else:
  bet=LABELS.get(str(row['bet_type']).replace(' ',''))
  if not bet:return None
  s=unicodedata.normalize('NFKC',str(row['combination'])).replace('－','-').replace('→','-')
  if any(k in s for k in ['返還','特払','不成立']):return None
  sel=tuple(map(int,re.findall(r'\d+',s)));value=float(row['payout_yen'])
 if bet not in ARITY or len(sel)!=ARITY[bet] or not np.isfinite(value) or value<=0:return None
 return str(row['race_id']),bet,tuple(sorted(sel)) if bet in UNORDERED else sel,value

def market_probabilities(win,bet,selections,gate,place_n=3):
 """Vectorized Plackett–Luce consistency benchmark, not true win probabilities."""
 numbers=sorted(win);indices={n:i for i,n in enumerate(numbers)};p=np.array([1/win[n] for n in numbers]);p/=p.sum();n=len(p)
 pair=p[:,None]*p[None,:]/(1-p[:,None]);np.fill_diagonal(pair,0)
 denominator=1-p[:,None]-p[None,:]
 tensor=np.divide(pair[:,:,None]*p[None,None,:],denominator[:,:,None],out=np.zeros((n,n,n)),where=denominator[:,:,None]>1e-12)
 for i in range(n):tensor[i,:,i]=0;tensor[:,i,i]=0
 if bet=='win':return np.array([p[indices[s[0]]] for s in selections])
 if bet=='place':
  probs=p+pair.sum(axis=0)
  if place_n==3:probs=probs+tensor.sum(axis=(0,1))
  return np.array([probs[indices[s[0]]] for s in selections])
 if bet in ['exacta','quinella']:matrix=pair if bet=='exacta' else pair+pair.T
 elif bet in ['bracket_exacta','bracket_quinella']:
  matrix=np.zeros((9,9))
  gates=np.array([gate[h] for h in numbers]);np.add.at(matrix,(np.repeat(gates,n),np.tile(gates,n)),pair.ravel())
  if bet=='bracket_quinella':matrix=matrix+matrix.T-np.diag(np.diag(matrix))
  return np.array([matrix[s[0],s[1]] for s in selections])
 elif bet=='wide':
  a=tensor.sum(axis=2);b=tensor.sum(axis=1);c=tensor.sum(axis=0);matrix=a+a.T+b+b.T+c+c.T
 else:
  result=[]
  for sel in selections:
   ids=tuple(indices[h] for h in sel)
   result.append(tensor[ids] if bet=='trifecta' else sum(tensor[v] for v in itertools.permutations(ids)))
  return np.array(result)
 return np.array([matrix[indices[s[0]],indices[s[1]]] for s in selections])
