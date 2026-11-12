"""Gate A2: reproduce the shipped 2024 solar kwh_per_kw from NASA POWER.

36 regions stratified by latitude (every 5-degree band that has regions, spread
evenly by rank within the sorted latitudes), fetched for 2024 in LST.
Pass: annual CF within 0.5% relative and hourly correlation >= 0.99, per region.
Also reports the share of hours that match exactly and a UTC-basis control for
three regions (to show the time basis is LST).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pyarrow.parquet as pq

import power as P

WS = Path(sys.argv[1])
t = pq.read_table(WS / "input_data/solar_profiles.parquet",
                  columns=["location_id", "latitude", "longitude", "kwh_per_kw", "irradiance_w_per_m2"])
ids = t["location_id"].to_numpy()
lat = t["latitude"].to_numpy()
lon = t["longitude"].to_numpy()
k = t["kwh_per_kw"].to_numpy()
g = t["irradiance_w_per_m2"].to_numpy()
n = len(np.unique(ids))
H = 8784
order = np.lexsort((np.arange(len(ids)), ids))  # file is location then ts order already
ids, lat, lon, k, g = (a.reshape(n, H) for a in (ids, lat, lon, k, g))
locs = ids[:, 0]
la = lat[:, 0]
lo = lon[:, 0]

rank = np.argsort(la)
pick = rank[np.linspace(0, n - 1, 36).round().astype(int)]
rows = []
print(f"{'loc':>5} {'lat':>7} {'lon':>8} {'CF ship':>8} {'CF POWER':>8} {'rel %':>7} {'corr':>7} {'exact %':>7}")
ok = True
for i in pick:
    d = P.fetch(int(locs[i]), float(la[i]), float(lo[i]), 2024, 2024, span="a2_2024")
    gp, _ = P.series(d, 2024, 2024)
    kp = P.to_kwh(gp).astype("float32")
    cf_s, cf_p = float(k[i].astype("float64").mean()), float(kp.astype("float64").mean())
    rel = (cf_p / cf_s - 1) * 100 if cf_s > 0 else 0.0
    c = float(np.corrcoef(k[i], kp)[0, 1])
    ex = float((kp == k[i]).mean() * 100)
    good = abs(rel) <= 0.5 and c >= 0.99
    ok &= good
    rows.append((locs[i], la[i], lo[i], cf_s, cf_p, rel, c, ex))
    print(f"{locs[i]:5d} {la[i]:7.2f} {lo[i]:8.2f} {cf_s:8.4f} {cf_p:8.4f} {rel:7.3f} {c:7.4f} {ex:7.2f}"
          + ("" if good else "  FAIL"), flush=True)
r = np.array([x[5] for x in rows]); c = np.array([x[6] for x in rows]); e = np.array([x[7] for x in rows])
print(f"\nregions {len(rows)}; |rel| max {np.abs(r).max():.4f}% ; corr min {c.min():.6f}; exact hours median {np.median(e):.2f}% min {e.min():.2f}%")

# time basis control: UTC request for 3 regions far from Greenwich
print("\ntime basis control (UTC request vs shipped):")
import requests
for i in [pick[5], pick[18], pick[30]]:
    r_ = requests.get(P.API, params=dict(parameters="ALLSKY_SFC_SW_DWN", community="RE",
                      longitude=f"{lo[i]:.4f}", latitude=f"{la[i]:.4f}", start="20240101",
                      end="20241231", format="JSON", **{"time-standard": "UTC"}), timeout=180).json()
    gu = np.array(list(r_["properties"]["parameter"]["ALLSKY_SFC_SW_DWN"].values()), dtype="float64")
    ku = P.to_kwh(gu)
    print(f"  loc {locs[i]} lon {lo[i]:.1f}: corr UTC {np.corrcoef(k[i], ku)[0,1]:.4f} "
          f"(shift round(lon/15) = {int(round(lo[i]/15))} h); "
          f"shipped peak hour (mean day) {np.argmax(k[i].reshape(-1,24).mean(0))}")
print("\nGATE A2", "PASS" if ok else "FAIL")
