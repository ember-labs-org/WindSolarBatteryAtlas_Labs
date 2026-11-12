#!/usr/bin/env python3
"""T089: numbers for the restructured article's sections 1, 2, 4, 5, 6 and 7.

Input: the per-cell rows run.mjs writes (the atlas's own LCOE worker, model.js parameters,
Local costs, 2026). Aggregations follow model.js exactly (wmedian = numpy-style weighted
median with side='left', unmet regions = +inf; share over all map cells).

    python3 scripts/article/analysis/t089/analyse_t089.py [--runs FILE] [--out DIR]

Writes DIR/t089_values.json (every proposed key), DIR/tables/*.csv and DIR/figs/*.png.
"""
import argparse, json, os, sys
from pathlib import Path
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DATA = ROOT / 'deployment' / 'data'
HOME = Path.home()

ap = argparse.ArgumentParser()
ap.add_argument('--runs', default=str(HOME / 'wind-atlas-T089/cells/t089_runs.json'))
ap.add_argument('--out', default=str(HOME / 'wind-atlas-T089'))
ap.add_argument('--states', default=str(HOME / 'wind-atlas-T079/downloads/adm1/ne_10m_admin_1_states_provinces.shp'),
                help='Natural Earth 10m admin-1 (v5), only for naming US states north of 40N')
ap.add_argument('--no-figs', action='store_true')
args = ap.parse_args()
OUT = Path(args.out); (OUT / 'tables').mkdir(parents=True, exist_ok=True); (OUT / 'figs').mkdir(parents=True, exist_ok=True)

D = json.load(open(args.runs))
C = D['cells']; R = D['runs']; P = D['params']
n = len(C['ids'])
ids = np.array(C['ids'])
lat = np.array(C['lat']); lon = np.array(C['lon'])
pop = np.array(C['pop'], float); dem = np.array(C['demand'], float); mapc = np.array(C['mapCell']) == 1
country = np.array(C['country'], dtype=object)
ones = np.ones(n)
area_df = pd.read_csv(DATA / 'voronoi_pvout_potential.csv', usecols=['location_id', 'zone_area_km2']).set_index('location_id')
area = area_df.reindex(ids).zone_area_km2.fillna(0).to_numpy()
W = {'people': pop, 'demand': dem}

V = {}            # proposed keys -> value
def put(k, v):
    V[k] = None if v is None or (isinstance(v, float) and not np.isfinite(v)) else (float(v) if not isinstance(v, (int, np.integer)) else int(v))

# --- model.js aggregations -------------------------------------------------------------
def wmedian(values, weights, sel=None):
    values = np.asarray(values, float); weights = np.asarray(weights, float)
    ok = (weights > 0) & ~np.isnan(values)
    if sel is not None: ok &= sel
    idx = np.nonzero(ok)[0]
    if not len(idx): return None
    idx = idx[np.argsort(values[idx], kind='stable')]
    cw = np.cumsum(weights[idx])
    if not cw[-1] > 0: return None
    k = min(np.searchsorted(cw, 0.5 * cw[-1], side='left'), len(idx) - 1)
    med = values[idx[k]]
    return float(med) if np.isfinite(med) else None

def share(mask, weights, sel=None):
    w = np.asarray(weights, float)
    s = np.ones(n, bool) if sel is None else sel
    den = w[s].sum()
    return float(w[s & mask].sum() / den) if den > 0 else None

def run(key):
    r = R[key]
    # Rows come sorted by location id; a cell the worker could not price (backup runs: 66 sea-only
    # cells with no fuel price, no people, no demand) is missing and counts as not meeting the target.
    pos = {lid: i for i, lid in enumerate(r['location_id'])}
    at = [pos.get(int(x)) for x in ids]
    assert sum(a is not None for a in at) == len(r['location_id']), key
    def col(k, fill):
        if k not in r:      # runs from before T095 have no annual_energy_mwh
            return [fill] * len(at)
        return [fill if (j is None or r[k][j] is None) else r[k][j] for j in at]
    f = lambda k, fill=np.nan: np.array(col(k, fill), dtype=float)
    o = dict(lcoe=f('lcoe'), meets=np.array(col('meetsTarget', False), bool), cf=f('annual_cf'), energy=f('annual_energy_mwh'),
             solar=f('solar_gw'), wind=f('wind_gw', 0),
             batt=f('batt_gwh'), nwLcoe=f('noWindLcoe'), nwMeets=np.array(col('noWindMeetsTarget', False), bool), saving=f('windSaving'),
             bkShare=f('backup_share_cf', 0), bkAdder=f('backup_lcoe_adder', 0), bkFuel=np.array(col('backup_fuel', None), dtype=object),
             gasAvail=np.array([bool(x) for x in col('gas_available', False)]), gasPrice=f('gas_price_usd_per_mmbtu'),
             dieselPrice=f('diesel_price_usd_per_liter'), surface=np.array(col('wind_surface', None), dtype=object))
    o['best'] = np.where(o['meets'], o['lcoe'], np.inf)          # model.js infWhereUnmet
    return o

def pair(T, kind='nb'):
    a, b = run(f'all_{kind}_{T}'), run(f'sb_{kind}_{T}')
    return a, b

# --- 0. Reconciliation with the committed article summary and between searches ----------
summary = json.load(open(ROOT / 'deployment/scrollytelling/data/article-summary.json'))['values']
recon = []
for T in (80, 90, 99):
    a, b = pair(T)
    # S+B search (wind switched off) must equal the overall search's no-wind comparator.
    both_ok = a['nwMeets'] == b['meets']
    diff = np.nanmax(np.abs(np.where(b['meets'], b['lcoe'] - a['nwLcoe'], 0)))
    recon.append(dict(check=f'S+B search vs noWindLcoe at {T}%', meets_equal=bool(both_ok.all()), max_abs_diff=float(diff)))
    cheaper = a['meets'] & (a['wind'] > 0) & a['nwMeets']
    for w in ('people', 'demand'):
        mine = share(cheaper, W[w]); ref = summary.get(f'hw.lower.{w}.{T}')
        recon.append(dict(check=f'hw.lower.{w}.{T}', mine=mine, summary=ref, equal=abs(mine - ref) < 1e-9))
        mine = wmedian(a['saving'], W[w], cheaper); ref = summary.get(f'hw.medSaving.{w}.{T}')
        recon.append(dict(check=f'hw.medSaving.{w}.{T}', mine=mine, summary=ref, equal=abs(mine - ref) < 1e-9))
a90, b90 = pair(90)
for k, w in (('people', pop),):
    mine = wmedian(a90['best'], pop); ref = summary.get('t4.medWind.world.90')
    recon.append(dict(check='t4.medWind.world.90 (people)', mine=mine, summary=ref, equal=ref is not None and abs(mine - ref) < 1e-9))
mine = wmedian(a90['best'], dem); ref = summary.get('lb.best.world.90.2026')
recon.append(dict(check='lb.best.world.90.2026 (demand)', mine=mine, summary=ref, equal=ref is not None and abs(mine - ref) < 1e-9))
pd.DataFrame(recon).to_csv(OUT / 'tables/recon.csv', index=False)
bad = [r for r in recon if r.get('equal') is False or r.get('meets_equal') is False or (r.get('max_abs_diff') or 0) > 1e-6]
print('reconciliation:', 'ALL OK' if not bad else bad)

# --- groups --------------------------------------------------------------------------
EUROPE = ['Albania', 'Austria', 'Belarus', 'Belgium', 'Bosnia and Herz.', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Denmark',
          'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Iceland', 'Ireland', 'Italy', 'Latvia', 'Lithuania',
          'Moldova', 'Montenegro', 'Netherlands', 'North Macedonia', 'Norway', 'Poland', 'Portugal', 'Romania', 'Serbia',
          'Slovakia', 'Spain', 'Sweden', 'Switzerland', 'Ukraine', 'United Kingdom']
assert all(c in set(country) for c in EUROPE)
groups = {'europe': np.isin(country, EUROPE), 'canada': country == 'Canada'}
us = country == 'United States of America'
state = np.array([''] * n, dtype=object)
north_states = []
try:
    import geopandas as gpd
    from shapely.geometry import Point
    st = gpd.read_file(args.states)
    st = st[st.admin == 'United States of America'][['name', 'latitude', 'geometry']]
    # A state counts as northern when Natural Earth's label point lies at or north of 40N.
    north_states = sorted(st[st.latitude >= 40].name.tolist())
    pts = gpd.GeoDataFrame({'i': np.nonzero(us)[0]}, geometry=[Point(lon[i], lat[i]) for i in np.nonzero(us)[0]], crs=st.crs)
    j = gpd.sjoin(pts, st, how='left', predicate='within')
    j = j[~j.index.duplicated()]
    miss = j.name.isna()
    if miss.any():   # site points just off the coast: nearest state
        jn = gpd.sjoin_nearest(pts[miss.values].to_crs(3857), st.to_crs(3857), how='left')
        jn = jn[~jn.index.duplicated()]
        j.loc[miss, 'name'] = jn.name.values
    state[j.i.values] = j.name.values
    groups['us_north'] = us & np.isin(state, north_states)
except Exception as e:  # noqa
    print('WARN no state boundaries, US north = US cells at or north of 40N:', e)
    groups['us_north'] = us & (lat >= 40)
groups['us_rest'] = us & ~groups['us_north']
groups['asia_north'] = (lat >= 45) & (lon >= 60)
groups['nordic_baltic_uk_ie'] = np.isin(country, ['Norway', 'Sweden', 'Finland', 'Denmark', 'Iceland', 'Estonia', 'Latvia', 'Lithuania', 'United Kingdom', 'Ireland'])
groups['world'] = np.ones(n, bool)
GROUP_LABEL = {'europe': 'Europe (36 countries, excl. Russia, Turkey)', 'canada': 'Canada', 'us_north': 'US states north of 40°N',
               'us_rest': 'Rest of the US', 'asia_north': 'Asia north of 45°N, east of 60°E', 'nordic_baltic_uk_ie': 'Nordics, Baltics, UK, Ireland', 'world': 'World'}
LAT_BANDS = {'s_all': (-90, 0), 'n0_15': (0, 15), 'n15_30': (15, 30), 'n30_40': (30, 40), 'n40_45': (40, 45), 'n45_50': (45, 50),
             'n50_55': (50, 55), 'n55_60': (55, 60), 'n60p': (60, 90.001)}
ABS_BANDS = {'a0_15': (0, 15), 'a15_30': (15, 30), 'a30_45': (30, 45), 'a45_55': (45, 55), 'a55p': (55, 90.0001)}

# --- S1: the shift -------------------------------------------------------------------
THR = (50, 60, 70, 80, 100, 120)
s1rows = []
for T in (80, 90, 95, 99):
    a, b = pair(T)
    cheaper = a['meets'] & (a['wind'] > 0) & a['nwMeets']
    for w in ('people', 'demand'):
        put(f's1.cost.sb.{w}.{T}', wmedian(b['best'], W[w]))
        put(f's1.cost.sbw.{w}.{T}', wmedian(a['best'], W[w]))
        put(f's1.reach.sb.{w}.{T}', share(b['meets'], W[w]))
        put(f's1.reach.sbw.{w}.{T}', share(a['meets'], W[w]))
        put(f's1.lower.{w}.{T}', share(cheaper, W[w]))
        put(f's1.saving.{w}.{T}', wmedian(a['saving'], W[w], cheaper))
        pct = np.where(cheaper, a['saving'] / a['nwLcoe'], np.nan)
        put(f's1.savingPct.{w}.{T}', wmedian(pct, W[w], cheaper))
        put(f's1.noWind.{w}.{T}', share(a['meets'] & ~(a['wind'] > 0), W[w]))
        for x in THR:
            put(f's1.under{x}.sb.{w}.{T}', share(b['best'] <= x, W[w]))
            put(f's1.under{x}.sbw.{w}.{T}', share(a['best'] <= x, W[w]))
    s1rows.append(T)
# per-region table at 90%
a, b = a90, b90
reg = pd.DataFrame(dict(location_id=ids, lat=lat, lon=lon, country=country, us_state=state, people=pop, demand_twh=dem,
                        sb_lcoe_90=np.where(b['meets'], b['lcoe'], np.nan), sbw_lcoe_90=np.where(a['meets'], a['lcoe'], np.nan),
                        saving_90=np.where(a['meets'] & a['nwMeets'], b['best'] - a['best'], np.nan),
                        sbw_wind_gw=a['wind'], sbw_solar_gw=a['solar'], sbw_batt_gwh=a['batt'], sb_solar_gw=b['solar'], sb_batt_gwh=b['batt']))
reg.to_csv(OUT / 'tables/s1_regions_90.csv', index=False, float_format='%.4g')
# countries (top by demand)
crow = []
for cn in pd.Series(dem, index=country).groupby(level=0).sum().sort_values(ascending=False).index[:40]:
    sel = country == cn
    crow.append(dict(country=cn, demand_twh=dem[sel].sum(), people_m=pop[sel].sum() / 1e6,
                     sb_90=wmedian(b['best'], dem, sel), sbw_90=wmedian(a['best'], dem, sel),
                     lower_share_demand=share(a['meets'] & (a['wind'] > 0) & a['nwMeets'], dem, sel)))
pd.DataFrame(crow).to_csv(OUT / 'tables/s1_countries_90.csv', index=False, float_format='%.4g')

# --- S2: the north --------------------------------------------------------------------
batt_capex = pd.read_csv(DATA / 'voronoi_local_capex.csv', usecols=['location_id', 'battery_2024']).set_index('location_id').reindex(ids).battery_2024.to_numpy()
batt_capex = np.where(np.isfinite(batt_capex), batt_capex, P['batteryCapex'])   # Global fallback, as the worker
s2 = []
def group_row(gid, sel, T=90):
    a, b = pair(T)
    both = a['meets'] & b['meets']
    row = dict(group=gid, label=GROUP_LABEL.get(gid, gid), T=T, people_m=pop[sel].sum() / 1e6, demand_twh=dem[sel].sum(), cells=int(sel.sum()))
    for w in ('people', 'demand'):
        row[f'sb_{w}'] = wmedian(b['best'], W[w], sel)
        row[f'sbw_{w}'] = wmedian(a['best'], W[w], sel)
        row[f'sb_reach_{w}'] = share(b['meets'], W[w], sel)
        row[f'lower_{w}'] = share(a['meets'] & (a['wind'] > 0) & a['nwMeets'], W[w], sel)
        row[f'saving_{w}'] = wmedian(np.where(both, b['lcoe'] - a['lcoe'], np.nan), W[w], sel & both)
    # The seasonal mechanism: battery (GWh per GW of load = hours of load) and solar in each build,
    # demand-weighted medians over regions where both reach T; battery capital $/kW of load (local 2026 capex).
    sb_ = sel & both
    row['sb_batt_h'] = wmedian(b['batt'], dem, sb_); row['sbw_batt_h'] = wmedian(a['batt'], dem, sb_)
    row['sb_solar_gw'] = wmedian(b['solar'], dem, sb_); row['sbw_solar_gw'] = wmedian(a['solar'], dem, sb_)
    row['sbw_wind_gw'] = wmedian(a['wind'], dem, sb_)
    row['sb_batt_capex_kw'] = wmedian(b['batt'] * batt_capex, dem, sb_); row['sbw_batt_capex_kw'] = wmedian(a['batt'] * batt_capex, dem, sb_)
    # battery shrink, demand-weighted median of the per-region ratio
    row['batt_ratio'] = wmedian(np.where(sb_ & (b['batt'] > 0), a['batt'] / np.where(b['batt'] > 0, b['batt'], 1), np.nan), dem, sb_ & (b['batt'] > 0))
    return row
for gid, sel in groups.items():
    for T in (90, 99):
        s2.append(group_row(gid, sel, T))
for bid, (lo, hi) in LAT_BANDS.items():
    s2.append(group_row(bid, (lat >= lo) & (lat < hi), 90))
for bid, (lo, hi) in ABS_BANDS.items():
    s2.append(group_row(bid, (np.abs(lat) >= lo) & (np.abs(lat) < hi), 90))
s2 = pd.DataFrame(s2)
s2.to_csv(OUT / 'tables/s2_north.csv', index=False, float_format='%.4g')
for r in s2.itertuples():
    if r.T != 90 and r.group not in groups: continue
    for k in ('sb_demand', 'sbw_demand', 'saving_demand', 'lower_demand', 'sb_people', 'sbw_people', 'lower_people', 'saving_people',
              'sb_batt_h', 'sbw_batt_h', 'sb_batt_capex_kw', 'sbw_batt_capex_kw', 'sb_solar_gw', 'sbw_solar_gw', 'sbw_wind_gw', 'batt_ratio', 'sb_reach_demand'):
        put(f's2.{r.group}.{k}.{r.T}', getattr(r, k))
V['s2.us_north.states'] = north_states

# --- S4 (article section 4): from 90% to 100% with backup -------------------------------
HOURS = 8760.0
MMBTU_PER_MWH = 3.412
s3 = {}
for T in (50, 60, 70, 80, 85, 90, 95, 99):
    s3[T] = pair(T, 'bk')
a, b = s3[90]
for name, r_ in (('sbw', a), ('sb', b)):
    ok = r_['meets'] & np.isfinite(r_['lcoe'])
    tot = np.where(ok, r_['lcoe'], np.inf)
    for w in ('people', 'demand'):
        put(f's4.total.{name}.{w}', wmedian(tot, W[w]))
        put(f's4.adder.{name}.{w}', wmedian(r_['bkAdder'], W[w], ok))
        put(f's4.share.{name}.{w}', wmedian(r_['bkShare'], W[w], ok))
        put(f's4.renew.{name}.{w}', wmedian(r_['lcoe'] - r_['bkAdder'], W[w], ok))
        put(f's4.gasShare.{name}.{w}', share(ok & (r_['bkFuel'] == 'gas'), W[w], ok))
        # fuel burned per MW of load per year (MWh thermal), at the app's 35% efficiency for both fuels
        put(f's4.fuelMwhTh.{name}.{w}', wmedian(r_['bkShare'] * HOURS / P['gasEfficiency'], W[w], ok))
        put(f's4.cf.{name}.{w}', wmedian(r_['cf'], W[w], ok))
put('s4.backupMwPerMwLoad', 1.0)   # lcoe-worker.js: backup capex = BASE_LOAD_MW x $/kW, i.e. sized to the full load
put('s4.gasCapex', P['gasCapex']); put('s4.gasEff', P['gasEfficiency']); put('s4.gasLife', P['gasLife'])
put('s4.dieselCapex', P['dieselCapex'])
# cost curve: 90, 95, 99 without backup; 100 = cheapest build reaching >= 90% plus backup;
# 100* = cheapest firm build over all searched starting uptimes (50-99%) plus backup
curve = []
best100 = {}
for name in ('sbw', 'sb'):
    stack = np.vstack([np.where(s3[T][0 if name == 'sbw' else 1]['meets'], s3[T][0 if name == 'sbw' else 1]['lcoe'], np.inf) for T in s3])
    best100[name] = stack.min(axis=0)
    argT = np.array(list(s3))[stack.argmin(axis=0)]
    for w in ('people', 'demand'):
        put(f's4.firmMin.{name}.{w}', wmedian(best100[name], W[w]))
        put(f's4.firmMinStartT.{name}.{w}', wmedian(argT.astype(float), W[w]))
for T in (80, 85, 90, 95, 97, 99):
    a_, b_ = pair(T)
    for w in ('people', 'demand'):
        curve.append(dict(step=f'{T}%', weight=w, sbw=wmedian(a_['best'], W[w]), sb=wmedian(b_['best'], W[w]),
                          sbw_reach=share(a_['meets'], W[w]), sb_reach=share(b_['meets'], W[w])))
for w in ('people', 'demand'):
    curve.append(dict(step='100% (90% + backup)', weight=w, sbw=V[f's4.total.sbw.{w}'], sb=V[f's4.total.sb.{w}'], sbw_reach=1, sb_reach=1))
    curve.append(dict(step='100% (cheapest start + backup)', weight=w, sbw=V[f's4.firmMin.sbw.{w}'], sb=V[f's4.firmMin.sb.{w}'], sbw_reach=1, sb_reach=1))
curve = pd.DataFrame(curve); curve.to_csv(OUT / 'tables/s4_curve.csv', index=False, float_format='%.4g')
for r in curve.itertuples():
    tag = r.step.split('%')[0] if '(' not in r.step else ('100' if '90%' in r.step else '100min')
    put(f's4.curve.sbw.{r.weight}.{tag}', r.sbw); put(f's4.curve.sb.{r.weight}.{tag}', r.sb)
# T095 (the human, 6 Nov 2026): the same 90/95/99 steps per MWh of the FULL load, as the backup bar (s4.curve.*.100) is:
# each region's annual cost / (8760 h x 1 GW load) = LCOE x its delivered energy (CF x degradation) / the full load; the
# hours a build misses go unserved. Unmet regions +inf, as s4.curve.
FULL_LOAD_MWH = HOURS * 1000.0
HAS_ENERGY = all('annual_energy_mwh' in R[f'{b}_nb_{T}'] for b in ('all', 'sb') for T in (90, 95, 99))
if not HAS_ENERGY:
    print('WARN runs without annual_energy_mwh (before T095): no s4.curveLoad keys; rerun run.mjs')
for T in ((90, 95, 99) if HAS_ENERGY else ()):
    a_, b_ = pair(T)
    for name, r_ in (('sbw', a_), ('sb', b_)):
        per_load = np.where(r_['meets'], r_['lcoe'] * r_['energy'] / FULL_LOAD_MWH, np.inf)
        for w in ('people', 'demand'):
            put(f's4.curveLoad.{name}.{w}.{T}', wmedian(per_load, W[w]))
# Same set: regions where both reach 99% without backup (like-for-like curve)
a99, b99 = pair(99)
both99 = a99['meets'] & b99['meets']
for w in ('people', 'demand'):
    for T in (90, 95, 99):
        a_, b_ = pair(T)
        put(f's4.ll.sbw.{w}.{T}', wmedian(a_['lcoe'], W[w], both99)); put(f's4.ll.sb.{w}.{T}', wmedian(b_['lcoe'], W[w], both99))
    put(f's4.ll.sbw.{w}.100', wmedian(s3[90][0]['lcoe'], W[w], both99)); put(f's4.ll.sb.{w}.100', wmedian(s3[90][1]['lcoe'], W[w], both99))
    put(f's4.ll.share.{w}', share(both99, W[w]))
# north groups with backup
for gid in ('europe', 'canada', 'us_north', 'asia_north', 'world'):
    sel = groups[gid]
    for name, r_ in (('sbw', a), ('sb', b)):
        put(f's4.{gid}.total.{name}', wmedian(np.where(r_['meets'], r_['lcoe'], np.inf), dem, sel))

# --- S5 (article section 5): cheap where people live ------------------------------------
for T in (90, 99):
    a_, b_ = pair(T)
    for name, r_ in (('sbw', a_), ('sb', b_)):
        for wn, w in (('people', pop), ('demand', dem), ('area', area), ('regions', ones)):
            put(f's5.med.{name}.{wn}.{T}', wmedian(r_['best'], w, mapc))
        for x in (60, 80, 100):
            put(f's5.under{x}.{name}.area.{T}', share(r_['best'] <= x, area, mapc))
            for wn in ('people', 'demand'):
                put(f's5.under{x}.{name}.{wn}.{T}', share(r_['best'] <= x, W[wn]))

# --- S6 (article section 6): planned coal and gas --------------------------------------
gem = pd.read_csv(DATA / 'voronoi_gem_capacity.csv').set_index('location_id').reindex(ids).fillna(0)
coal = gem.coal_Announced.to_numpy() / 1000; gas = gem.oil_gas_Announced.to_numpy() / 1000; plan = coal + gas
put('s6.planned.gw', plan.sum()); put('s6.planned.coal.gw', coal.sum()); put('s6.planned.gas.gw', gas.sum())
s6 = []
for basis, kind in (('local', 'nb'), ('global', 'glob')):
    for T in (80, 90):
        a_, b_ = pair(T, kind)
        for name, r_ in (('sbw', a_), ('sb', b_)):
            for x in (60, 80, 100):
                m = r_['best'] <= x
                s6.append(dict(basis=basis, T=T, build=name, threshold=x, gw=plan[m].sum(), coal_gw=coal[m].sum(), gas_gw=gas[m].sum(), share=plan[m].sum() / plan.sum()))
                put(f's6.{basis}.{name}.under{x}.{T}.gw', plan[m].sum()); put(f's6.{basis}.{name}.under{x}.{T}.share', plan[m].sum() / plan.sum())
pd.DataFrame(s6).to_csv(OUT / 'tables/s6_planned.csv', index=False, float_format='%.4g')
# by country, the article default (Local) at 80% and 90%, < $100
rows = []
for cn, g in pd.DataFrame(dict(country=country, plan=plan)).groupby('country'):
    sel = country == cn
    r = dict(country=cn, planned_gw=plan[sel].sum())
    for T in (80, 90):
        a_, b_ = pair(T)
        r[f'sb_under100_{T}'] = plan[sel & (b_['best'] <= 100)].sum(); r[f'sbw_under100_{T}'] = plan[sel & (a_['best'] <= 100)].sum()
        r[f'sbw_med_{T}'] = wmedian(a_['best'], plan, sel); r[f'sb_med_{T}'] = wmedian(b_['best'], plan, sel)
    rows.append(r)
s6c = pd.DataFrame(rows).sort_values('planned_gw', ascending=False)
s6c.to_csv(OUT / 'tables/s6_countries.csv', index=False, float_format='%.4g')
for T in (80, 90):
    a_, b_ = pair(T)
    put(f's6.medCost.sbw.{T}', wmedian(a_['best'], plan)); put(f's6.medCost.sb.{T}', wmedian(b_['best'], plan))

# --- S7 (article section 7): resource everywhere --------------------------------------
cons = np.array(C['consOnTwh']) + np.array(C['consFixTwh'])      # model.js windTwhCons (floating not counted)
tech = np.array(C['techOnTwh']) + np.array(C['ieaFixTwh'])       # model.js windTwhTech
with np.errstate(divide='ignore', invalid='ignore'):
    mult = {'cons': np.where(dem > 0, cons / dem, np.inf), 'tech': np.where(dem > 0, tech / dem, np.inf)}
s7 = []
for case, m in mult.items():
    for k in (1, 2, 5, 10):
        cov = m >= k
        for wn in ('people', 'demand'):
            put(f's7.{case}.{k}x.{wn}', share(cov, W[wn], mapc))
        # countries: national potential / national demand >= k, and countries with most of their people in cells >= k
        df = pd.DataFrame(dict(country=country, pot=cons if case == 'cons' else tech, dem=dem, people=pop, covered=cov & mapc, mc=mapc))
        df = df[df.mc & (df.country != '(none)')]
        nat = df.groupby('country').agg(pot=('pot', 'sum'), dem=('dem', 'sum'), people=('people', 'sum'))
        covpop = df[df.covered].groupby('country').people.sum().reindex(nat.index).fillna(0)
        n_nat = int(((nat.pot >= k * nat.dem) & (nat.dem > 0)).sum())
        n_maj = int(((covpop / nat.people.where(nat.people > 0)) >= 0.5).sum())
        put(f's7.{case}.{k}x.countriesNational', n_nat); put(f's7.{case}.{k}x.countriesMajorityPeople', n_maj)
        s7.append(dict(case=case, k=k, people=V[f's7.{case}.{k}x.people'], demand=V[f's7.{case}.{k}x.demand'],
                       countries_national=n_nat, countries_majority_people=n_maj, countries_total=len(nat)))
put('s7.countries', len(nat))
pd.DataFrame(s7).to_csv(OUT / 'tables/s7_resource.csv', index=False, float_format='%.4g')
# national list for the conservative case
nat_c = pd.DataFrame(dict(country=country, pot=cons, dem=dem, people=pop))[mapc].groupby('country').sum()
nat_c['multiple'] = nat_c.pot / nat_c.dem
nat_c.sort_values('dem', ascending=False).to_csv(OUT / 'tables/s7_countries_cons.csv', float_format='%.4g')

# World demand denominator (lead correction, D-158): the article's own Ember 2025 world demand
# (ext.demand2025 in build-snapshot.mjs, external_figures.csv SRC-EMBER-YEARLY-2026), never IEA.
# Demand shares above are shares of the atlas's cell demand (Chen et al.); a TWh figure in the text
# is that share times this total.
ext = pd.read_csv(ROOT / 'scripts/article/inputs/external_figures.csv', header=None)
row = ext[(ext[0] == 'SRC-EMBER-YEARLY-2026') & (ext[2] == 'electricity_demand') & (ext[4] == 'World') & (ext[5].astype(str) == '2025')]
EMBER_2025 = float(row.iloc[0, 6]); put('ext.demand2025', EMBER_2025)
for k in ('s1.lower.demand.90', 's1.under100.sbw.demand.90', 's1.under100.sb.demand.90', 's7.cons.1x.demand', 's7.tech.1x.demand'):
    put(k.replace('.demand', '.twh2025', 1), V[k] * EMBER_2025)
json.dump(V, open(OUT / 't089_values.json', 'w'), indent=1, sort_keys=True)
print(f'wrote {len(V)} values to {OUT / "t089_values.json"}')

# --- figures -------------------------------------------------------------------------
if args.no_figs: sys.exit(0)
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.rcParams.update({'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False})
SB, SBW, GREY = '#F2B33D', '#2E7FA8', '#888888'

def cdf_plot(ax, vals, w, color, label):
    v = np.asarray(vals); ok = np.isfinite(v) & (w > 0)
    o = np.argsort(v[ok]); x = v[ok][o]; y = np.cumsum(w[ok][o]) / w.sum() * 100
    ax.step(x, y, where='post', color=color, lw=2, label=label)

# F1: share of people under $X, S+B vs S+W+B, 90%
fig, axs = plt.subplots(1, 2, figsize=(10, 4), sharey=True)
for ax, wn in zip(axs, ('people', 'demand')):
    cdf_plot(ax, b90['best'], W[wn], SB, 'Solar + batteries'); cdf_plot(ax, a90['best'], W[wn], SBW, 'Solar + wind + batteries')
    ax.set_xlim(20, 200); ax.set_xlabel('$/MWh, 90% uptime, 2026, local costs'); ax.set_title(f'Share of {"people" if wn == "people" else "demand"} at or below the cost (%)', fontsize=10)
    ax.grid(alpha=.3)
axs[0].legend(frameon=False)
fig.suptitle(f'Adding wind moves {V["s1.under60.sbw.demand.90"]*100 - V["s1.under60.sb.demand.90"]*100:.0f} points of demand under $60/MWh', fontsize=11)
fig.tight_layout(); fig.savefig(OUT / 'figs/s1_cdf_90.png', dpi=150); plt.close(fig)

# F2: north – cost by group, S+B vs S+W+B, 90%
g = s2[(s2['T'] == 90) & s2.group.isin(['world', 'europe', 'nordic_baltic_uk_ie', 'canada', 'us_north', 'us_rest', 'asia_north'])].set_index('group')
order = ['world', 'us_rest', 'us_north', 'europe', 'nordic_baltic_uk_ie', 'canada', 'asia_north']
g = g.loc[order]
fig, ax = plt.subplots(figsize=(9, 4.2)); y = np.arange(len(g))
ax.barh(y + .2, g.sb_demand.clip(upper=400), .4, color=SB, label='Solar + batteries'); ax.barh(y - .2, g.sbw_demand, .4, color=SBW, label='Solar + wind + batteries')
for yy, v1, v2 in zip(y, g.sb_demand, g.sbw_demand):
    ax.text(min(v1, 400) + 3, yy + .2, f'${v1:.0f}', va='center', fontsize=8); ax.text(v2 + 3, yy - .2, f'${v2:.0f}', va='center', fontsize=8)
ax.set_yticks(y, g.label); ax.invert_yaxis(); ax.set_xlabel('Median cost at 90% uptime, demand-weighted, $/MWh (2026, local costs)')
ax.legend(frameon=False, loc='upper center', bbox_to_anchor=(0.5, -0.16), ncol=2); ax.set_title('In the north, wind cuts the cost of round-the-clock power the most', fontsize=11)
fig.tight_layout(); fig.savefig(OUT / 'figs/s2_north_groups.png', dpi=150); plt.close(fig)

# F3: battery hours with and without wind by latitude band
lb = s2[s2.group.isin(list(LAT_BANDS))].set_index('group').loc[list(LAT_BANDS)]
fig, ax = plt.subplots(figsize=(9, 4)); x = np.arange(len(lb))
ax.bar(x - .2, lb.sb_batt_h, .4, color=SB, label='Solar + batteries'); ax.bar(x + .2, lb.sbw_batt_h, .4, color=SBW, label='Solar + wind + batteries')
ax.set_yscale('log'); ax.set_xticks(x, ['S. hem.', '0–15°N', '15–30°N', '30–40°N', '40–45°N', '45–50°N', '50–55°N', '55–60°N', '60°N+'])
ax.set_ylabel('Battery, hours of load (log)'); ax.legend(frameon=False)
ax.set_title('Wind shrinks the battery a 90% build needs, most of all in the north', fontsize=11)
fig.tight_layout(); fig.savefig(OUT / 'figs/s2_battery_by_lat.png', dpi=150); plt.close(fig)

# F4: cost curve 80 -> 100
cv = curve[curve.weight == 'demand']
fig, ax = plt.subplots(figsize=(8, 4)); x = np.arange(len(cv))
ax.plot(x, cv.sb, 'o-', color=SB, label='Solar + batteries'); ax.plot(x, cv.sbw, 'o-', color=SBW, label='Solar + wind + batteries')
ax.set_xticks(x, [s.replace(' (', '\n(') for s in cv.step], fontsize=8); ax.set_ylabel('$/MWh, demand-weighted median'); ax.legend(frameon=False)
ax.set_title('With wind, the last steps to 100% cost less', fontsize=11); ax.grid(alpha=.3)
fig.tight_layout(); fig.savefig(OUT / 'figs/s4_curve.png', dpi=150); plt.close(fig)

# F5: medians by weight
fig, ax = plt.subplots(figsize=(8, 3.8)); labs = ['regions', 'area', 'people', 'demand']; x = np.arange(4)
ax.bar(x - .2, [V[f's5.med.sb.{l}.90'] or np.nan for l in labs], .4, color=SB, label='Solar + batteries')
ax.bar(x + .2, [V[f's5.med.sbw.{l}.90'] or np.nan for l in labs], .4, color=SBW, label='Solar + wind + batteries')
ax.set_xticks(x, ['per region', 'per km²', 'per person', 'per MWh of demand']); ax.set_ylabel('Median $/MWh at 90% uptime'); ax.legend(frameon=False)
ax.set_title('Cheapest where people live and power is used', fontsize=11)
fig.tight_layout(); fig.savefig(OUT / 'figs/s5_weights.png', dpi=150); plt.close(fig)

# F6: planned capacity by cost band
bands = [0, 60, 80, 100, 150, np.inf]; lab = ['<$60', '$60–80', '$80–100', '$100–150', '>$150 or not met']
a80, b80 = pair(80)
def binned(best): return [plan[(best > lo) & (best <= hi)].sum() if hi != np.inf else plan[best > lo].sum() for lo, hi in zip(bands[:-1], bands[1:])]
fig, ax = plt.subplots(figsize=(8, 3.6))
for i, (nm, r_, col) in enumerate((('Solar + batteries', b80, SB), ('Solar + wind + batteries', a80, SBW))):
    left = 0
    for j, v in enumerate(binned(r_['best'])):
        ax.barh(i, v, left=left, color=col, alpha=1 - j * .17, edgecolor='white');
        if v > 40: ax.text(left + v / 2, i, f'{lab[j]}\n{v:.0f} GW', ha='center', va='center', fontsize=7)
        left += v
ax.set_yticks([0, 1], ['Solar + batteries', 'Solar + wind + batteries']); ax.set_xlabel('Planned coal and gas, GW (GEM, announced)')
ax.set_title('Planned coal and gas by the cost of the 80%-uptime alternative where it is planned', fontsize=10)
fig.tight_layout(); fig.savefig(OUT / 'figs/s6_planned.png', dpi=150); plt.close(fig)

# F7: resource multiples
s7d = pd.DataFrame(s7)
fig, ax = plt.subplots(figsize=(8, 3.6)); x = np.arange(4)
for off, case, col in ((-.2, 'cons', '#7FB3D5'), (.2, 'tech', SBW)):
    v = s7d[s7d.case == case].set_index('k').loc[[1, 2, 5, 10]]
    ax.bar(x + off, v.people * 100, .4, color=col, label=f'{"Conservative" if case == "cons" else "Technical"} potential')
ax.set_xticks(x, ['≥1×', '≥2×', '≥5×', '≥10×']); ax.set_ylabel('% of people'); ax.legend(frameon=False)
ax.set_title('Share of people living in regions whose wind potential is a multiple of local demand', fontsize=10)
fig.tight_layout(); fig.savefig(OUT / 'figs/s7_resource.png', dpi=150); plt.close(fig)
print('figures in', OUT / 'figs')
