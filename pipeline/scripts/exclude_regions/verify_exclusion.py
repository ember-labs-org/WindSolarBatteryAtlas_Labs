"""Prove that apply_exclusion.py removed exactly the excluded rows and changed nothing else.

    python3 -I pipeline/scripts/exclude_regions/verify_exclusion.py --old <unfiltered data dir> [--new deployment/data]

For every file in the old folder:
  * parquet: same Arrow schema, same per-column compression and encodings; the new
    table equals the old table minus the excluded location_ids, row for row and value
    for value (pyarrow Table.equals, nulls included); and the old table rewritten with
    the same writer settings reproduces the old file byte for byte (so the settings
    are the pipeline's);
  * CSV: the new file's lines equal the old file's lines minus the excluded regions'
    lines, byte for byte and in order, and exactly the excluded regions were dropped;
  * world.geojson: the new features are the old ones minus the listed polygons, in
    order and byte for byte, and the file parses;
  * anything else: byte-identical (configs.json, sample_timestamps.json, plant lists).
Exit status 1 on any failure.
"""
import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
from apply_exclusion import load_spec  # noqa: E402

fails = []


def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg)
    if not ok:
        fails.append(msg)


def col_meta(path):
    md = pq.ParquetFile(path).metadata
    return [(md.row_group(0).column(i).path_in_schema, md.row_group(0).column(i).compression,
             tuple(sorted(md.row_group(0).column(i).encodings))) for i in range(md.num_columns)]


def parquet(name, old, new, ids):
    to, tn = pq.read_table(old), pq.read_table(new)
    keep = pc.invert(pc.is_in(to['location_id'], pa.array(sorted(ids), pa.int32())))
    want = to.filter(keep)
    daily = name.startswith('daily_')
    buf = io.BytesIO()
    if daily:
        n0 = pc.count_distinct(to['location_id']).as_py()
        pq.write_table(to, buf, compression='zstd', compression_level=19, row_group_size=n0 * 31, use_dictionary=False)
    else:
        pq.write_table(to, buf, compression='zstd', compression_level=9)
    same_writer = buf.getvalue() == old.read_bytes()
    left = set(pc.unique(tn['location_id']).to_pylist()) & ids
    n_new = pc.count_distinct(tn['location_id']).as_py()
    rg = pq.ParquetFile(new).metadata
    rg_ok = (not daily) or all(rg.row_group(i).num_rows == n_new * 31 for i in range(rg.num_row_groups - 1))
    ok = (tn.schema.equals(to.schema, check_metadata=True) and col_meta(old) == col_meta(new)
          and tn.equals(want) and same_writer and not left and rg_ok)
    check(ok, f'{name}: {to.num_rows:,} -> {tn.num_rows:,} rows (dropped {to.num_rows - tn.num_rows:,}); '
              f'schema {"same" if tn.schema.equals(to.schema, check_metadata=True) else "DIFFERS"}, '
              f'compression/encodings {"same" if col_meta(old) == col_meta(new) else "DIFFER"}, '
              f'equals old minus excluded: {tn.equals(want)}, writer reproduces old bytes: {same_writer}, '
              f'row groups ok: {rg_ok}, excluded ids left: {len(left)}')


def csv(name, old, new, ids, sites):
    lo, ln = old.read_bytes().split(b'\n'), new.read_bytes().split(b'\n')
    head = lo[0].decode().split(',')
    if head[0] == 'location_id':
        is_ex = lambda l: int(l.split(b',', 1)[0]) in ids
    else:
        is_ex = lambda l: (np.float32(float(l.split(b',')[0])).item(), np.float32(float(l.split(b',')[1])).item()) in sites
    want = [lo[0]] + [l for l in lo[1:] if not (l.strip() and is_ex(l))]
    dropped = len(lo) - len(want)
    n_ex_old = sum(1 for l in lo[1:] if l.strip() and is_ex(l))
    check(ln == want and n_ex_old == dropped,
          f'{name}: {len(lo) - 2:,} -> {len(ln) - 2:,} rows (dropped {dropped}); lines equal old minus excluded: {ln == want}')
    return dropped


def geojson(old, new, land):
    fo = [l.rstrip(',') for l in old.read_text().split('\n') if l.startswith('{"type":"Feature"')]
    fn = [l.rstrip(',') for l in new.read_text().split('\n') if l.startswith('{"type":"Feature"')]
    want = [l for l in fo if hashlib.sha256(l.encode()).hexdigest() not in land]
    g = json.loads(new.read_text())
    south = [f for f in g['features'] if max(p[1] for ring in f['geometry']['coordinates'] for p in ring) < -60]
    check(fn == want and len(g['features']) == len(fn) and not south and len(fo) - len(fn) == len(land),
          f'world.geojson: {len(fo):,} -> {len(fn):,} polygons (dropped {len(fo) - len(fn)}); others byte-identical '
          f'and in order: {fn == want}; parses: {len(g["features"]) == len(fn)}; polygons left wholly south of 60°S: {len(south)}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--old', type=Path, required=True)
    ap.add_argument('--new', type=Path, default=ROOT / 'deployment' / 'data')
    args = ap.parse_args()
    doc, ids, sites, land = load_spec()
    for f in sorted(args.old.iterdir()):
        n, nf = f.name, args.new / f.name
        if n.startswith('.'):
            continue
        if not nf.exists():
            check(False, f'{n}: missing from {args.new}')
        elif n.endswith('.parquet'):
            parquet(n, f, nf, ids)
        elif n.startswith('voronoi_') and n.endswith('.csv'):
            csv(n, f, nf, ids, sites)
        elif n == 'world.geojson':
            geojson(f, nf, land)
        else:
            same = f.read_bytes() == nf.read_bytes()
            check(same, f'{n}: byte-identical (sha256 {hashlib.sha256(nf.read_bytes()).hexdigest()[:12]})')
    extra = sorted({p.name for p in args.new.iterdir()} - {p.name for p in args.old.iterdir()})
    check(not extra, f'no new files in {args.new}: {extra or "none"}')
    print(f'\n{"ALL PASS" if not fails else f"{len(fails)} FAIL"}')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
