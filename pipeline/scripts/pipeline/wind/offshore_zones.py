"""T082: price and simulate offshore wind in designated or tendered zones where countries publish them.

Elsewhere the offshore site stays the best 20% of the region's eligible sea (T061/T067).

Zones: EMODnet Human Activities "Wind farms (polygons)" (WFS layer emodnet:windfarmspoly), which
collects the national registers: RVO/Programma Noordzee (NL), BSH Flaechenentwicklungsplan (DE),
Energistyrelsen (DK), DGEC/CRE (FR), the Crown Estate leasing rounds (GB), FPS Economy (BE).
Rule, fixed before the run (team/reports/T082-expectations.md):
  * countries NL, DE, DK, BE, FR (metropolitan waters only by construction: EMODnet covers Europe), GB;
  * statuses Production, Construction, Approved, Planned (not Dismantled, not Test site);
  * a pixel (0.02 deg, centre inside a polygon) counts only if it is eligible fixed-bottom sea
    (eligible_offshore_002deg, the same screen as every other offshore region: <= 60 m, outside
    protected areas), and it goes to the nearest region point of the polygon's own country (audit
    decision; elsewhere the nearest region point of any country, t067/offshore_area.py);
  * a region is a zone region if at least --min-km2 (100) of eligible zone sea falls in it.
For a zone region, over ALL its eligible zone pixels (no best-20% pick inside the zone), weighted by
eligible area:
  * level: mean net GWA 150 m offshore CF (x (1 - 12% losses)) -> off_cf_best; x off_level_factor
    (0.777, D-134) -> off_cf_target;
  * cost site: mean depth (eligibility depth raster) and mean great-circle distance to the Natural
    Earth 10 m coast, exactly as t067/offshore_area.py (written in the offshore_sites.csv format);
  * hourly shape: the ERA5 series already fetched at the viable offshore site nearest to the zone's
    area-weighted centroid (T068 fetch, 2015-2024); no new ERA5 download.

  python3 -I offshore_zones.py sites --ws <ws_T067> --resource <T068 resource csv> \
      --countries <deployment/data/voronoi_overlapping_countries.csv> --zones <windfarmspoly.json> \
      --coast <ne_10m_coastline.shp> --land <ne_10m_land.shp> --out <dir>
  python3 -I offshore_zones.py profiles --repo <worktree> --resource <T068 resource csv> \
      --era5 <dir with era5_speed_<year>.npz> --out <dir>      (reads <dir>/zone_resource_rows.csv)
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

R_EARTH_KM = 6371.0088
LOSSES = 0.12
RHO0 = 1.225
COUNTRY_ISO3 = {"Netherlands": "NLD", "Germany": "DEU", "Denmark": "DNK", "Belgium": "BEL",
                "France": "FRA", "United Kingdom": "GBR"}
STATUSES = {"Production", "Construction", "Approved", "Planned"}
YEARS = list(range(2015, 2025))


def gc_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(np.asarray(lon2) - lon1)
    h = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * R_EARTH_KM * np.arcsin(np.sqrt(h))


def load_zones(path):
    """Polygons of the six countries and four statuses, as (geometry, iso3, name, status)."""
    from shapely.geometry import shape
    g = json.load(open(path, encoding="utf-8"))
    out = []
    for f in g["features"]:
        p = f["properties"]
        iso = COUNTRY_ISO3.get(p.get("country"))
        if iso and p.get("status") in STATUSES and f.get("geometry"):
            out.append((shape(f["geometry"]), iso, p.get("name") or "", p.get("status")))
    return out


def cmd_sites(a):
    os.environ["ATLAS_WORKSPACE_DIR"] = str(a.ws)
    os.environ.setdefault("ATLAS_DOCS_DATA_DIR", str(a.out / "docs_unused"))
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    import rasterio
    from rasterio import features
    from scipy.spatial import cKDTree
    from scripts.pipeline.wind import site_selection as S, gwa_sources as G
    from scripts.pipeline.wind.t067.offshore_area import coast_points, unit

    a.out.mkdir(parents=True, exist_ok=True)
    res = pd.read_csv(a.resource)
    points = pd.read_csv(S.POINTS_CSV)
    assert (points.location_id.to_numpy() == res.location_id.to_numpy()).all()
    n = len(points)
    ctry = pd.read_csv(a.countries)[["location_id", "country_iso3"]]
    iso_of = dict(zip(ctry.location_id, ctry.country_iso3))
    codes = sorted(set(COUNTRY_ISO3.values()))
    code_of = {c: i + 1 for i, c in enumerate(codes)}
    cell_code = np.array([code_of.get(iso_of.get(int(l), ""), 0) for l in points.location_id], dtype="int16")

    zones = load_zones(a.zones)
    print(f"zones: {len(zones)} polygons of {', '.join(codes)} with status in {sorted(STATUSES)}")
    zr = np.zeros((G.GRID_HEIGHT, G.GRID_WIDTH), dtype="uint8")
    for iso in codes:   # union per country (overlapping polygons counted once)
        geoms = [z[0] for z in zones if z[1] == iso]
        if geoms:
            m = features.rasterize(((g, 1) for g in geoms), out_shape=zr.shape, transform=G.grid_transform(),
                                   fill=0, dtype="uint8")
            zr[(m == 1) & (zr == 0)] = code_of[iso]
            del m

    cf_off = S._u16_to_float(S._read_u16("gwa4_cf_offshore_150m_002deg.tif"), 10000)
    with rasterio.open(S.WIND_INPUTS / "eligible_offshore_002deg.tif") as s:
        elig = s.read(1).astype("float32") / 100.0
    with rasterio.open(S.WIND_INPUTS / "depth_002deg.tif") as s:
        depth = s.read(1).astype("float64")
    area = S.pixel_area_km2()
    # gross zone sea per region, before eligibility (for the eligibility check in the report)
    rows, cols = np.nonzero(zr > 0)
    lat = G.GRID_NORTH - (rows + 0.5) * G.GRID_RES
    lon = G.GRID_WEST + (cols + 0.5) * G.GRID_RES
    # T082 audit (lead decision): a zone pixel goes to the nearest region OF THE POLYGON'S OWN COUNTRY
    # (lon/lat distance, as the nearest-point rule everywhere else), so zones in sea that the general
    # rule gives to a neighbour's region (German FEP areas off the Dutch and Danish regions) still
    # count for their own country.
    zcode = zr[rows, cols]
    nn = np.full(len(rows), -1, dtype="int64")
    xy = np.column_stack([lon, lat])
    for code in np.unique(zcode):
        cand = np.nonzero(cell_code == code)[0]
        sel = zcode == code
        if len(cand) == 0:
            continue
        _, j = cKDTree(points[["longitude", "latitude"]].to_numpy()[cand]).query(xy[sel], k=1, workers=4)
        nn[sel] = cand[j]
    own = nn >= 0
    nn = np.where(own, nn, 0)
    gross = np.bincount(nn[own], weights=area[rows[own]], minlength=n)
    ok = own & (elig[rows, cols] > 0) & np.isfinite(cf_off[rows, cols])
    r_, c_, z_ = rows[ok], cols[ok], nn[ok]
    w = elig[r_, c_].astype("float64") * area[r_]
    v = cf_off[r_, c_].astype("float64") * (1.0 - S.DEFAULT_LOSSES)
    W = np.bincount(z_, weights=w, minlength=n)
    sel_cells = np.nonzero(W >= a.min_km2)[0]
    print(f"regions with eligible zone sea: {int((W > 0).sum())}; at least {a.min_km2:g} km2: {len(sel_cells)}")
    keep = np.isin(z_, sel_cells)
    r_, c_, z_, w, v = r_[keep], c_[keep], z_[keep], w[keep], v[keep]
    plat = G.GRID_NORTH - (r_ + 0.5) * G.GRID_RES
    plon = G.GRID_WEST + (c_ + 0.5) * G.GRID_RES
    pdepth = depth[r_, c_]
    clat, clon = coast_points(a.coast)
    chord, _ = cKDTree(unit(clat, clon)).query(unit(plat, plon), k=1, workers=4)
    pdist = 2 * R_EARTH_KM * np.arcsin(np.clip(chord / 2, 0, 1))
    import geopandas as gpd
    land = gpd.read_file(a.land)
    in_land = features.rasterize(((g, 1) for g in land.geometry), out_shape=zr.shape, transform=G.grid_transform(),
                                 fill=0, dtype="uint8")[r_, c_]
    # donor ERA5 sites: viable offshore sites (T068 fetch covers every row's off_site)
    via = res.off_viable.to_numpy() == 1
    dlat, dlon = res.off_site_lat.to_numpy(), res.off_site_lon.to_numpy()
    donor_idx = np.nonzero(via & np.isfinite(dlat))[0]
    dtree = cKDTree(unit(dlat[donor_idx], dlon[donor_idx]))
    names = {}
    for zg, iso, nm, st in zones:
        names.setdefault(iso, []).append((zg, nm, st))

    site_rows, res_rows, rep = [], [], []
    for i in sel_cells:
        k = z_ == i
        wk = w[k]
        Wi = wk.sum()
        cf_best = float((wk * v[k]).sum() / Wi)
        d_m = float((wk * pdepth[k]).sum() / Wi)
        D_km = float((wk * pdist[k]).sum() / Wi)
        u = (unit(plat[k], plon[k]) * wk[:, None]).sum(axis=0)
        u /= np.linalg.norm(u)
        cen_lat, cen_lon = float(np.degrees(np.arcsin(u[2]))), float(np.degrees(np.arctan2(u[1], u[0])))
        ch, j = dtree.query(u[None, :], k=1)
        dj = int(donor_idx[int(j[0])])
        don_km = float(2 * R_EARTH_KM * np.arcsin(min(1.0, ch[0] / 2)))
        lid = int(points.location_id.iat[i])
        iso = iso_of[lid]
        from shapely.geometry import Point
        zn = sorted({f"{nm} ({st})" for zg, nm, st in names.get(iso, []) if zg.intersects(Point(cen_lon, cen_lat).buffer(1.5))
                     and any(zg.contains(Point(x, y)) for x, y in zip(plon[k][::25], plat[k][::25]))})
        lf = float(res.off_level_factor.iat[i])
        old = res.iloc[i]
        site_rows.append({
            "location_id": lid, "off_site_lat": f"{dlat[dj]:.6f}", "off_site_lon": f"{dlon[dj]:.6f}",
            "etopo_row": "", "etopo_col": "", "etopo_z_m": f"{-d_m:.1f}", "depth_m": f"{d_m:.1f}",
            "shore_km": f"{D_km:.2f}", "shore_method": "zone_emodnet_2025",
            "on_land_ne": int(float((wk * in_land[k]).sum() / Wi) > 0.5),
            "area_km2": f"{Wi:.1f}", "n_pixels": int(k.sum()),
            "shore_km_min": f"{pdist[k].min():.1f}", "shore_km_max": f"{pdist[k].max():.1f}",
            "depth_m_min": f"{pdepth[k].min():.0f}", "depth_m_max": f"{pdepth[k].max():.0f}",
        })
        res_rows.append({
            "location_id": lid, "country_iso3": iso, "zone_area_km2": round(Wi, 1),
            "off_cf_best": round(cf_best, 6), "off_cf_target": round(cf_best * lf, 6), "off_level_factor": lf,
            "off_site_lat": round(float(dlat[dj]), 6), "off_site_lon": round(float(dlon[dj]), 6),
            "era5_donor_location_id": int(res.location_id.iat[dj]), "era5_donor_km_from_zone_centroid": round(don_km, 1),
            "old_off_cf_best": old.off_cf_best, "old_off_cf_target": old.off_cf_target,
            "old_off_site_lat": old.off_site_lat, "old_off_site_lon": old.off_site_lon, "old_off_viable": int(old.off_viable),
        })
        rep.append({"location_id": lid, "country_iso3": iso, "zone_gross_km2": round(float(gross[i]), 1),
                    "zone_eligible_km2": round(Wi, 1), "eligible_share": round(Wi / gross[i], 3) if gross[i] else None,
                    "depth_m": round(d_m, 1), "shore_km": round(D_km, 1),
                    "centroid_lat": round(cen_lat, 4), "centroid_lon": round(cen_lon, 4),
                    "zones": "; ".join(zn)})
    pd.DataFrame(site_rows).to_csv(a.out / "zone_sites.csv", index=False, lineterminator="\n")
    pd.DataFrame(res_rows).to_csv(a.out / "zone_resource_rows.csv", index=False, lineterminator="\n")
    pd.DataFrame(rep).to_csv(a.out / "zone_report.csv", index=False, lineterminator="\n")
    small = [(int(points.location_id.iat[i]), iso_of.get(int(points.location_id.iat[i])), round(float(W[i]), 1))
             for i in np.nonzero((W > 0) & (W < a.min_km2))[0]]
    print(f"below the {a.min_km2:g} km2 threshold (kept on best-20%): {small}")
    print(f"wrote {len(site_rows)} zone regions to {a.out}")


def cmd_profiles(a):
    """Ten-year k and hourly offshore profiles for the zone regions, by build_wind_years.py's and
    solve_k10.py's construction (offshore curve, sea-level density, 12% losses, the shipped solve_k
    with its 0.6-1.8 cap, k on the 2015-2024 mean, UTC -> local solar clock by round(lon/15))."""
    sys.path.insert(0, str(a.repo / "pipeline"))
    from scripts.pipeline.wind.power_curves import CURVES
    from scripts.pipeline.wind.build_wind_profiles import solve_k
    res = pd.read_csv(a.resource)
    ids = res.location_id.to_numpy()
    zr = pd.read_csv(a.out / "zone_resource_rows.csv")
    pos = {int(l): i for i, l in enumerate(ids)}
    lon = res.longitude.to_numpy()
    zi = np.array([pos[int(l)] for l in zr.location_id])
    di = np.array([pos[int(l)] for l in zr.era5_donor_location_id])
    keep = 1.0 - LOSSES
    curve = CURVES["offshore"]
    parts = []
    for y in YEARS:
        z = np.load(a.era5 / f"era5_speed_{y}.npz")
        assert (z["location_id"] == ids).all(), f"point order mismatch {y}"
        parts.append(z["off"][:, di].astype("float64"))
    hours = [p.shape[0] for p in parts]
    sp = np.concatenate(parts, axis=0)
    ks, cl, fin = [], [], []
    for j in range(len(zr)):
        k, c = solve_k(sp[:, j], curve, float(zr.off_cf_target.iat[j]) / keep)
        ks.append(k); cl.append(int(c)); fin.append(float((curve.output(sp[:, j] * k) * keep).mean()))
    ks = np.array(ks)
    prof = a.out / "profiles"
    prof.mkdir(exist_ok=True)
    off = 0
    tot = np.zeros(len(zr))
    for y, h in zip(YEARS, hours):
        v = sp[off:off + h]
        off += h
        out = np.zeros((len(zr), h), dtype="float32")
        for j in range(len(zr)):
            out[j] = np.roll(curve.output(v[:, j] * ks[j]) * keep, int(round(lon[zi[j]] / 15.0))).astype("float32")
        assert h == (date(y + 1, 1, 1) - date(y, 1, 1)).days * 24
        np.save(prof / f"off_zone_{y}.npy", out)
        tot += out.astype("float64").sum(axis=1)
    np.save(prof / "off_zone_rows.npy", zr.location_id.to_numpy())
    mean = tot / sum(hours)
    zr["off_k"], zr["off_clamped"], zr["off_final_cf"], zr["profile_ten_year_mean"] = ks, cl, fin, mean
    zr.to_csv(a.out / "zone_resource_rows.csv", index=False, lineterminator="\n")
    err = np.abs(mean - zr.off_cf_target.to_numpy())[np.array(cl) == 0]
    print(f"{len(zr)} zone profiles; clamped {sum(cl)}; ten-year mean vs target, unclamped max |err| "
          f"{err.max() if len(err) else 0:.2e}")
    assert len(err) == 0 or err.max() < 1e-4


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sites")
    s.add_argument("--ws", type=Path, required=True)
    s.add_argument("--resource", type=Path, required=True)
    s.add_argument("--countries", type=Path, required=True)
    s.add_argument("--zones", type=Path, required=True)
    s.add_argument("--coast", type=Path, required=True)
    s.add_argument("--land", type=Path, required=True)
    s.add_argument("--out", type=Path, required=True)
    s.add_argument("--min-km2", type=float, default=100.0)
    p = sub.add_parser("profiles")
    p.add_argument("--repo", type=Path, required=True)
    p.add_argument("--resource", type=Path, required=True)
    p.add_argument("--era5", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    cmd_sites(a) if a.cmd == "sites" else cmd_profiles(a)


if __name__ == "__main__":
    main()
