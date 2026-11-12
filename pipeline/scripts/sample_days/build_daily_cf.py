"""Build deployment/data/daily_cf_2024.parquet from the hourly 2024 profiles (T051).

Daily mean capacity factor per region for solar, onshore wind and offshore wind:
one row per region and day, 4,998 regions x 366 days.

Inputs (not in the repo; see pipeline/README.md): the hourly profiles used by
the simulation, 8,784 hours each. They run on local solar time: hour 0 =
2024-01-01 00:00 local solar time (solar as labelled; wind shifted from ERA5 UTC
by round(lon / 15) h in build_wind_profiles.py).
  solar_profiles.parquet      location_id, ts, kwh_per_kw, ...
  wind_profiles_on.parquet    location_id, hour_index, kwh_per_kw
  wind_profiles_off.parquet   location_id, hour_index, kwh_per_kw

Days are therefore local solar days. Offshore is null where a region has no offshore
site (its hourly profile is all zero; matches off_viable = 0 in
voronoi_wind_resource.csv).

Run:
  python3 pipeline/scripts/sample_days/build_daily_cf.py \
      --input-dir workspace/input_data --out deployment/data/daily_cf_2024.parquet
"""
import argparse
import os

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

N_HOURS = 8784
N_DAYS = N_HOURS // 24
START = np.datetime64('2024-01-01T00:00')


def load_matrix(path, time_col):
    """Return (location_ids, hours x locations float64 matrix) for one profile file."""
    t = pq.read_table(path, columns=['location_id', time_col, 'kwh_per_kw'])
    loc = t['location_id'].to_numpy()
    if time_col == 'ts':
        ts = t['ts'].to_numpy().astype('datetime64[h]')
        hour = (ts - START.astype('datetime64[h]')).astype(np.int64)
    else:
        hour = t[time_col].to_numpy().astype(np.int64)
    val = t['kwh_per_kw'].to_numpy().astype(np.float64)
    if hour.min() != 0 or hour.max() != N_HOURS - 1:
        raise SystemExit(f'{path}: hours run {hour.min()}..{hour.max()}, expected 0..{N_HOURS - 1}')
    ids = np.unique(loc)
    col = np.searchsorted(ids, loc)
    m = np.full((N_HOURS, ids.size), np.nan)
    m[hour, col] = val
    if np.isnan(m).any():
        raise SystemExit(f'{path}: missing (location, hour) pairs')
    if len(loc) != N_HOURS * ids.size:
        raise SystemExit(f'{path}: duplicate (location, hour) pairs')
    return ids, m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input-dir', default='workspace/input_data')
    ap.add_argument('--out', default='deployment/data/daily_cf_2024.parquet')
    args = ap.parse_args()

    files = {
        'solar': ('solar_profiles.parquet', 'ts'),
        'wind_on': ('wind_profiles_on.parquet', 'hour_index'),
        'wind_off': ('wind_profiles_off.parquet', 'hour_index'),
    }
    ids = None
    daily = {}
    for name, (fname, time_col) in files.items():
        tech_ids, m = load_matrix(os.path.join(args.input_dir, fname), time_col)
        if ids is None:
            ids = tech_ids
        elif not np.array_equal(ids, tech_ids):
            raise SystemExit(f'{fname}: location ids differ from the solar profile')
        d = m.reshape(N_DAYS, 24, ids.size).mean(axis=1)
        annual_hourly = m.mean(axis=0)
        # Check the values as stored (4 dp, float32): equal-length days, so their
        # mean must match the hourly annual mean to within half a unit of 4 dp.
        stored = np.round(d, 4).astype(np.float32).astype(np.float64)
        worst = np.abs(stored.mean(axis=0) - annual_hourly).max()
        if worst >= 5e-5:
            raise SystemExit(f'{name}: annual mean of stored daily values is off by {worst:.2e}')
        if name == 'wind_off':
            no_site = (m.max(axis=0) == 0)
            d[:, no_site] = np.nan
            print(f'{name}: {int(no_site.sum())} regions without an offshore site set to null')
        daily[name] = d
        print(f'{name}: {ids.size} regions, annual mean CF {np.nanmean(annual_hourly):.4f}')

    n = ids.size
    dates = START.astype('datetime64[D]') + np.arange(N_DAYS)
    loc_col = np.tile(ids.astype(np.int32), N_DAYS)
    date_col = np.repeat(dates, n)
    cols = {
        'location_id': pa.array(loc_col, pa.int32()),
        'date': pa.array(date_col.astype('datetime64[D]'), pa.date32()),
    }
    for name, d in daily.items():
        v = np.round(d.reshape(-1), 4).astype(np.float32)
        cols[name] = pa.array(v, pa.float32(), mask=np.isnan(v))
    table = pa.table(cols)
    # Sorted by date then location, so a month is one contiguous block.
    pq.write_table(table, args.out, compression='zstd', compression_level=19,
                   row_group_size=n * 31, use_dictionary=False)
    print(f'wrote {args.out}: {table.num_rows} rows, {os.path.getsize(args.out) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
