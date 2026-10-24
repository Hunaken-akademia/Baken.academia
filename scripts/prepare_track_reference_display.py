"""Prepare SQL import batches from archived official data (never commit output)."""
import argparse
from collections import defaultdict
import json
from pathlib import Path


def prepare(measurements, references, kochi=()):
    rows = []
    for item in measurements:
        payload = {key: item.get(key) for key in ('cushion', 'cushion_time', 'moisture_time', 'course', 'turf_moisture_goal', 'turf_moisture_turn4', 'dirt_moisture_goal', 'dirt_moisture_turn4', 'source_sha256', 'retrieved_at')}
        payload['kind'] = 'measurement'
        rows.append(dict(league='jra', venue=item['venue'], reference_date=item['date'], source_url=item['source_url'], payload=payload))
    grouped = defaultdict(list)
    for item in references:
        if item['kind'] == 'measurement_missing_year' or not item.get('publication_date'):
            continue
        grouped[item['venue'], item['publication_date'], item['source_url']].append(item)
    for (venue, day, url), items in grouped.items():
        rows.append(dict(league='nar', venue=venue, reference_date=day, source_url=url, payload={'kind':'notice','entries':items}))
    for item in kochi:
        rows.append(dict(league='nar', venue='高知', reference_date=item['date'], source_url=item['source_url'], payload={**item, 'kind':'sand_measurement'}))
    keys = [(r['league'], r['venue'], r['reference_date'], r['source_url']) for r in rows]
    if len(set(keys)) != len(keys):
        raise ValueError('Duplicate reference keys')
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--measurements', type=Path, required=True)
    parser.add_argument('--references', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--kochi', type=Path)
    args = parser.parse_args()
    rows = prepare(json.loads(args.measurements.read_text()), json.loads(args.references.read_text()), json.loads(args.kochi.read_text()) if args.kochi else ())
    args.output.mkdir(parents=True, exist_ok=True)
    for n, start in enumerate(range(0, len(rows), 250)):
        encoded = json.dumps(rows[start:start+250], ensure_ascii=False, separators=(',', ':')).replace("'", "''")
        sql = "insert into public.rein_track_references (league,venue,reference_date,source_url,payload) select league,venue,reference_date,source_url,payload from jsonb_to_recordset('" + encoded + "'::jsonb) as t(league text,venue text,reference_date date,source_url text,payload jsonb) on conflict (league,venue,reference_date,source_url) do update set payload=excluded.payload,imported_at=now();"
        (args.output / f'batch-{n:02}.sql').write_text(sql)
    print(json.dumps({'rows':len(rows),'jra':sum(r['league']=='jra' for r in rows),'nar':sum(r['league']=='nar' for r in rows)},ensure_ascii=False))

if __name__ == '__main__':
    main()
