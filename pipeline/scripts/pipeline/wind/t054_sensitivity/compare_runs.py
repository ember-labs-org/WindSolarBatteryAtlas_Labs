"""T054: compare a harness run with the shipped data, file by file and region by region.

  python3 -I compare_runs.py --run <run-dir> --shipped <repo>/deployment/data \
      --ws-input <workspace>/input_data [--expected expected_a500.csv]

Without --expected (baseline) everything must be equal. With --expected it
reports, per surface, which regions changed and checks that every region listed
as expect_identical is unchanged in its profile, its summary rows and its daily
column.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

H = 8784


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def profile(p: Path):
    t = pq.read_table(p).to_pandas().sort_values(['location_id', 'hour_index'])
    ids = t.location_id.unique()
    return ids, t.kwh_per_kw.to_numpy().reshape(len(ids), H)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', type=Path, required=True)
    ap.add_argument('--shipped', type=Path, required=True)
    ap.add_argument('--ws-input', type=Path, required=True)
    ap.add_argument('--expected', type=Path)
    a = ap.parse_args()
    data, ws = a.run / 'data', a.run / 'ws'
    exp = pd.read_csv(a.expected) if a.expected else None
    ok = True
    changed = {}

    # profiles
    for tag in ('on', 'off'):
        i1, new = profile(ws / 'input_data' / f'wind_profiles_{tag}.parquet')
        i0, old = profile(a.ws_input / f'wind_profiles_{tag}.parquet')
        assert (i0 == i1).all()
        same = (new == old).all(axis=1)
        changed[tag] = pd.Series(~same, index=i0)
        print(f'profiles {tag}: {same.sum()} of {len(same)} regions identical value for value; '
              f'max abs diff {np.abs(new - old).max():.3g}')
        if exp is None and not same.all():
            ok = False

    # summaries
    print()
    per_region = {'on': [], 'off': []}
    keys = ['location_id', 'solar_gw', 'wind_gw', 'batt_gwh']
    for p in sorted(data.glob('summary_*.parquet')):
        q = a.shipped / p.name
        if sha(p) == sha(q):
            print(f'{p.name}: byte-identical')
            continue
        n = pd.read_parquet(p).sort_values(keys).reset_index(drop=True)
        o = pd.read_parquet(q).sort_values(keys).reset_index(drop=True)
        assert n.shape == o.shape and (n[keys] == o[keys]).all().all(), p.name
        diff = ~((n == o) | (n.isna() & o.isna())).all(axis=1)
        reg = n.loc[diff, 'location_id'].unique()
        surf = 'off' if p.name.startswith('summary_wo') else 'on'
        if p.name == 'summary_w0.parquet':
            surf = 'w0'
        else:
            per_region[surf].append(set(reg.tolist()))
        print(f'{p.name}: bytes differ; {diff.sum()} of {len(n)} rows differ in value, {len(reg)} regions')
        if exp is None and diff.any():
            ok = False

    # daily
    dn = pd.read_parquet(data / 'daily_cf_2024.parquet').sort_values(['location_id', 'date']).reset_index(drop=True)
    do = pd.read_parquet(a.shipped / 'daily_cf_2024.parquet').sort_values(['location_id', 'date']).reset_index(drop=True)
    print(f"\ndaily_cf_2024.parquet: {'byte-identical' if sha(data / 'daily_cf_2024.parquet') == sha(a.shipped / 'daily_cf_2024.parquet') else 'bytes differ'}")
    dchg = {}
    for col in ('solar', 'wind_on', 'wind_off'):
        d = ~((dn[col] == do[col]) | (dn[col].isna() & do[col].isna()))
        reg = set(dn.loc[d, 'location_id'].unique().tolist())
        dchg[col] = reg
        print(f'  {col}: {d.sum()} cells differ, {len(reg)} regions')
        if (exp is None or col == 'solar') and d.any():
            ok = False

    # json manifests
    for name in ('configs.json', 'sample_timestamps.json'):
        if (data / name).exists():
            same = sha(data / name) == sha(a.shipped / name)
            print(f'{name}: SHA-256 {"equal" if same else "DIFFERS"}')
            ok &= same

    # resource csv
    n = pd.read_csv(data / 'voronoi_wind_resource.csv', dtype=str)
    o = pd.read_csv(a.shipped / 'voronoi_wind_resource.csv', dtype=str)
    common = [c for c in o.columns if c in n.columns]
    bad = [c for c in common if not (n[c].fillna('') == o[c].fillna('')).all()]
    print(f'\nvoronoi_wind_resource.csv: {len(common)} shipped columns present; string-identical {len(common)-len(bad)}; '
          f'differing: {", ".join(f"{c} ({(n[c].fillna("") != o[c].fillna("")).sum()})" for c in bad) or "none"}; '
          f'new columns: {[c for c in n.columns if c not in o.columns]}')
    if exp is None and bad:
        ok = False

    if exp is not None:
        print()
        for tag, dcol in (('on', 'wind_on'), ('off', 'wind_off')):
            e = exp.set_index('location_id')[f'{tag}_expect_identical'] == 1
            prof = changed[tag].reindex(e.index)
            summ = set().union(*per_region[tag]) if per_region[tag] else set()
            ids = set(e.index[e])
            bad_p = int(prof[e].sum())
            bad_s = len(ids & summ)
            bad_d = len(ids & dchg[dcol])
            unexpected_same = int((~e & ~prof).sum())
            print(f'{tag}: expected identical {int(e.sum())}; of these changed: profile {bad_p}, summary rows {bad_s}, '
                  f'daily {bad_d}. Regions changed overall: profile {int(prof.sum())}, summary {len(summ)}, daily {len(dchg[dcol])}; '
                  f'regions not in the expected set whose profile is nonetheless unchanged: {unexpected_same}')
            ok &= bad_p == 0 and bad_s == 0 and bad_d == 0
        print(f'solar unchanged in daily: {len(dchg["solar"]) == 0}')
    print('\nRESULT: ' + ('PASS' if ok else 'FAIL'))


if __name__ == '__main__':
    main()
