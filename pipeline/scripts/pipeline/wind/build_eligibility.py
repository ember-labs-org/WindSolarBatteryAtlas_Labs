"""Build onshore and offshore eligibility layers on the 0.02 deg working grid.

Onshore. We reuse the World Bank / ESMAP "Global PV Power Potential" global
masking layers (30 arc-second, CC BY 4.0, already in input_data), but with a
wind-appropriate selection rather than the solar one. Wind turbines coexist with
cropland and can be built in forest, and remoteness is not a disqualifier, so
only these are excluded by default:

    built-up areas, protected areas with an IUCN status, water bodies
    (including a 2 km buffer), and severe terrain (elevation range > 300 m
    within the pixel).

--exclude-forest and --exclude-cropland add the other two layers for sensitivity
testing.

Offshore. Eligible sea is: below sea level, water depth <= 60 m (fixed-bottom),
and at least 10 km from shore. The 200 km limit is implicit because the Global
Wind Atlas offshore layer is only defined that far out. Bathymetry is ETOPO 2022
(60 arc-second, NOAA, public domain). Area between 60 m and 1,000 m deep is
recorded separately as floating potential but is not simulated.

Outputs (workspace/input_data/wind/):
    eligible_onshore_002deg.tif   uint8 0-100, per cent of the pixel usable
    eligible_offshore_002deg.tif  uint8 0-100
    floating_offshore_002deg.tif  uint8 0-100
    land_002deg.tif               uint8 0/1 land mask from ETOPO
    depth_002deg.tif              int16 metres below sea level (positive down)

Usage:
    cd workspace && python3 -m scripts.pipeline.wind.build_eligibility \
        --etopo /tmp/etopo60.nc --wb-masks <path to the ESMAP masks folder>
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject
from scipy import ndimage

from scripts.pipeline.config import INPUTS_DIR
from scripts.pipeline.wind import gwa_sources as G

WIND_INPUTS = INPUTS_DIR / "wind"

# 1 in these rasters means the feature is present, so the pixel is excluded.
WIND_EXCLUDE_DEFAULT = [
    "bulit-up_over50_mask.tif",                      # sic, the file is misspelled upstream
    "protected-areas-with-iucn-status_mask.tif",
    "waterbodies_inside-buffer2km_mask.tif",
    "terrain_elevation-range-over300m-land_mask.tif",
]
OPTIONAL = {
    "forest": "forest-compact_mask.tif",
    "cropland": "landcover_cropland_mask.tif",
}

MAX_FIXED_DEPTH_M = 60.0
MAX_FLOATING_DEPTH_M = 1000.0
MIN_SHORE_DISTANCE_KM = 10.0


def _target_profile(dtype: str, nodata) -> dict:
    return {
        "driver": "GTiff",
        "width": G.GRID_WIDTH,
        "height": G.GRID_HEIGHT,
        "count": 1,
        "dtype": dtype,
        "crs": "EPSG:4326",
        "transform": G.grid_transform(),
        "nodata": nodata,
        "compress": "zstd",
        "zstd_level": 9,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
        "BIGTIFF": "IF_SAFER",
    }


def _write(path: Path, arr: np.ndarray, dtype: str, nodata) -> None:
    with rasterio.open(path, "w", **_target_profile(dtype, nodata)) as dst:
        dst.write(arr.astype(dtype), 1)
    print(f"  wrote {path.name}  ({path.stat().st_size/1e6:.0f} MB)")


def _resample_fraction(src_path: Path) -> np.ndarray:
    """Average a 0/1 global mask onto the working grid -> fraction 0..1."""
    out = np.zeros((G.GRID_HEIGHT, G.GRID_WIDTH), dtype="float32")
    with rasterio.open(src_path) as src:
        band = src.read(1).astype("float32")
        if src.nodata is not None and np.isfinite(src.nodata):
            band[band == src.nodata] = 0.0
        band[~np.isfinite(band)] = 0.0
        band[band > 1.0] = 0.0  # guard against 255 fill values
        reproject(
            source=band,
            destination=out,
            src_transform=src.transform,
            src_crs=src.crs or "EPSG:4326",
            dst_transform=G.grid_transform(),
            dst_crs="EPSG:4326",
            resampling=Resampling.average,
            src_nodata=None,
            dst_nodata=0.0,
        )
    return np.clip(out, 0.0, 1.0)


def build(etopo: Path, wb_masks: Path, extra: list[str]) -> None:
    WIND_INPUTS.mkdir(parents=True, exist_ok=True)

    # ---------------- onshore ----------------
    names = list(WIND_EXCLUDE_DEFAULT) + [OPTIONAL[k] for k in extra]
    print(f"Onshore exclusions ({len(names)} layers):")
    excluded = np.zeros((G.GRID_HEIGHT, G.GRID_WIDTH), dtype="float32")
    for name in names:
        p = wb_masks / name
        if not p.exists():
            raise SystemExit(f"missing mask: {p}")
        frac = _resample_fraction(p)
        print(f"  {name:52s} mean {frac.mean()*100:5.2f}%")
        # Union of independent masks, approximated as a probabilistic union so
        # overlapping layers do not push the excluded fraction above 1.
        excluded = excluded + frac - excluded * frac
    onshore = np.rint((1.0 - excluded) * 100).astype("uint8")

    # ---------------- bathymetry / land ----------------
    print("Bathymetry (ETOPO 2022 60 arc-second):")
    elev = np.zeros((G.GRID_HEIGHT, G.GRID_WIDTH), dtype="float32")
    with rasterio.open(etopo) as src:
        band = src.read(1).astype("float32")
        band[band == src.nodata] = np.nan
        reproject(
            source=band,
            destination=elev,
            src_transform=src.transform,
            src_crs=src.crs or "EPSG:4326",
            dst_transform=G.grid_transform(),
            dst_crs="EPSG:4326",
            resampling=Resampling.average,
            src_nodata=np.nan,
            dst_nodata=np.nan,
        )
    land = (elev >= 0) & np.isfinite(elev)
    depth = np.where(~land & np.isfinite(elev), -elev, 0.0)  # positive metres down
    print(f"  land fraction {land.mean()*100:.1f}%")

    # Distance from shore, in kilometres, on the sea side only.
    # The grid is 0.02 deg; use the latitude-dependent cell size for accuracy.
    print("Distance to shore:")
    dist_px = ndimage.distance_transform_edt(~land)
    lat = G.GRID_NORTH - (np.arange(G.GRID_HEIGHT) + 0.5) * G.GRID_RES
    km_per_px_lat = G.GRID_RES * 111.32
    # Distance is measured in pixel units on an equirectangular grid, so scale by
    # the mean of the north-south and east-west pixel sizes at that latitude.
    km_per_px_lon = km_per_px_lat * np.cos(np.deg2rad(lat))
    scale = np.sqrt(km_per_px_lat * np.clip(km_per_px_lon, 1e-3, None))[:, None]
    dist_km = dist_px * scale

    offshore_ok = (
        (~land)
        & (depth > 0)
        & (depth <= MAX_FIXED_DEPTH_M)
        & (dist_km >= MIN_SHORE_DISTANCE_KM)
    )
    floating_ok = (
        (~land)
        & (depth > MAX_FIXED_DEPTH_M)
        & (depth <= MAX_FLOATING_DEPTH_M)
        & (dist_km >= MIN_SHORE_DISTANCE_KM)
    )
    print(f"  fixed-bottom eligible {offshore_ok.mean()*100:.2f}% of the globe")
    print(f"  floating eligible     {floating_ok.mean()*100:.2f}%")

    # Onshore eligibility only means anything on land.
    onshore = np.where(land, onshore, 0).astype("uint8")

    _write(WIND_INPUTS / "eligible_onshore_002deg.tif", onshore, "uint8", 255)
    _write(WIND_INPUTS / "eligible_offshore_002deg.tif", offshore_ok * 100, "uint8", 255)
    _write(WIND_INPUTS / "floating_offshore_002deg.tif", floating_ok * 100, "uint8", 255)
    _write(WIND_INPUTS / "land_002deg.tif", land.astype("uint8"), "uint8", 255)
    _write(
        WIND_INPUTS / "depth_002deg.tif",
        np.clip(depth, 0, 32000).astype("int16"),
        "int16",
        -32768,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--etopo", type=Path, required=True)
    ap.add_argument("--wb-masks", type=Path, required=True)
    ap.add_argument(
        "--exclude", nargs="*", default=[], choices=sorted(OPTIONAL),
        help="additional exclusions: forest, cropland",
    )
    args = ap.parse_args()
    build(args.etopo, args.wb_masks, args.exclude)


if __name__ == "__main__":
    main()
