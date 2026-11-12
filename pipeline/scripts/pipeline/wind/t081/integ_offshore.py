"""Integration T081 + T082: put T082's designated-zone offshore rows into the T081 run.

  python3 -I integ_offshore.py --old-wind <T068 work/wind> --zone-dir <T082 zones> \
      --order <full 4,998-row resource csv (row order)> --deployed-in <csv> --deployed-out <csv> \
      --out-wind <run work/wind>

- off_<year>.npy / off_rows.npy: T068's rows, the 19 zone rows replaced by T082's zone profiles,
  zone regions without an offshore profile (394) added; rows kept in resource-row order as
  build_wind_years.py writes them. k_off.npz likewise (k from the zone rows).
- deployed voronoi_wind_resource.csv: in the zone rows only, off_cf_best, off_cf_target,
  off_site_lat/lon, off_k, off_final_cf, off_clamped from zone_resource_rows.csv (%.6f, as the
  file is written) and off_viable = 1. Every other cell keeps its exact text (asserted).
"""
import argparse
import csv
from pathlib import Path

import numpy as np
import pandas as pd

ap = argparse.ArgumentParser()
for k in ("old_wind", "zone_dir", "order", "deployed_in", "deployed_out", "out_wind"):
    ap.add_argument("--" + k.replace("_", "-"), type=Path, required=True)
a = ap.parse_args()

z = pd.read_csv(a.zone_dir / "zone_resource_rows.csv")
zrows = np.load(a.zone_dir / "profiles" / "off_zone_rows.npy")
assert np.array_equal(zrows, z.location_id.to_numpy()) and len(zrows) == 19, len(zrows)
order = pd.read_csv(a.order, usecols=["location_id"]).location_id.to_numpy()
rank = {int(v): i for i, v in enumerate(order)}
old_rows = np.load(a.old_wind / "off_rows.npy")
new_ids = sorted(set(old_rows.tolist()) | set(zrows.tolist()), key=lambda v: rank[v])
new_rows = np.array(new_ids, dtype=old_rows.dtype)
assert np.array_equal(old_rows, np.array([v for v in new_ids if v in set(old_rows.tolist())]))
added = sorted(set(zrows.tolist()) - set(old_rows.tolist()))
a.out_wind.mkdir(parents=True, exist_ok=True)
np.save(a.out_wind / "off_rows.npy", new_rows)
pos_old = {int(v): i for i, v in enumerate(old_rows)}
pos_z = {int(v): i for i, v in enumerate(zrows)}
for y in range(2015, 2025):
    o = np.load(a.old_wind / f"off_{y}.npy")
    zz = np.load(a.zone_dir / "profiles" / f"off_zone_{y}.npy")
    assert zz.shape == (19, o.shape[1]) and zz.dtype == o.dtype
    out = np.empty((len(new_rows), o.shape[1]), dtype=o.dtype)
    for j, v in enumerate(new_rows):
        out[j] = zz[pos_z[int(v)]] if int(v) in pos_z else o[pos_old[int(v)]]
    np.save(a.out_wind / f"off_{y}.npy", out)
k = np.load(a.old_wind / "k_off.npz")
kk = k["k"].copy()
for _, r in z.iterrows():
    kk[rank[int(r.location_id)]] = r.off_k
krows = np.where(np.isfinite(kk))[0]
np.savez(a.out_wind / "k_off.npz", k=kk, rows=krows, location_id=order[krows])
assert np.array_equal(order[krows], new_rows)
print(f"offshore rows {len(old_rows)} -> {len(new_rows)} (added {added}); 19 zone rows replaced")

with open(a.deployed_in, newline="") as f:
    rd = csv.reader(f)
    head = next(rd)
    body = list(rd)
col = {c: i for i, c in enumerate(head)}
zi = z.set_index("location_id")
n_changed = {}
for r in body:
    lid = int(r[0])
    if lid not in zi.index:
        continue
    x = zi.loc[lid]
    new = {"off_cf_best": f"{x.off_cf_best:.6f}", "off_cf_target": f"{x.off_cf_target:.6f}",
           "off_site_lat": f"{x.off_site_lat:.6f}", "off_site_lon": f"{x.off_site_lon:.6f}",
           "off_k": f"{x.off_k:.6f}", "off_final_cf": f"{x.off_final_cf:.6f}",
           "off_clamped": str(int(x.off_clamped)), "off_viable": "1"}
    for c, v in new.items():
        if r[col[c]] != v:
            n_changed[c] = n_changed.get(c, 0) + 1
            r[col[c]] = v
with open(a.deployed_out, "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(head)
    w.writerows(body)
print(f"resource: changed cells {n_changed}")
