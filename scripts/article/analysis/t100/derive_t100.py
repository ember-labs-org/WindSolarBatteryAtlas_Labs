#!/usr/bin/env python3
"""derive_t100.py - the article's new figures for the 9 Nov 2026 feedback (T100, D-179), from committed data only.

Inputs (all committed, no new model run):
  deployment/scrollytelling/data/story-cells.json   c100 (90% build + backup, run_story.mjs all_bk_90), c90, c90sb, pop,
                                                    demand, planned, droughtSolar/Both (T088 t088_regions.csv)
  deployment/scrollytelling/data/article-summary.json   cells.lat (each region's site latitude; not a derived value)
Output: team/reports/T100-tables/t100_values.json (embedded into the summary by build-snapshot.mjs).

  s6.local.sbw.bk90.under100.gw / .share   planned coal and gas (GEM announced) in regions where power every hour of
      the year - the cheapest solar, wind and battery build for 90% uptime with diesel or gas backup for the rest
      (story-cells c100) - costs under $100/MWh; the same test as the section 6 histogram's marker (cost < 100)
  s6.local.sb.bk90.under100.gw             the same without wind (c100sb)
  dunkel.a0_15.{solar,both}Every           1 / demand-weighted share of weeks in drought, regions within 15 degrees
                                           of the equator (|lat| < 15, section 2's first band); regions without T088
                                           data left out, as for the world figure
  s5.lower.{people,demand}.a30p.90 / a45p  share of people (demand) at or beyond 30 (45) degrees north or south living
                                           where adding wind lowers the cost of 90% uptime (c90 < c90sb: the cheapest
                                           build includes wind; both builds reach 90% everywhere they are defined)

usage (repo root): python3 scripts/article/analysis/t100/derive_t100.py [--check]
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
DATA = ROOT / 'deployment/scrollytelling/data'
OUT = ROOT / 'team/reports/T100-tables/t100_values.json'

S = json.loads((DATA / 'story-cells.json').read_text())
lat = np.array(json.loads((DATA / 'article-summary.json').read_text())['cells']['lat'], float)
n = S['n']
assert len(lat) == n, 'summary cells and story cells differ'


def col(k, none=np.inf):
    return np.array([none if v is None else v for v in S[k]], float)


pop, dem, plan = col('pop', 0), col('demand', 0), col('planned', 0)
V = {}
for b, k in (('sbw', 'c100'), ('sb', 'c100sb')):
    V[f's6.local.{b}.bk90.under100.gw'] = float(plan[col(k) < 100].sum())
V['s6.local.sbw.bk90.under100.share'] = V['s6.local.sbw.bk90.under100.gw'] / float(plan.sum())

sol, both = col('droughtSolar', np.nan), col('droughtBoth', np.nan)
ok = ~np.isnan(sol) & ~np.isnan(both)
eq = ok & (np.abs(lat) < 15)
w = dem[eq]
V['dunkel.a0_15.solarEvery'] = float(w.sum() / (sol[eq] * w).sum())
V['dunkel.a0_15.bothEvery'] = float(w.sum() / (both[eq] * w).sum())
V['dunkel.a0_15.demandShare'] = float(dem[eq].sum() / dem[ok].sum())

lower = col('c90') < col('c90sb') - 1e-9
for lo in (30, 45):
    m = np.abs(lat) >= lo
    for name, wt in (('people', pop), ('demand', dem)):
        V[f's5.lower.{name}.a{lo}p.90'] = float(wt[m & lower].sum() / wt[m].sum())

# ---- T100 round 3 (the human, 9 Nov 2026): section 8 and its charts on "the 90% case": power every hour of the year from
# the 90% build with diesel or gas backup (story-cells c100y<Y>, c100sbY<Y>: run_story.mjs all_ybk<Y>_90, sb_ybk<Y>_90).
#   s8bk.med.{sbw,sb}.demand.<Y>   demand-weighted median cost, every hour with backup, cost year Y
#   s8bk.lower.demand.<Y>          share of demand where adding wind lowers that cost (with wind < without; backup always
#                                  reaches every hour, so no region is left out)
#   s8bk.n45p.saving.<Y>           demand-weighted median saving (without - with) at site latitude >= 45 N (as s8.n45p)
#   s8bk.band.<band>.saving.<Y>    the same by band of absolute latitude (bands as analyse_t090.py)
# Section 4's chart (the human chose "show the cost split", 9 Nov 2026): the cost of power every hour of the year (the 90%
# build with diesel or gas backup, story-cells c100, c100sb) split into the renewable part (solar, wind, batteries) and the
# backup part (the worker's backup_lcoe_adder, story-cells bk90adder, bk90addersb), without and with wind, the world and by
# band of absolute latitude. Demand-weighted MEANS of each part, so the parts add up to the bar (medians of the parts do
# not: the world's with-wind parts would add to $94 against a median total of $89). Regions without a cost (66, no demand)
# are left out.
#   s4bk.<world|band>.{sbw,sb}.{renew,backup,total}
BANDS = {'a0_15': (0, 15), 'a15_30': (15, 30), 'a30_45': (30, 45), 'a45_55': (45, 55), 'a55p': (55, 91)}
YEARS = (2026, 2030, 2035, 2040, 2045, 2050)


def wmedian_at(values, weights, sel):
    """The demand-weighted median (as analyse_t089.py wmedian) and the index of the region that carries it."""
    ok = sel & (weights > 0) & ~np.isnan(values)
    idx = np.nonzero(ok)[0]
    idx = idx[np.argsort(values[idx], kind='stable')]
    cw = np.cumsum(weights[idx])
    k = min(np.searchsorted(cw, 0.5 * cw[-1], side='left'), len(idx) - 1)
    return float(values[idx[k]]), int(idx[k])


alat = np.abs(lat)
north = lat >= 45
everywhere = np.ones(n, bool)
for Y in YEARS:
    a, b = col(f'c100y{Y}'), col(f'c100sbY{Y}')
    both = np.isfinite(a) & np.isfinite(b)
    # the regions with no cost (no priced build: 66 regions, no electricity demand) are left out; every other region
    # reaches every hour with backup
    if dem[~both].sum() > 0:
        raise SystemExit(f'derive_t100: power every hour with backup is missing for a region with demand in {Y}')
    with np.errstate(invalid='ignore'):
        sav = np.where(both, b - a, np.nan)
    V[f's8bk.med.sbw.demand.{Y}'] = wmedian_at(a, dem, both)[0]
    V[f's8bk.med.sb.demand.{Y}'] = wmedian_at(b, dem, both)[0]
    V[f's8bk.lower.demand.{Y}'] = float(dem[both & (a < b - 1e-9)].sum() / dem.sum())
    V[f's8bk.n45p.saving.{Y}'] = wmedian_at(sav, dem, north)[0]
    for bid, (lo, hi) in BANDS.items():
        V[f's8bk.band.{bid}.saving.{Y}'] = wmedian_at(sav, dem, (alat >= lo) & (alat < hi))[0]
for b, k, ak in (('sbw', 'c100', 'bk90adder'), ('sb', 'c100sb', 'bk90addersb')):
    tot, add = col(k), col(ak, np.nan)
    for bid, sel in [('world', everywhere)] + [(bid, (alat >= lo) & (alat < hi)) for bid, (lo, hi) in BANDS.items()]:
        ok = sel & np.isfinite(tot) & np.isfinite(add) & (dem > 0)
        w = dem[ok]
        V[f's4bk.{bid}.{b}.backup'] = float((add[ok] * w).sum() / w.sum())
        V[f's4bk.{bid}.{b}.renew'] = float(((tot - add)[ok] * w).sum() / w.sum())
        V[f's4bk.{bid}.{b}.total'] = V[f's4bk.{bid}.{b}.renew'] + V[f's4bk.{bid}.{b}.backup']

# T100 round 7 (the human's draft): the share of the world's people where power every hour of the year (the 90% build with
# backup, story-cells c100) costs under $100/MWh - the section 5 histogram's own marker ("more than three-quarters")
V['s5.c100under100.people'] = float(pop[col('c100') < 100].sum() / pop.sum())

# ---- T102 (GWEC review comments, 11 Nov 2026): the storage line beyond Canada and Europe, and the far south.
#   t102.batt.<china|india|us>.{sb,sbw}.90   battery (hours of load) for 90% uptime, demand-weighted median over the
#       country's regions where both builds reach 90% (story-cells batt90sb / batt90) - as analyse_t089.py's s2.<group>
#       (asserted below: the same method reproduces s2.canada and s2.europe)
#   t102.south40.{sb,sbw}.demand.90          demand-weighted median cost of 90% uptime, Chile and Argentina at or south
#       of 40 S (site latitude), unmet regions as +inf (as s2.n45p)
_A = json.loads((DATA / 'article-summary.json').read_text())
_names = np.array(_A['cells']['countries'], object)[np.array(_A['cells']['country'])]
_b, _bsb = col('batt90', np.nan), col('batt90sb', np.nan)
_both = np.isfinite(col('c90')) & np.isfinite(col('c90sb'))


def _wmed(v, w, sel):
    ok = (w > 0) & ~np.isnan(v) & sel
    idx = np.nonzero(ok)[0]
    idx = idx[np.argsort(v[idx], kind='stable')]
    cw = np.cumsum(w[idx])
    return float(v[idx[min(np.searchsorted(cw, 0.5 * cw[-1], side='left'), len(idx) - 1)]])


_EUROPE = ['Albania', 'Austria', 'Belarus', 'Belgium', 'Bosnia and Herz.', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Denmark',
           'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Iceland', 'Ireland', 'Italy', 'Latvia', 'Lithuania',
           'Moldova', 'Montenegro', 'Netherlands', 'North Macedonia', 'Norway', 'Poland', 'Portugal', 'Romania', 'Serbia',
           'Slovakia', 'Spain', 'Sweden', 'Switzerland', 'Ukraine', 'United Kingdom']
_ref = _A['values']
for gid, sel in (('canada', _names == 'Canada'), ('europe', np.isin(_names, _EUROPE))):
    for b, arr in (('sb', _bsb), ('sbw', _b)):
        assert _wmed(arr, dem, sel & _both) == _ref[f's2.{gid}.{b}_batt_h.90'], f'T102 battery method differs from s2.{gid}'
for gid, name in (('china', 'China'), ('india', 'India'), ('us', 'United States of America')):
    for b, arr in (('sb', _bsb), ('sbw', _b)):
        V[f't102.batt.{gid}.{b}.90'] = _wmed(arr, dem, (_names == name) & _both)
_south = np.isin(_names, ['Chile', 'Argentina']) & (lat <= -40)
for b, k in (('sbw', 'c90'), ('sb', 'c90sb')):
    V[f't102.south40.{b}.demand.90'] = _wmed(col(k), dem, _south)

if '--check' in sys.argv:
    old = json.loads(OUT.read_text())
    diff = [k for k in set(old) | set(V) if k not in old or k not in V or abs(old[k] - V[k]) > 1e-9 * max(1, abs(old[k]))]
    if diff:
        raise SystemExit('derive_t100 --check: the committed T100 values differ from the committed data: ' + ', '.join(sorted(diff)))
    print(f'derive_t100 --check: {len(V)} T100 values re-derived from story-cells.json, equal to the committed file')
    raise SystemExit(0)
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(V, indent=1, sort_keys=True) + '\n')
print(f'wrote {OUT.relative_to(ROOT)}: {len(V)} values')
for k, v in sorted(V.items()):
    print(f'  {k} = {v:.4g}')
