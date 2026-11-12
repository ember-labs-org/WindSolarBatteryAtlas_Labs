"""Crimea and Sevastopol are part of Ukraine (T079).

Natural Earth's default admin-0 edition (the "de facto" view, v5.x, which the pipeline reads as
ne_110m_admin_0_countries.shp) draws Crimea and Sevastopol inside Russia. The atlas follows
international law and UN General Assembly resolution 68/262: they are part of Ukraine.

`reassign_crimea(countries)` returns a copy of a Natural Earth admin-0 GeoDataFrame with the
Crimea polygon(s) moved from Russia to Ukraine. Every pipeline step that reads Natural Earth
admin-0 to give a cell its country must pass the layer through it straight after reading it:
voronoi_overlapping_countries.py, voronoi_wacc.py, voronoi_gas_prices.py,
voronoi_diesel_prices.py and voronoi_local_capex.py (workspace scripts/pipeline/, not in this repo):

    from ukraine_crimea import reassign_crimea
    countries = reassign_crimea(gpd.read_file(COUNTRIES_SHP))

`apply_crimea_override.py` applies the same rule to the files already in deployment/data.

Crimea and Sevastopol are taken from Natural Earth 1:10m admin-1 v5.1.1 (iso_3166_2 UA-43 and
UA-40, public domain), stored next to this file as crimea_sevastopol_ne10m.geojson.

How a Russia part is moved: a polygon part of Russia's geometry whose representative point lies
in Crimea/Sevastopol moves whole (in the 1:110m and 1:10m default editions Crimea is a separate
part, so the move is exact and leaves no slivers). If no such part exists but Russia still
overlaps Crimea, the overlap is cut out of Russia and added to Ukraine.
"""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

HERE = Path(__file__).resolve().parent
CRIMEA_FILE = HERE / "crimea_sevastopol_ne10m.geojson"

_CODE_COLS = ("ADM0_A3", "ISO_A3", "ISO_A3_EH", "SOV_A3", "GU_A3", "iso3")


def crimea_geometry():
    """Crimea + Sevastopol, EPSG:4326."""
    g = gpd.read_file(CRIMEA_FILE).to_crs("EPSG:4326")
    return unary_union(list(g.geometry))


def _row_index(countries: gpd.GeoDataFrame, iso3: str):
    for col in _CODE_COLS:
        if col in countries.columns:
            hit = countries.index[countries[col].astype(str).str.upper() == iso3]
            if len(hit) == 1:
                return hit[0]
    raise ValueError(f"no single {iso3} row in the admin-0 layer")


def _parts(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def _multi(parts):
    parts = [p for p in parts if not p.is_empty]
    if not parts:
        return MultiPolygon()
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def reassign_crimea(countries: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Copy of `countries` with Crimea and Sevastopol in Ukraine, not Russia."""
    crs = countries.crs
    reproject = crs is not None and not crs.equals("EPSG:4326")
    work = countries.to_crs("EPSG:4326") if reproject else countries.copy()
    crimea = crimea_geometry()
    ir, iu = _row_index(work, "RUS"), _row_index(work, "UKR")
    rus, ukr = work.at[ir, "geometry"], work.at[iu, "geometry"]
    keep, move = [], []
    for p in _parts(rus):
        (move if p.representative_point().within(crimea) else keep).append(p)
    if move:
        new_rus = _multi(keep)
        new_ukr = unary_union([ukr] + move)
    elif rus.intersects(crimea):
        new_rus = rus.difference(crimea)
        new_ukr = unary_union([ukr, rus.intersection(crimea)])
    else:
        return countries.copy()
    work.at[ir, "geometry"] = new_rus
    work.at[iu, "geometry"] = new_ukr
    return work.to_crs(crs) if reproject else work
