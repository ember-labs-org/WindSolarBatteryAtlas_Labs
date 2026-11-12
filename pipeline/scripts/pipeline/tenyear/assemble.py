"""Assemble run10 parts into the app's files (T060).

  python3 -I assemble.py --repo <wt> --parts work/parts10 --out <dir> --sets dense,wind_mix,large \
      --points <ws>/outputs/voronoi_points.csv [--detail results/] [--years 2015-2024]

dense    -> summary_*.parquet exactly as run3d.py writes them (columns, dtypes,
            zstd 9, round(float32 cf, 4)), over all 4,998 regions, then the 533
            excluded regions dropped with apply_exclusion.filter_parquet (the
            exclusion step's own function and writer settings).
wind_mix -> addon_wind_mix.parquet, large -> addon_large.parquet, both with
            build_addon.write(); addon.json as build_addon.py writes it.
--detail -> per-year parquet per set: location_id, config, cf_<year>..., cf_mean.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run10 as R  # noqa: E402


def sha256(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--parts", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--sets", default="dense,wind_mix,large")
    ap.add_argument("--points", type=Path, required=True)
    ap.add_argument("--detail", type=Path)
    ap.add_argument("--years", default="2015-2024")
    ap.add_argument("--large-rule-note", default="max annual_cf in summary_w0 < 0.999")
    ap.add_argument("--manifest", type=Path, help="addon.json to copy fields from (default: the repo's deployment/data)")
    ap.add_argument("--large-start", choices=("cold", "cyclic"),
                    help="T068: the large set's start state as run (run10 --cyclic); default as before")
    a = ap.parse_args()
    sys.path.insert(0, str(a.repo / "pipeline"))
    sys.path.insert(0, str(a.repo / "pipeline/scripts/exclude_regions"))
    sys.path.insert(0, str(a.repo / "pipeline/scripts/pipeline/addon"))
    from scripts.pipeline.config import build_config_list, summary_name
    import apply_exclusion as AE
    a.out.mkdir(parents=True, exist_ok=True)
    y0, _, y1 = a.years.partition("-")
    years = list(range(int(y0), int(y1 or y0) + 1))
    _, excl_ids, _, _ = AE.load_spec()
    sets = a.sets.split(",")
    detail = {}

    if "dense" in sets:
        pts = pd.read_csv(a.points).set_index("location_id")
        groups = {}
        for idx, sf, s, w, b in build_config_list():
            groups.setdefault(summary_name(sf, w), []).append((idx, s, w, b))
        drows = []
        for name, items in sorted(groups.items()):
            cols = {k: [] for k in ("location_id", "latitude", "longitude", "solar_gw", "wind_gw",
                                    "batt_gwh", "annual_cf", "curtailed_share")}
            for idx, s, w, b in items:
                z = np.load(a.parts / "dense" / f"{idx}.npz")
                ids = z["location_id"]
                lat = pts.loc[ids, "latitude"].to_numpy(dtype="float32")
                lon = pts.loc[ids, "longitude"].to_numpy(dtype="float32")
                n = len(ids)
                cols["location_id"].append(ids.astype("int32"))
                cols["latitude"].append(lat); cols["longitude"].append(lon)
                cols["solar_gw"].append(np.full(n, s, dtype="int8"))
                cols["wind_gw"].append(np.full(n, w, dtype="int8"))
                cols["batt_gwh"].append(np.full(n, b, dtype="int8"))
                # run3d: results_cf = cf.astype("float32"), then np.round(.., 4)
                cols["annual_cf"].append(np.round(z["cf"].astype("float32"), 4).astype("float32"))
                cols["curtailed_share"].append(np.round(z["curt"].astype("float32"), 4).astype("float32"))
                if a.detail:
                    keep = ~np.isin(ids, list(excl_ids))
                    drows.append((ids[keep], np.full(keep.sum(), idx), z["ycf"][keep], z["cf"][keep]))
            tbl = pa.table({k: pa.array(np.concatenate(v)) for k, v in cols.items()})
            out = a.out / name
            pq.write_table(tbl, out, compression="zstd", compression_level=9)
            n0, dropped = AE.filter_parquet(out, excl_ids, daily=False)
            print(f"{name}: {n0} rows, dropped {dropped}", flush=True)
        if a.detail:
            detail["dense"] = drows

    import build_addon as BA
    old = json.loads((a.manifest or a.repo / "deployment/data/addon.json").read_text())
    manifest = {k: v for k, v in old.items() if k != "sets"} | {"sets": []}
    oldsets = {s["id"]: s for s in old["sets"]}
    if "wind_mix" in sets:
        locs, cfgs, cf, curt, drows = [], [], [], [], []
        for wa, wb in R.LEAN9:
            # Read each array of the part once. Indexing z[...] inside the loop re-reads the whole
            # array every time, and the detail rows then kept 1,881 full copies alive (about 20 GB);
            # same values, so the files written are unchanged (proof: wind/t081/integ_assemble_proof.txt).
            with np.load(a.parts / "wind_mix" / f"on{wa}_off{wb}.npz") as z:
                zl, zc, zcf, zcu, zy = z["location_id"], z["cfg"], z["cf"], z["curt"], z["ycf"]
            n = len(zl)
            for k, j in enumerate(zc):
                locs.append(zl); cfgs.append(np.full(n, j))
                cf.append(BA.r4(zcf[k])); curt.append(BA.r4(zcu[k]))
                drows.append((zl, np.full(n, j), zy[k], zcf[k]))
        path = a.out / "addon_wind_mix.parquet"
        rows = BA.write(path, np.concatenate(locs), np.concatenate(cfgs), np.concatenate(cf), np.concatenate(curt))
        e = dict(oldsets["wind_mix"]); e.update(sha256=sha256(path), rows=int(rows), regions=int(n))
        manifest["sets"].append(e)
        detail["wind_mix"] = drows
        print(f"addon_wind_mix: {rows} rows, {n} regions", flush=True)
    if "large" in sets:
        lc = R.large_configs()
        locs, cfgs, cf, curt, drows = [], [], [], [], []
        grid = []
        for c in lc:
            z = np.load(a.parts / "large" / f"{c['j']}.npz")
            n = len(z["location_id"])
            locs.append(z["location_id"]); cfgs.append(np.full(n, c["j"]))
            cf.append(BA.r4(z["cf"])); curt.append(BA.r4(z["curt"]))
            grid.append(BA.r4(z["cf"]))
            drows.append((z["location_id"], np.full(n, c["j"]), z["ycf"], z["cf"]))
        grid = np.stack(grid)
        for s in R.R_SOLAR:
            js = [c["j"] for c in lc if c["solar"] == s]
            if np.any(np.diff(grid[js], axis=0) < 0):
                raise SystemExit(f"CF falls with battery at solar {s}")
        path = a.out / "addon_large.parquet"
        rows = BA.write(path, np.concatenate(locs), np.concatenate(cfgs), np.concatenate(cf), np.concatenate(curt))
        e = dict(oldsets["large"]); e.update(sha256=sha256(path), rows=int(rows), regions=int(n))
        if a.large_start:
            e["start"] = a.large_start
        elif len(years) > 1:
            e["start"] = "cold"
        manifest["sets"].append(e)
        detail["large"] = drows
        print(f"addon_large: {rows} rows, {n} regions", flush=True)
    if "wind_mix" in sets and "large" in sets:
        manifest["sets"].sort(key=lambda s: [x["id"] for x in old["sets"]].index(s["id"]))
        (a.out / "addon.json").write_text(json.dumps(manifest, separators=(",", ":")))
        print("addon.json", sha256(a.out / "addon.json"))

    if a.detail:
        a.detail.mkdir(parents=True, exist_ok=True)
        for k, drows in detail.items():
            loc = np.concatenate([d[0] for d in drows]).astype("int32")
            cfg = np.concatenate([d[1] for d in drows]).astype("int32")
            ycf = np.concatenate([d[2] for d in drows]).astype("float32")
            mean = np.concatenate([d[3] for d in drows]).astype("float32")
            cols = {"location_id": loc, "config": cfg}
            for j, y in enumerate(years):
                cols[f"cf_{y}"] = ycf[:, j]
            cols["cf_mean"] = mean
            pq.write_table(pa.table(cols), a.detail / f"per_year_{k}.parquet", compression="zstd",
                           compression_level=9)
            print(f"detail {k}: {len(loc)} rows", flush=True)


if __name__ == "__main__":
    main()
