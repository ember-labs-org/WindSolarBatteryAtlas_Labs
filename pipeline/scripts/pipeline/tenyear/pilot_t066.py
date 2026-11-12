"""T066 Phase A pilot: new hourly PV model vs PVGIS 5.3 (2020), GSA PVOUT and the old GHI proxy.

Writes <ROOT>/pilot/pilot_summary.csv, pilot_monthly.csv, pilot_tilt.csv and prints the tables
used in team/reports/T066-pilot.md.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pandas as pd

import power_pv as PP
import pvmodel as M

T064 = Path.home() / "wind-atlas-T064"
GSA = Path("/Users/daanwalter/Library/CloudStorage/OneDrive-Ember 2/ember-futures - Documents/03 Research/"
           "2026/97 Ideas/WIND ATLAS/SolarWindBatteryAtlas/deployment/data/voronoi_pvout_potential.csv")
OUT = PP.ROOT / "pilot"
OUT.mkdir(exist_ok=True)

sites = pd.read_csv(PP.ROOT / "pilot_sites.csv")
gsa = pd.read_csv(GSA).set_index("location_id")
ids = np.load(T064 / "work/solar_ids.npy")
row_of = {int(v): i for i, v in enumerate(ids)}
old = {y: np.load(T064 / ("work/solar_2024_u16.npy" if y == 2024 else f"work/solar/solar_{y}_u16.npy"),
                  mmap_mode="r") for y in range(2015, 2025)}


def year_slices(t):
    yrs = t.astype("datetime64[Y]").astype(int) + 1970
    return {y: yrs == y for y in range(2015, 2025)}


def pvgis_lst(loc, k):
    """PVGIS 2020 hourly, re-labelled to the LST hour label (UTC hour + k); W per kWp and POA W/m2."""
    d = json.load(open(PP.ROOT / "raw/pvgis" / f"{loc}_2020.json"))
    h = pd.DataFrame(d["outputs"]["hourly"])
    t = pd.to_datetime(h.time.str[:11], format="%Y%m%d:%H") + pd.Timedelta(hours=k)
    s = pd.DataFrame({"P": h.P.values / 1000, "poa": (h["Gb(i)"] + h["Gd(i)"] + h["Gr(i)"]).values / 1000},
                     index=t)
    full = pd.date_range("2020-01-01", "2020-12-31 23:00", freq="h")
    return s.reindex(full).fillna(0.0), d["inputs"]["meteo_data"]["radiation_db"]


rows, mon, tilt_rows = [], [], []
for s in sites.itertuples():
    t0 = time.time()
    loc, lat, lon = int(s.location_id), float(s.lat), float(s.lon)
    inp = PP.load(loc)
    k = M.lst_offset(lon)
    # time basis: LST = UTC + k exactly?
    import gzip
    u = PP.arrays(json.loads(gzip.decompress(PP.cache_path(loc, "2020_2020", "UTC").read_bytes())), 2020, 2020)
    ghi_u = u["ALLSKY_SFC_SW_DWN"]
    ys = year_slices(inp["time"])
    ghi_l = inp["ALLSKY_SFC_SW_DWN"][ys[2020]]
    best = min(range(-12, 13), key=lambda j: np.abs(np.roll(ghi_u, j)[13:-13] - ghi_l[13:-13]).max())
    shift_err = float(np.abs(np.roll(ghi_u, best)[13:-13] - ghi_l[13:-13]).max())

    r = M.run_region(inp, lat, lon)
    pac = r["pac"]
    ac_raw = pac * (1 - M.LOSS_AC)                     # uncalibrated, unclipped kWh/kW per hour
    ann_raw = np.mean([ac_raw[ys[y]].sum() for y in range(2015, 2025)])
    g = gsa.loc[loc, "pvout_level1_mean"] * 365.25 if loc in gsa.index else np.nan
    kcal = g / ann_raw if np.isfinite(g) else np.nan
    new, unclip = M.finish(pac, kcal if np.isfinite(kcal) else 1.0)
    clip_share = 1 - new.sum() / unclip.sum()
    o = {y: old[y][row_of[loc]].astype("float64") / 1e4 for y in range(2015, 2025)}
    old_ann = np.mean([o[y].sum() for y in range(2015, 2025)])

    pv, db = pvgis_lst(loc, k)
    m20 = ac_raw[ys[2020]]
    poa20 = r["poa"][ys[2020]] / 1000
    old20 = o[2020]
    new20 = new[ys[2020]]
    tt = pd.DatetimeIndex(inp["time"][ys[2020]])
    # hourly correlation at lag 0 and best lag (PVGIS SARAH stamps are instantaneous ~HH:10 UTC)
    corr = {j: np.corrcoef(np.roll(pv.P.values, j), m20)[0, 1] for j in (-1, 0, 1)}
    dP = pd.Series(pv.P.values, tt).resample("D").sum()
    dM = pd.Series(m20, tt).resample("D").sum()
    dO = pd.Series(old20, tt).resample("D").sum()
    mP = pd.Series(pv.P.values, tt).resample("MS").sum()
    mM = pd.Series(m20, tt).resample("MS").sum()
    mO = pd.Series(old20, tt).resample("MS").sum()
    mPOA_p = pd.Series(pv.poa.values, tt).resample("MS").sum()
    mPOA_m = pd.Series(poa20, tt).resample("MS").sum()
    for i in range(12):
        mon.append(dict(site=s.site, month=i + 1, pvgis=mP.iloc[i], new_raw=mM.iloc[i], old=mO.iloc[i],
                        poa_pvgis=mPOA_p.iloc[i], poa_new=mPOA_m.iloc[i]))
    dj = lambda m: m.iloc[11] / m.iloc[5] if lat >= 0 else m.iloc[5] / m.iloc[11]   # winter / summer month
    # mean diurnal shape check: hour of the centroid of output (LST)
    hod = np.arange(len(m20)) % 24 + 0.5
    cen = lambda x: float((x * hod).sum() / x.sum())
    rows.append(dict(
        site=s.site, loc=loc, lat=round(lat, 2), lon=round(lon, 2), tilt=r["tilt"], db=db,
        lst_k=k, lst_shift_found=best, lst_shift_maxerr=shift_err,
        gsa=round(g, 0), old_10y=round(old_ann, 0), new_raw_10y=round(ann_raw, 0), kcal=round(kcal, 3),
        new_cal_10y=round(np.mean([new[ys[y]].sum() for y in range(2015, 2025)]), 0),
        clip_pct=round(100 * clip_share, 2),
        pvgis_2020=round(pv.P.sum(), 0), new_raw_2020=round(m20.sum(), 0), old_2020=round(old20.sum(), 0),
        raw_vs_pvgis=round(m20.sum() / pv.P.sum() - 1, 3),
        poa_new_2020=round(poa20.sum(), 0), poa_pvgis_2020=round(pv.poa.sum(), 0),
        poa_ratio=round(poa20.sum() / pv.poa.sum() - 1, 3),
        ghi_2020=round(inp["ALLSKY_SFC_SW_DWN"][ys[2020]].sum() / 1000, 0),
        corr_h_lag0=round(corr[0], 3), corr_h_best=round(max(corr.values()), 3),
        best_lag=max(corr, key=corr.get),
        corr_h_old=round(np.corrcoef(pv.P.values, old20)[0, 1], 3),
        corr_d_new=round(np.corrcoef(dP, dM)[0, 1], 3), corr_d_old=round(np.corrcoef(dP, dO)[0, 1], 3),
        ws_ratio_pvgis=round(dj(mP), 3), ws_ratio_new=round(dj(mM), 3), ws_ratio_old=round(dj(mO), 3),
        centroid_h_new=round(cen(m20), 2), centroid_h_pvgis=round(cen(pv.P.values), 2),
        dni_model_vs_power=round(r["dni_model"].sum() / max(inp["ALLSKY_SFC_SW_DNI"].clip(0).sum(), 1), 3),
        secs=round(time.time() - t0, 1),
    ))
    # numerical optimum tilt (10-year effective POA) vs the rule
    for tl in range(0, 66, 3):
        rr = M.run_region(inp, lat, lon, tilt=float(tl))
        tilt_rows.append(dict(site=s.site, tilt=tl, yield_raw=rr["pac"].sum() / 10))
    print(rows[-1]["site"], rows[-1]["secs"], "s", flush=True)

S = pd.DataFrame(rows)
T = pd.DataFrame(tilt_rows)
best = T.loc[T.groupby("site").yield_raw.idxmax()].set_index("site")
S["tilt_num_opt"] = S.site.map(best.tilt)
S["rule_loss_pct"] = [round(100 * (1 - np.interp(r.tilt, T[T.site == r.site].tilt, T[T.site == r.site].yield_raw)
                                   / T[T.site == r.site].yield_raw.max()), 2)
                      for r in S.itertuples()]
S.to_csv(OUT / "pilot_summary.csv", index=False)
pd.DataFrame(mon).to_csv(OUT / "pilot_monthly.csv", index=False)
T.to_csv(OUT / "pilot_tilt.csv", index=False)
pd.set_option("display.width", 250)
print(S.T.to_string())
