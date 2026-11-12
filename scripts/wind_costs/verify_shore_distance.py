#!/usr/bin/env python3
"""Independent spot-check of the shore distances in inputs/offshore_sites.csv.

Recomputes distance to shore for a seeded sample of sites with a different coastline and a
different algorithm: OpenStreetMap simplified land polygons (osmdata.openstreetmap.de, ODbL,
EPSG:3857), unprojected to lon/lat, every edge densified to <= 0.5 km, then the haversine
distance from the site to the nearest densified vertex (no planar approximation).

  python3 -I scripts/wind_costs/verify_shore_distance.py --osm <dir>/simplified_land_polygons.shp [--n 20]

Needs numpy. Writes out/verify_shore_distance.csv (site, NE distance used, OSM distance).
"""
import argparse
import csv
import math
import random
import struct
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
R = 6371.0088
R_MERC = 6378137.0


def read_rings(path):
    data = Path(path).read_bytes()
    pos, rings = 100, []
    while pos < len(data):
        _, words = struct.unpack('>ii', data[pos:pos + 8])
        rec = data[pos + 8:pos + 8 + words * 2]
        pos += 8 + words * 2
        if struct.unpack('<i', rec[:4])[0] == 0:
            continue
        nparts, npts = struct.unpack('<ii', rec[36:44])
        parts = list(struct.unpack(f'<{nparts}i', rec[44:44 + 4 * nparts])) + [npts]
        pts = np.frombuffer(rec[44 + 4 * nparts:44 + 4 * nparts + 16 * npts], dtype='<f8').reshape(-1, 2)
        lon = np.degrees(pts[:, 0] / R_MERC)
        lat = np.degrees(2 * np.arctan(np.exp(pts[:, 1] / R_MERC)) - math.pi / 2)
        for a, b in zip(parts[:-1], parts[1:]):
            rings.append(np.column_stack([lon[a:b], lat[a:b]]))
    return rings


def densify(ring, step_km=0.5):
    out = [ring[:1]]
    for (x0, y0), (x1, y1) in zip(ring[:-1], ring[1:]):
        d = R * math.radians(math.hypot((x1 - x0) * math.cos(math.radians((y0 + y1) / 2)), y1 - y0))
        n = max(1, int(math.ceil(d / step_km)))
        t = np.arange(1, n + 1) / n
        out.append(np.column_stack([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]))
    return np.vstack(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--osm', required=True)
    ap.add_argument('--n', type=int, default=20)
    a = ap.parse_args()
    sites = [r for r in csv.DictReader(open(HERE / 'inputs/offshore_sites.csv'))
             if r['on_land_ne'] == '0' and float(r['shore_km']) < 300]
    random.seed(2024)
    sample = sorted(random.sample(sites, a.n), key=lambda r: int(r['location_id']))
    rings = read_rings(a.osm)
    boxes = np.array([(r[:, 0].min(), r[:, 1].min(), r[:, 0].max(), r[:, 1].max()) for r in rings])
    rows = []
    for s in sample:
        lat, lon = float(s['off_site_lat']), float(s['off_site_lon'])
        win = 4.0
        dlon = min(180, win / max(math.cos(math.radians(lat)), 0.05))
        sel = np.where((boxes[:, 2] >= lon - dlon) & (boxes[:, 0] <= lon + dlon) &
                       (boxes[:, 3] >= lat - win) & (boxes[:, 1] <= lat + win))[0]
        pts = np.vstack([densify(rings[i]) for i in sel])
        p1, p2 = math.radians(lat), np.radians(pts[:, 1])
        h = np.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(np.radians(pts[:, 0] - lon) / 2) ** 2
        d_osm = float(2 * R * np.arcsin(np.sqrt(h)).min())
        d_ne = float(s['shore_km'])
        rows.append({'location_id': s['location_id'], 'lat': s['off_site_lat'], 'lon': s['off_site_lon'],
                     'ne_km': f'{d_ne:.1f}', 'osm_km': f'{d_osm:.1f}', 'diff_km': f'{d_ne - d_osm:.1f}'})
        print(rows[-1])
    with open(HERE / 'out/verify_shore_distance.csv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator='\n')
        w.writeheader()
        w.writerows(rows)
    diffs = [abs(float(r['diff_km'])) for r in rows]
    print(f'n={len(rows)} median |diff| {np.median(diffs):.1f} km, max {max(diffs):.1f} km')


if __name__ == '__main__':
    main()
