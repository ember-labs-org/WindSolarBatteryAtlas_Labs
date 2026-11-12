"""T054 phase 1: compare the best-area rule options from region_stats.csv.

Usage: python3 -I compare_options.py <region_stats.csv> <repo deployment/data dir> <cells.geojson>
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

stats_csv, data_dir, cells = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
r = pd.read_csv(stats_csv)
d = pd.read_csv(data_dir / 'voronoi_wind_resource.csv')
assert (r.location_id.values == d.location_id.values).all()
r['on_viable'] = d.on_viable.values

pop = pd.read_csv(data_dir / 'voronoi_population_2020.csv')
key = lambda la, lo: [f'{a:.2f},{b:.2f}' for a, b in zip(la, lo)]
pmap = dict(zip(key(pop.latitude, pop.longitude), pop.population_2020))
r['pop'] = [pmap.get(k, 0.0) for k in key(r.latitude, r.longitude)]
print(f"population joined: {np.isfinite(r['pop']).sum()} rows, total {r['pop'].sum()/1e9:.2f} bn, "
      f"missing keys {sum(k not in pmap for k in key(r.latitude, r.longitude))}")
cty = pd.read_csv(data_dir / 'voronoi_overlapping_countries.csv')[['location_id', 'country_name', 'country_iso3']]
r = r.merge(cty, on='location_id', how='left')

T = 0.20
has_land = r.on_area_km2 > 0
cur = r.on_viable == 1
alat = r.latitude.abs()
bands = pd.cut(alat, [0, 15, 30, 45, 60, 90], right=False,
               labels=['0-15', '15-30', '30-45', '45-60', '60+'])
bn = lambda x: f'{x/1e9:.2f} bn' if x >= 1e8 else f'{x/1e6:.0f} m'

print(f'\nCurrent: viable {cur.sum()} regions, {bn(r['pop'][cur].sum())}; no eligible land {(~has_land).sum()} '
      f'({bn(r['pop'][~has_land].sum())}); land but not viable {(has_land & ~cur).sum()} ({bn(r['pop'][has_land & ~cur].sum())})')
c = r[cur]
print(f'Current level (P90) of viable regions: median {c.on_cf_p90.median():.3f} p10 {c.on_cf_p90.quantile(.1):.3f} '
      f'p90 {c.on_cf_p90.quantile(.9):.3f}')

summary = []
for A in (500, 1000, 2500):
    col = f'best{A}_cf'
    new = has_land & (r[col] >= T)
    gain, loss = new & ~cur, cur & ~new
    print(f'\n=== A = {A} km2 ===')
    print(f'viable {new.sum()} ({bn(r['pop'][new].sum())}); become viable {gain.sum()} ({bn(r['pop'][gain].sum())}); '
          f'stop being viable {loss.sum()} ({bn(r['pop'][loss].sum())})')
    small_land = new & (r.on_area_km2 < 200)
    small_good = new & (r.on_viable_area_km2 < 200)
    lt_a = new & (r.on_area_km2 < A)
    print(f'viable with < 200 km2 eligible land: {small_land.sum()} ({bn(r['pop'][small_land].sum())}); '
          f'with < 200 km2 clearing 20%: {small_good.sum()}; with less eligible land than A (all land used): {lt_a.sum()}')
    if loss.any():
        lo = r[loss]
        print(f'  losers: P90 median {lo.on_cf_p90.median():.3f}, best-A median {lo[col].median():.3f}, '
              f'eligible area median {lo.on_area_km2.median():.0f} km2, max {lo.on_area_km2.max():.0f}')
    # scope (i): headline everywhere, change for currently viable
    dlt = (r[col] - r.on_cf_p90)[cur]
    print(f'(i) headline change for currently viable (pp): median {100*dlt.median():+.1f} '
          f'p10 {100*dlt.quantile(.1):+.1f} p90 {100*dlt.quantile(.9):+.1f}; '
          f'share up {100*(dlt>0).mean():.0f}%, |change|>5pp {100*(dlt.abs()>0.05).mean():.0f}%')
    g = pd.DataFrame({'d': dlt, 'b': bands[cur]}).groupby('b', observed=True)['d']
    print('    by |lat| band: ' + '; '.join(f'{k}: n={len(v)} med {100*v.median():+.1f} '
                                            f'[{100*v.quantile(.1):+.1f},{100*v.quantile(.9):+.1f}]' for k, v in g))
    pw = np.average(dlt, weights=r['pop'][cur] + 1e-9)
    print(f'    population-weighted mean change {100*pw:+.1f} pp; new level median {r.loc[new, col].median():.3f}')
    # scope (ii): viability only; discontinuity
    lvl_ii = np.where(cur, r.on_cf_p90, r[col])
    gl = r.loc[gain, col]
    above = (gl.to_numpy()[:, None] > c.on_cf_p90.to_numpy()[None, :]).mean(axis=1)
    print(f'(ii) newly viable get best-A level: median {gl.median():.3f}; kept P90 for current viable median '
          f'{c.on_cf_p90.median():.3f}. Newly viable regions out-ranking the median currently viable region: '
          f'{(gl > c.on_cf_p90.median()).sum()} of {gain.sum()}; mean share of current viable they out-rank '
          f'{100*above.mean():.0f}%')
    # the jump at the old boundary: regions with P90 in [0.19, 0.21)
    near = has_land & (r.on_cf_p90 >= 0.19) & (r.on_cf_p90 < 0.21)
    lv = pd.Series(lvl_ii, index=r.index)
    print(f'    at the old boundary (P90 19-21%, n={near.sum()}): level median {lv[near & cur].median():.3f} if viable today '
          f'vs {lv[near & ~cur & new].median():.3f} if newly viable')
    # countries
    top = (r[gain].groupby('country_name').agg(n=('location_id', 'size'), people=('pop', 'sum'))
           .sort_values('people', ascending=False).head(10))
    print('  top countries gaining (by people): ' + '; '.join(f'{i} {int(row.n)} ({bn(row.people)})' for i, row in top.iterrows()))
    if loss.any():
        topl = r[loss].groupby('country_name').size().sort_values(ascending=False).head(6)
        print('  countries losing: ' + '; '.join(f'{i} {n}' for i, n in topl.items()))
    cdl = (pd.DataFrame({'d': dlt, 'c': r.country_name[cur], 'p': r['pop'][cur]})
           .groupby('c').agg(n=('d', 'size'), med=('d', 'median'), p=('p', 'sum')))
    cdl = cdl[cdl.n >= 10].sort_values('med')
    print('  (i) largest median CF change, countries with >=10 viable regions: up ' +
          '; '.join(f'{i} {100*row.med:+.1f}' for i, row in cdl.tail(5)[::-1].iterrows()) +
          ' | least: ' + '; '.join(f'{i} {100*row.med:+.1f}' for i, row in cdl.head(5).iterrows()))
    n15 = has_land & (r[col] >= 0.15)
    print(f'  at 15% instead of 20%: viable {n15.sum()} ({bn(r['pop'][n15].sum())})')
    summary.append(dict(A=A, viable=int(new.sum()), viable_pop_bn=r['pop'][new].sum()/1e9,
                        gain=int(gain.sum()), gain_pop_bn=r['pop'][gain].sum()/1e9,
                        loss=int(loss.sum()), loss_pop_m=r['pop'][loss].sum()/1e6,
                        lt200=int(small_land.sum()), good_lt200=int(small_good.sum()),
                        d_med=100*dlt.median(), d_p10=100*dlt.quantile(.1), d_p90=100*dlt.quantile(.9),
                        viable15=int(n15.sum())))
print('\n', pd.DataFrame(summary).round(2).to_string(index=False))

# spot checks: region whose land-clipped cell contains the point
import geopandas as gpd
from shapely.geometry import Point
g = gpd.read_file(cells)[['location_id', 'geometry']]
spots = {'Jeneponto': (-5.6, 119.7), 'Sidrap': (-3.9, 119.8), 'Kinshasa': (-4.32, 15.31),
         'Bogota': (4.71, -74.07), 'Uttar Pradesh': (26.8, 80.9), 'Amazonas': (-4.0, -63.0),
         'Gujarat': (23.3, 69.8)}
rows = []
for name, (la, lo) in spots.items():
    hit = g[g.contains(Point(lo, la))]
    if hit.empty:  # fall back to the nearest seed
        lid = int(r.iloc[((r.latitude - la)**2 + (r.longitude - lo)**2).idxmin()].location_id)
    else:
        lid = int(hit.location_id.iloc[0])
    x = r[r.location_id == lid].iloc[0]
    rows.append(dict(spot=name, lid=lid, country=x.country_name, pop_m=x['pop']/1e6, area=x.on_area_km2,
                     area20=x.on_viable_area_km2, viable=int(x.on_viable), p90=x.on_cf_p90,
                     b500=x.best500_cf, b1000=x.best1000_cf, b2500=x.best2500_cf, best_px=x.best_pixel_cf))
print('\nspot checks\n', pd.DataFrame(rows).round(3).to_string(index=False))
r.to_csv(stats_csv.with_name('region_options.csv'), index=False, float_format='%.6f')
