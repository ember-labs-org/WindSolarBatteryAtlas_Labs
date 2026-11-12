"""T066 Phase B gates on ~/wind-atlas-T066/work (read-only): presence, NaN, format, k and clipping
distributions, old vs new 2024 annual yield and ten-year Dec/Jun ratio by latitude band, k outliers."""
import sys
from pathlib import Path
import numpy as np
import pandas as pd
import shapefile
from shapely.geometry import Point, shape
from shapely.ops import unary_union

H = Path.home()
W, T064 = H / "wind-atlas-T066/work", H / "wind-atlas-T064/work"
DD = Path("/Users/daanwalter/Library/CloudStorage/OneDrive-Ember 2/ember-futures - Documents/03 Research/"
          "2026/97 Ideas/WIND ATLAS/SolarWindBatteryAtlas")
ok = True
def gate(name, cond, info=""):
    global ok; ok &= bool(cond); print(f"[{'PASS' if cond else 'FAIL'}] {name} {info}")

ids = np.load(T064 / "solar_ids.npy")
R = pd.read_csv(W / "solar_t066_regions.csv")
gate("regions in table = solar_ids", len(R) == len(ids) and (R.location_id.values == ids).all(), f"{len(R)}/{len(ids)}")
yrs = range(2015, 2025)
f = lambda d, y: d / ("solar_2024_u16.npy" if y == 2024 else f"solar/solar_{y}_u16.npy")
new = {y: np.load(f(W, y), mmap_mode="r") for y in yrs}
old = {y: np.load(f(T064, y), mmap_mode="r") for y in yrs}
for y in yrs:
    h = 8784 if y % 4 == 0 else 8760
    gate(f"{y} shape/dtype", new[y].shape == (len(ids), h) and new[y].dtype == np.uint16 and old[y].shape == new[y].shape,
         f"{new[y].shape} max {int(new[y].max())} (cap {round(1/1.3*0.985*1e4)})")
gate("no NaN in model DC, no fill values in inputs", R.nan.sum() == 0 and R.fill_values.sum() == 0,
     f"nan {R.nan.sum()} fills {R.fill_values.sum()}")
gate("max <= 1/ILR x (1-AC loss)", max(int(new[y].max()) for y in yrs) <= round(1 / 1.3 * 0.985 * 1e4))
zero = [int(loc) for i, loc in enumerate(ids) if new[2024][i].sum() == 0]
gate("no all-zero region in 2024", not zero, str(zero[:10]))

cc = pd.read_csv(DD / "deployment/data/voronoi_overlapping_countries.csv").set_index("location_id")
R["country"] = R.location_id.map(cc.country_name)
land = unary_union([shape(s.__geo_interface__) for s in shapefile.Reader(str(DD / "workspace/input_data/ne_110m_land.shp")).shapes()])
coast = land.boundary
R["coast_km"] = [round(coast.distance(Point(lo, la)) * 111 * max(np.cos(np.radians(la)), 0.3), 0) for la, lo in zip(R.latitude, R.longitude)]
R["on_land"] = [land.contains(Point(lo, la)) for la, lo in zip(R.latitude, R.longitude)]
bands = pd.cut(R.latitude.abs(), [0, 15, 30, 45, 55, 91], right=False, labels=["0-15", "15-30", "30-45", "45-55", ">55"])
R["band"] = bands

print("\nk source:", R.k_source.value_counts().to_dict())
q = [.05, .1, .25, .5, .75, .9, .95]
print("k (GSA-calibrated, uncapped) quantiles:", R.k_uncapped.quantile(q).round(3).to_dict())
print("k by band (median, GSA only):", R[R.k_uncapped.notna()].groupby("band", observed=True).k_uncapped.median().round(3).to_dict())
print("share of GSA k within 0.85-1.05:", round(R.k_uncapped.between(.85, 1.05).sum() / R.k_uncapped.notna().sum(), 3))
print("clipping share after calibration, quantiles:", R.clip_share.quantile(q).round(4).to_dict(), "max", round(R.clip_share.max(), 4))
print("clipping by band (median):", R.groupby("band", observed=True).clip_share.median().round(4).to_dict())
print("regions with clipping > 5%:", int((R.clip_share > .05).sum()))

i24 = {y: None for y in yrs}
on = np.array([new[2024][i].sum() for i in range(len(ids))]) / 1e4
oo = np.array([old[2024][i].sum() for i in range(len(ids))]) / 1e4
R["new_2024"], R["old_2024"] = on, oo
R["new_over_old_2024"] = on / np.where(oo > 0, oo, np.nan)
R["new2024_over_gsa"] = on / R.gsa_kwh_kwp
print("\n2024 annual yield new/old, median by band:", R.groupby("band", observed=True).new_over_old_2024.median().round(3).to_dict())
print("2024 old/GSA, median by band:", (R.old_2024 / R.gsa_kwh_kwp).groupby(R.band, observed=True).median().round(3).to_dict())
print("2024 new/GSA, median by band:", R.groupby("band", observed=True).new2024_over_gsa.median().round(3).to_dict())

def dj(d):
    dec, jun = np.zeros(len(ids)), np.zeros(len(ids))
    for y in yrs:
        t = np.arange(np.datetime64(f"{y}-01-01T00"), np.datetime64(f"{y+1}-01-01T00"), np.timedelta64(1, "h"))
        m = t.astype("datetime64[M]").astype(int) % 12
        a = np.asarray(d[y], dtype="float64")
        dec += a[:, m == 11].sum(1); jun += a[:, m == 5].sum(1)
    w = np.where(R.latitude >= 0, dec / np.maximum(jun, 1), jun / np.maximum(dec, 1))
    return w
R["dj_new"], R["dj_old"] = dj(new), dj(old)
print("ten-year winter/summer (Dec/Jun, Jun/Dec south) median by band: new",
      R.groupby("band", observed=True).dj_new.median().round(3).to_dict(), "old",
      R.groupby("band", observed=True).dj_old.median().round(3).to_dict())
cols = ["location_id", "latitude", "longitude", "country", "coast_km", "on_land", "gsa_kwh_kwp", "raw_10y", "k_uncapped"]
pd.set_option("display.width", 200)
print("\nk < 0.80:\n", R[R.k_uncapped < .8][cols].round(3).to_string(index=False))
print("\nk at the 1.10 cap:\n", R[R.k_source == "gsa_capped"][cols].round(3).sort_values("k_uncapped").to_string(index=False))
R.to_csv(W / "gate_t066_regions.csv", index=False)
print("\nALL GATES", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
