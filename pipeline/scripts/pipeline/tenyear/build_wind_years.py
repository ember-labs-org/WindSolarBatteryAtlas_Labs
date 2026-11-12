"""Hourly onshore/offshore wind CF profiles for one weather year (T060).

Same code path as the repo's build_wind_profiles.py (density correction, power
curves, 12% losses, UTC -> local solar clock by np.roll(round(lon/15))), with one
change: the level-correction multiplier k is solved ONCE, on the 2024 ERA5
speeds against the site's Global Wind Atlas target, and then applied unchanged
to every year. Year-to-year differences are therefore pure weather (contract
T060 A1). For --year 2024 this is exactly the shipped construction.

Output: work/wind/<tag>_<year>.npy  float32 [n_rows, hours] for the rows in
        work/wind/<tag>_rows.npy (location_ids with a profile; others are zero),
        plus work/wind/k_<tag>.npy (the 2024 k per row).

  python3 -I build_wind_years.py --repo <wt> --resource <run>/ws/outputs/voronoi_wind_resource.csv \
      --year 2024 --speeds work/era5_speed_2024.npz
"""
from __future__ import annotations

import os
import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(os.environ.get("TENYEAR_ROOT", str(Path.home() / "wind-atlas-T064")))  # T064 run dir (T060: ~/wind-atlas-T060)
WOUT = ROOT / "work" / "wind"
LOSSES = 0.12
RHO0 = 1.225


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--resource", type=Path, required=True)
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--speeds", type=Path, required=True)
    ap.add_argument("--speeds2024", type=Path, default=ROOT / "work" / "era5_speed_2024.npz")
    ap.add_argument("--k-fixed", action="store_true",
                    help="T068: use work/wind/k_<tag>.npz as it is (solved on the ten-year mean by "
                         "solve_k10.py); never re-solve on 2024")
    a = ap.parse_args()
    sys.path.insert(0, str(a.repo / "pipeline"))
    from scripts.pipeline.wind.power_curves import CURVES  # noqa
    from scripts.pipeline.wind.build_wind_profiles import solve_k  # noqa

    WOUT.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(a.resource)
    z = np.load(a.speeds)
    assert (z["location_id"] == df["location_id"].to_numpy()).all(), "point order mismatch"
    nh = z["on"].shape[0]
    keep = 1.0 - LOSSES
    t0 = time.time()
    for tag in ("on", "off"):
        n = len(df)
        viable = df[f"{tag}_viable"].to_numpy() == 1
        tcol = f"{tag}_cf_target" if f"{tag}_cf_target" in df.columns else f"{tag}_cf_p90"
        target_net = df[tcol].to_numpy()
        dens = df["on_site_air_density"].to_numpy() if tag == "on" else np.full(n, RHO0)
        dens = np.where(np.isfinite(dens) & (dens > 0.5), dens, RHO0)
        cls = df["on_site_iec_class"].to_numpy() if tag == "on" else None
        lons = df["longitude"].to_numpy()

        kfile = WOUT / f"k_{tag}.npz"
        if a.k_fixed and not kfile.exists():
            raise SystemExit(f"--k-fixed: {kfile} missing (run solve_k10.py first)")
        if not a.k_fixed and (a.year == 2024 or not kfile.exists()):
            # solve k on 2024 (the shipped construction)
            z24 = np.load(a.speeds2024)
            assert (z24["location_id"] == df["location_id"].to_numpy()).all()
            sp24 = z24[tag]
            ks = np.full(n, np.nan)
            for i in range(n):
                if not viable[i] or not np.isfinite(target_net[i]) or target_net[i] <= 0:
                    continue
                curve = CURVES[int(cls[i])] if tag == "on" and int(cls[i]) in CURVES else CURVES["offshore"]
                v = sp24[:, i].astype("float64")
                if not np.isfinite(v).all() or v.max() <= 0:
                    continue
                v = v * (dens[i] / RHO0) ** (1.0 / 3.0)
                ks[i], _ = solve_k(v, curve, float(target_net[i]) / keep)
            rows = np.where(np.isfinite(ks))[0]
            np.savez(kfile, k=ks, rows=rows, location_id=df["location_id"].to_numpy()[rows])
            del z24, sp24
        kz = np.load(kfile)
        ks, rows = kz["k"], kz["rows"]

        sp = z[tag]
        out = np.zeros((len(rows), nh), dtype="float32")
        for j, i in enumerate(rows):
            curve = CURVES[int(cls[i])] if tag == "on" and int(cls[i]) in CURVES else CURVES["offshore"]
            v = sp[:, i].astype("float64")
            if not np.isfinite(v).all():
                raise SystemExit(f"{tag} row {i}: non-finite ERA5 speed in {a.year}")
            v = v * (dens[i] / RHO0) ** (1.0 / 3.0)
            cf_hourly = curve.output(v * ks[i]) * keep
            out[j] = np.roll(cf_hourly, int(round(lons[i] / 15.0))).astype("float32")
        np.save(WOUT / f"{tag}_{a.year}.npy", out)
        np.save(WOUT / f"{tag}_rows.npy", df["location_id"].to_numpy()[rows])
        print(f"{a.year} {tag}: {len(rows)} profiles, mean CF {out.mean():.4f}, "
              f"{time.time()-t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
