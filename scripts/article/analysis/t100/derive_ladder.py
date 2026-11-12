#!/usr/bin/env python3
"""derive_ladder.py - the uptime ladder (T100, Kingsmill Bond's comment 4, approved by the human, 9 Nov 2026).

The world's cost of power as uptime rises: for each uptime target, the cheapest build in each region (the atlas's own
worker, run_story.mjs runs all_nb_<T> with wind and sb_nb_<T> solar and batteries only), weighted by electricity demand,
the median (the article's measure; a region that cannot reach the target counts as infinitely dear, as s4.curve); and
"every hour": the 90% build with diesel or gas backup (all_bk_90, sb_bk_90).

  ladder.{sbw,sb}.<T>      T = 25, 30, 40, 50, 60, 70, 80, 90, 95, 99, and 100 for every hour with backup
  ladder.sbNoBatt.25       share of world demand where the cheapest solar and battery build for 25% uptime (sb_nb_25) has
                           no batteries: solar panels alone

Writes team/reports/T100-tables/t100_ladder.json (build-snapshot.mjs embeds it). --check re-derives from the runs and
compares; without the runs file it prints WARN and exits 3 (verify-article reports a WARN, as for analyse_t090.py).
The 90, 95, 99 and every-hour values must equal T089's s4.curve.*.demand.* (checked here and in verify-article).

usage (repo root): python3 scripts/article/analysis/t100/derive_ladder.py [--runs <file>] [--check]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'team/reports/T100-tables/t100_ladder.json'
ap = argparse.ArgumentParser()
ap.add_argument('--runs', default=str(Path.home() / 'wind-atlas-T087/t087_runs.json'))
ap.add_argument('--check', action='store_true')
args = ap.parse_args()
if not Path(args.runs).exists():
    print(f'WARN derive_ladder: no runs file at {args.runs}; the uptime ladder was not re-derived')
    raise SystemExit(3)
R = json.load(open(args.runs))
TARGETS = (25, 30, 40, 50, 60, 70, 80, 90, 95, 99)
ids = [int(i) for i in R['cells']['ids']]
dem = np.array(R['cells']['demand'], float)


def run(key):
    r = R['runs'][key]
    pos = {lid: i for i, lid in enumerate(r['location_id'])}
    at = [pos.get(i) for i in ids]

    def col(k, fill=np.nan):
        return np.array([fill if (j is None or r[k][j] is None) else r[k][j] for j in at], dtype=float)
    meets = col('meetsTarget', 0) > 0
    return {'best': np.where(meets, col('lcoe'), np.inf), 'meets': meets, 'batt': col('batt_gwh', 0), 'wind': col('wind_gw', 0)}


def wmedian(values, weights):
    ok = (weights > 0) & ~np.isnan(values)
    idx = np.nonzero(ok)[0]
    idx = idx[np.argsort(values[idx], kind='stable')]
    cw = np.cumsum(weights[idx])
    k = min(np.searchsorted(cw, 0.5 * cw[-1], side='left'), len(idx) - 1)
    return float(values[idx[k]])


V = {}
for b, pre in (('sbw', 'all'), ('sb', 'sb')):
    for T in TARGETS:
        V[f'ladder.{b}.{T}'] = wmedian(run(f'{pre}_nb_{T}')['best'], dem)
    V[f'ladder.{b}.100'] = wmedian(run(f'{pre}_bk_90')['best'], dem)
# T100 (the human, 9 Nov 2026: "lines for the global average ... from 60% to 100% uptime, where the rest is backup"): power
# every hour of the year, the cheapest build for T% uptime with the app's diesel or gas backup for the rest (all_bk_T,
# sb_bk_T; per MWh of the full load), world demand-weighted AVERAGE over the regions with a cost (those without have no demand)
#   ladder.bk.{sbw,sb}.<T>   T = 60, 70, 80, 90, 95, 99
BK_TARGETS = (60, 70, 80, 90, 95, 99)
for b, pre in (('sbw', 'all'), ('sb', 'sb')):
    for T in BK_TARGETS:
        v = run(f'{pre}_bk_{T}')['best']
        ok = np.isfinite(v) & (dem > 0)
        if dem[~np.isfinite(v)].sum() > 0:
            raise SystemExit(f'derive_ladder: a region with demand has no every-hour cost at {T}% ({pre})')
        V[f'ladder.bk.{b}.{T}'] = float((v[ok] * dem[ok]).sum() / dem[ok].sum())
# the 90% point is the cost-split chart's world total (derive_t100.py s4bk.world.*.total, from the same run)
T100 = json.load(open(ROOT / 'team/reports/T100-tables/t100_values.json'))
for b in ('sbw', 'sb'):
    if abs(V[f'ladder.bk.{b}.90'] - T100[f's4bk.world.{b}.total']) > 0.01:
        raise SystemExit(f'derive_ladder: ladder.bk.{b}.90 {V[f"ladder.bk.{b}.90"]} is not s4bk.world.{b}.total {T100[f"s4bk.world.{b}.total"]}')
r25 = run('sb_nb_25')
V['ladder.sbNoBatt.25'] = float(dem[r25['meets'] & (r25['batt'] <= 0)].sum() / dem.sum())

# the steps the article already states (T089 s4.curve: 90%, 95%, 99% and every hour with backup)
T089 = json.load(open(ROOT / 'team/reports/T089-tables/t089_values.json'))
T089 = T089.get('values', T089)
bad = [(k, V[f'ladder.{b}.{T}'], T089[k]) for b in ('sbw', 'sb') for T in (90, 95, 99, 100)
       for k in [f's4.curve.{b}.demand.{T}'] if abs(V[f'ladder.{b}.{T}'] - T089[k]) > 0.01]
if bad:
    raise SystemExit(f'derive_ladder: the ladder differs from T089 s4.curve: {bad}')

if args.check:
    old = json.loads(OUT.read_text())
    diff = [k for k in set(old) | set(V) if k not in old or k not in V or abs(old[k] - V[k]) > 1e-9 * max(1, abs(old[k]))]
    if diff:
        raise SystemExit('derive_ladder --check: the committed ladder differs from the runs: ' + ', '.join(sorted(diff)))
    print(f'derive_ladder --check: {len(V)} ladder values re-derived from the runs, equal to the committed file; 90/95/99/every hour = T089 s4.curve')
    raise SystemExit(0)
OUT.write_text(json.dumps(V, indent=1, sort_keys=True) + '\n')
print(f'wrote {OUT.relative_to(ROOT)}: {len(V)} values')
for k in sorted(V):
    print(f'  {k} = {V[k]:.4g}')
