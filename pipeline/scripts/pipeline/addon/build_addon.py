"""T058: build the sparse add-on (team/contracts/T058.md, T058-interface.md).

Writes into --out (never into OneDrive):
  addon_wind_mix.parquet  lean-9 onshore + offshore combinations x solar 0-10 x
                          battery 0-36 step 2, cold start (as every slider build),
                          for regions with on_area_km2 > 0 and off_area_km2 > 0
  addon_large.parquet     grid R solar x battery, repeating year (cyclic, to
                          convergence), for regions whose best summary_w0 CF < 0.999
  addon.json              the add-on manifest (schema in T058-interface.md)
  build_addon.log.json    input SHA-256s, counts, timings

Regions are the deployed ones (the location_ids of --data/summary_w0.parquet,
i.e. after apply_exclusion), checked against excluded_regions.json.

Dispatch: wind_mix uses the pipeline kernel simulation3d.simulate_config with the
summed wind series (onshore*on + offshore*off in float32, passed as 1 GW of
wind; with off = 0 this reproduces the single-surface slices bit for bit);
large uses common._simulate_soc (the same expressions with a starting charge),
iterated until the end-of-year charge equals the starting one (|d| <= 1e-6 GWh),
failing if any region has not converged in 50 passes.

  ATLAS_WORKSPACE_DIR=<workspace> T058_OUT=<scratch> python3 -I build_addon.py \
      --data <repo>/deployment/data --wind-profiles <run>/ws/input_data --out <dir>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

import common as C

LEAN9 = [(1, 1), (1, 2), (1, 3), (2, 1), (2, 2), (2, 3), (3, 1), (3, 2), (4, 1)]
MIX_SOLAR = list(range(0, 11))
MIX_BATT = list(range(0, 38, 2))
R_SOLAR = [20, 22, 25, 30, 35, 40, 50, 60, 70, 85, 100, 120, 150, 200]
R_BATT = [36, 42, 48, 60, 72, 84, 96, 120, 144, 192, 240, 288, 384, 480, 576, 768, 960,
          1152, 1536, 1920, 2304, 3072, 3840, 4608]
LARGE_BELOW = 0.999
GUARD = 0.00005
EXCLUDED = C.REPO / "pipeline/scripts/exclude_regions/excluded_regions.json"


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def mix_configs():
    return [{"j": j, "solar": s, "batt": b, "on": on, "off": off}
            for j, (on, off, s, b) in enumerate((on, off, s, b) for on, off in LEAN9 for s in MIX_SOLAR for b in MIX_BATT)]


def large_configs():
    out = [(s, b) for s in R_SOLAR for b in R_BATT if not (s <= 20 and b <= 36)]
    return [{"j": j, "solar": s, "batt": b} for j, (s, b) in enumerate(out)]


def write(path: Path, loc: np.ndarray, cfg: np.ndarray, cf: np.ndarray, curt: np.ndarray):
    order = np.lexsort((loc, cfg))
    t = pa.table({
        "location_id": pa.array(loc[order].astype("int32"), type=pa.int32()),
        "cfg": pa.array(cfg[order].astype("uint16"), type=pa.uint16()),
        "annual_cf": pa.array(cf[order].astype("float32"), type=pa.float32()),
        "curtailed_share": pa.array(curt[order].astype("float32"), type=pa.float32()),
    })
    pq.write_table(t, path, compression="zstd", compression_level=9)
    return t.num_rows


def r4(x):
    return np.round(x, 4).astype("float32")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--wind-profiles", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--sets", default="wind_mix,large")
    args = ap.parse_args()
    cloud = (Path.home() / "Library" / "CloudStorage").resolve()
    if args.out.resolve().is_relative_to(cloud):
        raise SystemExit("--out must not be under OneDrive")
    args.out.mkdir(parents=True, exist_ok=True)
    C.DATA = args.data
    sets = args.sets.split(",")
    t0 = time.time()
    log = {"inputs": {}, "sets": {}}

    # deployed regions, checked against the exclusion list
    w0 = pd.read_parquet(args.data / "summary_w0.parquet", columns=["location_id", "annual_cf"])
    deployed = np.unique(w0.location_id.values)
    excl = {r["location_id"] for r in json.loads(EXCLUDED.read_text())["regions"]}
    ids, solar_all = C.load_solar()
    expect = np.array(sorted(set(ids.tolist()) - excl))
    if not np.array_equal(deployed, expect):
        raise SystemExit("deployed regions differ from the solar ids minus excluded_regions.json")
    print(f"deployed regions {len(deployed)} (= {len(ids)} - {len(excl)} excluded)")
    for name, p in [("summary_w0.parquet", args.data / "summary_w0.parquet"),
                    ("voronoi_wind_resource.csv", args.data / "voronoi_wind_resource.csv"),
                    ("excluded_regions.json", EXCLUDED),
                    ("_solar_matrix.npy", C.WORKSPACE / "outputs/wind/_solar_matrix.npy"),
                    ("_solar_ids.npy", C.WORKSPACE / "outputs/wind/_solar_ids.npy"),
                    ("wind_profiles_on.parquet", args.wind_profiles / "wind_profiles_on.parquet"),
                    ("wind_profiles_off.parquet", args.wind_profiles / "wind_profiles_off.parquet")]:
        log["inputs"][name] = sha256(p)
        print(f"  {name}: {log['inputs'][name][:16]}")
    manifest = {"version": 1, "baseload_mw": 1000, "hours": C.N_HOURS, "sets": []}

    if "wind_mix" in sets:
        res = pd.read_csv(args.data / "voronoi_wind_resource.csv")
        res = res[res.location_id.isin(deployed)]
        sel = np.sort(res.loc[(res.on_area_km2 > 0) & (res.off_area_km2 > 0), "location_id"].values.astype(int))
        sol = np.ascontiguousarray(solar_all[np.searchsorted(ids, sel)])
        _, on = C.load_wind(args.wind_profiles / "wind_profiles_on.parquet", ids, sel)
        _, off = C.load_wind(args.wind_profiles / "wind_profiles_off.parquet", ids, sel)
        cfgs = mix_configs()
        n = len(sel)
        loc = np.tile(sel, len(cfgs)); cfg = np.repeat(np.arange(len(cfgs)), n)
        cf = np.empty(len(cfgs) * n, dtype="float32"); curt = np.empty_like(cf)
        # check: with off = 0 the summed series reproduces summary_w2 (onshore 2) for these regions
        w2 = pd.read_parquet(args.data / "summary_w2.parquet")
        ref = w2[(w2.solar_gw == 3) & (w2.batt_gwh == 8)].set_index("location_id").annual_cf.loc[sel].values
        c_chk, _ = C.simulate(sol, (on * np.float32(2) + off * np.float32(0)).astype("float32"), 3, 1.0, 8)
        c_dir, _ = C.simulate(sol, on, 3, 2, 8)
        bad = (r4(c_chk) != ref) & ~(np.abs(c_chk - ref) <= 5.1e-5)
        print(f"  check: summed series with off = 0 equals the onshore kernel {np.array_equal(c_chk, c_dir)}, "
              f"summary_w2 s3 b8 {not bad.any()}")
        if bad.any() or not np.array_equal(c_chk, c_dir):
            raise SystemExit("wind_mix harness does not reproduce the slices")
        k = 0
        for a, b in LEAN9:
            wind = (on * np.float32(a) + off * np.float32(b)).astype("float32")
            for s in MIX_SOLAR:
                for bb in MIX_BATT:
                    c1, u1 = C.simulate(sol, wind, s, 1.0, bb)
                    assert cfgs[k]["on"] == a and cfgs[k]["off"] == b and cfgs[k]["solar"] == s and cfgs[k]["batt"] == bb
                    cf[k * n:(k + 1) * n] = r4(c1); curt[k * n:(k + 1) * n] = r4(u1)
                    k += 1
            print(f"  wind_mix on {a} + off {b} done ({time.time() - t0:.0f} s)", flush=True)
        path = args.out / "addon_wind_mix.parquet"
        rows = write(path, loc, cfg, cf, curt)
        entry = {"id": "wind_mix", "file": path.name, "sha256": sha256(path), "start": "cold",
                 "regions": int(n), "rows": int(rows), "rule": "on_area_km2 > 0 and off_area_km2 > 0",
                 "configs": cfgs}
        manifest["sets"].append(entry)
        log["sets"]["wind_mix"] = {k2: v for k2, v in entry.items() if k2 != "configs"} | {"bytes": path.stat().st_size}
        del on, off, sol

    if "large" in sets:
        mx = w0.groupby("location_id").annual_cf.max()
        sel = np.sort(mx[mx < LARGE_BELOW].index.values.astype(int))
        sol = np.ascontiguousarray(solar_all[np.searchsorted(ids, sel)])
        zero = np.zeros_like(sol)
        cfgs = large_configs()
        n = len(sel)
        loc = np.tile(sel, len(cfgs)); cfg = np.repeat(np.arange(len(cfgs)), n)
        cf = np.empty(len(cfgs) * n, dtype="float32"); curt = np.empty_like(cf)
        passes_max = 0
        for k, c in enumerate(cfgs):
            soc = np.zeros(n)
            for p in range(1, 51):
                c1, u1, end = C.simulate_soc(sol, zero, c["solar"], 0.0, c["batt"], soc0=soc)
                if np.all(np.abs(end - soc) <= 1e-6):
                    break
                soc = end
            else:
                raise SystemExit(f"cyclic year did not converge for solar {c['solar']} battery {c['batt']}")
            passes_max = max(passes_max, p)
            cf[k * n:(k + 1) * n] = r4(c1); curt[k * n:(k + 1) * n] = r4(u1)
            if k % 24 == 23:
                print(f"  large {k + 1}/{len(cfgs)} ({time.time() - t0:.0f} s)", flush=True)
        # CF never falls as battery grows within a solar level (interpolation relies on it)
        grid = cf.reshape(len(cfgs), n)
        for s in R_SOLAR:
            js = [c["j"] for c in cfgs if c["solar"] == s]
            if np.any(np.diff(grid[js], axis=0) < 0):
                raise SystemExit(f"CF falls with battery at solar {s}")
        path = args.out / "addon_large.parquet"
        rows = write(path, loc, cfg, cf, curt)
        entry = {"id": "large", "file": path.name, "sha256": sha256(path), "start": "cyclic",
                 "regions": int(n), "rows": int(rows), "rule": f"max annual_cf in summary_w0 < {LARGE_BELOW}",
                 "interpolate": "battery-linear", "guard": GUARD, "configs": cfgs}
        manifest["sets"].append(entry)
        log["sets"]["large"] = {k2: v for k2, v in entry.items() if k2 != "configs"} | {
            "bytes": path.stat().st_size, "cyclic_passes_max": passes_max,
            "regions_below_0.99": int((mx < 0.99).sum())}

    (args.out / "addon.json").write_text(json.dumps(manifest, separators=(",", ":")))
    log["addon.json"] = sha256(args.out / "addon.json")
    log["seconds"] = round(time.time() - t0, 1)
    (args.out / "build_addon.log.json").write_text(json.dumps(log, indent=1))
    print(json.dumps({k: v for k, v in log.items() if k != "inputs"}, indent=1))


if __name__ == "__main__":
    main()
