"""T054: run the wind pipeline from the repo copy against the laptop workspace,
writing only into a scratch run directory.

Layout made under --run-dir (inputs are symlinks into the workspace and are only
read; every file the pipeline writes is a real file under --run-dir):

  ws/input_data/wind -> <workspace>/input_data/wind        (GWA, eligibility)
  ws/input_data/solar_profiles.parquet -> <workspace>/...
  ws/input_data/wind_profiles_{on,off}.parquet             written by profiles
  ws/outputs/voronoi_points.csv, voronoi_cells.geojson -> <workspace>/outputs/...
  ws/outputs/wind/era5_speed_2024.npz, _solar_*.npy -> <workspace>/outputs/wind/...
  ws/outputs/voronoi_wind_resource.csv                     written by siting/profiles
  data/                                                    ATLAS_DOCS_DATA_DIR
  shards/, parts/                                          run3d scratch dirs

Steps: site (site_selection --rule R), profiles, run3d (--configs A:B
--skip-samples), daily (build_daily_cf.py). Each runs under /usr/bin/time -l.
Before a run it checks free disk (>= --min-free-gb) and that no write target
resolves under OneDrive; after it, that nothing under the workspace changed.

Usage:
  python3 -I harness.py --workspace <ws> --repo <repo> --run-dir <dir> --rule p90 \
      --steps site,profiles,run3d,daily --configs 0:3216
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

LINKS = [
    ("input_data/wind", "input_data/wind"),
    ("input_data/solar_profiles.parquet", "input_data/solar_profiles.parquet"),
    ("outputs/voronoi_points.csv", "outputs/voronoi_points.csv"),
    ("outputs/voronoi_cells.geojson", "outputs/voronoi_cells.geojson"),
    ("outputs/wind/era5_speed_2024.npz", "outputs/wind/era5_speed_2024.npz"),
    ("outputs/wind/_solar_matrix.npy", "outputs/wind/_solar_matrix.npy"),
    ("outputs/wind/_solar_ids.npy", "outputs/wind/_solar_ids.npy"),
]
BOOT = ("import sys, runpy; sys.dont_write_bytecode = True; sys.path.insert(0, sys.argv[1]); "
        "mod = sys.argv[2]; sys.argv = [mod] + sys.argv[3:]; "
        "runpy.run_module(mod, run_name='__main__', alter_sys=True)")


CLOUD = (Path.home() / "Library" / "CloudStorage").resolve()


def forbidden(p: Path) -> bool:
    """True if p resolves into a synced cloud folder (OneDrive on this laptop)."""
    return p.resolve().is_relative_to(CLOUD)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", type=Path, required=True)
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--run-dir", type=Path, required=True)
    ap.add_argument("--rule", choices=("best-area", "best500", "p90", "share"), required=True)
    ap.add_argument("--share", default=None, help="share rule (T061): per cent of eligible area")
    ap.add_argument("--level-factors", default=None, help="T061: CSV of per-region level factors")
    ap.add_argument("--steps", default="site,profiles,run3d,daily")
    ap.add_argument("--configs", default="290:3216")
    ap.add_argument("--min-free-gb", type=float, default=10.0)
    a = ap.parse_args()

    run = a.run_dir.resolve()
    ws = run / "ws"
    data = run / "data"
    for d in (ws / "input_data", ws / "outputs" / "wind", data, run / "shards", run / "parts"):
        d.mkdir(parents=True, exist_ok=True)
    for dst, src in LINKS:
        t = ws / dst
        if not t.is_symlink():
            t.symlink_to(a.workspace / src)

    writes = [ws / "outputs" / "voronoi_wind_resource.csv",
              ws / "input_data" / "wind_profiles_on.parquet",
              ws / "input_data" / "wind_profiles_off.parquet",
              data, run / "shards", run / "parts", data / "daily_cf_2024.parquet"]
    for w in writes:
        if w.is_symlink() or forbidden(w):
            raise SystemExit(f"refusing: write target {w} resolves to {w.resolve()}")
    print(f"write targets checked: none under OneDrive ({len(writes)})")
    if forbidden(run):
        raise SystemExit("run dir is under OneDrive")

    free = shutil.disk_usage(run).free / 1e9
    print(f"free disk {free:.1f} GB (need >= {a.min_free_gb})", flush=True)
    if free < a.min_free_gb:
        raise SystemExit("not enough free disk")

    env = dict(os.environ, ATLAS_WORKSPACE_DIR=str(ws), ATLAS_DOCS_DATA_DIR=str(data))
    pipe = str((a.repo / "pipeline").resolve())
    py = [sys.executable, "-I", "-B", "-c", BOOT, pipe]
    cmds = {
        "site": py + ["scripts.pipeline.wind.site_selection", "--rule", a.rule]
                + (["--share", a.share] if a.share is not None else [])
                + (["--level-factors", str(Path(a.level_factors).resolve())] if a.level_factors else []),
        "profiles": py + ["scripts.pipeline.wind.build_wind_profiles"],
        "run3d": py + ["scripts.pipeline.run3d", "--configs", a.configs, "--skip-samples",
                       "--samples-dir", str(run / "shards"), "--parts-dir", str(run / "parts")],
        "daily": [sys.executable, "-I", "-B", str(a.repo / "pipeline/scripts/sample_days/build_daily_cf.py"),
                  "--input-dir", str(ws / "input_data"), "--out", str(data / "daily_cf_2024.parquet")],
    }
    marker = run / f".start-{int(time.time())}"
    marker.touch()
    for step in a.steps.split(","):
        print(f"\n===== {step} =====", flush=True)
        t0 = time.time()
        r = subprocess.run(["/usr/bin/time", "-l"] + cmds[step], env=env, cwd=run)
        print(f"===== {step}: exit {r.returncode}, {time.time()-t0:.0f} s", flush=True)
        if r.returncode:
            raise SystemExit(r.returncode)
    # nothing under the workspace may have been touched
    out = subprocess.run(["find", str(a.workspace), "-newer", str(marker), "-type", "f"],
                         capture_output=True, text=True).stdout.strip()
    print("workspace files changed during the run: " + (out or "none"))
    if out:
        raise SystemExit("workspace was written to")


if __name__ == "__main__":
    main()
