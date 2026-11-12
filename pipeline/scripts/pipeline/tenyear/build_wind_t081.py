"""T081: onshore hourly wind profiles 2015-2024 with distribution mapping where k clamps.

Per viable onshore region, on the ten-year ERA5 series at the site (as solve_k10.py):
  1. scalar method (the shipped one): density correction, then one multiplier k so the
     ten-year mean net CF equals the region's target, k in [0.6, 1.8];
  2. where k clamps, quantile mapping instead: each hour's ERA5 speed is replaced by the
     same quantile of the Global Wind Atlas Weibull mixture of the region's selected land
     at hub height (site_selection --mixture-out). The rank of every hour is kept, so the
     hourly sequence and seasonal shape are ERA5's. The level still comes from the target
     (the GWA CF layer, x the market-turbine ratio and the level factor): a scalar trim on
     the mapped speeds closes the remaining gap between the Weibull-integrated CF and the
     GWA CF layer; it is reported (on_qm_trim) and is not capped beyond [0.6, 1.8].
The power curve is the region's market turbine where the resource CSV names one
(on_market), else the IEC-class reference curve as before. Offshore is not touched.

Writes <out>/on_<year>.npy, on_rows.npy, k_on.npz (k = scalar k or QM trim) and
t081_diag.csv: location_id, on_k, on_raw_cf, on_final_cf, on_clamped (scalar k clamped),
on_method (scalar|qm|scalar_kept: clamped, but the mapping got no closer to the target), on_qm_trim, on_scalar_cf (what the clamped scalar would give).

  python3 -I build_wind_t081.py --repo <wt> --resource <csv> --mixture <npz> --era5 <dir> \
      --out work/wind [--only <ids>] [--procs 5]
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import date
from multiprocessing import get_context
from pathlib import Path

import numpy as np
import pandas as pd

LOSSES = 0.12
RHO0 = 1.225
YEARS = list(range(2015, 2025))
G = {}


def _one(i):
    curve, target = G["curves"][i], G["target"][i]
    v = G["sp"][:, i].astype("float64") * (G["dens"][i] / RHO0) ** (1.0 / 3.0)
    if not np.isfinite(v).all() or v.max() <= 0:
        return i, None
    keep = 1.0 - LOSSES
    k, clamped = G["solve_k"](v, curve, float(target) / keep)
    raw = float(curve.output(v).mean()) * keep
    scalar_cf = float((curve.output(v * k) * keep).mean())
    res = dict(k=k, clamped=int(clamped), raw=raw, scalar_cf=scalar_cf, method="scalar", trim=np.nan)
    if clamped and not G["scalar_only"]:
        cdf = G["cdf"][G["mix_row"][i]].astype("float64")
        if not np.isfinite(cdf).all():
            return i, dict(res, method="scalar_nomix", series=curve.output(v * k) * keep)
        n = v.size
        order = np.argsort(G["sp"][:, i], kind="stable")
        p = np.empty(n)
        p[order] = (np.arange(n) + 0.5) / n
        # inverse of the mixture CDF; keep the strictly increasing part of the curve
        cm = np.maximum.accumulate(cdf)
        u, first = np.unique(cm, return_index=True)
        vq = np.interp(p, u, G["vgrid"][first]) * (G["dens"][i] / RHO0) ** (1.0 / 3.0)
        trim, cl2 = G["solve_k"](vq, curve, float(target) / keep)
        series = curve.output(vq * trim) * keep
        final = float(series.mean())
        if abs(final - target) >= abs(scalar_cf - target):
            # the mapping cannot get closer to the target than the clamped scalar (very windy
            # sites, where the curve's 25 m/s cut-out caps the CF): keep the shipped profile
            s0 = curve.output(v * k) * keep
            return i, dict(res, method="scalar_kept", trim=trim, series=s0, final=float(s0.mean()))
        return i, dict(res, method="qm", trim=trim, clamped_trim=int(cl2), series=series, final=final)
    series = curve.output(v * k) * keep
    return i, dict(res, series=series, final=float(series.mean()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--resource", type=Path, required=True)
    ap.add_argument("--mixture", type=Path, help="site_selection --mixture-out npz (not needed with --scalar-only)")
    ap.add_argument("--era5", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--only", type=str, default=None, help="comma-separated location_ids (pilot); no npy written")
    ap.add_argument("--scalar-only", action="store_true", help="identity check: never quantile-map")
    ap.add_argument("--procs", type=int, default=5)
    a = ap.parse_args()
    sys.path.insert(0, str(a.repo / "pipeline"))
    from scripts.pipeline.wind.build_wind_profiles import solve_k  # noqa
    from scripts.pipeline.wind.turbines import region_curve  # noqa

    df = pd.read_csv(a.resource)
    ids = df["location_id"].to_numpy()
    n = len(df)
    parts = []
    hours = []
    for y in YEARS:
        z = np.load(a.era5 / f"era5_speed_{y}.npz")
        assert (z["location_id"] == ids).all(), y
        parts.append(z["on"])
        hours.append(z["on"].shape[0])
        assert hours[-1] == (date(y + 1, 1, 1) - date(y, 1, 1)).days * 24
    sp = np.concatenate(parts, axis=0)
    del parts
    mx = np.load(a.mixture) if a.mixture else {"location_id": np.array([], int), "cdf": None, "v": None}
    pos = {int(v): j for j, v in enumerate(mx["location_id"])}
    viable = df["on_viable"].to_numpy() == 1
    target = df["on_cf_target"].to_numpy()
    dens = df["on_site_air_density"].to_numpy()
    dens = np.where(np.isfinite(dens) & (dens > 0.5), dens, RHO0)
    cache = {}
    curves = []
    for _, r in df.iterrows():
        c = region_curve(r)
        curves.append(cache.setdefault(c.name, c))
    G.update(sp=sp, target=target, dens=dens, curves=curves, solve_k=solve_k, cdf=mx["cdf"], vgrid=mx["v"],
             mix_row=np.array([pos.get(int(i), -1) for i in ids]), scalar_only=a.scalar_only)
    todo = [i for i in range(n) if viable[i] and np.isfinite(target[i]) and target[i] > 0]
    if a.only:
        want = {int(x) for x in a.only.split(",")}
        todo = [i for i in todo if int(ids[i]) in want]
    t0 = time.time()
    res = {}
    with get_context("fork").Pool(a.procs) as pool:
        for i, r in pool.imap_unordered(_one, todo, chunksize=8):
            if r is not None:
                res[i] = r
    print(f"solved {len(res)} regions in {time.time()-t0:.0f} s; methods "
          f"{pd.Series([r['method'] for r in res.values()]).value_counts().to_dict()}", flush=True)
    rows = np.array(sorted(res))
    diag = pd.DataFrame({"location_id": ids})
    for c in ("on_k", "on_raw_cf", "on_final_cf", "on_qm_trim", "on_scalar_cf"):
        diag[c] = np.nan
    diag["on_clamped"] = 0
    diag["on_method"] = ""
    for i, r in res.items():
        diag.loc[i, ["on_k", "on_raw_cf", "on_final_cf", "on_qm_trim", "on_scalar_cf"]] = [
            r["trim"] if r["method"] == "qm" else r["k"], r["raw"], r["final"], r["trim"], r["scalar_cf"]]
        diag.loc[i, "on_clamped"] = r["clamped"]
        diag.loc[i, "on_method"] = r["method"]
    a.out.mkdir(parents=True, exist_ok=True)
    if a.only:
        diag.iloc[rows].to_csv(a.out / "pilot_diag.csv", index=False)
        np.savez(a.out / "pilot_series.npz", location_id=ids[rows],
                 series=np.stack([res[i]["series"].astype("float32") for i in rows]))
        return
    diag.to_csv(a.out / "t081_diag.csv", index=False)
    kk = np.full(n, np.nan)
    kk[rows] = diag["on_k"].to_numpy()[rows]
    np.savez(a.out / "k_on.npz", k=kk, rows=rows, location_id=ids[rows])
    np.save(a.out / "on_rows.npy", ids[rows])
    lons = df["longitude"].to_numpy()
    h0 = 0
    for y, h in zip(YEARS, hours):
        out = np.zeros((len(rows), h), dtype="float32")
        for j, i in enumerate(rows):
            out[j] = np.roll(res[i]["series"][h0:h0 + h], int(round(lons[i] / 15.0))).astype("float32")
        np.save(a.out / f"on_{y}.npy", out)
        print(f"{y} on: {len(rows)} profiles, mean CF {out.mean():.4f}", flush=True)
        h0 += h


if __name__ == "__main__":
    main()
