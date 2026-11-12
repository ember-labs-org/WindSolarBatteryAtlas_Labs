#!/usr/bin/env python3
"""build_cartogram.py – a population cartogram of the atlas's regions for the charts-only article (T091).

The human (5 Nov 2026): "for the map with the size of population, can we try a version like [Worldmapper's] where we
shape all the Voronois to their population size".

Method: the flow-based diffusion cartogram (Gastner & Newman 2004, PNAS 101, 7499; Gastner, Seguy & More 2018, PNAS
115, E2156). Each region's population is spread over its land area as a density; the density diffuses, and every point
of the map moves with the flow v = -grad(rho) / rho until the density is even. All vertices (coasts, region and country
edges) move with the same smooth field, so shared edges stay shared: no gaps, no overlaps. The flow is repeated on the
deformed map a few times, recomputing densities from the regions' new areas, until each region's area is close to its
share of population.

Inputs (all committed): the regions' sites and countries (deployment/scrollytelling/data/article-summary.json), their
population (story-cells.json `pop`, GPW v4 2020 as T087), the land (deployment/data/world.geojson, south of 58°S left
out). The regions are the atlas's Voronoi cells around the sites, cut to the land, in d3's Equal Earth projection.

Output: deployment/scrollytelling/data/story-cartogram.json – per region its polygon rings in the page's frame (x right,
y down, integers in units of `quantum`, the first point absolute and the rest as differences), the country outlines, the
coast, and label positions for the most populous countries; team/reports/T091-cartogram.md – the area accuracy.

usage (repo root): python3 scripts/article/analysis/t091/build_cartogram.py   (needs numpy, scipy, shapely, pillow)
"""
import json
import math
import time
from pathlib import Path

import numpy as np
import shapely
from PIL import Image, ImageDraw
from scipy.fft import dctn, idctn
from scipy.ndimage import map_coordinates
from shapely.geometry import MultiPoint, box

ROOT = Path(__file__).resolve().parents[4]
SUMMARY = ROOT / 'deployment/scrollytelling/data/article-summary.json'
CELLS = ROOT / 'deployment/scrollytelling/data/story-cells.json'
WORLD = ROOT / 'deployment/data/world.geojson'
OUT = ROOT / 'deployment/scrollytelling/data/story-cartogram.json'
REPORT = ROOT / 'team/reports/T091-cartogram.md'

NX, NY = 2048, 1024         # diffusion grid (square cells); 1024x512 stalled at 25% weighted error (too coarse for 4,465 regions)
PASSES = 6                  # flow passes on the deformed map
FLOOR = 0.05                # minimum density, as a share of the mean: near-empty land keeps some area, so it is not
                            # squeezed into spikes (0.01 drew northern India's regions out to a point at Tibet); the
                            # human accepted the map at 0.05 (5 Nov 2026); 0.15 was tried for a smaller fan there
OUT_W = 1000                # output frame width (units)
PER_UNIT = 10               # coordinates stored in tenths of a unit (quantum 0.1)
SIMPLIFY = 0.4              # coverage simplification, grid units
SOUTH = -58                 # land south of this (Antarctica) is left out, as the page's world view does
N_LABELS = 12               # the most populous countries get a label


# ---- Equal Earth (d3-geo geoEqualEarthRaw; y up) -----------------------------------------------------------------
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
M = math.sqrt(3) / 2


def equal_earth(lon, lat):
    lam, phi = np.radians(lon), np.radians(lat)
    l = np.arcsin(M * np.sin(phi))
    l2 = l * l
    l6 = l2 * l2 * l2
    x = lam * np.cos(l) / (M * (A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2)))
    y = l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2))
    return x, y


def project(geom):
    def f(c):
        x, y = equal_earth(c[:, 0], c[:, 1])
        return np.column_stack([x, y])
    return shapely.transform(geom, f)


t0 = time.time()
# ---- the regions --------------------------------------------------------------------------------------------------
S = json.loads(SUMMARY.read_text())
c = S['cells']
n = S['n']
lat = np.array(c['lat'], float)
lon = np.array(c['lon'], float)
country = [c['countries'][k] for k in c['country']]
pop = np.array([p or 0 for p in json.loads(CELLS.read_text())['pop']], float)
assert len(pop) == n, 'story-cells pop and the summary cells differ in length'

W = json.loads(WORLD.read_text())
land_ll = shapely.make_valid(shapely.union_all([shapely.geometry.shape(f['geometry']) for f in W['features']]))
land_ll = shapely.intersection(land_ll, box(-180, SOUTH, 180, 90))
land = shapely.make_valid(project(land_ll))
sx, sy = equal_earth(lon, lat)
sites = np.column_stack([sx, sy])

lb = land.bounds
env = box(lb[0] - 1, lb[1] - 1, lb[2] + 1, lb[3] + 1)
vd = shapely.voronoi_polygons(MultiPoint(sites), extend_to=env)
vpolys = np.array(list(vd.geoms))
tree = shapely.STRtree(vpolys)
pi, ti = tree.query(shapely.points(sites), predicate='within')
owner = np.full(n, -1)
owner[pi] = ti
missing = np.where(owner < 0)[0]
assert len(missing) == 0, f'{len(missing)} sites without a Voronoi cell (duplicate sites?)'
cells = shapely.intersection(vpolys[owner], land)
cells = shapely.make_valid(cells)
print(f'{n} regions; land and Voronoi cells in {time.time() - t0:.1f} s')

# ---- the grid -----------------------------------------------------------------------------------------------------
# A padded box around the land: the map needs room to swell into (Gastner et al. pad by about half the extent).
gx0, gy0, gx1, gy1 = lb
w, h = gx1 - gx0, gy1 - gy0
cell = max(w * 1.5 / NX, h * 1.6 / NY)
X0 = (gx0 + gx1) / 2 - cell * NX / 2
Y0 = (gy0 + gy1) / 2 - cell * NY / 2


def to_grid(xy):        # projected -> grid units (x right, y up; cell (i, j) spans [i, i+1) x [j, j+1))
    return np.column_stack([(xy[:, 0] - X0) / cell, (xy[:, 1] - Y0) / cell])


# Work in grid units from here: segmentize so straight Voronoi edges bend smoothly with the flow.
geoms = shapely.transform(cells, lambda a: to_grid(a))
geoms = shapely.segmentize(geoms, 0.75)


def rasterize(gs):
    """Label image: region index + 1 under each grid cell's centre (0 = sea), drawn with PIL (holes cut back to 0)."""
    img = Image.new('I', (NX, NY), 0)
    dr = ImageDraw.Draw(img)
    for k, g in enumerate(gs):
        if g is None or g.is_empty:
            continue
        for part in getattr(g, 'geoms', [g]):
            if part.geom_type != 'Polygon' or part.is_empty:
                continue
            ext = [(x, NY - y) for x, y in part.exterior.coords]   # image rows run down
            if len(ext) >= 3:
                dr.polygon(ext, fill=k + 1)
            for hole in part.interiors:
                hc = [(x, NY - y) for x, y in hole.coords]
                if len(hc) >= 3:
                    dr.polygon(hc, fill=0)
    a = np.array(img, dtype=np.int64)
    return a[::-1]          # row j = y in [j, j+1)


def density(labels):
    counts = np.bincount(labels.ravel(), minlength=n + 1)[1:].astype(float)
    on = counts > 0
    dens = np.zeros(n)
    dens[on] = pop[on] / counts[on]
    land_cells = counts.sum()
    mean = pop[on].sum() / land_cells
    rho = np.where(labels > 0, dens[np.maximum(labels - 1, 0)], mean)
    rho = np.maximum(rho, FLOOR * mean)         # empty land keeps a little area, so its edges stay drawable
    return rho, counts, mean


# Decay of each cosine mode under the DISCRETE heat equation (eigenvalues of the grid's 5-point Laplacian with reflecting
# edges): exp(-t L) keeps a positive density positive. The continuous factors (pi k / N)^2 ring (Gibbs) at the steep
# density steps here (up to 6,500:1 between neighbours) and drove the density negative within a few steps.
KX = 4 * np.sin(np.pi * np.arange(NX) / (2 * NX)) ** 2
KY = 4 * np.sin(np.pi * np.arange(NY) / (2 * NY)) ** 2
DECAY = KX[None, :] + KY[:, None]


def flow(gs, rho):
    """Move every vertex of gs with the diffusion flow of rho (grid units) until the density is even."""
    coords = shapely.get_coordinates(gs)
    pts = coords.copy()
    rho_hat = dctn(rho, type=2, norm='ortho')
    t, steps = 0.0, 0
    while True:
        r = idctn(rho_hat * np.exp(-DECAY * t), type=2, norm='ortho')
        if not (r.min() > 0):
            raise SystemExit(f'build_cartogram: the diffused density is not positive at t = {t:.4g} (min {r.min():.4g})')
        gy, gx = np.gradient(r)
        vx, vy = -gx / r, -gy / r
        vmax = max(np.abs(vx).max(), np.abs(vy).max())
        if steps % 250 == 0:
            print(f'    step {steps}: t {t:.4g}, max speed {vmax:.4g} cells per unit time', flush=True)
        if vmax < 1e-4 or steps > 4000:
            break
        dt = min(0.2 / vmax, 50.0)          # at most a fifth of a cell per step
        # midpoint (RK2) step, velocities sampled at cell centres (index = position - 0.5)
        def vel(p, field_x, field_y):
            yy, xx = p[:, 1] - 0.5, p[:, 0] - 0.5
            return np.column_stack([map_coordinates(field_x, [yy, xx], order=1, mode='nearest'),
                                    map_coordinates(field_y, [yy, xx], order=1, mode='nearest')])
        v1 = vel(pts, vx, vy)
        mid = pts + 0.5 * dt * v1
        r2 = idctn(rho_hat * np.exp(-DECAY * (t + 0.5 * dt)), type=2, norm='ortho')
        gy2, gx2 = np.gradient(r2)
        v2 = vel(mid, -gx2 / r2, -gy2 / r2)
        pts += dt * v2
        t += dt
        steps += 1
    return shapely.set_coordinates(gs.copy(), pts), steps, t


def area_error(gs):
    a = shapely.area(gs)
    share_a = a / a.sum()
    share_p = pop / pop.sum()
    ok = pop > 0
    rel = np.abs(share_a[ok] / share_p[ok] - 1)
    w = share_p[ok]
    return float((rel * w).sum()), float(np.median(rel)), float(np.percentile(rel, 95))


import sys
CACHE = Path(sys.argv[sys.argv.index('--cache') + 1]) if '--cache' in sys.argv else None   # the moved shapes, so output changes need no new flow
log = []
e0 = area_error(geoms)
log.append(('start (the map as drawn)', *e0))
print(f'start: population-weighted mean |area share / population share - 1| = {e0[0]:.3f}')
key = f'{NX}x{NY} passes {PASSES} floor {FLOOR}'
if CACHE and CACHE.exists() and json.loads(CACHE.with_suffix('.json').read_text())['key'] == key:
    geoms = shapely.from_wkb(np.load(CACHE, allow_pickle=True))
    log = [tuple(x) for x in json.loads(CACHE.with_suffix('.json').read_text())['log']]
    print(f'moved shapes from the cache {CACHE} ({key})')
else:
    for p in range(PASSES):
        labels = rasterize(geoms)
        rho, counts, mean = density(labels)
        t1 = time.time()
        geoms, steps, tt = flow(geoms, rho)
        geoms = shapely.make_valid(geoms)
        e = area_error(geoms)
        log.append((f'pass {p + 1} ({steps} steps, {time.time() - t1:.0f} s)', *e))
        print(f'pass {p + 1}: {steps} steps, weighted error {e[0]:.3f}, median {e[1]:.3f}, p95 {e[2]:.3f}')
    if CACHE:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        np.save(CACHE, shapely.to_wkb(geoms), allow_pickle=True)
        CACHE.with_suffix('.json').write_text(json.dumps({'key': key, 'log': log}))

# ---- output -------------------------------------------------------------------------------------------------------
# Frame: the cartogram's bounds, OUT_W wide, y down; simplified as a coverage so shared edges stay shared.
geoms = shapely.coverage_simplify(geoms, SIMPLIFY) if hasattr(shapely, 'coverage_simplify') else shapely.simplify(geoms, SIMPLIFY)
allb = shapely.total_bounds(geoms)
scale = OUT_W / (allb[2] - allb[0])
OUT_H = (allb[3] - allb[1]) * scale


def frame(a):
    return np.column_stack([(a[:, 0] - allb[0]) * scale, (allb[3] - a[:, 1]) * scale])


geoms = shapely.transform(geoms, frame)


def rings(g):
    out = []
    for part in getattr(g, 'geoms', [g]):
        if part.geom_type != 'Polygon' or part.is_empty:
            continue
        for ring in [part.exterior, *part.interiors]:
            q = np.round(np.asarray(ring.coords)[:-1] * PER_UNIT).astype(int)
            if len(q) < 3:
                continue
            d = np.vstack([q[:1], np.diff(q, axis=0)]).ravel().tolist()
            out.append(d)
    return out


regions = [rings(g) if g is not None and not g.is_empty else [] for g in geoms]
by_country = {}
for k, g in enumerate(geoms):
    if g is not None and not g.is_empty:
        by_country.setdefault(country[k], []).append(g)
countries = {name: shapely.make_valid(shapely.union_all(gs)) for name, gs in by_country.items() if name and name != '(none)'}
coast = shapely.make_valid(shapely.union_all([g for g in geoms if g is not None and not g.is_empty]))
cpop = {}
for k in range(n):
    cpop[country[k]] = cpop.get(country[k], 0) + pop[k]
labels = []
for name in sorted((x for x in cpop if x in countries), key=lambda x: -cpop[x])[:N_LABELS]:
    g = countries[name]
    big = max(getattr(g, 'geoms', [g]), key=lambda q: q.area)
    pt = big.point_on_surface()
    short = {'United States of America': 'United States', 'Dem. Rep. Congo': 'DR Congo'}.get(name, name)
    labels.append({'name': short, 'x': round(pt.x, 1), 'y': round(pt.y, 1)})

out = {
    'about': 'T091 population cartogram of the atlas regions (scripts/article/analysis/t091/build_cartogram.py): '
             'diffusion flow (Gastner & Newman 2004; Gastner, Seguy & More 2018), population GPW v4 2020 via story-cells.json. '
             'Coordinates in units of quantum, y down; each ring: first point absolute, then differences.',
    'width': round(OUT_W, 1), 'height': round(float(OUT_H), 1), 'n': n, 'quantum': 1 / PER_UNIT,
    'regions': regions,
    'countries': [rings(g) for name, g in sorted(countries.items())],
    'coast': rings(coast),
    'labels': labels,
}
OUT.write_text(json.dumps(out, separators=(',', ':')))
print(f'wrote {OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1e6:.2f} MB; {len(countries)} countries; {time.time() - t0:.0f} s in all')

# ---- accuracy report ------------------------------------------------------------------------------------------------
a = np.array([shapely.area(g) if g is not None else 0 for g in geoms])
share_a, share_p = a / a.sum(), pop / pop.sum()
ok = pop > 0
worst = np.argsort(-np.abs(np.where(ok, share_a / np.where(ok, share_p, 1) - 1, 0)) * share_p)[:10]
cs = sorted(cpop, key=lambda x: -cpop[x])[:15]
ca = {name: shapely.area(countries[name]) / a.sum() for name in cs if name in countries}
lines = ['# T091 – population cartogram: area accuracy', '',
         f'Minimum density {FLOOR:.0%} of the mean (near-empty land keeps some area, so it is not drawn as spikes).',
         'Built by `scripts/article/analysis/t091/build_cartogram.py` → `deployment/scrollytelling/data/story-cartogram.json`.',
         f'Grid {NX}×{NY}, {PASSES} flow passes. Error = |a region\'s share of the map\'s area / its share of population − 1|.', '',
         '| Stage | Population-weighted mean error | Median | 95th percentile |', '|---|---|---|---|']
lines += [f'| {s} | {m:.1%} | {md:.1%} | {p95:.1%} |' for s, m, md, p95 in log]
lines += ['', '## The 15 most populous countries: share of population against share of the map', '',
          '| Country | Population share | Area share | Ratio |', '|---|---|---|---|']
for name in cs:
    if name in ca:
        lines.append(f'| {name} | {cpop[name] / pop.sum():.2%} | {ca[name]:.2%} | {ca[name] / (cpop[name] / pop.sum()):.3f} |')
lines += ['', '## Largest population-weighted errors (regions)', '', '| Region | Country | Population share | Area share |', '|---|---|---|---|']
for k in worst:
    lines.append(f'| {k} | {country[k]} | {share_p[k]:.4%} | {share_a[k]:.4%} |')
REPORT.write_text('\n'.join(lines) + '\n')
print(f'wrote {REPORT.relative_to(ROOT)}')
