"""T078 (D-150): conservative case for wind technical potential, per region.

The upper bound stays today's figure (model.js windPotential: each region's eligible land at
>= 15% unscaled net CF x 5 MW/km2 x the region's own site CF; offshore ESMAP GW x the
region's offshore site CF). The conservative case applies three changes and nothing else:

  1. calibrated CF: each pixel's net CF x the region's level factor (onshore 0.879 in Europe
     by location, D-135; offshore 0.777), applied before any cut-off;
  2. onshore density 3 MW/km2 (offshore stays on ESMAP's 3-4 MW/km2);
  3. a 20% cut-off on the calibrated CF.

Every case is computed from the same 0.02 deg eligibility and GWA capacity-factor rasters as
site_selection.py (T067 inputs: land mask, WDPA, GHSL), with its own zone, loss and weight
rules, pixel by pixel. Offshore capacity is ESMAP's GW per cell (the article's basis); the
rasters give each cell's share of eligible sea above the cut-off and its mean calibrated CF.

Levers are reported one at a time, from P0 (the pixel method on today's rules):
  P0   unscaled CF, cut-off 15% onshore / none offshore, 5 MW/km2 onshore
  L1   + calibrated CF (cut-off on the calibrated CF)
  L12  + 3 MW/km2 onshore
  L123 + 20% cut-off  (= the conservative case)

Inputs are read only (ATLAS_WORKSPACE_DIR, default ~/wind-atlas-T067/ws_T067). Writes the
pixel cache under ~/wind-atlas-T078 and the per-region CSV given by --out.

Usage: python3 -I potential.py --repo <worktree> --out <csv> [--results <dir>]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

RUN_DIR = Path(os.environ.get("T078_RUN_DIR", Path.home() / "wind-atlas-T078"))
WS = Path(os.environ.get("ATLAS_WORKSPACE_DIR", Path.home() / "wind-atlas-T067" / "ws_T067"))
CLOUD = (Path.home() / "Library" / "CloudStorage").resolve()
TWH_PER_GW_CF = 8.76
LOSSES = 0.12


def guard(p: Path) -> Path:
    r = Path(p).resolve()
    if r.is_relative_to(CLOUD):
        raise SystemExit(f"refusing to write under OneDrive: {r}")
    return r


def siting(repo: Path):
    os.environ["ATLAS_WORKSPACE_DIR"] = str(WS)
    os.environ.setdefault("ATLAS_DOCS_DATA_DIR", str(RUN_DIR / "docs_unused"))
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(repo / "pipeline"))
    from scripts.pipeline.wind import site_selection as S, gwa_sources as G
    return S, G


def build_pixels(repo: Path) -> dict:
    out = guard(RUN_DIR / "cache" / "pixels_t078.npz")
    if out.exists():
        return dict(np.load(out))
    import rasterio
    from rasterio import features
    from scipy.spatial import cKDTree
    S, G = siting(repo)
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
        del band, sel
    del speed
    keep = np.float32(1.0 - LOSSES)
    area = S.pixel_area_km2()
    with open(S.CELLS_GEOJSON) as fh:
        gj = json.load(fh)
    shapes = [(f["geometry"], id_to_idx[int(f["properties"]["location_id"])] + 1)
              for f in gj["features"] if int(f["properties"]["location_id"]) in id_to_idx]
    zone_on = features.rasterize(shapes, out_shape=(G.GRID_HEIGHT, G.GRID_WIDTH),
                                 transform=G.grid_transform(), fill=0, dtype="int32", all_touched=False)
    res = {}
    with rasterio.open(S.WIND_INPUTS / "eligible_onshore_002deg.tif") as s:
        elig = s.read(1).astype("float32") / 100.0
    m = (zone_on > 0) & (elig > 0) & np.isfinite(cf)
    flat = np.flatnonzero(m)
    res["on_zone"] = (zone_on.ravel()[flat] - 1).astype("int32")
    res["on_cf"] = (cf.ravel()[flat] * keep).astype("float32")
    res["on_w"] = (elig.ravel()[flat] * area[flat // G.GRID_WIDTH]).astype("float32")
    del cf, elig, m, flat, zone_on
    cf_off = S._u16_to_float(S._read_u16("gwa4_cf_offshore_150m_002deg.tif"), 10000)
    tree = cKDTree(points[["longitude", "latitude"]].to_numpy())
    for tag, name in (("off", "eligible_offshore_002deg.tif"), ("fl", "floating_offshore_002deg.tif")):
        with rasterio.open(S.WIND_INPUTS / name) as s:
            e = s.read(1).astype("float32") / 100.0
        rows, cols = np.nonzero(e > 0)
        lat = G.GRID_NORTH - (rows + 0.5) * G.GRID_RES
        lon = G.GRID_WEST + (cols + 0.5) * G.GRID_RES
        _, nn = tree.query(np.column_stack([lon, lat]), k=1, workers=4)
        c = cf_off[rows, cols]
        w = (e[rows, cols] * area[rows]).astype("float32")
        res[f"{tag}_area_all"] = np.bincount(nn, weights=w.astype("float64"), minlength=len(points))
        ok = np.isfinite(c)                      # site_selection: (elig > 0) & finite CF
        res[f"{tag}_zone"] = nn[ok].astype("int32")
        res[f"{tag}_cf"] = (c[ok] * keep).astype("float32")
        res[f"{tag}_w"] = w[ok]
        del e, rows, cols, lat, lon, nn, c, w, ok
    res["location_id"] = points["location_id"].to_numpy()
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez(out, **res)
    print(f"pixel table {time.time()-t0:.0f}s: on {res['on_zone'].size:,} off {res['off_zone'].size:,} "
          f"floating {res['fl_zone'].size:,}")
    return res


def bc(z, x, n):
    return np.bincount(z, weights=x.astype("float64"), minlength=n)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--results", type=Path, default=None)
    a = ap.parse_args()
    px = build_pixels(a.repo)
    data = a.repo / "deployment" / "data"
    res = pd.read_csv(data / "voronoi_wind_resource.csv")
    offp = pd.read_csv(data / "voronoi_wind_potential_offshore.csv")
    dem = pd.read_csv(data / "voronoi_electricity_demand.csv")
    ids = px["location_id"]
    n = ids.size
    R = res.set_index("location_id").reindex(ids)
    O = offp.set_index("location_id").reindex(ids)
    lines = []
    say = lambda s: (print(s), lines.append(s))

    # ---------------- identity: the pixel table is site_selection's ----------------
    zon, cfo, wo = px["on_zone"], px["on_cf"].astype("float64"), px["on_w"]
    tot = bc(zon, wo, n)
    good = cfo >= 0.15
    gooda = bc(zon[good], wo[good], n)
    S, _ = siting(a.repo)
    best = S.share_mean_by_zone(zon.astype("int64"), px["on_cf"], wo, n, 0.20, 500.0)
    zf, cff, wf = px["off_zone"], px["off_cf"], px["off_w"]
    best_off = S.share_mean_by_zone(zf.astype("int64"), cff, wf, n, 0.20, 500.0)
    checks = {
        "on_area_km2": (tot, R["on_area_km2"].to_numpy()),
        "on_viable_area_km2": (gooda, R["on_viable_area_km2"].to_numpy()),
        "on_cf_best": (best, R["on_cf_best"].to_numpy()),
        "off_area_km2": (bc(zf, wf, n), R["off_area_km2"].to_numpy()),
        "off_viable_area_km2": (bc(zf[cff >= 0.15], wf[cff >= 0.15], n), R["off_viable_area_km2"].to_numpy()),
        "off_cf_best": (best_off, R["off_cf_best"].to_numpy()),
        "off_floating_area_km2": (px["fl_area_all"], R["off_floating_area_km2"].to_numpy()),
    }
    say("## Identity: pixel table vs deployed voronoi_wind_resource.csv (written %.6f)")
    ident_ok = True
    in_csv = np.isin(ids, res["location_id"].to_numpy())
    say(f"- {int(in_csv.sum())} of {n} simulation points are rows of the CSV (the rest are excluded regions)")
    for k, (mine, csv) in checks.items():
        mine, csv = np.asarray(mine, "float64")[in_csv], csv[in_csv]
        both_nan = np.isnan(mine) & np.isnan(csv)
        d = np.abs(np.round(mine, 6) - csv)
        d[both_nan] = 0
        bad = ~(d <= 1e-6)                     # NaN on one side only counts as a difference
        ident_ok &= not bad.any()
        say(f"- {k}: {int(bad.sum())} rows differ beyond the CSV's 6 dp (max abs diff {np.max(np.where(bad, 0, d)):.3g})")

    # ---------------- upper bound, model.js formula ----------------
    mapcell = np.isin(ids, dem["location_id"].to_numpy())
    onv = R["on_viable"].to_numpy() == 1
    offcf = np.nan_to_num(R["off_final_cf"].to_numpy())
    offv = (R["off_viable"].to_numpy() == 1) & (offcf > 0)
    oncf = np.nan_to_num(R["on_final_cf"].to_numpy())
    area = np.nan_to_num(R["on_viable_area_km2"].to_numpy())
    fixgw = np.nan_to_num(O["fixed_gw"].to_numpy())
    flgw = np.nan_to_num(O["floating_gw"].to_numpy())
    ub = {
        "on_gw": np.where(onv, area * 5 / 1000, 0),
    }
    ub["on_twh"] = np.where(onv & (oncf > 0), ub["on_gw"] * oncf * TWH_PER_GW_CF, 0)
    ub["fix_twh"] = np.where(offv, fixgw * offcf * TWH_PER_GW_CF, 0)
    ub["fl_twh"] = np.where(offv, flgw * offcf * TWH_PER_GW_CF, 0)
    say("\n## Upper bound (today's formula, model.js), map cells")
    for k, v in ub.items():
        say(f"- {k}: {v[mapcell].sum():.5f}")

    # ---------------- cases ----------------
    fon = R["on_level_factor"].fillna(1.0).to_numpy()
    foff = R["off_level_factor"].fillna(1.0).to_numpy()
    out = pd.DataFrame({"location_id": ids})
    out["on_level_factor"] = fon
    out["off_level_factor"] = foff
    cases = {  # name: (calibrated, onshore cut-off, offshore cut-off, onshore MW/km2)
        "p0": (False, 0.15, None, 5.0),
        "l1": (True, 0.15, None, 5.0),
        "l12": (True, 0.15, None, 3.0),
        "cons": (True, 0.20, 0.20, 3.0),
    }
    for name, (cal, cut_on, cut_off, dens) in cases.items():
        c = cfo * (fon[zon] if cal else 1.0)
        sel = c >= cut_on
        ar = bc(zon[sel], wo[sel], n)
        en = bc(zon[sel], wo[sel] * c[sel], n)           # km2 x CF
        gw = np.where(onv, ar * dens / 1000, 0)
        out[f"on_{name}_gw"] = gw
        out[f"on_{name}_twh"] = np.where(onv, en * dens / 1000 * TWH_PER_GW_CF, 0)
        for tag, egw in (("fix", fixgw), ("fl", flgw)):
            z = px["off_zone" if tag == "fix" else "fl_zone"]
            w = px["off_w" if tag == "fix" else "fl_w"]
            cc = px["off_cf" if tag == "fix" else "fl_cf"].astype("float64") * (foff[z] if cal else 1.0)
            s2 = np.ones(cc.size, bool) if cut_off is None else cc >= cut_off
            wall = bc(z, w, n)
            share = np.divide(bc(z[s2], w[s2], n), wall, out=np.zeros(n), where=wall > 0)
            mcf = np.divide(bc(z[s2], w[s2] * cc[s2], n), wall, out=np.zeros(n), where=wall > 0)  # share x mean CF
            if tag == "fl":
                # Floating capacity in a cell whose nearest-point zone holds no floating pixel takes the
                # cell's fixed-bottom sea statistics, as the upper bound uses the offshore site CF for both.
                zf2, wf2 = px["off_zone"], px["off_w"]
                cf2 = px["off_cf"].astype("float64") * (foff[zf2] if cal else 1.0)
                s3 = np.ones(cf2.size, bool) if cut_off is None else cf2 >= cut_off
                wall2 = bc(zf2, wf2, n)
                share2 = np.divide(bc(zf2[s3], wf2[s3], n), wall2, out=np.zeros(n), where=wall2 > 0)
                mcf2 = np.divide(bc(zf2[s3], wf2[s3] * cf2[s3], n), wall2, out=np.zeros(n), where=wall2 > 0)
                nofl = wall <= 0
                share = np.where(nofl, share2, share)
                mcf = np.where(nofl, mcf2, mcf)
                if name == "p0":
                    out["fl_uses_fixed_stats"] = (nofl & offv & (flgw > 0)).astype("int8")
            out[f"{tag}_{name}_gw"] = np.where(offv, egw * share, 0)
            out[f"{tag}_{name}_twh"] = np.where(offv, egw * mcf * TWH_PER_GW_CF, 0)
    a.out = guard(a.out)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(a.out, index=False, float_format="%.6f")

    m = mapcell
    say("\n## Levers, map cells (PWh/yr; TW)")
    say("| Case | Onshore PWh | Onshore TW | Fixed PWh | Fixed TW | Floating PWh | Floating TW |")
    say("|---|---|---|---|---|---|---|")
    say(f"| Upper bound (today) | {ub['on_twh'][m].sum()/1e3:,.1f} | {ub['on_gw'][m].sum()/1e3:,.1f} | "
        f"{ub['fix_twh'][m].sum()/1e3:,.1f} | {fixgw[m].sum()/1e3:,.1f} | {ub['fl_twh'][m].sum()/1e3:,.1f} | {flgw[m].sum()/1e3:,.1f} |")
    for name in cases:
        say(f"| {name} | {out[f'on_{name}_twh'][m].sum()/1e3:,.1f} | {out[f'on_{name}_gw'][m].sum()/1e3:,.1f} | "
            f"{out[f'fix_{name}_twh'][m].sum()/1e3:,.1f} | {out[f'fix_{name}_gw'][m].sum()/1e3:,.1f} | "
            f"{out[f'fl_{name}_twh'][m].sum()/1e3:,.1f} | {out[f'fl_{name}_gw'][m].sum()/1e3:,.1f} |")
    say(f"\nfloating GW on fixed-sea statistics (no floating pixel in the zone): "
        f"{flgw[m & (out['fl_uses_fixed_stats'].to_numpy() == 1)].sum():,.0f} GW of {flgw[m & offv].sum():,.0f}")
    say(f"floating GW in cells without eligible fixed sea (0 in every case, as the upper bound): "
        f"{flgw[m & ~offv].sum():,.0f} GW; fixed GW likewise {fixgw[m & ~offv].sum():,.0f} GW")
    eu = fon < 1
    say(f"onshore Europe-factor regions: {int((eu & m).sum())}")
    say(f"identity all pass: {ident_ok}")
    if a.results:
        guard(a.results).mkdir(parents=True, exist_ok=True)
        (a.results / "potential_levers.txt").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
