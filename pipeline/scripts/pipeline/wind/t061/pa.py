"""Phase B: protected areas from the WDPA (UNEP-WCMC and IUCN, Oct 2026).

Kept: polygon records with STATUS 'Designated' or 'Inscribed' (proposed,
'Not Reported', adopted and established dropped, as WDPA guidance and D-133
lead instruction). UNESCO-MAB Biosphere Reserves are dropped, as in
Protected Planet coverage statistics: their buffer and transition zones are
not protected. Point-only records are dropped (no buffering by REP_AREA).

Two shares per 0.02 deg pixel, from 0.002 deg sub-cells (10 x 10):
  pa_all   any kept protected area
  pa_iucn  kept areas with an IUCN category I-VI (the ESMAP layer's scope)
The extra exclusion beyond ESMAP's IUCN layer, as a share of what ESMAP left,
is  add = (pa_all - pa_iucn) / (1 - pa_iucn), so that onshore
new = old x (1 - add). Offshore eligibility had no protected-area layer, so
offshore new = old x (1 - pa_all).

Raw WDPA data is not redistributed; only these derived shares are kept.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

from . import common as C

KEEP_STATUS = ("Designated", "Inscribed")
IUCN_CATS = ("Ia", "Ib", "II", "III", "IV", "V", "VI")
SUB = 10
STRIP_ROWS = 50          # working-grid rows per strip (1 deg)


def load_polygons(wdpa_dir: Path):
    import geopandas as gpd
    import pandas as pd
    parts = sorted(wdpa_dir.rglob("*polygons.shp"))
    if not parts:
        raise SystemExit(f"no WDPA polygon shapefiles under {wdpa_dir}")
    cols = ["SITE_ID", "STATUS", "IUCN_CAT", "DESIG_ENG", "REALM", "geometry"]
    g = pd.concat([gpd.read_file(p, columns=cols[:-1]) for p in parts], ignore_index=True)
    n0 = len(g)
    g = g[g["STATUS"].isin(KEEP_STATUS) & ~g["DESIG_ENG"].fillna("").str.contains("UNESCO-MAB Biosphere")]
    g["iucn"] = g["IUCN_CAT"].isin(IUCN_CATS)
    print(f"WDPA polygons {n0:,} -> kept {len(g):,} ({len(parts)} shapefiles)", flush=True)
    return g


def build(wdpa_dir: Path, out: Path | None = None) -> Path:
    from rasterio import features
    from rasterio.transform import from_origin
    out = C.guard_write(out or C.CACHE / "pa_share_002deg.npz")
    if out.exists():
        return out
    C.guard_disk()
    S, G = C.import_siting()
    px = C.load_pixels()
    rows_needed = np.unique(np.concatenate([px["on_flat"] // G.GRID_WIDTH, px["off_flat"] // G.GRID_WIDTH]))
    strips = np.unique(rows_needed // STRIP_ROWS)
    del px
    g = load_polygons(wdpa_dir)
    sidx = g.sindex
    pa_all = np.zeros((G.GRID_HEIGHT, G.GRID_WIDTH), dtype="uint8")
    pa_iucn = np.zeros_like(pa_all)
    res = G.GRID_RES / SUB
    t0 = time.time()
    for k, s in enumerate(strips):
        r0 = s * STRIP_ROWS
        north = G.GRID_NORTH - r0 * G.GRID_RES
        south = north - STRIP_ROWS * G.GRID_RES
        from shapely.geometry import box
        hits = sidx.query(box(-180, south, 180, north))
        if hits.size == 0:
            continue
        sub = g.iloc[hits]
        tr = from_origin(G.GRID_WEST, north, res, res)
        shape = (STRIP_ROWS * SUB, G.GRID_WIDTH * SUB)
        for arr, sel in ((pa_all, np.ones(len(sub), bool)), (pa_iucn, sub["iucn"].to_numpy())):
            if not sel.any():
                continue
            m = features.rasterize(((geom, 1) for geom in sub.geometry[sel]), out_shape=shape,
                                   transform=tr, fill=0, dtype="uint8")
            frac = m.reshape(STRIP_ROWS, SUB, G.GRID_WIDTH, SUB).mean(axis=(1, 3), dtype="float32")
            arr[r0:r0 + STRIP_ROWS] = np.rint(frac * 100).astype("uint8")
        if k % 10 == 0:
            print(f"  strip {k+1}/{strips.size} ({north:.0f} N), {len(sub):,} polygons, {time.time()-t0:.0f}s", flush=True)
    np.savez_compressed(out, pa_all=pa_all, pa_iucn=pa_iucn)
    print(f"PA shares written in {time.time()-t0:.0f}s -> {out}")
    return out
