#!/usr/bin/env python3
"""T090 round 2: deployment/scrollytelling/data/story-shapes.json – each region's shape on the story map, for the morph
(js/story-morph.js), which turns the map's real polygons into the chart's tiles point by point.

The story map (js/story-map.js) draws each region as its Voronoi cell around its site, in the Equal Earth projection,
clipped to the land (data/world.geojson). Here the same: sites and land projected with d3's equalEarthRaw (unit scale,
no translation: the page applies its fitted scale and translation, x' = tx + k x, y' = ty - k y), the Voronoi cells of
the sites (unique, so the page's d3-delaunay cells), each cell intersected with the land, and the largest piece kept (a
region's other pieces fade with the map). Its outer ring is resampled to N points by arc length, clockwise on screen,
starting at the point nearest the ring's top-left corner (the target tile's points start at its top-left corner too, so
the morph does not twist). Regions with no land in their cell get null.

Encoding: pts = per region (the summary's cell order) N points (x, y) as integers in raw units x scale, the first point
absolute and each next one as the difference from the one before; null = none.

usage (repo root): python3 scripts/article/analysis/t090/build_story_shapes.py [--runs ~/wind-atlas-T087/t087_runs.json]
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Polygon, MultiPolygon, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[4]
ap = argparse.ArgumentParser()
ap.add_argument('--runs', default=str(Path.home() / 'wind-atlas-T087/t087_runs.json'))
args = ap.parse_args()
N = 20
SCALE = 4000           # raw units x 4000: 1 unit is under 0.2 px at the largest zoom the morph is drawn at

# d3-geo equalEarthRaw
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
M = math.sqrt(3) / 2


def ee(lon, lat):
    lam, phi = np.radians(lon), np.radians(lat)
    l = np.arcsin(M * np.sin(phi))
    l2 = l * l
    l6 = l2 * l2 * l2
    return lam * np.cos(l) / (M * (A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2))), l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2))


summary = json.load(open(ROOT / 'deployment/scrollytelling/data/article-summary.json'))
R = json.load(open(args.runs))
ids = []
x = 0
for d in summary['cells']['idDelta']:
    x += d
    ids.append(x)
assert list(R['cells']['ids']) == ids
lon = np.array(R['cells']['lon'], float)
lat = np.array(R['cells']['lat'], float)
sx, sy = ee(lon, lat)
# screen orientation: y grows downwards (the page's y' = ty - k y), so work in (x, -y)
pts = np.c_[sx, -sy]

land = []
for f in json.load(open(ROOT / 'deployment/data/world.geojson'))['features']:
    g = f['geometry']
    polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    for rings in polys:
        rr = []
        for ring in rings:
            a = np.array(ring, float)
            px, py = ee(a[:, 0], a[:, 1])
            rr.append(np.c_[px, -py])
        p = Polygon(rr[0], rr[1:]).buffer(0)
        if not p.is_empty:
            land.append(p)
LAND = unary_union(land)

span = box(-4, -2, 4, 2)
cells = shapely.voronoi_polygons(shapely.MultiPoint(pts), extend_to=span)
tree = shapely.STRtree(list(cells.geoms))
owner = {}
for k, p in enumerate(pts):
    hits = tree.query(shapely.Point(p), predicate='intersects')
    best = min(hits, key=lambda j: cells.geoms[j].distance(shapely.Point(p))) if len(hits) else None
    owner[k] = best


def resample(ring):
    """N points by arc length along a closed ring, clockwise on screen (y down), from the point nearest the top-left."""
    a = np.array(ring.coords)[:-1]
    # shoelace in (x, y-down): positive = clockwise on screen
    s = np.sum(a[:, 0] * np.roll(a[:, 1], -1) - np.roll(a[:, 0], -1) * a[:, 1])
    if s < 0:
        a = a[::-1]
    x0, y0 = a[:, 0].min(), a[:, 1].min()
    start = int(np.argmin((a[:, 0] - x0) ** 2 + (a[:, 1] - y0) ** 2))
    a = np.roll(a, -start, axis=0)
    c = np.vstack([a, a[:1]])
    seg = np.hypot(np.diff(c[:, 0]), np.diff(c[:, 1]))
    cum = np.r_[0, np.cumsum(seg)]
    L = cum[-1]
    out = []
    for t in np.arange(N) * L / N:
        j = min(np.searchsorted(cum, t, side='right') - 1, len(seg) - 1)
        f = (t - cum[j]) / seg[j] if seg[j] > 0 else 0
        out.append(c[j] + f * (c[j + 1] - c[j]))
    return np.array(out)


flat = []
none = 0
for k in range(len(pts)):
    j = owner[k]
    shape = cells.geoms[j].intersection(LAND) if j is not None else None
    if shape is None or shape.is_empty:
        flat.append(None)
        none += 1
        continue
    parts = [g for g in getattr(shape, 'geoms', [shape]) if isinstance(g, Polygon) and g.area > 0]
    if not parts:
        flat.append(None)
        none += 1
        continue
    big = max(parts, key=lambda g: g.area)
    r = resample(big.exterior)
    q = np.round(r * SCALE).astype(int)
    d = np.vstack([q[:1], np.diff(q, axis=0)])        # the first point, then deltas (short integers)
    flat.append([int(v) for v in d.ravel()])

out = {'source': 'T090 scripts/article/analysis/t090/build_story_shapes.py: each region\'s Voronoi cell (Equal Earth raw units, y down) '
                 'clipped to data/world.geojson, the largest piece resampled to N points', 'n': len(pts), 'N': N, 'scale': SCALE, 'pts': flat}
(ROOT / 'deployment/scrollytelling/data/story-shapes.json').write_text(json.dumps(out, separators=(',', ':')))
print(f'wrote deployment/scrollytelling/data/story-shapes.json: {len(pts)} regions, {none} with no land, N = {N}')
