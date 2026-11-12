"""T058 study (b): large solar + battery builds for regions that cannot reach 99%.

Simulates, for every region (excl. ATA/GRL) whose best solar+battery build today
(summary_w0, solar <= 20, battery <= 36) stays below a CF of 0.999:
  * the proposed grid  P: solar {25,30,40,50,70,100} x battery {48 .. 4608} (14, geometric)
  * a fine reference grid F (solar 12-200, battery 36-9216) to judge P's gaps
  * solar 1-20 at the large batteries (do small-solar/big-battery builds win?)
  * the pipeline's cold start (battery empty on 1 January) and a cyclic warm
    start (the year repeats; starting charge = end-of-year charge)
and prices every build with the app's default LCOE (common.Cost).

Writes <T058_OUT>/b_cf.npz (all simulated CFs) and prints the tables used in
team/contracts/T058.md.

  ATLAS_WORKSPACE_DIR=<workspace> T058_OUT=<scratch>/T058 python3 -I study_b_large_builds.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pandas as pd

from common import OUT, Cost, excluded_ids, load_solar, simulate, simulate_soc, summary, DATA

P_SOLAR = [25, 30, 40, 50, 70, 100]
P_BATT = [48, 72, 96, 144, 192, 288, 384, 576, 768, 1152, 1536, 2304, 3072, 4608]
F_SOLAR = [12, 14, 16, 18, 20, 22, 25, 28, 30, 35, 40, 45, 50, 60, 70, 85, 100, 120, 150, 200]
F_BATT = [36, 42, 48, 60, 72, 84, 96, 120, 144, 168, 192, 240, 288, 336, 384, 480, 576, 672,
          768, 960, 1152, 1344, 1536, 1920, 2304, 2688, 3072, 3840, 4608, 6144, 9216]
TARGETS = [0.80, 0.90, 0.95, 0.99, 0.995, 0.999]
TROMSO = 3459


def r4(x):
    return np.round(x, 4).astype("float32")


def population(ids):
    pop = pd.read_csv(DATA / "voronoi_population_2020.csv")
    w0 = summary("summary_w0.parquet")
    pts = w0.drop_duplicates("location_id").set_index("location_id")[["latitude", "longitude"]]
    key = lambda la, lo: (np.round(la.astype(float), 2).astype(str) + "," + np.round(lo.astype(float), 2).astype(str))
    pmap = dict(zip(key(pop.latitude.values, pop.longitude.values), pop.population_2020.values))
    k = key(pts.loc[ids, "latitude"].values, pts.loc[ids, "longitude"].values)
    return np.array([pmap.get(x, 0.0) for x in k])


def main():
    t0 = time.time()
    excl = excluded_ids()
    w0 = summary("summary_w0.parquet")
    w0 = w0[~w0.location_id.isin(excl)]
    mx = w0.groupby("location_id").annual_cf.max()
    sel = np.sort(mx[mx < 0.999].index.values)
    print(f"regions excl. ATA/GRL: {len(mx)}; best today < 0.99: {(mx < 0.99).sum()}, "
          f"< 0.995: {(mx < 0.995).sum()}, < 0.999: {len(sel)}; max over all regions {mx.max():.4f}")

    ids, solar_all = load_solar()
    pos = np.searchsorted(ids, sel)
    assert np.array_equal(ids[pos], sel)
    sol = np.ascontiguousarray(solar_all[pos])
    zero = np.zeros_like(sol)
    n = len(sel)

    # --- harness check: the kernel reproduces summary_w0 exactly -------------
    chk = w0.set_index(["location_id", "solar_gw", "batt_gwh"]).annual_cf
    for s, b in [(1, 0), (5, 8), (10, 36), (20, 36), (14, 22)]:
        cf, _ = simulate(sol, zero, s, 0, b)
        ref = chk.loc[list(zip(sel, [s] * n, [b] * n))].values
        # Equal after rounding, except at exact half-way ties (x.xxxx5): the shipped
        # w0 slice keeps the original atlas's rounding there (simulation3d notes it).
        diff = r4(cf) != ref.astype("float32")
        ties = np.abs(cf - ref) <= 5.1e-5   # float32 ref: 5e-5 plus float32 spacing
        same = bool(np.all(~diff | ties))
        cf2, _, _ = simulate_soc(sol, zero, s, 0, b)
        print(f"  check s{s} b{b}: equals summary_w0 {same} ({int(diff.sum())} half-way ties of {n}); "
              f"soc-kernel equals pipeline kernel {np.array_equal(cf, cf2)}")
        if not same or not np.array_equal(cf, cf2):
            raise SystemExit("harness does not reproduce the shipped data")

    # --- simulate --------------------------------------------------------------
    solar_levels = sorted(set(range(1, 21)) | set(F_SOLAR) | set(P_SOLAR))
    batt_levels = sorted(set(F_BATT) | set(P_BATT))
    cold = np.full((len(solar_levels), len(batt_levels), n), np.nan, dtype="float32")
    warm = np.full_like(cold, np.nan)
    for i, s in enumerate(solar_levels):
        for j, b in enumerate(batt_levels):
            cf, _, _ = simulate_soc(sol, zero, s, 0, b)
            cold[i, j] = r4(cf)
            cfw, _, _ = simulate_soc(sol, zero, s, 0, b, cyclic=True)
            warm[i, j] = r4(cfw)
        print(f"  solar {s}: done ({time.time() - t0:.0f} s)", flush=True)
    np.savez_compressed(OUT / "b_cf.npz", ids=sel, solar=solar_levels, batt=batt_levels, cold=cold, warm=warm)

    # existing grid (cold start, as shipped)
    ex = w0[w0.location_id.isin(sel)]
    ex_cf = ex.pivot_table(index="location_id", columns=["solar_gw", "batt_gwh"], values="annual_cf").loc[sel]
    ex_s = np.array([c[0] for c in ex_cf.columns]); ex_b = np.array([c[1] for c in ex_cf.columns])
    ex_cf = ex_cf.values.T.astype("float32")          # (n_ex, n)

    cost = Cost()

    def lcoe_grid(cfs, s_arr, b_arr):
        return cost.lcoe(cfs.astype(float), s_arr[:, None].astype(float), b_arr[:, None].astype(float))

    ex_l = lcoe_grid(ex_cf, ex_s, ex_b)

    def flat(arr, s_list, b_list):
        si = np.array([solar_levels.index(s) for s in s_list for _ in b_list])
        bj = np.array([batt_levels.index(b) for _ in s_list for b in b_list])
        s_arr = np.array([s for s in s_list for _ in b_list]); b_arr = np.array([b for _ in s_list for b in b_list])
        c = arr[si, bj]
        return c, lcoe_grid(c, s_arr, b_arr), s_arr, b_arr

    def best(cfs, ls, s_arr, b_arr, T):
        ok = cfs >= T
        l = np.where(ok, ls, np.inf)
        k = np.argmin(l, axis=0)
        v = l[k, np.arange(n)]
        return v, s_arr[k], b_arr[k]

    pop = population(sel)
    lt99 = mx.loc[sel].values < 0.99
    sets = {
        "today": (ex_cf, ex_l, ex_s, ex_b),
    }
    for name, arr in (("cold", cold), ("warm", warm)):
        pc, pl, ps, pb = flat(arr, P_SOLAR, P_BATT)
        fc, fl, fs, fb = flat(arr, F_SOLAR, F_BATT)
        s20c, s20l, s20s, s20b = flat(arr, list(range(1, 21)), [b for b in F_BATT if b > 36])
        sets[f"P_{name}"] = (np.vstack([ex_cf, pc]), np.vstack([ex_l, pl]), np.r_[ex_s, ps], np.r_[ex_b, pb])
        sets[f"F_{name}"] = (np.vstack([ex_cf, fc, s20c]), np.vstack([ex_l, fl, s20l]),
                             np.r_[ex_s, fs, s20s], np.r_[ex_b, fb, s20b])
    # warm start applies to the whole build list; the existing grid's points are
    # cold-start values, so for warm sets compare like with like on P/F points only.

    print("\n== Regions (best today < 0.99: %d, %.0f m people) reaching each target" % (lt99.sum(), pop[lt99].sum() / 1e6))
    print("set       " + "  ".join(f"{t:>8}" for t in TARGETS))
    for name, (c, l, s, b) in sets.items():
        row = []
        for T in TARGETS:
            v, _, _ = best(c, l, s, b, T)
            row.append(f"{int(np.isfinite(v[lt99]).sum()):>8}")
        print(f"{name:<10}" + "  ".join(row))

    print("\n== Cost of the proposed grid P vs fine grid F (regions < 0.99 where F reaches target): "
          "LCOE_P / LCOE_F - 1")
    for name in ("cold", "warm"):
        for T in TARGETS[:4]:
            vP, sP, bP = best(*sets[f"P_{name}"], T)
            vF, sF, bF = best(*sets[f"F_{name}"], T)
            m = lt99 & np.isfinite(vF)
            gap = vP[m] / vF[m] - 1
            missP = (~np.isfinite(vP[m])).sum()
            g = gap[np.isfinite(gap)]
            print(f"  {name} T={T}: F reaches {m.sum()}, P misses {missP}; gap median {np.median(g)*100:.1f}% "
                  f"p90 {np.percentile(g, 90)*100:.1f}% max {g.max()*100:.1f}%" if len(g) else f"  {name} T={T}: none")
            # which F builds win
            fs_win = pd.Series(sF[m]).value_counts().sort_index()
            fb_win = pd.Series(bF[m]).value_counts().sort_index()
            print(f"     F winners solar: {dict(fs_win)}")
            print(f"     F winners battery: {dict(fb_win)}")

    print("\n== Regions in [0.99, 0.999) today: does P lower their cost at 0.99 / 0.995?")
    mid = ~lt99
    for T in (0.99, 0.995, 0.999):
        v0, _, _ = best(*sets["today"], T)
        vP, sP, bP = best(*sets["P_cold"], T)
        m = mid & np.isfinite(vP)
        better = m & (vP < v0 - 1e-9)
        print(f"  T={T}: {mid.sum()} regions; reach today {int(np.isfinite(v0[mid]).sum())}, with P {int(m.sum())}; "
              f"P cheaper in {int(better.sum())}")
        if better.any():
            red = (1 - vP[better] / np.where(np.isfinite(v0[better]), v0[better], np.nan))
            red = red[np.isfinite(red)]
            if len(red):
                print(f"     where both reach: saving median {np.median(red)*100:.1f}% max {red.max()*100:.1f}%")

    print("\n== Regions < 0.99 that still cannot reach 0.99 with P (cold / warm)")
    for name in ("cold", "warm"):
        c, l, s, b = sets[f"P_{name}"]
        maxcf = c.max(axis=0)
        bad = lt99 & (maxcf < 0.99)
        lat = w0.drop_duplicates("location_id").set_index("location_id").loc[sel, "latitude"].values
        print(f"  {name}: {bad.sum()} regions ({pop[bad].sum()/1e6:.1f} m people); |lat| min {np.abs(lat[bad]).min() if bad.any() else 0:.1f}; "
              f"max CF among them: median {np.median(maxcf[bad]) if bad.any() else 0:.3f}")
        print(f"     best CF reachable over P, regions < 0.99: p10 {np.percentile(maxcf[lt99], 10):.3f} "
              f"median {np.median(maxcf[lt99]):.4f}")

    print("\n== Tromsø (location 3459)")
    k = int(np.where(sel == TROMSO)[0][0])
    print(f"  today best {mx.loc[TROMSO]:.4f}")
    for name, arr in (("cold", cold), ("warm", warm)):
        print(f"  {name}: CF by solar (rows) x battery (cols)")
        print("        " + " ".join(f"{b:>6}" for b in P_BATT))
        for s in P_SOLAR:
            i = solar_levels.index(s)
            print(f"   s{s:<4}" + " ".join(f"{arr[i, batt_levels.index(b), k]:>6.3f}" for b in P_BATT))
        for T in TARGETS:
            for setname in (f"P_{name}", f"F_{name}"):
                v, s_, b_ = best(*sets[setname], T)
                print(f"   {setname} T={T}: " + (f"solar {s_[k]} battery {b_[k]} LCOE ${v[k]:,.0f}/MWh" if np.isfinite(v[k]) else "not reached"))

    # shortfall timing for Tromsø, cold start, best P build
    print(f"\ndone in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
