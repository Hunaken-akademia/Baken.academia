"""Reconcile every exported entity, subgroup, index and shard before publication."""
from pathlib import Path
import argparse,base64,gzip,hashlib,json

def read(p):return json.loads(gzip.decompress(base64.b64decode(p.read_bytes())))
def validate(root,league):
    index=read(root/f'{league}-index.json.gz.b64');seen=set();count=0;group_count=0
    totals={k:0 for k in index['entries']}
    def good(c):return len(c)==4 and all(isinstance(v,int) and v>=0 for v in c) and c[0]>=c[3]>=c[2]>=c[1]
    lookup={kind+':'+e['id']:e for kind,entries in index['entries'].items() for e in entries}
    for file in sorted(root.glob(f'{league}-?.json.gz.b64')):
        raw=gzip.decompress(base64.b64decode(file.read_bytes()));assert len(raw)<40_000_000
        for key,p in json.loads(raw).items():
            assert key not in seen;seen.add(key);assert p['league']==league
            assert good(p['counts']) and good(p['recentCounts']);assert p['recentCounts'][0]<=p['counts'][0]
            assert hashlib.sha256(key.encode()).hexdigest()[0]==file.name[len(league)+1]
            e=lookup[key]
            for k in e:assert e[k]==p[k],(key,k)
            for group,rows in p['groups'].items():
                assert all(good(c) for c in rows.values()),(key,group)
                assert [sum(c[i] for c in rows.values()) for i in range(4)]==p['counts'],(key,group)
                group_count+=len(rows)
            if p.get('editions'):
                assert len({e['date'] for e in p['editions']})==len(p['editions'])
                assert all(e['date']<=index['meta']['dateTo'] for e in p['editions'])
            totals[p['kind']]+=p['counts'][0];count+=1
    assert seen==set(lookup)
    assert totals['horse']==totals['course']==index['meta']['starts']
    assert sum(c['starts'] for c in index['meta']['coverage'].values())==index['meta']['starts']
    assert all(len(entries)==index['meta']['entities'][kind] for kind,entries in index['entries'].items())
    return {'league':league,'entities':count,'conditionRows':group_count,'starts':index['meta']['starts'],'passed':True}
if __name__=='__main__':
    a=argparse.ArgumentParser();a.add_argument('--root',default='rein-web/data/dictionary');a.add_argument('--league',choices=['jra','nar']);p=a.parse_args()
    for league in [p.league] if p.league else ['jra','nar']:print(json.dumps(validate(Path(p.root),league)))
