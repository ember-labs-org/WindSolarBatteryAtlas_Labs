"""T081: B1-style identity of the assembled files against T068's.

  python3 -I check_outputs.py <new dir> <old dir> <t081_diag.csv>
Files with no onshore wind (summary_w0, summary_wo*, addon_large) must be byte-identical. In the
onshore files (summary_w1..w8, addon_wind_mix) only rows of quantile-mapped regions may change,
and every changed row must belong to one.
"""
import sys
from pathlib import Path

import pandas as pd

new, old, diag = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
d = pd.read_csv(diag, keep_default_na=False)
qm = set(d.loc[d.on_method == "qm", "location_id"].astype(int))
ok = True
for f in sorted(old.glob("*.parquet")):
    g = new / f.name
    if not g.exists():
        print("MISSING", f.name); ok = False; continue
    if f.read_bytes() == g.read_bytes():
        print(f"{f.name}: byte-identical"); continue
    if f.name.startswith(("summary_w0", "summary_wo", "addon_large")):
        print(f"{f.name}: DIFFERS (must be identical)"); ok = False; continue
    a, b = pd.read_parquet(f), pd.read_parquet(g)
    if list(a.columns) != list(b.columns) or len(a) != len(b):
        print(f"{f.name}: schema/rows differ"); ok = False; continue
    keys = [c for c in ("location_id", "config", "cfg", "solar_gw", "wind_gw", "batt_gwh", "on", "off") if c in a.columns]
    diff = ~(a.fillna(-9e9) == b.fillna(-9e9)).all(axis=1)
    ch = set(a.loc[diff, "location_id"].astype(int))
    bad = ch - qm
    print(f"{f.name}: {diff.sum()} rows changed in {len(ch)} regions; outside quantile-mapped regions: {len(bad)}")
    ok &= not bad
print("OUTPUT CHECK", "PASS" if ok else "FAIL")
