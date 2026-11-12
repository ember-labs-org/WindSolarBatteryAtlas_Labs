"""T088 step 3: examples (chosen by rule), Germany national aggregate, tables and figures.

Examples (rule fixed in T088-expectations.md): highest-demand region in Germany, Canada, the USA at
>= 40N and Spain below 38.5N. Worst local-winter fortnight = the 14-day window wholly inside Nov-Feb
(north) / May-Aug (south) with the lowest 50/50-mix mean in the decade.
Germany national: demand-weighted mean of the daily CF of Germany's regions (each source), then the
same deficit and drought metrics.

  python3 -I figs.py --repo <worktree> --out ~/wind-atlas-T088/out --figs ~/wind-atlas-T088/figs
"""
import argparse
import datetime as dt
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

MONTH = np.repeat(np.arange(1, 13), [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
C_SOLAR, C_WIND, C_MIX, C_BOTH, C_IND = "#E8A33D", "#3E7CB1", "#2A9D6F", "#B23A48", "#9A9A9A"


def day_date(i):
    y, d = 2015 + i // 365, i % 365
    base = dt.date(y, 1, 1) + dt.timedelta(days=int(d))
    if y % 4 == 0 and d >= 59:  # 29 Feb was dropped
        base += dt.timedelta(days=1)
    return base


def wmeans(x, w):
    c = np.concatenate([[0.0], np.cumsum(x, dtype=np.float64)])
    return (c[w:] - c[:-w]) / w


def world_outline(ax, repo):
    g = json.load(open(repo / "deployment/data/world.geojson"))
    for f in g["features"]:
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for p in polys:
            ring = np.array(p[0])
            ax.fill(ring[:, 0], ring[:, 1], color="#EEEEEE", lw=0.2, ec="#BBBBBB", zorder=0)


def mapfig(r, col, title, path, repo, cmap, vmin, vmax, label, undefined_note=None):
    fig, ax = plt.subplots(figsize=(11, 5.6))
    world_outline(ax, repo)
    ok = np.isfinite(r[col])
    if undefined_note:
        ax.scatter(r.lon[~ok], r.lat[~ok], s=7, c="#CFCFCF", marker="s", lw=0, label=undefined_note)
    sc = ax.scatter(r.lon[ok], r.lat[ok], c=r[col][ok].clip(vmin, vmax), cmap=cmap, vmin=vmin, vmax=vmax, marker="s", lw=0, s=7)
    cb = fig.colorbar(sc, ax=ax, shrink=0.7, pad=0.01)
    cb.set_label(label)
    ax.set_xlim(-180, 180)
    ax.set_ylim(-58, 82)
    ax.set_aspect(1.15)
    ax.set_xticks([])
    ax.set_yticks([-45, -30, -15, 0, 15, 30, 45, 60])
    ax.set_title(title, loc="left", fontsize=12)
    if undefined_note:
        ax.legend(loc="lower left", markerscale=4, frameon=False, fontsize=8)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--figs", type=Path, required=True)
    a = ap.parse_args()
    a.figs.mkdir(parents=True, exist_ok=True)
    r = pd.read_csv(a.out / "regions.csv")
    agg = pd.read_csv(a.out / "aggregates.csv")
    D = np.load(a.out / "daily.npz")
    s_pos = {int(v): i for i, v in enumerate(D["solar_ids"])}
    on_pos = {int(v): i for i, v in enumerate(D["on_rows"])}

    # ---------- examples
    rules = [("Germany (Rhine-Ruhr)", "country_iso3=='DEU'"), ("Canada (southern Ontario)", "country_iso3=='CAN'"),
             ("Northern US (New York-Connecticut)", "country_iso3=='USA' and lat>=40"),
             ("Southern Spain (Murcia)", "country_iso3=='ESP' and lat<38.5")]
    ex_rows, series = [], {}
    mon = np.tile(MONTH, 10)
    for label, q in rules:
        x = r.query(q).sort_values("demand_twh", ascending=False).iloc[0]
        lid = int(x.location_id)
        s = D["solar"][s_pos[lid]].astype(np.float64)
        w = D["on"][on_pos[lid]].astype(np.float64)
        s1, w1 = s / s.mean(), w / w.mean()
        m = 0.5 * s1 + 0.5 * w1
        win = np.isin(mon, (11, 12, 1, 2)) if x.lat >= 0 else np.isin(mon, (5, 6, 7, 8))
        mw = wmeans(m, 14)
        inside = wmeans(win.astype(float), 14) == 1
        mw[~inside] = np.inf
        end = int(mw.argmin())
        start, stop = end, end + 14  # wmeans[i] covers days i..i+13
        ex_rows.append(dict(example=label, location_id=lid, lat=x.lat, lon=x.lon, demand_twh=x.demand_twh,
                            solar_cf=s.mean(), wind_cf=w.mean(), t90_build=x.t90_build,
                            fortnight=f"{day_date(start)} to {day_date(stop - 1)}",
                            fortnight_solar_pct=100 * s1[start:stop].mean(), fortnight_wind_pct=100 * w1[start:stop].mean(),
                            fortnight_mix50_pct=100 * m[start:stop].mean(),
                            def7_solar=x.def7_solar, def7_wind=x.def7_wind, def7_mix50=x.def7_mix50, def7_mixatlas=x.def7_mixatlas,
                            def14_solar=x.def14_solar, def14_wind=x.def14_wind, def14_mix50=x.def14_mix50, def14_mixatlas=x.def14_mixatlas,
                            w7_t50_ps=x.w7_t50_ps, w7_t50_pw=x.w7_t50_pw, w7_t50_pboth=x.w7_t50_pboth, w7_t50_ratio=x.w7_t50_ratio,
                            w7_t50_pmix50=x.w7_t50_pmix50, w7_p5_ratio=x.w7_p5_ratio, corr_weekly_winter=x.corr_weekly_winter,
                            corr_daily_winter=x.corr_daily_winter))
        lo, hi = max(0, start - 14), min(len(m), stop + 14)
        series[label] = (lo, hi, start, stop, s1[lo:hi], w1[lo:hi], m[lo:hi])
    ex = pd.DataFrame(ex_rows)

    # ---------- Germany national aggregate (demand-weighted regional profiles)
    de = r[r.country_iso3 == "DEU"]
    wts = de.demand_twh.to_numpy() / de.demand_twh.sum()
    s = sum(wt * D["solar"][s_pos[int(l)]].astype(np.float64) for wt, l in zip(wts, de.location_id))
    w = sum(wt * D["on"][on_pos[int(l)]].astype(np.float64) for wt, l in zip(wts, de.location_id))
    s1, w1 = s / s.mean(), w / w.mean()
    nat = {"example": "Germany, national (8 regions, demand-weighted)", "solar_cf": s.mean(), "wind_cf": w.mean()}
    for W in (7, 14):
        for nm, v in (("solar", s1), ("wind", w1), ("mix50", 0.5 * s1 + 0.5 * w1)):
            nat[f"def{W}_{nm}"] = W * (1 - wmeans(v, W).min())
    ds, dw = wmeans(s1, 7) < 0.5, wmeans(w1, 7) < 0.5
    nat.update(w7_t50_ps=ds.mean(), w7_t50_pw=dw.mean(), w7_t50_pboth=(ds & dw).mean(),
               w7_t50_ratio=(ds & dw).mean() / (ds.mean() * dw.mean()),
               w7_t50_pmix50=(wmeans(0.5 * s1 + 0.5 * w1, 7) < 0.5).mean())
    ex = pd.concat([ex, pd.DataFrame([nat])], ignore_index=True)
    ex.to_csv(a.out / "examples.csv", index=False, float_format="%.4g")

    # ---------- figures
    fig, axes = plt.subplots(2, 2, figsize=(12, 7.5), sharey=True)
    for ax, (label, (lo, hi, start, stop, ss, ww, mm)) in zip(axes.flat, series.items()):
        days = [day_date(i) for i in range(lo, hi)]
        ax.axvspan(day_date(start), day_date(stop - 1), color="#F2F2F2", zorder=0)
        ax.plot(days, 100 * ss, color=C_SOLAR, lw=1.6, label="Solar")
        ax.plot(days, 100 * ww, color=C_WIND, lw=1.6, label="Wind (onshore)")
        ax.plot(days, 100 * mm, color=C_MIX, lw=2.4, label="50/50 mix")
        ax.axhline(100, color="#777", lw=0.6, ls=":")
        ax.axhline(50, color="#B23A48", lw=0.6, ls="--")
        row = ex[ex.example == label].iloc[0]
        ax.set_title(f"{label}\nworst winter fortnight {row.fortnight}: mix at {row.fortnight_mix50_pct:.0f}% of its average",
                     fontsize=9.5, loc="left")
        ax.tick_params(axis="x", labelsize=8, rotation=30)
    axes[0, 0].set_ylabel("Daily output, % of ten-year average")
    axes[1, 0].set_ylabel("Daily output, % of ten-year average")
    axes[0, 0].legend(fontsize=8, frameon=False, loc="upper left")
    fig.suptitle("The worst winter fortnight of 2015–2024: solar is low all through; the mix falls only when wind also stalls",
                 fontsize=11, x=0.01, ha="left")
    fig.tight_layout()
    fig.savefig(a.figs / "t088_examples_worst_fortnight.png", dpi=150)
    plt.close(fig)

    # headline chart: drought frequency (7-day, below half of average), demand-weighted
    groups = ["World", "Europe", "North America (USA+CAN)", "Canada", "Northern US (>=40N)", "Germany"]
    d = agg[agg.weight == "demand"].set_index("group").loc[groups]
    d["pexp"] = d.w7_t50_mean_pexp
    fig, ax = plt.subplots(figsize=(11, 5))
    xx = np.arange(len(groups))
    bw = 0.17
    for k, (col, c, lab) in enumerate([("w7_t50_mean_ps", C_SOLAR, "Solar in drought"), ("w7_t50_mean_pw", C_WIND, "Wind in drought"),
                                       ("pexp", C_IND, "Both, if independent"), ("w7_t50_mean_pboth", C_BOTH, "Both at once (observed)"),
                                       ("w7_t50_mean_pmix50", C_MIX, "50/50 mix in drought")]):
        ax.bar(xx + (k - 2) * bw, 100 * d[col], bw, color=c, label=lab)
        for xi, v in zip(xx + (k - 2) * bw, 100 * d[col]):
            ax.text(xi, v + 0.3, f"{v:.1f}", ha="center", fontsize=7)
    ax.set_xticks(xx)
    ax.set_xticklabels(["World", "Europe", "North America", "Canada", "Northern US", "Germany"])
    ax.set_ylabel("Share of 7-day periods, 2015–2024 (%)")
    ax.set_title("Week-long solar and wind droughts coincide less than half as often as chance would predict\n"
                 "Weeks with output below half of the long-run average, weighted by electricity demand", loc="left", fontsize=11)
    ax.legend(frameon=False, fontsize=8, ncol=5, loc="upper left", bbox_to_anchor=(0, -0.08))
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    fig.savefig(a.figs / "t088_drought_frequency.png", dpi=150)
    plt.close(fig)
    d[["w7_t50_mean_ps", "w7_t50_mean_pw", "pexp", "w7_t50_mean_pboth", "w7_t50_mean_pmix50", "w7_t50_pooled_ratio"]].to_csv(a.out / "chart_drought_frequency.csv", float_format="%.4f")

    # latitude bands: ratio observed vs seasonal-only (year-shift)
    bands = ["lat 60N+", "lat 45-60N", "lat 30-45N", "lat 15-30N", "lat 15S-15N", "lat 15-30S", "lat 30-45S", "lat 45S+"]
    b = agg[agg.weight == "demand"].set_index("group").loc[bands]
    fig, ax = plt.subplots(figsize=(9, 4.5))
    yy = np.arange(len(bands))
    ax.barh(yy + 0.2, b.w7_p5_pooled_ratio, 0.38, color=C_BOTH, label="Observed")
    ax.barh(yy - 0.2, b.w7_p5_pooled_shift_ratio, 0.38, color=C_IND, label="Seasons only (years shuffled)")
    ax.axvline(1, color="#333", lw=0.8)
    ax.set_yticks(yy)
    ax.set_yticklabels([x.replace("lat ", "") for x in bands])
    ax.invert_yaxis()
    ax.set_xlabel("Coincidence ratio, worst 5% of weeks (1 = as often as chance)")
    ax.set_title("Outside the tropics, the worst solar and wind weeks rarely overlap (pooled, demand-weighted)", loc="left", fontsize=10)
    ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    fig.savefig(a.figs / "t088_ratio_by_latitude.png", dpi=150)
    plt.close(fig)

    # worst 7-day gap by group
    fig, ax = plt.subplots(figsize=(11, 4.6))
    for k, (col, c, lab) in enumerate([("median_def7_solar", C_SOLAR, "Solar alone"), ("median_def7_wind", C_WIND, "Wind alone"),
                                       ("median_def7_mix50", C_MIX, "50/50 mix"), ("median_def7_mixatlas", "#6C4FA3", "Atlas 90% build, same average")]):
        ax.bar(xx + (k - 1.5) * 0.2, d[col], 0.2, color=c, label=lab)
        for xi, v in zip(xx + (k - 1.5) * 0.2, d[col]):
            ax.text(xi, v + 0.05, f"{v:.1f}", ha="center", fontsize=7)
    ax.set_xticks(xx)
    ax.set_xticklabels(["World", "Europe", "North America", "Canada", "Northern US", "Germany"])
    ax.set_ylabel("Shortfall in worst week, days of average demand")
    ax.set_ylim(0, 7)
    ax.set_title("Mixing wind and solar makes the worst week of the decade only somewhat shallower (demand-weighted median)", loc="left", fontsize=10)
    ax.legend(frameon=False, fontsize=8, ncol=4, loc="upper left", bbox_to_anchor=(0, -0.08))
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    fig.savefig(a.figs / "t088_worst_week_gap.png", dpi=150)
    plt.close(fig)

    # maps
    mapfig(r, "w7_t50_ratio", "How often weekly solar and wind droughts coincide, relative to chance (2015–2024)",
           a.figs / "t088_map_coincidence_ratio.png", a.repo, "RdBu_r", 0, 2, "observed ÷ independent (1 = chance)",
           "solar or wind never below half its average for a week")
    mapfig(r, "w7_p5_ratio", "Worst 5% of solar weeks and worst 5% of wind weeks: overlap relative to chance",
           a.figs / "t088_map_coincidence_ratio_p5.png", a.repo, "RdBu_r", 0, 2, "observed ÷ independent (1 = chance)")
    mapfig(r, "corr_weekly_winter", "Winter weather: correlation of weekly solar and wind anomalies (local winter)",
           a.figs / "t088_map_winter_corr.png", a.repo, "RdBu_r", -0.6, 0.6, "Pearson r")
    mapfig(r, "shrink7_mix50", "How much a 50/50 mix shrinks the worst week, against the better single source",
           a.figs / "t088_map_shrink7.png", a.repo, "PuOr", -0.5, 0.5, "1 − mix gap ÷ better single-source gap")
    print(ex.drop(columns=["t90_build"]).round(3).T.to_string())


if __name__ == "__main__":
    main()
