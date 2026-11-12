#!/usr/bin/env python3
"""T087: deployment/scrollytelling/data/story-cells.json – the story map's per-region columns beyond the article
summary: weights for the dots (people, demand, land area), the cheapest build's cost at 80, 90, 95 and 99% uptime and
for 100% with backup (90% build + backup), with and without wind, the battery each 90% build needs, the 99% cost for
each cost year 2026-2050 with and without wind (T090), buildable wind in GW (T090), T088's week-long drought frequencies, and planned coal and gas by region (GEM, announced).

Inputs: the runs of scripts/article/analysis/t087/run_story.mjs (the atlas's worker via t089_model.js, Local costs),
deployment/scrollytelling/data/t088_regions.csv (pipeline/scripts/pipeline/t088/export_story.py) and deployment/data
(voronoi_pvout_potential.csv zone areas, voronoi_gem_capacity.csv). The cells are the summary's, in its order.

Checks (the build stops on a miss): every aggregate the article prints from T089 is reproduced from these columns
with T089's own definitions (model.js wmedian / share): the cost curve s4.curve.* and, per MWh of the full load,
s4.curveLoad.* (T095), s1.under100.*, s6.local.*,
s5.med.*, s2 battery hours; the summary's ids and t90 costs agree.

usage (repo root): python3 scripts/article/analysis/t087/build_story_cells.py [--runs ~/wind-atlas-T087/t087_runs.json]
"""
import argparse
import csv
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
DATA = ROOT / 'deployment/data'
SC = ROOT / 'deployment/scrollytelling/data'
ap = argparse.ArgumentParser()
ap.add_argument('--runs', default=str(Path.home() / 'wind-atlas-T087/t087_runs.json'))
args = ap.parse_args()
R = json.load(open(args.runs))
summary = json.load(open(SC / 'article-summary.json'))
V = json.load(open(ROOT / 'team/reports/T089-tables/t089_values.json'))

ids = []
x = 0
for d in summary['cells']['idDelta']:
    x += d
    ids.append(x)
ids = np.array(ids)
n = len(ids)
cell = R['cells']
assert list(cell['ids']) == list(ids), 'run cells differ from the summary cells'
pop = np.array(cell['pop'], float)
dem = np.array(cell['demand'], float)
mapc = np.array(cell['mapCell'], bool)
area = {}
with open(DATA / 'voronoi_pvout_potential.csv') as f:
    for r in csv.DictReader(f):
        area[int(r['location_id'])] = float(r['zone_area_km2'] or 0)
land = np.array([area.get(int(i), 0.0) for i in ids])


def run(key):
    r = R['runs'][key]
    pos = {lid: i for i, lid in enumerate(r['location_id'])}
    at = [pos.get(int(i)) for i in ids]

    def col(k, fill=np.nan):
        return np.array([fill if (j is None or r[k][j] is None) else r[k][j] for j in at], dtype=float)
    meets = col('meetsTarget', 0) > 0
    # T095: the cost per MWh of the full load (1 GW x 8760 h): LCOE x the build's delivered energy / the full load
    per_load = np.where(meets, col('lcoe') * col('annual_energy_mwh') / (8760 * 1000), np.inf) if 'annual_energy_mwh' in r else None
    adder = np.where(meets, col('backup_lcoe_adder'), np.nan) if 'backup_lcoe_adder' in r else None
    return {'best': np.where(meets, col('lcoe'), np.inf), 'batt': col('batt_gwh'), 'meets': meets, 'perLoad': per_load, 'adder': adder}


def wmedian(values, weights, sel=None):
    values = np.asarray(values, float)
    ok = (weights > 0) & ~np.isnan(values)
    if sel is not None:
        ok &= sel
    idx = np.nonzero(ok)[0]
    idx = idx[np.argsort(values[idx], kind='stable')]
    cw = np.cumsum(weights[idx])
    k = min(np.searchsorted(cw, 0.5 * cw[-1], side='left'), len(idx) - 1)
    return float(values[idx[k]])


def share(mask, weights, sel=None):
    s = np.ones(n, bool) if sel is None else sel
    return float(weights[s & mask].sum() / weights[s].sum())


cols = {}
for T in (80, 90, 95, 99):
    for b in ('all', 'sb'):
        cols[f'c{T}{"" if b == "all" else "sb"}'] = run(f'{b}_nb_{T}')['best']
for b in ('all', 'sb'):
    cols[f'c100{"" if b == "all" else "sb"}'] = run(f'{b}_bk_90')['best']
a90, b90 = run('all_nb_90'), run('sb_nb_90')
cols['batt90'] = a90['batt']
cols['batt90sb'] = b90['batt']
YEARS = [Y for Y in (2026, 2030, 2035, 2040, 2045, 2050) if f'all_y{Y}_99' in R['runs']]
if len(YEARS) < 6:
    print('WARN: no cost-year runs in', args.runs, '(test only: run run_story.mjs for the real file)')
for Y in YEARS:
    cols[f'c99y{Y}'] = run(f'all_y{Y}_99')['best']
# T090: the same cost years without wind (run_story.mjs's sb_y<Y>_99 runs: onshore off, offshore off), for the saving
# from wind at 99% uptime to 2050 (section 8)
for Y in YEARS:
    cols[f'c99sbY{Y}'] = run(f'sb_y{Y}_99')['best']
# T100 (the human, 9 Nov 2026: section 8 on "the 90% case", every hour with backup): the 90% build with diesel or gas
# backup at each cost year, with wind (c100y<Y>) and without (c100sbY<Y>); and the backup's own cost per MWh of the full
# load in the base year (bk90adder, bk90addersb: the worker's backup_lcoe_adder), for section 4's chart
BK_YEARS = [Y for Y in (2026, 2030, 2035, 2040, 2045, 2050) if f'all_ybk{Y}_90' in R['runs']]
if len(BK_YEARS) < 6:
    raise SystemExit(f'build_story_cells: no backup cost-year runs (all_ybk<Y>_90) in {args.runs}: rerun run_story.mjs')
for Y in BK_YEARS:
    cols[f'c100y{Y}'] = run(f'all_ybk{Y}_90')['best']
    cols[f'c100sbY{Y}'] = run(f'sb_ybk{Y}_90')['best']
cols['bk90adder'] = run('all_bk_90')['adder']
cols['bk90addersb'] = run('sb_bk_90')['adder']

# ---- checks against T089's published aggregates ------------------------------------------------------------
bad = []


def same(key, got, tol):
    ref = V[key]
    if not (abs(got - ref) <= tol):
        bad.append((key, ref, got))


for T in (80, 90, 95, 99, 100):
    same(f's4.curve.sbw.demand.{T}', wmedian(cols[f'c{T}'], dem), 0.01)
    same(f's4.curve.sb.demand.{T}', wmedian(cols[f'c{T}sb'], dem), 0.01)
# T095: the chart's 90/95/99 bars per MWh of the full load (s4.curveLoad.*), from the runs' delivered energy
for T in (90, 95, 99):
    for b, name in (('all', 'sbw'), ('sb', 'sb')):
        pl = run(f'{b}_nb_{T}')['perLoad']
        if pl is None:
            bad.append((f's4.curveLoad.{name}.*.{T}', 'runs without annual_energy_mwh', 'rerun run_story.mjs'))
            continue
        for w, wt in (('demand', dem), ('people', pop)):
            same(f's4.curveLoad.{name}.{w}.{T}', wmedian(pl, wt), 0.01)
for b, k in (('sbw', 'c90'), ('sb', 'c90sb')):
    same(f's1.under100.{b}.demand.90', share(cols[k] <= 100, dem), 1e-9)
    same(f's5.med.{b}.people.90', wmedian(cols[k], pop), 0.01)
    same(f's5.med.{b}.area.90', wmedian(cols[k], land, mapc), 0.01)
# summary's t90 costs are the same searches
res = summary['results']['t90']
lc = np.array([np.nan if v is None else v for v in res['lcoe']], float)
ok = np.isfinite(lc) & np.isfinite(cols['c90'])
if np.nanmax(np.abs(lc[ok] - cols['c90'][ok])) > 0.01:
    bad.append(('summary t90 lcoe', 0, float(np.nanmax(np.abs(lc[ok] - cols['c90'][ok])))))
# T100: the 2026 backup year runs are the base backup runs; the backup adder's demand-weighted median is T089's
for k0, k1 in (('c100y2026', 'c100'), ('c100sbY2026', 'c100sb')):
    if np.nanmax(np.abs(np.where(np.isfinite(cols[k1]), cols[k0] - cols[k1], 0))) > 1e-9 or (np.isfinite(cols[k0]) != np.isfinite(cols[k1])).any():
        bad.append((f'{k0} vs {k1}', 0, 1))
for b, k in (('sbw', 'bk90adder'), ('sb', 'bk90addersb')):
    same(f's4.adder.{b}.demand', wmedian(cols[k], dem, np.isfinite(cols['c100' if b == 'sbw' else 'c100sb'])), 0.01)
# year 2026 at 99% equals the base run
if YEARS and np.nanmax(np.abs(np.where(np.isfinite(cols['c99']), cols['c99y2026'] - cols['c99'], 0))) > 0.01:
    bad.append(('c99y2026 vs c99', 0, 1))
if YEARS and np.nanmax(np.abs(np.where(np.isfinite(cols['c99sb']), cols['c99sbY2026'] - cols['c99sb'], 0))) > 0.01:
    bad.append(('c99sbY2026 vs c99sb', 0, 1))

# planned coal and gas by region (GEM announced coal + oil and gas, as T089)
gem = {}
with open(DATA / 'voronoi_gem_capacity.csv') as f:
    for r in csv.DictReader(f):
        gem[int(r['location_id'])] = (float(r['coal_Announced'] or 0) + float(r['oil_gas_Announced'] or 0)) / 1000
plan = np.array([gem.get(int(i), 0.0) for i in ids])
same('s6.planned.gw', plan.sum(), 0.01)
for T in (80, 90):
    for b, k in (('sbw', f'c{T}'), ('sb', f'c{T}sb')):
        same(f's6.local.{b}.under100.{T}.gw', plan[cols[k] <= 100].sum(), 0.01)
# T090 (the human, D-161): the third tier of section 6, solar, wind and batteries under $130/MWh at the same 80% test,
# written for the summary (build-snapshot.mjs embeds team/reports/T090-tables/t090_s6.json)
TIER2_USD = 130
country = np.array(cell['country'], dtype=object)
t6 = {'s6.local.sbw.under130.80.gw': float(plan[cols['c80'] <= TIER2_USD].sum()),
      's6.local.sbw.under130.80.share': float(plan[cols['c80'] <= TIER2_USD].sum() / plan.sum()),
      's6c.china.sbw_under130_80': float(plan[(cols['c80'] <= TIER2_USD) & (country == 'China')].sum())}
if not (t6['s6.local.sbw.under130.80.gw'] >= V['s6.local.sbw.under100.80.gw'] - 1e-9):
    bad.append(('s6 tiers', V['s6.local.sbw.under100.80.gw'], t6['s6.local.sbw.under130.80.gw']))
(ROOT / 'team/reports/T090-tables').mkdir(parents=True, exist_ok=True)
(ROOT / 'team/reports/T090-tables/t090_s6.json').write_text(json.dumps(t6, indent=1, sort_keys=True) + '\n')
# battery hours, northern groups as T089 (demand-weighted median where both builds reach 90%)
both = np.isfinite(cols['c90']) & np.isfinite(cols['c90sb'])
same('s2.world.sb_batt_h.90', wmedian(cols['batt90sb'], dem, both), 1e-6)
same('s2.world.sbw_batt_h.90', wmedian(cols['batt90'], dem, both), 1e-6)
if bad:
    raise SystemExit('story-cells: aggregates differ from T089: ' + json.dumps(bad))

# wind potential (conservative case: onshore T078 + fixed-bottom offshore, World Bank/ESMAP) / own demand, as T089 s7
cons = np.array(cell['consOnTwh'], float) + np.array(cell['consFixTwh'], float)
with np.errstate(divide='ignore', invalid='ignore'):
    mult = np.where(dem > 0, cons / np.where(dem > 0, dem, 1), np.inf)
same('s7.cons.1x.people', share(mult >= 1, pop), 1e-9)
same('s7.cons.1x.demand', share(mult >= 1, dem), 1e-9)
same('s7.cons.10x.people', share(mult >= 10, pop), 1e-9)
if bad:
    raise SystemExit('story-cells: aggregates differ from T089: ' + json.dumps(bad))
cols['multCons'] = np.where(np.isfinite(mult), mult, 1e9)
# T090: buildable wind in GW, conservative case (onshore T078 on_cons_gw + fixed-bottom offshore World Bank/ESMAP
# fix_esmap_gw, the app's own deployment/data/voronoi_wind_potential_defs.csv, capacity as published there)
gwp = {}
with open(DATA / 'voronoi_wind_potential_defs.csv') as f:
    for r in csv.DictReader(f):
        gwp[int(r['location_id'])] = float(r['on_cons_gw'] or 0) + float(r['fix_esmap_gw'] or 0)
cols['potGw'] = np.array([gwp.get(int(i), 0.0) for i in ids])

# T088 drought frequencies
t88 = {}
with open(SC / 't088_regions.csv') as f:
    next(f)
    for r in csv.DictReader(f):
        t88[int(r['location_id'])] = [float(r[c]) if r[c] else None for c in ('w7_t50_ps', 'w7_t50_pw', 'w7_t50_pboth')]


def enc(a, dp=2):
    return [None if not math.isfinite(v) else round(float(v), dp) for v in a]


out = {
    'source': 'T087 scripts/article/analysis/t087/build_story_cells.py from run_story.mjs (the atlas worker, Local costs, 2026 and cost years to 2050), '
              'T088 t088_regions.csv, deployment/data voronoi_pvout_potential.csv and voronoi_gem_capacity.csv',
    'n': n,
    'pop': enc(pop, 0), 'demand': enc(dem, 3), 'land': enc(land, 0), 'planned': enc(plan, 3),
    **{k: enc(v) for k, v in cols.items()},
    'droughtSolar': [t88.get(int(i), [None] * 3)[0] for i in ids],
    'droughtWind': [t88.get(int(i), [None] * 3)[1] for i in ids],
    'droughtBoth': [t88.get(int(i), [None] * 3)[2] for i in ids],
}
(SC / 'story-cells.json').write_text(json.dumps(out, separators=(',', ':')))
print(f'wrote deployment/scrollytelling/data/story-cells.json: {n} cells, {len(out) - 2} columns; T089 aggregates reproduced')
