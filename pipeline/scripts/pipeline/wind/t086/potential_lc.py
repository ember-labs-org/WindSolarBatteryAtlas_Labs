"""T086: onshore wind potential without dense forest and cropland (potential-only sensitivity).

Nothing shipped changes: siting, CFs, profiles, costs and maps stay as they are. This script
recomputes onshore potential from T078's pixel table (GWA pixels, eligibility, net CF) in two
cases, each pixel by pixel:

  cons  conservative (T078, D-150): CF x the region's on_level_factor; keep >= 20%; 3 MW/km2
  tech  technical, pixel by pixel (T078's P0): unscaled net CF; keep >= 15%; 5 MW/km2

and four land variants:

  a  as today
  b  minus dense forest  (CGLS-LC100 2019 tree cover >= 50%)
  c  minus cropland      (CGLS-LC100 2019 discrete class 40)
  d  minus both          (a 100 m pixel that is either)

Land cover enters as the share f of each 0.02 deg pixel's 100 m pixels in the class
(landcover_agg.py). The atlas's eligibility is only known as a share of the 0.02 deg pixel, so
the eligible land kept is w x (1 - f): eligibility and land cover independent inside the pixel
(about 2 x 2 km). The world totals also give the two extremes: kept = max(0, w - f A) when the
class lies on eligible land first, min(w, (1 - f) A) when it lies on excluded land first.

Regions are gated as in model.js and T078 (on_viable == 1, map cells = rows of the demand file).
Countries per pixel from Natural Earth 1:10m admin-0 (Crimea and Sevastopol in Ukraine, T079);
pixels outside every polygon take their region's country. Continents from Natural Earth's
CONTINENT, with Russia split at 60 E (as D-135) and small island states ("Seven seas") kept apart.

Usage: python3 -I potential_lc.py --repo <worktree> --lc <strip dir> --ne <ne_10m_admin_0_countries.shp>
                                  --results <dir>
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

CLOUD = (Path.home() / "Library" / "CloudStorage").resolve()
RUN = Path.home() / "wind-atlas-T086"
TWH_PER_GW_CF = 8.76
DEMAND = {"IEA 2025": 28_600.0, "Ember 2025": 31_800.0}   # TWh; brief: IEA 28.6 PWh, Ember 31.8 PWh
CASES = {"cons": (True, 0.20, 3.0), "tech": (False, 0.15, 5.0)}   # calibrated, cut-off, MW/km2
VARIANTS = {"a": None, "b": "n_t50", "c": "n_crop", "d": "n_union",
            "b70": "n_closed", "b15": "n_forest15"}
LABEL = {"a": "as today", "b": "minus dense forest", "c": "minus cropland", "d": "minus both",
         "b70": "minus closed forest (>70%)", "b15": "minus all forest (>15%)"}
ROW0, ROWS = 500, 7000


def guard(p: Path) -> Path:
    r = Path(p).resolve()
    if r.is_relative_to(CLOUD):
        raise SystemExit(f"refusing to write under OneDrive: {r}")
    return r


def onshore_flat(repo: Path, px: dict) -> np.ndarray:
    """Flat grid index of every T078 onshore pixel, rebuilt with T078's own mask and checked."""
    cache = guard(RUN / "cache" / "on_flat.npy")
    if cache.exists():
        flat = np.load(cache)
    else:
        from scripts.pipeline.wind.t078 import potential as T78
        import json
        import rasterio
        from rasterio import features
        S, G = T78.siting(repo)
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
        with open(S.CELLS_GEOJSON) as fh:
            gj = json.load(fh)
        shapes = [(f["geometry"], id_to_idx[int(f["properties"]["location_id"])] + 1)
                  for f in gj["features"] if int(f["properties"]["location_id"]) in id_to_idx]
        zone_on = features.rasterize(shapes, out_shape=(G.GRID_HEIGHT, G.GRID_WIDTH),
                                     transform=G.grid_transform(), fill=0, dtype="int32", all_touched=False)
        with rasterio.open(S.WIND_INPUTS / "eligible_onshore_002deg.tif") as s:
            elig = s.read(1).astype("float32") / 100.0
        flat = np.flatnonzero((zone_on > 0) & (elig > 0) & np.isfinite(cf))
        # identity with T078's cached table, element by element
        assert np.array_equal((zone_on.ravel()[flat] - 1).astype("int32"), px["on_zone"]), "zone"
        keep = np.float32(1.0 - T78.LOSSES)
        assert np.array_equal((cf.ravel()[flat] * keep).astype("float32"), px["on_cf"]), "cf"
        area = S.pixel_area_km2()
        assert np.array_equal((elig.ravel()[flat] * area[flat // G.GRID_WIDTH]).astype("float32"), px["on_w"]), "w"
        cache.parent.mkdir(parents=True, exist_ok=True)
        np.save(cache, flat)
    assert flat.size == px["on_zone"].size
    return flat


def lc_shares(lc_dir: Path, flat: np.ndarray, width: int, say) -> dict:
    """Per onshore pixel: n_all and class counts; zero outside 80 N - 60 S."""
    files = sorted(lc_dir.glob("strip_[0-9][0-9][0-9].npz"))
    if len(files) != 280:
        raise SystemExit(f"{len(files)} of 280 land-cover strips present in {lc_dir}")
    keys = ["n_all", "n_t50", "n_crop", "n_union", "n_closed", "n_open", "n_crop_t50",
            "n_closed_t50", "n_nodata_tree"]
    full = {k: np.zeros((ROWS, width), np.uint16) for k in keys}
    for i, f in enumerate(files):
        assert f.name == f"strip_{i:03d}.npz"
        z = np.load(f)
        for k in keys:
            full[k][i * 25:(i + 1) * 25] = z[k]
    row, col = flat // width, flat % width
    inside = (row >= ROW0) & (row < ROW0 + ROWS)
    out = {}
    for k in keys:
        v = np.zeros(flat.size, np.float64)
        v[inside] = full[k][row[inside] - ROW0, col[inside]]
        out[k] = v
    out["n_forest15"] = out["n_closed"] + out["n_open"]
    out["inside"] = inside
    cl = full["n_closed"].sum(dtype=np.int64)
    say(f"- closed forest (>70%) 100 m pixels with tree cover >= 50%: "
        f"{full['n_closed_t50'].sum(dtype=np.int64) / cl:.4f} of {cl:,}")
    say(f"- cropland 100 m pixels with tree cover >= 50% (counted once in 'both'): "
        f"{full['n_crop_t50'].sum(dtype=np.int64) / full['n_crop'].sum(dtype=np.int64):.4f}")
    say(f"- tree-cover no-data pixels on onshore atlas pixels: {out['n_nodata_tree'].sum() / out['n_all'].sum():.5f} of all")
    return out


def countries(repo: Path, ne: Path, G, flat, zone, ids, say):
    import geopandas as gpd
    from rasterio import features
    sys.path.insert(0, str(repo / "pipeline" / "scripts" / "country_overrides"))
    from ukraine_crimea import reassign_crimea
    from apply_crimea_override import coalesce_iso3
    cdf = reassign_crimea(gpd.read_file(ne))
    cdf["iso3"] = [coalesce_iso3(r) for _, r in cdf.iterrows()]
    cdf = cdf[cdf["iso3"].notna()].reset_index(drop=True)
    shapes = [(g, i + 1) for i, g in enumerate(cdf.geometry) if g is not None and not g.is_empty]
    ras = features.rasterize(shapes, out_shape=(G.GRID_HEIGHT, G.GRID_WIDTH), transform=G.grid_transform(),
                             fill=0, dtype="int32", all_touched=False)
    k = ras.ravel()[flat] - 1
    del ras
    iso = np.where(k >= 0, cdf["iso3"].to_numpy()[np.maximum(k, 0)], None).astype(object)
    cont = np.where(k >= 0, cdf["CONTINENT"].to_numpy()[np.maximum(k, 0)], None).astype(object)
    # Several Natural Earth rows can share one code (e.g. Ashmore and Cartier Is. -> AUS, Baikonur ->
    # KAZ): name and continent come from the row whose own ADM0_A3 is the code, else the first row.
    main = cdf.assign(_own=(cdf["ADM0_A3"] == cdf["iso3"]).astype(int)).sort_values("_own", ascending=False)
    main = main.drop_duplicates("iso3")
    cont_of = dict(zip(main["iso3"], main["CONTINENT"]))
    oc = pd.read_csv(repo / "deployment" / "data" / "voronoi_overlapping_countries.csv").set_index("location_id")
    name = dict(zip(main["iso3"], main["NAME"]))
    name.update(dict(zip(oc["country_iso3"], oc["country_name"])))     # the app's own names win
    prim = oc["country_iso3"].reindex(ids).to_numpy()[zone]
    miss = k < 0
    iso[miss] = prim[miss]
    cont[miss] = [cont_of.get(x) for x in prim[miss]]
    lon = -180 + (flat % G.GRID_WIDTH + 0.5) * G.GRID_RES
    cont[(iso == "RUS") & (lon >= 60)] = "Asia"
    cont[(iso == "RUS") & (lon < 60)] = "Europe"
    cont = np.where(cont == "Seven seas (open ocean)", "Island states", cont)
    cont = np.where(pd.isna(cont), "Unassigned", cont).astype(object)
    iso = np.where(pd.isna(iso), "---", iso).astype(object)
    say(f"- onshore pixels outside every Natural Earth polygon (region's country used): {int(miss.sum()):,} of {flat.size:,}")
    return iso, cont, name


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--lc", type=Path, required=True)
    ap.add_argument("--ne", type=Path, required=True)
    ap.add_argument("--results", type=Path, required=True)
    a = ap.parse_args()
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(a.repo / "pipeline"))
    from scripts.pipeline.wind.t078 import potential as T78
    S, G = T78.siting(a.repo)
    lines = []
    say = lambda s: (print(s, flush=True), lines.append(s))
    px = T78.build_pixels(a.repo)            # T078's cached pixel table
    say("# T086 onshore potential without dense forest and cropland\n\n## Inputs and checks")
    flat = onshore_flat(a.repo, px)
    say(f"- onshore pixels: {flat.size:,}; flat index rebuilt with T078's mask and equal to its table (zone, CF, weight)")
    zon, cf0, w = px["on_zone"].astype(np.int64), px["on_cf"].astype(np.float64), px["on_w"].astype(np.float64)
    ids = px["location_id"]
    n = ids.size
    data = a.repo / "deployment" / "data"
    R = pd.read_csv(data / "voronoi_wind_resource.csv").set_index("location_id").reindex(ids)
    dem = pd.read_csv(data / "voronoi_electricity_demand.csv")
    onv = R["on_viable"].to_numpy() == 1
    mapcell = np.isin(ids, dem["location_id"].to_numpy())
    gate = (onv & mapcell)[zon]
    fon = R["on_level_factor"].fillna(1.0).to_numpy()
    A = S.pixel_area_km2().astype(np.float64)[flat // G.GRID_WIDTH]
    lc = lc_shares(a.lc, flat, G.GRID_WIDTH, say)
    nall = lc["n_all"]
    share = {v: (np.zeros(flat.size) if key is None else
                 np.divide(lc[key], nall, out=np.zeros(flat.size), where=nall > 0))
             for v, key in VARIANTS.items()}
    say(f"- eligible onshore land outside the CGLS extent (north of 80 N or south of 60 S), map cells, viable: "
        f"{w[gate & ~lc['inside']].sum():,.0f} km2 of {w[gate].sum():,.0f} km2 (no exclusion applied)")
    for v in ("b", "c", "d", "b70", "b15"):
        say(f"- eligible land (viable map cells) in class '{LABEL[v]}': {(w * share[v])[gate].sum() / w[gate].sum():.1%}")
    iso, cont, names = countries(a.repo, a.ne, G, flat, zon, ids, say)

    # ---------------- per pixel energy and capacity ----------------
    rows = {}
    reg = pd.DataFrame({"location_id": ids})
    t78 = pd.read_csv(Path(T78.__file__).parent / "results" / "wind_potential_levers.csv").set_index("location_id").reindex(ids)
    for cname, (cal, cut, dens) in CASES.items():
        c = cf0 * (fon[zon] if cal else 1.0)
        sel = gate & (c >= cut)
        for v in VARIANTS:
            kept = w * (1 - share[v])
            gw = np.where(sel, kept * dens / 1000, 0.0)
            twh = gw * c * TWH_PER_GW_CF
            rows[(cname, v)] = (gw, twh)
            reg[f"on_{cname}_{v}_gw"] = np.bincount(zon, gw, n)
            reg[f"on_{cname}_{v}_twh"] = np.bincount(zon, twh, n)
            if v in ("b", "c", "d"):
                f = share[v]
                for tag, kk in (("lo", np.maximum(0, w - f * A)), ("hi", np.minimum(w, (1 - f) * A))):
                    g2 = np.where(sel, kk * dens / 1000, 0.0)
                    rows[(cname, v + tag)] = (g2, g2 * c * TWH_PER_GW_CF)
        # identity with T078 per region (case a)
        col = "cons" if cname == "cons" else "p0"
        for q in ("gw", "twh"):
            mine = reg[f"on_{cname}_a_{q}"].to_numpy()
            ref = np.where(mapcell, t78[f"on_{col}_{q}"].fillna(0).to_numpy(), 0)
            mine = np.where(mapcell, mine, 0)
            d = np.abs(mine - ref).max()
            say(f"- identity {cname} (a) {q} vs T078 on_{col}_{q}, per region: max abs diff {d:.2e}")
            assert d < 1e-5 * max(1.0, np.abs(ref).max()), "case (a) does not reproduce T078"

    # ---------------- tables ----------------
    def tot(key, m=None):
        gw, twh = rows[key]
        return (gw.sum(), twh.sum()) if m is None else (gw[m].sum(), twh[m].sum())

    say("\n## World, map cells (PWh a year; TW; multiple of world demand)")
    say("| Case | Land | PWh/yr | TW | change | × 28.6 PWh (IEA 2025) | × 31.8 PWh (Ember 2025) | range if not independent (PWh) |")
    say("|---|---|---|---|---|---|---|---|")
    world = []
    for cname in CASES:
        base = tot((cname, "a"))[1]
        for v in VARIANTS:
            gw, twh = tot((cname, v))
            rng = ""
            if (cname, v + "lo") in rows:
                rng = f"{tot((cname, v + 'lo'))[1] / 1e3:,.0f}–{tot((cname, v + 'hi'))[1] / 1e3:,.0f}"
            say(f"| {cname} | {LABEL[v]} | {twh / 1e3:,.1f} | {gw / 1e3:,.1f} | {twh / base - 1:+.1%} | "
                f"{twh / DEMAND['IEA 2025']:.1f}× | {twh / DEMAND['Ember 2025']:.1f}× | {rng} |")
            world.append({"case": cname, "variant": v, "label": LABEL[v], "twh": twh, "gw": gw,
                          "x_iea2025": twh / DEMAND["IEA 2025"], "x_ember2025": twh / DEMAND["Ember 2025"]})

    def group_table(keys, labels, title, order):
        say(f"\n## {title} (PWh a year; change from 'as today')")
        say("| | Cons. today | − forest | − cropland | − both | Tech. today | − forest | − cropland | − both |")
        say("|---|---|---|---|---|---|---|---|---|")
        recs = []
        for g in order:
            m = keys == g
            vals = []
            rec = {"group": g, "label": labels.get(g, g)}
            for cname in CASES:
                base = tot((cname, "a"), m)[1]
                for v in ("a", "b", "c", "d"):
                    gw, twh = tot((cname, v), m)
                    rec[f"{cname}_{v}_twh"], rec[f"{cname}_{v}_gw"] = twh, gw
                    vals.append(f"{twh / 1e3:,.1f}" if v == "a" else
                                f"{twh / 1e3:,.1f} ({(twh / base - 1) if base > 0 else 0:+.0%})")
            say(f"| {labels.get(g, g)} | " + " | ".join(vals) + " |")
            recs.append(rec)
        return recs

    conts = pd.Series(rows[("cons", "a")][1]).groupby(cont).sum().sort_values(ascending=False).index.tolist()
    cont_recs = group_table(cont, {}, "By continent", conts)
    top = pd.Series(rows[("cons", "a")][1]).groupby(iso).sum().sort_values(ascending=False).index[:15].tolist()
    ctry_recs = group_table(iso, names, "15 largest countries by conservative potential today", top)
    say(f"\nThe 15 hold {sum(r['cons_a_twh'] for r in ctry_recs) / tot(('cons', 'a'))[1]:.0%} of conservative "
        f"and {sum(r['tech_a_twh'] for r in ctry_recs) / tot(('tech', 'a'))[1]:.0%} of technical potential.")

    res = guard(a.results)
    res.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(world).to_csv(res / "world.csv", index=False, float_format="%.3f")
    pd.DataFrame(cont_recs).to_csv(res / "continents.csv", index=False, float_format="%.3f")
    pd.DataFrame(ctry_recs).to_csv(res / "countries_top15.csv", index=False, float_format="%.3f")
    reg[mapcell].to_csv(res / "regions.csv", index=False, float_format="%.6f")
    (res / "potential_lc.txt").write_text("\n".join(lines) + "\n")
    say(f"\nwrote {res}")


if __name__ == "__main__":
    main()
