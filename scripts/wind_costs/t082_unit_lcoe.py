#!/usr/bin/env python3
"""T082 before/after: standalone offshore wind LCOE (1 GW alone, no battery) per region, Local mode
(local capex, local WACC), cost year 2026 (the files' first column, T067), 30-year wind life (D-146).

Formula as the app (precomputeLcoePerLocation / computeLcoeMetricsFast) and t067/unit_lcoe.py:
  LCOE = (capex x CRF(w, 30) + O&M) x 1000 / (CF x 8,760 x degradation multiplier(0.2%/yr))
CF: the region's ten-year mean net offshore CF (off_final_cf in voronoi_wind_resource.csv); for the
zone regions the new ten-year mean of the zone profiles (offshore_zones.py profiles). Generator-only
LCOE: the same with the generator capex alone (export system left out), as tenders price it where
the grid operator builds the export link.

  python3 scripts/wind_costs/t082_unit_lcoe.py --before <old capex csv> --zones <zone_resource_rows.csv> --out <csv>
"""
import argparse
import csv
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'deployment' / 'data'
LIFE = 30
DEG = 0.002


def crf(r, n):
    return r * (1 + r) ** n / ((1 + r) ** n - 1)


def lgm(g, r, n):
    ratio = (1 + g) / (1 + r)
    pv = (1 / (1 + g)) * ratio * (1 - ratio ** n) / (1 - ratio)
    return pv * crf(r, n)


def lcoe(capex, om, w, cf):
    return (capex * crf(w, LIFE) + om) * 1000 / (cf * 8760 * lgm(-DEG, w, LIFE))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--before', type=Path, required=True)
    ap.add_argument('--zones', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    a = ap.parse_args()
    rd = lambda p: {r['location_id']: r for r in csv.DictReader(open(p, newline='', encoding='utf-8'))}
    old, new = rd(a.before), rd(DATA / 'voronoi_local_capex.csv')
    res, ww = rd(DATA / 'voronoi_wind_resource.csv'), rd(DATA / 'voronoi_wacc_wind.csv')
    ctry = {k: v['country_iso3'] for k, v in rd(DATA / 'voronoi_overlapping_countries.csv').items()}
    zones = rd(a.zones)
    rows = []
    for lid, n in new.items():
        r = res.get(lid)
        if not r or r['off_viable'] != '1' or not float(r['off_final_cf'] or 0) > 0 or n['wind_off_class'] == 'none':
            continue
        o = old[lid]
        w = float(ww[lid]['wind_off_fixed_wacc_percent']) / 100
        om = float(n['wind_off_fixed_om_2024'])
        cf_old = float(r['off_final_cf'])
        z = zones.get(lid)
        cf_new = float(z['profile_ten_year_mean']) if z else cf_old
        gen = float(n['wind_off_fixed_gen_2024'])
        rows.append({
            'location_id': lid, 'country_iso3': ctry[lid], 'zone': int(bool(z)), 'tso': n['wind_off_tso'],
            'class_old': o['wind_off_class'], 'class_new': n['wind_off_class'],
            'depth_old': o['wind_off_depth_m'], 'depth_new': n['wind_off_depth_m'],
            'shore_km_old': o['wind_off_shore_km'], 'shore_km_new': n['wind_off_shore_km'],
            'capex_old': float(o['wind_off_fixed_2024']), 'capex_new': float(n['wind_off_fixed_2024']),
            'capex_raw_new': gen + float(n['wind_off_fixed_export_2024']), 'gen_capex_new': gen,
            'export_share': float(n['wind_off_fixed_export_2024']) / (gen + float(n['wind_off_fixed_export_2024'])),
            'cf_old': cf_old, 'cf_new': cf_new, 'wacc': w, 'om': om,
            'lcoe_old': lcoe(float(o['wind_off_fixed_2024']), om, w, cf_old),
            'lcoe_new': lcoe(float(n['wind_off_fixed_2024']), om, w, cf_new),
            'lcoe_gen_new': lcoe(gen, om, w, cf_new),
        })
    keys = list(rows[0].keys())
    with open(a.out, 'w', newline='') as f:
        wr = csv.DictWriter(f, keys, lineterminator='\n')
        wr.writeheader()
        for r in rows:
            wr.writerow({k: (f'{v:.4f}' if isinstance(v, float) else v) for k, v in r.items()})
    by = defaultdict(list)
    for r in rows:
        by[r['country_iso3']].append(r)
    print('country cells zone  capex old->new (median)   CF old->new   LCOE old->new   generator-only')
    for iso in ('JPN', 'TWN', 'NLD', 'DEU', 'DNK', 'BEL', 'GBR', 'FRA', 'KOR', 'USA', 'CHN'):
        lst = by.get(iso, [])
        if not lst:
            continue
        m = lambda k: statistics.median(r[k] for r in lst)
        print(f'{iso} {len(lst):5d} {sum(r["zone"] for r in lst):4d}  {m("capex_old"):6.0f} -> {m("capex_new"):6.0f}'
              f'   {m("cf_old"):.3f} -> {m("cf_new"):.3f}   {m("lcoe_old"):6.1f} -> {m("lcoe_new"):6.1f}   {m("lcoe_gen_new"):6.1f}')
    print(f'wrote {len(rows)} regions to {a.out}')


if __name__ == '__main__':
    main()
