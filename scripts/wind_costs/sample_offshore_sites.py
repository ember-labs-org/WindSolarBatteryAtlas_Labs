#!/usr/bin/env python3
"""Sample water depth and distance to shore at each cell's simulated offshore site.

Writes scripts/wind_costs/inputs/offshore_sites.csv, which build_wind_costs.py reads.
Run once after downloading the two public files listed in scripts/wind_costs/README.md:

  python3 scripts/wind_costs/sample_offshore_sites.py \
      --etopo <dir>/ETOPO_2022_v1_60s_N90W180_bed.nc \
      --coast <dir>/ne_10m_coastline.shp --land <dir>/ne_10m_land.shp

Needs numpy and h5py (the ETOPO netCDF is HDF5). Everything else is stdlib.

Depth (SRC-ETOPO-2022): bed elevation of the 1-arc-minute grid cell that contains the site;
depth_m = -z when z < 0, else 0 (site on land at this resolution; flagged downstream).
Distance (SRC-NE-COAST-10M): shortest distance from the site to any Natural Earth 10 m
coastline segment, in a local equirectangular projection centred on the site (error well
under 1% at the distances that matter, <= 300 km); beyond 300 km a haversine search over
all coastline vertices is used instead.
On land (SRC-NE-COAST-10M, land polygons): 1 if the site falls inside a Natural Earth 10 m land
polygon (even-odd rule). Flags pipeline sites in below-sea-level land, ice-sheet beds and lakes.
"""
import argparse
import csv
import math
import struct
from pathlib import Path

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
R_EARTH_KM = 6371.0088


def read_cells():
    cells = {r['location_id'] for r in csv.DictReader(open(ROOT / 'deployment/data/voronoi_overlapping_countries.csv'))}
    sites = []
    for r in csv.DictReader(open(ROOT / 'deployment/data/voronoi_wind_resource.csv')):
        if r['location_id'] not in cells:
            continue  # 72 ids in the resource file are not atlas cells
        try:
            lat, lon = float(r['off_site_lat']), float(r['off_site_lon'])
        except ValueError:
            continue
        if math.isnan(lat) or math.isnan(lon):
            continue
        sites.append((int(r['location_id']), lat, lon))
    return sorted(sites)


def read_coast_segments(shp_path):
    """Return (lat1, lon1, lat2, lon2) arrays of every coastline segment (shapefile polylines)."""
    data = Path(shp_path).read_bytes()
    pos = 100
    lat1, lon1, lat2, lon2 = [], [], [], []
    while pos < len(data):
        _, content_words = struct.unpack('>ii', data[pos:pos + 8])
        rec = data[pos + 8:pos + 8 + content_words * 2]
        pos += 8 + content_words * 2
        shape_type = struct.unpack('<i', rec[:4])[0]
        if shape_type == 0:
            continue
        if shape_type not in (3, 13, 23):
            raise ValueError(f'unexpected shape type {shape_type}')
        num_parts, num_points = struct.unpack('<ii', rec[36:44])
        parts = list(struct.unpack(f'<{num_parts}i', rec[44:44 + 4 * num_parts]))
        pts = np.frombuffer(rec[44 + 4 * num_parts:44 + 4 * num_parts + 16 * num_points], dtype='<f8').reshape(-1, 2)
        parts.append(num_points)
        for a, b in zip(parts[:-1], parts[1:]):
            seg = pts[a:b]
            if len(seg) < 2:
                continue
            lon1.append(seg[:-1, 0]); lat1.append(seg[:-1, 1])
            lon2.append(seg[1:, 0]); lat2.append(seg[1:, 1])
    return tuple(np.concatenate(x) for x in (lat1, lon1, lat2, lon2))


def read_rings(shp_path):
    """Return a list of (lon, lat) numpy rings from a polygon shapefile."""
    data = Path(shp_path).read_bytes()
    pos, rings = 100, []
    while pos < len(data):
        _, content_words = struct.unpack('>ii', data[pos:pos + 8])
        rec = data[pos + 8:pos + 8 + content_words * 2]
        pos += 8 + content_words * 2
        if struct.unpack('<i', rec[:4])[0] == 0:
            continue
        num_parts, num_points = struct.unpack('<ii', rec[36:44])
        parts = list(struct.unpack(f'<{num_parts}i', rec[44:44 + 4 * num_parts])) + [num_points]
        pts = np.frombuffer(rec[44 + 4 * num_parts:44 + 4 * num_parts + 16 * num_points], dtype='<f8').reshape(-1, 2)
        for a, b in zip(parts[:-1], parts[1:]):
            rings.append(pts[a:b])
    return rings


def on_land(lat, lon, rings, boxes):
    inside = False
    for ring, (x0, y0, x1, y1) in zip(rings, boxes):
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            continue
        x, y = ring[:, 0], ring[:, 1]
        xj, yj = np.roll(x, 1), np.roll(y, 1)
        cross = ((y > lat) != (yj > lat))
        with np.errstate(divide='ignore', invalid='ignore'):
            xint = (xj - x) * (lat - y) / (yj - y) + x
        if np.count_nonzero(cross & (lon < xint)) % 2:
            inside = not inside
    return inside


def wrap180(d):
    return (d + 180.0) % 360.0 - 180.0


def shore_distance_km(lat, lon, seg, window_km=300.0):
    lat1, lon1, lat2, lon2 = seg
    dlat_win = window_km / 111.0
    coslat = max(math.cos(math.radians(lat)), 0.02)
    dlon_win = min(180.0, window_km / (111.0 * coslat))
    near = ((np.abs(lat1 - lat) < dlat_win) | (np.abs(lat2 - lat) < dlat_win)) & \
           ((np.abs(wrap180(lon1 - lon)) < dlon_win) | (np.abs(wrap180(lon2 - lon)) < dlon_win))
    if near.any():
        kx = math.radians(1) * R_EARTH_KM * coslat
        ky = math.radians(1) * R_EARTH_KM
        ax = wrap180(lon1[near] - lon) * kx; ay = (lat1[near] - lat) * ky
        bx = wrap180(lon2[near] - lon) * kx; by = (lat2[near] - lat) * ky
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = np.where(L2 > 0, np.clip(-(ax * dx + ay * dy) / np.where(L2 > 0, L2, 1), 0, 1), 0)
        px, py = ax + t * dx, ay + t * dy
        d = float(np.sqrt(px * px + py * py).min())
        if d <= window_km:
            return d, 'segment_local'
    # Far from any coast: haversine to every vertex
    p1, p2 = np.radians(lat), np.radians(lat1)
    dl = np.radians(lon1 - lon)
    h = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return float(2 * R_EARTH_KM * np.arcsin(np.sqrt(h)).min()), 'vertex_haversine'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--etopo', required=True)
    ap.add_argument('--coast', required=True)
    ap.add_argument('--land', required=True)
    ap.add_argument('--out', default=str(ROOT / 'scripts/wind_costs/inputs/offshore_sites.csv'))
    a = ap.parse_args()

    sites = read_cells()
    seg = read_coast_segments(a.coast)
    rings = read_rings(a.land)
    boxes = [(r[:, 0].min(), r[:, 1].min(), r[:, 0].max(), r[:, 1].max()) for r in rings]
    with h5py.File(a.etopo, 'r') as f:
        lats = f['lat'][:]
        lons = f['lon'][:]
        z = f['z']
        fill = float(z.attrs['_FillValue'][0])
        out = []
        for lid, lat, lon in sites:
            # grid-cell centres; pick the cell containing the site
            i = int(np.abs(lats - lat).argmin())
            j = int(np.abs(lons - wrap180(lon)).argmin())
            zz = float(z[i, j])
            if zz == fill:
                raise ValueError(f'fill value at site {lid}')
            depth = -zz if zz < 0 else 0.0
            dist, how = shore_distance_km(lat, lon, seg)
            land = 1 if on_land(lat, wrap180(lon), rings, boxes) else 0
            out.append([lid, f'{lat:.6f}', f'{lon:.6f}', i, j, f'{zz:.1f}', f'{depth:.1f}', f'{dist:.2f}', how, land])
    with open(a.out, 'w', newline='') as fh:
        w = csv.writer(fh, lineterminator='\n')
        w.writerow(['location_id', 'off_site_lat', 'off_site_lon', 'etopo_row', 'etopo_col', 'etopo_z_m',
                    'depth_m', 'shore_km', 'shore_method', 'on_land_ne'])
        w.writerows(out)
    print(f'wrote {len(out)} sites to {a.out}')


if __name__ == '__main__':
    main()
