"""T067 fix 1 (T065-V-1): a land mask that does not call land below sea level 'sea'.

build_eligibility.py set land = ETOPO elevation >= 0, so the Dutch polders, the
Caspian Depression, Qattara, Chott Melrhir, Lake Eyre, the Imperial Valley and
other dry depressions counted as sea: zero onshore eligibility, and offshore
wind sited on dry land. This module rebuilds the eligibility rasters with:

  land  = ETOPO elevation >= 0 (unchanged), plus every pixel below sea level
          whose centre lies in a Natural Earth 10 m land polygon, outside the
          Natural Earth 10 m lakes, and which the ESMAP/Solargis water-body layer
          (water plus 2 km buffer) covers for less than half the pixel.
          ETOPO keeps the coastline: Natural Earth (1:10 m, ~1 km generalisation)
          and ESMAP must both say "land" before a below-sea-level pixel flips, and
          A flipped area must also be at least MIN_FLIP_PX pixels (8-connected,
          about 30-45 km2): ETOPO's 60" grid averaged to 0.02 deg cannot resolve
          smaller below-sea-level land, and the small groups are mixed coastal
          pixels whose mean elevation dips below zero (29,000 pixels in ~900
          regions worldwide), not depressions. So ordinary coastlines are not
          redrawn; small polders under ~40 km2 stay as they were.
  lakes = Natural Earth 10 m lakes (IJsselmeer, Great Lakes, Ladoga, Salton
          Sea, Dead Sea, Lake Eyre, ...): neither onshore (ESMAP's water layer
          already excludes them) nor offshore. Lake-bed depths in ETOPO are
          measured from sea level, not the lake surface, so lake 'offshore'
          eligibility was an artefact; lake wind farms (Fryslan) are not modelled.
  sea   = everything else that is not land, i.e. the ocean and the Caspian Sea
          (Natural Earth leaves the Caspian out of both land and lakes).
  Caspian water depth is measured from its own surface, CASPIAN_SURFACE_M
          (-28 m), not from sea level: depth = ETOPO depth below sea level - 28.
  Antarctica (south of 60 S) and Greenland (Natural Earth 10 m admin-0 GRL) are
          left as they were: the atlas excludes them (T057, D-120), and their
          'below sea level' pixels are ice-sheet beds.
  Distance to shore is measured to the nearest non-sea pixel (land or lake), as
          before (ETOPO-land lakes were land before).

The ESMAP masks are the same files build_eligibility.py used (proved by
reproducing the shipped pre-T061 onshore raster bit for bit). Onshore
eligibility on new land is ESMAP's, then T061's PA and settlement layers are
applied with t061/eligibility.py's formula (proved by reproducing the T061
rasters bit for bit from the old pre-T061 rasters).

Outside the Caspian, offshore can only lose pixels (new land, lakes, closer
shore): off_new = off_old & sea & dist >= 10 km, which keeps the original float
depths' decisions. Inside the Caspian depth is recomputed from the int16 depth
raster (truncated metres; the 0 m and 60 m edges are within 1 m).

  python3 -I -m t067.landmask --run <run dir>     (from pipeline/scripts/pipeline/wind)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CASPIAN_SURFACE_M = -28.0
CASPIAN_BOX = dict(lon_min=45.0, lon_max=56.0, lat_min=35.5, lat_max=48.0)
MIN_SHORE_KM = 10.0
MIN_FLIP_PX = 10
MAX_FIXED_M = 60.0
MAX_FLOAT_M = 1000.0
ESMAP = ["bulit-up_over50_mask.tif", "protected-areas-with-iucn-status_mask.tif",
         "waterbodies_inside-buffer2km_mask.tif", "terrain_elevation-range-over300m-land_mask.tif"]


def grid():
    sys.path.insert(0, str(HERE.parents[3]))   # pipeline/
    os.environ.setdefault("ATLAS_WORKSPACE_DIR", str(Path.home() / "wind-atlas-T061" / "ws_mirror"))
    from scripts.pipeline.wind import gwa_sources as G
    return G


def read(p):
    import rasterio
    with rasterio.open(p) as s:
        return s.read(1)


def esmap_layers(masks: Path):
    """Each ESMAP layer averaged onto the working grid (build_eligibility._resample_fraction)."""
    sys.path.insert(0, str(HERE.parents[3]))
    from scripts.pipeline.wind.build_eligibility import _resample_fraction
    out = {}
    for name in ESMAP:
        out[name] = _resample_fraction(masks / name)
    return out


def excluded_union(fr):
    ex = None
    for name in ESMAP:        # same order and arithmetic as build_eligibility.build
        f = fr[name]
        ex = np.zeros_like(f) if ex is None else ex
        ex = ex + f - ex * f
    return ex


def shore_km(nonsea, G):
    """build_eligibility's distance: EDT in pixels x sqrt(km_lat x km_lon) per row."""
    from scipy import ndimage
    d = ndimage.distance_transform_edt(~nonsea)
    lat = G.GRID_NORTH - (np.arange(G.GRID_HEIGHT) + 0.5) * G.GRID_RES
    kl = G.GRID_RES * 111.32
    scale = np.sqrt(kl * np.clip(kl * np.cos(np.deg2rad(lat)), 1e-3, None))[:, None]
    return d * scale


def rasterize(shp, G):
    import geopandas as gpd
    from rasterio import features
    g = gpd.read_file(shp)
    return features.rasterize(((geom, 1) for geom in g.geometry), out_shape=(G.GRID_HEIGHT, G.GRID_WIDTH),
                              transform=G.grid_transform(), fill=0, dtype="uint8").astype(bool)


def pa_layers(pa_npz, missing_strips, wdpa_dir, G, log):
    """T061's PA shares, plus any 1-deg strip T061 did not compute (it covered only
    rows holding eligible pixels) computed now with t061/pa.py's selection and
    arithmetic, reading only the WDPA polygons that touch the strip."""
    pa = dict(np.load(pa_npz))
    if not missing_strips:
        return pa
    import geopandas as gpd
    import pandas as pd
    from rasterio import features
    from rasterio.transform import from_origin
    from t061 import pa as P
    parts = sorted(Path(wdpa_dir).rglob("*polygons.shp"))
    for s in missing_strips:
        r0 = s * P.STRIP_ROWS
        north = G.GRID_NORTH - r0 * G.GRID_RES
        south = north - P.STRIP_ROWS * G.GRID_RES
        g = pd.concat([gpd.read_file(p, bbox=(-180, south, 180, north),
                                     columns=["SITE_ID", "STATUS", "IUCN_CAT", "DESIG_ENG", "REALM"]) for p in parts],
                      ignore_index=True)
        g = g[g["STATUS"].isin(P.KEEP_STATUS) & ~g["DESIG_ENG"].fillna("").str.contains("UNESCO-MAB Biosphere")]
        iucn = g["IUCN_CAT"].isin(P.IUCN_CATS).to_numpy()
        res = G.GRID_RES / P.SUB
        tr = from_origin(G.GRID_WEST, north, res, res)
        shape = (P.STRIP_ROWS * P.SUB, G.GRID_WIDTH * P.SUB)
        for key, sel in (("pa_all", np.ones(len(g), bool)), ("pa_iucn", iucn)):
            if not sel.any():
                continue
            m = features.rasterize(((geom, 1) for geom in g.geometry[sel]), out_shape=shape,
                                   transform=tr, fill=0, dtype="uint8")
            frac = m.reshape(P.STRIP_ROWS, P.SUB, G.GRID_WIDTH, P.SUB).mean(axis=(1, 3), dtype="float32")
            pa[key][r0:r0 + P.STRIP_ROWS] = np.rint(frac * 100).astype("uint8")
        log(f"  PA strip {north:.0f}-{south:.0f} N computed now: {len(g)} WDPA polygons")
    return pa


def t061_transform(on_pre, off_pre, pa, sb):
    """t061/eligibility.build, applied to given pre-T061 rasters (same expressions)."""
    if not isinstance(pa, dict):
        pa = np.load(pa)
    a = pa["pa_all"].astype("float32") / 100
    i = pa["pa_iucn"].astype("float32") / 100
    add = np.clip(np.divide(a - i, 1 - i, out=np.ones_like(a), where=i < 1), 0, 1)
    del i
    on = on_pre.astype("float32") * (1 - add) * (1 - sb)
    del add
    on = np.minimum(on, 100.0 * (1 - a))
    on_new = np.where(on_pre > 0, np.rint(on), 0).astype("uint8")
    del on
    off_new = np.rint(off_pre.astype("float32") * (1 - a)).astype("uint8")
    return on_new, off_new


def setback_layer(t061_cache: Path, need: np.ndarray, ghsl: Path, G, log):
    """T061 setback layer (10% built, 0 m) with any 1-deg block that holds new
    eligible land but was not processed in T061 (it processed only blocks with
    eligible in-zone onshore pixels) computed now with exclusions._block."""
    sb_t061 = np.load(t061_cache / "setback_excl_pct_002deg.npz")["excl_pct"][0, 0]
    sb = sb_t061.copy()
    px = np.load(t061_cache / "pixels_v1.npz")
    bpx = 50
    flat = px["on_flat"]
    old_blocks = set(np.unique((flat // G.GRID_WIDTH // bpx) * 10_000 + (flat % G.GRID_WIDTH // bpx)).tolist())
    r, c = np.nonzero(need)
    new_blocks = sorted(set(np.unique((r // bpx) * 10_000 + (c // bpx)).tolist()) - old_blocks)
    log(f"setback: {len(old_blocks)} T061 blocks; {len(new_blocks)} new blocks with new eligible land")
    if new_blocks:
        from concurrent.futures import ProcessPoolExecutor
        os.environ.setdefault("T061_RUN_DIR", str(t061_cache.parent))
        from t061 import exclusions as X
        jobs = [(str(ghsl), b // 10_000, b % 10_000, bpx) for b in new_blocks]
        with ProcessPoolExecutor(max_workers=3) as ex:
            for br, bc, arr in ex.map(X._block, jobs, chunksize=4):
                sb[br * bpx:(br + 1) * bpx, bc * bpx:(bc + 1) * bpx] = arr[0, 0]
    # new values only where land is new: every other pixel keeps T061's layer exactly
    sb = np.where(need, sb, sb_t061)
    return sb.astype("float32") / 100, new_blocks


def write(path, arr, dtype, nodata):
    import rasterio
    sys.path.insert(0, str(HERE.parents[3]))
    from scripts.pipeline.wind.build_eligibility import _target_profile
    with rasterio.open(path, "w", **_target_profile(dtype, nodata)) as d:
        d.write(arr.astype(dtype), 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", type=Path, default=Path.home() / "wind-atlas-T067")
    ap.add_argument("--t061", type=Path, default=Path.home() / "wind-atlas-T061")
    ap.add_argument("--admin0", type=Path, default=Path.home() / "wind-atlas-T061/downloads/naturalearth/"
                    "ne_10m_admin_0_countries/ne_10m_admin_0_countries.shp")
    a = ap.parse_args()
    G = grid()
    R, T61 = a.run, a.t061
    inp, ne = R / "inputs", R / "downloads" / "naturalearth"
    out_ws = R / "ws_T067" / "input_data" / "wind"
    out_ws.mkdir(parents=True, exist_ok=True)
    res_dir = R / "results"
    lines = []

    def log(s):
        print(s, flush=True)
        lines.append(s)

    t0 = time.time()
    land_old = read(inp / "ws_wind" / "land_002deg.tif") == 1
    depth = read(inp / "ws_wind" / "depth_002deg.tif").astype("float32")
    on_old = read(inp / "ws_wind" / "eligible_onshore_002deg.tif")
    off_old = read(inp / "ws_wind" / "eligible_offshore_002deg.tif")
    fl_old = read(inp / "ws_wind" / "floating_offshore_002deg.tif")

    # ---- proof A: the ESMAP masks are the ones build_eligibility used
    fr = esmap_layers(inp / "esmap_masks")
    water = fr["waterbodies_inside-buffer2km_mask.tif"].copy()
    ex = excluded_union(fr)
    del fr
    on_pre_all = np.rint((1.0 - ex) * 100).astype("uint8")
    del ex
    rep = np.where(land_old, on_pre_all, 0).astype("uint8")
    nd = int((rep != on_old).sum())
    log(f"proof A: ESMAP masks + ETOPO land reproduce shipped pre-T061 onshore raster: {nd} pixels differ")
    if nd:
        raise SystemExit("ESMAP masks do not reproduce the shipped onshore raster")
    del rep

    # ---- proof B: t061 transform reproduces the T061 rasters
    t61_on = read(T61 / "ws_D/input_data/wind/eligible_onshore_002deg.tif")
    t61_off = read(T61 / "ws_D/input_data/wind/eligible_offshore_002deg.tif")
    sb_old = np.load(T61 / "cache/setback_excl_pct_002deg.npz")["excl_pct"][0, 0].astype("float32") / 100
    o1, o2 = t061_transform(on_old, off_old, T61 / "cache/pa_share_002deg.npz", sb_old)
    nb = (int((o1 != t61_on).sum()), int((o2 != t61_off).sum()))
    log(f"proof B: T061 formula on the old rasters reproduces ws_D on/off: {nb} pixels differ")
    if any(nb):
        raise SystemExit("T061 transform not reproduced")
    del o1, o2, sb_old

    # ---- new land / lakes / sea
    neland = rasterize(ne / "ne_10m_land/ne_10m_land.shp", G)
    lake = rasterize(ne / "ne_10m_lakes/ne_10m_lakes.shp", G)
    flip = (~land_old) & neland & ~lake & (water < 0.5)
    del water, neland
    import geopandas as gpd
    from rasterio import features
    adm = gpd.read_file(a.admin0)
    ice = features.rasterize(((g, 1) for g in adm[adm.ADM0_A3 == "GRL"].geometry),
                             out_shape=flip.shape, transform=G.grid_transform(), fill=0, dtype="uint8").astype(bool)
    ice[int(round((G.GRID_NORTH + 60.0) / G.GRID_RES)):] = True          # south of 60 S
    flip &= ~ice
    del ice
    from scipy import ndimage
    lab, _ = ndimage.label(flip, structure=np.ones((3, 3), bool))
    size = np.bincount(lab.ravel())
    size[0] = 0
    flip = size[lab] >= MIN_FLIP_PX
    del lab, size
    land = land_old | flip
    sea = ~land & ~lake
    lat = (G.GRID_NORTH - (np.arange(G.GRID_HEIGHT) + 0.5) * G.GRID_RES)[:, None]
    lon = (G.GRID_WEST + (np.arange(G.GRID_WIDTH) + 0.5) * G.GRID_RES)[None, :]
    box = ((lat >= CASPIAN_BOX["lat_min"]) & (lat <= CASPIAN_BOX["lat_max"])
           & (lon >= CASPIAN_BOX["lon_min"]) & (lon <= CASPIAN_BOX["lon_max"]))
    casp = sea & box
    del box
    log(f"flip to land: {int(flip.sum()):,} px; lake px that were ETOPO sea: {int((lake & ~land_old).sum()):,}; "
        f"Caspian px: {int(casp.sum()):,}")
    dist = shore_km(~sea, G)
    d_c = depth - (-CASPIAN_SURFACE_M)                  # Caspian water depth from its surface
    in_dist = dist >= MIN_SHORE_KM
    off_pre = np.where(casp, ((d_c > 0) & (d_c <= MAX_FIXED_M) & in_dist) * 100,
                       np.where(sea & in_dist, off_old, 0)).astype("uint8")
    fl_pre = np.where(casp, ((d_c > MAX_FIXED_M) & (d_c <= MAX_FLOAT_M) & in_dist) * 100,
                      np.where(sea & in_dist, fl_old, 0)).astype("uint8")
    # sanity: what the Caspian looked like under the old rule
    log(f"Caspian offshore px old {int(((off_old > 0) & casp).sum()):,} -> new {int((off_pre > 0)[casp].sum()):,}; "
        f"floating old {int(((fl_old > 0) & casp).sum()):,} -> new {int((fl_pre > 0)[casp].sum()):,}")
    del dist, in_dist
    on_pre = np.where(land, on_pre_all, 0).astype("uint8")
    del on_pre_all
    if not np.array_equal(on_pre[~flip], on_old[~flip]):
        raise SystemExit("onshore changed outside flipped pixels")
    depth_new = np.where(land | lake, 0.0, np.where(casp, np.clip(d_c, 0, None), depth))
    del d_c

    # ---- T061 layers
    ghsl = T61 / "downloads/ghsl/extracted/GHS_BUILT_S_E2020_GLOBE_R2023A_4326_3ss_V1_0.tif"
    sb, new_blocks = setback_layer(T61 / "cache", (on_pre > 0) & flip, ghsl, G, log)
    pa = np.load(T61 / "cache/pa_share_002deg.npz")
    px = np.load(T61 / "cache/pixels_v1.npz")
    rows_done = np.unique(np.concatenate([px["on_flat"] // G.GRID_WIDTH, px["off_flat"] // G.GRID_WIDTH]) // 50)
    need_rows = np.unique(np.nonzero(((on_pre > 0) & flip) | ((off_pre > 0) & (off_old == 0)))[0] // 50)
    missing = sorted(set(need_rows.tolist()) - set(rows_done.tolist()))
    log(f"PA strips: {len(missing)} 1-deg strips with new eligible pixels not covered by T061 "
        f"({[90 - s for s in missing]} N top edges)")
    del pa, px
    pa_new = pa_layers(T61 / "cache/pa_share_002deg.npz", missing, T61 / "downloads/wdpa/extracted", G, log)
    if missing:
        # T061 skipped these strips because they held no eligible *in-zone* pixel; use the
        # new shares only at newly eligible pixels, so every other pixel keeps T061's value
        old = np.load(T61 / "cache/pa_share_002deg.npz")
        newpx = flip | ((off_pre > 0) & (off_old == 0))
        for k in ("pa_all", "pa_iucn"):
            pa_new[k] = np.where(newpx, pa_new[k], old[k])
        del old, newpx
        assert np.array_equal(t061_transform(on_old, off_old, pa_new, sb)[0], t61_on)
    on_new, off_new = t061_transform(on_pre, off_pre, pa_new, sb)
    del sb, pa_new

    log(f"final onshore px changed vs T061: {int((on_new != t61_on).sum()):,}; "
        f"offshore px changed: {int((off_new != t61_off).sum()):,}; floating px changed: {int((fl_pre != fl_old).sum()):,}")
    if not np.array_equal(on_new[~flip], t61_on[~flip]):
        raise SystemExit("final onshore changed outside flipped pixels")

    write(out_ws / "eligible_onshore_002deg.tif", on_new, "uint8", 255)
    write(out_ws / "eligible_offshore_002deg.tif", off_new, "uint8", 255)
    write(out_ws / "floating_offshore_002deg.tif", fl_pre, "uint8", 255)
    write(out_ws / "land_002deg.tif", land.astype("uint8"), "uint8", 255)
    write(out_ws / "depth_002deg.tif", np.clip(depth_new, 0, 32000).astype("int16"), "int16", -32768)
    np.savez_compressed(R / "cache" / "landmask_diff.npz", flip=flip, lake=lake, casp=casp,
                        on_old=t61_on, on_new=on_new, off_old=t61_off, off_new=off_new,
                        fl_old=fl_old, fl_new=fl_pre)
    log(f"done in {time.time()-t0:.0f}s; setback blocks computed now: {len(new_blocks)}")
    (res_dir / "landmask_build.txt").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
