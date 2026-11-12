"""T054 phase 1: can the hourly onshore profiles reach the new targets?

build_wind_profiles.py scales ERA5 speed by k in [0.6, 1.8] so the annual mean
net CF hits the target; if even k = 1.8 falls short the profile is clamped and the
simulation uses less than the headline. This computes, per region, the net CF at
k = 1.8 (same density correction, power curve and losses as build_wind_profiles)
and counts how many regions would be clamped under each option's target.

Usage: python3 -I k_headroom.py <scratch>/region_options.csv <voronoi_wind_resource.csv> <era5_speed_2024.npz> <workspace>
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _stub import ensure_pkg  # noqa: E402

ensure_pkg(Path(sys.argv[4]), Path(sys.argv[1]).parent)
from scripts.pipeline.wind.power_curves import CURVES  # noqa: E402

RHO0, K_MAX, K_MIN, KEEP = 1.225, 1.8, 0.6, 0.88
r = pd.read_csv(sys.argv[1])
d = pd.read_csv(sys.argv[2])
z = np.load(sys.argv[3])
assert (z['location_id'] == d.location_id.to_numpy()).all()
on = z['on']
dens = d.on_site_air_density.to_numpy()
dens = np.where(np.isfinite(dens) & (dens > 0.5), dens, RHO0)
cls = d.on_site_iec_class.to_numpy()
cap_hi = np.full(len(d), np.nan)
cap_lo = np.full(len(d), np.nan)
for i in range(len(d)):
    if r.on_area_km2.iat[i] <= 0:
        continue
    curve = CURVES[int(cls[i])] if int(cls[i]) in CURVES else CURVES['offshore']
    v = on[:, i].astype('float64') * (dens[i] / RHO0) ** (1 / 3)
    if not np.isfinite(v).all() or v.max() <= 0:
        continue
    cap_hi[i] = curve.output(v * K_MAX).mean() * KEEP
    cap_lo[i] = curve.output(v * K_MIN).mean() * KEEP
r['cap_k18'] = cap_hi
cur = r.on_viable == 1
has = r.on_area_km2 > 0
print(f"check vs shipped: regions currently clamped {int(d.on_clamped.sum())}; "
      f"recomputed (P90 > cap or < floor) {int((cur & ((r.on_cf_p90 > cap_hi + 1e-6) | (r.on_cf_p90 < cap_lo - 1e-6))).sum())}")
sh = (r.on_cf_p90 - d.on_final_cf)[cur & (d.on_clamped == 1)]
print(f"current clamped viable: shortfall of simulated CF vs P90 median {100*sh.median():.1f} pp, max {100*sh.max():.1f} pp")
for A in (500, 1000, 2500):
    col = f'best{A}_cf'
    new = has & (r[col] >= 0.2)
    gain = new & ~cur
    for scope, tgt in (('i', r[col]), ('ii', np.where(cur, r.on_cf_p90, r[col]))):
        tgt = pd.Series(tgt, index=r.index)
        cl = new & (tgt > r.cap_k18)
        sim = np.minimum(tgt, r.cap_k18)
        print(f"A={A} scope {scope}: clamped {int(cl.sum())} of {int(new.sum())} viable "
              f"(of newly viable {int((cl & gain).sum())}/{int(gain.sum())}); "
              f"newly viable whose simulated CF < 20%: {int((gain & (sim < 0.2)).sum())}; "
              f"median simulated CF newly viable {sim[gain].median():.3f}")
r[['location_id', 'cap_k18']].to_csv(Path(sys.argv[1]).with_name('k_headroom.csv'), index=False, float_format='%.6f')
