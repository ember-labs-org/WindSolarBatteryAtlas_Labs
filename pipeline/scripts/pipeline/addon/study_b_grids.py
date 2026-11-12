"""T058 study (b), part 2: which large-build grid to ship.

Reads <T058_OUT>/b_cf.npz (study_b_large_builds.py) and compares candidate
grids against the fine reference grid F, each searched with guarded linear
interpolation along the battery axis (the shipped method, study (c)), at the
pipeline's cold start and at the cyclic warm start. The existing grid
(solar 1-20, battery 0-36, cold start) is always included, as in the app.

Reference ("best") = F with interpolation. Reports per grid: rows, regions
reaching each target, and the cost gap to the reference.

  ATLAS_WORKSPACE_DIR=<ws> T058_OUT=<scratch>/T058 python3 -I study_b_grids.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np

from common import OUT, Cost, summary

TARGETS = [0.80, 0.90, 0.95, 0.99, 0.995, 0.999]
F_SOLAR = [12, 14, 16, 18, 20, 22, 25, 28, 30, 35, 40, 45, 50, 60, 70, 85, 100, 120, 150, 200]
F_BATT = [36, 42, 48, 60, 72, 84, 96, 120, 144, 168, 192, 240, 288, 336, 384, 480, 576, 672,
          768, 960, 1152, 1344, 1536, 1920, 2304, 2688, 3072, 3840, 4608, 6144, 9216]
GRIDS = {
    "P (brief)": ([25, 30, 40, 50, 70, 100],
                  [48, 72, 96, 144, 192, 288, 384, 576, 768, 1152, 1536, 2304, 3072, 4608]),
    "P + b36,42,60 + s20,150,200": ([20, 25, 30, 40, 50, 70, 100, 150, 200],
                  [36, 42, 48, 60, 72, 96, 144, 192, 288, 384, 576, 768, 1152, 1536, 2304, 3072, 4608]),
    "R (recommended)": ([20, 22, 25, 30, 35, 40, 50, 60, 70, 85, 100, 120, 150, 200],
                  [36, 42, 48, 60, 72, 84, 96, 120, 144, 192, 240, 288, 384, 480, 576, 768, 960,
                   1152, 1536, 1920, 2304, 3072, 3840, 4608]),
    "F (reference)": (F_SOLAR, F_BATT),
}
GUARD = 0.00005


def search(cf, solar_levels, batt_levels, s_list, b_list, T, cost):
    """Least LCOE per region over the grid (s_list x b_list, b = 36 only for
    solar > 20 since the existing grid holds solar <= 20 at 36), with guarded
    linear interpolation along battery. cf: (n_solar, n_batt, n)."""
    n = cf.shape[2]
    best = np.full(n, np.inf)
    for s in s_list:
        bl = [b for b in b_list if not (s <= 20 and b <= 36)]
        if not bl:
            continue
        si = solar_levels.index(s)
        c = cf[si, [batt_levels.index(b) for b in bl]].astype(float)      # (nb, n)
        b = np.array(bl, float)
        ok = c >= T
        j = np.argmax(ok, axis=0)
        reach = ok.any(axis=0)
        # simulated points
        l_pts = np.where(ok, cost.lcoe(np.maximum(c, 1e-9), float(s), b[:, None]), np.inf).min(axis=0)
        # interpolated point in the bracket (j-1, j)
        has = reach & (j > 0)
        jj = np.where(has, j, 1)
        clo = c[jj - 1, np.arange(n)]; chi = c[jj, np.arange(n)]
        Tg = np.minimum(T + GUARD, chi)
        with np.errstate(divide="ignore", invalid="ignore"):
            frac = np.clip((Tg - clo) / (chi - clo), 0, 1)
        bstar = b[jj - 1] + frac * (b[jj] - b[jj - 1])
        l_int = np.where(has, cost.lcoe(np.full(n, T), float(s), bstar), np.inf)
        best = np.minimum(best, np.minimum(l_pts, l_int))
    return best


def main():
    d = np.load(OUT / "b_cf.npz")
    ids = d["ids"]; solar_levels = [int(x) for x in d["solar"]]; batt_levels = [int(x) for x in d["batt"]]
    cost = Cost()
    w0 = summary("summary_w0.parquet")
    w0 = w0[w0.location_id.isin(ids)]
    mx = w0.groupby("location_id").annual_cf.max().loc[ids].values
    piv = w0.pivot_table(index="location_id", columns=["solar_gw", "batt_gwh"], values="annual_cf").loc[ids]
    ex_s = np.array([c[0] for c in piv.columns], float); ex_b = np.array([c[1] for c in piv.columns], float)
    ex_cf = piv.values.T.astype(float)
    ex_l = cost.lcoe(ex_cf, ex_s[:, None], ex_b[:, None])

    for start in ("cold", "warm"):
        cf = d[start]
        print(f"\n===== {start} start =====")
        for grp, m in (("< 0.99 today", mx < 0.99), ("0.99-0.999 today", mx >= 0.99)):
            print(f"-- regions {grp}: {m.sum()}")
            ref = {}
            for T in TARGETS:
                today = np.where(ex_cf >= T, ex_l, np.inf).min(axis=0)
                ref[T] = np.minimum(today, search(cf, solar_levels, batt_levels, *GRIDS["F (reference)"], T, cost))
            for name, (sl, bl) in GRIDS.items():
                rows = sum(1 for s in sl for b in bl if not (s <= 20 and b <= 36))
                parts = []
                for T in TARGETS:
                    today = np.where(ex_cf >= T, ex_l, np.inf).min(axis=0)
                    v = np.minimum(today, search(cf, solar_levels, batt_levels, sl, bl, T, cost))
                    r = m & np.isfinite(ref[T])
                    reach = int((m & np.isfinite(v)).sum())
                    g = v[r] / ref[T][r] - 1
                    g = g[np.isfinite(g)]
                    parts.append(f"{T}: {reach} reach, gap med {np.median(g)*100:.1f}% p90 {np.percentile(g, 90)*100:.1f}%"
                                 if len(g) else f"{T}: {reach} reach")
                print(f"  {name} [{rows} configs/region]\n      " + "\n      ".join(parts))
            if start == "warm" and grp.startswith("<"):
                T = 0.99
                today = np.where(ex_cf >= T, ex_l, np.inf).min(axis=0)
                v = np.minimum(today, search(cf, solar_levels, batt_levels, *GRIDS["R (recommended)"], T, cost))
                print(f"  R, warm, 99%: LCOE $/MWh p10 {np.percentile(v[m], 10):,.0f} median {np.median(v[m]):,.0f} "
                      f"p90 {np.percentile(v[m], 90):,.0f}")


if __name__ == "__main__":
    main()
