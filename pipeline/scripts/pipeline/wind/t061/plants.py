"""GEM operating wind units -> region index and GWA net CF at the plant pixel."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import common as C


def build(force: bool = False) -> pd.DataFrame:
    out = C.guard_write(C.CACHE / "gem_plants_t061.parquet")
    if out.exists() and not force:
        return pd.read_parquet(out)
    import rasterio
    from scipy.spatial import cKDTree
    import sys
    sys.path.insert(0, str(C.Path(__file__).resolve().parents[1]))
    import calibration as K
    S, G = C.import_siting()
    oc = pd.read_csv(S.OUTPUTS_DIR / "voronoi_overlapping_countries.csv")
    names = dict(zip(oc["country_name"], oc["country_iso3"]))
    g = K.gem_operating(C.CACHE / "gem_wind_units_sep2025.parquet", names)
    row = np.floor((G.GRID_NORTH - g["Latitude"].to_numpy()) / G.GRID_RES).astype(int).clip(0, G.GRID_HEIGHT - 1)
    col = np.floor((g["Longitude"].to_numpy() - G.GRID_WEST) / G.GRID_RES).astype(int).clip(0, G.GRID_WIDTH - 1)

    def window_vals(a):
        # value at the pixel, else the mean of finite values in the 3x3 window (coastal plants)
        v = a[row, col].astype("float64")
        miss = ~np.isfinite(v)
        if miss.any():
            acc = np.zeros(miss.sum()); cnt = np.zeros(miss.sum())
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    x = a[(row[miss] + dr).clip(0, G.GRID_HEIGHT - 1), (col[miss] + dc).clip(0, G.GRID_WIDTH - 1)]
                    ok = np.isfinite(x); acc[ok] += x[ok]; cnt[ok] += 1
            v[miss] = np.where(cnt > 0, acc / np.maximum(cnt, 1), np.nan)
        return v

    speed = S._u16_to_float(S._read_u16("gwa4_wind_speed_100m_002deg.tif"), 100)
    cf = np.full_like(speed, np.nan)
    b1, b2 = G.IEC_SPEED_BREAKS
    for cls, lo, hi in ((3, -np.inf, b1), (2, b1, b2), (1, b2, np.inf)):
        band = S._u16_to_float(S._read_u16(f"gwa4_{G.IEC_CLASSES[cls]['layer']}_002deg.tif"), 10000)
        sel = (speed > lo) & (speed <= hi) & np.isfinite(band)
        cf[sel] = band[sel]
        del band
    g["gwa_speed"] = window_vals(speed)
    del speed
    on_cf = window_vals(cf) * (1 - C.LOSSES)
    del cf
    off = S._u16_to_float(S._read_u16("gwa4_cf_offshore_150m_002deg.tif"), 10000)
    off_cf = window_vals(off) * (1 - C.LOSSES)
    del off
    g["plant_cf"] = np.where(g["surface"] == "on", on_cf, off_cf)
    px = C.load_pixels()
    zone_on = px["zone_on_full"]
    pts = pd.read_csv(S.POINTS_CSV)
    _, nn = cKDTree(pts[["longitude", "latitude"]].to_numpy()).query(
        np.column_stack([g["Longitude"], g["Latitude"]]), k=1)
    zr = zone_on[row, col].astype(int) - 1
    g["region"] = np.where((g["surface"] == "on") & (zr >= 0), zr, nn)
    g["region_rule"] = np.where((g["surface"] == "on") & (zr >= 0), "onshore cell", "nearest point")
    g["row"], g["col"] = row, col
    g.to_parquet(out)
    return g
