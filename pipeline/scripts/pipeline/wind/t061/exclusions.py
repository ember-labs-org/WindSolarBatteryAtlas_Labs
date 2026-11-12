"""Phase B: settlement setbacks from GHSL GHS-BUILT-S 2020 (3 arc-second).

A 3" cell is 'settlement' when its built-up surface is at least
SETTLEMENT_MIN_SHARE of the cell area (about one house). Excluded land at
setback d is every 3" cell whose centre lies within d metres of a settlement
cell (d = 0: the settlement cells themselves). Distances use the true metric
cell size per row (anisotropic Euclidean distance transform), computed in 1 deg
blocks with a halo wide enough for the largest setback.

The excluded share is averaged onto the 0.02 deg working grid (24 x 24 cells)
and stored as uint8 per cent in the run directory, one band per setback.
It is combined with the existing eligibility (which already encodes the four
ESMAP layers) as a probabilistic union, new = old x (1 - excluded); see
A-T061 notes on the overlap with ESMAP's built-up > 50% layer.

Only 1 deg blocks that hold eligible onshore pixels are processed.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

from . import common as C

SETBACKS_M = (0, 500, 1000)
SETTLEMENT_MIN_SHARE = (0.10, 0.20)   # built share of a 3" cell that counts as settlement;
                                     # 1% (about one house) would put 53% of the world's and 86-88% of
                                     # Dutch and German operating capacity within 500 m (B_farm_check.txt)
SS = 3.0 / 3600.0            # 3 arc-seconds in degrees
SUB = 24                     # 0.02 deg / 3"
BLOCK_DEG = 1.0
M_PER_DEG = 111_320.0


def build(ghsl_tif: Path, out: Path | None = None, workers: int = 4) -> Path:
    import rasterio
    from rasterio.windows import Window
    from scipy import ndimage
    from concurrent.futures import ProcessPoolExecutor
    out = C.guard_write(out or C.CACHE / "setback_excl_pct_002deg.npz")
    if out.exists():
        return out
    C.guard_disk()
    S, G = C.import_siting()
    px = C.load_pixels()
    flat = px["on_flat"]
    r, c = flat // G.GRID_WIDTH, flat % G.GRID_WIDTH
    bpx = int(round(BLOCK_DEG / G.GRID_RES))            # 50 working-grid pixels per block
    blocks = np.unique((r // bpx) * 10_000 + (c // bpx))
    print(f"{blocks.size} 1-deg blocks with eligible land", flush=True)
    res = np.zeros((len(SETTLEMENT_MIN_SHARE), len(SETBACKS_M), G.GRID_HEIGHT, G.GRID_WIDTH), dtype="uint8")
    t0 = time.time()
    jobs = [(str(ghsl_tif), int(b // 10_000), int(b % 10_000), bpx) for b in blocks]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for k, (br, bc, arr) in enumerate(ex.map(_block, jobs, chunksize=8)):
            res[:, :, br * bpx:(br + 1) * bpx, bc * bpx:(bc + 1) * bpx] = arr
            if k % 500 == 0:
                print(f"  {k}/{len(jobs)} blocks, {time.time()-t0:.0f}s", flush=True)
    np.savez_compressed(out, excl_pct=res, setbacks_m=np.array(SETBACKS_M),
                        min_share=np.array(SETTLEMENT_MIN_SHARE))
    print(f"setback layers written in {time.time()-t0:.0f}s -> {out}")
    return out


def _block(job):
    import rasterio
    from rasterio.windows import from_bounds
    from scipy import ndimage
    path, br, bc, bpx = job
    S, G = C.import_siting()
    north = G.GRID_NORTH - br * bpx * G.GRID_RES
    west = G.GRID_WEST + bc * bpx * G.GRID_RES
    south, east = north - bpx * G.GRID_RES, west + bpx * G.GRID_RES
    maxd = max(SETBACKS_M)
    coslat = max(np.cos(np.radians(max(abs(north), abs(south)))), 0.05)
    halo_y = int(np.ceil(maxd / (SS * M_PER_DEG))) + 2
    halo_x = int(np.ceil(maxd / (SS * M_PER_DEG * coslat))) + 2
    from rasterio.windows import Window
    with rasterio.open(path) as src:
        # GHSL's 3" cells are offset by half a cell from whole degrees; take the
        # nearest cell alignment (shift <= 1.5", about 45 m) and an exact 24 x 24
        # cells per working-grid pixel plus the halo
        T = src.transform
        col0 = int(round((west - T.c) / T.a)) - halo_x
        row0 = int(round((T.f - north) / -T.e)) - halo_y
        win = Window(col0, row0, bpx * 24 + 2 * halo_x, bpx * 24 + 2 * halo_y)
        a = src.read(1, window=win, boundless=True, fill_value=0).astype("float32")
        nod = src.nodata
    if nod is not None:
        a[a == nod] = 0
    n_rows = a.shape[0]
    lat = (north + halo_y * SS) - (np.arange(n_rows) + 0.5) * SS
    dy = SS * M_PER_DEG
    dx_row = SS * M_PER_DEG * np.cos(np.radians(lat))
    cell_area = dy * dx_row
    out = np.zeros((len(SETTLEMENT_MIN_SHARE), len(SETBACKS_M), bpx, bpx), dtype="uint8")
    # anisotropic EDT with a single dx for the block (centre latitude); the error is
    # the cos(lat) change across 1 deg plus halo, < 2% below 70 deg
    dx = SS * M_PER_DEG * np.cos(np.radians((north + south) / 2))
    core = (slice(halo_y, halo_y + bpx * 24), slice(halo_x, halo_x + bpx * 24))
    for t, share in enumerate(SETTLEMENT_MIN_SHARE):
        settle = a >= (share * cell_area)[:, None]
        if not settle.any():
            continue
        dist = ndimage.distance_transform_edt(~settle, sampling=(dy, dx))
        for k, d in enumerate(SETBACKS_M):
            ex = (dist[core] <= d) if d > 0 else settle[core]
            frac = ex.reshape(bpx, 24, bpx, 24).mean(axis=(1, 3))
            out[t, k] = np.rint(frac * 100).astype("uint8")
    return br, bc, out


def farm_check(ghsl_tif: Path, plants, thresholds=(0.01, 0.05, 0.10, 0.20), halo=25):
    """Distance (m) from each onshore GEM farm point to the nearest settlement
    3" cell, for several settlement thresholds (share of cell area built).
    Used to bound the setback rule: a variant that excludes most existing farms
    is too strict."""
    import rasterio
    from rasterio.windows import Window
    import pandas as pd
    rows = []
    with rasterio.open(ghsl_tif) as src:
        T = src.transform
        for r in plants.itertuples(index=False):
            c = int((r.Longitude - T.c) / T.a)
            rr = int((T.f - r.Latitude) / -T.e)
            c0, r0 = max(c - halo, 0), max(rr - halo, 0)
            a = src.read(1, window=Window(c0, r0, 2 * halo + 1, 2 * halo + 1)).astype("float32")
            dy = SS * M_PER_DEG
            dx = dy * np.cos(np.radians(r.Latitude))
            yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
            dist = np.hypot((yy + r0 - rr) * dy, (xx + c0 - c) * dx)
            rec = {"iso3": r.iso3, "mw": r.mw, "start": r._asdict().get("Start year")}
            for th in thresholds:
                m = a >= th * dy * dx
                rec[f"d_{th}"] = float(dist[m].min()) if m.any() else np.inf
            rows.append(rec)
    return pd.DataFrame(rows)
