"""T083: wind potential under selectable, published definitions, per map cell.

Onshore (unchanged methods):
  conservative  T078's case (D-150), read from t078/potential.py's per-region output:
                calibrated CF, 3 MW/km2, calibrated CF >= 20%.
  technical     pixel by pixel (T078's P0 case, lead A1): each pixel's own net CF before
                calibration, 5 MW/km2, pixels >= 15%, read from the same T078 output. The old
                best-site figure (5 MW/km2 x the region's site CF) is recomputed only as a check.

Offshore, fixed-bottom and floating each from their own sea (floating never borrows the
fixed-bottom CF). Both definitions use the atlas's own exclusions and calibration:
  * sea = the T067 land and lake mask; >= 10 km from shore (the eligibility rasters'
    rule); all designated WDPA areas excluded (T061 pa_all, now also on floating sea);
  * CF = GWA 4 offshore 150 m CF x (1 - 12% losses) x the region's off_level_factor.

  ESMAP  World Bank/ESMAP, Going Global (2019) and Global Offshore Wind Technical
         Potential (2021): fixed-bottom 0-50 m, floating 50-1,000 m, within 200 km of
         shore, mean 100 m speed >= 7 m/s. Capacity is ESMAP's own GW per cell
         (voronoi_wind_potential_offshore.csv, 3-4 MW/km2). The cell's atlas sea in the
         same class gives the share of that capacity at calibrated CF >= 20% (T078's
         conservative cut-off, kept: this is the article's conservative case) and its
         mean CF.
  IEA    IEA, Offshore Wind Outlook 2019, Annex B: within 300 km of shore, shallow < 60 m
         and deep 60-2,000 m, mean speed >= 5 m/s. Capacity = eligible area x the IEA's
         8 x 8 rotor-diameter spacing with the GWA offshore reference turbine (8 MW,
         167 m rotor; power_curves.py): 8 / (64 x 0.167^2) = 4.48 MW/km2. No CF cut-off
         beyond the 5 m/s screen. The IEA's buffers for shipping lanes (20 km), cables
         (1 km), fault lines (20 km) and oil and gas are not applied: the atlas has no such
         layers. Its MPA rule (IUCN Ia-III) is narrower than the atlas's WDPA exclusion.

Pixels: the 0.02 deg grid of site_selection.py. Depth classes come from the eligibility
rasters where they decide (<= 60 m fixed raster, 60-1,000 m floating raster; their float
depths and EDT distance), and from the int16 depth raster for the 50 m split and the
1,000-2,000 m band. Maximum distances (200 km, 300 km) are great-circle distances from the
pixel centre to the nearest non-sea pixel centre (land or lake), and so is the 10 km rule
in the 1,000-2,000 m band, which the rasters do not cover. Zones: nearest simulation point,
as site_selection.py and T078.

Usage (from anywhere; inputs are read in place, outputs only outside OneDrive):
  python3 -I potential_defs.py --repo <worktree> --ws <workspace> --pa <pa_share_002deg.npz>
      --resource <voronoi_wind_resource.csv> --esmap <voronoi_wind_potential_offshore.csv>
      --onshore-cons <t078 per-region csv> --cells <voronoi_pvout_potential.csv>
      --demand <voronoi_electricity_demand.csv> --out <csv> --results <dir>
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

CLOUD = (Path.home() / "Library" / "CloudStorage").resolve()
TWH_PER_GW_CF = 8.76
LOSSES = 0.12
R_EARTH_KM = 6371.0088
CUT_CONS = 0.20

# IEA OWO 2019 Annex B spacing (8 x 8 rotor diameters) with the GWA offshore reference turbine.
IEA_RATED_MW, IEA_ROTOR_KM = 8.0, 0.167
IEA_MW_PER_KM2 = IEA_RATED_MW / (64 * IEA_ROTOR_KM ** 2)

DEFS = {
    # name: (classes, max distance km, min 100 m speed m/s)
    "esmap": ({"fix": (None, 50), "fl": (50, 1000)}, 200.0, 7.0),
    "iea": ({"fix": (None, 60), "fl": (60, 2000)}, 300.0, 5.0),
}


def guard(p: Path) -> Path:
    r = Path(p).resolve()
    if r.is_relative_to(CLOUD):
        raise SystemExit(f"refusing to write under OneDrive: {r}")
    return r


def siting(repo: Path, ws: Path):
    os.environ["ATLAS_WORKSPACE_DIR"] = str(ws)
    os.environ.setdefault("ATLAS_DOCS_DATA_DIR", str(Path.home() / "wind-atlas-T083" / "docs_unused"))
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(repo / "pipeline"))
    from scripts.pipeline.wind import site_selection as S, gwa_sources as G
    return S, G


def unit(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.column_stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


def pixel_table(S, G, pa_path: Path, say) -> dict:
    """Every candidate offshore pixel: zone, weight (km2), net CF, speed, depth, distance, flags."""
    import rasterio
    from scipy import ndimage
    from scipy.spatial import cKDTree
    t0 = time.time()
    rd = lambda n: rasterio.open(S.WIND_INPUTS / n).read(1)
    fixed = rd("eligible_offshore_002deg.tif")
    flo = rd("floating_offshore_002deg.tif")
    depth = rd("depth_002deg.tif")
    land = rd("land_002deg.tif") == 1
    # T067 depth is 0 on land and in lakes, so sea = depth > 0 (the ocean and the Caspian).
    nonsea = land | (depth <= 0)
    del land
    deep_band = (~nonsea) & (depth >= 1000) & (depth <= 2000) & (flo == 0) & (fixed == 0)
    cand = (fixed > 0) | (flo > 0) | deep_band
    r, c = np.nonzero(cand)
    del cand
    say(f"- candidate pixels: fixed raster {int((fixed > 0).sum()):,}, floating raster {int((flo > 0).sum()):,}, "
        f"1,000-2,000 m band {int(deep_band.sum()):,}")
    # great-circle distance to the nearest non-sea pixel centre, from its boundary pixels
    er = ndimage.binary_erosion(nonsea, structure=np.ones((3, 3), bool), border_value=1)
    br, bc_ = np.nonzero(nonsea & ~er)
    del er, nonsea
    tree = cKDTree(unit(G.GRID_NORTH - (br + 0.5) * G.GRID_RES, G.GRID_WEST + (bc_ + 0.5) * G.GRID_RES))
    del br, bc_
    lat = G.GRID_NORTH - (r + 0.5) * G.GRID_RES
    lon = G.GRID_WEST + (c + 0.5) * G.GRID_RES
    chord, _ = tree.query(unit(lat, lon), k=1, workers=4)
    del tree
    dist = 2 * R_EARTH_KM * np.arcsin(np.clip(chord / 2, 0, 1))
    del chord
    f_fix = fixed[r, c].astype("float32") / 100          # PA already applied (T061/T067)
    f_flo = flo[r, c].astype("float32") / 100
    band = deep_band[r, c]
    dep = depth[r, c].astype("int32")
    del fixed, flo, depth, deep_band
    pa = np.load(pa_path)["pa_all"][r, c].astype("float32") / 100
    # PA on floating and deep sea, rounded to whole per cent as the fixed raster was (t061 formula)
    e_deep = np.rint(np.where(band, 100.0, f_flo * 100) * (1 - pa)) / 100
    in_fixed = f_fix > 0
    elig = np.where(in_fixed, f_fix, e_deep).astype("float32")
    # the 10 km rule for the band the rasters do not cover
    elig = np.where(band & (dist < 10.0), 0, elig)
    cf_raw = rd("gwa4_cf_offshore_150m_002deg.tif")[r, c]
    cf = np.where(cf_raw == G.NODATA_U16, np.nan, cf_raw.astype("float32") / 10000) * np.float32(1 - LOSSES)
    del cf_raw
    sp_raw = rd("gwa4_wind_speed_100m_002deg.tif")[r, c]
    speed = np.where(sp_raw == G.NODATA_U16, np.nan, sp_raw.astype("float32") / 100)
    del sp_raw
    area = S.pixel_area_km2()[r]
    points = pd.read_csv(S.POINTS_CSV)
    ptree = cKDTree(points[["longitude", "latitude"]].to_numpy())
    _, zone = ptree.query(np.column_stack([lon, lat]), k=1, workers=4)
    keep = (elig > 0) & np.isfinite(cf)
    say(f"- pixels with eligible sea and a GWA CF: {int(keep.sum()):,} of {r.size:,}; "
        f"eligible but no CF: {int(((elig > 0) & ~np.isfinite(cf)).sum()):,}; "
        f"no 100 m speed among them: {int((keep & ~np.isfinite(speed)).sum()):,}")
    say(f"- pixel table built in {time.time() - t0:.0f} s")
    fl_all = np.bincount(zone, weights=(f_flo * area).astype("float64"), minlength=len(points))
    k = keep
    return {"fl_area_all": fl_all,"zone": zone[k].astype("int32"), "w": (elig[k] * area[k]).astype("float64"), "cf": cf[k].astype("float64"),
            "speed": speed[k], "depth": dep[k], "dist": dist[k].astype("float32"), "in_fixed": in_fixed[k],
            "row": r[k], "location_id": points["location_id"].to_numpy(),
            "band": band[k]}


def class_mask(px, cls, lo_hi, maxd, vmin):
    """Pixels of one depth class. Three disjoint sources: the fixed raster (<= 60 m), the
    floating raster (60-1,000 m) and the 1,000-2,000 m band; the 50 m split uses the depth raster."""
    lo, hi = lo_hi
    fixed, band = px["in_fixed"], px["band"]
    if cls == "fix":
        m = fixed & (px["depth"] <= hi)
    else:
        m = (fixed & (px["depth"] > lo)) | (~fixed & ~band)
        if hi >= 2000:
            m |= band
    sp = px["speed"]
    return m & (px["dist"] <= maxd) & np.isfinite(sp) & (sp >= vmin)


def bc(z, x, n):
    return np.bincount(z, weights=np.asarray(x, "float64"), minlength=n)


def main() -> None:
    ap = argparse.ArgumentParser()
    for k in ("repo", "ws", "pa", "resource", "esmap", "onshore_cons", "cells", "demand", "out", "results"):
        ap.add_argument("--" + k.replace("_", "-"), type=Path, required=True)
    a = ap.parse_args()
    lines = []
    say = lambda s: (print(s), lines.append(s))
    S, G = siting(a.repo, a.ws)
    say(f"# T083 potential definitions\n\nInputs: ws {a.ws}; resource {a.resource}; ESMAP {a.esmap}; "
        f"onshore conservative {a.onshore_cons}\n\nIEA density {IEA_MW_PER_KM2:.4f} MW/km2\n\n## Pixel table")
    px = pixel_table(S, G, a.pa, say)
    ids = px["location_id"]
    n = ids.size
    R = pd.read_csv(a.resource).set_index("location_id").reindex(ids)
    E = pd.read_csv(a.esmap).set_index("location_id").reindex(ids)
    foff = R["off_level_factor"].fillna(1.0).to_numpy()
    z = px["zone"]
    cfc = px["cf"] * foff[z]
    out = pd.DataFrame({"location_id": ids})

    # ---------------- identity: masks against the eligibility rasters ----------------
    say("\n## Identity")
    in_csv = R["off_area_km2"].notna().to_numpy()
    fixw = bc(z[px["in_fixed"]], px["w"][px["in_fixed"]], n)
    d1 = np.abs(np.round(fixw, 6) - R["off_area_km2"].to_numpy())[in_csv]
    d2 = np.abs(np.round(px["fl_area_all"], 6) - R["off_floating_area_km2"].to_numpy())[in_csv]
    say(f"- {int(in_csv.sum())} of {n} simulation points are rows of the resource CSV")
    say(f"- fixed raster sea with a CF (= off_area_km2): {int((d1 > 1e-6).sum())} rows differ beyond 6 dp (max {d1.max():.3g} km2)")
    say(f"- floating raster sea, all pixels, before the new PA step (= off_floating_area_km2): "
        f"{int((d2 > 1e-6).sum())} rows differ beyond 6 dp (max {d2.max():.3g} km2)")
    if (d1 > 1e-6).any() or (d2 > 1e-6).any():
        raise SystemExit("pixel table does not reproduce the resource CSV's offshore areas")

    # ---------------- offshore definitions ----------------
    esmap_gw = {"fix": np.nan_to_num(E["fixed_gw"].to_numpy()), "fl": np.nan_to_num(E["floating_gw"].to_numpy())}
    for dname, (classes, maxd, vmin) in DEFS.items():
        for cls, lo_hi in classes.items():
            m = class_mask(px, cls, lo_hi, maxd, vmin)
            zz, w, cc = z[m], px["w"][m], cfc[m]
            wall = bc(zz, w, n)
            if dname == "esmap":
                s = cc >= CUT_CONS
                share = np.divide(bc(zz[s], w[s], n), wall, out=np.zeros(n), where=wall > 0)
                mcf = np.divide(bc(zz[s], w[s] * cc[s], n), wall, out=np.zeros(n), where=wall > 0)
                gw = esmap_gw[cls] * share
                twh = esmap_gw[cls] * mcf * TWH_PER_GW_CF
                # ESMAP capacity in a cell with none of the class's atlas sea: no estimate
                twh = np.where((wall <= 0) & (esmap_gw[cls] > 0), np.nan, twh)
                gw = np.where((wall <= 0) & (esmap_gw[cls] > 0), np.nan, gw)
            else:
                gw = wall * IEA_MW_PER_KM2 / 1000
                twh = bc(zz, w * cc, n) * IEA_MW_PER_KM2 / 1000 * TWH_PER_GW_CF
                # IEA Table A.3 split: near shore < 60 km, far 60-300 km
                near = px["dist"][m] < 60
                out[f"{cls}_{dname}_near_twh"] = bc(zz[near], (w * cc)[near], n) * IEA_MW_PER_KM2 / 1000 * TWH_PER_GW_CF
            out[f"{cls}_{dname}_gw"] = gw
            out[f"{cls}_{dname}_twh"] = twh
            out[f"{cls}_{dname}_area_km2"] = wall

    # ---------------- onshore ----------------
    oc = pd.read_csv(a.onshore_cons).set_index("location_id").reindex(ids)
    out["on_cons_gw"] = oc["on_cons_gw"].fillna(0).to_numpy()
    out["on_cons_twh"] = oc["on_cons_twh"].fillna(0).to_numpy()
    out["on_tech_gw"] = oc["on_p0_gw"].fillna(0).to_numpy()
    out["on_tech_twh"] = oc["on_p0_twh"].fillna(0).to_numpy()
    onv = R["on_viable"].to_numpy() == 1
    oncf = np.nan_to_num(R["on_final_cf"].to_numpy())
    on5 = np.where(onv, np.nan_to_num(R["on_viable_area_km2"].to_numpy()) * 5 / 1000, 0)
    on5twh = np.where(onv & (oncf > 0), on5 * oncf * TWH_PER_GW_CF, 0)

    # ---------------- totals over the map cells ----------------
    cells = pd.read_csv(a.cells)["location_id"].to_numpy()
    dem = pd.read_csv(a.demand)
    mapcell = np.isin(ids, dem["location_id"].to_numpy())
    m = mapcell
    tot = lambda col: np.nansum(out[col].to_numpy()[m])
    say("\n## Totals, map cells (PWh a year; TW)")
    say(f"- onshore old best-site figure (model.js formula, identity): {on5twh[m].sum():,.5f} TWh, {on5[m].sum()/1e3:,.1f} TW")
    say(f"- onshore technical, pixel by pixel: {tot('on_tech_twh'):,.5f} TWh, {tot('on_tech_gw')/1e3:,.1f} TW")
    say(f"- onshore conservative: {tot('on_cons_twh'):,.5f} TWh, {tot('on_cons_gw')/1e3:,.1f} TW")
    say("\n| Definition | Fixed PWh | Fixed TW | Floating PWh | Floating TW | Total PWh |")
    say("|---|---|---|---|---|---|")
    for d in DEFS:
        say(f"| {d} | {tot(f'fix_{d}_twh')/1e3:,.1f} | {tot(f'fix_{d}_gw')/1e3:,.1f} | {tot(f'fl_{d}_twh')/1e3:,.1f} | "
            f"{tot(f'fl_{d}_gw')/1e3:,.1f} | {(tot(f'fix_{d}_twh') + tot(f'fl_{d}_twh'))/1e3:,.1f} |")
    say(f"\nESMAP capacity in map cells: fixed {esmap_gw['fix'][m].sum():,.1f} GW, floating {esmap_gw['fl'][m].sum():,.1f} GW; "
        f"of which without the class's atlas sea (no estimate): fixed "
        f"{esmap_gw['fix'][m & np.isnan(out['fix_esmap_twh'].to_numpy())].sum():,.1f} GW, floating "
        f"{esmap_gw['fl'][m & np.isnan(out['fl_esmap_twh'].to_numpy())].sum():,.1f} GW")
    say(f"IEA split (PWh): shallow near {tot('fix_iea_near_twh')/1e3:,.1f}, shallow far "
        f"{(tot('fix_iea_twh') - tot('fix_iea_near_twh'))/1e3:,.1f}, deep near {tot('fl_iea_near_twh')/1e3:,.1f}, "
        f"deep far {(tot('fl_iea_twh') - tot('fl_iea_near_twh'))/1e3:,.1f}  "
        f"(IEA Table A.3: 35.9, 51.2, 76.8, 257.1; total 420.9)")
    mcf = lambda d, cls: tot(f"{cls}_{d}_twh") / max(tot(f"{cls}_{d}_gw"), 1e-9) / TWH_PER_GW_CF
    say(f"capacity-weighted mean calibrated CF: ESMAP fixed {mcf('esmap','fix'):.3f}, floating {mcf('esmap','fl'):.3f}; "
        f"IEA shallow {mcf('iea','fix'):.3f}, deep {mcf('iea','fl'):.3f}")
    nonmap = np.isin(ids, cells) & ~mapcell
    say(f"cells in the Potential map file but not in demand (excluded from totals): {int(nonmap.sum())}")

    keep_cols = ["location_id", "on_cons_gw", "on_cons_twh", "on_tech_gw", "on_tech_twh",
                 "fix_esmap_gw", "fix_esmap_twh", "fl_esmap_gw", "fl_esmap_twh",
                 "fix_iea_gw", "fix_iea_twh", "fl_iea_gw", "fl_iea_twh"]
    res = out[np.isin(ids, cells)][keep_cols]
    a.out = guard(a.out)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    res.to_csv(a.out, index=False, float_format="%.6f")
    full = guard(a.results) / "potential_defs_full.csv"
    full.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(full, index=False, float_format="%.6f")
    (a.results / "potential_defs.txt").write_text("\n".join(lines) + "\n")
    say(f"\nwrote {a.out} ({len(res)} rows) and {full}")


if __name__ == "__main__":
    main()
