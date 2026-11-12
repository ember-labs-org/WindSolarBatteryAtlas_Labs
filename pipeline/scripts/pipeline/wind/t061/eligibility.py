"""Phase D (D-134): write the new eligibility rasters and the level-factor CSV.

Eligibility, variant new0 with the protected-area cap (audit F3):
  onshore  new = rint(min(old x (1 - pa_add) x (1 - settle), 100 x (1 - pa_all)))
           where old > 0, else 0. pa_add = WDPA 2026 area beyond IUCN I-VI as a share
           of what ESMAP left; settle = GHSL 3" cells >= 10% built, no setback.
  offshore new = rint(old x (1 - pa_all))   (all kept marine/coastal PAs)
  floating unchanged (report-only column).
Same uint8 0-100 GeoTIFF format as build_eligibility.py. The pixel-table route
(run_bc.variant_elig) must give the same value at every pixel of the table.

Level factors (D-135): onshore 0.879 for European regions by location (see
level_factors), exactly 1.0 elsewhere; offshore 0.777 everywhere.

  python3 -I -m t061.eligibility --out-ws <run>/ws_D     (from pipeline/scripts/pipeline/wind)
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from . import common as C

ON_FACTOR_EUROPE = 0.879
OFF_FACTOR = 0.777
# The gate C fit set (sweep.BROAD "Europe") plus every other European country
# (D-134, audit F2). Russia and Turkiye are not included: they were outside the
# fitted European set and the human dropped the Central Asia & Russia factor.
EUROPE = sorted(set(
    "AUT BEL BGR HRV CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX NLD NOR POL PRT ROU SRB SVK SVN "
    "ESP SWE CHE GBR UKR BIH "
    "ISL BLR ALB MKD MNE XKX KOS MDA CYP AND LIE MCO SMR VAT MLT FRO GIB IMN JEY GGY ALA SJM".split()))


# D-135: the onshore Europe factor is assigned by location. A region gets 0.879 iff
#   (a) its primary country is in EUROPE and its cell centroid lies in geographic
#       Europe, taken as the box lat >= 34 N and 32 W <= lon <= 45 E. This keeps
#       mainland Europe, the British Isles, Iceland, Cyprus and Svalbard, and drops
#       overseas territories (French Guiana 47, 1054, 2485; no other deployed region
#       of a European country lies outside the box: Reunion, Guadeloupe, Martinique,
#       Mayotte, the Canaries, Madeira and the Azores have no cell whose primary
#       country is European, or no eligible land); or
#   (b) its primary country is Russia and its cell centroid is west of 60 E
#       (European Russia, up to the Urals).
# Turkiye stays 1.0 (already 1.00 of new-build). Offshore is 0.777 everywhere.
EUROPE_BOX = dict(lat_min=34.0, lon_min=-32.0, lon_max=45.0)
RUSSIA_LON_MAX = 60.0


def cell_centroids(S) -> pd.DataFrame:
    import json
    from shapely.geometry import shape
    with open(S.CELLS_GEOJSON) as fh:
        gj = json.load(fh)
    rows = [(int(f["properties"]["location_id"]), *(lambda c: (c.y, c.x))(shape(f["geometry"]).centroid))
            for f in gj["features"]]
    return pd.DataFrame(rows, columns=["location_id", "centroid_lat", "centroid_lon"]).set_index("location_id")


def level_factors(out_csv: Path) -> pd.DataFrame:
    S, G = C.import_siting()
    pts = pd.read_csv(S.POINTS_CSV)
    oc = pd.read_csv(S.OUTPUTS_DIR / "voronoi_overlapping_countries.csv").set_index("location_id")
    iso = oc.reindex(pts["location_id"])["country_iso3"].to_numpy()
    cen = cell_centroids(S).reindex(pts["location_id"])
    # regions without a land cell (no onshore land at all) fall back to the site point
    lat = np.where(cen.centroid_lat.notna(), cen.centroid_lat, pts["latitude"]).astype(float)
    lon = np.where(cen.centroid_lon.notna(), cen.centroid_lon, pts["longitude"]).astype(float)
    in_box = (lat >= EUROPE_BOX["lat_min"]) & (lon >= EUROPE_BOX["lon_min"]) & (lon <= EUROPE_BOX["lon_max"])
    europe = (pd.Series(iso).isin(EUROPE).to_numpy() & in_box) | ((iso == "RUS") & (lon < RUSSIA_LON_MAX))
    f = pd.DataFrame({"location_id": pts["location_id"].to_numpy(), "country_iso3": iso,
                      "centroid_lat": np.round(lat, 4), "centroid_lon": np.round(lon, 4),
                      "on_level_factor": np.where(europe, ON_FACTOR_EUROPE, 1.0),
                      "off_level_factor": OFF_FACTOR})
    f.to_csv(C.guard_write(out_csv), index=False)
    return f


def build(out_ws: Path) -> dict:
    import rasterio
    S, G = C.import_siting()
    from scripts.pipeline.wind.build_eligibility import _target_profile
    wind = C.guard_write(out_ws / "input_data" / "wind")
    wind.mkdir(parents=True, exist_ok=True)
    with rasterio.open(S.WIND_INPUTS / "eligible_onshore_002deg.tif") as s:
        on_old = s.read(1)
    with rasterio.open(S.WIND_INPUTS / "eligible_offshore_002deg.tif") as s:
        off_old = s.read(1)
    pa = np.load(C.CACHE / "pa_share_002deg.npz")
    a = pa["pa_all"].astype("float32") / 100
    i = pa["pa_iucn"].astype("float32") / 100
    add = np.clip(np.divide(a - i, 1 - i, out=np.ones_like(a), where=i < 1), 0, 1)
    del i
    sb = np.load(C.CACHE / "setback_excl_pct_002deg.npz")["excl_pct"][0, 0].astype("float32") / 100
    on = on_old.astype("float32") * (1 - add) * (1 - sb)
    del add, sb
    on = np.minimum(on, 100.0 * (1 - a))
    on_new = np.where(on_old > 0, np.rint(on), 0).astype("uint8")
    del on
    off_new = np.rint(off_old.astype("float32") * (1 - a)).astype("uint8")
    for name, arr in (("eligible_onshore_002deg.tif", on_new), ("eligible_offshore_002deg.tif", off_new)):
        with rasterio.open(wind / name, "w", **_target_profile("uint8", 255)) as d:
            d.write(arr, 1)
    # same values as the pixel-table route at every table pixel
    from . import run_bc as RB
    px = C.load_pixels()
    L = RB.Layers(px)
    t_on, t_off = RB.variant_elig(px, L, RB.VARIANTS["new0"], cap_pa=True)
    d_on = int((on_new.ravel()[px["on_flat"]] != t_on).sum())
    d_off = int((off_new.ravel()[px["off_flat"]] != t_off).sum())
    res = {"on_old_km2": None, "pixels_on_changed": int((on_new != on_old).sum()),
           "pixels_off_changed": int((off_new != off_old).sum()),
           "table_mismatch_on": d_on, "table_mismatch_off": d_off}
    print(res)
    if d_on or d_off:
        raise SystemExit("raster and pixel-table eligibility differ")
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-ws", type=Path, required=True)
    a = ap.parse_args()
    if not (a.out_ws / "input_data" / "wind" / "eligible_onshore_002deg.tif").exists():
        build(a.out_ws)
    f = level_factors(a.out_ws / "level_factors_d135.csv")
    print("onshore regions at 0.879:", int((f.on_level_factor != 1.0).sum()), "; countries:",
          sorted(f.loc[f.on_level_factor != 1.0, "country_iso3"].dropna().unique()))
