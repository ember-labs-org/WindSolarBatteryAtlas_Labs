"""T081: cache the extra GWA4 and GASP layers at the atlas's 0.02 deg working grid.

Same approach as the existing gwa4_*_002deg.tif caches: read overview level 8
(0.02 deg) of the public Cloud-Optimised GeoTIFF over HTTP range requests and
place it on the global 18000 x 9000 grid (west -180, north 90).

Sources (CC BY 4.0):
- Global Wind Atlas 4 (DTU, 2025), DTU Data article 28955267: Weibull A and k
  ("combined") at 100 m and 150 m, mean wind speed at 150 m.
- Global Atlas of Siting Parameters V1 (DTU, 2021), DTU Data article 14753349:
  V50 (50-year return 10-min wind speed) at 100 m and 150 m; IEC class by the ultimate
  limit state (ULS, from V50 and air density) and by the fatigue limit state (FLS, wind
  distribution and effective turbulence, with and without wakes).

  python3 -I fetch_layers.py --out ~/wind-atlas-T081/layers
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

BASE = "/vsicurl/https://ndownloader.figshare.com/files/"
# name -> (file id, scale, source)
LAYERS = {
    "gwa4_weib_A_100m": (55360937, 100, "GWA4 weib_A_combined_cog_100m"),
    "gwa4_weib_A_150m": (55362353, 100, "GWA4 weib_A_combined_cog_150m"),
    "gwa4_weib_k_100m": (55367729, 1000, "GWA4 weib_k_combined_cog_100m"),
    "gwa4_weib_k_150m": (55369928, 1000, "GWA4 weib_k_combined_cog_150m"),
    "gwa4_wind_speed_150m": (54329396, 100, "GWA4 wind_speed_cog_150m"),
    "gasp_v50_100m": (28354818, 100, "GASP V1 gasp_V50_100m"),
    "gasp_v50_150m": (28355007, 100, "GASP V1 gasp_V50_150m"),
    "gasp_uls_class_100m": (28354779, 1, "GASP V1 gasp_uls-class_100m"),
    "gasp_uls_class_150m": (28354785, 1, "GASP V1 gasp_uls-class_150m"),
    "gasp_fls_wake_100m": (28352706, 1, "GASP V1 gasp_fls-class-wake_100m"),
    "gasp_fls_wake_150m": (28352721, 1, "GASP V1 gasp_fls-class-wake_150m"),
    "gasp_fls_nowake_100m": (28352649, 1, "GASP V1 gasp_fls-class-nowake_100m"),
}
W, H, RES = 18000, 9000, 0.02
NODATA = 65535


def fetch(name: str, out: Path) -> None:
    fid, scale, src = LAYERS[name]
    dst = out / f"{name}_002deg.tif"
    if dst.exists():
        print(f"{name}: exists, skipped", flush=True)
        return
    t0 = time.time()
    with rasterio.open(BASE + str(fid)) as s0:
        ovs = s0.overviews(1)
        lvl = ovs.index(8)
        top = s0.transform.f
        nd = s0.nodata
    with rasterio.open(BASE + str(fid), overview_level=lvl) as s:
        a = s.read(1)
        tr = s.transform
    assert abs(tr.a - RES) < 1e-6 and abs(tr.c + 180.0) < 0.01, (name, tr)
    row0 = int(round((90.0 - tr.f) / RES))
    assert abs((90.0 - tr.f) / RES - row0) < 0.1, (name, tr.f)
    bad = ~np.isfinite(a) | (a < 0)
    if nd is not None and np.isfinite(nd):
        bad |= a == nd
    q = np.where(bad, NODATA, np.clip(np.round(a.astype("float64") * scale), 0, NODATA - 1)).astype("uint16")
    g = np.full((H, W), NODATA, dtype="uint16")
    nrow = min(q.shape[0], H - row0)
    ncol = min(q.shape[1], W)
    g[row0:row0 + nrow, :ncol] = q[:nrow, :ncol]
    prof = dict(driver="GTiff", dtype="uint16", nodata=NODATA, width=W, height=H, count=1,
                crs="EPSG:4326", transform=from_origin(-180.0, 90.0, RES, RES),
                tiled=True, blockxsize=512, blockysize=512, compress="zstd")
    tmp = dst.with_suffix(".tmp.tif")
    with rasterio.open(tmp, "w", **prof) as d:
        d.write(g, 1)
        d.update_tags(source=src, figshare_file=str(fid), scale=str(scale), native_top=str(top))
    tmp.rename(dst)
    v = a[~bad]
    print(f"{name}: {a.shape} row0 {row0}, valid {v.size}, min {v.min():.3f} median {np.median(v):.3f} "
          f"max {v.max():.3f}, {time.time()-t0:.0f} s", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    for n in (a.only or LAYERS):
        fetch(n, a.out)


if __name__ == "__main__":
    main()
