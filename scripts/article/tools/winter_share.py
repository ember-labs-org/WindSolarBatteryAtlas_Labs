"""T077 round 2: each region's share of its 2024 onshore wind and solar output generated in
November-February, from the atlas's own daily capacity factors (deployment/data/daily_cf_2024.parquet,
the same hourly profiles as the simulation; 2024 is the only year the daily file holds).
Writes scripts/article/tools/data/winter_share_2024.csv, read by model.js for take 3's map.

  python3 -I scripts/article/tools/winter_share.py   (from the repo root)
"""
from pathlib import Path
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[3]
t = pq.read_table(ROOT / 'deployment/data/daily_cf_2024.parquet').to_pandas()
t['nf'] = t['date'].map(lambda d: d.month in (11, 12, 1, 2))
g = t.groupby('location_id')
out = g.apply(lambda d: {'wind_on_nf': d.loc[d.nf, 'wind_on'].sum() / d['wind_on'].sum() if d['wind_on'].sum() > 0 else None,
                         'solar_nf': d.loc[d.nf, 'solar'].sum() / d['solar'].sum() if d['solar'].sum() > 0 else None},
              include_groups=False)
with open(ROOT / 'scripts/article/tools/data/winter_share_2024.csv', 'w') as f:
    f.write('location_id,wind_on_nf,solar_nf\n')
    for lid, v in out.items():
        fmt = lambda x: '' if x is None else f'{x:.4f}'
        f.write(f'{lid},{fmt(v["wind_on_nf"])},{fmt(v["solar_nf"])}\n')
print(len(out), 'regions')
