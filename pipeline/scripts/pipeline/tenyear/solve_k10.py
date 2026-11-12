"""T068 (D-142): solve the wind level multiplier k on the ten-year mean.

Same construction as build_wind_years.py's 2024 solve (density correction, power curve by
IEC class, 12% losses, the shipped solve_k with its 0.6-1.8 cap), but the speed series is
every year in --years joined end to end, so k makes the mean CF over all those hours equal
the site's target. With --years 2024 this is exactly the T064/T061 construction (identity
check against a kept k_<tag>.npz).

Writes <out>/k_<tag>.npz (k, rows, location_id: the format build_wind_years.py reads with
--k-fixed) and <out>/k10_diag.csv: location_id, <tag>_k, <tag>_raw_cf (mean net CF at k=1),
<tag>_final_cf (mean net CF at k), <tag>_clamped, over the same hours.

  python3 -I solve_k10.py --repo <wt> --resource <full resource csv> --era5 <dir> \
      [--speeds2024 <npz>] --years 2015-2024 --out work/wind --procs 5
"""
from __future__ import annotations

import argparse
import sys
import time
from multiprocessing import get_context
from pathlib import Path

import numpy as np
import pandas as pd

LOSSES = 0.12
RHO0 = 1.225
G = {}


def _solve(i):
    curve, v, target = G["curve"][i], G["sp"][:, i].astype("float64"), G["target"][i]
    v = v * (G["dens"][i] / RHO0) ** (1.0 / 3.0)
    if not np.isfinite(v).all() or v.max() <= 0:
        return i, np.nan, np.nan, np.nan, 0
    k, clamped = G["solve_k"](v, curve, float(target) / G["keep"])
    raw = float(curve.output(v).mean()) * G["keep"]
    fin = float((curve.output(v * k) * G["keep"]).mean())   # as build_wind_profiles: mean of the hourly net CF
    return i, k, raw, fin, int(clamped)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--resource", type=Path, required=True)
    ap.add_argument("--era5", type=Path, required=True, help="dir with era5_speed_<year>.npz")
    ap.add_argument("--speeds2024", type=Path, help="2024 npz if not in --era5")
    ap.add_argument("--years", default="2015-2024")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--procs", type=int, default=5)
    a = ap.parse_args()
    sys.path.insert(0, str(a.repo / "pipeline"))
    from scripts.pipeline.wind.power_curves import CURVES  # noqa
    from scripts.pipeline.wind.build_wind_profiles import solve_k  # noqa
    y0, _, y1 = a.years.partition("-")
    years = list(range(int(y0), int(y1 or y0) + 1))
    df = pd.read_csv(a.resource)
    ids = df["location_id"].to_numpy()
    n = len(df)
    a.out.mkdir(parents=True, exist_ok=True)
    diag = pd.DataFrame({"location_id": ids})
    t0 = time.time()
    for tag in ("on", "off"):
        parts = []
        for y in years:
            p = a.speeds2024 if (y == 2024 and a.speeds2024) else a.era5 / f"era5_speed_{y}.npz"
            z = np.load(p)
            assert (z["location_id"] == ids).all(), f"point order mismatch in {p}"
            parts.append(z[tag])
        sp = np.concatenate(parts, axis=0)
        del parts
        viable = df[f"{tag}_viable"].to_numpy() == 1
        tcol = f"{tag}_cf_target" if f"{tag}_cf_target" in df.columns else f"{tag}_cf_p90"
        target = df[tcol].to_numpy()
        dens = df["on_site_air_density"].to_numpy() if tag == "on" else np.full(n, RHO0)
        dens = np.where(np.isfinite(dens) & (dens > 0.5), dens, RHO0)
        cls = df["on_site_iec_class"].to_numpy() if tag == "on" else None
        curves = [CURVES[int(cls[i])] if tag == "on" and np.isfinite(cls[i]) and int(cls[i]) in CURVES
                  else CURVES["offshore"] for i in range(n)]
        G.update(sp=sp, target=target, dens=dens, curve=curves, keep=1.0 - LOSSES, solve_k=solve_k)
        todo = [i for i in range(n) if viable[i] and np.isfinite(target[i]) and target[i] > 0]
        ks = np.full(n, np.nan); raw = np.full(n, np.nan); fin = np.full(n, np.nan); cl = np.zeros(n, "int8")
        with get_context("fork").Pool(a.procs) as pool:
            for i, k, r, f, c in pool.imap_unordered(_solve, todo, chunksize=16):
                ks[i], raw[i], fin[i], cl[i] = k, r, f, c
        rows = np.where(np.isfinite(ks))[0]
        np.savez(a.out / f"k_{tag}.npz", k=ks, rows=rows, location_id=ids[rows])
        diag[f"{tag}_k"], diag[f"{tag}_raw_cf"], diag[f"{tag}_final_cf"], diag[f"{tag}_clamped"] = ks, raw, fin, cl
        print(f"{tag}: {len(rows)} rows solved on {years[0]}-{years[-1]} ({sp.shape[0]} h), "
              f"clamped {int(cl.sum())}, {time.time()-t0:.0f} s", flush=True)
        del sp
    diag.to_csv(a.out / "k10_diag.csv", index=False)


if __name__ == "__main__":
    main()
