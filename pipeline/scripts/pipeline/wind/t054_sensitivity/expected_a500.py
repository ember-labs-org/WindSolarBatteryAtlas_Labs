"""T054: expected effect of the best-500 km2 rule (both surfaces), stated before the run.

Inputs: a site_selection CSV that carries <tag>_cf_best (any rule; the best-area
columns are written either way), the shipped voronoi_wind_resource.csv (current
viability, P90, profile diagnostics), the ERA5 speeds and the repo's power curves.

"Before" is the resource CSV in --before (default: the repo's deployment/data);
its level is <tag>_cf_target if present, else the P90. Viable after = eligible
area and cf_best >= --threshold.

For each surface: viability before/after (regions, people), regions with good land
that still fail, headline and simulated CF shifts for regions viable before, clamp
counts, and the sets of regions whose hourly profile must come out identical:
non-viable before and after (all-zero profile), viable before and after with the
same target, and viable before and after with k clamped at the same bound (k = 1.8
or 0.6 both times, so the target is irrelevant).

Usage: python3 -I expected_a500.py <siting.csv> <repo> <era5_speed_2024.npz> <out.csv>
           [--threshold 0.15] [--before <data dir>]
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import argparse

ap = argparse.ArgumentParser()
ap.add_argument('siting', type=Path)
ap.add_argument('repo', type=Path)
ap.add_argument('npz')
ap.add_argument('out_csv', type=Path)
ap.add_argument('--threshold', type=float, default=0.15)
ap.add_argument('--before', type=Path)
A = ap.parse_args()
siting, repo, npz, out_csv = A.siting, A.repo, A.npz, A.out_csv
sys.dont_write_bytecode = True
sys.path.insert(0, str(repo / 'pipeline'))
from scripts.pipeline.wind.power_curves import CURVES  # noqa: E402

RHO0, K_MIN, K_MAX, KEEP, T = 1.225, 0.6, 1.8, 0.88, A.threshold
data = repo / 'deployment' / 'data'
s = pd.read_csv(siting)
d = pd.read_csv((A.before or data) / 'voronoi_wind_resource.csv')
print(f'threshold {T:.2f}; before = {(A.before or data)}')
assert (s.location_id.values == d.location_id.values).all()
pop = pd.read_csv(data / 'voronoi_population_2020.csv')
key = lambda la, lo: [f'{a:.2f},{b:.2f}' for a, b in zip(la, lo)]
pmap = dict(zip(key(pop.latitude, pop.longitude), pop.population_2020))
people = np.array([pmap.get(k, 0.0) for k in key(d.latitude, d.longitude)])
cty = d[['location_id']].merge(pd.read_csv(data / 'voronoi_overlapping_countries.csv')[['location_id', 'country_name']],
                               on='location_id', how='left').country_name.to_numpy()
z = np.load(npz)
assert (z['location_id'] == d.location_id.to_numpy()).all()
bn = lambda x: f'{x/1e9:.2f} bn' if x >= 1e8 else f'{x/1e6:.1f} m'
rows = {'location_id': d.location_id.to_numpy()}
viable_any = {}
for tag in ('on', 'off'):
    has = s[f'{tag}_area_km2'].to_numpy() > 0
    best = s[f'{tag}_cf_best'].to_numpy()
    p90 = d[f'{tag}_cf_target' if f'{tag}_cf_target' in d.columns else f'{tag}_cf_p90'].to_numpy()
    old_v = d[f'{tag}_viable'].to_numpy() == 1
    new_v = has & (best >= T)
    viable_any[tag] = (old_v, new_v)
    # profile headroom at both clamp bounds, as build_wind_profiles computes it
    dens = d['on_site_air_density'].to_numpy() if tag == 'on' else np.full(len(d), RHO0)
    dens = np.where(np.isfinite(dens) & (dens > 0.5), dens, RHO0)
    cls = d['on_site_iec_class'].to_numpy()
    hi, lo = np.full(len(d), np.nan), np.full(len(d), np.nan)
    sp = z[tag]
    for i in np.nonzero(old_v | new_v)[0]:
        curve = CURVES[int(cls[i])] if tag == 'on' and int(cls[i]) in CURVES else CURVES['offshore']
        v = sp[:, i].astype('float64') * (dens[i] / RHO0) ** (1 / 3)
        if not np.isfinite(v).all() or v.max() <= 0:
            continue
        hi[i] = curve.output(v * K_MAX).mean() * KEEP
        lo[i] = curve.output(v * K_MIN).mean() * KEEP
    old_sim = d[f'{tag}_final_cf'].to_numpy()
    new_sim = np.where(new_v, np.clip(best, lo, hi), np.nan)
    old_cl_hi = old_v & (p90 > hi + 1e-9)
    old_cl_lo = old_v & (p90 < lo - 1e-9)
    new_cl_hi = new_v & (best > hi + 1e-9)
    new_cl_lo = new_v & (best < lo - 1e-9)
    assert (old_cl_hi | old_cl_lo).sum() == d[f'{tag}_clamped'].sum(), 'clamp recomputation differs from shipped'
    gain, loss, both = new_v & ~old_v, old_v & ~new_v, old_v & new_v
    same_none = ~old_v & ~new_v
    same_clamp = both & ((old_cl_hi & new_cl_hi) | (old_cl_lo & new_cl_lo))
    same_target = both & (p90 == best) & ~same_clamp
    print(f'\n===== {tag}shore, A = 500 km2 =====')
    print(f'viable before {old_v.sum()} ({bn(people[old_v].sum())}), after {new_v.sum()} ({bn(people[new_v].sum())})')
    print(f'gain {gain.sum()} ({bn(people[gain].sum())}); lose {loss.sum()} ({bn(people[loss].sum())})'
          + (f": {', '.join(f'{c}' for c in pd.Series(cty[loss]).value_counts().head(6).index)}" if loss.any() else ''))
    good = s[f'{tag}_viable_area_km2'].to_numpy()
    still = has & (good > 0) & ~new_v
    still200 = has & (good >= 200) & ~new_v
    print(f'with land at >= 20% but still non-viable (best 500 km2 mean < 20%): {still.sum()} ({bn(people[still].sum())}); '
          f'of which >= 200 km2 at >= 20%: {still200.sum()} ({bn(people[still200].sum())}); '
          f'their area at >= 20%: median {np.median(good[still]) if still.any() else 0:.0f} km2, max {good[still].max() if still.any() else 0:.0f}')
    dh = (best - p90)[both]
    ds = (new_sim - old_sim)[both]
    q = lambda x: f'median {100*np.nanmedian(x):+.1f} pp [p10 {100*np.nanquantile(x, .1):+.1f}, p90 {100*np.nanquantile(x, .9):+.1f}]'
    print(f'viable before and after (n={both.sum()}): headline change {q(dh)}; simulated (final_cf) change {q(ds)}; '
          f'pop-weighted headline {100*np.average(dh, weights=people[both]+1e-9):+.1f} pp, '
          f'simulated {100*np.average(np.nan_to_num(ds), weights=people[both]+1e-9):+.1f} pp')
    print(f'clamped viable: before {(old_cl_hi | old_cl_lo).sum()} (k=1.8: {old_cl_hi.sum()}, k=0.6: {old_cl_lo.sum()}), '
          f'after {(new_cl_hi | new_cl_lo).sum()} (k=1.8: {new_cl_hi.sum()}, k=0.6: {new_cl_lo.sum()})')
    for lim in (0.15, 0.20):
        print(f'viable but simulating < {lim:.0%}: before {(old_v & (old_sim < lim)).sum()}, after {(new_v & (new_sim < lim)).sum()}; '
              f'newly viable simulating < {lim:.0%}: {(gain & (new_sim < lim)).sum()} ({bn(people[gain & (new_sim < lim)].sum())})')
    print(f'newly viable: headline median {np.median(best[gain]) if gain.any() else np.nan:.3f}, simulated median '
          f'{np.nanmedian(new_sim[gain]) if gain.any() else np.nan:.3f}; capped {(gain & (new_cl_hi | new_cl_lo)).sum()}')
    n_same = same_none.sum() + same_clamp.sum() + same_target.sum()
    print(f'EXPECTED IDENTICAL {tag} profiles/slices: non-viable before and after {same_none.sum()}, '
          f'clamped at the same bound before and after {same_clamp.sum()}, same target {same_target.sum()} -> {n_same} regions')
    rows[f'{tag}_old_viable'] = old_v.astype(int)
    rows[f'{tag}_new_viable'] = new_v.astype(int)
    rows[f'{tag}_cap_hi'] = hi
    rows[f'{tag}_cap_lo'] = lo
    rows[f'{tag}_expected_sim'] = new_sim
    rows[f'{tag}_expect_identical'] = (same_none | same_clamp | same_target).astype(int)

ob, nb = viable_any['on'][0] | viable_any['off'][0], viable_any['on'][1] | viable_any['off'][1]
print(f'\nany wind (on or off): before {ob.sum()} ({bn(people[ob].sum())}), after {nb.sum()} ({bn(people[nb].sum())}); '
      f'gain {(nb & ~ob).sum()} ({bn(people[nb & ~ob].sum())}), lose {(ob & ~nb).sum()} ({bn(people[ob & ~nb].sum())})')
pd.DataFrame(rows).to_csv(out_csv, index=False, float_format='%.6f')
