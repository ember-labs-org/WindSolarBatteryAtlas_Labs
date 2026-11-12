"""T086: aggregate Copernicus CGLS-LC100 collection 3, epoch 2019 (v3.0.1) to the atlas's 0.02 deg grid.

Source: Buchhorn et al. (2020), Copernicus Global Land Service: Land Cover 100m, collection 3,
epoch 2019, Globe, v3.0.1. Zenodo, doi:10.5281/zenodo.3939050 (CC BY 4.0). EPSG:4326, 1/1008 deg
pixels, 80 N to 60 S.

Layers read:
  discrete  Discrete-Classification-map (downloaded, kept): 40 = cultivated and managed
            vegetation/agriculture (cropland); 111-116 = closed forest (tree canopy > 70%);
            121-126 = open forest (15-70%).
  tree      Tree-CoverFraction-layer (0-100 %, 255 = no data), streamed over HTTP and not kept
            (5.65 GB, over the task's 5 GB download budget): dense forest = tree cover >= 50%.

The CGLS grid nests in the atlas grid exactly every 504 rows / 1,008 columns (25 / 50 atlas
pixels; 20.16 CGLS pixels per atlas pixel). Each CGLS pixel goes to the atlas pixel holding its
centre: atlas col = floor((2c + 1) * 25 / 1008), atlas row = 500 + floor((2r + 1) * 25 / 1008),
in integer arithmetic (no ties occur). Counts per atlas pixel, rows 500-7499 (80 N to 60 S):
  n_all    CGLS pixels whose centre lies in the atlas pixel (geometry only)
  n_crop   class 40
  n_closed classes 111-116
  n_open   classes 121-126
  n_t50    tree cover 50-100 (needs the tree layer)
  n_union  class 40 or tree cover >= 50 (same CGLS pixel)
  n_crop_t50  class 40 and tree cover >= 50
  n_closed_t50  closed forest and tree cover >= 50 (consistency check)
  n_nodata_tree  tree layer 255

One strip of 504 CGLS rows = 25 atlas rows; each strip is saved on its own so a broken
stream resumes. Writes only under --out (never OneDrive).

Usage: python3 -I landcover_agg.py --discrete <tif> --tree <tif or https URL> --out <dir>
                                   [--strips a:b]
"""
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

import numpy as np

CLOUD = (Path.home() / "Library" / "CloudStorage").resolve()
PER_DEG = 1008
STRIP = 504                       # CGLS rows per strip = 25 atlas rows
N_STRIPS = 140 * PER_DEG // STRIP  # 280
ATLAS_ROW0 = 500                  # atlas row of 80 N
WIDTH = 360 * PER_DEG


def guard(p: Path) -> Path:
    r = Path(p).resolve()
    if r.is_relative_to(CLOUD):
        raise SystemExit(f"refusing to write under OneDrive: {r}")
    return r


def starts(n_src: int) -> np.ndarray:
    """First source index of each target pixel inside one repeat unit."""
    tgt = ((2 * np.arange(n_src) + 1) * 25) // PER_DEG
    s = np.flatnonzero(np.r_[True, tgt[1:] != tgt[:-1]])
    assert np.array_equal(tgt[s], np.arange(tgt[-1] + 1)), "target indices not contiguous"
    return s


ROW_S = starts(STRIP)      # 25 groups
COL_S = starts(PER_DEG)    # 50 groups
assert ROW_S.size == 25 and COL_S.size == 50


def agg(mask: np.ndarray) -> np.ndarray:
    """(504, 362880) bool -> (25, 18000) uint16 counts."""
    m = mask.reshape(STRIP, 360, PER_DEG)
    c = np.add.reduceat(m, COL_S, axis=2, dtype=np.uint16)       # (504, 360, 50)
    r = np.add.reduceat(c, ROW_S, axis=0, dtype=np.uint16)       # (25, 360, 50)
    return r.reshape(25, 360 * 50)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--discrete", required=True)
    ap.add_argument("--tree", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--strips", default=f"0:{N_STRIPS}")
    a = ap.parse_args()
    import rasterio
    from rasterio.windows import Window
    out = guard(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tree_path = a.tree if not a.tree.startswith("http") else "/vsicurl/" + a.tree
    lo, hi = (int(x) for x in a.strips.split(":"))
    env = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MAX_RETRY="20",
               GDAL_HTTP_RETRY_DELAY="5", GDAL_CACHEMAX=512, CPL_VSIL_CURL_CHUNK_SIZE="2097152",
               GDAL_HTTP_TIMEOUT="120")
    with rasterio.Env(**env), rasterio.open(a.discrete) as dsc, rasterio.open(tree_path) as tre:
        for s in (dsc, tre):
            assert (s.width, s.height) == (WIDTH, 140 * PER_DEG), (s.width, s.height)
            t = s.transform
            assert abs(t.a - 1 / PER_DEG) < 1e-12 and abs(t.e + 1 / PER_DEG) < 1e-12, t
            assert abs(t.c + 180) < 1e-9 and abs(t.f - 80) < 1e-9, t
        for i in range(lo, hi):
            f = out / f"strip_{i:03d}.npz"
            if f.exists():
                continue
            t0 = time.time()
            win = Window(0, i * STRIP, WIDTH, STRIP)
            d = dsc.read(1, window=win)
            crop = d == 40
            closed = (d >= 111) & (d <= 116)
            opn = (d >= 121) & (d <= 126)
            del d
            tr = tre.read(1, window=win)
            t50 = (tr >= 50) & (tr <= 100)
            nod = tr == 255
            assert not ((tr > 100) & (tr != 255)).any(), "tree cover outside 0-100/255"
            del tr
            res = {
                "n_all": agg(np.ones((STRIP, WIDTH), bool)),
                "n_crop": agg(crop), "n_closed": agg(closed), "n_open": agg(opn),
                "n_t50": agg(t50), "n_union": agg(crop | t50), "n_crop_t50": agg(crop & t50),
                "n_closed_t50": agg(closed & t50), "n_nodata_tree": agg(nod),
            }
            tmp = out / f"strip_{i:03d}.tmp.npz"
            np.savez_compressed(tmp, **res)
            os.replace(tmp, f)
            print(f"strip {i} ({80 - i * 0.5:.1f} N) {time.time() - t0:.1f}s "
                  f"crop {int(res['n_crop'].sum()):,} t50 {int(res['n_t50'].sum()):,}", flush=True)


if __name__ == "__main__":
    main()
