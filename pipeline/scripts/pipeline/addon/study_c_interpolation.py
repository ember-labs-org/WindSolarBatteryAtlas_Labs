"""T058 study (c): interpolation along the battery axis for the large builds.

For a sample of regions that cannot reach 99% today (seeded; Tromsø always in),
every proposed solar level and a set of targets:
  1. simulate the proposed battery axis (cold start, as the pipeline), rounded to
     4 decimals as the app holds it;
  2. where the target falls between two simulated batteries, interpolate the
     battery that reaches it, linearly in battery and linearly in log(battery);
  3. find the true minimum battery by bisection on the simulation itself;
  4. check the interpolated battery is never below the true one (errs high) and
     report the cost error LCOE(interpolated) / LCOE(true) - 1 (both priced at the
     target CF, as the app would price an interpolated build);
  5. simulate quarter points and midpoints of every bracket and compare the true
     CF with each interpolation (errs high <=> true CF >= interpolated CF).

  ATLAS_WORKSPACE_DIR=<workspace> T058_OUT=<scratch>/T058 python3 -I study_c_interpolation.py \
      [--batt 48,72,...] [--solar 25,30,...] [--n 40]
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np

from common import Cost, excluded_ids, load_solar, simulate_rows, summary

P_SOLAR = [25, 30, 40, 50, 70, 100]
P_BATT = [48, 72, 96, 144, 192, 288, 384, 576, 768, 1152, 1536, 2304, 3072, 4608]
TARGETS = [0.80, 0.85, 0.90, 0.95, 0.97, 0.99]
TROMSO = 3459


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--solar", default=",".join(map(str, P_SOLAR)))
    ap.add_argument("--batt", default=",".join(map(str, P_BATT)))
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=58)
    ap.add_argument("--warm", action="store_true", help="cyclic year instead of the cold start")
    args = ap.parse_args()
    solars = [int(x) for x in args.solar.split(",")]
    batts = np.array([float(x) for x in args.batt.split(",")])
    t0 = time.time()

    excl = excluded_ids()
    w0 = summary("summary_w0.parquet")
    w0 = w0[~w0.location_id.isin(excl)]
    mx = w0.groupby("location_id").annual_cf.max()
    pool = np.sort(mx[mx < 0.99].index.values)
    rng = np.random.default_rng(args.seed)
    sample = np.sort(np.unique(np.r_[rng.choice(pool, args.n, replace=False), [TROMSO]]))
    lat = w0.drop_duplicates("location_id").set_index("location_id").loc[sample, "latitude"].values
    print(f"start: {'cyclic (warm)' if args.warm else 'cold, as the pipeline'}")
    print(f"sample: {len(sample)} regions of {len(pool)} (< 0.99 today); |lat| "
          f"min {np.abs(lat).min():.1f} median {np.median(np.abs(lat)):.1f} max {np.abs(lat).max():.1f}")

    ids, solar_all = load_solar()
    sol = np.ascontiguousarray(solar_all[np.searchsorted(ids, sample)])
    zero = np.zeros_like(sol)
    n = len(sample)
    cost = Cost()

    # 1. grid
    loc, s_arr, b_arr = [], [], []
    for si, s in enumerate(solars):
        for bi, b in enumerate(batts):
            loc += list(range(n)); s_arr += [s] * n; b_arr += [b] * n
    raw = simulate_rows(sol, zero, loc, s_arr, [0] * len(loc), b_arr, cyclic=args.warm)
    grid = np.round(raw, 4).astype("float32").astype(float).reshape(len(solars), len(batts), n)
    raw = raw.reshape(len(solars), len(batts), n)
    mono = np.all(np.diff(raw, axis=1) >= -1e-12)
    print(f"CF non-decreasing in battery on the grid: {mono}")

    # 2-3. brackets for each target
    cases = []   # (k, si, j, T)
    for si in range(len(solars)):
        for k in range(n):
            for T in TARGETS:
                c = grid[si, :, k]
                j = int(np.searchsorted(c >= T, True))   # first index reaching T
                if 0 < j < len(batts) and c[j - 1] < T:
                    cases.append((k, si, j, T))
    print(f"cases with the target between two simulated batteries: {len(cases)}")
    if not cases:
        return
    K = np.array([c[0] for c in cases]); SI = np.array([c[1] for c in cases])
    J = np.array([c[2] for c in cases]); TT = np.array([c[3] for c in cases])
    S = np.array(solars)[SI]
    blo, bhi = batts[J - 1], batts[J]
    clo, chi = grid[SI, J - 1, K], grid[SI, J, K]
    frac = (TT - clo) / (chi - clo)
    b_lin = blo + frac * (bhi - blo)
    b_log = np.exp(np.log(blo) + frac * (np.log(bhi) - np.log(blo)))

    # Guard for the 4-dp rounding of the stored CFs: interpolate to the target plus
    # half a rounding step (never past the upper point), so rounding cannot pull
    # the interpolated battery below the true one.
    Tg = np.minimum(TT + 0.00005, chi)
    fg = (Tg - clo) / (chi - clo)
    b_lin_g = blo + fg * (bhi - blo)

    lo, hi = blo.copy(), bhi.copy()
    for _ in range(30):
        mid = 0.5 * (lo + hi)
        cf = simulate_rows(sol, zero, K, S, np.zeros(len(K)), mid, cyclic=args.warm)
        ok = cf >= TT
        hi = np.where(ok, mid, hi)
        lo = np.where(ok, lo, mid)
    b_true = hi

    def report(name, b):
        under = b < b_true * (1 - 1e-9)
        lt = cost.lcoe(TT, S.astype(float), b)
        lt_true = cost.lcoe(TT, S.astype(float), b_true)
        err = lt / lt_true - 1
        berr = b / b_true - 1
        print(f"  {name}: battery below the true minimum in {int(under.sum())} of {len(b)} cases "
              f"(worst {berr.min()*100:.2f}%); battery over: median {np.median(berr)*100:.1f}% "
              f"p90 {np.percentile(berr, 90)*100:.1f}% max {berr.max()*100:.1f}%")
        print(f"      cost error: median {np.median(err)*100:.2f}% p90 {np.percentile(err, 90)*100:.2f}% "
              f"p99 {np.percentile(err, 99)*100:.2f}% max {err.max()*100:.2f}% min {err.min()*100:.3f}%")
        return under, err

    print("\n== Interpolated vs true minimum battery (bisection, 30 steps)")
    u_lin, e_lin = report("linear in battery", b_lin)
    u_log, e_log = report("linear in log(battery)", b_log)
    u_lg, e_lg = report("linear in battery, target + 0.00005 (rounding guard)", b_lin_g)
    # the upper bracket point itself (no interpolation)
    report("no interpolation (next simulated battery)", bhi)
    if u_lin.any():
        bad = np.where(u_lin)[0][:10]
        for i in bad:
            print(f"     lin under: loc {sample[K[i]]} s{S[i]} T{TT[i]} [{blo[i]:.0f},{bhi[i]:.0f}] "
                  f"cf [{clo[i]:.4f},{chi[i]:.4f}] lin {b_lin[i]:.2f} true {b_true[i]:.2f}")

    # region-level: best build across solar levels at each target
    print("\n== Region-level least cost over the add-on grid at each target (guarded linear vs true)")
    for T in TARGETS:
        m = TT == T
        if not m.any():
            continue
        errs = []
        for k in np.unique(K[m]):
            mm = m & (K == k)
            l_lin = cost.lcoe(T, S[mm].astype(float), b_lin_g[mm]).min()
            l_true = cost.lcoe(T, S[mm].astype(float), b_true[mm]).min()
            errs.append(l_lin / l_true - 1)
        errs = np.array(errs)
        print(f"  T={T}: {len(errs)} regions; cost error median {np.median(errs)*100:.2f}% "
              f"max {errs.max()*100:.2f}% min {errs.min()*100:.3f}%")

    # 5. quarter points and midpoints of every bracket, every sampled region and solar level
    print("\n== Quarter points and midpoints: true CF vs interpolated CF, all brackets")
    for name, logspace in (("linear in battery", False), ("linear in log(battery)", True)):
        rows_k, rows_s, rows_b, rows_interp = [], [], [], []
        for si, s in enumerate(solars):
            for j in range(1, len(batts)):
                for q in (0.25, 0.5, 0.75):
                    if logspace:
                        b = float(np.exp(np.log(batts[j - 1]) + q * (np.log(batts[j]) - np.log(batts[j - 1]))))
                    else:
                        b = float(batts[j - 1] + q * (batts[j] - batts[j - 1]))
                    rows_k.append(np.arange(n)); rows_s.append(np.full(n, s)); rows_b.append(np.full(n, b))
                    rows_interp.append(grid[si, j - 1] + q * (grid[si, j] - grid[si, j - 1]))
        Kq = np.concatenate(rows_k); Sq = np.concatenate(rows_s); Bq = np.concatenate(rows_b)
        Iq = np.concatenate(rows_interp)
        true = simulate_rows(sol, zero, Kq, Sq, np.zeros(len(Kq)), Bq, cyclic=args.warm)
        d = true - Iq
        flat = (np.abs(d) < 1e-12)
        print(f"  {name}: {len(d)} points; true below interpolated in {int((d < -1e-9).sum())} "
              f"(beyond 4-dp rounding, < -5e-5: {int((d < -5e-5).sum())}); worst {d.min():.5f}; "
              f"median gap {np.median(d):.5f}")
    print(f"\ndone in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
