#!/usr/bin/env python3
"""T067 (T065-01, -02, -12): fix the solar and battery capex mapping in voronoi_local_capex.csv.

The original mapping (workspace scripts/pipeline/voronoi_local_capex.py, not in this repo) joined
cells to Natural Earth 1:110m admin-0 on ISO_A3, which is -99 for France and Norway, and took the
cell's country from voronoi_wacc.csv, which is blank for 15 Canadian, 6 Russian, 5 Somaliland and
other cells. Those cells, and all of Oceania (the regional table has no Oceania row), fell to the
"Global average" row. Gulf states and Taiwan fell into "Emerging Asia".

This script rewrites only the rows it changes (every other line keeps its bytes) and only the
columns country_iso3, country_name, region, region_method, capex_source, solar_*, battery_*:

  * country: blank ISO3 -> the cell's country in voronoi_overlapping_countries.csv (the file with a
    country for every cell); Somaliland (SOL) maps like Somalia (Africa).
  * blank-country cells take the region most of that country's other cells already have
    (Croatia, Italy -> Europe; Russia -> Eurasia; Chile -> Other South America; Indonesia,
    Philippines -> Emerging Asia; Japan -> Japan; USA -> United States). Where no other cell of the
    country is mapped (France, Norway, Fr. S. Antarctic Lands), the original rule is applied with
    Natural Earth 1:10m admin-0 joined on ADM0_A3 (not ISO_A3, which is -99 for France and Norway):
    continent Europe -> Europe. (--admin0, the shapefile T061 downloaded; public domain.)
  * Oceania (Natural Earth continent Oceania): new "Oceania" row (inputs/solar_battery_capex_added_t067.csv).
  * Canada: all cells on the United States proxy (north_america_proxy), as 344 of 359 already were.
  * Saudi Arabia: new "Saudi Arabia" row from IRENA's country figure; UAE, Qatar, Kuwait, Oman,
    Bahrain (GCC) take it as a proxy (gcc_proxy): IRENA lists no other Gulf country, and their
    utility-scale PV is procured under the same desert, large-tender conditions.
  * Taiwan: the Korea row (high_income_asia_proxy), the nearest high-income East Asian market in the
    table, instead of Emerging Asia.

  python3 scripts/wind_costs/fix_local_capex.py   (then build_wind_costs.py, which keeps these columns)
"""
import csv
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DATA = ROOT / 'deployment' / 'data'
INP = HERE / 'inputs'
OUT = HERE / 'out'

OCEANIA = {'ASM', 'ATC', 'AUS', 'COK', 'CSI', 'FJI', 'FSM', 'GUM', 'KIR', 'MHL', 'MNP', 'NCL', 'NFK', 'NIU',
           'NRU', 'NZL', 'PCN', 'PLW', 'PNG', 'PYF', 'SLB', 'TON', 'TUV', 'VUT', 'WLF', 'WSM'}
US_TERRITORIES = {'USA', 'PRI', 'UMI', 'GUM', 'ASM', 'VIR', 'MNP'}   # kept on the US row (original rule)
GCC_PROXY = {'ARE', 'QAT', 'KWT', 'OMN', 'BHR'}
COLS = ['solar_2024', 'solar_2035', 'solar_2050', 'battery_2024', 'battery_2035', 'battery_2050']


def read(p):
    with open(p, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def region_table():
    t = {}
    for r in read(INP / 'solar_battery_capex_regions.csv'):
        t[r['Country / Region'].strip()] = [float(r[k].replace(',', '')) for k in (
            'Solar 2024 (USD/kW)', 'Solar 2035', 'Solar 2050', 'Battery 2024 (USD/kWh)', 'Battery 2035', 'Battery 2050')]
    for r in read(INP / 'solar_battery_capex_added_t067.csv'):
        t[r['region']] = [float(r[k]) for k in COLS]
    return t


def continent_region(iso, admin0):
    """The original map_region rule for the cases it needs here (continent Europe -> Europe)."""
    import geopandas as gpd
    a = gpd.read_file(admin0, ignore_geometry=True)
    row = a[a['ADM0_A3'] == iso]
    if row.empty:
        return None
    cont = row.iloc[0]['CONTINENT']
    return {'Europe': 'Europe', 'Africa': 'Africa'}.get(cont)


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--admin0', default=str(Path.home() / 'wind-atlas-T061/downloads/naturalearth/'
                    'ne_10m_admin_0_countries/ne_10m_admin_0_countries.shp'))
    a = ap.parse_args()
    table = region_table()
    path = DATA / 'voronoi_local_capex.csv'
    with open(path, newline='', encoding='utf-8') as f:
        lines = f.read().split('\n')
    header = lines[0].split(',')
    rows = read(path)
    oc = {r['location_id']: r for r in read(DATA / 'voronoi_overlapping_countries.csv')}
    # majority region per country among cells that already have a country
    maj = {}
    by = {}
    for r in rows:
        if r['country_iso3']:
            by.setdefault(r['country_iso3'], Counter())[r['region']] += 1
    for iso, c in by.items():
        maj[iso] = c.most_common(1)[0][0]
    maj['SOL'] = maj['SOM']

    changes = []
    for i, r in enumerate(rows):
        old = {k: r[k] for k in ('country_iso3', 'country_name', 'region', 'region_method', 'capex_source', *COLS)}
        iso = r['country_iso3'] or oc[r['location_id']]['country_iso3']
        name = r['country_name'] or oc[r['location_id']]['country_name']
        region, method = r['region'], r['region_method']
        if not r['country_iso3']:
            if iso in maj:
                region, method = maj[iso], 'overlapping_iso3'
            else:
                cr = continent_region(iso, a.admin0)
                if cr:
                    region, method = cr, 'continent_adm0_a3'
        if iso in OCEANIA and iso not in US_TERRITORIES:
            region, method = 'Oceania', 'oceania_irena'
        elif iso == 'CAN':
            region, method = 'United States', 'north_america_proxy'
        elif iso == 'SAU':
            region, method = 'Saudi Arabia', 'country'
        elif iso in GCC_PROXY:
            region, method = 'Saudi Arabia', 'gcc_proxy'
        elif iso == 'TWN':
            region, method = 'Korea (Rep. of Korea)', 'high_income_asia_proxy'
        new = {'country_iso3': iso, 'country_name': name, 'region': region, 'region_method': method,
               'capex_source': 'global_average' if region == 'Global average' else 'region'}
        new.update({k: f'{v}' for k, v in zip(COLS, table[region])})
        # keep the original number text where the value is unchanged
        for k in COLS:
            if float(old[k]) == float(new[k]):
                new[k] = old[k]
        if new != old:
            r.update(new)
            vals = [r[h] for h in header]
            buf = []
            w = csv.writer(_L(buf), lineterminator='')
            w.writerow(vals)
            lines[i + 1] = buf[0]
            changes.append({'location_id': r['location_id'], 'country_iso3': iso,
                            **{f'old_{k}': old[k] for k in ('region', 'region_method', 'solar_2024', 'battery_2024')},
                            **{f'new_{k}': new[k] for k in ('region', 'region_method', 'solar_2024', 'battery_2024')}})
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write('\n'.join(lines))
    OUT.mkdir(exist_ok=True)
    with open(OUT / 'local_capex_mapping_t067.csv', 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(changes[0].keys()), lineterminator='\n')
        w.writeheader()
        w.writerows(changes)
    c = Counter((x['country_iso3'], x['old_region'], x['new_region']) for x in changes)
    print(f'{len(changes)} rows changed')
    for (iso, a, b), n in sorted(c.items()):
        print(f'  {iso:4s} {n:4d}  {a} -> {b}')
    left = [r['location_id'] for r in rows if r['region'] == 'Global average']
    print(f'cells still on Global average: {len(left)} {sorted({oc[x]["country_iso3"] for x in left})}')


class _L:
    def __init__(self, buf):
        self.buf = buf

    def write(self, s):
        self.buf.append(s)


if __name__ == '__main__':
    main()
