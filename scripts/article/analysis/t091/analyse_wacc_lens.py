#!/usr/bin/env python3
"""analyse_wacc_lens.py – the article's cost-of-capital lens (T091).

The human (5 Nov 2026): the article compares the physics, not the financing, so it runs on one common cost of capital,
7% everywhere (the atlas's WACC Global; model.js COST_MODE = Capex Local + WACC Global). Section 1 first shows what
changes with each region's own cost of capital (Hatton et al. 2025, as published; D-141): Africa then looks dearer than
Europe, because its cost of capital is about twice as high, not because of its sun or wind.

1. From the run of run_wacc_lens.mjs (the atlas's own worker at 90% uptime: the article's own mode as a control, and the
   atlas's full Local mode), it checks that the control reproduces story-cells.json c90 / c90sb (to 0.01 $/MWh) and
   writes deployment/scrollytelling/data/story-localwacc.json: per region, in the summary's cell order, the cheapest build
   with and without wind with each region's own cost of capital. With --previous <story-cells.json of the article before
   the switch>, it also checks the Local run reproduces that file's c90 / c90sb (the article's old numbers).
2. From committed files only (that data file, story-cells.json, the summary's cells, deployment/data/voronoi_wacc.csv) it
   computes the values the article binds and writes team/reports/T091-tables/t091_values.json, which
   scripts/article/tools/build-snapshot.mjs embeds in the summary.

Groups: Europe as T089 (analyse_t089.py EUROPE, 36 countries); Africa = the UN M49 region Africa, the atlas's country
names. Medians weighted by population (GPW v4, story-cells pop).

usage (repo root):
  python3 scripts/article/analysis/t091/analyse_wacc_lens.py --runs <t091_wacc_lens_runs.json> [--previous <file>]
  python3 scripts/article/analysis/t091/analyse_wacc_lens.py --check      # values == committed, from committed files
"""
import csv
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
DATA = ROOT / 'deployment/scrollytelling/data'
OUT_DATA = DATA / 'story-localwacc.json'
OUT_VALUES = ROOT / 'team/reports/T091-tables/t091_values.json'
T = 90

EUROPE = ['Albania', 'Austria', 'Belarus', 'Belgium', 'Bosnia and Herz.', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Denmark',
          'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Iceland', 'Ireland', 'Italy', 'Latvia', 'Lithuania',
          'Moldova', 'Montenegro', 'Netherlands', 'North Macedonia', 'Norway', 'Poland', 'Portugal', 'Romania', 'Serbia',
          'Slovakia', 'Spain', 'Sweden', 'Switzerland', 'Ukraine', 'United Kingdom']     # analyse_t089.py EUROPE
AFRICA = ['Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Cameroon', 'Central African Rep.', 'Chad', 'Congo',
          "Côte d'Ivoire", 'Dem. Rep. Congo', 'Djibouti', 'Egypt', 'Eritrea', 'eSwatini', 'Ethiopia', 'Gabon', 'Ghana',
          'Guinea', 'Guinea-Bissau', 'Kenya', 'Lesotho', 'Liberia', 'Libya', 'Madagascar', 'Malawi', 'Mali', 'Mauritania',
          'Morocco', 'Mozambique', 'Namibia', 'Niger', 'Nigeria', 'Rwanda', 'S. Sudan', 'Senegal', 'Sierra Leone',
          'Somalia', 'Somaliland', 'South Africa', 'Sudan', 'Tanzania', 'Togo', 'Tunisia', 'Uganda', 'W. Sahara', 'Zambia',
          'Zimbabwe']                                                                          # UN M49 Africa, atlas names

summary = json.loads((DATA / 'article-summary.json').read_text())
c = summary['cells']
ids, x = [], 0
for d in c['idDelta']:
    x += d
    ids.append(x)
country = np.array([c['countries'][k] for k in c['country']], dtype=object)
for name in EUROPE + AFRICA:
    assert name in set(country), f'{name} is not an atlas country name'
S = json.loads((DATA / 'story-cells.json').read_text())
arr = lambda v: np.array([np.inf if q is None else q for q in v], float)
pop = np.array([p or 0 for p in S['pop']], float)


def wmedian(values, weights, sel):
    ok = sel & (weights > 0) & ~np.isnan(values)
    idx = np.nonzero(ok)[0]
    idx = idx[np.argsort(values[idx], kind='stable')]
    cw = np.cumsum(weights[idx])
    return float(values[idx[min(np.searchsorted(cw, 0.5 * cw[-1]), len(idx) - 1)]])


def reproduces(a, b, what):
    same_finite = np.array_equal(np.isfinite(a), np.isfinite(b))
    diff = np.max(np.abs(a[np.isfinite(a)] - b[np.isfinite(b)])) if same_finite else np.inf
    if not (same_finite and diff <= 0.01):
        raise SystemExit(f'{what}: max diff {diff}')


def build_data(runs_path, previous=None):
    R = json.loads(Path(runs_path).read_text())

    def best(name):
        r = R['runs'][name]
        pos = {lid: j for j, lid in enumerate(r['location_id'])}
        out = []
        for lid in ids:
            j = pos.get(lid)
            out.append(r['lcoe'][j] if j is not None and r['meetsTarget'][j] and r['lcoe'][j] is not None else np.inf)
        return np.array(out, float)
    for col in ('', 'sb'):
        reproduces(best(f'{"sb" if col else "all"}_nb_{T}'), arr(S[f'c{T}{col}']), f'the control run does not reproduce story-cells c{T}{col}')
    lw, lwsb = best(f'all_lw_{T}'), best(f'sb_lw_{T}')
    if previous:
        P = json.loads(Path(previous).read_text())
        reproduces(lw, arr(P[f'c{T}']), 'the Local run does not reproduce the previous article\'s c90')
        reproduces(lwsb, arr(P[f'c{T}sb']), 'the Local run does not reproduce the previous article\'s c90sb')
        print('the Local run reproduces the previous article\'s per-region costs (c90, c90sb) to 0.01 $/MWh')
    rnd = lambda v: [None if not np.isfinite(q) else round(float(q), 2) for q in v]
    OUT_DATA.write_text(json.dumps({
        'about': 'T091 cost-of-capital lens (scripts/article/analysis/t091/run_wacc_lens.mjs + analyse_wacc_lens.py): the '
                 'cheapest build at 90% uptime in the atlas\'s full Local mode (each region\'s own cost of capital, local capex), '
                 'app defaults; per region in the summary\'s cell order; null where 90% is not met. `wacc` is the article\'s '
                 'common cost of capital (the atlas\'s WACC Global), for the labels.',
        'wacc': R['wacc'], 'c90': rnd(lw), 'c90sb': rnd(lwsb),
        # each region's own cost of capital (solar and batteries; deployment/data/voronoi_wacc.csv, Hatton et al. 2025)
        'waccLocal': [None if not np.isfinite(q) else round(float(q), 4) for q in local_wacc()]}, separators=(',', ':')))
    print(f'wrote {OUT_DATA.relative_to(ROOT)} (control reproduces story-cells.json to 0.01 $/MWh)')


def local_wacc():
    wacc = {}
    with open(ROOT / 'deployment/data/voronoi_wacc.csv', newline='') as f:
        for r in csv.DictReader(f):
            wacc[int(r['location_id'])] = float(r['wacc_percent']) / 100
    return np.array([wacc.get(i, np.nan) for i in ids], float)


def values():
    D = json.loads(OUT_DATA.read_text())
    local = arr(D[f'c{T}'])
    common = arr(S[f'c{T}'])          # the article's own mode: one common cost of capital
    w = local_wacc()
    v = {'t091.wacc.common': D['wacc']}
    for gid, names in (('africa', AFRICA), ('europe', EUROPE)):
        sel = np.isin(country, names)
        v[f't091.wacc.{gid}.people'] = round(wmedian(w, pop, sel), 6)
        v[f't091.cost.{gid}.local.people.{T}'] = round(wmedian(local, pop, sel), 4)
        v[f't091.cost.{gid}.common.people.{T}'] = round(wmedian(common, pop, sel), 4)
    every = np.ones(len(ids), bool)
    v[f't091.cost.world.local.people.{T}'] = round(wmedian(local, pop, every), 4)
    v[f't091.cost.world.common.people.{T}'] = round(wmedian(common, pop, every), 4)
    return v


if '--runs' in sys.argv:
    build_data(sys.argv[sys.argv.index('--runs') + 1], sys.argv[sys.argv.index('--previous') + 1] if '--previous' in sys.argv else None)
    vals = values()
    OUT_VALUES.parent.mkdir(parents=True, exist_ok=True)
    OUT_VALUES.write_text(json.dumps(vals, indent=1) + '\n')
    print(f'wrote {OUT_VALUES.relative_to(ROOT)}: ' + ', '.join(f'{k} {q}' for k, q in vals.items()))
elif '--check' in sys.argv:
    want = json.loads(OUT_VALUES.read_text())
    got = values()
    off = {k: (want.get(k), got[k]) for k in got if want.get(k) != got[k]}
    if off or set(want) != set(got):
        print(f'T091 cost-of-capital lens values differ from the committed ones: {off}')
        raise SystemExit(1)
    print(f'T091 cost-of-capital lens: all {len(got)} values recomputed from the committed data equal t091_values.json')
else:
    raise SystemExit(__doc__)
