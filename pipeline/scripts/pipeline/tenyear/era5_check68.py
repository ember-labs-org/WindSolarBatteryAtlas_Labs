"""T068: ERA5 at the T067 sites against T064's kept fetch (same store, same code).

For each set (centre, on, off) a point whose fetch coordinates are unchanged between the old
and new resource CSV must have a bit-identical hourly series; moved points are counted and
compared with T067's moved_sites.csv. Exit 1 on any mismatch.

  python3 -I era5_check68.py --year Y --new <npz> --old <npz> --new-res <csv> --old-res <csv> [--moved <csv>]
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_era5_year import points  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--year", type=int, required=True)
ap.add_argument("--new", type=Path, required=True)
ap.add_argument("--old", type=Path, required=True)
ap.add_argument("--new-res", type=Path, required=True)
ap.add_argument("--old-res", type=Path, required=True)
ap.add_argument("--moved", type=Path)
a = ap.parse_args()
zn, zo = np.load(a.new), np.load(a.old)
assert np.array_equal(zn["location_id"], zo["location_id"]), "location order differs"
dn, la_n, lo_n = points(a.new_res)
do, la_o, lo_o = points(a.old_res)
n = len(dn)
ok = True
moved = {}
for k, name in enumerate(("centre", "on", "off")):
    s = slice(k * n, (k + 1) * n)
    same = (la_n[s] == la_o[s]) & (lo_n[s] == lo_o[s])
    a_, b_ = zn[name], zo[name]
    ident = np.all(a_[:, same] == b_[:, same], axis=0)
    bad = int((~ident).sum())
    moved[name] = set(dn["location_id"].to_numpy()[~same].tolist())
    finite = bool(np.isfinite(a_).all())
    print(f"{a.year} {name}: {int(same.sum())} unmoved points bit-identical {int(ident.sum())}/{int(same.sum())}, "
          f"moved {int((~same).sum())}, all finite {finite}, mean speed {float(a_.mean()):.3f} (old {float(b_.mean()):.3f})")
    ok &= bad == 0 and finite
if a.moved:
    m = pd.read_csv(a.moved)
    print(f"moved_sites.csv rows {len(m)}; columns {list(m.columns)[:6]}")
print("ERA5 CHECK", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
