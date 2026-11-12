"""ERA5 100 m wind speed at every wind site for one year (T060).

The workspace's scripts/pipeline/wind/fetch_era5_wind.py, parameterised by year:
the hour offset is hours since 1900-01-01 to 1 January of the year, and the length
is 8,760 or 8,784. Same zarr store, same point list (workspace
outputs/voronoi_wind_resource.csv, non-viable sites parked at the cell centre),
same bilinear weights and float32 arithmetic. Resumable via a checkpoint.

  python3 -I fetch_era5_year.py --year 2019 --resource <ws>/outputs/voronoi_wind_resource.csv
  python3 -I fetch_era5_year.py --year 2024 --hours 0,100,5000 --resource ...   (spot check)
"""
from __future__ import annotations

import os
import argparse
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from numcodecs import Blosc

BUCKET = "https://storage.googleapis.com/gcp-public-data-arco-era5"
ZARR = f"{BUCKET}/ar/full_37-1h-0p25deg-chunk-1.zarr-v3"
VARS = ("100m_u_component_of_wind", "100m_v_component_of_wind")
NLAT, NLON = 721, 1440
RES = 0.25
OUT = Path(os.environ.get("TENYEAR_ROOT", str(Path.home() / "wind-atlas-T064"))) / "raw" / "era5"

_codec = Blosc()
_session = requests.Session()
_session.mount("https://", requests.adapters.HTTPAdapter(pool_connections=64, pool_maxsize=64, max_retries=5))


def hour0(year: int) -> int:
    return (date(year, 1, 1) - date(1900, 1, 1)).days * 24


def n_hours(year: int) -> int:
    return (date(year + 1, 1, 1) - date(year, 1, 1)).days * 24


def bilinear_weights(lats, lons):
    y = (90.0 - lats) / RES
    x = (lons % 360.0) / RES
    y0 = np.clip(np.floor(y).astype(int), 0, NLAT - 2)
    x0 = np.floor(x).astype(int) % NLON
    fy = np.clip(y - y0, 0, 1)
    fx = x - np.floor(x)
    x1 = (x0 + 1) % NLON
    y1 = y0 + 1
    idx = np.stack([y0 * NLON + x0, y0 * NLON + x1, y1 * NLON + x0, y1 * NLON + x1])
    w = np.stack([(1 - fy) * (1 - fx), (1 - fy) * fx, fy * (1 - fx), fy * fx]).astype("float32")
    return idx, w


def read_hour(var: str, t: int) -> np.ndarray:
    # Tolerates network outages (DNS drops etc.): capped exponential backoff for
    # up to about 3 hours before giving up on a slice.
    wait, waited = 2.0, 0.0
    while True:
        try:
            r = _session.get(f"{ZARR}/{var}/{t}.0.0", timeout=120)
            r.raise_for_status()
            return np.frombuffer(_codec.decode(r.content), dtype="<f4")
        except Exception as e:
            if waited > 3 * 3600:
                raise
            print(f"  retry {var} t={t} in {wait:.0f} s: {type(e).__name__}: {str(e)[:120]}", flush=True)
            time.sleep(wait)
            waited += wait
            wait = min(wait * 2, 120.0)


def points(resource_csv: Path):
    df = pd.read_csv(resource_csv)
    sets = {"centre": (df["latitude"].to_numpy(), df["longitude"].to_numpy())}
    for name in ("on", "off"):
        la = df[f"{name}_site_lat"].to_numpy().copy()
        lo = df[f"{name}_site_lon"].to_numpy().copy()
        bad = ~np.isfinite(la) | ~np.isfinite(lo)
        la[bad] = df["latitude"].to_numpy()[bad]
        lo[bad] = df["longitude"].to_numpy()[bad]
        sets[name] = (la, lo)
    all_lat = np.concatenate([sets[k][0] for k in ("centre", "on", "off")])
    all_lon = np.concatenate([sets[k][1] for k in ("centre", "on", "off")])
    return df, all_lat, all_lon


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--resource", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--checkpoint-hours", type=int, default=744)
    ap.add_argument("--hours", default="", help="comma list: spot-check these hours only")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    df, all_lat, all_lon = points(a.resource)
    n_each = len(df)
    idx, w = bilinear_weights(all_lat, all_lon)
    H0, NH = hour0(a.year), n_hours(a.year)

    def do_hour(h):
        t = H0 + h
        u = read_hour(VARS[0], t)
        v = read_hour(VARS[1], t)
        s = np.sqrt(u * u + v * v)
        return h, (s[idx] * w).sum(axis=0).astype("float32")

    if a.hours:
        hs = [int(x) for x in a.hours.split(",")]
        with ThreadPoolExecutor(a.workers) as ex:
            res = dict(ex.map(do_hour, hs))
        np.savez(OUT / f"spot_{a.year}.npz", hours=np.array(hs), speed=np.stack([res[h] for h in hs]))
        print(f"spot check {len(hs)} hours written")
        return

    out = OUT / f"era5_speed_{a.year}.npz"
    if out.exists():
        print(f"{out} exists"); return
    speed = np.zeros((NH, len(all_lat)), dtype="float32")
    ckpt = OUT / f"era5_{a.year}.partial.npy"
    meta = OUT / f"era5_{a.year}.progress.txt"
    start = 0
    if ckpt.exists() and meta.exists():
        start = int(meta.read_text().strip())
        speed[:start] = np.load(ckpt, mmap_mode="r")[:start]
        print(f"resuming {a.year} from hour {start}", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(a.workers) as ex:
        for bs in range(start, NH, a.checkpoint_hours):
            block = range(bs, min(bs + a.checkpoint_hours, NH))
            for h, vals in ex.map(do_hour, block):
                speed[h] = vals
            done = block[-1] + 1
            np.save(ckpt, speed)
            meta.write_text(str(done))
            el = time.time() - t0
            print(f"  {a.year}: {done}/{NH} h, {el/60:.1f} min, "
                  f"{(NH-done)*el/max(done-start,1)/60:.1f} min left", flush=True)
    np.savez_compressed(out, centre=speed[:, :n_each], on=speed[:, n_each:2 * n_each],
                        off=speed[:, 2 * n_each:], location_id=df["location_id"].to_numpy(), hour0=H0)
    ckpt.unlink(missing_ok=True); meta.unlink(missing_ok=True)
    print(f"wrote {out.name} ({out.stat().st_size/1e6:.0f} MB) in {(time.time()-t0)/60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
