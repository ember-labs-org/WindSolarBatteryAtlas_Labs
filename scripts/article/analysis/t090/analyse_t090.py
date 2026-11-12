#!/usr/bin/env python3
"""T090: the key findings' new metrics, from the same runs as the story map (scripts/article/analysis/t087/run_story.mjs:
the atlas's own worker, Local costs) and the atlas's own data. Writes team/reports/T090-tables/t090_values.json, which
build-snapshot.mjs embeds in the article summary (every key with its definition below), and t090_bands.csv.

  s2.n45p.{sb,sbw}_demand.90   the north (finding 2): demand-weighted median cost of 90% uptime in regions whose site
                               lies at or north of 45°N (section 2's latitude bands: 30–45°, 45–55°, 55°+), without and
                               with wind. As T089's s2 groups: the cheapest build's cost, infinite where it misses 90%.
  s4.adder.{fixed,var}.{sbw,sb}.demand
                               the backup split (finding 4): the region at the demand-weighted median backup cost
                               (T089 s4.adder.*.demand, the same median and the same region) split into its two parts,
                               as lcoe-worker.js prices them: fixed = the turbine's capital (capex x CRF, sized to the
                               full load), paid whether it runs or not; variable = the fuel it burns in the hours it runs
                               (backup share x 8,760 h x fuel cost per MWh). fixed + var = that region's backup cost =
                               the bound median exactly. The model has no fixed or variable O&M for backup.
  s7.gw{1,10,100}.{people,demand}
                               wind to add (finding 6): share of the world's people and electricity demand (map cells, as
                               T089 s7) in regions with at least 1, 10 or 100 GW of buildable wind of their own, on the
                               conservative case: onshore T078 (on_cons_gw) + fixed-bottom offshore World Bank/ESMAP
                               (fix_esmap_gw), both from deployment/data/voronoi_wind_potential_defs.csv (capacity as
                               published there, not derived from TWh).
  s7.gw1.restNoGain.people     of the people in regions under 1 GW, the share living where wind does not lower the cost
                               of 90% uptime (T089's "lower" test: built with wind, both builds reach 90%).
  s7.gw1.regions               share of map regions with at least 1 GW.
  s8.lower.demand.<Y>          wind to 2050 (finding 7): share of world demand where the cheapest build at 99% uptime
                               includes wind and costs less than the cheapest without it, both reaching 99% (T089's
                               test), cost year Y (2026, 2030, ..., 2050; model.js local cost paths).
  s8.n45p.saving.<Y>           demand-weighted median saving from wind at 99% uptime north of 45°N, cost year Y.
  s8.band.<band>.saving.<Y>    the same by band of absolute latitude (section 2's and the morph's bands).
  s1.wacc.<ISO>, s1.cost.sb.<ISO>.90
                               section 1's border explainer: the national cost of capital the app uses (Hatton et al.,
                               as published, D-141) and the demand-weighted median cost of 90% uptime without wind.

usage (repo root): python3 scripts/article/analysis/t090/analyse_t090.py [--runs ~/wind-atlas-T087/t087_runs.json]
"""
import argparse
import csv
import json
import re
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
DATA = ROOT / 'deployment/data'
OUT = ROOT / 'team/reports/T090-tables'
ap = argparse.ArgumentParser()
ap.add_argument('--runs', default=str(Path.home() / 'wind-atlas-T087/t087_runs.json'))
ap.add_argument('--check', action='store_true', help='re-derive and compare with the committed t090_values.json and t090_s6.json; write nothing')
args = ap.parse_args()
if not Path(args.runs).exists():
    print(f'SKIP analyse_t090: no runs file {args.runs} (run scripts/article/analysis/t087/run_story.mjs)')
    raise SystemExit(3)
R = json.load(open(args.runs))
C = R['cells']
P = R['params']
ids = np.array(C['ids'])
n = len(ids)
lat = np.array(C['lat'], float)
pop = np.array(C['pop'], float)
dem = np.array(C['demand'], float)
mapc = np.array(C['mapCell']) == 1
T089 = json.load(open(ROOT / 'team/reports/T089-tables/t089_values.json'))

# The worker's own fuel constants, read from lcoe-worker.js (not copied), so the split prices fuel exactly as the model.
WORKER = (ROOT / 'deployment/js/workers/lcoe-worker.js').read_text()


def worker_const(name):
    return float(re.search(r'const %s = ([\d.]+);' % name, WORKER).group(1))


MMBTU_PER_MWH = worker_const('MMBTU_PER_MWH')
DIESEL_KWH_PER_L = worker_const('DIESEL_THERMAL_KWH_PER_LITER')
DIESEL_MIN_USD_PER_L = worker_const('DIESEL_PRICE_FLOOR_USD_PER_LITER')
HOURS = 8760.0

V = {}


def put(k, v):
    V[k] = float(v)


def run(key):
    r = R['runs'][key]
    pos = {lid: i for i, lid in enumerate(r['location_id'])}
    at = [pos.get(int(i)) for i in ids]

    def col(k, fill=np.nan):
        return np.array([fill if (j is None or r[k][j] is None) else r[k][j] for j in at], dtype=object)
    meets = np.array([bool(x) for x in col('meetsTarget', False)])
    o = {'meets': meets, 'lcoe': col('lcoe').astype(float), 'wind': col('wind_gw', 0).astype(float)}
    o['best'] = np.where(meets, o['lcoe'], np.inf)
    for k in ('backup_lcoe_adder', 'backup_share_cf', 'gas_price_usd_per_mmbtu', 'diesel_price_usd_per_liter'):
        if k in r:
            o[k] = col(k).astype(float)
    if 'backup_fuel' in r:
        o['backup_fuel'] = col('backup_fuel', None)
    return o


def wmedian_at(values, weights, sel=None):
    """model.js wmedian: the value and the index of the region at the weighted median."""
    values = np.asarray(values, float)
    ok = (weights > 0) & ~np.isnan(values)
    if sel is not None:
        ok &= sel
    idx = np.nonzero(ok)[0]
    idx = idx[np.argsort(values[idx], kind='stable')]
    cw = np.cumsum(weights[idx])
    k = min(np.searchsorted(cw, 0.5 * cw[-1], side='left'), len(idx) - 1)
    return float(values[idx[k]]), int(idx[k])


def wmedian(values, weights, sel=None):
    return wmedian_at(values, weights, sel)[0]


def share(mask, w, sel=None):
    s = np.ones(n, bool) if sel is None else sel
    return float(w[s & mask].sum() / w[s].sum())


bad = []

# ---- finding 2: north of 45°N -----------------------------------------------------------------------------
NORTH = lat >= 45
a90, b90 = run('all_nb_90'), run('sb_nb_90')
put('s2.n45p.sb_demand.90', wmedian(b90['best'], dem, NORTH))
put('s2.n45p.sbw_demand.90', wmedian(a90['best'], dem, NORTH))
put('s2.n45p.demandShare', share(NORTH, dem))
put('s2.n45p.sbReach.90', share(b90['meets'], dem, NORTH))

# ---- finding 4: the backup split ----------------------------------------------------------------------------
for name, key in (('sbw', 'all_bk_90'), ('sb', 'sb_bk_90')):
    r_ = run(key)
    ok = r_['meets'] & np.isfinite(r_['lcoe'])
    add = r_['backup_lcoe_adder']
    gas_fuel = r_['gas_price_usd_per_mmbtu'] * MMBTU_PER_MWH / P['gasEfficiency']                    # $/MWh of backup output
    diesel_fuel = np.maximum(r_['diesel_price_usd_per_liter'], DIESEL_MIN_USD_PER_L) * 1000 / (P['dieselEfficiency'] * DIESEL_KWH_PER_L)
    is_gas = r_['backup_fuel'] == 'gas'
    var = r_['backup_share_cf'] * np.where(is_gas, gas_fuel, diesel_fuel)       # per MWh of the full load
    fixed = add - var
    med, i = wmedian_at(add, dem, ok)
    if abs(med - T089[f's4.adder.{name}.demand']) > 1e-6:
        bad.append((f's4.adder.{name}.demand', T089[f's4.adder.{name}.demand'], med))
    put(f's4.adder.fixed.{name}.demand', fixed[i])
    put(f's4.adder.var.{name}.demand', var[i])
    put(f's4.adder.share.{name}.demand', r_['backup_share_cf'][i])
    V[f's4.adder.fuel.{name}.demand'] = str(r_['backup_fuel'][i])
    # cross-checks: the fixed part is the turbine's annuity at a plausible rate (CRF of 2-25% a year over its life),
    # and the separate demand-weighted medians of each part sit close to the median region's
    life, capex = (P['gasLife'], P['gasCapex']) if is_gas[i] else (P['dieselLife'], P['dieselCapex'])
    crf = fixed[i] * HOURS / 1000 / capex
    lo, hi = [w / (1 - (1 + w) ** -life) for w in (0.02, 0.25)]
    if not (lo <= crf <= hi):
        bad.append((f'{name} fixed part implies CRF {crf:.4f}', lo, hi))
    put(f's4.adder.fixedMedian.{name}.demand', wmedian(fixed, dem, ok))
    put(f's4.adder.varMedian.{name}.demand', wmedian(var, dem, ok))

# ---- finding 6: wind to add, in GW ---------------------------------------------------------------------------
gw = {}
with open(DATA / 'voronoi_wind_potential_defs.csv') as f:
    for r in csv.DictReader(f):
        gw[int(r['location_id'])] = float(r['on_cons_gw'] or 0) + float(r['fix_esmap_gw'] or 0)
pot = np.array([gw.get(int(i), 0.0) for i in ids])
for t in (1, 10, 100):
    put(f's7.gw{t}.people', share(pot >= t, pop, mapc))
    put(f's7.gw{t}.demand', share(pot >= t, dem, mapc))
put('s7.gw1.regions', float((mapc & (pot >= 1)).sum() / mapc.sum()))
lower90 = a90['meets'] & (a90['wind'] > 0) & b90['meets']
put('s7.gw1.restNoGain.people', share(~lower90, pop, mapc & (pot < 1)))

# ---- finding 7: wind to 2050, at 99% uptime -----------------------------------------------------------------
YEARS = [2026, 2030, 2035, 2040, 2045, 2050]
BANDS = {'a0_15': (0, 15), 'a15_30': (15, 30), 'a30_45': (30, 45), 'a45_55': (45, 55), 'a55p': (55, 91)}
bands = []
for Y in YEARS:
    a, b = run(f'all_y{Y}_99'), run(f'sb_y{Y}_99')
    both = a['meets'] & b['meets']
    put(f's8.lower.demand.{Y}', share(both & (a['wind'] > 0), dem))
    sav = np.where(both, b['best'] - a['best'], np.nan)
    put(f's8.n45p.saving.{Y}', wmedian(sav, dem, NORTH & both))
    put(f's8.n45p.sb.{Y}', wmedian(b['best'], dem, NORTH))
    put(f's8.n45p.sbw.{Y}', wmedian(a['best'], dem, NORTH))
    put(f's8.n45p.sbReach.{Y}', share(b['meets'], dem, NORTH))
    for bid, (lo, hi) in BANDS.items():
        sel = (np.abs(lat) >= lo) & (np.abs(lat) < hi)
        put(f's8.band.{bid}.saving.{Y}', wmedian(sav, dem, sel & both))
        bands.append({'band': bid, 'year': Y, 'saving_median': V[f's8.band.{bid}.saving.{Y}'], 'lower_share': share(both & (a['wind'] > 0), dem, sel)})
# 2026 at 99% must be the base run (as build_story_cells.py checks for the costs)
a99 = run('all_nb_99')
if np.nanmax(np.abs(np.where(np.isfinite(a99['best']), run('all_y2026_99')['best'] - a99['best'], 0))) > 0.01:
    bad.append(('all_y2026_99 vs all_nb_99', 0, 1))

# ---- section 1, the border explainer (addendum 3): the cost of capital the app uses (deployment/data/voronoi_wacc.csv,
# Hatton et al. as published, D-141; the national figure, source "country") and the demand-weighted median cost of 90%
# uptime with solar and batteries alone, for countries in conflict or deep political instability and a neighbour each.
# Only pairs where the first stands out against its neighbour on the map are used in the text (Venezuela/Colombia);
# the others are reported in the hand-off.
wacc_nat = {}
with open(DATA / 'voronoi_wacc.csv') as f:
    for r in csv.DictReader(f):
        if r['source'] == 'country' and r['wacc_iso3'] == r['country_iso3'] and r['wacc_percent']:
            wacc_nat.setdefault(r['country_iso3'], set()).add(float(r['wacc_percent']) / 100)
country = np.array(C['country'], dtype=object)
NAMES = {'VEN': 'Venezuela', 'COL': 'Colombia', 'SDN': 'Sudan', 'EGY': 'Egypt', 'UKR': 'Ukraine', 'POL': 'Poland', 'YEM': 'Yemen', 'SAU': 'Saudi Arabia'}
for iso, name in NAMES.items():
    w = wacc_nat[iso]
    if len(w) != 1:
        bad.append((f'one national cost of capital for {iso}', 1, len(w)))
    put(f's1.wacc.{iso}', next(iter(w)))
    put(f's1.cost.sb.{iso}.90', wmedian(b90['best'], dem, country == name))
if args.check:
    # the committed values must be what the runs give now; and section 6's tier (build_story_cells.py) what the
    # committed story cells give
    old = json.load(open(OUT / 't090_values.json'))
    diff = [k for k in set(old) | set(V) if k not in old or k not in V or (isinstance(V[k], float) and abs(V[k] - old[k]) > 1e-9 * max(1, abs(old[k]))) or (isinstance(V[k], str) and V[k] != old[k])]
    S = json.load(open(ROOT / 'deployment/scrollytelling/data/story-cells.json'))
    c80 = np.array([np.inf if v is None else v for v in S['c80']]); plan = np.array(S['planned'], float)
    s6 = json.load(open(OUT / 't090_s6.json'))
    if abs(plan[c80 <= 130].sum() - s6['s6.local.sbw.under130.80.gw']) > 0.01:
        diff.append('s6.local.sbw.under130.80.gw')
    if diff:
        raise SystemExit('analyse_t090 --check: the committed values differ from the runs: ' + ', '.join(sorted(diff)[:20]))
    print(f'analyse_t090 --check: {len(V)} values and the section 6 tier re-derived, equal to the committed files')
    raise SystemExit(0)
if bad:
    raise SystemExit('analyse_t090: checks failed: ' + json.dumps(bad))
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 't090_values.json').write_text(json.dumps(V, indent=1, sort_keys=True) + '\n')
with open(OUT / 't090_bands.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(bands[0]))
    w.writeheader()
    for r in bands:
        w.writerow({k: (f'{v:.4g}' if isinstance(v, float) else v) for k, v in r.items()})
print(f'wrote {OUT.relative_to(ROOT)}/t090_values.json: {len(V)} values; checks passed')
for k in ('s2.n45p.sb_demand.90', 's2.n45p.sbw_demand.90', 's4.adder.fixed.sbw.demand', 's4.adder.var.sbw.demand', 's7.gw1.people', 's7.gw1.demand',
          's7.gw10.people', 's7.gw10.demand', 's7.gw1.restNoGain.people', 's8.lower.demand.2026', 's8.lower.demand.2050', 's8.n45p.saving.2026', 's8.n45p.saving.2050'):
    print(f'  {k} = {V[k]:.4g}')
