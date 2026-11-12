"""T058: verify the add-on files against addon.json, the data and a fresh simulation.

Checks (exit 1 on any failure):
  1. each set's SHA-256 equals addon.json; schema (int32, uint16, float32, float32);
     rows sorted by cfg then location; every region has exactly one row per config;
     row and region counts as in addon.json; configs as T058-interface.md §1
  2. region rules: wind_mix = deployed regions with on_area_km2 > 0 and
     off_area_km2 > 0; large = deployed regions with max summary_w0 CF < 0.999
  3. large: CF non-decreasing in battery within every solar level
  4. --sample N random rows per set (seeded) re-simulated with a different kernel
     (common._simulate_rows: per-row builds; cold start for wind_mix, the
     repeating year to convergence for large) for the CF, and common.simulate_soc
     for the curtailed share: equal at 4 dp (a half-way tie, |raw - stored| <= 5.1e-5,
     is reported and accepted)

  ATLAS_WORKSPACE_DIR=<ws> T058_OUT=<scratch> python3 -I verify_addon.py --dir <addon dir> \
      --data <repo>/deployment/data --wind-profiles <run>/ws/input_data [--sample 300]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

import common as C
from build_addon import mix_configs, large_configs, R_SOLAR, LARGE_BELOW

FAIL = []


def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg)
    if not ok:
        FAIL.append(msg)


def sha256(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--wind-profiles", type=Path, required=True)
    ap.add_argument("--sample", type=int, default=300)
    ap.add_argument("--seed", type=int, default=58)
    args = ap.parse_args()
    man = json.loads((args.dir / "addon.json").read_text())
    sets = {s["id"]: s for s in man["sets"]}
    check(list(sets) == ["wind_mix", "large"], f"addon.json sets {list(sets)}")
    check(man["version"] == 1 and man["baseload_mw"] == 1000 and man["hours"] == 8784, "addon.json header")
    check(sets["wind_mix"]["configs"] == mix_configs(), "wind_mix configs = lean 9 x solar 0-10 x battery 0-36/2, in order")
    check(sets["large"]["configs"] == large_configs(), "large configs = grid R, in order")

    w0 = pd.read_parquet(args.data / "summary_w0.parquet", columns=["location_id", "annual_cf"])
    deployed = np.unique(w0.location_id.values)
    res = pd.read_csv(args.data / "voronoi_wind_resource.csv")
    res = res[res.location_id.isin(deployed)]
    want = {"wind_mix": np.sort(res.loc[(res.on_area_km2 > 0) & (res.off_area_km2 > 0), "location_id"].values),
            "large": np.sort((lambda m: m[m < LARGE_BELOW].index.values)(w0.groupby("location_id").annual_cf.max()))}
    tables = {}
    for sid, s in sets.items():
        p = args.dir / s["file"]
        check(sha256(p) == s["sha256"], f"{sid}: SHA-256 {s['sha256'][:16]} matches addon.json")
        t = pq.read_table(p)
        types = [str(f.type) for f in t.schema]
        check([f.name for f in t.schema] == ["location_id", "cfg", "annual_cf", "curtailed_share"]
              and types == ["int32", "uint16", "float", "float"], f"{sid}: schema {types}")
        d = t.to_pandas()
        n_cfg = len(s["configs"])
        regs = np.unique(d.location_id.values)
        check(len(d) == s["rows"] == len(regs) * n_cfg and len(regs) == s["regions"],
              f"{sid}: {len(d)} rows = {len(regs)} regions x {n_cfg} configs (addon.json: {s['rows']}, {s['regions']})")
        key = d.cfg.values.astype(np.int64) * 10_000_000 + d.location_id.values
        check(bool(np.all(np.diff(key) > 0)), f"{sid}: sorted by cfg then location, no duplicates")
        check(np.array_equal(regs, want[sid]), f"{sid}: regions follow the rule ({s['rule']})")
        check(bool(d.annual_cf.between(0, 1).all() and d.curtailed_share.between(0, 1).all()), f"{sid}: values in [0, 1]")
        v = d[["annual_cf", "curtailed_share"]].values.astype(np.float32)
        check(bool(np.all(np.round(v.astype(float), 4).astype(np.float32) == v)), f"{sid}: values stored at 4 dp")
        tables[sid] = d

    # 3. monotone in battery
    L = tables["large"]
    grid = L.annual_cf.values.reshape(len(sets["large"]["configs"]), -1)
    bad = 0
    for s in R_SOLAR:
        js = [c["j"] for c in sets["large"]["configs"] if c["solar"] == s]
        bad += int((np.diff(grid[js], axis=0) < 0).sum())
    check(bad == 0, f"large: CF non-decreasing in battery within each solar level ({bad} decreases)")

    # 4. re-simulate a sample
    ids, solar_all = C.load_solar()
    rng = np.random.default_rng(args.seed)
    for sid in ("wind_mix", "large"):
        d = tables[sid]; cfgs = sets[sid]["configs"]
        pick = np.sort(rng.choice(len(d), args.sample, replace=False))
        rows = d.iloc[pick]
        locs = rows.location_id.values.astype(int)
        sol = np.ascontiguousarray(solar_all[np.searchsorted(ids, locs)])
        if sid == "wind_mix":
            _, on = C.load_wind(args.wind_profiles / "wind_profiles_on.parquet", ids, np.unique(locs))
            _, off = C.load_wind(args.wind_profiles / "wind_profiles_off.parquet", ids, np.unique(locs))
            u = np.unique(locs); k = np.searchsorted(u, locs)
            a = np.array([cfgs[j]["on"] for j in rows.cfg]); b = np.array([cfgs[j]["off"] for j in rows.cfg])
            wind = np.stack([on[k[i]] * np.float32(a[i]) + off[k[i]] * np.float32(b[i]) for i in range(len(rows))]).astype("float32")
            w = np.ones(len(rows)); cyc = False
        else:
            wind = np.zeros_like(sol); w = np.zeros(len(rows)); cyc = True
        s_arr = np.array([cfgs[j]["solar"] for j in rows.cfg], float)
        b_arr = np.array([cfgs[j]["batt"] for j in rows.cfg], float)
        cf = C.simulate_rows(sol, wind, np.arange(len(rows)), s_arr, w, b_arr, cyclic=cyc)
        curt = np.array([C.simulate_soc(sol[i:i + 1], wind[i:i + 1], s_arr[i], w[i], b_arr[i], cyclic=cyc)[1][0]
                         for i in range(len(rows))])
        st_cf = rows.annual_cf.values.astype(float); st_cu = rows.curtailed_share.values.astype(float)
        eq_cf = np.round(cf, 4).astype("float32").astype(float) == st_cf
        eq_cu = np.round(curt, 4).astype("float32").astype(float) == st_cu
        tie_cf = ~eq_cf & (np.abs(cf - st_cf) <= 5.1e-5)
        tie_cu = ~eq_cu & (np.abs(curt - st_cu) <= 5.1e-5)
        check(bool(np.all(eq_cf | tie_cf)), f"{sid}: {len(rows)} sampled rows re-simulated ({'repeating year' if cyc else 'cold start'}): "
              f"CF equal at 4 dp in {int(eq_cf.sum())}, half-way ties {int(tie_cf.sum())}, max |d| {np.abs(cf - st_cf).max():.1e}")
        check(bool(np.all(eq_cu | tie_cu)), f"{sid}: curtailed share equal at 4 dp in {int(eq_cu.sum())}, half-way ties {int(tie_cu.sum())}")
        print(f"     sampled {len(np.unique(locs))} regions, {len(np.unique(rows.cfg))} configs")
    print("ALL PASS" if not FAIL else f"{len(FAIL)} FAILED")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
