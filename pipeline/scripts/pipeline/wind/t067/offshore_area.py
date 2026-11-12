"""T067 fix 2 (T065-05): price offshore wind at the depth and distance of the area its
capacity factor comes from.

The simulated offshore level is the mean net CF of the best 20% of each zone's
eligible sea (floor 500 km2; site_selection --rule share). The cost site was the
arg-max of a 10 km focal mean – one point, often the windiest and farthest out
(NL: 170 km, priced as HVDC). Here each zone's depth and distance to shore are
the area-weighted means over exactly those pixels, with the same weights the CF
level uses (the fractional last pixel included). Why area-weighted and not the
centroid: DEA's cost function is linear in depth and in distance within a class,
so the area-weighted mean gives the area-mean capex; the centroid of a split or
curved area (two coasts, a ring round an island) can fall outside it, on land or
in deep water.

Depth: the eligibility depth raster (ETOPO 2022 60" averaged to 0.02 deg, the
Caspian measured from its -28 m surface; t067/landmask.py), the same depth that
decides the <= 60 m fixed-bottom screen. Distance: great-circle distance from the
pixel centre to the Natural Earth 10 m coastline, densified to <= 0.5 km between
vertices (error < 0.25 km), via a 3-D KD-tree.

Proof: the weighted net CF over the same pixels reproduces off_cf_best in the
resource CSV for every zone (to the CSV's 6 dp).

Writes scripts/wind_costs/inputs/offshore_sites.csv (same columns build_wind_costs
reads, plus area columns), keeping the old point file as offshore_sites_point_t061.csv.

  python3 -I -m t067.offshore_area --ws <ws_T067> --resource <new resource csv> \
      --coast <ne_10m_coastline.shp> --land <ne_10m_land.shp> --out <csv>
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

R_EARTH_KM = 6371.0088


def unit(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.column_stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


def coast_points(shp, step_km=0.5):
    import geopandas as gpd
    g = gpd.read_file(shp)
    pts = []
    for geom in g.geometry:
        lines = geom.geoms if geom.geom_type.startswith("Multi") else [geom]
        for ln in lines:
            xy = np.asarray(ln.coords)
            if len(xy) < 2:
                continue
            a, b = xy[:-1], xy[1:]
            # segment length (equirectangular, fine for densifying)
            dx = (b[:, 0] - a[:, 0]) * np.cos(np.radians((a[:, 1] + b[:, 1]) / 2)) * 111.32
            dy = (b[:, 1] - a[:, 1]) * 111.32
            n = np.maximum(1, np.ceil(np.hypot(dx, dy) / step_km).astype(int))
            for k in np.unique(n):
                sel = n == k
                t = (np.arange(k) / k)[None, :, None]
                p = a[sel][:, None, :] + t * (b[sel] - a[sel])[:, None, :]
                pts.append(p.reshape(-1, 2))
            pts.append(xy[-1:])
    p = np.concatenate(pts)
    return p[:, 1], p[:, 0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ws", type=Path, required=True)
    ap.add_argument("--resource", type=Path, required=True)
    ap.add_argument("--coast", type=Path, required=True)
    ap.add_argument("--land", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--share", type=float, default=20.0)
    ap.add_argument("--check-sites", type=Path, default=None,
                    help="old point file: validate this distance method at its points")
    a = ap.parse_args()
    os.environ["ATLAS_WORKSPACE_DIR"] = str(a.ws)
    os.environ.setdefault("ATLAS_DOCS_DATA_DIR", str(Path.home() / "wind-atlas-T067" / "docs_unused"))
    sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
    import rasterio
    from rasterio import features
    from scipy.spatial import cKDTree
    from scripts.pipeline.wind import site_selection as S, gwa_sources as G

    res = pd.read_csv(a.resource)
    points = pd.read_csv(S.POINTS_CSV)
    assert (points.location_id.to_numpy() == res.location_id.to_numpy()).all()
    n = len(points)
    cf_off = S._u16_to_float(S._read_u16("gwa4_cf_offshore_150m_002deg.tif"), 10000)
    with rasterio.open(S.WIND_INPUTS / "eligible_offshore_002deg.tif") as s:
        elig = s.read(1).astype("float32") / 100.0
    with rasterio.open(S.WIND_INPUTS / "depth_002deg.tif") as s:
        depth = s.read(1).astype("float64")
    area = S.pixel_area_km2()[:, None]
    zone = np.zeros(elig.shape, dtype="int32")
    rows, cols = np.nonzero(elig > 0)
    lat = G.GRID_NORTH - (rows + 0.5) * G.GRID_RES
    lon = G.GRID_WEST + (cols + 0.5) * G.GRID_RES
    _, nn = cKDTree(points[["longitude", "latitude"]].to_numpy()).query(np.column_stack([lon, lat]), k=1, workers=4)
    zone[rows, cols] = nn + 1
    m = (zone > 0) & (elig > 0) & np.isfinite(cf_off)
    flat = np.flatnonzero(m)
    zi = (zone.ravel()[flat] - 1).astype("int64")
    cfv = (cf_off.ravel()[flat] * (1.0 - S.DEFAULT_LOSSES)).astype("float32")
    wgt = (elig.ravel()[flat] * np.broadcast_to(area, zone.shape).ravel()[flat]).astype("float32")
    del cf_off, elig, zone
    # share_mean_by_zone's own expressions, keeping the per-pixel take
    order = np.lexsort((-cfv, zi))
    z, v = zi[order], cfv[order].astype("float64")
    w = wgt[order].astype("float64")
    total = np.bincount(z, weights=w, minlength=n)
    starts = np.zeros(n + 1)
    starts[1:] = np.cumsum(total)
    above = np.cumsum(w) - w - starts[z]
    target = np.maximum(a.share / 100.0 * total, S.BEST_AREA_KM2)[z]
    take = np.clip(target - above, 0.0, w)
    den = np.bincount(z, weights=take, minlength=n)
    cf_mean = np.divide(np.bincount(z, weights=take * v, minlength=n), den, out=np.full(n, np.nan), where=den > 0)
    best = S.share_mean_by_zone(zi, cfv, wgt, n, a.share / 100.0, S.BEST_AREA_KM2)
    assert np.array_equal(cf_mean, best, equal_nan=True), "take weights do not reproduce share_mean_by_zone"
    csv_best = res["off_cf_best"].to_numpy()
    ok = np.isfinite(csv_best)
    dmax = float(np.nanmax(np.abs(np.round(best[ok], 6) - csv_best[ok])))
    print(f"proof: area weights reproduce off_cf_best of {int(ok.sum())} zones; max |diff| after 6 dp rounding {dmax:.1e}")
    assert dmax < 1.5e-6 and np.array_equal(ok, np.isfinite(best))

    sel = take > 0
    fz = flat[order][sel]
    tz, tw = z[sel], take[sel]
    plat = G.GRID_NORTH - (fz // G.GRID_WIDTH + 0.5) * G.GRID_RES
    plon = G.GRID_WEST + (fz % G.GRID_WIDTH + 0.5) * G.GRID_RES
    pdepth = depth.ravel()[fz]
    clat, clon = coast_points(a.coast)
    tree = cKDTree(unit(clat, clon))
    chord, _ = tree.query(unit(plat, plon), k=1, workers=4)
    pdist = 2 * R_EARTH_KM * np.arcsin(np.clip(chord / 2, 0, 1))
    if a.check_sites:
        old = pd.read_csv(a.check_sites)
        ch, _ = tree.query(unit(old.off_site_lat.to_numpy(), old.off_site_lon.to_numpy()), k=1, workers=4)
        d = 2 * R_EARTH_KM * np.arcsin(np.clip(ch / 2, 0, 1)) - old.shore_km.to_numpy()
        print(f"distance method vs the old segment method at {len(old)} old sites: "
              f"median {np.median(d):+.3f} km, max |diff| {np.abs(d).max():.3f} km")
    W = np.bincount(tz, weights=tw, minlength=n)
    wd = np.bincount(tz, weights=tw * pdepth, minlength=n) / np.where(W > 0, W, 1)
    wD = np.bincount(tz, weights=tw * pdist, minlength=n) / np.where(W > 0, W, 1)
    # spread, for the report
    out = []
    import geopandas as gpd
    land = gpd.read_file(a.land)
    in_land = features.rasterize(((g, 1) for g in land.geometry), out_shape=(G.GRID_HEIGHT, G.GRID_WIDTH),
                                 transform=G.grid_transform(), fill=0, dtype="uint8").ravel()[fz]
    wl = np.bincount(tz, weights=tw * in_land, minlength=n) / np.where(W > 0, W, 1)
    for i in np.nonzero(W > 0)[0]:
        k = tz == i
        out.append({
            "location_id": int(points.location_id.iat[i]),
            "off_site_lat": f"{res.off_site_lat.iat[i]:.6f}", "off_site_lon": f"{res.off_site_lon.iat[i]:.6f}",
            "etopo_row": "", "etopo_col": "",
            "etopo_z_m": f"{-wd[i]:.1f}", "depth_m": f"{wd[i]:.1f}", "shore_km": f"{wD[i]:.2f}",
            "shore_method": "area_weighted_best20",
            "on_land_ne": int(wl[i] > 0.5),
            "area_km2": f"{W[i]:.1f}", "n_pixels": int(k.sum()),
            "shore_km_min": f"{pdist[k].min():.1f}", "shore_km_max": f"{pdist[k].max():.1f}",
            "depth_m_min": f"{pdepth[k].min():.0f}", "depth_m_max": f"{pdepth[k].max():.0f}",
        })
    with open(a.out, "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=list(out[0].keys()), lineterminator="\n")
        wr.writeheader()
        wr.writerows(out)
    print(f"wrote {len(out)} zones to {a.out}")


if __name__ == "__main__":
    main()
