#!/usr/bin/env python3
"""Offshore wind technical potential per atlas cell from the World Bank/ESMAP polygons (T031).

Source: World Bank Group / ESMAP, Global Offshore Wind Technical Potential (2021), CC BY 4.0
(SRC-ESMAP-OWTP-2021 in team/evidence/wind-potential.md). Files, URLs and SHA-256 are pinned in
inputs/esmap_files.csv; the script refuses any file whose hash differs.

Cells: the atlas Potential map's own Voronoi cells (deployment/js/voronoi-canvas.js): a planar
Voronoi diagram of the 4,926 sites in deployment/data/voronoi_pvout_potential.csv, built in
Leaflet's EPSG:3857 layer coordinates (spherical Mercator, R = 6378137 m, latitude clamped to
+-85.0511287798), bounded by the projected world square, with no wrap at the antimeridian. The
app masks the cells to land only when it paints them; the sea belongs to the same cells, so no
land mask is applied here. The app rounds sites to whole pixels at the current zoom; this script
uses the unrounded sites (the limit of all zooms) unless --zoom is given (see README.md).

Method: each ESMAP polygon (one EEZ x depth class x wind class) is cut by the cells in Mercator
coordinates; each piece's area is measured on an equal-area projection (EPSG:6933, WGS 84
cylindrical equal-area) after densifying its edges; the polygon's InstallCap (GW) is shared out
in proportion to piece area, so the cells sum exactly to ESMAP's polygon totals.

Writes:
  deployment/data/voronoi_wind_potential_offshore.csv  per cell, row order of voronoi_pvout_potential.csv
  scripts/wind_potential/out/esmap_by_eez.csv           per EEZ and depth class: country file vs polygons vs cells
  scripts/wind_potential/out/cell_eez.csv               per cell, EEZ, depth and wind class (audit trail)
  scripts/wind_potential/out/totals.csv                 global totals

Usage:
  python3 scripts/wind_potential/build_offshore_potential.py --cache DIR [--download]
  python3 scripts/wind_potential/build_offshore_potential.py --cache DIR --zoom 2 --out-csv /tmp/x.csv
Downloaded files are only read as data (pyshp, openpyxl); nothing in them is executed.
"""
import argparse
import csv
import hashlib
import io
import math
import sys
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np
import openpyxl
import shapefile  # pyshp
import shapely
from pyproj import Transformer
from shapely.geometry import box, shape

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DATA = ROOT / 'deployment' / 'data'
MANIFEST = HERE / 'inputs' / 'esmap_files.csv'
OUT = HERE / 'out'
SITES_CSV = DATA / 'voronoi_pvout_potential.csv'      # the rows the Potential map hands to renderVoronoi
OUT_CSV = DATA / 'voronoi_wind_potential_offshore.csv'

R = 6378137.0                    # Leaflet L.Projection.SphericalMercator.R
MAX_LAT = 85.0511287798          # Leaflet SphericalMercator.MAX_LATITUDE
HALF_WORLD = math.pi * R         # the projected world square is [-pi R, pi R]^2
LONLAT_STEP_DEG = 0.01           # densify ESMAP edges (straight in lon/lat) before projecting to Mercator
MERC_STEP_M = 2000.0             # densify piece edges (Voronoi edges are straight in Mercator) before EPSG:6933
ARTIFACT_EDGE_DEG = 5.0          # a polygon part with a longer edge is a broken feature (README, A-T031-4)
DEPTH = {-50: 'fixed', -1000: 'floating'}
WIND = {7: 'ws7', 8: 'ws8'}      # ESMAP WSCategory: 7 = 7-8 m/s at 100 m (3 MW/km2), 8 = above 8 m/s (4 MW/km2)
KINDS = ('fixed', 'floating')
CLASSES = ('ws7', 'ws8')
CELL_COLS = (['location_id', 'latitude', 'longitude', 'fixed_gw', 'fixed_area_km2', 'floating_gw', 'floating_area_km2']
             + [f'{k}_{c}_{m}' for k in KINDS for c in CLASSES for m in ('gw', 'area_km2')])

TO_EA = Transformer.from_crs('EPSG:4326', 'EPSG:6933', always_xy=True)


# ---------------------------------------------------------------- inputs

def read_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def write_csv(path, fieldnames, rows):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, lineterminator='\n')
        w.writeheader()
        w.writerows(rows)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch_and_verify(cache, download):
    """Check every manifest file in the cache (downloading it first with --download)."""
    cache.mkdir(parents=True, exist_ok=True)
    manifest = read_csv(MANIFEST)
    for m in manifest:
        p = cache / m['file']
        if download and (not p.exists() or sha256(p) != m['sha256']):
            tmp = p.with_suffix(p.suffix + '.part')
            with urllib.request.urlopen(m['url'], timeout=600) as r, open(tmp, 'wb') as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            tmp.replace(p)
        if not p.exists():
            sys.exit(f'missing {p}; run with --download or fetch {m["url"]}')
        got = sha256(p)
        if got != m['sha256']:
            sys.exit(f'{p}: sha256 {got} does not match the manifest {m["sha256"]}; the published file changed. Stop and report.')
    return manifest


def fix_text(s):
    """Undo the repeated UTF-8-read-as-cp1252 damage in some ESMAP names ('CuraÃƒÆ’Ã‚Â§aoan')."""
    s = (s or '').strip()
    for _ in range(6):
        t = None
        for enc in ('cp1252', 'latin-1'):
            try:
                t = s.encode(enc).decode('utf-8')
                break
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
        if t is None or t == s:
            break
        s = t
    return s


def name_key(s):
    """Join key for EEZ names: repaired, accents dropped, case and spacing folded."""
    return ' '.join(unicodedata.normalize('NFKD', fix_text(s)).encode('ascii', 'ignore').decode().lower().split())


def load_country_xlsx(path):
    """ESMAP country file: {(region, eez key, kind): GW}. Columns read by position (LAC header says 'Flixed')."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out = {}
    names = {}
    for ws in wb.worksheets:
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i == 0 or not row or not row[0]:
                continue
            k = name_key(row[0])
            names[(ws.title, k)] = (fix_text(row[0]), fix_text(row[1]), fix_text(row[2]))
            for kind, v in (('fixed', row[3]), ('floating', row[4])):
                if isinstance(v, (int, float)):
                    out[(ws.title, k, kind)] = out.get((ws.title, k, kind), 0.0) + float(v)
    return out, names


def polygons_of(geom):
    """Polygon parts of a geometry; make_valid can return collections holding lines, which carry no area."""
    out = []
    for g in shapely.get_parts(geom):
        if g.geom_type == 'Polygon':
            if not g.is_empty:
                out.append(g)
        elif g.geom_type in ('MultiPolygon', 'GeometryCollection'):
            out += polygons_of(g)
    return out


def crosses_antimeridian(shp):
    """True when a ring of the raw shapefile shape jumps more than 180 degrees of longitude between
    two vertices, i.e. crosses 180 in one piece (six features: one New Zealand, five Fiji)."""
    pts = np.asarray(shp.points)
    if len(pts) == 0:
        return False
    bounds = list(shp.parts) + [len(pts)]
    return any(np.any(np.abs(np.diff(pts[a:b, 0])) > 180) for a, b in zip(bounds, bounds[1:]))


def unwrap(c):
    c = c.copy()
    c[c[:, 0] < 0, 0] += 360
    return c


def cut_at_180(parts):
    """Parts in 0..360 longitude -> parts in -180..180, cut at 180."""
    out = []
    for p in parts:
        west = shapely.intersection(p, box(-180, -90, 180, 90))
        east = shapely.transform(shapely.intersection(p, box(180, -90, 540, 90)), lambda c: c - np.array([360.0, 0.0]))
        out += polygons_of(west) + polygons_of(east)
    return out


def load_polygons(cache, manifest):
    """One record per ESMAP shapefile feature, with its polygon parts in lon/lat (WGS 84)."""
    recs = []
    for m in manifest:
        if m['role'] != 'shapefile':
            continue
        z = zipfile.ZipFile(cache / m['file'])
        for shp in sorted(n for n in z.namelist() if n.lower().endswith('.shp')):
            base = shp[:-4]
            # Every .prj present is GCS WGS 1984 in degrees; NA floating ships without one (README).
            r = shapefile.Reader(shp=io.BytesIO(z.read(shp)), shx=io.BytesIO(z.read(base + '.shx')),
                                 dbf=io.BytesIO(z.read(base + '.dbf')), encoding='utf-8')
            fields = [f[0].lower() for f in r.fields[1:]]
            file_kind = 'fixed' if 'fixed' in shp.lower() else 'floating'
            for i, sr in enumerate(r.iterShapeRecords()):
                d = dict(zip(fields, list(sr.record)))
                kind = DEPTH[int(d['wdepthcat'])]
                if kind != file_kind:
                    sys.exit(f'{shp} feature {i}: WDepthCat {d["wdepthcat"]} in a {file_kind} file')
                geom = shape(sr.shape.__geo_interface__)
                wrapped = crosses_antimeridian(sr.shape)
                if wrapped:                 # unwrap before any planar repair, then cut at 180
                    geom = shapely.transform(geom, unwrap)
                if not geom.is_valid:
                    geom = shapely.make_valid(geom)
                flat = polygons_of(geom)
                if wrapped:
                    flat = cut_at_180(flat)
                recs.append({
                    'region': m['region'], 'file': shp, 'index': i, 'kind': kind,
                    'wind': WIND[int(d['wscategory'])], 'gw': float(d['installcap']),
                    'area_skm': float(d['area_skm']), 'crs': d.get('crs'),
                    'geoname': fix_text(d.get('geoname')), 'territory': fix_text(d.get('territory1')),
                    'sovereign': fix_text(d.get('sovereign1')), 'parts': flat, 'wrapped': wrapped,
                })
    return recs


def max_edge_deg(p):
    return max(float(np.hypot(*np.diff(np.asarray(r.coords), axis=0).T).max()) for r in [p.exterior] + list(p.interiors))


def screen(recs):
    """Mark what is not allocated to cells, keeping everything in the records for the audit files.
    - artifact parts: any edge longer than ARTIFACT_EDGE_DEG (genuine edges are at most ~3.3 degrees,
      along the 81.5 N limit of the wind data; the broken Alaska features run bands to -114 and 156 E);
    - exact duplicates: the same geometry and depth class in two features (joint-regime areas repeat
      national EEZ polygons) is counted once, keeping a national EEZ over a joint regime, then file order."""
    for r in recs:
        r['dropped'] = [p for p in r['parts'] if max_edge_deg(p) > ARTIFACT_EDGE_DEG]
        r['parts'] = [p for p in r['parts'] if max_edge_deg(p) <= ARTIFACT_EDGE_DEG]
        r['duplicate_of'] = None
    groups = defaultdict(list)
    for i, r in enumerate(recs):
        if r['parts']:
            g = shapely.normalize(shapely.multipolygons(r['parts']))
            groups[(r['kind'], hashlib.sha256(shapely.to_wkb(g)).hexdigest())].append(i)
    for idx in groups.values():
        if len(idx) < 2:
            continue
        keep = min(idx, key=lambda i: (recs[i]['geoname'].lower().startswith('joint regime'), i))
        for i in idx:
            if i != keep:
                recs[i]['duplicate_of'] = keep
    return recs


def load_sites():
    rows = read_csv(SITES_CSV)
    return [{'location_id': r['location_id'], 'latitude': r['latitude'], 'longitude': r['longitude']} for r in rows]


# ---------------------------------------------------------------- projections

def merc(coords):
    """Leaflet SphericalMercator.project on an (N, 2) lon/lat array -> metres."""
    lon, lat = coords[:, 0], np.clip(coords[:, 1], -MAX_LAT, MAX_LAT)
    s = np.sin(np.radians(lat))
    return np.column_stack([R * np.radians(lon), R * np.log((1 + s) / (1 - s)) / 2])


def merc_inv(coords):
    """Leaflet SphericalMercator.unproject: metres -> lon/lat."""
    x, y = coords[:, 0], coords[:, 1]
    return np.column_stack([np.degrees(x / R), np.degrees(2 * np.arctan(np.exp(y / R)) - math.pi / 2)])


def to_equal_area(coords):
    """Mercator metres -> EPSG:6933 metres (via lon/lat). A few ESMAP vertices sit at 180.0000000001;
    PROJ would wrap them to -180, so longitude is clamped to the world first."""
    ll = merc_inv(coords)
    x, y = TO_EA.transform(np.clip(ll[:, 0], -180.0, 180.0), ll[:, 1])
    return np.column_stack([x, y])


def equal_area_km2(geoms_merc):
    """Area in km2 on EPSG:6933 of Mercator geometries, after densifying their edges in Mercator."""
    dense = shapely.segmentize(geoms_merc, MERC_STEP_M)
    return shapely.area(shapely.transform(dense, to_equal_area)) / 1e6


def site_xy(sites, zoom=None):
    """Sites in Mercator metres; with zoom, rounded to whole Leaflet pixels at that zoom as the app does."""
    ll = np.array([[float(s['longitude']), float(s['latitude'])] for s in sites])
    xy = merc(ll)
    if zoom is None:
        return xy
    scale = 256 * 2 ** zoom                     # L.CRS.EPSG3857.scale(zoom)
    k = 0.5 / (math.pi * R)                      # EPSG3857 transformation: (k, 0.5, -k, 0.5)
    px = np.floor(scale * (k * xy[:, 0] + 0.5) + 0.5)    # Point._round() is Math.round
    py = np.floor(scale * (-k * xy[:, 1] + 0.5) + 0.5)
    return np.column_stack([(px / scale - 0.5) / k, (py / scale - 0.5) / -k])


def build_cells(xy):
    """Planar Voronoi of the sites, clipped to the projected world. Coincident sites (only possible
    with --zoom) keep the first one's cell; the others get an empty cell."""
    world = box(-HALF_WORLD, -HALF_WORLD, HALF_WORLD, HALF_WORLD)
    first = {}
    keep = []
    for i, (x, y) in enumerate(xy):
        key = (float(x), float(y))
        if key not in first:
            first[key] = i
            keep.append(i)
    pts = shapely.multipoints(xy[keep])
    v = shapely.voronoi_polygons(pts, extend_to=box(-2 * HALF_WORLD, -2 * HALF_WORLD, 2 * HALF_WORLD, 2 * HALF_WORLD),
                                 ordered=True)
    polys = list(shapely.get_parts(v))
    if len(polys) != len(keep):
        sys.exit(f'Voronoi returned {len(polys)} cells for {len(keep)} sites')
    cells = np.array([shapely.Polygon() for _ in range(len(xy))], dtype=object)
    for j, i in enumerate(keep):
        p = polys[j]
        if not p.is_valid:          # pixel-rounded sites (--zoom) are often cocircular
            p = shapely.make_valid(p)
        c = shapely.intersection(p, world)
        if not shapely.covers(c, shapely.Point(xy[i])):
            sys.exit(f'cell {i} does not contain its own site')
        cells[i] = c
    return cells, len(xy) - len(keep)


# ---------------------------------------------------------------- intersection

def allocate(recs, cells):
    """Cut every ESMAP polygon by the cells. Returns per-piece rows (record index, cell index, area km2)."""
    part_geoms, part_rec = [], []
    for ri, r in enumerate(recs):
        if r['duplicate_of'] is not None:
            continue
        for p in r['parts']:
            part_geoms.append(p)
            part_rec.append(ri)
    part_geoms = np.array(part_geoms, dtype=object)
    part_rec = np.array(part_rec)
    merc_parts = shapely.transform(shapely.segmentize(part_geoms, LONLAT_STEP_DEG), merc)
    tree = shapely.STRtree(cells)
    pi, ci = tree.query(merc_parts, predicate='intersects')
    order = np.lexsort((ci, pi))                 # deterministic piece order: part, then cell
    pi, ci = pi[order], ci[order]
    pieces = shapely.intersection(merc_parts[pi], cells[ci])
    area = equal_area_km2(pieces)
    keep = area > 0
    part_area = equal_area_km2(merc_parts)       # whole part, same method, for the coverage check
    return part_rec[pi[keep]], ci[keep], area[keep], part_rec, part_area


def run(cache, zoom=None):
    manifest = fetch_and_verify(cache, download=False)
    sites = load_sites()
    cells, dup = build_cells(site_xy(sites, zoom))
    recs = screen(load_polygons(cache, manifest))
    rec_i, cell_i, area, part_rec, part_area = allocate(recs, cells)

    # Share each polygon's capacity by piece area (sum of pieces = the polygon, see coverage check).
    # The capacity is ESMAP's InstallCap; a feature that lost artifact parts keeps ESMAP's own density
    # (InstallCap / Area_skm) on the area that is left, never more than InstallCap.
    rec_area = defaultdict(list)
    for r, a in zip(rec_i, area):
        rec_area[int(r)].append(float(a))
    rec_total = {r: math.fsum(v) for r, v in rec_area.items()}
    for ri, r in enumerate(recs):
        if r['duplicate_of'] is not None or ri not in rec_total:
            r['alloc_gw'] = 0.0
        elif r['dropped']:
            r['alloc_gw'] = min(r['gw'], r['gw'] * rec_total[ri] / r['area_skm'])
        else:
            r['alloc_gw'] = r['gw']
    cell_acc = defaultdict(lambda: defaultdict(list))     # cell -> (kind, wind, 'gw'|'area') -> values
    eez_acc = defaultdict(lambda: defaultdict(list))      # (cell, territory, sovereign, kind, wind) -> ...
    for r, c, a in zip(rec_i, cell_i, area):
        rec = recs[int(r)]
        gw = rec['alloc_gw'] * float(a) / rec_total[int(r)]
        key = (rec['kind'], rec['wind'])
        cell_acc[int(c)][key + ('gw',)].append(gw)
        cell_acc[int(c)][key + ('area',)].append(float(a))
        ek = (int(c), rec['territory'], rec['sovereign'], rec['kind'], rec['wind'])
        eez_acc[ek]['gw'].append(gw)
        eez_acc[ek]['area'].append(float(a))

    whole = defaultdict(list)
    for r, a in zip(part_rec, part_area):
        whole[int(r)].append(float(a))
    coverage = {r: (rec_total.get(r, 0.0), math.fsum(v)) for r, v in whole.items()}
    return {'sites': sites, 'cells': cells, 'dup': dup, 'recs': recs, 'cell_acc': cell_acc,
            'eez_acc': eez_acc, 'rec_total': rec_total, 'coverage': coverage, 'manifest': manifest}


def cell_rows(res):
    rows = []
    for i, s in enumerate(res['sites']):
        acc = res['cell_acc'].get(i, {})
        row = {'location_id': s['location_id'], 'latitude': s['latitude'], 'longitude': s['longitude']}
        for k in KINDS:
            tot_gw, tot_a = [], []
            for c in CLASSES:
                gw = math.fsum(acc.get((k, c, 'gw'), []))
                a = math.fsum(acc.get((k, c, 'area'), []))
                row[f'{k}_{c}_gw'] = f'{gw:.4f}'
                row[f'{k}_{c}_area_km2'] = f'{a:.2f}'
                tot_gw += acc.get((k, c, 'gw'), [])
                tot_a += acc.get((k, c, 'area'), [])
            row[f'{k}_gw'] = f'{math.fsum(tot_gw):.4f}'
            row[f'{k}_area_km2'] = f'{math.fsum(tot_a):.2f}'
        rows.append(row)
    return rows


def write_outputs(res, cache, out_csv):
    write_csv(out_csv, CELL_COLS, cell_rows(res))

    recs = res['recs']
    xlsx_path = cache / next(m['file'] for m in res['manifest'] if m['role'] == 'country_xlsx')
    xlsx, xnames = load_country_xlsx(xlsx_path)

    def removed(r):
        """(duplicate GW, artifact GW, other GW) not allocated to cells for one feature."""
        if r['duplicate_of'] is not None:
            return r['gw'], 0.0, 0.0
        if r['dropped']:
            return 0.0, r['gw'] - r['alloc_gw'], 0.0
        return 0.0, 0.0, r['gw'] - r['alloc_gw']

    # Features not allocated in full (audit trail).
    xrows = []
    for ri, r in enumerate(recs):
        dup, art, other = removed(r)
        if dup == art == other == 0.0 and not r['dropped']:
            continue
        dropped_km2 = float(equal_area_km2(shapely.transform(shapely.segmentize(
            np.array(r['dropped'], dtype=object), LONLAT_STEP_DEG), merc)).sum()) if r['dropped'] else 0.0
        dup_of = recs[r['duplicate_of']] if r['duplicate_of'] is not None else None
        xrows.append({
            'file': r['file'], 'feature': r['index'], 'geoname': r['geoname'], 'kind': r['kind'], 'wind_class': r['wind'],
            'reason': 'duplicate' if dup_of else ('artifact parts' if r['dropped'] else 'no area in any cell'),
            'duplicate_of': f'{dup_of["file"]}#{dup_of["index"]} {dup_of["geoname"]}' if dup_of else '',
            'installcap_gw': f'{r["gw"]:.5f}', 'allocated_gw': f'{r["alloc_gw"]:.5f}',
            'esmap_area_skm': f'{r["area_skm"]:.3f}', 'kept_equal_area_km2': f'{res["rec_total"].get(ri, 0.0):.3f}',
            'dropped_parts': len(r['dropped']), 'dropped_equal_area_km2': f'{dropped_km2:.3f}',
        })
    write_csv(OUT / 'excluded_features.csv', list(xrows[0].keys()), xrows)

    # Per EEZ x depth class: country file, polygons (InstallCap, ESMAP Area_skm, our area), cells.
    eez = defaultdict(lambda: {'gw': [], 'alloc': [], 'dup': [], 'art': [], 'skm': [], 'km2': [], 'n': 0, 'names': None})
    for ri, r in enumerate(recs):
        k = (r['region'], name_key(r['geoname']), r['kind'])
        e = eez[k]
        dup, art, _ = removed(r)
        e['gw'].append(r['gw'])
        e['alloc'].append(r['alloc_gw'])
        e['dup'].append(dup)
        e['art'].append(art)
        e['skm'].append(r['area_skm'])
        e['km2'].append(res['rec_total'].get(ri, 0.0))
        e['n'] += 1
        e['names'] = e['names'] or (r['geoname'], r['territory'], r['sovereign'])
    rows = []
    for k in sorted(set(eez) | set(xlsx)):
        e = eez.get(k)
        names = e['names'] if e else xnames.get((k[0], k[1]), ('', '', ''))
        poly_gw = math.fsum(e['gw']) if e else 0.0
        rows.append({
            'region': k[0], 'geoname': names[0], 'territory': names[1], 'sovereign': names[2], 'kind': k[2],
            'country_file_gw': f'{xlsx[k]:.4f}' if k in xlsx else '',
            'polygon_gw': f'{poly_gw:.4f}',
            'polygon_minus_country_file_gw': f'{poly_gw - xlsx.get(k, 0.0):.4f}',
            'duplicate_gw': f'{math.fsum(e["dup"]):.4f}' if e else '',
            'artifact_gw': f'{math.fsum(e["art"]):.4f}' if e else '',
            'cells_gw': f'{math.fsum(e["alloc"]):.4f}' if e else '0.0000',
            'features': e['n'] if e else 0,
            'esmap_area_skm': f'{math.fsum(e["skm"]):.1f}' if e else '',
            'cells_equal_area_km2': f'{math.fsum(e["km2"]):.1f}' if e else '',
        })
    write_csv(OUT / 'esmap_by_eez.csv', list(rows[0].keys()), rows)

    erows = []
    sites = res['sites']
    for (c, terr, sov, kind, wind), v in sorted(res['eez_acc'].items(), key=lambda kv: (kv[0][0], kv[0][3], kv[0][4], kv[0][1], kv[0][2])):
        erows.append({'location_id': sites[c]['location_id'], 'territory': terr, 'sovereign': sov, 'kind': kind,
                      'wind_class': wind, 'gw': f'{math.fsum(v["gw"]):.5f}', 'area_km2': f'{math.fsum(v["area"]):.3f}'})
    write_csv(OUT / 'cell_eez.csv', list(erows[0].keys()), erows)

    trows = []
    for kind in KINDS:
        kr = [r for r in recs if r['kind'] == kind]
        rem = [removed(r) for r in kr]
        cf = math.fsum(v for (reg, key, k), v in xlsx.items() if k == kind)
        pg = math.fsum(r['gw'] for r in kr)
        cg = math.fsum(g for acc in res['cell_acc'].values() for (k, c, m), vals in acc.items() if k == kind and m == 'gw' for g in vals)
        ca = math.fsum(a for acc in res['cell_acc'].values() for (k, c, m), vals in acc.items() if k == kind and m == 'area' for a in vals)
        n_cells = sum(1 for acc in res['cell_acc'].values() if any(k == kind and m == 'gw' for (k, c, m) in acc))
        trows.append({'kind': kind, 'country_file_gw': f'{cf:.2f}', 'polygon_gw': f'{pg:.2f}',
                      'duplicate_gw': f'{math.fsum(x[0] for x in rem):.2f}', 'artifact_gw': f'{math.fsum(x[1] for x in rem):.2f}',
                      'other_unallocated_gw': f'{math.fsum(x[2] for x in rem):.2f}', 'cells_gw': f'{cg:.2f}',
                      'esmap_area_skm': f'{math.fsum(r["area_skm"] for r in kr):.0f}', 'cells_equal_area_km2': f'{ca:.0f}',
                      'cells_with_potential': n_cells})
    write_csv(OUT / 'totals.csv', list(trows[0].keys()), trows)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--cache', type=Path, required=True, help='directory holding (or receiving) the ESMAP files')
    ap.add_argument('--download', action='store_true', help='fetch missing or changed files from the World Bank catalogue')
    ap.add_argument('--zoom', type=int, default=None, help='round sites to Leaflet pixels at this zoom (sensitivity runs only)')
    ap.add_argument('--out-csv', type=Path, default=None, help='write the cell CSV here instead (required with --zoom)')
    a = ap.parse_args()
    if a.zoom is not None and a.out_csv is None:
        sys.exit('--zoom runs are diagnostics: pass --out-csv to keep the committed file untouched')
    fetch_and_verify(a.cache, a.download)
    res = run(a.cache, a.zoom)
    if a.out_csv is not None:
        write_csv(a.out_csv, CELL_COLS, cell_rows(res))
    else:
        OUT.mkdir(exist_ok=True)
        write_outputs(res, a.cache, OUT_CSV)
    worst = max((abs(t - w) / w for t, w in res['coverage'].values() if w > 0), default=0.0)
    print(f'cells {len(res["sites"])} (coincident sites {res["dup"]}), ESMAP features {len(res["recs"])}, '
          f'worst piece-sum vs whole-polygon area gap {worst:.2e}')


if __name__ == '__main__':
    main()
