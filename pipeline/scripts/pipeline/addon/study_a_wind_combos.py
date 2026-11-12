"""T058 study (a): combined onshore + offshore wind builds.

For every region with both eligible land and eligible sea (on_area_km2 > 0 and
off_area_km2 > 0 in the run's voronoi_wind_resource.csv; ATA/GRL excluded),
simulate all 21 combinations onshore {1,2,3,4,5,6,8} x offshore {1,2,3} GW per
GW of load, with solar 0-10 and battery 0-36 step 2 (the wind grid), using the
pipeline's dispatch. Then, with the app's default LCOE:
  * at targets 80/90/95/99%, how often is a combination the cheapest build,
    against today's single-surface grid (summary_w0, w1-8, wo1-8), and by how much;
  * which combinations win, and how much of the saving a subset keeps
    (lean 9 = on 1-4 + off 1-3 with on + off <= 5);
  * reliability: the highest CF reachable with and without combinations.

Inputs: --profiles <dir> with wind_profiles_on.parquet / wind_profiles_off.parquet
(the run's hourly wind) and --data <dir> with that run's summary_*.parquet and
voronoi_wind_resource.csv. Writes <T058_OUT>/<tag>_a_cf.npz.

  ATLAS_WORKSPACE_DIR=<ws> T058_OUT=<scratch>/T058 python3 -I study_a_wind_combos.py \
      --profiles <run>/ws/input_data --data <run>/data --tag t059
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pandas as pd

ON = [1, 2, 3, 4, 5, 6, 8]
OFF = [1, 2, 3]
SOLAR = list(range(0, 11))
BATT = list(range(0, 38, 2))
TARGETS = [0.80, 0.90, 0.95, 0.99]
LEAN9 = [(a, b) for a in (1, 2, 3, 4) for b in (1, 2, 3) if a + b <= 5]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profiles", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--tag", default="run")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--reuse", action="store_true", help="reuse <tag>_a_cf.npz instead of simulating")
    args = ap.parse_args()
    os.environ["T058_DATA"] = str(args.data)
    import common as C
    C.DATA = args.data
    t0 = time.time()

    excl = C.excluded_ids()
    res = pd.read_csv(args.data / "voronoi_wind_resource.csv")
    both = res[(res.on_area_km2 > 0) & (res.off_area_km2 > 0) & ~res.location_id.isin(excl)]
    sel = np.sort(both.location_id.values.astype(int))
    if args.limit:
        sel = sel[: args.limit]
    n = len(sel)
    print(f"[{args.tag}] regions with both eligible land and sea (excl. ATA/GRL): {n}")

    ids, solar_all = C.load_solar()
    sol = np.ascontiguousarray(solar_all[np.searchsorted(ids, sel)])
    _, on = C.load_wind(args.profiles / "wind_profiles_on.parquet", ids, sel)
    _, off = C.load_wind(args.profiles / "wind_profiles_off.parquet", ids, sel)
    print(f"  profiles loaded: mean CF on {on.mean():.3f} off {off.mean():.3f} ({time.time()-t0:.0f} s)")

    # today's single-surface grid for these regions, from the run's summaries
    frames = []
    for f in sorted(args.data.glob("summary_w*.parquet")):
        d = pd.read_parquet(f, columns=["location_id", "solar_gw", "wind_gw", "batt_gwh", "annual_cf"])
        d = d[d.location_id.isin(sel)]
        d["surface"] = "off" if f.name.startswith("summary_wo") else "on"
        frames.append(d)
    today = pd.concat(frames, ignore_index=True)
    today["w_on"] = np.where(today.surface == "on", today.wind_gw, 0)
    today["w_off"] = np.where(today.surface == "off", today.wind_gw, 0)
    today["key"] = today.surface + "|" + today.solar_gw.astype(str) + "|" + today.wind_gw.astype(str) + "|" + today.batt_gwh.astype(str)
    piv = today.pivot_table(index="location_id", columns="key", values="annual_cf").loc[sel]
    meta = today.drop_duplicates("key").set_index("key").loc[piv.columns]
    t_cf = piv.values.T.astype(float)                       # (n_today, n)
    t_s, t_b = meta.solar_gw.values.astype(float), meta.batt_gwh.values.astype(float)
    t_on, t_off = meta.w_on.values.astype(float), meta.w_off.values.astype(float)

    # harness check: single-surface wind reproduces the run's summaries
    for s, w, b, surf in [(0, 1, 0, "on"), (3, 2, 8, "on"), (0, 1, 0, "off"), (5, 3, 20, "off")]:
        m = on if surf == "on" else off
        cf, _, _ = C.simulate_soc(sol, (m * np.float32(w)).astype("float32"), s, 1.0, b)
        cf_direct, _, _ = C.simulate_soc(sol, m, s, w, b)
        ref = piv[f"{surf}|{s}|{w}|{b}"].values
        diff = np.round(cf_direct, 4).astype("float32") != ref.astype("float32")
        ties = np.abs(cf_direct - ref) <= 5.1e-5
        print(f"  check {surf} s{s} w{w} b{b}: kernel equals summary {bool(np.all(~diff | ties))} "
              f"({int(diff.sum())} half-way ties); premultiplied wind max |d| {np.abs(cf - cf_direct).max():.1e}")

    # unit CFs for the degradation blend (the worker's unitCfg)
    u = C.unit_cfs().loc[sel]
    ucf_s, ucf_on, ucf_off = u.s.values, u.on.values, u.off.values
    cost = C.Cost()

    # simulate the combinations
    combos = [(a, b) for a in ON for b in OFF]
    cfs = np.zeros((len(combos), len(SOLAR), len(BATT), n), dtype="float32")
    npz = C.OUT / f"{args.tag}_a_cf.npz"
    if args.reuse and npz.exists():
        z = np.load(npz)
        assert np.array_equal(z["ids"], sel)
        cfs = z["cf"]
    for ci, (a, b) in enumerate([] if args.reuse and npz.exists() else combos):
        wind = (on * np.float32(a) + off * np.float32(b)).astype("float32")
        for si, s in enumerate(SOLAR):
            for bi, bb in enumerate(BATT):
                cf, _, _ = C.simulate_soc(sol, wind, s, 1.0, bb)
                cfs[ci, si, bi] = np.round(cf, 4)
        print(f"  on {a} + off {b}: done ({time.time()-t0:.0f} s)", flush=True)
    if not args.reuse:
        np.savez_compressed(npz, ids=sel, combos=np.array(combos), solar=SOLAR, batt=BATT, cf=cfs)

    # price everything
    t_l = cost.lcoe(t_cf, t_s[:, None], t_b[:, None], t_on[:, None], t_off[:, None], ucf_s, ucf_on, ucf_off)
    c_l = np.zeros_like(cfs, dtype=float)
    for ci, (a, b) in enumerate(combos):
        for si, s in enumerate(SOLAR):
            c_l[ci, si] = cost.lcoe(cfs[ci, si].astype(float), float(s), np.array(BATT, float)[:, None],
                                    float(a), float(b), ucf_s, ucf_on, ucf_off)
    c_cf = cfs.reshape(len(combos), -1, n).astype(float)
    c_l = c_l.reshape(len(combos), -1, n)

    def best(cf, l, T):
        lt = np.where(cf >= T, l, np.inf)
        return lt.min(axis=0)

    print("\n== Cheapest build at each target: today's grid vs + all 21 combinations")
    for T in TARGETS:
        b_today = best(t_cf, t_l, T)
        per = np.stack([best(c_cf[ci], c_l[ci], T) for ci in range(len(combos))])   # (21, n)
        b_all = np.minimum(b_today, per.min(axis=0))
        lean_idx = [combos.index(c) for c in LEAN9]
        b_lean = np.minimum(b_today, per[lean_idx].min(axis=0))
        win = per.min(axis=0) < b_today
        reach_today = np.isfinite(b_today)
        newly = ~reach_today & np.isfinite(b_all)
        both_ok = reach_today & win
        sav = 1 - b_all[both_ok] / b_today[both_ok]
        win_lean = per[lean_idx].min(axis=0) < b_today
        sav_lean = 1 - b_lean[both_ok] / b_today[both_ok]
        captured = np.where(sav > 0, sav_lean / sav, 1)
        print(f"  T={T:.2f}: reach today {reach_today.sum()}, with combos {np.isfinite(b_all).sum()} "
              f"(new {newly.sum()}); a combination is cheapest in {win.sum()} of {n} "
              f"(lean 9: {win_lean.sum()})")
        if both_ok.any():
            print(f"      saving where a combination wins: median {np.median(sav)*100:.1f}% p90 "
                  f"{np.percentile(sav, 90)*100:.1f}% max {sav.max()*100:.1f}%; "
                  f"> 1%: {(sav > 0.01).sum()}, > 5%: {(sav > 0.05).sum()}")
            print(f"      lean 9 keeps: median {np.median(captured)*100:.0f}% of that saving, "
                  f"p10 {np.percentile(captured, 10)*100:.0f}%; regions where lean 9 loses > 1% of LCOE vs all 21: "
                  f"{int((b_lean[both_ok] / b_all[both_ok] - 1 > 0.01).sum())}")
        winner = np.argmin(per, axis=0)
        counts = pd.Series([f"on{combos[k][0]}+off{combos[k][1]}" for k in winner[win]]).value_counts()
        print("      winning combinations: " + ", ".join(f"{k} {v}" for k, v in counts.items()))

    print("\n== Subsets: regions where the subset is > 1% / > 5% dearer than all 21, and regions that reach the target only with all 21")
    SUBSETS = {
        "lean 9 (on 1-4 + off 1-3, total <= 5)": LEAN9,
        "lean 9 + off 1 with on 5,6,8": LEAN9 + [(5, 1), (6, 1), (8, 1)],
        "lean 9 + on 5,6,8 with off 1,2": LEAN9 + [(5, 1), (6, 1), (8, 1), (5, 2), (6, 2), (8, 2)],
        "on 1-4 + off 1-3 (12)": [(a, b) for a in (1, 2, 3, 4) for b in (1, 2, 3)],
        "on 1-3 + off 1 (3)": [(1, 1), (2, 1), (3, 1)],
    }
    for name, sub in SUBSETS.items():
        idx = [combos.index(c) for c in sub]
        parts = []
        for T in TARGETS:
            b_today = best(t_cf, t_l, T)
            per = np.stack([best(c_cf[ci], c_l[ci], T) for ci in range(len(combos))])
            b_all = np.minimum(b_today, per.min(axis=0))
            b_sub = np.minimum(b_today, per[idx].min(axis=0))
            ok = np.isfinite(b_all)
            r = b_sub[ok] / b_all[ok] - 1
            parts.append(f"{T:.2f}: >1% {int((r > 0.01).sum())}, >5% {int((r > 0.05).sum())}, unreached {int(np.isinf(r).sum())}")
        print(f"  {name} [{len(sub)}]: " + "; ".join(parts))

    print("\n== Reliability: highest CF reachable")
    mx_today = t_cf.max(axis=0)
    mx_all = np.maximum(mx_today, c_cf.max(axis=(0, 1)))
    lean_idx = [combos.index(c) for c in LEAN9]
    mx_lean = np.maximum(mx_today, c_cf[lean_idx].max(axis=(0, 1)))
    g = mx_all - mx_today
    print(f"  gain with all 21: median {np.median(g)*100:.2f} pts, p90 {np.percentile(g, 90)*100:.2f}, "
          f"max {g.max()*100:.2f}; regions gaining > 1 pt {(g > 0.01).sum()}; lean 9 gain median "
          f"{np.median(mx_lean - mx_today)*100:.2f} pts, > 1 pt {((mx_lean - mx_today) > 0.01).sum()}")
    for th in (0.99, 0.995, 0.999):
        print(f"  regions reaching {th}: today {(mx_today >= th).sum()}, lean 9 {(mx_lean >= th).sum()}, all 21 {(mx_all >= th).sum()}")
    print(f"\ndone in {time.time()-t0:.0f} s")


if __name__ == "__main__":
    main()
