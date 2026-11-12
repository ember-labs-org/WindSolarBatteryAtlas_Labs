"""Integration T081 + T082: assembled files against task/T081's.

  python3 -I integ_check.py <new data dir> <T081 data dir> <zone_resource_rows.csv>
summary_w0, summary_w1..w8 and addon_large byte-identical; in summary_wo*, addon_wind_mix and
daily_cf_2024 (wind_off only) every changed row belongs to a zone region; daily solar and wind_on
identical; resource CSV changes only in zone rows and only in offshore columns.
"""
import sys
from pathlib import Path

import pandas as pd

new, old, zf = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
zone = set(pd.read_csv(zf).location_id.astype(int))
ok = True
for f in sorted(old.glob("*.parquet")):
    g = new / f.name
    same = f.read_bytes() == g.read_bytes()
    if same:
        print(f"{f.name}: byte-identical"); continue
    if f.name.startswith(("summary_w0", "addon_large")) or (f.name.startswith("summary_w") and not f.name.startswith("summary_wo")):
        print(f"{f.name}: DIFFERS (must be identical)"); ok = False; continue
    a, b = pd.read_parquet(f), pd.read_parquet(g)
    if list(a.columns) != list(b.columns) or len(a) != len(b):
        print(f"{f.name}: schema/rows differ"); ok = False; continue
    if f.name.startswith("daily"):
        for c in ("solar", "wind_on"):
            if not a[c].equals(b[c]):
                print(f"daily: {c} differs"); ok = False
    diff = ~(a.fillna(-9e9) == b.fillna(-9e9)).all(axis=1)
    ch = set(a.loc[diff, "location_id"].astype(int))
    bad = ch - zone
    print(f"{f.name}: {diff.sum()} rows changed in {len(ch)} regions; outside zone regions: {len(bad)}")
    ok &= not bad
a = pd.read_csv(old / "voronoi_wind_resource.csv", dtype=str, keep_default_na=False)
b = pd.read_csv(new / "voronoi_wind_resource.csv", dtype=str, keep_default_na=False)
assert list(a.columns) == list(b.columns) and len(a) == len(b)
d = a != b
rows = set(a.loc[d.any(axis=1), "location_id"].astype(int))
cols = [c for c in a.columns if d[c].any()]
print(f"resource: {len(rows)} rows changed, columns {cols}")
ok &= rows <= zone and all(c.startswith("off_") for c in cols)
print("INTEG CHECK", "PASS" if ok else "FAIL")
