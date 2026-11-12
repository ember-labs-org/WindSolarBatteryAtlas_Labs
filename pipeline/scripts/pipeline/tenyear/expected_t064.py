"""T064 expectations, computed BEFORE any T064 fetch or simulation.

Predictor: the T064 ten-year data = T060's ten-year data + the change T061 made to
2024 (same weather, new sites and levels). Per slice row:
    predicted_10y(T064) = data_10y(T060) + [deployment/data(T061) - deployment/data(main 2a29f90)]
and per region profile: predicted ten-year mean = T061 2024 simulated CF x T060's
(ten-year / 2024) ratio at that region (the old site's ratio stands in for moved sites).

  python3 -I expected_t064.py <ref dir with main/ and t060_10y/> <repo deployment/data> <T060 cf_ratio csv> <old resource> <new resource>
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ref, cur, ratio_csv, old_res, new_res = map(Path, sys.argv[1:6])
key = ["location_id", "solar_gw", "wind_gw", "batt_gwh"]
print("== Slice-level prediction (annual_cf, deployed rows) ==")
print(f"{'file':22s} {'rows':>7s} {'rows that move (pred)':>22s} {'mean d(T061 2024)':>18s} {'mean pred T060->T064':>21s}")
for f in sorted(p.name for p in (ref / "main").glob("summary_*.parquet")):
    m = pd.read_parquet(ref / "main" / f).set_index(key).annual_cf
    c = pd.read_parquet(cur / f).set_index(key).annual_cf
    t = pd.read_parquet(ref / "t060_10y" / f).set_index(key).annual_cf
    d = (c - m.reindex(c.index)).astype("float64")
    pred = t.reindex(c.index).astype("float64") + d
    print(f"{f:22s} {len(c):7d} {int((d.abs() > 0).sum()):22d} {d.mean():+18.4f} {(pred - t.reindex(c.index)).mean():+21.4f}")

print("\n== Profile-level prediction (deployed, viable regions) ==")
ratio = pd.read_csv(ratio_csv)
new = pd.read_csv(new_res).set_index("location_id")
old = pd.read_csv(old_res).set_index("location_id")
dep = pd.read_csv(cur / "voronoi_wind_resource.csv").location_id
for t in ("on", "off"):
    r = ratio[ratio.tech == f"wind_{t}"].set_index("location_id")
    n = new.loc[dep]
    v = n[n[f"{t}_viable"] == 1]
    rr = r.mean_over_2024.reindex(v.index)
    pred10 = v[f"{t}_final_cf"] * rr
    o = old.loc[dep]
    pk = lambda df, c: df[f"{t}_site_{c}"].fillna(df["latitude" if c == "lat" else "longitude"])  # parked at centre
    moved = (pk(n, "lat") != pk(o, "lat")) | (pk(n, "lon") != pk(o, "lon"))
    t060_10 = r.cf_mean.reindex(v.index)
    print(f"{t}: viable deployed {len(v)}; fetch points moved (deployed) {int(moved.sum())}, of them viable {int(moved.reindex(v.index).sum())}; "
          f"mean 2024 CF T061 {v[f'{t}_final_cf'].mean():.4f}; predicted ten-year mean {pred10.mean():.4f} "
          f"(T060 ten-year mean, same regions {t060_10.mean():.4f}); predicted median ten-year/2024 {rr.median():.4f}")
