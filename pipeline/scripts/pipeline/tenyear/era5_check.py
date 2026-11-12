"""T064: prove a fresh ERA5 year at the T061 points against T060's caches.

For every year:
  * the fresh file's point order is the T061 resource CSV's, and its hour0 / length are the year's;
  * "unmoved" = the parked (on/off site, else centre) coordinates are equal in T060's
    fetch-point CSV and T061's;
  * moved columns: finite, in 0..60 m/s, and their annual mean speed correlates with the
    same column's 2024 mean in T061's 2024 fetch (same coordinates).
2020-2023 (T060 raw npz kept): centre and every unmoved on/off column bit-identical to the
T060 raw npz.
Every year, and the only check for 2015-2019 (T060 raw deleted in T060): every T060 profile row whose site is unmoved is
rebuilt from the fresh speeds with T060's own k, density, class and clock shift
(build_wind_years' expression) and must equal T060's work/wind/<tag>_<year>.npy bit for bit.

  python3 -I era5_check.py --repo <wt> --year 2017
"""
from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

T060 = Path.home() / "wind-atlas-T060"
T064 = Path.home() / "wind-atlas-T064"
LOSSES, RHO0 = 0.12, 1.225


def parked(df, tag):
    la = df[f"{tag}_site_lat"].to_numpy().copy()
    lo = df[f"{tag}_site_lon"].to_numpy().copy()
    bad = ~np.isfinite(la) | ~np.isfinite(lo)
    la[bad] = df["latitude"].to_numpy()[bad]
    lo[bad] = df["longitude"].to_numpy()[bad]
    return la, lo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--year", type=int, required=True)
    a = ap.parse_args()
    y = a.year
    old = pd.read_csv(T060 / "work" / "resource_fetchpoints.csv")
    new = pd.read_csv(T064 / "work" / "resource_fetchpoints.csv")
    f = dict(np.load(T064 / "raw" / "era5" / f"era5_speed_{y}.npz"))
    nh = (date(y + 1, 1, 1) - date(y, 1, 1)).days * 24
    ok = True
    ok &= bool((f["location_id"] == new.location_id.to_numpy()).all())
    ok &= int(f["hour0"]) == (date(y, 1, 1) - date(1900, 1, 1)).days * 24 and f["on"].shape[0] == nh
    print(f"{y}: point order and hours {'ok' if ok else 'WRONG'} ({nh} h)")
    z24 = np.load(T064 / "work" / "era5_speed_2024.npz")
    same = {}
    for tag in ("on", "off"):
        o, n = parked(old, tag), parked(new, tag)
        same[tag] = (o[0] == n[0]) & (o[1] == n[1])
        mv = ~same[tag]
        sp = f[tag][:, mv]
        good = np.isfinite(sp).all() and sp.min() >= 0 and sp.max() < 60
        r = np.corrcoef(sp.mean(axis=0), z24[tag][:, mv].mean(axis=0))[0, 1]
        print(f"  {tag}: moved {int(mv.sum())}; finite and 0-60 m/s {good}; "
              f"corr of {y} mean speed with 2024 mean at the same points {r:.4f}")
        ok &= bool(good) and r > 0.9

    raw = T060 / "raw" / "era5" / f"era5_speed_{y}.npz"
    if raw.exists():
        w = dict(np.load(raw))
        assert (w["location_id"] == f["location_id"]).all() and int(w["hour0"]) == int(f["hour0"])
        c = np.array_equal(f["centre"], w["centre"])
        print(f"  centre vs T060 raw npz: {'bit-identical' if c else 'DIFFERS'}")
        ok &= c
        for tag in ("on", "off"):
            eq = np.array([np.array_equal(f[tag][:, i], w[tag][:, i]) for i in range(len(new))])
            s = same[tag]
            print(f"  {tag} vs T060 raw npz: unmoved {int(s.sum())}, bit-identical {int((eq & s).sum())}; "
                  f"moved {int((~s).sum())}, of which still identical {int((eq & ~s).sum())}")
            ok &= bool(eq[s].all())
    if True:  # profile check every year (the only check for 2015-2019; a cross-check for 2020-2023)
        sys.path.insert(0, str(a.repo / "pipeline"))
        from scripts.pipeline.wind.power_curves import CURVES  # noqa
        res = pd.read_csv(T060 / "work" / "resource_t059.csv")
        assert (res.location_id == new.location_id).all()
        keep = 1.0 - LOSSES
        for tag in ("on", "off"):
            kz = np.load(T060 / "work" / "wind" / f"k_{tag}.npz")
            ks, rows = kz["k"], kz["rows"]
            prof = np.load(T060 / "work" / "wind" / f"{tag}_{y}.npy", mmap_mode="r")
            dens = res["on_site_air_density"].to_numpy() if tag == "on" else np.full(len(res), RHO0)
            dens = np.where(np.isfinite(dens) & (dens > 0.5), dens, RHO0)
            cls = res["on_site_iec_class"].to_numpy() if tag == "on" else None
            lons = res["longitude"].to_numpy()
            n_cmp = n_eq = n_moved = 0
            for j, i in enumerate(rows):
                if not same[tag][i]:
                    n_moved += 1
                    continue
                curve = CURVES[int(cls[i])] if tag == "on" and int(cls[i]) in CURVES else CURVES["offshore"]
                v = f[tag][:, i].astype("float64") * (dens[i] / RHO0) ** (1.0 / 3.0)
                p = np.roll(curve.output(v * ks[i]) * keep, int(round(lons[i] / 15.0))).astype("float32")
                n_cmp += 1
                n_eq += np.array_equal(p, prof[j])
            print(f"  {tag} T060 profiles rebuilt from the fresh speeds at unmoved sites: {n_eq} of {n_cmp} "
                  f"bit-identical (T060 rows at moved sites: {n_moved})")
            ok &= n_eq == n_cmp
    print(f"{y}: ERA5 CHECK {'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
