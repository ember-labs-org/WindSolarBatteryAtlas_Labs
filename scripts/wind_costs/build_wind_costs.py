#!/usr/bin/env python3
"""Build the atlas's per-cell wind costs (capex, O&M, WACC) and solar WACC from cited sources.

Inputs: scripts/wind_costs/inputs/*.csv (extracts of the cited sources, see README.md) and the
committed cell files in deployment/data/. Stdlib only, deterministic, safe to re-run.

Writes (keeping every existing column and the row order):
  deployment/data/voronoi_local_capex.csv  wind_on_*/wind_off_* refilled, new wind_* columns added
  deployment/data/voronoi_wacc_wind.csv    Hatton v3 onshore/offshore/floating WACC (D-054)
  deployment/data/voronoi_wacc.csv         Hatton v3 solar PV WACC (D-055), new wacc_source column
  scripts/wind_costs/out/country_anchor_history.csv  per-country IRENA history, trend, variance, flags (D-057)
  scripts/wind_costs/out/summary_by_country.csv      headline values per country

Method: team/evidence/wind-costs.md section 7 as amended by D-054..D-059; details in README.md.
"""
import argparse
import csv
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
INP = HERE / 'inputs'
OUT = HERE / 'out'
DATA = ROOT / 'deployment' / 'data'

ANCHOR_LAST_YEAR = 2025          # IRENA RPGC 2025 data year; labelled "2024" in the app (D-058 Q1a)
YEARS = (2024, 2035, 2050)       # app year anchors
ONSHORE_SERIES = {'CHN': 'China', 'IND': 'India', 'USA': 'US', 'BRA': 'Brazil'}  # IRENA fig 1.7 series
OFFSHORE_COUNTRIES = {'CHN': 'China', 'KOR': 'Other', 'GBR': 'Europe', 'DEU': 'Europe', 'FRA': 'Europe', 'USA': 'Other'}
WACC_COLS = ['location_id', 'latitude', 'longitude', 'country_iso3', 'country_name', 'wacc_iso3', 'wacc_country',
             'wacc_percent', 'wacc_year', 'source', 'distance_km']          # schema the app reads (data.js)
WACC_WIND_COLS = ['location_id', 'latitude', 'longitude', 'country_iso3', 'country_name', 'wacc_iso3', 'wacc_country',
                  'solar_wacc_percent', 'wacc_year', 'source', 'distance_km', 'wind_on_wacc_percent',
                  'wind_off_wacc_percent', 'wind_wacc_source']
HIGH_VAR_SD = 0.15
# D-146 (human, T067): Gulf and Central Asia without their own IRENA value on a Chinese-supply proxy,
# the mean of the 2025 values for Egypt, Uzbekistan and Kazakhstan (fig 2.4). Countries with their own
# IRENA 2025 value (KAZ, UZB) keep it.
# D-148 (T072): China's single-year 2025 value is reverted. The rule also fitted Chile, Turkiye and the
# Global series, so applying it to China alone was selective; China is on the 2023-25 mean like every
# other listed country. The set is kept (empty) so the rule stays visible.
D146_SINGLE_YEAR = set()
D146_PROXY_ISO = {'SAU', 'ARE', 'QAT', 'OMN', 'KWT', 'BHR', 'TKM', 'KGZ', 'TJK'}
D146_PROXY_FROM = ('EGY', 'UZB', 'KAZ')
# D-146: offshore capex is never below this multiple of the same cell's onshore capex (each year).
# T082: not applied where a national regulator's capex is used (inputs/national_offshore_capex.csv).
OFFSHORE_FLOOR_X_ONSHORE = 1.5
# T082: where the transmission system operator builds and owns the offshore export system (substation
# and export cable), it is depreciated over its regulated 40-year life at the same WACC (TenneT Net op
# zee, BNetzA section 17d EnWG, Energinet, Elia MOG, RTE raccordement); the capex column then carries
# generator + export x CRF(w, 40) / CRF(w, WIND_OFF_LIFE), the capex that gives the same annual cost
# over the wind life the app uses. Metropolitan waters only (the box below).
TSO_EXPORT_ISO = {'NLD', 'DEU', 'DNK', 'BEL', 'FRA'}
TSO_EXPORT_LIFE = 40
WIND_OFF_LIFE = 30            # must match app.js lcoeParams.windOffLife (D-146)
EUROPE_BOX = (35.0, 72.0, -15.0, 35.0)   # lat min, lat max, lon min, lon max


def crf(r, n):
    return r * (1 + r) ** n / ((1 + r) ** n - 1)
R_EARTH_KM = 6371.0088


def read_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def write_csv(path, fieldnames, rows):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, lineterminator='\n', extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH_KM * math.asin(math.sqrt(h))


def fmt(x, nd):
    return '' if x is None else f'{x:.{nd}f}'


# ---------------------------------------------------------------- anchors and history (D-057 Q10)

def series_stats(values, n_anchor):
    """values: {year: float}. Anchor = mean of the values in the last n_anchor calendar years."""
    window = [y for y in range(ANCHOR_LAST_YEAR - n_anchor + 1, ANCHOR_LAST_YEAR + 1) if y in values]
    if not window:
        raise ValueError('no value in anchor window')
    anchor = statistics.fmean(values[y] for y in window)
    yrs = sorted(values)
    pts = [(y, math.log(values[y])) for y in yrs if y >= 2015]
    trend = None
    if len(pts) >= 3:
        my = statistics.fmean(p[0] for p in pts); ml = statistics.fmean(p[1] for p in pts)
        slope = sum((y - my) * (l - ml) for y, l in pts) / sum((y - my) ** 2 for y, _ in pts)
        trend = math.exp(slope) - 1
    changes = [math.log(values[y] / values[y - 1]) for y in yrs if y >= 2016 and y - 1 in values]
    yoy_sd = statistics.stdev(changes) if len(changes) >= 3 else None   # stdev subtracts the mean change (detrended)
    win_changes = [abs(math.log(values[y] / values[y - 1])) for y in window if y - 1 in values]
    flags = []
    if len(window) < n_anchor:
        flags.append('thin')
    if (yoy_sd is not None and yoy_sd > HIGH_VAR_SD) or (yoy_sd is None and win_changes and max(win_changes) > HIGH_VAR_SD):
        flags.append('high_variance')
    return {
        'anchor': anchor, 'window': window, 'latest_year': yrs[-1], 'latest': values[yrs[-1]],
        'first_year': yrs[0], 'n_years': len(yrs), 'trend': trend, 'yoy_sd': yoy_sd,
        'max_abs_yoy_window': max(win_changes) if win_changes else None, 'flags': flags,
    }


def window_tag(st):
    w = st['window']
    return f'avg{w[0]}' if len(w) == 1 else f'avg{w[0]}-{w[-1]}'


# ---------------------------------------------------------------- DEA offshore cost function

class Dea:
    def __init__(self, rows):
        p = {r['parameter']: float(r['value']) for r in rows}
        self.p = p
        k = p['eur2023_per_eur2020']
        # floating trajectories relative to the table 7 2025 floating cost at each sheet's site,
        # both in 2020 EUR (table 7 is 2023 prices; DEA table 6 factor). No depth term (floating).
        self.r_fixed = {
            'ac': {2035: p['sheet_fixed_ac_2035'] / p['sheet_fixed_ac_2025'], 2050: p['sheet_fixed_ac_2050'] / p['sheet_fixed_ac_2025']},
            'dc': {2035: p['sheet_fixed_dc_2035'] / p['sheet_fixed_dc_2025'], 2050: p['sheet_fixed_dc_2050'] / p['sheet_fixed_dc_2025']},
        }
        self.r_float = {}
        for conn in ('ac', 'dc'):
            base2025 = self.c_float(p[f'sheet_float_{conn}_ref_km'], conn) / k
            self.r_float[conn] = {y: p[f'sheet_float_{conn}_{y}'] / base2025 for y in (2035, 2050)}
        f = p['sheet_fom_fixed_2025']
        self.om_fixed = {2024: 1.0, 2035: p['sheet_fom_fixed_2035'] / f, 2050: p['sheet_fom_fixed_2050'] / f}
        self.om_float = {2024: p['t7_fom_float_over_fixed_2025'], 2035: p['sheet_fom_float_2035'] / f, 2050: p['sheet_fom_float_2050'] / f}
        o = p['sheet_fom_onshore_2025']
        self.om_on = {2024: 1.0, 2035: p['sheet_fom_onshore_2030'] / o, 2050: p['sheet_fom_onshore_2050'] / o}

    def _grid(self, D, conn):
        p = self.p
        return p[f'substation_{conn}'] + p[f'cable_{conn}_per_km'] * D

    def c_fixed(self, d, D, conn):
        p = self.p
        return p['devex_fixed'] + p['turbines'] + p['found_fixed_base'] + p['found_fixed_per_m'] * d + p['array'] + self._grid(D, conn)

    def c_float(self, D, conn):
        p = self.p
        return p['devex_floating'] + p['turbines'] + p['found_floating'] + p['array'] + self._grid(D, conn)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--floating-depth-m', type=float, default=60.0, help='fixed/floating split (D-064: 60 m)')
    ap.add_argument('--anchor-years', type=int, default=3, help='IRENA country anchor = mean of the last N years (D-057: 3)')
    ap.add_argument('--ac-dc-km', type=float, default=100.0, help='AC up to this distance, DC beyond (DEA ranges)')
    a = ap.parse_args()
    OUT.mkdir(exist_ok=True)

    # ---- cells and country keys
    cells = read_csv(DATA / 'voronoi_overlapping_countries.csv')
    cmap = {r['iso3']: r for r in read_csv(INP / 'country_map.csv')}
    hatton = {r['iso3']: r for r in read_csv(INP / 'hatton_v3_wacc.csv')}
    cell_ll = {int(c['location_id']): (float(c['latitude']), float(c['longitude'])) for c in cells}
    cell_iso = {int(c['location_id']): c['country_iso3'] for c in cells}
    for iso in set(cell_iso.values()):
        if iso not in cmap:
            raise SystemExit(f'country {iso} missing from inputs/country_map.csv')

    cell_multi = {int(c['location_id']): set(c['country_iso3s'].split('|')) | {c['country_iso3']} for c in cells}
    cells_of = defaultdict(list)
    for lid, iso in cell_iso.items():
        cells_of[iso].append(lid)

    def nearest_cell(lid, ok):
        lat, lon = cell_ll[lid]
        best = None
        for other, iso in cell_iso.items():
            if iso == cell_iso[lid] or not ok(iso):
                continue
            d = haversine_km(lat, lon, *cell_ll[other])
            if best is None or d < best[0] or (d == best[0] and other < best[1]):
                best = (d, other)
        return best

    donor_cache = {}

    def country_donor(iso, ok, tag):
        """One donor country for a country without data (D-065): the data country sharing the most
        overlapping cells with it (a land neighbour); if none, the data country holding the nearest
        cell for most of its cells. Ties go to the smaller minimum cell-to-cell distance."""
        key = (iso, tag)
        if key in donor_cache:
            return donor_cache[key]
        nb = Counter()
        for lid, isos in cell_multi.items():
            if iso in isos:
                for o in isos:
                    if o != iso and o in cmap and ok(o):
                        nb[cmap[o]['data_iso3']] += 1
        how = 'land_neighbour'
        if not nb:
            how = 'majority_nearest'
            for lid in cells_of[iso]:
                nb[cmap[cell_iso[nearest_cell(lid, ok)[1]]]['data_iso3']] += 1
        top = max(nb.values())
        tied = sorted(o for o, n in nb.items() if n == top)

        def min_dist(o):
            return min(haversine_km(*cell_ll[a], *cell_ll[b]) for a in cells_of[iso] for b in cells_of[o]) if cells_of[o] else math.inf
        donor = min(tied, key=lambda o: (min_dist(o), o)) if len(tied) > 1 else tied[0]
        donor_cache[key] = (donor, how)
        return donor_cache[key]

    def dist_to_country(lid, o):
        return min((haversine_km(*cell_ll[lid], *cell_ll[b]) for b in cells_of[o]), default=0.0)

    # IRENA key per cell: the cell's own country unless it has no IRENA region (ATA, ATF)
    irena_key = {}
    for lid, iso in cell_iso.items():
        if cmap[iso]['irena_annex_region']:
            irena_key[lid] = (cmap[iso]['data_iso3'], 'country' if iso == cmap[iso]['data_iso3'] else f'mapped:{iso}>{cmap[iso]["data_iso3"]}', 0.0)
        else:
            d_iso, how = country_donor(iso, lambda x: bool(cmap[x]['irena_annex_region']), 'irena')
            irena_key[lid] = (d_iso, f'donor:{iso}>{d_iso}({how})', dist_to_country(lid, d_iso))
    region_of = {r['data_iso3']: r['irena_annex_region'] for r in cmap.values() if r['irena_annex_region']}
    oecd_of = {r['data_iso3']: r['oecd_member'] == '1' for r in cmap.values()}
    # Hatton key per cell
    wacc_key = {}
    for lid, iso in cell_iso.items():
        d_iso = cmap[iso]['data_iso3']
        if d_iso in hatton:
            wacc_key[lid] = (d_iso, 'country' if d_iso == iso else 'mapped_country', 0.0, '')
        else:
            n_iso, how = country_donor(iso, lambda x: cmap[x]['data_iso3'] in hatton, 'hatton')
            wacc_key[lid] = (n_iso, 'nearest_country', dist_to_country(lid, n_iso), how)

    # ---- onshore anchors
    on_country = {}
    hist_rows = []
    for r in read_csv(INP / 'irena_onshore_country_tic.csv'):
        vals = {int(y): float(v) for y, v in r.items() if y.isdigit() and v}
        st = series_stats(vals, a.anchor_years)
        on_country[r['iso3']] = st
        hist_rows.append(('onshore', 'SRC-IRENA-RPGC-2025 fig 2.4', r['irena_country'], r['iso3'], vals, st))
    on_2025 = {r['iso3']: float(r['2025']) for r in read_csv(INP / 'irena_onshore_country_tic.csv') if r['2025']}
    on_region = {r['irena_region']: float(r['weighted_average']) for r in read_csv(INP / 'irena_onshore_region_tic.csv')}
    proj = {r['series']: r for r in read_csv(INP / 'irena_onshore_projection.csv')}
    series_hist = {s: {2023: float(v['historical_2023']), 2024: float(v['historical_2024']), 2025: float(v['observed_2025'])}
                   for s, v in proj.items()}

    def r35(ser, window):
        # D-064: Refined 2035 over the series' own mean in the anchor's years (2023-2025 for a full window)
        return float(proj[ser]['refined_2035']) / statistics.fmean(series_hist[ser][y] for y in window)
    rate = {s: (float(v['refined_2035']) / float(v['refined_2025'])) ** (1 / 10) for s, v in proj.items()}  # D-057 Q1b

    def onshore_region(iso):
        reg = region_of[iso]
        if reg == 'Asia':
            return {'CHN': 'China', 'IND': 'India'}.get(iso, 'Other Asia')
        if reg == 'Middle East':
            return 'Other Asia'
        if reg in ('North America', 'Central America and the Caribbean'):
            return 'United States' if iso == 'USA' else 'Other North America'
        if reg == 'South America':
            return 'Brazil' if iso == 'BRA' else 'Other South America'
        return reg  # Africa, Eurasia, Europe, Oceania

    def onshore_series(iso):
        if iso in ONSHORE_SERIES:
            return ONSHORE_SERIES[iso]
        return 'Europe' if region_of[iso] == 'Europe' else 'Global'

    # ---- offshore anchors
    off_series = {}
    for r in read_csv(INP / 'irena_offshore_tic.csv'):
        vals = {int(y): float(v) for y, v in r.items() if y.isdigit() and v}
        off_series[r['key']] = (r, vals)
    off_anchor = {}
    for key, (r, vals) in off_series.items():
        st = series_stats(vals, a.anchor_years)
        off_anchor[key] = st
        if key != 'REGION_NORTH_AMERICA_US_ONLY':
            hist_rows.append(('offshore', f'SRC-IRENA-RPGC-2025 fig {r["figure"]}', r['irena_series'], key, vals, st))
    # T082: national regulator capex (local currency, price year) -> 2025 USD at that year's exchange
    # rate and US CPI-U; it enters the DEA site function like an IRENA anchor, at its site group.
    nat_off = {}
    for r in read_csv(INP / 'national_offshore_capex.csv'):
        usd = float(r['value_local_per_kw']) / float(r['fx_local_per_usd']) * float(r['cpi_2025']) / float(r['cpi_price_year'])
        nat_off[r['iso3']] = (usd, r['site_group'], f'{r["source_id"]} {r["price_year"]} {r["currency"]} '
                              f'{float(r["value_local_per_kw"]):g}/kW @{r["fx_local_per_usd"]} x CPI {r["cpi_2025"]}/{r["cpi_price_year"]}')
    glob_off = off_series['GLOBAL'][1][ANCHOR_LAST_YEAR]   # D-057: fallback = IRENA global 2025, $2,931/kW
    sites_ref = {r['site_group']: (float(r['depth_m']), float(r['distance_km'])) for r in read_csv(INP / 'irena_offshore_sites.csv')}

    def offshore_base(iso):
        if iso in nat_off:
            usd, grp, tag = nat_off[iso]
            return usd, grp, tag, 'national'
        if iso in OFFSHORE_COUNTRIES:
            st = off_anchor[iso]
            return st['anchor'], OFFSHORE_COUNTRIES[iso], f'SRC-IRENA-RPGC-2025 f4.4 {iso} {window_tag(st)}', 'country'
        reg = region_of[iso]
        if reg == 'Europe':
            st = off_anchor['REGION_EUROPE']
            return st['anchor'], 'Europe', f'SRC-IRENA-RPGC-2025 f4.4 Europe {window_tag(st)}', 'region:Europe'
        if reg == 'Asia':
            st = off_anchor['REGION_ASIA_EX_CHN']
            return st['anchor'], 'Other', f'SRC-IRENA-RPGC-2025 f4.4 Asia {window_tag(st)}', 'region:Asia'
        return glob_off, 'Global', 'SRC-IRENA-RPGC-2025 f4.3 global 2025', 'global_fallback'

    # ---- O&M
    # futures (IRENA data file, 2025 USD) values, checked against the annex print (2024 USD). Where a value
    # disagrees with the annex beyond integer rounding (> 3% after the table's median 2024->2025 factor),
    # the annex is preferred, converted with that factor (D-065 item 10: A3 Other OECD / Other non-OECD).
    om = defaultdict(dict)
    om_note = {}
    om_rows = read_csv(INP / 'irena_om.csv')
    for t in ('A3', 'A5'):
        rows_t = [r for r in om_rows if r['table'] == t]
        f = statistics.median(float(r['usd_2025_per_kw_yr']) / float(r['annex_printed_usd_2024'])
                              for r in rows_t if not r['key'].startswith('OTHER'))
        for r in rows_t:
            fut, ann = float(r['usd_2025_per_kw_yr']), float(r['annex_printed_usd_2024'])
            if abs(fut / (ann * f) - 1) > 0.03:
                om[t][r['key']] = ann * f
                om_note[(t, r['key'])] = f'annex{r["annex_table"]}x{f:.4f}'
            else:
                om[t][r['key']] = fut

    def om_lookup(table, iso):
        k = iso if iso in om[table] else ('OTHER_OECD' if oecd_of.get(iso) else 'OTHER_NON_OECD')
        note = om_note.get((table, k))
        return om[table][k], f'{k}({note})' if note else k

    dea = Dea(read_csv(INP / 'dea_offshore.csv'))
    sites = {int(r['location_id']): r for r in read_csv(INP / 'offshore_sites.csv')}
    # T082: designated or tendered zones (pipeline/scripts/pipeline/wind/offshore_zones.py) replace the
    # best-20% area as the cost site where a country publishes them
    zone_sites = {int(r['location_id']): r for r in read_csv(INP / 'offshore_zone_sites.csv')}
    sites.update(zone_sites)
    viable = {int(r['location_id']): r['off_viable'] == '1' for r in read_csv(DATA / 'voronoi_wind_resource.csv')}

    # ---- per-cell values
    res = {}
    for c in cells:
        lid = int(c['location_id'])
        iso, imethod, idist = irena_key[lid]
        v = {'wind_iso3': iso}
        # onshore capex
        if iso in D146_SINGLE_YEAR:
            anchor, src, on_short = on_2025[iso], f'f2.4 {iso} 2025 (D-146)', f'f2.4:{iso}:2025'
            window = [2025]
        elif iso in D146_PROXY_ISO and iso not in on_country:
            anchor = statistics.fmean(on_2025[k] for k in D146_PROXY_FROM)
            src, on_short = f'f2.4 mean 2025 {"/".join(D146_PROXY_FROM)} (D-146 Chinese-supply proxy)', 'f2.4:proxy_EGY_UZB_KAZ:2025'
            window = [2025]
        elif iso in on_country:
            st = on_country[iso]
            anchor, src, on_short = st['anchor'], f'f2.4 {iso} {window_tag(st)}', f'f2.4:{iso}:{window_tag(st)[3:]}'
            window = st['window']
        else:
            reg = onshore_region(iso)
            anchor, src, on_short = on_region[reg], f't2.1 {reg} 2025', f't2.1:{reg}:2025'
            window = [2025]
        ser = onshore_series(iso)
        on = {2024: anchor, 2035: anchor * r35(ser, window)}
        on[2050] = on[2035] * rate[ser] ** 15
        v['on'] = on
        v['wind_on_src'] = f'SRC-IRENA-RPGC-2025 {src}; f1.7 {ser} R2035/series mean {window[0]}-{window[-1]}, R2025-35 rate to 2050; {imethod}'
        w_iso, w_method, w_dist, w_how = wacc_key[lid]
        h = hatton[w_iso]
        # offshore capex
        base, grp, bsrc, bmethod = offshore_base(iso)
        d_ref, D_ref = sites_ref[grp]
        c_ref = dea.c_fixed(d_ref, D_ref, 'ac')
        flags = []
        s = sites.get(lid)
        if s:
            depth, dist = float(s['depth_m']), float(s['shore_km'])
            if float(s['etopo_z_m']) >= 0:
                flags.append('etopo_land')
            if s.get('on_land_ne') == '1':
                flags.append('site_inland_ne')   # inside a Natural Earth land polygon: lake (incl. Caspian), depression or ice bed
            D = min(max(dist, 10.0), 250.0)
            if D != dist:
                flags.append('dist_clamped')
            floating = depth > a.floating_depth_m
            d_fix = min(max(depth, 10.0), a.floating_depth_m)
            if not floating and d_fix != depth:
                flags.append('depth_clamped')
            if not floating and depth > 50:
                flags.append('fixed_depth_beyond_dea_50m')   # DEA fixed-bottom range ends at 50 m; linear term extrapolated
            if floating and depth > 100:
                flags.append('depth_beyond_dea_range')
            conn = 'dc' if D > a.ac_dc_km else 'ac'
            cls = f'{"floating" if floating else "fixed"}_{conn}'
            if not viable.get(lid):
                flags.append('site_not_viable')
            site_tag = f'site {grp} {d_ref:g}m/{D_ref:g}km; SRC-ETOPO-2022 SRC-NE-COAST-10M'
            site_ids = ' SRC-ETOPO-2022 SRC-NE-COAST-10M'
            if lid in zone_sites:
                flags.append('zone_site')
                site_tag += ' SRC-EMODNET-WINDFARMS-2025 zone'
                site_ids += ' SRC-EMODNET-WINDFARMS-2025'
        else:
            depth = dist = None
            D, d_fix, conn, cls = D_ref, d_ref, 'ac', 'none'
            flags.append('no_site')
            site_tag = f'no site: at ref site {grp} {d_ref:g}m/{D_ref:g}km'
            site_ids = ''
        fx24 = base * dea.c_fixed(d_fix, D, conn) / c_ref
        fl24 = base * dea.c_float(D, conn) / c_ref
        fixed = {2024: fx24, 2035: fx24 * dea.r_fixed[conn][2035], 2050: fx24 * dea.r_fixed[conn][2050]}
        flt = {2024: fl24, 2035: fl24 * dea.r_float[conn][2035], 2050: fl24 * dea.r_float[conn][2050]}
        # D-146 floor: never below 1.5 x the cell's onshore capex, year by year (T082: not where a
        # national regulator's value is used)
        if bmethod != 'national':
            floor = {y: OFFSHORE_FLOOR_X_ONSHORE * on[y] for y in YEARS}
            if any(fixed[y] < floor[y] for y in YEARS):
                flags.append('offshore_floor_1.5x_onshore')
            fixed = {y: max(fixed[y], floor[y]) for y in YEARS}
            flt = {y: max(flt[y], floor[y]) for y in YEARS}
        else:
            flags.append('national_capex')
        # T082: generator / export split with the DEA cost function at the cell's site (export system =
        # substation + export cable x distance; the share is held over the years, DEA gives no split by year)
        s_fix = dea._grid(D, conn) / dea.c_fixed(d_fix, D, conn)
        s_flt = dea._grid(D, conn) / dea.c_float(D, conn)
        lat, lon = cell_ll[lid]
        tso = (cell_iso[lid] in TSO_EXPORT_ISO and EUROPE_BOX[0] <= lat <= EUROPE_BOX[1]
               and EUROPE_BOX[2] <= lon <= EUROPE_BOX[3])
        r_fix = crf(float(h['offshore_2025']) / 100, TSO_EXPORT_LIFE) / crf(float(h['offshore_2025']) / 100, WIND_OFF_LIFE) if tso else 1.0
        r_flt = crf(float(h['floating_2025']) / 100, TSO_EXPORT_LIFE) / crf(float(h['floating_2025']) / 100, WIND_OFF_LIFE) if tso else 1.0
        if tso:
            flags.append('tso_export_40y')
        fixed_gen = {y: fixed[y] * (1 - s_fix) for y in YEARS}
        fixed_exp = {y: fixed[y] * s_fix for y in YEARS}
        flt_gen = {y: flt[y] * (1 - s_flt) for y in YEARS}
        flt_exp = {y: flt[y] * s_flt for y in YEARS}
        fixed = {y: fixed_gen[y] + fixed_exp[y] * r_fix for y in YEARS}
        flt = {y: flt_gen[y] + flt_exp[y] * r_flt for y in YEARS}
        v.update(fixed=fixed, flt=flt, off=flt if cls.startswith('floating') else fixed, cls=cls,
                 depth=depth, dist=dist, flags=flags, tso=tso, fixed_gen=fixed_gen, fixed_exp=fixed_exp,
                 flt_gen=flt_gen, flt_exp=flt_exp)
        v['wind_off_src'] = (f'{bsrc}; SRC-DEA-TC-2026 t7 {site_tag}; export share {s_fix:.3f}'
                             f'{f"; TSO export 40y x{r_fix:.4f}" if tso else ""}; {imethod}')
        # O&M
        om_on, k_on = om_lookup('A3', iso)
        om_off, k_off = om_lookup('A5', iso)
        v['om_on'] = {y: om_on * dea.om_on[y] for y in YEARS}
        v['om_fixed'] = {y: om_off * dea.om_fixed[y] for y in YEARS}
        v['om_float'] = {y: om_off * dea.om_float[y] for y in YEARS}
        v['om_off'] = v['om_float'] if cls.startswith('floating') else v['om_fixed']
        v['wind_om_src'] = f'SRC-IRENA-RPGC-2025 A3 {k_on}/A5 {k_off}; SRC-DEA-TC-2026 ratios'
        key_short = iso if imethod == 'country' else imethod
        nat_id = f' {bsrc.split(" ", 1)[0]}' if bmethod == 'national' else ''
        v['wind_cost_src'] = (f'SRC-IRENA-RPGC-2025 SRC-DEA-TC-2026{nat_id}{site_ids} | on {on_short} x{ser} | '
                              f'off {bsrc.split(" ", 1)[1].replace(" ", ":")} site:{grp} | om A3:{k_on} A5:{k_off} | key {key_short}')
        # WACC
        v['wacc'] = {
            'on': {y: float(h[f'onshore_{yy}']) for y, yy in ((2024, 2024), (2025, 2025), (2035, 2035), (2050, 2036))},
            'fixed': {y: float(h[f'offshore_{yy}']) for y, yy in ((2024, 2024), (2025, 2025), (2035, 2035), (2050, 2036))},
            'float': {y: float(h[f'floating_{yy}']) for y, yy in ((2024, 2024), (2025, 2025), (2035, 2035), (2050, 2036))},
            'solar': float(h['solar_2025']),
        }
        v['wacc_iso3'], v['wacc_country'], v['wacc_method'], v['wacc_dist'] = w_iso, h['country'], w_method, w_dist
        v['wacc_how'] = f'donor({w_how})' if w_how else ''
        res[lid] = v

    # ---- write voronoi_local_capex.csv
    path = DATA / 'voronoi_local_capex.csv'
    rows = read_csv(path)
    base_cols = [k for k in rows[0].keys() if not k.startswith('wind_')]
    wind_cols = ['wind_on_2024', 'wind_on_2035', 'wind_on_2050', 'wind_off_2024', 'wind_off_2035', 'wind_off_2050']
    new_cols = (['wind_iso3', 'wind_off_class', 'wind_off_depth_m', 'wind_off_shore_km', 'wind_off_flags']
                + [f'wind_off_fixed_{y}' for y in YEARS] + [f'wind_off_float_{y}' for y in YEARS]
                + [f'wind_on_om_{y}' for y in YEARS] + [f'wind_off_om_{y}' for y in YEARS]
                + [f'wind_off_fixed_om_{y}' for y in YEARS] + [f'wind_off_float_om_{y}' for y in YEARS] + ['wind_cost_src']
                # T082: generator and export system (raw capex, before the TSO 40-year adjustment)
                + ['wind_off_tso'] + [f'wind_off_{k}_{part}_{y}' for k in ('fixed', 'float') for part in ('gen', 'export')
                                      for y in YEARS])
    if len(rows) != len(cells):
        raise SystemExit('cell count mismatch in voronoi_local_capex.csv')
    for r in rows:
        v = res[int(r['location_id'])]
        for y in YEARS:
            r[f'wind_on_{y}'] = fmt(v['on'][y], 1)
            r[f'wind_off_{y}'] = fmt(v['off'][y], 1)
            r[f'wind_off_fixed_{y}'] = fmt(v['fixed'][y], 1)
            r[f'wind_off_float_{y}'] = fmt(v['flt'][y], 1)
            r[f'wind_on_om_{y}'] = fmt(v['om_on'][y], 2)
            r[f'wind_off_om_{y}'] = fmt(v['om_off'][y], 2)
            r[f'wind_off_fixed_om_{y}'] = fmt(v['om_fixed'][y], 2)
            r[f'wind_off_float_om_{y}'] = fmt(v['om_float'][y], 2)
            for k, kk in (('fixed', 'fixed'), ('float', 'flt')):
                r[f'wind_off_{k}_gen_{y}'] = fmt(v[f'{kk}_gen'][y], 1)
                r[f'wind_off_{k}_export_{y}'] = fmt(v[f'{kk}_exp'][y], 1)
        for k in [k for k in r if k.startswith('wind_') and k not in wind_cols + new_cols]:
            del r[k]
        r.update({'wind_iso3': v['wind_iso3'], 'wind_off_class': v['cls'],
                  'wind_off_depth_m': fmt(v['depth'], 1), 'wind_off_shore_km': fmt(v['dist'], 1),
                  'wind_off_flags': '|'.join(v['flags']), 'wind_cost_src': v['wind_cost_src'],
                  'wind_off_tso': '1' if v['tso'] else '0'})
    write_csv(path, base_cols + wind_cols + new_cols, rows)
    # full per-cell provenance (not served by the app)
    write_csv(OUT / 'wind_cost_provenance.csv', ['location_id', 'wind_on_src', 'wind_off_src', 'wind_om_src', 'wacc_src'],
              [{'location_id': lid, 'wind_on_src': v['wind_on_src'], 'wind_off_src': v['wind_off_src'],
                'wind_om_src': v['wind_om_src'],
                'wacc_src': f'SRC-HATTON-V3-2026 2015-2024 estimates, 2025-2036 forecasts; {v["wacc_method"]}:{v["wacc_iso3"]}{v["wacc_how"]}'}
               for lid, v in sorted(res.items())])

    # ---- write voronoi_wacc_wind.csv
    path = DATA / 'voronoi_wacc_wind.csv'
    rows = read_csv(path)
    cols = WACC_WIND_COLS[:]
    extra = ['wind_off_class', 'wind_off_fixed_wacc_percent', 'wind_off_float_wacc_percent'] + \
            [f'{k}_wacc_{y}' for k in ('wind_on', 'wind_off_fixed', 'wind_off_float') for y in YEARS]
    cols += [c for c in extra if c not in cols]
    for r in rows:
        lid = int(r['location_id'])
        v = res[lid]
        w = v['wacc']
        off_key = 'float' if v['cls'].startswith('floating') else 'fixed'
        r.update({
            'country_iso3': cell_iso[lid], 'country_name': cmap[cell_iso[lid]]['name'],
            'wacc_iso3': v['wacc_iso3'], 'wacc_country': v['wacc_country'],
            'solar_wacc_percent': fmt(w['solar'], 2), 'wacc_year': '2025',
            'source': v['wacc_method'], 'distance_km': fmt(v['wacc_dist'], 1),
            'wind_on_wacc_percent': fmt(w['on'][2025], 2), 'wind_off_wacc_percent': fmt(w[off_key][2025], 2),
            'wind_wacc_source': f'SRC-HATTON-V3-2026 2025 on=Onshore Wind off={"Floating Offshore" if off_key == "float" else "Offshore Wind"} real; {v["wacc_method"]}:{v["wacc_iso3"]}{v["wacc_how"]}',
            'wind_off_class': v['cls'],
            'wind_off_fixed_wacc_percent': fmt(w['fixed'][2025], 2), 'wind_off_float_wacc_percent': fmt(w['float'][2025], 2),
        })
        for k, kk in (('wind_on', 'on'), ('wind_off_fixed', 'fixed'), ('wind_off_float', 'float')):
            for y in YEARS:
                r[f'{k}_wacc_{y}'] = fmt(w[kk][y], 2)
    write_csv(path, cols, rows)

    # ---- write voronoi_wacc.csv (solar, D-055)
    path = DATA / 'voronoi_wacc.csv'
    rows = read_csv(path)
    cols = WACC_COLS + ['wacc_source']
    for r in rows:
        lid = int(r['location_id'])
        v = res[lid]
        r.update({'country_iso3': cell_iso[lid], 'country_name': cmap[cell_iso[lid]]['name'],
                  'wacc_iso3': v['wacc_iso3'], 'wacc_country': v['wacc_country'],
                  'wacc_percent': fmt(v['wacc']['solar'], 2), 'wacc_year': '2025',
                  'source': v['wacc_method'], 'distance_km': fmt(v['wacc_dist'], 1),
                  'wacc_source': f'SRC-HATTON-V3-2026 2025 Solar PV; real (D-054); {v["wacc_method"]}:{v["wacc_iso3"]}{v["wacc_how"]}'})
    write_csv(path, cols, rows)

    # ---- country history table (D-057 Q10)
    hrows = []
    for tech, src, name, key, vals, st in hist_rows:
        hr = {'technology': tech, 'source': src, 'series': name, 'key': key,
              'first_year': st['first_year'], 'last_year': st['latest_year'], 'n_years': st['n_years']}
        for y in range(2010, 2026):
            hr[str(y)] = fmt(vals.get(y), 1)
        hr.update({'anchor_years': ' '.join(map(str, st['window'])), 'anchor_usd_kw': fmt(st['anchor'], 1),
                   'latest_usd_kw': fmt(st['latest'], 1), 'anchor_over_latest': fmt(st['anchor'] / st['latest'], 3),
                   'trend_pct_per_yr_2015_2025': fmt(None if st['trend'] is None else 100 * st['trend'], 1),
                   'yoy_log_sd_2016_2025': fmt(st['yoy_sd'], 3), 'max_abs_log_yoy_in_window': fmt(st['max_abs_yoy_window'], 3),
                   'flags': '|'.join(st['flags'])})
        hrows.append(hr)
    write_csv(OUT / 'country_anchor_history.csv', list(hrows[0].keys()), hrows)

    # ---- summary by country
    by = defaultdict(list)
    for lid, v in res.items():
        by[cell_iso[lid]].append((lid, v))
    srows = []
    for iso in sorted(by):
        lst = by[iso]
        v0 = lst[0][1]
        offv = [v for lid, v in lst if viable.get(lid) and v['cls'] != 'none']
        cls = Counter(v['cls'] for v in offv)
        srows.append({
            'iso3': iso, 'name': cmap[iso]['name'], 'cells': len(lst), 'wind_iso3': v0['wind_iso3'],
            'on_2024': fmt(v0['on'][2024], 0), 'on_2035': fmt(v0['on'][2035], 0), 'on_2050': fmt(v0['on'][2050], 0),
            'off_viable_cells': len(offv),
            'off_2024_median_viable': fmt(statistics.median(v['off'][2024] for v in offv), 0) if offv else '',
            'off_2035_median_viable': fmt(statistics.median(v['off'][2035] for v in offv), 0) if offv else '',
            'off_2050_median_viable': fmt(statistics.median(v['off'][2050] for v in offv), 0) if offv else '',
            'off_classes_viable': ' '.join(f'{k}:{n}' for k, n in sorted(cls.items())),
            'on_om_2024': fmt(v0['om_on'][2024], 1), 'off_fixed_om_2024': fmt(v0['om_fixed'][2024], 1),
            'wacc_on': fmt(v0['wacc']['on'][2025], 2), 'wacc_off_fixed': fmt(v0['wacc']['fixed'][2025], 2),
            'wacc_off_float': fmt(v0['wacc']['float'][2025], 2), 'wacc_solar': fmt(v0['wacc']['solar'], 2),
            'wacc_key': f'{v0["wacc_method"]}:{v0["wacc_iso3"]}',
        })
    write_csv(OUT / 'summary_by_country.csv', list(srows[0].keys()), srows)

    n_cls = Counter(v['cls'] for v in res.values())
    print(f'cells {len(res)}; offshore classes {dict(sorted(n_cls.items()))}')
    print(f'floating split {a.floating_depth_m:g} m; anchors = mean of last {a.anchor_years} years')
    print('DEA ratios: fixed', {k: {y: round(r, 4) for y, r in v.items()} for k, v in dea.r_fixed.items()},
          'floating', {k: {y: round(r, 4) for y, r in v.items()} for k, v in dea.r_float.items()})


if __name__ == '__main__':
    main()
