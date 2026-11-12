"""Run the solar x wind x battery simulation and write the deployable data set.

Outputs
  <samples-dir>/samples_gen_solar_s{S}.parquet          solar generation per level
  <samples-dir>/samples_gen_wind_{on|off}_w{W}.parquet  wind generation per level
  <samples-dir>/samples_s{S}[_w{W}|_wo{W}]_b{B}.parquet battery flow per config
  deployment/data/summary_w{W}.parquet, summary_wo{W}.parquet
  deployment/data/configs.json, sample_timestamps.json

Resumable: a configuration whose shard and summary part both exist is skipped.

Usage:
    cd workspace && python3 -m scripts.pipeline.run3d --sample 40      # smoke test
    cd workspace && python3 -m scripts.pipeline.run3d
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from scripts.pipeline import simulation3d as S
from scripts.pipeline.config import (
    BASELOAD_GW,
    DOCS_DATA_DIR,
    INPUTS_DIR,
    N_HOURS,
    OUTPUTS_DIR,
    SAMPLE_DURATION_HOURS,
    SOLAR_PROFILES_PARQUET,
    WIND_PROFILES_OFF_PARQUET,
    WIND_PROFILES_ON_PARQUET,
    build_config_list,
    shard_name,
    summary_name,
)

# Intermediate per-configuration results must NOT live under OneDrive: a few
# thousand small files there get dehydrated mid-run and reads block for minutes.
DEFAULT_PARTS_DIR = Path.home() / "atlas-work" / "summary_parts"
CACHE = OUTPUTS_DIR / "wind"


# ---------------------------------------------------------------------------
def load_matrix(path: Path, expect_ids: np.ndarray | None, label: str):
    import duckdb

    con = duckdb.connect()
    con.execute("SET threads=6")
    order = "location_id, ts" if "solar" in path.name else "location_id, hour_index"
    col = "kwh_per_kw"
    tbl = con.execute(f"SELECT location_id, {col} FROM '{path}' ORDER BY {order}").fetch_arrow_table()
    ids = np.unique(tbl["location_id"].to_numpy())
    mat = tbl[col].to_numpy().astype("float32").reshape(len(ids), N_HOURS)
    if expect_ids is not None and not np.array_equal(ids, expect_ids):
        raise SystemExit(f"{label}: location order differs from the solar profiles")
    print(f"  {label}: {mat.shape} mean CF {mat.mean():.4f}")
    return ids, mat


def season_table(ids: np.ndarray) -> dict:
    return {
        "location_id": pa.array(np.repeat(ids.astype("int32"), len(S.SEASON_NAMES)), type=pa.int32()),
        "season": pa.array(np.tile(np.array(S.SEASON_NAMES), len(ids))).dictionary_encode(),
    }


def write_series(path: Path, ids: np.ndarray, arr: np.ndarray, name: str) -> None:
    cols = season_table(ids)
    cols[name] = pa.array(list(arr.reshape(-1, SAMPLE_DURATION_HOURS)), type=pa.list_(pa.int16()))
    pq.write_table(pa.table(cols), path, compression="zstd", compression_level=9)


def generation_samples(mat: np.ndarray, gw: float) -> np.ndarray:
    out = np.empty((mat.shape[0], len(S.SEASON_STARTS), SAMPLE_DURATION_HOURS), dtype="int16")
    for si, st in enumerate(S.SEASON_STARTS):
        out[:, si, :] = np.rint(mat[:, st : st + SAMPLE_DURATION_HOURS] * gw * S.SAMPLE_SCALE)
    return out


# ---------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--samples-dir", type=Path, default=Path.home() / "atlas-shards")
    ap.add_argument("--sample", type=int, default=0, help="limit to N locations (smoke test)")
    ap.add_argument("--configs", type=str, default="", help="index slice a:b")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--skip-samples", action="store_true")
    ap.add_argument("--parts-dir", type=Path, default=DEFAULT_PARTS_DIR)
    args = ap.parse_args()

    samples_dir = args.samples_dir
    parts_dir = args.parts_dir
    samples_dir.mkdir(parents=True, exist_ok=True)
    parts_dir.mkdir(parents=True, exist_ok=True)
    DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)

    print("Loading profiles ...")
    cached = CACHE / "_solar_matrix.npy"
    if cached.exists():
        solar = np.load(cached)
        ids = np.load(CACHE / "_solar_ids.npy")
        print(f"  solar (cached): {solar.shape} mean CF {solar.mean():.4f}")
    else:
        ids, solar = load_matrix(SOLAR_PROFILES_PARQUET, None, "solar")
    _, wind_on = load_matrix(WIND_PROFILES_ON_PARQUET, ids, "wind onshore")
    _, wind_off = load_matrix(WIND_PROFILES_OFF_PARQUET, ids, "wind offshore")

    if args.sample:
        n = args.sample
        ids, solar, wind_on, wind_off = ids[:n], solar[:n], wind_on[:n], wind_off[:n]
        print(f"  limited to {n} locations")

    # coordinates for the summary files
    import pandas as pd

    pts = pd.read_csv(OUTPUTS_DIR / "voronoi_points.csv").set_index("location_id")
    lat = pts.loc[ids, "latitude"].to_numpy(dtype="float32")
    lon = pts.loc[ids, "longitude"].to_numpy(dtype="float32")

    configs = build_config_list()
    if args.configs:
        a, b = args.configs.split(":")
        configs = configs[int(a or 0) : int(b or len(configs))]
    print(f"{len(configs)} configurations")

    # ---- shared generation series ----
    if not args.skip_samples:
        print("Writing generation reference series ...")
        for gw in sorted({c[2] for c in configs}):
            p = samples_dir / f"samples_gen_solar_s{gw}.parquet"
            if not p.exists() or args.overwrite:
                write_series(p, ids, generation_samples(solar, gw), "solar_gen")
        for surface, mat in (("on", wind_on), ("off", wind_off)):
            for gw in sorted({c[3] for c in configs if c[1] == surface and c[3] > 0}):
                p = samples_dir / f"samples_gen_wind_{surface}_w{gw}.parquet"
                if not p.exists() or args.overwrite:
                    write_series(p, ids, generation_samples(mat, gw), "wind_gen")

    ec, ed = S.efficiencies()
    cf, curt, samp = S.make_buffers(len(ids))
    # warm the jit on a tiny slice so the first timing is honest
    S.simulate_config(solar[:8], wind_on[:8], 1.0, 0.0, 2.0, ec, ed, S.SEASON_STARTS,
                      cf[:8], curt[:8], samp[:8])

    results_cf: dict[int, np.ndarray] = {}
    results_curt: dict[int, np.ndarray] = {}
    t0 = time.time()
    n_run = 0
    for pos, (idx, surface, s_gw, w_gw, b_gwh) in enumerate(configs):
        shard = samples_dir / shard_name(surface, s_gw, w_gw, b_gwh)
        if not args.skip_samples and shard.exists() and not args.overwrite:
            # shard already written, but we still need the summary numbers
            pass
        wind_m = wind_on if surface == "on" else wind_off
        S.simulate_config(solar, wind_m, float(s_gw), float(w_gw), float(b_gwh),
                          ec, ed, S.SEASON_STARTS, cf, curt, samp)
        results_cf[idx] = cf.astype("float32")
        results_curt[idx] = curt.astype("float32")
        if not args.skip_samples and (not shard.exists() or args.overwrite):
            write_series(shard, ids, samp, "battery_flow")
        n_run += 1
        if n_run % 25 == 0 or pos == len(configs) - 1:
            el = time.time() - t0
            rate = n_run / max(el, 1e-9)
            left = (len(configs) - pos - 1) / max(rate, 1e-9)
            print(f"  {pos+1}/{len(configs)} configs  {el/60:5.1f} min elapsed, "
                  f"{left/60:5.1f} min left  (last: s{s_gw} {surface}w{w_gw} b{b_gwh} "
                  f"cf {cf.mean():.3f})", flush=True)

    # ---- assemble summaries ----
    print("Assembling summary files ...", flush=True)
    groups: dict[str, list] = {}
    for idx, surface, s_gw, w_gw, b_gwh in configs:
        groups.setdefault(summary_name(surface, w_gw), []).append((idx, s_gw, w_gw, b_gwh))
    for name, items in sorted(groups.items()):
        cols = {k: [] for k in ("location_id", "latitude", "longitude", "solar_gw",
                                "wind_gw", "batt_gwh", "annual_cf", "curtailed_share")}
        for idx, s_gw, w_gw, b_gwh in items:
            if idx not in results_cf:
                continue
            z = {"cf": results_cf[idx], "curt": results_curt[idx]}
            cols["location_id"].append(ids.astype("int32"))
            cols["latitude"].append(lat)
            cols["longitude"].append(lon)
            cols["solar_gw"].append(np.full(len(ids), s_gw, dtype="int8"))
            cols["wind_gw"].append(np.full(len(ids), w_gw, dtype="int8"))
            cols["batt_gwh"].append(np.full(len(ids), b_gwh, dtype="int8"))
            cols["annual_cf"].append(np.round(z["cf"], 4).astype("float32"))
            cols["curtailed_share"].append(np.round(z["curt"], 4).astype("float32"))
        if not cols["location_id"]:
            continue
        tbl = pa.table({k: pa.array(np.concatenate(v)) for k, v in cols.items()})
        out = DOCS_DATA_DIR / name
        pq.write_table(tbl, out, compression="zstd", compression_level=9)
        print(f"  {name}: {tbl.num_rows} rows, {out.stat().st_size/1e6:.1f} MB", flush=True)

    # ---- manifest ----
    manifest = {
        "baseload_mw": BASELOAD_GW * 1000,
        "hours": N_HOURS,
        "sample_hours": SAMPLE_DURATION_HOURS,
        "seasons": list(S.SEASON_NAMES),
        "sample_scale": S.SAMPLE_SCALE,
        "configs": [
            {"i": i, "surface": sf, "solar": s, "wind": w, "batt": b,
             "shard": shard_name(sf, s, w, b), "summary": summary_name(sf, w)}
            for i, sf, s, w, b in build_config_list()
        ],
    }
    (DOCS_DATA_DIR / "configs.json").write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"  configs.json: {len(manifest['configs'])} configurations")

    stamps = {}
    base = np.datetime64("2024-01-01T00:00:00")
    for name, st in zip(S.SEASON_NAMES, S.SEASON_STARTS):
        stamps[name] = [str(base + np.timedelta64(int(st + h), "h")) for h in range(SAMPLE_DURATION_HOURS)]
    (DOCS_DATA_DIR / "sample_timestamps.json").write_text(json.dumps(stamps, separators=(",", ":")))
    print(f"  sample_timestamps.json written")
    print(f"done in {(time.time()-t0)/60:.1f} min; {n_run} configurations simulated")


if __name__ == "__main__":
    main()
