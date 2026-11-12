"""T088 step 2: solar and wind droughts per region, their coincidence and the supply gap.

Metrics exactly as team/reports/T088-expectations.md (committed before this ran):
  drought      W-day trailing mean < 50% of the source's ten-year mean (t50), or in the
               region's bottom 5% of W-day windows (p5); W = 1, 3, 7, 14
  ratio        P(both) / (P(solar) * P(wind)); NaN where a marginal is 0
  shift ratio  same with wind years cycled k = 1..9 against solar (seasons kept, weather broken):
               mean_k P_both_k / mean_k (Ps_k * Pw_k)
  correlation  Pearson r of daily anomalies (day minus 31-day-smoothed ten-year calendar-day mean)
               per season, and of non-overlapping 7-day means of those anomalies; plus r of the
               raw 7-day means over the whole year
  deficit      supply scaled to ten-year mean 1 (flat demand 1): W * (1 - lowest W-day mean),
               in days of average demand; solar, wind (onshore), 50/50 energy mix, atlas t90 build
               energy split; plus the t90 build as built (no rescale)
Inputs: <out>/daily.npz (daily.py), take1_cells.csv, voronoi_overlapping_countries.csv.
Writes <out>/regions.csv and <out>/aggregates.csv.

  python3 -I analyse.py --repo <worktree> --out ~/wind-atlas-T088/out
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

WINDOWS = (1, 3, 7, 14)
DEFS = ("t50", "p5")
NDAY = 3650
EUROPE = set("""AUT BEL BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT
ROU SVK SVN ESP SWE GBR NOR CHE ISL LIE ALB BIH MNE MKD SRB XKX UKR BLR MDA AND MCO SMR""".split())
# month of each day of a 365-day year
MONTH = np.repeat(np.arange(1, 13), [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
SEASONS = {"DJF": (12, 1, 2), "MAM": (3, 4, 5), "JJA": (6, 7, 8), "SON": (9, 10, 11)}


def wmeans(x, w):
    """trailing W-day means along axis 1 (float64 cumsum)."""
    c = np.concatenate([np.zeros((x.shape[0], 1)), np.cumsum(x, axis=1, dtype=np.float64)], axis=1)
    return (c[:, w:] - c[:, :-w]) / w


def droughts(r, kind):
    if kind == "t50":
        return r < 0.5
    q = np.quantile(r, 0.05, axis=1, keepdims=True)
    return r <= q


def ratio(ds, dw):
    ps, pw, pb = ds.mean(1), dw.mean(1), (ds & dw).mean(1)
    with np.errstate(invalid="ignore", divide="ignore"):
        rr = np.where((ps > 0) & (pw > 0), pb / (ps * pw), np.nan)
    return ps, pw, pb, rr


def rowcorr(a, b):
    a = a - a.mean(1, keepdims=True)
    b = b - b.mean(1, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        return (a * b).sum(1) / np.sqrt((a * a).sum(1) * (b * b).sum(1))


def anomalies(x):
    clim = x.reshape(x.shape[0], 10, 365).mean(1)
    k = np.ones(31) / 31
    pad = np.concatenate([clim[:, -15:], clim, clim[:, :15]], axis=1)
    sm = np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 1, pad)
    return x - np.tile(sm, 10)


def wmedian(v, w):
    ok = np.isfinite(v) & (w > 0)
    if ok.sum() == 0:
        return np.nan
    v, w = v[ok], w[ok]
    o = np.argsort(v)
    cw = np.cumsum(w[o])
    return float(v[o][np.searchsorted(cw, cw[-1] / 2)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    D = np.load(a.out / "daily.npz")
    cells = pd.read_csv(a.repo / "scripts/article/out/take1_cells.csv")
    oc = pd.read_csv(a.repo / "deployment/data/voronoi_overlapping_countries.csv")[["location_id", "country_iso3", "country_name"]]
    cells = cells.merge(oc, on="location_id", how="left")
    # rows: regions with an onshore profile whose ten-year mean CF is at least 2%
    on_pos = {int(r): i for i, r in enumerate(D["on_rows"])}
    off_pos = {int(r): i for i, r in enumerate(D["off_rows"])}
    s_pos = {int(r): i for i, r in enumerate(D["solar_ids"])}
    cells = cells[cells.location_id.isin(on_pos)].reset_index(drop=True)
    S = D["solar"][[s_pos[i] for i in cells.location_id]].astype(np.float64)
    Wn = D["on"][[on_pos[i] for i in cells.location_id]].astype(np.float64)
    keep = (Wn.mean(1) >= 0.02) & (S.mean(1) > 0)
    print(f"regions with onshore profile {len(cells)}, kept (wind mean >= 2%) {keep.sum()}")
    cells, S, Wn = cells[keep].reset_index(drop=True), S[keep], Wn[keep]
    n = len(cells)
    lat = cells.lat.to_numpy()
    out = cells[["location_id", "lat", "lon", "pop", "demand_twh", "country_iso3", "country_name", "t90_class", "t90_build"]].copy()
    ms, mw = S.mean(1, keepdims=True), Wn.mean(1, keepdims=True)
    out["solar_cf"], out["wind_cf"] = ms[:, 0], mw[:, 0]
    s1, w1 = S / ms, Wn / mw  # each source / its own ten-year mean

    # ---- atlas t90 build supply (GW per GW load)
    b = cells.t90_build.str.split("|", expand=True)
    sg = b[0].astype(float).to_numpy()
    wtok = b[1].str.split(":", expand=True)
    wg = wtok[0].astype(float).to_numpy()
    surf = wtok[1].fillna("none").to_numpy() if wtok.shape[1] > 1 else np.array(["none"] * n)
    Wb = np.zeros_like(Wn)
    for i in range(n):
        if surf[i] == "on":
            Wb[i] = Wn[i]
        elif surf[i] in ("off", "both"):
            lid = int(cells.location_id[i])
            off = D["off"][off_pos[lid]].astype(np.float64) if lid in off_pos else Wn[i]
            Wb[i] = off if surf[i] == "off" else 0.5 * (Wn[i] + off)  # 'both': 1 region, split evenly
    built = sg[:, None] * S + wg[:, None] * Wb
    out["t90_solar_gw"], out["t90_wind_gw"], out["t90_wind_surface"] = sg, wg, surf
    out["t90_wind_energy_share"] = (wg[:, None] * Wb).mean(1) / built.mean(1)
    m50 = 0.5 * s1 + 0.5 * w1
    mat = built / built.mean(1, keepdims=True)

    # ---- droughts and coincidence
    for w in WINDOWS:
        rs, rw = wmeans(s1, w), wmeans(w1, w)
        for kind in DEFS:
            ds, dw = droughts(rs, kind), droughts(rw, kind)
            ps, pw, pb, rr = ratio(ds, dw)
            p = f"w{w}_{kind}_"
            out[p + "ps"], out[p + "pw"], out[p + "pboth"], out[p + "ratio"] = ps, pw, pb, rr
            if kind == "t50":  # added after the first run: the same drought test applied to the mixes
                out[p + "pmix50"] = (wmeans(m50, w) < 0.5).mean(1)
                out[p + "pmixatlas"] = (wmeans(mat, w) < 0.5).mean(1)
            # year-shift benchmark
            pbk, ppk = [], []
            for k in range(1, 10):
                rwk = wmeans(np.roll(w1, 365 * k, axis=1), w)
                dwk = droughts(rwk, kind)
                pbk.append((ds & dwk).mean(1))
                ppk.append(ps * dwk.mean(1))
            with np.errstate(invalid="ignore", divide="ignore"):
                out[p + "shift_ratio"] = np.where(np.mean(ppk, 0) > 0, np.mean(pbk, 0) / np.mean(ppk, 0), np.nan)
            out[p + "pboth_shift"], out[p + "pexp_shift"] = np.mean(pbk, 0), np.mean(ppk, 0)
            if kind == "t50" and w == 7:
                # season of solar and wind droughts: share of drought windows ending in local winter
                endm = np.tile(MONTH, 10)[w - 1:]
                north = lat[:, None] >= 0
                winter = np.where(north, np.isin(endm, (11, 12, 1, 2))[None, :], np.isin(endm, (5, 6, 7, 8))[None, :])
                with np.errstate(invalid="ignore", divide="ignore"):
                    out["w7_t50_solar_share_in_winter"] = (ds & winter).sum(1) / ds.sum(1)
                    out["w7_t50_wind_share_in_winter"] = (dw & winter).sum(1) / dw.sum(1)
        out[f"w{w}_corr_raw"] = rowcorr(rs, rw)
    # ---- anomaly correlations by season
    aS, aW = anomalies(S), anomalies(Wn)
    mon = np.tile(MONTH, 10)
    wk = (NDAY // 7) * 7
    aSw = aS[:, :wk].reshape(n, -1, 7).mean(2)
    aWw = aW[:, :wk].reshape(n, -1, 7).mean(2)
    monw = mon[:wk].reshape(-1, 7)[:, 3]
    out["corr_daily_all"] = rowcorr(aS, aW)
    out["corr_weekly_all"] = rowcorr(aSw, aWw)
    for sname, ms_ in SEASONS.items():
        m = np.isin(mon, ms_)
        mw_ = np.isin(monw, ms_)
        out[f"corr_daily_{sname}"] = rowcorr(aS[:, m], aW[:, m])
        out[f"corr_weekly_{sname}"] = rowcorr(aSw[:, mw_], aWw[:, mw_])
    north = lat >= 0
    out["corr_daily_winter"] = np.where(north, out.corr_daily_DJF, out.corr_daily_JJA)
    out["corr_weekly_winter"] = np.where(north, out.corr_weekly_DJF, out.corr_weekly_JJA)
    out["corr_daily_summer"] = np.where(north, out.corr_daily_JJA, out.corr_daily_DJF)

    # ---- worst-window deficits (days of average demand)
    for w in (1, 3, 7, 14):
        for name, x in (("solar", s1), ("wind", w1), ("mix50", m50), ("mixatlas", mat)):
            r = wmeans(x, w)
            out[f"def{w}_{name}"] = w * (1 - r.min(1))
            if w in (7, 14):
                out[f"def{w}_{name}_end_day"] = r.argmin(1) + w - 1  # day index (0..3649) of the window's last day
        best = np.minimum(out[f"def{w}_solar"], out[f"def{w}_wind"])
        with np.errstate(invalid="ignore", divide="ignore"):
            out[f"shrink{w}_mix50"] = 1 - out[f"def{w}_mix50"] / best
            out[f"shrink{w}_mixatlas"] = 1 - out[f"def{w}_mixatlas"] / best
            out[f"shrink{w}_mix50_vs_solar"] = 1 - out[f"def{w}_mix50"] / out[f"def{w}_solar"]
        out[f"def{w}_built"] = w * np.maximum(0, 1 - wmeans(built, w).min(1))
    out = out.copy()
    out.to_csv(a.out / "regions.csv", index=False, float_format="%.5g")
    print(f"regions.csv: {len(out)} rows, {out.shape[1]} columns")

    # ---- aggregates
    groups = {"World": np.ones(n, bool), "Europe": out.country_iso3.isin(EUROPE).to_numpy(),
              "North America (USA+CAN)": out.country_iso3.isin(["USA", "CAN"]).to_numpy(),
              "Canada": (out.country_iso3 == "CAN").to_numpy(),
              "Northern US (>=40N)": ((out.country_iso3 == "USA") & (lat >= 40)).to_numpy(),
              "Germany": (out.country_iso3 == "DEU").to_numpy()}
    bands = [(60, 91, "60N+"), (45, 60, "45-60N"), (30, 45, "30-45N"), (15, 30, "15-30N"), (-15, 15, "15S-15N"),
             (-30, -15, "15-30S"), (-45, -30, "30-45S"), (-91, -45, "45S+")]
    for lo, hi, nm in bands:
        groups["lat " + nm] = (lat >= lo) & (lat < hi)
    rows = []
    for g, m in groups.items():
        for wname, wcol in (("demand", "demand_twh"), ("people", "pop")):
            wt = out[wcol].to_numpy() * m
            row = {"group": g, "weight": wname, "n_regions": int(m.sum()),
                   "weight_total": float(wt.sum())}
            for w in WINDOWS:
                for kind in DEFS:
                    p = f"w{w}_{kind}_"
                    ps, pw, pb = (out[p + c].to_numpy() for c in ("ps", "pw", "pboth"))
                    den = (wt * ps * pw).sum()
                    row[p + "pooled_ratio"] = (wt * pb).sum() / den if den > 0 else np.nan
                    row[p + "median_ratio"] = wmedian(out[p + "ratio"].to_numpy(), wt)
                    row[p + "share_weight_ratio_lt1"] = float((wt * (out[p + "ratio"] < 1)).sum() / wt.sum()) if wt.sum() else np.nan
                    row[p + "share_weight_ratio_defined"] = float((wt * np.isfinite(out[p + "ratio"])).sum() / wt.sum()) if wt.sum() else np.nan
                    row[p + "median_shift_ratio"] = wmedian(out[p + "shift_ratio"].to_numpy(), wt)
                    sd = (wt * out[p + "pexp_shift"]).sum()
                    row[p + "pooled_shift_ratio"] = (wt * out[p + "pboth_shift"]).sum() / sd if sd > 0 else np.nan
                    row[p + "mean_pexp"] = den / wt.sum() if wt.sum() else np.nan  # 'both' if independent
                    row[p + "mean_ps"] = (wt * ps).sum() / wt.sum() if wt.sum() else np.nan
                    row[p + "mean_pw"] = (wt * pw).sum() / wt.sum() if wt.sum() else np.nan
                    row[p + "mean_pboth"] = (wt * pb).sum() / wt.sum() if wt.sum() else np.nan
                    if kind == "t50":
                        for mx in ("pmix50", "pmixatlas"):
                            row[p + "mean_" + mx] = (wt * out[p + mx]).sum() / wt.sum() if wt.sum() else np.nan
            for c in ["w7_t50_solar_share_in_winter", "w7_t50_wind_share_in_winter", "corr_daily_winter", "corr_weekly_winter", "corr_daily_summer", "corr_daily_all", "corr_weekly_all",
                      "w7_corr_raw", "w14_corr_raw"] + [f"corr_daily_{s}" for s in SEASONS] + [f"corr_weekly_{s}" for s in SEASONS]:
                row["median_" + c] = wmedian(out[c].to_numpy(), wt)
            for w in (1, 3, 7, 14):
                for nm in ("solar", "wind", "mix50", "mixatlas", "built"):
                    row[f"median_def{w}_{nm}"] = wmedian(out[f"def{w}_{nm}"].to_numpy(), wt)
                for nm in ("mix50", "mixatlas", "mix50_vs_solar"):
                    row[f"median_shrink{w}_{nm}"] = wmedian(out[f"shrink{w}_{nm}"].to_numpy(), wt)
            row["median_t90_wind_energy_share"] = wmedian(out.t90_wind_energy_share.to_numpy(), wt)
            rows.append(row)
    agg = pd.DataFrame(rows)
    agg.to_csv(a.out / "aggregates.csv", index=False, float_format="%.4g")
    print(f"aggregates.csv: {len(agg)} rows")


if __name__ == "__main__":
    main()
