#!/usr/bin/env python3
"""Cross-checks for the wind cost dataset (prints and writes out/crosscheck_*.csv; changes no dataset value).

1. Offshore site gradient: DEA table 7 function (used) against NREL ATB 2025 fixed-bottom classes
   (SRC-NREL-ATB-2025, depth/distance per class and Moderate CAPEX), as relative cost to class 2.
2. Floating premium and learning path: DEA (used) against ATB floating class 8 / fixed class 2.
3. LCOE sanity: simple LCOE per country at the cells' final CF (on_final_cf, off_final_cf), against IRENA 2025 weighted-average
   LCOE (SRC-IRENA-RPGC-2025 table 2.3 onshore by region, fig 4.10 offshore by country).

Run after build_wind_costs.py. Needs openpyxl (for the ATB workbook).
"""
import csv
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
from build_wind_costs import Dea, read_csv, write_csv, INP, OUT, DATA, ROOT  # noqa: E402

ATB = ROOT / 'team/evidence/raw/nrel-atb-2025/ATB_2025_v1_Workbook_08-27-2026.xlsx'


def atb_capex():
    import openpyxl
    wb = openpyxl.load_workbook(ATB, read_only=True, data_only=True)
    out = {}
    for sheet in ('Fixed-Bottom Offshore Wind', 'Floating Offshore Wind'):
        rows = list(wb[sheet].iter_rows(values_only=True))
        site = {}
        for r in rows[11:19]:
            if len(r) > 17 and isinstance(r[10], str) and r[10].startswith('Offshore Wind - Class'):
                site[r[10]] = (r[16], r[17])        # average water depth (m), average distance site to cable landing (km)
        metric, yrs = None, None
        for r in rows:
            if len(r) < 14:
                continue
            if isinstance(r[9], str):
                metric = r[9]
            ints = [v for v in r[13:] if isinstance(v, int)]
            if len(ints) > 20 and all(2000 < v < 2100 for v in ints[:5]):
                yrs = list(r[13:])
            if metric and metric.startswith('CAPEX') and r[12] == 'Moderate' and r[10] in site:
                out[r[10]] = (site[r[10]], {y: v for y, v in zip(yrs, r[13:]) if isinstance(y, int) and v is not None})
    return out


def main():
    dea = Dea(read_csv(INP / 'dea_offshore.csv'))
    p = dea.p
    atb = atb_capex()
    # 1. gradient
    rows = []
    (d2, D2), c2 = atb['Offshore Wind - Class 2']
    for k in sorted(atb, key=lambda s: int(s.split()[-1])):
        (d, D), caps = atb[k]
        if int(k.split()[-1]) > 7:
            continue
        conn = 'dc' if D > 100 else 'ac'
        rows.append({'atb_class': k, 'depth_m': f'{d:.1f}', 'dist_km': f'{D:.1f}',
                     'atb_rel_2025': f'{caps[2025] / c2[2025]:.3f}',
                     'dea_rel_2025': f'{dea.c_fixed(d, D, conn) / dea.c_fixed(d2, D2, "ac"):.3f}'})
    write_csv(OUT / 'crosscheck_atb_gradient.csv', list(rows[0].keys()), rows)
    print('Fixed-bottom site gradient, relative to ATB class 2 (2025 CAPEX):')
    for r in rows:
        print(f"  {r['atb_class']:<26} {r['depth_m']:>6} m {r['dist_km']:>6} km  ATB {r['atb_rel_2025']}  DEA {r['dea_rel_2025']}")
    # 2. floating premium and learning
    (d8, D8), c8 = atb['Offshore Wind - Class 8']
    k = p['eur2023_per_eur2020']
    dea_fix = {2025: dea.c_fixed(d2, D2, 'ac') / k}
    dea_fix[2030] = dea_fix[2025] * p['sheet_fixed_ac_2030'] / p['sheet_fixed_ac_2025']
    dea_fix[2035] = dea_fix[2025] * dea.r_fixed['ac'][2035]
    dea_fix[2050] = dea_fix[2025] * dea.r_fixed['ac'][2050]
    dea_flt = {2025: dea.c_float(D8, 'ac') / k}
    dea_flt[2030] = dea_flt[2025] * p['sheet_float_ac_2030'] / (dea.c_float(p['sheet_float_ac_ref_km'], 'ac') / k)
    dea_flt[2035] = dea_flt[2025] * dea.r_float['ac'][2035]
    dea_flt[2050] = dea_flt[2025] * dea.r_float['ac'][2050]
    prem = []
    for y in (2025, 2030, 2035, 2050):
        prem.append({'year': y,
                     'atb_float8_over_fixed2': f'{c8[y] / c2[y]:.3f}' if y in c8 else '',
                     'dea_float_over_fixed_same_sites': f'{dea_flt[y] / dea_fix[y]:.3f}',
                     'atb_fixed2_over_2025': f'{c2[y] / c2[2025]:.3f}', 'dea_fixed_ac_over_2025': f'{dea_fix[y] / dea_fix[2025]:.3f}'})
    write_csv(OUT / 'crosscheck_atb_floating.csv', list(prem[0].keys()), prem)
    print('Floating premium and fixed-bottom learning path (ATB class 8 vs 2; DEA at the same two sites):')
    for r in prem:
        print('  ', r)
    # 3. LCOE sanity
    ref = {(r['technology'], r['series']): r for r in read_csv(INP / 'irena_lcoe_reference.csv')}
    cap = {r['location_id']: r for r in read_csv(DATA / 'voronoi_local_capex.csv')}
    wacc = {r['location_id']: r for r in read_csv(DATA / 'voronoi_wacc_wind.csv')}
    res = {r['location_id']: r for r in read_csv(DATA / 'voronoi_wind_resource.csv') if r['location_id'] in cap}

    def lcoe(capex, om, w, cf, life=25):
        crf = w / (1 - (1 + w) ** -life)
        return (capex * crf + om) * 1000 / (cf * 8760)

    on_series = {'CHN': 'China', 'IND': 'India', 'USA': 'United States', 'BRA': 'Brazil'}
    off_series = {'CHN': 'China', 'KOR': 'Republic of Korea', 'GBR': 'United Kingdom', 'DEU': 'Germany',
                  'FRA': 'France', 'USA': 'United States'}
    by = defaultdict(lambda: {'on': [], 'off': [], 'off_fixed': []})
    for lid, c in cap.items():
        r, w = res[lid], wacc[lid]
        iso = c['wind_iso3']
        if r['on_viable'] == '1':
            by[iso]['on'].append(lcoe(float(c['wind_on_2024']), float(c['wind_on_om_2024']),
                                      float(w['wind_on_wacc_percent']) / 100, float(r['on_final_cf'])))
        if r['off_viable'] == '1' and c['wind_off_class'] != 'none':
            by[iso]['off'].append(lcoe(float(c['wind_off_2024']), float(c['wind_off_om_2024']),
                                       float(w['wind_off_wacc_percent']) / 100, float(r['off_final_cf'])))
            by[iso]['off_fixed'].append(lcoe(float(c['wind_off_fixed_2024']), float(c['wind_off_fixed_om_2024']),
                                             float(w['wind_off_fixed_wacc_percent']) / 100, float(r['off_final_cf'])))
    out = []
    for iso in ('CHN', 'IND', 'USA', 'BRA', 'DEU', 'GBR', 'FRA', 'ESP', 'JPN', 'KOR', 'AUS', 'ZAF', 'MEX', 'TUR', 'VNM', 'CAN', 'RUS', 'SAU', 'EGY'):
        v = by.get(iso)
        if not v:
            continue
        row = {'iso3': iso,
               'on_lcoe_median': f"{statistics.median(v['on']):.0f}" if v['on'] else '',
               'off_lcoe_median_by_class': f"{statistics.median(v['off']):.0f}" if v['off'] else '',
               'off_lcoe_median_fixed': f"{statistics.median(v['off_fixed']):.0f}" if v['off_fixed'] else ''}
        s_on = on_series.get(iso)
        if not s_on:
            # IRENA table 2.3 region via the country map
            reg = {r['data_iso3']: r['irena_annex_region'] for r in read_csv(INP / 'country_map.csv')}[iso]
            s_on = {'Europe': 'Europe', 'Eurasia': 'Eurasia', 'Africa': 'Africa', 'Oceania': 'Oceania',
                    'Middle East': 'Other Asia', 'Asia': 'Other Asia', 'North America': 'Other North America',
                    'South America': 'Other South America'}[reg]
        o = ref[('onshore', s_on)]
        row['irena_on_ref'] = f"{s_on}: {o['lcoe_2025']} ({o['p5']}-{o['p95']})"
        if iso in off_series:
            row['irena_off_ref'] = f"{off_series[iso]}: {float(ref[('offshore', off_series[iso])]['lcoe_2025']):.0f}"
        else:
            row['irena_off_ref'] = ''
        out.append(row)
    write_csv(OUT / 'crosscheck_lcoe.csv', list(out[0].keys()), out)
    print('LCOE sanity ($/MWh, 2024 anchor, median over viable cells, cell on_final_cf/off_final_cf, 25 yr, no degradation):')
    for r in out:
        print('  ', r)


if __name__ == '__main__':
    main()
