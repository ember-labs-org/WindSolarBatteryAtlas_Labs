"""T081 pilot: quantile mapping against the clamped scalar profile and ERA5's shape, 20 clamped regions.

  python3 -I pilot.py <qm dir> <scalar dir> <resource csv> <countries csv> <out md>
Both dirs hold build_wind_t081.py --only outputs (pilot_series.npz, pilot_diag.csv): one normal, one
--scalar-only (the shipped clamped k = 1.8 profile). Hours are UTC (no clock shift in pilot output).
Shape tests per region: Pearson r of hourly CF; r of the 120 month means (each normalised by its
series mean); r of the mean diurnal cycle; ratio of the coefficient of variation of daily CF;
share of hours at zero output and at rated output.
"""
import sys

import numpy as np
import pandas as pd

qd, sd, res, ctry, out = sys.argv[1:6]
q = np.load(f"{qd}/pilot_series.npz"); s = np.load(f"{sd}/pilot_series.npz")
assert np.array_equal(q["location_id"], s["location_id"])
dq = pd.read_csv(f"{qd}/pilot_diag.csv").set_index("location_id")
r = pd.read_csv(res).set_index("location_id")
oc = pd.read_csv(ctry).set_index("location_id")["country_iso3"]
t = np.arange(np.datetime64("2015-01-01T00"), np.datetime64("2025-01-01T00"), np.timedelta64(1, "h"))
month = (t.astype("datetime64[M]") - t[0].astype("datetime64[M]")).astype(int)
day = (t.astype("datetime64[D]") - t[0].astype("datetime64[D]")).astype(int)
hod = (t - t.astype("datetime64[D]")).astype(int)
rows = []
for j, lid in enumerate(q["location_id"]):
    a, b = q["series"][j].astype("float64"), s["series"][j].astype("float64")
    mm = lambda x: np.bincount(month, x) / np.bincount(month)
    dm = lambda x: np.bincount(day, x) / np.bincount(day)
    hm = lambda x: np.bincount(hod, x) / np.bincount(hod)
    ma, mb = mm(a) / a.mean(), mm(b) / b.mean()
    da, db = dm(a), dm(b)
    rows.append(dict(location_id=int(lid), iso3=oc.get(lid, ""), target=r.loc[lid, "on_cf_target"],
                     scalar_cf=b.mean(), qm_cf=a.mean(), qm_trim=dq.loc[lid, "on_qm_trim"],
                     r_hourly=np.corrcoef(a, b)[0, 1], r_monthly=np.corrcoef(ma, mb)[0, 1],
                     r_diurnal=np.corrcoef(hm(a), hm(b))[0, 1],
                     cv_daily_ratio=(da.std() / da.mean()) / (db.std() / db.mean()),
                     zero_h_qm=(a < 1e-4).mean(), zero_h_scalar=(b < 1e-4).mean(),
                     rated_h_qm=(a > 0.8).mean(), rated_h_scalar=(b > 0.8).mean()))
d = pd.DataFrame(rows)
txt = ["# T081 pilot: quantile mapping in 20 clamped regions", "",
       "Scalar = the shipped profile with k clamped at 1.8; QM = ERA5 ten-year series mapped onto the GWA "
       "Weibull mixture of the region's selected land (rank kept), then trimmed to the target.", "",
       d.to_markdown(index=False, floatfmt=".3f"), "",
       f"Median: r hourly {d.r_hourly.median():.3f}, r monthly {d.r_monthly.median():.3f}, "
       f"r diurnal {d.r_diurnal.median():.3f}, daily CV ratio {d.cv_daily_ratio.median():.3f}, "
       f"QM trim {d.qm_trim.median():.3f} (range {d.qm_trim.min():.3f}–{d.qm_trim.max():.3f}); "
       f"QM CF / target max |err| {np.abs(d.qm_cf/d.target-1).max():.2e}"]
open(out, "w").write("\n".join(txt) + "\n")
print("\n".join(txt))
