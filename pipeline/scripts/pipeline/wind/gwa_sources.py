"""Global Wind Atlas 4 source definitions and the coarse working grid.

GWA4 (DTU, June 2025) is published as global Cloud-Optimised GeoTIFFs on DTU Data
(Figshare article 28955267, CC BY 4.0). Each file is 6-16 GB at 0.0025 deg
(~250 m) with eight overview levels, and DTU's store answers HTTP range
requests, so we never download a whole layer: we read the level-8 overview
(0.02 deg, ~2.2 km) once per layer and cache it locally.

Why 2.2 km rather than 250 m: the atlas asks whether a *wind farm* could be
built in a region, not whether one 250 m pixel is windy. A 2 km average is a
closer analogue of a farm footprint and avoids single-pixel cherry-picking.

Citation: Davis, N.N. et al. (2023) The Global Wind Atlas: A high-resolution
dataset of climatologies and associated web-based application. BAMS 104(8).
Data: https://doi.org/10.11583/DTU.28955267 (CC BY 4.0).
"""

from __future__ import annotations

FIGSHARE_ARTICLE = 28955267
BASE = "https://ndownloader.figshare.com/files"

# file id -> logical layer name
GWA_FILES = {
    "cf_iec1_100m": 54454331,
    "cf_iec2_100m": 54458105,
    "cf_iec3_100m": 54458897,
    "cf_offshore_150m": 54461216,
    "wind_speed_100m": 54328562,
    "air_density_100m": 54304652,
    "rix": 54302798,
}

# GWA4 turbine classes at 100 m hub height (rotor diameters from the DTU record).
IEC_CLASSES = {
    1: {"layer": "cf_iec1_100m", "rotor_m": 117, "rated_mw": 4.2, "hub_m": 100},
    2: {"layer": "cf_iec2_100m", "rotor_m": 136, "rated_mw": 4.2, "hub_m": 100},
    3: {"layer": "cf_iec3_100m", "rotor_m": 150, "rated_mw": 4.2, "hub_m": 100},
}
# Offshore reference turbine matching cf_offshore_cog_150m.
OFFSHORE_TURBINE = {"rotor_m": 150, "rated_mw": 4.2, "hub_m": 150}

# Class selection by GWA long-run mean wind speed at 100 m (m/s).
# IEC 1 = high wind, IEC 3 = low wind. Thresholds follow common practice.
IEC_SPEED_BREAKS = (7.5, 8.5)  # <=7.5 -> class 3; <=8.5 -> class 2; else class 1


def url_for(layer: str) -> str:
    if layer not in GWA_FILES:
        raise KeyError(f"unknown GWA layer {layer!r}; have {sorted(GWA_FILES)}")
    return f"/vsicurl/{BASE}/{GWA_FILES[layer]}"


# ---------------------------------------------------------------------------
# Working grid: global 0.02 deg, exactly GWA overview level 8 within the GWA
# extent, extended to full -90..90 so every other raster can be aligned to it.
# ---------------------------------------------------------------------------
GRID_RES = 0.02
GRID_WIDTH = 18000       # 360 / 0.02
GRID_HEIGHT = 9000       # 180 / 0.02
GRID_WEST = -180.0
GRID_NORTH = 90.0

# GWA4 native extent (read from the COG metadata): -180,-64,180,80
GWA_NORTH = 80.0
GWA_SOUTH = -64.0


def grid_transform():
    from rasterio.transform import from_origin

    return from_origin(GRID_WEST, GRID_NORTH, GRID_RES, GRID_RES)


def gwa_row_slice() -> tuple[int, int]:
    """Rows of the global working grid covered by the GWA extent."""
    top = int(round((GRID_NORTH - GWA_NORTH) / GRID_RES))
    bottom = int(round((GRID_NORTH - GWA_SOUTH) / GRID_RES))
    return top, bottom


# Scaling used when caching layers as compact integer rasters.
SCALES = {
    "cf": (10000, "uint16"),        # capacity factor 0-1 -> 0-10000
    "speed": (100, "uint16"),       # m/s -> x100
    "density": (1000, "uint16"),    # kg/m3 -> x1000
    "rix": (100, "uint16"),         # per cent -> x100
}
NODATA_U16 = 65535
