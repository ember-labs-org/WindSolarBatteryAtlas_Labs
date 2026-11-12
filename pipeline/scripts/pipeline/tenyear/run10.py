"""T060 phase B runner: every configuration on the continuous series.

  python3 -I run10.py --repo <wt> --set dense    --years 2015-2024 --parts work/parts10
  python3 -I run10.py --repo <wt> --set dense    --years 2024      --parts work/parts24   (gate B1)
  python3 -I run10.py --repo <wt> --set wind_mix --years ...
  python3 -I run10.py --repo <wt> --set large    --years ... [--cyclic]  (cyclic only for the 2024 check)

Per configuration it saves <parts>/<set>/<key>.npz with location_id, cf (float32,
whole run), curt (float32), ycf (float32 [n, years]); a configuration whose part
exists is skipped (resumable).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sim10 as S  # noqa: E402

LEAN9 = [(1, 1), (1, 2), (1, 3), (2, 1), (2, 2), (2, 3), (3, 1), (3, 2), (4, 1)]
MIX_SOLAR = list(range(0, 11))
MIX_BATT = list(range(0, 38, 2))
R_SOLAR = [20, 22, 25, 30, 35, 40, 50, 60, 70, 85, 100, 120, 150, 200]
R_BATT = [36, 42, 48, 60, 72, 84, 96, 120, 144, 192, 240, 288, 384, 480, 576, 768, 960,
          1152, 1536, 1920, 2304, 3072, 3840, 4608]


def large_configs():
    out = [(s, b) for s in R_SOLAR for b in R_BATT if not (s <= 20 and b <= 36)]
    return [{"j": j, "solar": s, "batt": b} for j, (s, b) in enumerate(out)]


def save(path, ids, cf, curt, ycf, extra=None):
    tmp = path.with_suffix(".tmp.npz")
    # cf and curt kept in float64: the add-on writer rounds the float64 value
    # (build_addon.r4), run3d rounds float32(cf); assemble.py does each.
    np.savez(tmp, location_id=ids.astype("int32"), cf=cf.astype("float64"), curt=curt.astype("float64"),
             ycf=ycf.astype("float32"), **(extra or {}))
    tmp.rename(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--set", required=True, choices=("dense", "wind_mix", "large"))
    ap.add_argument("--years", default="2015-2024")
    ap.add_argument("--parts", type=Path, required=True)
    ap.add_argument("--configs", default="")
    ap.add_argument("--data", type=Path, help="deployment data folder (regions, resource csv)")
    ap.add_argument("--w0", type=Path, help="summary_w0.parquet that selects the large-set regions")
    ap.add_argument("--cyclic", action="store_true")
    a = ap.parse_args()
    y0, _, y1 = a.years.partition("-")
    years = list(range(int(y0), int(y1 or y0) + 1))
    ystarts = S.year_starts(years)
    out = a.parts / a.set
    out.mkdir(parents=True, exist_ok=True)
    ids = S.solar_ids()
    t0 = time.time()
    log = lambda m: print(f"[{time.time()-t0:7.0f} s] {m}", flush=True)  # noqa: E731

    if a.set == "dense":
        sys.path.insert(0, str(a.repo / "pipeline"))
        from scripts.pipeline.config import build_config_list
        cfgs = build_config_list()
        if a.configs:
            lo, _, hi = a.configs.partition(":")
            cfgs = cfgs[int(lo or 0):int(hi or len(cfgs))]
        solar = S.load_solar(years)
        log(f"solar {solar.shape} mean {solar.mean():.4f}")
        for surface in ("on", "off"):
            todo = [c for c in cfgs if c[1] == surface and not (out / f"{c[0]}.npz").exists()]
            if not todo:
                continue
            wind = S.load_wind(surface, years)
            log(f"wind {surface} {wind.shape} mean {wind.mean():.4f}; {len(todo)} configs")
            for n, (idx, sf, s, w, b) in enumerate(todo):
                cf, curt, ycf, _ = S.run(solar, wind, s, w, b, ystarts)
                save(out / f"{idx}.npz", ids, cf, curt, ycf)
                if n % 50 == 0 or n == len(todo) - 1:
                    log(f"{surface} {n+1}/{len(todo)} cfg {idx} s{s} w{w} b{b} mean cf {cf.mean():.4f}")
            del wind

    elif a.set == "wind_mix":
        res = pd.read_csv(a.data / "voronoi_wind_resource.csv")
        dep = np.unique(pd.read_parquet(a.data / "summary_w0.parquet", columns=["location_id"]).location_id)
        res = res[res.location_id.isin(dep)]
        sel = np.sort(res.loc[(res.on_area_km2 > 0) & (res.off_area_km2 > 0), "location_id"].values.astype(int))
        rows = np.searchsorted(ids, sel)
        assert np.array_equal(ids[rows], sel)
        sol = S.load_solar(years, rows)
        on = S.load_wind("on", years, sel)
        off = S.load_wind("off", years, sel)
        log(f"wind_mix regions {len(sel)}")
        j = 0
        for wa, wb in LEAN9:
            p = out / f"on{wa}_off{wb}.npz"
            if p.exists():
                j += len(MIX_SOLAR) * len(MIX_BATT); continue
            wind = (on * np.float32(wa) + off * np.float32(wb)).astype("float32")
            cfs, curts, ycfs, js = [], [], [], []
            for s in MIX_SOLAR:
                for b in MIX_BATT:
                    cf, curt, ycf, _ = S.run(sol, wind, s, 1.0, b, ystarts)
                    cfs.append(cf); curts.append(curt); ycfs.append(ycf); js.append(j); j += 1
            save(p, sel, np.stack(cfs), np.stack(curts), np.stack(ycfs), {"cfg": np.array(js)})
            log(f"on {wa} + off {wb} done")

    else:  # large
        w0 = pd.read_parquet(a.w0, columns=["location_id", "annual_cf"])
        mx = w0.groupby("location_id").annual_cf.max()
        sel = np.sort(mx[mx < 0.999].index.values.astype(int))
        rows = np.searchsorted(ids, sel)
        assert np.array_equal(ids[rows], sel)
        sol = S.load_solar(years, rows)
        zero = np.zeros_like(sol)
        cfgs = large_configs()
        log(f"large regions {len(sel)}, {len(cfgs)} configs, cyclic {a.cyclic}")
        (out / "regions.json").write_text(json.dumps({"n": len(sel), "w0": str(a.w0)}))
        for c in cfgs:
            p = out / f"{c['j']}.npz"
            if p.exists():
                continue
            soc = np.zeros(len(sel)); passes = 1
            cf, curt, ycf, end = S.run(sol, zero, c["solar"], 0.0, c["batt"], ystarts, soc)
            if a.cyclic:
                for passes in range(2, 52):
                    if np.all(np.abs(end - soc) <= 1e-6):
                        break
                    soc = end
                    cf, curt, ycf, end = S.run(sol, zero, c["solar"], 0.0, c["batt"], ystarts, soc)
                else:
                    raise SystemExit("cyclic year did not converge")
            save(p, sel, cf, curt, ycf, {"end_soc": end, "passes": passes})
            if c["j"] % 24 == 23:
                log(f"large {c['j']+1}/{len(cfgs)}")
    log("done")


if __name__ == "__main__":
    main()
