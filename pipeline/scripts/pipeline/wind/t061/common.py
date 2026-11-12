"""T061 shared helpers: paths, write guards and the per-pixel table.

The per-pixel table holds every eligible in-zone pixel of the 0.02 deg grid with
its zone, net CF and area weight, built with site_selection.py's own code and
inputs, so any share-of-land statistic can be computed without re-reading the
GWA rasters. It is cached under the run directory; the workspace is only read.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np

WORKSPACE = Path(os.environ.get(
    "T061_WORKSPACE",
    "/Users/daanwalter/Library/CloudStorage/OneDrive-Ember 2/ember-futures - Documents/"
    "03 Research/2026/97 Ideas/WIND ATLAS/SolarWindBatteryAtlas/workspace"))
RUN_DIR = Path(os.environ.get("T061_RUN_DIR", Path.home() / "wind-atlas-T061"))
REPO = Path(os.environ.get("T061_REPO", Path(__file__).resolve().parents[5]))
CACHE = RUN_DIR / "cache"
CLOUD = (Path.home() / "Library" / "CloudStorage").resolve()
LOSSES = 0.12


def guard_write(p: Path) -> Path:
    """Refuse any write target inside OneDrive / the workspace."""
    r = Path(p).resolve()
    if r.is_relative_to(CLOUD) or r.is_relative_to(WORKSPACE.resolve()):
        raise SystemExit(f"refusing to write under OneDrive/workspace: {r}")
    return r


def guard_disk(min_gb: float = 10.0) -> float:
    free = shutil.disk_usage(Path.home()).free / 1e9
    if free < min_gb:
        raise SystemExit(f"free disk {free:.1f} GB < {min_gb} GB: stop and report")
    return free


def import_siting():
    """Import the repo's site_selection / gwa_sources against the workspace (read only)."""
    os.environ.setdefault("ATLAS_WORKSPACE_DIR", str(WORKSPACE))
    os.environ.setdefault("ATLAS_DOCS_DATA_DIR", str(RUN_DIR / "docs_data_unused"))
    sys.dont_write_bytecode = True
    p = str(REPO / "pipeline")
    if p not in sys.path:
        sys.path.insert(0, p)
    from scripts.pipeline.wind import site_selection as S, gwa_sources as G
    return S, G


def build_pixels(force: bool = False) -> Path:
    """Per-pixel table, onshore and offshore, as site_selection.run() builds it."""
    out = guard_write(CACHE / "pixels_v1.npz")
    if out.exists() and not force:
        return out
    guard_disk()
    import rasterio
    from rasterio import features
    from scipy.spatial import cKDTree
    import pandas as pd
    S, G = import_siting()
    t0 = time.time()
    points = pd.read_csv(S.POINTS_CSV)
    id_to_idx = {int(v): i for i, v in enumerate(points["location_id"].to_numpy())}
    speed = S._u16_to_float(S._read_u16("gwa4_wind_speed_100m_002deg.tif"), 100)
    cf = np.full_like(speed, np.nan)
    b1, b2 = G.IEC_SPEED_BREAKS
    for cls, lo, hi in ((3, -np.inf, b1), (2, b1, b2), (1, b2, np.inf)):
        band = S._u16_to_float(S._read_u16(f"gwa4_{G.IEC_CLASSES[cls]['layer']}_002deg.tif"), 10000)
        sel = (speed > lo) & (speed <= hi) & np.isfinite(band)
        cf[sel] = band[sel]
        del band
    del speed
    cf_off = S._u16_to_float(S._read_u16("gwa4_cf_offshore_150m_002deg.tif"), 10000)
    with rasterio.open(S.WIND_INPUTS / "eligible_onshore_002deg.tif") as s:
        elig_on = s.read(1)
    with rasterio.open(S.WIND_INPUTS / "eligible_offshore_002deg.tif") as s:
        elig_off = s.read(1)
    area = S.pixel_area_km2()
    with open(S.CELLS_GEOJSON) as fh:
        gj = json.load(fh)
    shapes = [(f["geometry"], id_to_idx[int(f["properties"]["location_id"])] + 1)
              for f in gj["features"] if int(f["properties"]["location_id"]) in id_to_idx]
    zone_on = features.rasterize(shapes, out_shape=(G.GRID_HEIGHT, G.GRID_WIDTH),
                                 transform=G.grid_transform(), fill=0, dtype="int32",
                                 all_touched=False)
    zone_off = np.zeros_like(zone_on)
    rows, cols = np.nonzero(elig_off > 0)
    lat = G.GRID_NORTH - (rows + 0.5) * G.GRID_RES
    lon = G.GRID_WEST + (cols + 0.5) * G.GRID_RES
    _, nn = cKDTree(points[["longitude", "latitude"]].to_numpy()).query(
        np.column_stack([lon, lat]), k=1, workers=4)
    zone_off[rows, cols] = nn + 1
    keep = 1.0 - LOSSES
    res = {}
    for tag, zone, layer, elig in (("on", zone_on, cf, elig_on), ("off", zone_off, cf_off, elig_off)):
        m = (zone > 0) & (elig > 0) & np.isfinite(layer)
        flat = np.flatnonzero(m).astype("int64")
        res[f"{tag}_flat"] = flat
        res[f"{tag}_zone"] = (zone.ravel()[flat] - 1).astype("int32")
        res[f"{tag}_cf"] = (layer.ravel()[flat] * keep).astype("float32")   # net, as site_selection
        res[f"{tag}_elig"] = (elig.ravel()[flat]).astype("uint8")          # per cent
        res[f"{tag}_pxarea"] = area[flat // G.GRID_WIDTH].astype("float32")
    # every land pixel inside an onshore zone (eligible or not), for exclusion maths
    res["zone_on_full"] = zone_on.astype("int16") if zone_on.max() < 32767 else zone_on
    np.savez(out, **res)
    print(f"pixel table written in {time.time()-t0:.0f}s: on {res['on_flat'].size:,} off {res['off_flat'].size:,}")
    return out


def load_pixels() -> dict:
    return dict(np.load(build_pixels()))


def weights(px: dict, tag: str, elig_pct: np.ndarray | None = None) -> np.ndarray:
    """Area weight = eligible share x pixel area, exactly as site_selection (float32)."""
    e = px[f"{tag}_elig"] if elig_pct is None else elig_pct
    return ((e.astype("float32") / 100.0) * px[f"{tag}_pxarea"]).astype("float32")


def share_mean_by_zone(zone, value, weight, n_zones, share, floor_km2=500.0):
    """Mean of `value` over the best max(share x total, floor) of weight in each zone
    (all of it if the zone has less than the floor); last pixel fractional."""
    order = np.lexsort((-value, zone))
    z, v = zone[order], value[order].astype("float64")
    w = weight[order].astype("float64")
    total = np.bincount(z, weights=w, minlength=n_zones)
    starts = np.zeros(n_zones + 1)
    starts[1:] = np.cumsum(total)
    above = np.cumsum(w) - w - starts[z]
    target = np.maximum(share * total, floor_km2)[z]
    take = np.clip(target - above, 0.0, w)
    num = np.bincount(z, weights=take * v, minlength=n_zones)
    den = np.bincount(z, weights=take, minlength=n_zones)
    return np.divide(num, den, out=np.full(n_zones, np.nan), where=den > 0), total


def pixel_country(ne_shp: Path | None = None) -> tuple[np.ndarray, list[str]]:
    """Country index per onshore pixel of the pixel table (Natural Earth 1:10m
    admin-0, public domain; ISO_A3_EH, else ADM0_A3). -1 = no country."""
    out = guard_write(CACHE / "pixel_country_on.npz")
    if out.exists():
        z = np.load(out, allow_pickle=False)
        return z["idx"], [str(s) for s in z["codes"]]
    import geopandas as gpd
    from rasterio import features
    S, G = import_siting()
    ne = gpd.read_file(ne_shp or RUN_DIR / "downloads/naturalearth/ne_10m_admin_0_countries/ne_10m_admin_0_countries.shp")
    code = [a if a not in ("-99", None) else b for a, b in zip(ne["ISO_A3_EH"], ne["ADM0_A3"])]
    codes = sorted(set(code))
    lut = {k: i + 1 for i, k in enumerate(codes)}
    ras = features.rasterize(((g, lut[c]) for g, c in zip(ne.geometry, code)),
                             out_shape=(G.GRID_HEIGHT, G.GRID_WIDTH), transform=G.grid_transform(),
                             fill=0, dtype="int16", all_touched=False)
    px = load_pixels()
    idx = ras.ravel()[px["on_flat"]].astype("int16") - 1
    np.savez(out, idx=idx, codes=np.array(codes))
    return idx, codes
