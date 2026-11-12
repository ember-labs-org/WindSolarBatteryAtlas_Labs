"""Drop the excluded regions (Antarctica, Greenland; T057, D-120) from every
per-region data file in deployment/data, and their land from world.geojson.

    python3 -I pipeline/scripts/exclude_regions/apply_exclusion.py [--data <dir>]

Re-runnable and idempotent: run it after any pipeline step that rewrites a file in
deployment/data. It reads excluded_regions.json (derive_excluded.py) and:

  * summary_*.parquet, daily_cf_2024.parquet: drops rows whose location_id is
    excluded and rewrites the file with the pipeline's own writer settings
    (run3d.py: zstd 9; build_daily_cf.py: zstd 19, no dictionary, one row group per
    31 days of regions). Rewriting an unfiltered file this way reproduces it byte for
    byte, so only the dropped rows differ;
  * voronoi_*.csv: drops the lines of excluded regions and keeps every other line's
    bytes. voronoi_population_2020.csv has no location_id; its rows are matched on
    the site coordinates (float32, as the summary slices store them);
  * world.geojson: drops the listed land polygons (one feature per line, matched by
    the SHA-256 of the line).

It fails on any file in the data folder it does not know, so a new per-region file
cannot slip through unfiltered. configs.json, sample_timestamps.json and the plant
lists are not per region and are left alone.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SPEC = HERE / 'excluded_regions.json'
# Not per region: left alone.
UNTOUCHED = {'configs.json', 'sample_timestamps.json', 'gem_plants.csv', 'fossil_plants.csv'}


def load_spec():
    doc = json.loads(SPEC.read_text())
    ids = {r['location_id'] for r in doc['regions']}
    sites = {(np.float32(r['latitude']).item(), np.float32(r['longitude']).item()) for r in doc['regions']}
    land = {x['sha256'] for x in doc['land']}
    return doc, ids, sites, land


def filter_parquet(path, ids, daily):
    t = pq.read_table(path)
    keep = pc.invert(pc.is_in(t['location_id'], pa.array(sorted(ids), pa.int32())))
    n0 = t.num_rows
    t = t.filter(keep)
    if t.num_rows == n0:
        return n0, 0
    tmp = path.with_suffix('.tmp')
    if daily:
        n_regions = pc.count_distinct(t['location_id']).as_py()
        pq.write_table(t, tmp, compression='zstd', compression_level=19,
                       row_group_size=n_regions * 31, use_dictionary=False)
    else:
        pq.write_table(t, tmp, compression='zstd', compression_level=9)
    tmp.replace(path)
    return n0, n0 - t.num_rows


def filter_csv(path, ids, sites):
    raw = path.read_bytes()
    lines = raw.split(b'\n')
    header = lines[0].decode().rstrip('\r').split(',')
    out, dropped = [lines[0]], 0
    if header[0] == 'location_id':
        key = lambda f: int(f[0]) in ids
    elif header[:2] == ['latitude', 'longitude']:
        key = lambda f: (np.float32(float(f[0])).item(), np.float32(float(f[1])).item()) in sites
    else:
        raise SystemExit(f'{path.name}: no location_id or latitude,longitude columns; cannot filter')
    for ln in lines[1:]:
        if ln.strip() and key(ln.split(b',', 2)):
            dropped += 1
            continue
        out.append(ln)
    if dropped:
        path.write_bytes(b'\n'.join(out))
    return sum(1 for ln in lines[1:] if ln.strip()), dropped


def filter_geojson(path, land):
    text = path.read_text()
    lines = text.split('\n')
    feats = [ln for ln in lines if ln.startswith('{"type":"Feature"')]
    keep = [ln.rstrip(',') for ln in feats if hashlib.sha256(ln.rstrip(',').encode()).hexdigest() not in land]
    if len(keep) == len(feats):
        return len(feats), 0
    head = [ln for ln in lines if not ln.startswith('{"type":"Feature"')]
    # Layout: header line, one feature per line joined by ',\n', closing line.
    assert len(head) == 2 and head[0].endswith('[') and head[1] == ']}', 'unexpected world.geojson layout'
    path.write_text(head[0] + '\n' + ',\n'.join(keep) + '\n' + head[1])
    return len(feats), len(feats) - len(keep)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', type=Path, default=ROOT / 'deployment' / 'data')
    args = ap.parse_args()
    doc, ids, sites, land = load_spec()
    assert len(ids) == len(sites) == doc['counts']['regions']
    report = []
    for f in sorted(args.data.iterdir()):
        n = f.name
        if n in UNTOUCHED or n.startswith('.'):
            continue
        if n.endswith('.parquet') and (n.startswith('summary_') or n == 'daily_cf_2024.parquet'):
            report.append((n, *filter_parquet(f, ids, daily=n.startswith('daily_'))))
        elif n.startswith('voronoi_') and n.endswith('.csv'):
            report.append((n, *filter_csv(f, ids, sites)))
        elif n == 'world.geojson':
            report.append((n, *filter_geojson(f, land)))
        else:
            sys.exit(f'unknown file in {args.data}: {n}. Add it to apply_exclusion.py (filter it, or list it as not per region).')
    for n, total, dropped in report:
        print(f'{n:40s} {total:>9,} rows/features, dropped {dropped:,}')


if __name__ == '__main__':
    main()
