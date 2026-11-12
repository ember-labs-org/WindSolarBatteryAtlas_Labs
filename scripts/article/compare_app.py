"""Use the app's own draws recorded by drive_app.mjs (out/app/*.csv).

1. Cross-check: engine.py against the app at target 95% (2026) and at 80% in
   2035, field by field (build, LCOE, target met, no-wind LCOE, saving). Exact
   float equality is expected (the CSV holds JS's round-trip number strings).
2. Sensitivity: the takes' headline shares and medians under Local capex and
   Local WACC (the app's alternative cost mode), against app defaults.
   Writes out/local_sensitivity.csv.

Exit 1 if a cross-check row differs.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import engine  # noqa: E402
from analyse import cell_table, classify, wmedian, share, r, band_label, both_reach  # noqa: E402

APP = HERE / 'out' / 'app'


def load(name):
    d = pd.read_csv(APP / f'{name}.csv')
    return d.sort_values('location_id').reset_index(drop=True)


def as_res(d):
    return dict(ids=d.location_id.to_numpy(), meets=d.meetsTarget.to_numpy() == 1,
                wind_gw=d.wind_gw.to_numpy(), nowind_meets=d.noWindMeetsTarget.to_numpy() == 1,
                lcoe=d.lcoe.to_numpy(float), nowind_lcoe=d.noWindLcoe.to_numpy(float),
                saving=d.windSaving.to_numpy(float), wind_share=d.windShare.to_numpy(float))


def crosscheck(m, name, target, year):
    d = load(name)
    lcoe, cf = engine.lcoe_matrix(m, year=year)
    e = engine.search(m, lcoe, cf, target / 100)
    idx = pd.Index(e['ids']).get_indexer(d.location_id)
    bad = []
    checks = [('solar_gw', e['solar_gw'][idx], d.solar_gw), ('wind_gw', e['wind_gw'][idx], d.wind_gw),
              ('batt_gwh', e['batt_gwh'][idx], d.batt_gwh), ('meets', e['meets'][idx], d.meetsTarget == 1),
              ('nowind_meets', e['nowind_meets'][idx], d.noWindMeetsTarget == 1),
              ('lcoe', e['lcoe'][idx], d.lcoe), ('nowind_lcoe', e['nowind_lcoe'][idx], d.noWindLcoe),
              ('saving', e['saving'][idx], d.windSaving)]
    for f, a, b in checks:
        a = np.asarray(a, float)
        b = np.asarray(b, float)
        diff = ~((a == b) | (np.isnan(a) & np.isnan(b)))
        if diff.any():
            bad.append(f'{f}: {int(diff.sum())} rows (max abs diff {np.nanmax(np.abs(a - b)):.3g})')
    surf_e = np.where(e['wind_gw'][idx] > 0, e['surface'][idx], 'on')
    surf_a = np.where(d.wind_gw > 0, d.wind_surface, 'on')
    if (surf_e != surf_a).any():
        bad.append(f'surface: {int((surf_e != surf_a).sum())} rows')
    ok = not bad and len(d) == len(e['ids'])
    print(f'{"PASS" if ok else "FAIL"} engine vs app {name}: {len(d)} rows' + ('' if ok else ' – ' + '; '.join(bad)))
    return ok


def scopes(lat):
    out = [('World', np.ones(len(lat), bool)), ('45°N and north', lat >= 45), ('50°N and north', lat >= 50)]
    for lo, hi in [(30, 45), (45, 55), (55, 65)]:
        out.append((band_label(lo, hi), (lat >= lo) & (lat < hi)))
    return out


def metrics(res, cells, scenario, target, year):
    rows = []
    lat = cells.lat.to_numpy()
    cls = classify(res)
    lc_w = np.where(res['meets'], res['lcoe'], np.inf)
    lc_nw = np.where(res['nowind_meets'], res['nowind_lcoe'], np.inf)
    for scope, sel in scopes(lat):
        for wname, col in [('people', 'pop'), ('demand', 'demand_twh')]:
            wall = cells[col].to_numpy()
            w = wall[sel]
            a, b, cut = both_reach(res, wall, sel)
            rows.append(dict(
                scenario=scenario, year=year, target_cf=target, scope=scope, weight=wname,
                share_wind_helps=r(share(((cls == 'wind_cheaper') | (cls == 'wind_only'))[sel], w)),
                share_wind_cheaper=r(share((cls == 'wind_cheaper')[sel], w)),
                share_wind_only=r(share((cls == 'wind_only')[sel], w)),
                median_lcoe_with_wind_both_reach=r(a, 2),
                median_lcoe_solar_battery_only_both_reach=r(b, 2),
                median_cut_both_reach=r(cut),
                share_met_solar_battery_only=r(share(res['nowind_meets'][sel], w)),
                share_met_with_wind=r(share(res['meets'][sel], w)),
                median_lcoe_with_wind=r(wmedian(lc_w[sel], w), 2),
                median_lcoe_solar_battery_only=r(wmedian(lc_nw[sel], w), 2),
            ))
    return rows


def main():
    m = engine.load_matrix()
    ok = crosscheck(m, 'global_t95_2026', 95, engine.BASE_YEAR)
    ok &= crosscheck(m, 'global_t80_2035', 80, 2035)

    cells = cell_table(m['ids']).set_index('location_id')
    rows = []
    for name, target, year in [('local_t80_2026', 80, 2026), ('local_t90_2026', 90, 2026), ('local_t90_2035', 90, 2035)]:
        d = load(name)
        c = cells.reindex(d.location_id).reset_index()
        rows += metrics(as_res(d), c, 'local capex + local WACC', target, year)
        lcoe, cf = engine.lcoe_matrix(m, year=year)
        e = engine.search(m, lcoe, cf, target / 100)
        ce = cells.reindex(e['ids']).reset_index()
        rows += metrics(e, ce, 'app defaults (global)', target, year)
    # T091: Capex Local + WACC Global (one 7% cost of capital everywhere), recorded by drive_app.mjs as lcgw_*
    for name, target, year in [('lcgw_t80_2026', 80, 2026), ('lcgw_t90_2026', 90, 2026), ('lcgw_t90_2035', 90, 2035)]:
        if not (APP / f'{name}.csv').exists():
            print(f'WARN no {name}.csv (run drive_app.mjs): scenario local capex + global WACC left out')
            continue
        d = load(name)
        c = cells.reindex(d.location_id).reset_index()
        rows += metrics(as_res(d), c, 'local capex + global WACC', target, year)
    out = pd.DataFrame(rows)
    out.to_csv(HERE / 'out' / 'local_sensitivity.csv', index=False)
    print(out[out.weight == 'people'].to_string(index=False))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
