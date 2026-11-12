"""T068 (D-142): put the ten-year k diagnostics into the app's voronoi_wind_resource.csv.

Only <tag>_k, <tag>_raw_cf, <tag>_final_cf and <tag>_clamped change (tag on/off), in rows
whose region has a profile; every other cell keeps its exact text. k, raw_cf and clamped
and final_cf come from solve_k10.py's k10_diag.csv (final_cf computed as build_wind_profiles
does: the mean of the hourly net CF in float64, over all the years k was solved on). Rows are
those with a built profile (work/wind/<tag>_rows.npy).
Numbers are written as %.6f like the shipped file; a region without a profile keeps ''.

  python3 -I update_resource68.py --csv <in> --diag <k10_diag.csv> --root <run dir> --out <out>
"""
import argparse
import csv
from pathlib import Path

import numpy as np
import pandas as pd

ap = argparse.ArgumentParser()
ap.add_argument("--csv", type=Path, required=True)
ap.add_argument("--diag", type=Path, required=True)
ap.add_argument("--root", type=Path, required=True)
ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
diag = pd.read_csv(a.diag).set_index("location_id")
final = {}
for tag in ("on", "off"):
    rows = np.load(a.root / f"work/wind/{tag}_rows.npy")
    final[tag] = dict(zip(rows.tolist(), diag.loc[rows, f"{tag}_final_cf"].tolist()))
with open(a.csv, newline="") as f:
    rd = csv.reader(f)
    head = next(rd)
    body = list(rd)
col = {c: head.index(c) for c in head}
changed = 0
for r in body:
    lid = int(r[col["location_id"]])
    for tag in ("on", "off"):
        if lid not in final[tag]:
            continue
        d = diag.loc[lid]
        new = {f"{tag}_k": f"{d[f'{tag}_k']:.6f}", f"{tag}_raw_cf": f"{d[f'{tag}_raw_cf']:.6f}",
               f"{tag}_final_cf": f"{final[tag][lid]:.6f}", f"{tag}_clamped": str(int(d[f"{tag}_clamped"]))}
        for c, v in new.items():
            if r[col[c]] != v:
                r[col[c]] = v; changed += 1
with open(a.out, "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(head); w.writerows(body)
print(f"{a.out.name}: {len(body)} rows, {changed} cells changed")
