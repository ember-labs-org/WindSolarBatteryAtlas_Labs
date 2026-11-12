#!/usr/bin/env python3
"""T079: apply "Crimea and Sevastopol are part of Ukraine" to the files in deployment/data.

The workspace country steps (voronoi_overlapping_countries.py and the WACC, gas, diesel and capex
scripts) join cells to Natural Earth 1:110m admin-0, whose default edition puts Crimea in Russia.
This script redoes their country step with that layer passed through
ukraine_crimea.reassign_crimea, and rewrites only the rows whose country changes:

1. voronoi_overlapping_countries.csv – for every cell that touches Crimea/Sevastopol, the primary
   country (the one holding the cell centroid, EPSG:3857 centroid as upstream) and the list of
   overlapping countries (EPSG:6933 areas, 2% sliver filter, primary first) are recomputed exactly
   as the upstream script does. Before writing, the same code on the uncorrected layer must
   reproduce the shipped rows (fidelity check).
2. Cells whose primary country changes take their country-level values by the rule the other
   cells of the new country follow:
   * voronoi_gas_prices.csv, voronoi_diesel_prices.csv: every column after the coordinates is the
     country's own price row (source "country", distance 0), the tuple all of that country's
     other cells carry;
   * voronoi_local_capex.csv: country_iso3, country_name, region, region_method, capex_source,
     solar_*, battery_* – the tuple the country's other cells carry (as fix_local_capex.py);
   the script stops if the country's other cells do not agree on one tuple.
3. Then run scripts/wind_costs/build_wind_costs.py, which keys WACC (solar, onshore, offshore),
   wind capex and O&M on the overlapping-countries country. Site terms (offshore depth, shore
   distance, class) and every non-country file are untouched; wind capacity factors do not
   depend on the country assignment (the Europe level factor is by location, D-135).

Every other line keeps its bytes. Idempotent.

  python3 -I pipeline/scripts/country_overrides/apply_crimea_override.py \
      --cells <workspace>/outputs/voronoi_cells.geojson \
      --admin0 <workspace>/input_data/ne_110m_admin_0_countries.shp
  python3 scripts/wind_costs/build_wind_costs.py

Run it after any step that rewrites these files from the workspace, and before
pipeline/scripts/exclude_regions/apply_exclusion.py.
"""
from __future__ import annotations

import argparse
import csv
import io
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ROOT = HERE.parents[2]
DATA = ROOT / "deployment" / "data"

import geopandas as gpd  # noqa: E402
import pandas as pd  # noqa: E402

from ukraine_crimea import crimea_geometry, reassign_crimea  # noqa: E402

EQUAL_AREA_CRS = "EPSG:6933"
MIN_AREA_FRACTION = 0.02
ISO_COLS = ("ISO_A3", "ISO_A3_EH", "ADM0_A3")
CAPEX_COUNTRY_COLS = ["country_iso3", "country_name", "region", "region_method", "capex_source",
                      "solar_2024", "solar_2035", "solar_2050",
                      "battery_2024", "battery_2035", "battery_2050"]


def coalesce_iso3(row) -> str | None:
    for col in ISO_COLS:
        value = str(row.get(col, "") or "").strip().upper()
        if value and value != "-99" and len(value) == 3:
            return value
    return None


def overlapping(cells: gpd.GeoDataFrame, countries: gpd.GeoDataFrame) -> dict[int, dict]:
    """Upstream voronoi_overlapping_countries.py, restricted to `cells`."""
    countries = countries.to_crs("EPSG:4326").copy()
    countries["iso3"] = countries.apply(coalesce_iso3, axis=1)
    countries = countries[["iso3", "NAME", "geometry"]].rename(columns={"NAME": "name"})
    cen = cells[["location_id", "geometry"]].to_crs("EPSG:3857")
    cen["geometry"] = cen.geometry.centroid
    cen = cen.to_crs("EPSG:4326")
    prim = gpd.sjoin(cen, countries, how="left", predicate="within")
    prim = prim[~prim["location_id"].duplicated(keep="first")]
    p_name = dict(zip(prim["location_id"], prim["name"]))
    p_iso = dict(zip(prim["location_id"], prim["iso3"]))
    ea = cells[["location_id", "geometry"]].to_crs(EQUAL_AREA_CRS)
    ea["cell_area"] = ea.geometry.area
    area = dict(zip(ea["location_id"], ea["cell_area"]))
    pieces = gpd.overlay(ea[["location_id", "geometry"]], countries.to_crs(EQUAL_AREA_CRS),
                         how="intersection", keep_geom_type=True)
    pieces["overlap_area"] = pieces.geometry.area
    agg = (pieces.groupby(["location_id", "name"], dropna=False)
           .agg(overlap_area=("overlap_area", "sum"), iso3=("iso3", "first")).reset_index())
    agg["area_frac"] = agg["overlap_area"] / agg["location_id"].map(area)
    agg = agg[agg["name"].notna() & (agg["area_frac"] >= MIN_AREA_FRACTION)]
    agg = agg.sort_values(["location_id", "overlap_area"], ascending=[True, False])
    out = {}
    for lid in cells["location_id"]:
        g = agg[agg["location_id"] == lid]
        names, isos = list(g["name"]), [i if isinstance(i, str) else "" for i in g["iso3"]]
        pn, pi = p_name.get(lid), p_iso.get(lid)
        if isinstance(pn, str) and pn:
            if pn in names:
                i = names.index(pn)
                names.insert(0, names.pop(i))
                isos.insert(0, isos.pop(i))
            else:
                names.insert(0, pn)
                isos.insert(0, pi if isinstance(pi, str) else "")
        out[int(lid)] = {"country_iso3": isos[0] if isos and isos[0] else "",
                         "country_name": names[0] if names else "",
                         "country_names": "|".join(names), "country_iso3s": "|".join(isos),
                         "country_count": str(len(names))}
    return out


def read(path: Path):
    with open(path, newline="") as f:
        text = f.read()
    lines = text.splitlines(keepends=True)
    header = next(csv.reader([lines[0]]))
    rows = {}
    for i, line in enumerate(lines[1:], start=1):
        rec = next(csv.reader([line]))
        rows[int(rec[0])] = (i, rec)
    return lines, header, rows


def line_of(rec, eol: str) -> str:
    buf = io.StringIO()
    csv.writer(buf, lineterminator=eol).writerow(rec)
    return buf.getvalue()


def rewrite(path: Path, changes: dict[int, dict[str, str]]) -> list[str]:
    """Set columns per location_id; keep every other line's bytes. Returns a log."""
    lines, header, rows = read(path)
    log = []
    for lid, cols in changes.items():
        if lid not in rows:
            continue
        i, rec = rows[lid]
        new = list(rec)
        for c, v in cols.items():
            new[header.index(c)] = v
        if new != rec:
            eol = "\r\n" if lines[i].endswith("\r\n") else "\n"
            lines[i] = line_of(new, eol)
            diff = [f"{c}: {rec[header.index(c)]} -> {v}" for c, v in cols.items() if rec[header.index(c)] != v]
            log.append(f"{path.name} {lid}: " + "; ".join(diff))
    if log:
        with open(path, "w", newline="") as f:
            f.write("".join(lines))
    return log


def country_tuple(path: Path, iso3: str, cols: list[str], exclude: set[int], key="country_iso3",
                  where=None) -> list[str]:
    _, header, rows = read(path)
    seen = Counter()
    for lid, (_, rec) in rows.items():
        if lid in exclude or rec[header.index(key)] != iso3:
            continue
        if where and not where(dict(zip(header, rec))):
            continue
        seen[tuple(rec[header.index(c)] for c in cols)] += 1
    if len(seen) != 1:
        raise SystemExit(f"{path.name}: {iso3} cells disagree on {cols}: {seen.most_common(3)}")
    return list(next(iter(seen)))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cells", type=Path, required=True, help="workspace outputs/voronoi_cells.geojson")
    ap.add_argument("--admin0", type=Path, required=True, help="ne_110m_admin_0_countries.shp (default edition)")
    ap.add_argument("--data", type=Path, default=DATA)
    a = ap.parse_args()

    cells = gpd.read_file(a.cells)
    cells = cells.set_crs("EPSG:4326") if cells.crs is None else cells.to_crs("EPSG:4326")
    cells["location_id"] = cells["location_id"].astype(int)
    crimea = crimea_geometry()
    touch = cells[cells.intersects(crimea)].copy()
    oc_path = a.data / "voronoi_overlapping_countries.csv"
    _, oc_header, oc_rows = read(oc_path)
    touch = touch[touch["location_id"].isin(oc_rows)]  # cells still in the atlas (T057)
    print(f"cells touching Crimea/Sevastopol: {sorted(touch['location_id'])}")

    raw = gpd.read_file(a.admin0)
    fixed = reassign_crimea(raw)
    before, after = overlapping(touch, raw), overlapping(touch, fixed)
    cols = ["country_iso3", "country_name", "country_names", "country_iso3s", "country_count"]
    for lid, rec_before in before.items():
        rec = dict(zip(oc_header, oc_rows[lid][1]))
        shipped = {c: rec[c] for c in cols}
        if shipped != rec_before and shipped != after[lid]:
            raise SystemExit(f"fidelity check failed for {lid}: shipped {shipped} vs upstream rule {rec_before}")
    changed_primary = {lid: r["country_iso3"] for lid, r in after.items()
                       if dict(zip(oc_header, oc_rows[lid][1]))["country_iso3"] != r["country_iso3"]
                       or before[lid]["country_iso3"] != r["country_iso3"]}
    log = rewrite(oc_path, after)

    moved = set(changed_primary)
    for lid, iso in changed_primary.items():
        if iso != "UKR":
            raise SystemExit(f"cell {lid} would move to {iso}, not UKR")
    for name in ("voronoi_gas_prices.csv", "voronoi_diesel_prices.csv"):
        path = a.data / name
        _, header, _ = read(path)
        cc = header[3:]
        ch = {}
        for lid, iso in changed_primary.items():
            vals = country_tuple(path, iso, cc, moved,
                                 where=lambda r: all(r.get(k, "country") == "country" for k in header if k.endswith("_source"))
                                 and all(r.get(k, "0.0") in ("0.0", "0") for k in header if k.endswith("distance_km")))
            ch[lid] = dict(zip(cc, vals))
        log += rewrite(path, ch)
    path = a.data / "voronoi_local_capex.csv"
    ch = {lid: dict(zip(CAPEX_COUNTRY_COLS, country_tuple(path, iso, CAPEX_COUNTRY_COLS, moved)))
          for lid, iso in changed_primary.items()}
    log += rewrite(path, ch)
    print("\n".join(log) if log else "no change (already applied)")
    print("now run: python3 scripts/wind_costs/build_wind_costs.py")


if __name__ == "__main__":
    main()
