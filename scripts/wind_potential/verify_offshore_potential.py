#!/usr/bin/env python3
"""Checks for deployment/data/voronoi_wind_potential_offshore.csv (T031). Read-only on deployment/.

1. totals: cells vs ESMAP polygons vs ESMAP country file
2. country spot checks: (a) EEZ sums from out/cell_eez.csv vs the country file; (b) cells whose
   atlas country is X (voronoi_overlapping_countries.csv) vs ESMAP's figure for X's own EEZs
3. hand cells: each cell rebuilt independently (convex clipping by perpendicular bisectors, pure
   Python), ESMAP pieces measured with geodesic area (pyproj.Geod) instead of EPSG:6933
4. zoom sensitivity: the app rounds sites to whole pixels at the current zoom; per-cell change
   against the committed (unrounded) file
5. context: the pipeline's own cell areas (zone_area_km2) and offshore areas against these cells

Writes scripts/wind_potential/out/verify_*.csv and prints a summary.
Usage: python3 scripts/wind_potential/verify_offshore_potential.py --cache DIR [--skip-zoom]
"""
import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import shapely
from pyproj import Geod
from shapely.geometry import box, shape

sys.path.insert(0, str(Path(__file__).resolve().parent))   # also under python -I
import build_offshore_potential as B  # noqa: E402

GEOD = Geod(ellps='WGS84')
# Atlas country (ISO3) -> ESMAP territories that are that country's own EEZs (country-file names).
SPOT = {
    'GBR': ['United Kingdom'], 'NLD': ['Netherlands'], 'DEU': ['Germany'], 'NOR': ['Norway'],
    'USA': ['United States', 'Alaska (US)', 'Hawaii'], 'CHN': ['China'], 'JPN': ['Japan'],
    'IND': ['India'], 'BRA': ['Brazil'], 'AUS': ['Australia'], 'VNM': ['Vietnam'], 'ZAF': ['South Africa'],
    'MEX': ['Mexico'], 'PHL': ['Philippines'], 'CAN': ['Canada'], 'ARG': ['Argentina'],
}


def f(x):
    return float(x) if x not in ('', None) else 0.0


def read_cells():
    return {r['location_id']: r for r in B.read_csv(B.OUT_CSV)}


# ---------------------------------------------------------------- 1. totals

def check_totals(cells, cache, manifest):
    xlsx, _ = B.load_country_xlsx(cache / next(m['file'] for m in manifest if m['role'] == 'country_xlsx'))
    tot = {r['kind']: r for r in B.read_csv(B.OUT / 'totals.csv')}
    rows = []
    for kind in B.KINDS:
        csv_sum = math.fsum(f(c[f'{kind}_gw']) for c in cells.values())
        cls_sum = math.fsum(f(c[f'{kind}_{w}_gw']) for c in cells.values() for w in B.CLASSES)
        cf = math.fsum(v for (reg, k, kk), v in xlsx.items() if kk == kind)
        rows.append({'kind': kind, 'cells_csv_gw': round(csv_sum, 3), 'cells_csv_by_class_gw': round(cls_sum, 3),
                     'polygon_gw': tot[kind]['polygon_gw'], 'country_file_gw': round(cf, 3),
                     'cells_minus_polygons_gw': round(csv_sum - float(tot[kind]['polygon_gw']), 3),
                     'cells_minus_country_file_gw': round(csv_sum - cf, 3),
                     'cells_vs_country_file_pct': round(100 * (csv_sum / cf - 1), 3),
                     'cells_with_potential': sum(1 for c in cells.values() if f(c[f'{kind}_gw']) > 0)})
    B.write_csv(B.OUT / 'verify_totals.csv', list(rows[0].keys()), rows)
    return rows


# ---------------------------------------------------------------- 2. country spot checks

def check_countries(cells, cache, manifest):
    xlsx, xnames = B.load_country_xlsx(cache / next(m['file'] for m in manifest if m['role'] == 'country_xlsx'))
    # country-file GW per territory name
    terr_cf = defaultdict(float)
    for (reg, key, kind), v in xlsx.items():
        terr_cf[(xnames[(reg, key)][1], kind)] += v
    # cell_eez sums per territory
    terr_cells = defaultdict(float)
    for r in B.read_csv(B.OUT / 'cell_eez.csv'):
        terr_cells[(r['territory'], r['kind'])] += float(r['gw'])
    country = {r['location_id']: r['country_iso3'] for r in B.read_csv(B.DATA / 'voronoi_overlapping_countries.csv')}
    rows = []
    for iso, terrs in SPOT.items():
        for kind in B.KINDS:
            cf = math.fsum(terr_cf.get((t, kind), 0.0) for t in terrs)
            eez = math.fsum(terr_cells.get((t, kind), 0.0) for t in terrs)
            in_country = math.fsum(f(c[f'{kind}_gw']) for lid, c in cells.items() if country.get(lid) == iso)
            rows.append({'iso3': iso, 'territories': '; '.join(terrs), 'kind': kind,
                         'country_file_gw': round(cf, 2), 'cells_eez_gw': round(eez, 2),
                         'eez_minus_country_file_gw': round(eez - cf, 2),
                         'cells_in_atlas_country_gw': round(in_country, 2),
                         'atlas_country_vs_country_file_pct': round(100 * (in_country / cf - 1), 1) if cf else ''})
    B.write_csv(B.OUT / 'verify_countries.csv', list(rows[0].keys()), rows)
    return rows


# ---------------------------------------------------------------- 3. hand cells

def clip_halfplane(poly, a, b, c):
    """Sutherland-Hodgman: keep the part of a convex polygon (list of (x, y)) where a*x + b*y <= c."""
    out = []
    n = len(poly)
    for i in range(n):
        p, q = poly[i], poly[(i + 1) % n]
        fp, fq = a * p[0] + b * p[1] - c, a * q[0] + b * q[1] - c
        if fp <= 0:
            out.append(p)
        if (fp < 0 < fq) or (fq < 0 < fp):
            t = fp / (fp - fq)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


def independent_cell(xy, i):
    """Voronoi cell of site i by clipping the world square with every bisector that can matter."""
    h = B.HALF_WORLD
    poly = [(-h, -h), (h, -h), (h, h), (-h, h)]
    xi, yi = xy[i]
    d2 = (xy[:, 0] - xi) ** 2 + (xy[:, 1] - yi) ** 2
    for j in np.argsort(d2, kind='stable'):
        if j == i:
            continue
        rmax2 = max((px - xi) ** 2 + (py - yi) ** 2 for px, py in poly)
        if d2[j] > 4 * rmax2:          # bisector lies beyond the current cell: no later site can cut it
            break
        xj, yj = xy[j]
        a, b = xj - xi, yj - yi
        c = (xj * xj + yj * yj - xi * xi - yi * yi) / 2
        poly = clip_halfplane(poly, a, b, c)
    return shapely.Polygon(poly)


def geod_km2(geom_lonlat):
    return abs(GEOD.geometry_area_perimeter(geom_lonlat)[0]) / 1e6


def merc_to_lonlat_dense(g):
    return shapely.transform(shapely.segmentize(g, B.MERC_STEP_M), B.merc_inv)


def pick_hand_cells(cells):
    rows = list(cells.values())
    by = lambda k: max(rows, key=lambda r: f(r[k]))['location_id']
    picks = {by('fixed_gw'), by('floating_gw'), by('fixed_ws7_gw')}
    def nearest(lat, lon):
        return min(rows, key=lambda r: (f(r['latitude']) - lat) ** 2 + (f(r['longitude']) - lon) ** 2)['location_id']
    picks |= {nearest(53.5, 3.0),       # southern North Sea
              nearest(52.9, 173.2),     # nearest site to Attu (a Chukotka cell; no Aleutian site)
              nearest(-17.8, 178.0),    # Fiji: polygons split at the antimeridian
              nearest(18.2, -66.5),     # Puerto Rico: LAC polygon areas from UTM 16N
              nearest(23.5, 120.0)}     # Taiwan Strait
    return sorted(picks, key=int)


def check_hand_cells(cells, cache, manifest, sites):
    xy = B.site_xy(sites)
    index = {s['location_id']: i for i, s in enumerate(sites)}
    recs = B.screen(B.load_polygons(cache, manifest))
    whole_geod = {}
    rows = []
    gcells, _ = B.build_cells(xy)
    for lid in pick_hand_cells(cells):
        i = index[lid]
        cell = independent_cell(xy, i)
        geos_cell = gcells[i]
        sym = shapely.area(shapely.symmetric_difference(cell, geos_cell)) / shapely.area(cell)
        cell_ll_bounds = shapely.transform(shapely.segmentize(cell, B.MERC_STEP_M), B.merc_inv).bounds
        acc = defaultdict(float)
        for ri, r in enumerate(recs):
            if r['duplicate_of'] is not None:
                continue
            for p in r['parts']:
                x0, y0, x1, y1 = p.bounds
                if x1 < cell_ll_bounds[0] or x0 > cell_ll_bounds[2] or y1 < cell_ll_bounds[1] or y0 > cell_ll_bounds[3]:
                    continue
                pm = shapely.transform(shapely.segmentize(p, B.LONLAT_STEP_DEG), B.merc)
                piece = shapely.intersection(pm, cell)
                if piece.is_empty or piece.area == 0:
                    continue
                if ri not in whole_geod:
                    whole_geod[ri] = math.fsum(geod_km2(q) for q in r['parts'])
                cap = r['gw'] if not r['dropped'] else min(r['gw'], r['gw'] * whole_geod[ri] / r['area_skm'])
                a = geod_km2(merc_to_lonlat_dense(piece))
                acc[(r['kind'], 'gw')] += cap * a / whole_geod[ri]
                acc[(r['kind'], 'area')] += a
        c = cells[lid]
        row = {'location_id': lid, 'latitude': c['latitude'], 'longitude': c['longitude'],
               'cell_symdiff_share': f'{sym:.2e}'}
        for kind in B.KINDS:
            row[f'{kind}_gw_csv'] = c[f'{kind}_gw']
            row[f'{kind}_gw_hand'] = f'{acc[(kind, "gw")]:.4f}'
            row[f'{kind}_area_csv'] = c[f'{kind}_area_km2']
            row[f'{kind}_area_hand'] = f'{acc[(kind, "area")]:.2f}'
        rows.append(row)
    B.write_csv(B.OUT / 'verify_hand_cells.csv', list(rows[0].keys()), rows)
    return rows


# ---------------------------------------------------------------- 4. zoom sensitivity

def check_zoom(cells, cache, sites, zooms):
    rows = []
    base = {k: np.array([f(cells[s['location_id']][f'{k}_gw']) for s in sites]) for k in B.KINDS}
    for z in zooms:
        res = B.run(cache, zoom=z)
        zr = {r['location_id']: r for r in B.cell_rows(res)}
        row = {'zoom': z, 'pixel_km_at_equator': round(2 * math.pi * B.R / (256 * 2 ** z) / 1000, 2),
               'coincident_sites': res['dup']}
        for k in B.KINDS:
            other = np.array([f(zr[s['location_id']][f'{k}_gw']) for s in sites])
            d = np.abs(other - base[k])
            row[f'{k}_moved_gw'] = round(float(0.5 * d.sum()), 2)
            row[f'{k}_moved_pct'] = round(float(100 * 0.5 * d.sum() / base[k].sum()), 3)
            row[f'{k}_max_cell_change_gw'] = round(float(d.max()), 3)
            row[f'{k}_cells_with_potential'] = int(np.sum((base[k] > 0) | (other > 0)))
            row[f'{k}_cells_changed_over_5pct'] = int(np.sum(d > 0.05 * np.maximum(base[k], other)))
        rows.append(row)
    B.write_csv(B.OUT / 'verify_zoom.csv', list(rows[0].keys()), rows)
    return rows


# ---------------------------------------------------------------- 5. context against the pipeline

def check_pipeline(cells, sites):
    xy = B.site_xy(sites)
    gcells, _ = B.build_cells(xy)
    world = json.load(open(B.DATA / 'world.geojson', encoding='utf-8'))
    land = [q for ft in world['features'] for q in B.polygons_of(shapely.make_valid(shape(ft['geometry'])))]
    land_m = shapely.transform(shapely.segmentize(np.array(land, dtype=object), B.LONLAT_STEP_DEG * 10), B.merc)
    cells_arr = np.array(list(gcells), dtype=object)
    li, ci = shapely.STRtree(cells_arr).query(land_m, predicate='intersects')
    piece_area = B.equal_area_km2(shapely.intersection(land_m[li], cells_arr[ci]))
    land_area = np.zeros(len(cells_arr))
    np.add.at(land_area, ci, piece_area)
    pv = {r['location_id']: f(r['zone_area_km2']) for r in B.read_csv(B.SITES_CSV)}
    wr = {r['location_id']: r for r in B.read_csv(B.DATA / 'voronoi_wind_resource.csv')}
    rows = []
    for i, s in enumerate(sites):
        lid = s['location_id']
        w = wr.get(lid, {})
        rows.append({'location_id': lid, 'zone_area_km2': f'{pv[lid]:.1f}', 'cell_land_km2_world_geojson': f'{land_area[i]:.1f}',
                     'pipeline_off_area_km2': w.get('off_area_km2', ''), 'pipeline_off_floating_area_km2': w.get('off_floating_area_km2', ''),
                     'esmap_fixed_area_km2': cells[lid]['fixed_area_km2'], 'esmap_floating_area_km2': cells[lid]['floating_area_km2']})
    B.write_csv(B.OUT / 'verify_pipeline_context.csv', list(rows[0].keys()), rows)
    ratios = sorted(float(r['cell_land_km2_world_geojson']) / float(r['zone_area_km2'])
                    for r in rows if float(r['zone_area_km2']) > 1000)
    q = lambda p: round(ratios[min(int(p * len(ratios)), len(ratios) - 1)], 4)
    corr_fixed = np.corrcoef([f(r['pipeline_off_area_km2']) for r in rows], [f(r['esmap_fixed_area_km2']) for r in rows])[0, 1]
    corr_float = np.corrcoef([f(r['pipeline_off_floating_area_km2']) for r in rows], [f(r['esmap_floating_area_km2']) for r in rows])[0, 1]
    return {'land_ratio_q05_q50_q95': (q(0.05), q(0.5), q(0.95)), 'n_ratio_cells': len(ratios),
            'sum_zone_area': round(sum(pv.values())), 'sum_cell_land': round(float(land_area.sum())),
            'corr_fixed_area': round(float(corr_fixed), 3), 'corr_floating_area': round(float(corr_float), 3)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--cache', type=Path, required=True)
    ap.add_argument('--skip-zoom', action='store_true')
    ap.add_argument('--zooms', default='2,3,4')
    a = ap.parse_args()
    manifest = B.fetch_and_verify(a.cache, download=False)
    cells = read_cells()
    sites = B.load_sites()
    for r in check_totals(cells, a.cache, manifest):
        print('TOTAL', r)
    for r in check_countries(cells, a.cache, manifest):
        print('COUNTRY', r)
    for r in check_hand_cells(cells, a.cache, manifest, sites):
        print('HAND', r)
    print('PIPELINE', check_pipeline(cells, sites))
    if not a.skip_zoom:
        for r in check_zoom(cells, a.cache, sites, [int(z) for z in a.zooms.split(',')]):
            print('ZOOM', r)


if __name__ == '__main__':
    main()
