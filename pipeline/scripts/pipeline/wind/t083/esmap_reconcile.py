"""T083 A2: the atlas's ESMAP-definition offshore energy, step by step from ESMAP's own capacity.

ESMAP's dataset (World Bank Group/ESMAP 2021, Global Offshore Wind Technical Potential) publishes
capacity (GW), not energy. This script starts from that capacity per cell
(voronoi_wind_potential_offshore.csv) and applies the atlas's steps one at a time, so the
gap between a plain "ESMAP GW x Global Wind Atlas CF" figure and the atlas's 64 / 158 PWh is
decomposed. Nothing here changes the method; potential_defs.py is the method.

  S0  ESMAP GW x mean GROSS GWA 150 m offshore CF over all of the cell's sea in ESMAP's class
      (fixed 0-50 m, floating 50-1,000 m by the int16 depth raster; <= 200 km; >= 7 m/s at 100 m),
      no exclusions; cells with ESMAP GW but no such sea pixel with a CF count zero
  S1  + 12% losses (net CF)
  S2  + the atlas's exclusions: only sea >= 10 km from shore outside designated WDPA areas,
      and the eligibility rasters' depth decision at 60 m (potential_defs.py's pixels)
  S3  + calibration x off_level_factor (0.777)
  S4  + 20% cut-off on the calibrated CF  (= potential_defs.py's ESMAP columns)

Usage: python3 -I esmap_reconcile.py <same arguments as potential_defs.py>
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import potential_defs as P  # noqa: E402


def main() -> None:
    import argparse
    import rasterio
    from scipy import ndimage
    from scipy.spatial import cKDTree
    ap = argparse.ArgumentParser()
    for k in ("repo", "ws", "pa", "resource", "esmap", "onshore_cons", "cells", "demand", "out", "results"):
        ap.add_argument("--" + k.replace("_", "-"), type=Path, required=True)
    a = ap.parse_args()
    S, G = P.siting(a.repo, a.ws)
    lines = []
    say = lambda s: (print(s), lines.append(s))
    rd = lambda n: rasterio.open(S.WIND_INPUTS / n).read(1)
    points = pd.read_csv(S.POINTS_CSV)
    ids = points["location_id"].to_numpy()
    n = ids.size
    E = pd.read_csv(a.esmap).set_index("location_id").reindex(ids)
    R = pd.read_csv(a.resource).set_index("location_id").reindex(ids)
    foff = R["off_level_factor"].fillna(1.0).to_numpy()
    mapcell = np.isin(ids, pd.read_csv(a.demand)["location_id"].to_numpy())
    gw = {"fix": np.nan_to_num(E["fixed_gw"].to_numpy()), "fl": np.nan_to_num(E["floating_gw"].to_numpy())}

    # ---- S0/S1: all sea in ESMAP's classes, no exclusions
    depth = rd("depth_002deg.tif")
    land = rd("land_002deg.tif") == 1
    nonsea = land | (depth <= 0)
    del land
    r, c = np.nonzero((~nonsea) & (depth <= 1000))
    er = ndimage.binary_erosion(nonsea, structure=np.ones((3, 3), bool), border_value=1)
    br, bc_ = np.nonzero(nonsea & ~er)
    del er, nonsea
    tree = cKDTree(P.unit(G.GRID_NORTH - (br + 0.5) * G.GRID_RES, G.GRID_WEST + (bc_ + 0.5) * G.GRID_RES))
    lat = G.GRID_NORTH - (r + 0.5) * G.GRID_RES
    lon = G.GRID_WEST + (c + 0.5) * G.GRID_RES
    chord, _ = tree.query(P.unit(lat, lon), k=1, workers=4)
    dist = 2 * P.R_EARTH_KM * np.arcsin(np.clip(chord / 2, 0, 1))
    dep = depth[r, c].astype("int32")
    del depth, tree, chord
    cf_raw = rd("gwa4_cf_offshore_150m_002deg.tif")[r, c]
    cf = np.where(cf_raw == G.NODATA_U16, np.nan, cf_raw.astype("float64") / 10000)
    sp_raw = rd("gwa4_wind_speed_100m_002deg.tif")[r, c]
    sp = np.where(sp_raw == G.NODATA_U16, np.nan, sp_raw.astype("float64") / 100)
    w = S.pixel_area_km2()[r].astype("float64")
    _, zone = cKDTree(points[["longitude", "latitude"]].to_numpy()).query(np.column_stack([lon, lat]), k=1, workers=4)
    ok = np.isfinite(cf) & np.isfinite(sp) & (sp >= 7.0) & (dist <= 200)
    steps = {}
    for cls, sel in (("fix", ok & (dep <= 50)), ("fl", ok & (dep > 50))):
        z, ww, cc = zone[sel], w[sel], cf[sel]
        wall = np.bincount(z, weights=ww, minlength=n)
        mcf = np.divide(np.bincount(z, weights=ww * cc, minlength=n), wall, out=np.zeros(n), where=wall > 0)
        s0 = gw[cls] * mcf * P.TWH_PER_GW_CF
        steps[(cls, "S0")] = s0
        steps[(cls, "S1")] = s0 * (1 - P.LOSSES)
        steps[(cls, "gw_no_sea_S0")] = np.where(wall > 0, 0, gw[cls])
    del r, c, dist, dep, cf, sp, w, zone, ok

    # ---- S2-S4: the atlas's pixels (potential_defs.py)
    px = P.pixel_table(S, G, a.pa, lambda s: None)
    z = px["zone"]
    classes, maxd, vmin = P.DEFS["esmap"]
    for cls, lo_hi in classes.items():
        m = P.class_mask(px, cls, lo_hi, maxd, vmin)
        zz, ww, cnet = z[m], px["w"][m], px["cf"][m]
        ccal = cnet * foff[zz]
        wall = np.bincount(zz, weights=ww, minlength=n)
        f = lambda x: np.divide(np.bincount(zz, weights=ww * x, minlength=n), wall, out=np.zeros(n), where=wall > 0)
        steps[(cls, "S2")] = gw[cls] * f(cnet) * P.TWH_PER_GW_CF
        steps[(cls, "S3")] = gw[cls] * f(ccal) * P.TWH_PER_GW_CF
        steps[(cls, "S4")] = gw[cls] * f(np.where(ccal >= P.CUT_CONS, ccal, 0)) * P.TWH_PER_GW_CF
        steps[(cls, "gw_no_sea_S2")] = np.where(wall > 0, 0, gw[cls])

    m = mapcell
    say("# T083 A2: ESMAP-definition offshore energy, step by step (map cells, PWh a year)\n")
    say(f"ESMAP capacity in map cells: fixed {gw['fix'][m].sum()/1e3:,.2f} TW, floating {gw['fl'][m].sum()/1e3:,.2f} TW\n")
    names = {"S0": "ESMAP GW x gross GWA CF, all class sea", "S1": "+ 12% losses", "S2": "+ atlas exclusions (10 km, WDPA)",
             "S3": "+ calibration x0.777", "S4": "+ 20% cut-off (atlas ESMAP case)"}
    say("| Step | Fixed-bottom | Change | Floating | Change |")
    say("|---|---|---|---|---|")
    prev = {}
    for k, label in names.items():
        row = [label]
        for cls in ("fix", "fl"):
            v = steps[(cls, k)][m].sum() / 1e3
            row += [f"{v:,.1f}", "" if cls not in prev else f"{v - prev[cls]:+,.1f} ({v / prev[cls] - 1:+.1%})"]
            prev[cls] = v
        say("| " + " | ".join(row) + " |")
    for cls in ("fix", "fl"):
        mean0 = steps[(cls, "S0")][m].sum() / (gw[cls][m].sum() * P.TWH_PER_GW_CF)
        say(f"\n{cls}: capacity-weighted gross CF at S0 {mean0:.3f}; ESMAP GW with no class sea pixel holding a CF: "
            f"S0 {steps[(cls, 'gw_no_sea_S0')][m].sum():,.0f} GW, S2 {steps[(cls, 'gw_no_sea_S2')][m].sum():,.0f} GW")
    out = P.guard(a.results) / "esmap_reconcile.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
