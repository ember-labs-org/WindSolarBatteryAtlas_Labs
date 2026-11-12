"""T066 Phase B: tilted-panel hourly PV profiles 2015-2024 for every region (D-145).

Pass 1 (4 processes): pvmodel DC output per region -> float32 memmap work/pdc_10y.f32 (rows in solar_ids order).
k: GSA PVOUT (pvout_level1_mean x 365.25) / ten-year mean unclipped AC, k applied to DC (solved by
secant on the inverter curve), capped at 1.10; regions without GSA: median capped k of the 8 nearest
calibrated regions. Output: AC after clipping at 1/ILR, uint16 x 1e4, work/solar/solar_<y>_u16.npy
(2015-2023) and work/solar_2024_u16.npy, plus work/solar_t066_regions.csv.
"""
import os, sys, time
from multiprocessing import Pool
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pandas as pd
import power_pv as PP
import pvmodel as M

T064 = Path.home() / "wind-atlas-T064"
GSA = Path("/Users/daanwalter/Library/CloudStorage/OneDrive-Ember 2/ember-futures - Documents/03 Research/"
           "2026/97 Ideas/WIND ATLAS/SolarWindBatteryAtlas/deployment/data/voronoi_pvout_potential.csv")
W = PP.ROOT / "work"
KCAP = 1.10
NH = PP.hours_in(2015, 2024)
ids = np.load(T064 / "work/solar_ids.npy")
if os.environ.get("T066_TEST_IDS"):            # smoke test on a subset (separate T066_ROOT)
    ids = np.array([int(x) for x in os.environ["T066_TEST_IDS"].split(",")])
pts = pd.read_csv(T064 / "work/solar_points.csv").set_index("location_id").loc[ids]


def one(i):
    loc = int(ids[i]); la, lo = float(pts.latitude.iloc[i]), float(pts.longitude.iloc[i])
    inp = PP.load(loc)
    bad = sum(int((inp[k] == -999).sum()) for k in PP.PARAMS if k != "ALLSKY_SRF_ALB")
    r = M.run_region(inp, la, lo)
    pdc = M.dc_power(r["eff"], r["poa"], inp["T2M"], inp["WS10M"])
    mm = np.memmap(W / "pdc_10y.f32", dtype="float32", mode="r+", shape=(len(ids), NH))
    mm[i] = pdc.astype("float32"); mm.flush(); del mm
    return i, r["tilt"], bad, int(np.isnan(pdc).sum())


def ann(pdc, k, clip=False):
    return M.inverter(k * pdc, clip).sum() / 10.0


if __name__ == "__main__":
    W.mkdir(exist_ok=True); (W / "solar").mkdir(exist_ok=True)
    np.save(W / "solar_ids.npy", ids)
    f = W / "pdc_10y.f32"
    if not f.exists():
        np.memmap(f, dtype="float32", mode="w+", shape=(len(ids), NH)).flush()
    t0 = time.time(); meta = {}
    with Pool(4) as pool:
        for n, (i, tilt, bad, nan) in enumerate(pool.imap_unordered(one, range(len(ids)), chunksize=8)):
            meta[i] = (tilt, bad, nan)
            if n % 250 == 0:
                print(n, f"{(time.time()-t0)/60:.1f} min", flush=True)
    mm = np.memmap(f, dtype="float32", mode="r", shape=(len(ids), NH))
    gsa = pd.read_csv(GSA).set_index("location_id").pvout_level1_mean * 365.25
    rows = []
    for i, loc in enumerate(ids):
        pdc = np.asarray(mm[i], dtype="float64")
        raw = ann(pdc, 1.0)
        g = gsa.get(int(loc), np.nan)
        k = np.nan
        if np.isfinite(g) and raw > 0:
            k0, k1 = g / raw, g / raw * 1.01
            f0, f1 = ann(pdc, k0) - g, ann(pdc, k1) - g
            for _ in range(4):
                if f1 == f0: break
                k0, f0, k1 = k1, f1, k1 - f1 * (k1 - k0) / (f1 - f0)
                f1 = ann(pdc, k1) - g
            k = k1
        rows.append(dict(location_id=int(loc), latitude=pts.latitude.iloc[i], longitude=pts.longitude.iloc[i],
                         tilt=meta[i][0], fill_values=meta[i][1], nan=meta[i][2], gsa_kwh_kwp=g,
                         raw_10y=raw, k_uncapped=k))
    R = pd.DataFrame(rows)
    R["k_source"] = np.where(R.k_uncapped.notna(), np.where(R.k_uncapped > KCAP, "gsa_capped", "gsa"), "neighbour")
    R["k"] = R.k_uncapped.clip(upper=KCAP)
    cal = R[R.k.notna()]
    xyz = lambda d: np.c_[np.cos(np.radians(d.latitude)) * np.cos(np.radians(d.longitude)),
                          np.cos(np.radians(d.latitude)) * np.sin(np.radians(d.longitude)), np.sin(np.radians(d.latitude))]
    C, Q = xyz(cal), xyz(R)
    for j in np.where(R.k.isna())[0]:
        d = ((C - Q[j]) ** 2).sum(1)
        R.loc[j, "k"] = float(np.median(cal.k.values[np.argsort(d)[:8]]))
    yrs = np.arange(np.datetime64("2015-01-01T00"), np.datetime64("2025-01-01T00"), np.timedelta64(1, "h"))
    yy = yrs.astype("datetime64[Y]").astype(int) + 1970
    out = {y: np.zeros((len(ids), int((yy == y).sum())), dtype="uint16") for y in range(2015, 2025)}
    clipped, unclipped, cal10 = [], [], []
    for i in range(len(ids)):
        pdc = np.asarray(mm[i], dtype="float64") * R.k.iloc[i]
        ac = M.inverter(pdc, True); un = M.inverter(pdc, False)
        clipped.append(ac.sum()); unclipped.append(un.sum()); cal10.append(ac.sum() / 10)
        u = np.rint(ac * 1e4)
        assert u.max() < 65535 and not np.isnan(u).any()
        for y in out:
            out[y][i] = u[yy == y].astype("uint16")
    R["clip_share"] = 1 - np.array(clipped) / np.array(unclipped)
    R["cal_10y"] = cal10
    for y in range(2015, 2024):
        np.save(W / f"solar/solar_{y}_u16.npy", out[y])
    np.save(W / "solar_2024_u16.npy", out[2024])
    R.to_csv(W / "solar_t066_regions.csv", index=False)
    print(R.describe().T.to_string())
    print("done", f"{(time.time()-t0)/60:.1f} min")
