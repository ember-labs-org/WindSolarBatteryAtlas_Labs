"""T060 report section 1: weather variability of the hourly profiles, 2015-2024.

Per region (the 4,465 deployed) and year: mean CF of the solar, onshore and
offshore profiles (the atlas's inputs, wind level-corrected with the fixed 2024 k).
Writes to results/:
  profile_cf_by_region_year.parquet  location_id, tech, cf_2015..cf_2024, cf_mean
  cf_ratio_by_region.csv             ten-year mean / 2024, per region and tech (A1 by-product)
  weather_by_band.csv                per latitude band and tech: people-weighted band CF per year,
                                     ten-year mean, 2024, min, max, 2024's rank (1 = best)
  weather_cities.csv                 the 15 cities (nearest region by site, as curves.py)
  python3 -I weather.py <repo>
"""
import os
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(os.environ.get("TENYEAR_ROOT", str(Path.home() / "wind-atlas-T064")))  # T064 run dir (T060: ~/wind-atlas-T060)
sys.path.insert(0, str(ROOT / "scripts"))
import sim10 as S  # noqa: E402

repo = Path(sys.argv[1]).resolve()
DATA = repo / "deployment" / "data"
sys.path.insert(0, str(repo / "scripts/article"))
import engine  # noqa: E402
engine.DATA = DATA
import analyse  # noqa: E402

YEARS = S.YEARS
ids_all = S.solar_ids()
excl = {r["location_id"] for r in json.loads((repo / "pipeline/scripts/exclude_regions/excluded_regions.json").read_text())["regions"]}
dep = np.array([i for i in ids_all if i not in excl])
cells = analyse.cell_table(dep)
pop = cells["pop"].to_numpy()
lat = cells.lat.to_numpy()
lon = cells.lon.to_numpy()

rows = np.searchsorted(ids_all, dep)
cf = {}
sol = np.zeros((len(dep), len(YEARS)))
for j, y in enumerate(YEARS):
    u = np.load(ROOT / "work" / ("solar_2024_u16.npy" if y == 2024 else f"solar/solar_{y}_u16.npy"), mmap_mode="r")
    sol[:, j] = np.asarray(u[rows], dtype=np.float64).mean(axis=1) / 1e4
cf["solar"] = sol
for tag in ("on", "off"):
    wrows = np.load(ROOT / "work/wind" / f"{tag}_rows.npy")
    m = np.full((len(dep), len(YEARS)), np.nan)
    pos = {v: k for k, v in enumerate(wrows)}
    sel = np.array([pos.get(i, -1) for i in dep])
    have = sel >= 0
    for j, y in enumerate(YEARS):
        a = np.load(ROOT / "work/wind" / f"{tag}_{y}.npy", mmap_mode="r")
        m[have, j] = np.asarray(a[sel[have]], dtype=np.float64).mean(axis=1)
    cf[f"wind_{tag}"] = m

# ten-year mean as an hour-weighted mean of the years (= mean of the continuous series)
hw = S.year_hours(YEARS) / S.year_hours(YEARS).sum()
out = []
for tech, m in cf.items():
    d = pd.DataFrame(m, columns=[f"cf_{y}" for y in YEARS])
    d.insert(0, "tech", tech)
    d.insert(0, "location_id", dep)
    d["cf_mean"] = m @ hw
    out.append(d)
prof = pd.concat(out, ignore_index=True)
(ROOT / "results").mkdir(exist_ok=True)
prof.to_parquet(ROOT / "results/profile_cf_by_region_year.parquet", index=False)

rat = prof[["location_id", "tech"]].copy()
rat["cf_2024"] = prof.cf_2024
rat["cf_mean"] = prof.cf_mean
rat["mean_over_2024"] = prof.cf_mean / prof.cf_2024
rat.dropna().to_csv(ROOT / "results/cf_ratio_by_region.csv", index=False, float_format="%.5f")

BANDS = analyse.LAT_BANDS
band_rows = []
for tech, m in cf.items():
    for lo, hi in BANDS + [(-90, 90.0001)]:
        sel = (lat >= lo) & (lat < hi) & np.isfinite(m[:, 0])
        w = pop[sel]
        if sel.sum() == 0:
            continue
        if w.sum() <= 0:
            w = np.ones(sel.sum())
        yearly = (m[sel] * w[:, None]).sum(0) / w.sum()
        mean = float(yearly @ hw)
        rank = int((yearly > yearly[-1]).sum() + 1)
        with np.errstate(divide='ignore', invalid='ignore'):
            reg_ratio = np.where(m[sel, -1] > 0, m[sel] @ hw / m[sel, -1], np.nan)
        band_rows.append(dict(
            tech=tech, band="world" if hi > 90 else analyse.band_label(lo, hi), regions=int(sel.sum()),
            people_m=round(float(pop[sel].sum() / 1e6), 1),
            **{f"cf_{y}": round(float(v), 4) for y, v in zip(YEARS, yearly)},
            cf_mean=round(mean, 4),
            dev_2024_pct=round((yearly[-1] / mean - 1) * 100, 2),
            min_pct=round((yearly.min() / mean - 1) * 100, 2), max_pct=round((yearly.max() / mean - 1) * 100, 2),
            rank_2024=rank,
            region_ratio_median=round(float(np.nanmedian(reg_ratio)), 4),
            region_ratio_p10=round(float(np.nanquantile(reg_ratio, 0.1)), 4),
            region_ratio_p90=round(float(np.nanquantile(reg_ratio, 0.9)), 4),
            regions_2024_above_mean_pct=round(float((m[sel, -1] > m[sel] @ hw).mean() * 100), 1)))
pd.DataFrame(band_rows).to_csv(ROOT / "results/weather_by_band.csv", index=False)

CITIES = [('Tromsø', 69.65, 18.96), ('Stockholm', 59.33, 18.07), ('Edinburgh', 55.95, -3.19), ('Berlin', 52.52, 13.40),
          ('London', 51.51, -0.13), ('Chicago', 41.88, -87.63), ('Madrid', 40.42, -3.70), ('Beijing', 39.90, 116.40),
          ('Dallas', 32.78, -96.80), ('Delhi', 28.61, 77.21), ('Lagos', 6.52, 3.38), ('Jakarta', -6.21, 106.85),
          ('Johannesburg', -26.20, 28.05), ('Buenos Aires', -34.60, -58.38), ('Melbourne', -37.81, 144.96)]


def hav(a, b, c, d):
    a, b, c, d = map(np.radians, (a, b, c, d))
    return 2 * 6371 * np.arcsin(np.sqrt(np.sin((c - a) / 2) ** 2 + np.cos(a) * np.cos(c) * np.sin((d - b) / 2) ** 2))


crow = []
for name, la, lo in CITIES:
    i = int(np.argmin(hav(la, lo, lat, lon)))
    for tech, m in cf.items():
        y = m[i]
        if not np.isfinite(y[0]):
            continue
        mean = float(y @ hw)
        crow.append(dict(city=name, location_id=int(dep[i]), tech=tech,
                         **{f"cf_{yy}": round(float(v), 4) for yy, v in zip(YEARS, y)},
                         cf_mean=round(mean, 4),
                         dev_2024_pct=round((y[-1] / mean - 1) * 100, 2),
                         min_pct=round((y.min() / mean - 1) * 100, 2), max_pct=round((y.max() / mean - 1) * 100, 2),
                         rank_2024=int((y > y[-1]).sum() + 1)))
pd.DataFrame(crow).to_csv(ROOT / "results/weather_cities.csv", index=False)
print(pd.DataFrame(band_rows)[["tech", "band", "cf_mean", "cf_2024", "dev_2024_pct", "min_pct", "max_pct", "rank_2024"]].to_string())
