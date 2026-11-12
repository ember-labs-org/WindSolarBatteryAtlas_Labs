"""Numbers for "Harnessing the Winds" (T040), from the atlas's committed data.

Runs the app's LCOE search (engine.py, proven against the app by
validate_engine.py) at app defaults and writes the tables in out/:

  take1_by_target.csv   does wind make high uptime cheaper? by target CF, both
                        surfaces and onshore only, by cells / people / demand
  take1_cells.csv       per cell at 80/90/95%: cheapest build, its LCOE, the
                        cheapest solar + battery build's LCOE, saving
  take2_potential.csv   onshore, offshore fixed and floating technical potential
                        against demand (T014 Potential-map conventions)
  take2_by_lat.csv      the same by latitude band, plus people in cells whose
                        wind potential covers local demand
  take4_by_lat.csv      by latitude band: cost of 80/90/95% uptime with and
                        without wind, where solar + battery alone cannot reach it
  take5_by_year.csv     the atlas's cost paths (2026 -> 2050): LCOE with and
                        without wind and how much of the cheapest build is wind
  summary.json          headline numbers quoted in team/evidence/harnessing-the-winds.md

  take1_weak_wind.csv   cells whose windiest fifth of eligible land, and of eligible sea
                        (500 km2 at least), averages below 15% net CF before the level
                        factors ('weak wind', T063 W1), by country
  local_onshore_capex.csv   the app's Local onshore capex anchors against the Global one

Definitions are in the evidence file and in the comments below. Cost comparisons
are like for like: '*_both_reach' medians are over the cells where both the
cheapest build with wind and the best solar + battery build reach the target, so
the two medians cover the same cells and weights, and the share of weight that
solar + battery cannot reach is reported separately ('share_met_solar_battery_only').
The plain 'median_lcoe_*' columns count a cell that cannot reach the target as
+infinity (blank when over half the weight is unmet); they describe reach as much
as cost and are not used for cost comparisons.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import engine  # noqa: E402

DATA = engine.DATA
OUT = HERE / 'out'
TARGETS = [50, 60, 70, 75, 80, 85, 90, 95, 99]
HEAD_TARGETS = [80, 90, 95]
YEARS = [2026, 2030, 2035, 2040, 2050]
LAT_BANDS = [(-90, -45), (-45, -30), (-30, -15), (-15, 0), (0, 15), (15, 30), (30, 45), (45, 55), (55, 65), (65, 90)]
TWH_PER_GW_CF = 8.76           # map.js
WEAK_WIND_CF = 0.15      # 'weak wind' line for the take 1 context (T063 W1; model.js WEAK_WIND_CF must match)
MMBTU_PER_MWH = 3.412          # constants.js
GAS_EFFICIENCY = 0.35          # app.js lcoeParams.gasEfficiency (OCGT, the app's backup default)


def band_label(lo, hi):
    f = lambda v: f'{abs(v)}°{"S" if v < 0 else "N"}' if v else '0°'
    return f'{f(lo)} to {f(hi)}'


# ---------------------------------------------------------------------------
# Weights and cell attributes
# ---------------------------------------------------------------------------
def cell_table(ids):
    import pyarrow.parquet as pq
    pos = pq.read_table(DATA / 'summary_w0.parquet', columns=['location_id', 'latitude', 'longitude']).to_pandas()
    pos = pos.drop_duplicates('location_id').set_index('location_id').reindex(ids)
    t = pd.DataFrame({'location_id': ids, 'lat': pos['latitude'].to_numpy(np.float64),
                      'lon': pos['longitude'].to_numpy(np.float64)})
    # Population: GPW v4 2020, keyed by lat/lon; joined on the app's 2-decimal key
    # (app.js ensurePotentialPopulationMap).
    pop = pd.read_csv(DATA / 'voronoi_population_2020.csv')
    key = lambda la, lo: [f'{a:.2f},{b:.2f}' for a, b in zip(la, lo)]
    pmap = dict(zip(key(pop.latitude, pop.longitude), pop.population_2020))
    t['pop'] = [pmap.get(k, np.nan) for k in key(t.lat, t.lon)]
    t['pop_matched'] = t['pop'].notna()
    t['pop'] = t['pop'].fillna(0.0)
    dem = pd.read_csv(DATA / 'voronoi_electricity_demand.csv')[['location_id', 'annual_demand_kwh']]
    t = t.merge(dem, on='location_id', how='left')
    t['demand_twh'] = t['annual_demand_kwh'].fillna(0.0) / 1e9
    wr = pd.read_csv(DATA / 'voronoi_wind_resource.csv')
    t = t.merge(wr[['location_id', 'on_viable', 'off_viable', 'on_viable_area_km2', 'on_final_cf', 'on_cf_p50',
                    'on_site_speed_100m', 'off_final_cf', 'off_cf_p50', 'on_cf_best', 'off_cf_best',
                    'on_level_factor', 'off_level_factor']],
                on='location_id', how='left')
    t['wind_viable'] = (t.on_viable.fillna(0) == 1) | (t.off_viable.fillna(0) == 1)
    # Weak wind (T063, W1): neither the windiest fifth of the region's eligible land nor that of
    # its eligible sea (500 km2 at least; cf_best times the D-134/D-135 level factor, i.e. the
    # calibrated level, since T068 / D-146; a missing factor counts as 1) reaches 15% net CF.
    # Since D-123 every region with eligible land or sea is viable, so this, not viability,
    # marks the low-wind places.
    on_cal = t.on_cf_best * t.on_level_factor.fillna(1)
    off_cal = t.off_cf_best * t.off_level_factor.fillna(1)
    t['wind_weak'] = ~((on_cal.fillna(0) >= WEAK_WIND_CF) | (off_cal.fillna(0) >= WEAK_WIND_CF))
    gas = pd.read_csv(DATA / 'voronoi_gas_prices.csv')[['location_id', 'gas_2024_usd_per_mmbtu', 'gas_available']]
    t = t.merge(gas, on='location_id', how='left')
    ok = t.gas_available.astype(str).str.lower().eq('true') & t.gas_2024_usd_per_mmbtu.notna()
    t['gas_fuel_usd_mwh'] = np.where(ok, t.gas_2024_usd_per_mmbtu * MMBTU_PER_MWH / GAS_EFFICIENCY, np.nan)
    pv = pd.read_csv(DATA / 'voronoi_pvout_potential.csv')[['location_id']]
    t['map_cell'] = t.location_id.isin(pv.location_id)
    return t


def wmedian(values, weights):
    """Weighted median; +inf allowed. None if total weight is zero or the median is infinite."""
    v = np.asarray(values, float)
    w = np.asarray(weights, float)
    keep = (w > 0) & ~np.isnan(v)
    v, w = v[keep], w[keep]
    if w.sum() <= 0:
        return None
    o = np.argsort(v, kind='stable')
    cw = np.cumsum(w[o])
    med = v[o][np.searchsorted(cw, 0.5 * cw[-1])]
    return None if not np.isfinite(med) else float(med)


def wquantile(values, weights, q):
    v = np.asarray(values, float)
    w = np.asarray(weights, float)
    keep = (w > 0) & ~np.isnan(v)
    v, w = v[keep], w[keep]
    if w.sum() <= 0:
        return None
    o = np.argsort(v, kind='stable')
    cw = np.cumsum(w[o])
    x = v[o][np.searchsorted(cw, q * cw[-1])]
    return None if not np.isfinite(x) else float(x)


def both_reach(res, w, sel=None):
    """Like-for-like: weighted medians of the cheapest build with wind and of the
    best solar + battery build, over the cells where both reach the target.
    `w` is the full-length weight array; `sel` an optional cell mask.
    Returns (median with wind, median solar + battery only, fractional cut)."""
    both = res['meets'] & res['nowind_meets']
    if sel is not None:
        both = both & sel
    ww = np.where(both, w, 0.0)
    a = wmedian(np.where(both, res['lcoe'], np.nan), ww)
    b = wmedian(np.where(both, res['nowind_lcoe'], np.nan), ww)
    cut = (1 - a / b) if (a is not None and b) else None
    return a, b, cut


def share(mask, w):
    w = np.asarray(w, float)
    tot = w.sum()
    return float(w[mask].sum() / tot) if tot > 0 else None


def r(x, d=4):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else round(float(x), d)


# ---------------------------------------------------------------------------
# Take 1 classification
# ---------------------------------------------------------------------------
def classify(res):
    """Per cell, at one target:
    wind_cheaper  the cheapest build meeting the target has wind, and a solar +
                  battery build also meets it (so wind lowers the cost: ties go to
                  the no-wind build, which comes first in config order)
    wind_only     the target is met, but no solar + battery build in the grid
                  meets it (up to 20 GW solar and 36 GWh battery per GW of load)
    no_gain       met, and the cheapest build has no wind
    unmet         no build in the grid meets the target
    """
    meets, wind = res['meets'], res['wind_gw'] > 0
    cls = np.full(len(meets), 'unmet', dtype=object)
    cls[meets & ~wind] = 'no_gain'
    cls[meets & wind & res['nowind_meets']] = 'wind_cheaper'
    cls[meets & ~res['nowind_meets']] = 'wind_only'
    return cls


def take1_rows(cells, res, target, surfaces):
    cls = classify(res)
    out = []
    lc_w = np.where(res['meets'], res['lcoe'], np.inf)
    lc_nw = np.where(res['nowind_meets'], res['nowind_lcoe'], np.inf)
    both = res['meets'] & res['nowind_meets']
    pct = np.where(both, res['saving'] / res['nowind_lcoe'], np.nan)
    for wname, w in [('cells', np.ones(len(cls))), ('people', cells['pop'].to_numpy()),
                     ('demand', cells['demand_twh'].to_numpy())]:
        row = dict(target_cf=target, surfaces=surfaces, weight=wname)
        for c in ['wind_cheaper', 'wind_only', 'no_gain', 'unmet']:
            row[f'share_{c}'] = r(share(cls == c, w))
        row['share_wind_helps'] = r(share((cls == 'wind_cheaper') | (cls == 'wind_only'), w))
        row['share_no_gain_wind_not_viable'] = r(share((cls == 'no_gain') & ~cells.wind_viable.to_numpy(), w))
        wv = cells.wind_viable.to_numpy()
        row['share_wind_not_viable'] = r(share(~wv, w))
        row['share_wind_weak'] = r(share(cells.wind_weak.to_numpy(), w))
        row['share_wind_helps_where_wind_viable'] = r(share(((cls == 'wind_cheaper') | (cls == 'wind_only'))[wv], w[wv]))
        # Among cells where wind helps and solar + battery also meets the target
        wc = cls == 'wind_cheaper'
        row['median_saving_usd_mwh_where_cheaper'] = r(wmedian(res['saving'][wc], w[wc]), 2)
        # T058 headline (hw.* in model.js): saving above $15/MWh; the same against the
        # slider (standard) solar + battery builds only, where the cheapest build has wind.
        row['share_wind_cheaper_by_15'] = r(share(wc & (res['saving'] > 15), w))
        with np.errstate(invalid='ignore'):
            std = np.where(res['meets'] & (res['wind_gw'] > 0), res['nowind_std_lcoe'] - res['lcoe'], np.nan)
        row['share_wind_cheaper_than_standard'] = r(share(std > 0, w))
        row['share_wind_cheaper_than_standard_by_15'] = r(share(std > 15, w))
        row['median_saving_pct_where_cheaper'] = r(wmedian(pct[wc], w[wc]))
        # Over every cell where both meet the target (saving 0 where wind isn't chosen)
        row['median_saving_pct_where_both_meet'] = r(wmedian(pct[both], w[both]))
        a, b, cut = both_reach(res, w)
        row['median_lcoe_with_wind_both_reach'] = r(a, 2)
        row['median_lcoe_solar_battery_only_both_reach'] = r(b, 2)
        row['median_cut_both_reach'] = r(cut)
        row['median_lcoe_with_wind'] = r(wmedian(lc_w, w), 2)
        row['median_lcoe_solar_battery_only'] = r(wmedian(lc_nw, w), 2)
        row['p25_lcoe_with_wind'] = r(wquantile(lc_w, w, 0.25), 2)
        row['p25_lcoe_solar_battery_only'] = r(wquantile(lc_nw, w, 0.25), 2)
        row['p75_lcoe_with_wind'] = r(wquantile(lc_w, w, 0.75), 2)
        row['p75_lcoe_solar_battery_only'] = r(wquantile(lc_nw, w, 0.75), 2)
        row['share_met_with_wind'] = r(share(res['meets'], w))
        row['share_met_solar_battery_only'] = r(share(res['nowind_meets'], w))
        row['share_met_solar_battery_only_standard'] = r(share(res['nowind_std_meets'], w))
        row['mean_wind_share_of_capacity_where_met'] = r(
            float(np.average(res['wind_share'][res['meets']], weights=w[res['meets']]))
            if w[res['meets']].sum() > 0 else None)
        out.append(row)
    return out


def main():
    OUT.mkdir(exist_ok=True)
    m = engine.load_matrix()
    cells = cell_table(m['ids'])
    summary = {'base_year': engine.BASE_YEAR, 'n_cells_engine': int(len(cells)),
               'n_map_cells': int(cells.map_cell.sum()),
               'population_total_bn': r(cells['pop'].sum() / 1e9, 3),
               'population_unmatched_cells': int((~cells.pop_matched).sum()),
               'demand_total_twh': r(cells['demand_twh'].sum(), 0)}

    # ---- Take 1 and take 5 share one loop over years ---------------------
    t1, t5, percell = [], [], {}
    lat = cells.lat.to_numpy()
    pop = cells['pop'].to_numpy()
    dem = cells['demand_twh'].to_numpy()
    north = lat >= 45
    for year in YEARS:
        lcoe, cf = engine.lcoe_matrix(m, year=year)
        mult = engine.cost_multipliers(year)
        for target in (TARGETS if year == engine.BASE_YEAR else HEAD_TARGETS):
            res = engine.search(m, lcoe, cf, target / 100, include_offshore=True)
            if year == engine.BASE_YEAR:
                t1 += take1_rows(cells, res, target, 'onshore+offshore')
                res_on = engine.search(m, lcoe, cf, target / 100, include_offshore=False)
                t1 += take1_rows(cells, res_on, target, 'onshore only')
                if target in HEAD_TARGETS:
                    percell[target] = res
                    percell[(target, 'on')] = res_on
            cls = classify(res)
            lc_w = np.where(res['meets'], res['lcoe'], np.inf)
            lc_nw = np.where(res['nowind_meets'], res['nowind_lcoe'], np.inf)
            for (scope, sel), (wname, wall) in [(s, wt) for s in [('world', np.ones(len(lat), bool)), ('45N and north', north)]
                                                 for wt in [('people', pop), ('demand', dem)]]:
                w = wall[sel]
                t5.append(dict(
                    year=year, target_cf=target, scope=scope, weight=wname,
                    capex_factor_solar=r(mult['solar']), capex_factor_battery=r(mult['battery']),
                    capex_factor_onshore=r(mult['wind']), capex_factor_offshore=r(mult['windOff']),
                    median_lcoe_with_wind=r(wmedian(lc_w[sel], w), 2),
                    median_lcoe_solar_battery_only=r(wmedian(lc_nw[sel], w), 2),
                    share_cheapest_build_has_wind=r(share((res['meets'] & (res['wind_gw'] > 0))[sel], w)),
                    share_wind_helps=r(share(((cls == 'wind_cheaper') | (cls == 'wind_only'))[sel], w)),
                    share_wind_cheaper=r(share((cls == 'wind_cheaper')[sel], w)),
                    share_wind_only=r(share((cls == 'wind_only')[sel], w)),
                    median_lcoe_with_wind_both_reach=r(both_reach(res, wall, sel)[0], 2),
                    median_lcoe_solar_battery_only_both_reach=r(both_reach(res, wall, sel)[1], 2),
                    median_cut_both_reach=r(both_reach(res, wall, sel)[2]),
                    share_met_with_wind=r(share(res['meets'][sel], w)),
                    share_met_solar_battery_only=r(share(res['nowind_meets'][sel], w)),
                    mean_wind_share_of_capacity_where_met=r(float(np.average(
                        res['wind_share'][sel][res['meets'][sel]], weights=w[res['meets'][sel]]))
                        if w[res['meets'][sel]].sum() > 0 else None),
                ))
    pd.DataFrame(t1).to_csv(OUT / 'take1_by_target.csv', index=False)
    pd.DataFrame(t5).to_csv(OUT / 'take5_by_year.csv', index=False)

    # Per-cell table (both surfaces, base year)
    pc = cells[['location_id', 'lat', 'lon', 'pop', 'demand_twh', 'wind_viable']].copy()
    pc['lat'] = pc.lat.round(4)
    pc['lon'] = pc.lon.round(4)
    pc['pop'] = pc['pop'].round(0)
    pc['demand_twh'] = pc.demand_twh.round(4)
    for t in HEAD_TARGETS:
        res = percell[t]
        pc[f't{t}_class'] = classify(res)
        pc[f't{t}_build'] = [f'{s}|{w}{"" if w == 0 else ":" + sf}|{b}' for s, w, sf, b in
                             zip(res['solar_gw'], res['wind_gw'], res['surface'], res['batt_gwh'])]
        pc[f't{t}_lcoe'] = np.round(res['lcoe'], 2)
        pc[f't{t}_meets'] = res['meets'].astype(int)
        pc[f't{t}_sb_lcoe'] = np.round(res['nowind_lcoe'], 2)
        pc[f't{t}_sb_meets'] = res['nowind_meets'].astype(int)
        pc[f't{t}_saving'] = np.round(res['saving'], 2)
    pc.to_csv(OUT / 'take1_cells.csv', index=False)

    # ---- Take 4: latitude bands -------------------------------------------
    t4 = []
    for t in HEAD_TARGETS:
        res = percell[t]
        res_on = percell[(t, 'on')]
        cls = classify(res)
        lc_w = np.where(res['meets'], res['lcoe'], np.inf)
        lc_on = np.where(res_on['meets'], res_on['lcoe'], np.inf)
        lc_nw = np.where(res['nowind_meets'], res['nowind_lcoe'], np.inf)
        bands = [(lo, hi, band_label(lo, hi), (lat >= lo) & (lat < hi)) for lo, hi in LAT_BANDS]
        bands += [(45, 90, '45°N and north', lat >= 45), (50, 90, '50°N and north', lat >= 50),
                  (55, 90, '55°N and north', lat >= 55), (-90, 90, 'World', np.ones(len(lat), bool))]
        for lo, hi, label, sel in bands:
            w = pop[sel]
            g = cells.gas_fuel_usd_mwh.to_numpy()[sel]
            t4.append(dict(
                target_cf=t, band=label, lat_lo=lo, lat_hi=hi, cells=int(sel.sum()),
                people_m=r(w.sum() / 1e6, 1), demand_twh=r(dem[sel].sum(), 0),
                share_people_met_solar_battery_only=r(share(res['nowind_meets'][sel], w)),
                share_people_met_solar_battery_only_standard=r(share(res['nowind_std_meets'][sel], w)),
                # T058: regions whose no-wind build is a large add-on build, and its median solar and battery
                regions_nowind_large=int((res['nowind_large'] & res['nowind_meets'])[sel].sum()),
                median_solar_nowind_large=r(float(np.median(res['nowind_solar'][sel & res['nowind_large'] & res['nowind_meets']]))
                                            if (sel & res['nowind_large'] & res['nowind_meets']).any() else None),
                median_batt_nowind_large=r(float(np.median(res['nowind_batt'][sel & res['nowind_large'] & res['nowind_meets']]))
                                           if (sel & res['nowind_large'] & res['nowind_meets']).any() else None),
                share_people_met_with_wind=r(share(res['meets'][sel], w)),
                share_people_met_onshore_wind_only_surface=r(share(res_on['meets'][sel], w)),
                share_people_wind_helps=r(share(((cls == 'wind_cheaper') | (cls == 'wind_only'))[sel], w)),
                share_people_wind_only=r(share((cls == 'wind_only')[sel], w)),
                share_people_wind_cheaper=r(share((cls == 'wind_cheaper')[sel], w)),
                median_lcoe_with_wind_both_reach=r(both_reach(res, pop, sel)[0], 2),
                median_lcoe_solar_battery_only_both_reach=r(both_reach(res, pop, sel)[1], 2),
                median_cut_both_reach=r(both_reach(res, pop, sel)[2]),
                median_lcoe_solar_battery_only=r(wmedian(lc_nw[sel], w), 2),
                median_lcoe_with_wind=r(wmedian(lc_w[sel], w), 2),
                median_lcoe_with_onshore_wind_only=r(wmedian(lc_on[sel], w), 2),
                p25_lcoe_with_wind=r(wquantile(lc_w[sel], w, 0.25), 2),
                p75_lcoe_with_wind=r(wquantile(lc_w[sel], w, 0.75), 2),
                median_wind_share_of_capacity=r(wmedian(np.where(res['meets'], res['wind_share'], np.nan)[sel], w)),
                median_gas_fuel_cost_usd_mwh=r(wmedian(g, w), 2),
                share_people_with_wind_below_gas_fuel_cost=r(share((lc_w[sel] < g) & np.isfinite(g), w)),
                share_people_sb_below_gas_fuel_cost=r(share((lc_nw[sel] < g) & np.isfinite(g), w)),
                share_people_with_gas_price=r(share(np.isfinite(g), w)),
            ))
    pd.DataFrame(t4).to_csv(OUT / 'take4_by_lat.csv', index=False)

    # ---- Take 4 examples: by country (each cell counted in its dominant country,
    # voronoi_overlapping_countries.csv; cells straddle borders, so these are
    # indicative). Countries with at least 5 million people in the atlas.
    oc = pd.read_csv(DATA / 'voronoi_overlapping_countries.csv')[['location_id', 'country_name']]
    country = cells[['location_id']].merge(oc, on='location_id', how='left')['country_name'].fillna('(none)').to_numpy()
    t4c = []
    for name in sorted(set(country)):
        sel = country == name
        w = pop[sel]
        if w.sum() < 5e6:
            continue
        row = dict(country=name, people_m=r(w.sum() / 1e6, 1), demand_twh=r(dem[sel].sum(), 0),
                   median_lat=r(wmedian(lat[sel], w), 1))
        for t in HEAD_TARGETS:
            res = percell[t]
            lc_w = np.where(res['meets'], res['lcoe'], np.inf)
            lc_nw = np.where(res['nowind_meets'], res['nowind_lcoe'], np.inf)
            row[f't{t}_median_lcoe_with_wind'] = r(wmedian(lc_w[sel], w), 2)
            row[f't{t}_median_lcoe_solar_battery_only'] = r(wmedian(lc_nw[sel], w), 2)
            row[f't{t}_share_people_met_solar_battery_only'] = r(share(res['nowind_meets'][sel], w))
            cl = classify(res)
            row[f't{t}_share_people_wind_cheaper'] = r(share((cl == 'wind_cheaper')[sel], w))
            row[f't{t}_share_people_wind_only'] = r(share((cl == 'wind_only')[sel], w))
            row[f't{t}_median_cut_both_reach'] = r(both_reach(res, pop, sel)[2])
        t4c.append(row)
    pd.DataFrame(t4c).sort_values('median_lat', ascending=False).to_csv(OUT / 'take4_countries.csv', index=False)

    # ---- Take 1 context: cells with only weak wind (no site >= 15%), by country
    nv = cells.wind_weak.to_numpy()
    tot_pop, tot_dem = pop.sum(), dem.sum()
    t1nv = [dict(country='(all)', cells=int(nv.sum()), people_m=r(pop[nv].sum() / 1e6, 1),
                 share_of_world_people=r(pop[nv].sum() / tot_pop), demand_twh=r(dem[nv].sum(), 0),
                 share_of_world_demand=r(dem[nv].sum() / tot_dem),
                 median_on_site_speed_100m=r(float(np.nanmedian(cells.on_site_speed_100m.to_numpy()[nv])), 2),
                 median_on_cf_p50=r(float(np.nanmedian(cells.on_cf_p50.to_numpy()[nv])), 3),
                 people_weighted_lat=r(float(np.average(lat[nv], weights=pop[nv])), 1),
                 people_weighted_lon=r(float(np.average(cells.lon.to_numpy()[nv], weights=pop[nv])), 1))]
    for name in sorted(set(country[nv])):
        sel = nv & (country == name)
        if pop[sel].sum() < 20e6:
            continue
        t1nv.append(dict(country=name, cells=int(sel.sum()), people_m=r(pop[sel].sum() / 1e6, 1),
                         share_of_world_people=r(pop[sel].sum() / tot_pop), demand_twh=r(dem[sel].sum(), 0),
                         share_of_world_demand=r(dem[sel].sum() / tot_dem),
                         median_on_site_speed_100m=r(float(np.nanmedian(cells.on_site_speed_100m.to_numpy()[sel])), 2),
                         median_on_cf_p50=r(float(np.nanmedian(cells.on_cf_p50.to_numpy()[sel])), 3),
                         people_weighted_lat=r(float(np.average(lat[sel], weights=pop[sel])), 1),
                         people_weighted_lon=r(float(np.average(cells.lon.to_numpy()[sel], weights=pop[sel])), 1)))
    pd.DataFrame(t1nv).sort_values('people_m', ascending=False).to_csv(OUT / 'take1_weak_wind.csv', index=False)

    # ---- Local onshore capex (the app's Local series) against the Global anchor
    lc = pd.read_csv(DATA / 'voronoi_local_capex.csv')[['location_id', 'wind_on_2024']]
    lcap = cells[['location_id']].merge(lc, on='location_id', how='left')['wind_on_2024'].to_numpy(float)
    rows_lc = []
    for scope, sel in [('World', np.ones(len(lat), bool)), ('45°N and north', lat >= 45), ('50°N and north', lat >= 50)] + \
            [(n, country == n) for n in ['Germany', 'United Kingdom', 'France', 'Poland', 'United States of America', 'China', 'India']]:
        ok = sel & np.isfinite(lcap)
        rows_lc.append(dict(scope=scope, people_weighted_median_local_onshore_capex_2024=r(wmedian(lcap[ok], pop[ok]), 0),
                            global_mode_onshore_capex=engine.PARAMS['windCapex']))
    pd.DataFrame(rows_lc).to_csv(OUT / 'local_onshore_capex.csv', index=False)

    # ---- Take 2: technical potential (T014 Potential-map conventions) ------
    pv = pd.read_csv(DATA / 'voronoi_pvout_potential.csv')
    offp = pd.read_csv(DATA / 'voronoi_wind_potential_offshore.csv')[['location_id', 'fixed_gw', 'floating_gw']]
    p = pv[['location_id', 'total_level1_twh_y', 'total_level2_twh_y']].merge(
        cells[['location_id', 'lat', 'pop', 'demand_twh', 'on_viable', 'off_viable', 'on_viable_area_km2',
               'on_final_cf', 'on_cf_p50', 'off_final_cf', 'off_cf_p50', 'on_level_factor', 'off_level_factor']],
        on='location_id', how='left'
    ).merge(offp, on='location_id', how='left')
    # The cautious case's median land carries the same level factors as the default level (T063 audit M1,
    # D-134/D-135), so both cases are calibrated alike.
    p['on_cf_p50_cal'] = p.on_cf_p50 * p.on_level_factor.fillna(1.0)
    p['off_cf_p50_cal'] = p.off_cf_p50 * p.off_level_factor.fillna(1.0)
    onv = p.on_viable.fillna(0) == 1
    offv = (p.off_viable.fillna(0) == 1) & (p.off_final_cf.fillna(0) > 0)
    for dens in (5, 3):
        p[f'on_gw_{dens}'] = np.where(onv, p.on_viable_area_km2.fillna(0) * dens / 1000, 0.0)
        p[f'on_twh_{dens}'] = np.where(onv & (p.on_final_cf.fillna(0) > 0), p[f'on_gw_{dens}'] * p.on_final_cf * TWH_PER_GW_CF, 0.0)
        p[f'on_twh_{dens}_p50'] = np.where(onv, p[f'on_gw_{dens}'] * p.on_cf_p50_cal.fillna(0) * TWH_PER_GW_CF, 0.0)
    p['off_fixed_twh'] = np.where(offv, p.fixed_gw.fillna(0) * p.off_final_cf * TWH_PER_GW_CF, 0.0)
    p['off_fixed_twh_p50'] = np.where(offv, p.fixed_gw.fillna(0) * p.off_cf_p50_cal.fillna(0) * TWH_PER_GW_CF, 0.0)
    p['off_fixed_gw_no_estimate'] = np.where(~offv, p.fixed_gw.fillna(0), 0.0)
    p['off_float_twh'] = np.where(offv, p.floating_gw.fillna(0) * p.off_final_cf * TWH_PER_GW_CF, 0.0)
    demand_tot = p.demand_twh.sum()
    rows = []
    def add(item, gw, twh, note):
        rows.append(dict(item=item, gw=r(gw, 0), twh_per_year=r(twh, 0),
                         multiple_of_atlas_demand=r(twh / demand_tot, 1) if twh is not None else None, note=note))
    add('Onshore wind, 5 MW/km2 (default)', p.on_gw_5.sum(), p.on_twh_5.sum(), 'on_viable cells; on_final_cf (best-20% level x level factor, capped scaling)')
    add('Onshore wind, 5 MW/km2, median-site CF', p.on_gw_5.sum(), p.on_twh_5_p50.sum(), 'on_cf_p50 x level factor instead of on_final_cf')
    add('Onshore wind, 3 MW/km2 (low case)', p.on_gw_3.sum(), p.on_twh_3.sum(), 'Denholm 2009 whole-project density')
    add('Onshore wind, 3 MW/km2, median-site CF', p.on_gw_3.sum(), p.on_twh_3_p50.sum(), 'most conservative onshore case')
    add('Offshore wind, fixed-bottom (ESMAP)', p.fixed_gw.fillna(0).sum(), p.off_fixed_twh.sum(), 'ESMAP fixed_gw x off_final_cf where the atlas has a viable offshore site')
    add('Offshore wind, fixed-bottom, median-site CF', p.fixed_gw.fillna(0).sum(), p.off_fixed_twh_p50.sum(), 'off_cf_p50 x level factor')
    add('Offshore fixed-bottom GW with no atlas CF (no estimate)', p.off_fixed_gw_no_estimate.sum(), None, 'counted as zero TWh')
    add('Offshore wind, floating (ESMAP, not costed)', p.floating_gw.fillna(0).sum(), p.off_float_twh.sum(), 'indicative: fixed-bottom site CF applied; US floating partly missing in ESMAP polygons')
    add('Solar PV, technical (Global Solar Atlas level 1)', None, p.total_level1_twh_y.sum(), 'context; the Potential map default')
    add('Atlas electricity demand (Chen et al. 2022)', None, demand_tot, 'the atlas demand layer')
    pd.DataFrame(rows).to_csv(OUT / 'take2_potential.csv', index=False)

    p['wind_twh'] = p.on_twh_5 + p.off_fixed_twh
    p['wind_twh_low'] = p.on_twh_3_p50 + p.off_fixed_twh_p50
    with np.errstate(divide='ignore', invalid='ignore'):
        cover = np.where(p.demand_twh > 0, p.wind_twh / p.demand_twh, np.inf)
        cover_low = np.where(p.demand_twh > 0, p.wind_twh_low / p.demand_twh, np.inf)
    t2 = []
    latp = p.lat.to_numpy()
    for lo, hi, label, sel in [(lo, hi, band_label(lo, hi), (latp >= lo) & (latp < hi)) for lo, hi in LAT_BANDS] + \
            [(45, 90, '45°N and north', latp >= 45), (-90, 90, 'World', np.ones(len(latp), bool))]:
        w = p['pop'].to_numpy()[sel]
        d = p.demand_twh[sel].sum()
        t2.append(dict(
            band=label, people_m=r(w.sum() / 1e6, 1), demand_twh=r(d, 0),
            onshore_twh_5=r(p.on_twh_5[sel].sum(), 0), offshore_fixed_twh=r(p.off_fixed_twh[sel].sum(), 0),
            wind_multiple_of_demand=r((p.on_twh_5[sel].sum() + p.off_fixed_twh[sel].sum()) / d, 1) if d > 0 else None,
            wind_multiple_of_demand_low=r(p.wind_twh_low[sel].sum() / d, 1) if d > 0 else None,
            solar_twh_level1=r(p.total_level1_twh_y[sel].sum(), 0),
            share_people_local_wind_covers_demand=r(share(cover[sel] >= 1, w)),
            share_people_local_wind_covers_demand_low=r(share(cover_low[sel] >= 1, w)),
            share_people_in_cells_with_viable_wind=r(share((onv | offv).to_numpy()[sel], w)),
        ))
    pd.DataFrame(t2).to_csv(OUT / 'take2_by_lat.csv', index=False)

    ext = pd.read_csv(HERE / 'inputs' / 'external_figures.csv')
    world_2025 = float(ext[(ext.item == 'electricity_demand') & (ext.period == '2025')].value.iloc[0])
    summary['take2'] = {
        'world_demand_2025_twh_ember': world_2025,
        'wind_multiple_of_world_demand_2025': r((p.on_twh_5.sum() + p.off_fixed_twh.sum()) / world_2025, 0),
        'wind_multiple_of_world_demand_2025_low': r(p.wind_twh_low.sum() / world_2025, 0),
        'onshore_multiple_of_world_demand_2025_low': r(p.on_twh_3_p50.sum() / world_2025, 0),
        'onshore_tw_5': r(p.on_gw_5.sum() / 1000, 1), 'onshore_pwh_5': r(p.on_twh_5.sum() / 1000, 0),
        'onshore_pwh_3_p50': r(p.on_twh_3_p50.sum() / 1000, 0),
        'offshore_fixed_tw': r(p.fixed_gw.sum() / 1000, 1), 'offshore_fixed_pwh': r(p.off_fixed_twh.sum() / 1000, 0),
        'offshore_floating_tw': r(p.floating_gw.sum() / 1000, 1),
        'demand_twh': r(demand_tot, 0),
        'wind_multiple_of_demand': r((p.on_twh_5.sum() + p.off_fixed_twh.sum()) / demand_tot, 0),
        'wind_multiple_of_demand_low': r(p.wind_twh_low.sum() / demand_tot, 0),
    }
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=1) + '\n')
    print(json.dumps(summary, indent=1))


if __name__ == '__main__':
    main()
