"""Prove engine.py reproduces the app at defaults.

1. Every ported constant still appears verbatim in deployment/js (so a change in
   the app breaks this check instead of silently drifting).
2. The engine's answers at target 90% and 80%, and onshore-only at 80%, digest
   exactly as the app's own recorded draws in checks/oracle.json (keys lcoe_t90,
   lcoe_t80, lcoe_t80_onshore; digest format from checks/digest.mjs). Those keys
   were recorded at the base year = the calendar year (2026), global mode.

3. With the add-on (T058, D-127): the engine's answers at 90%, 80%, 99% and
   onshore-only 80% digest exactly as the independent add-on oracle
   (checks/addon_oracle.json.gz, oracle.py), extended digest of checks/digest.mjs.

Exit 0 only if every row of every key matches.
"""
import gzip
import json
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine  # noqa: E402

ROOT = engine.ROOT
APP = (ROOT / 'deployment/js/app.js').read_text()
CONSTS = (ROOT / 'deployment/js/constants.js').read_text()

NEEDLES = [
    (APP, "solarCapex: 720,"), (APP, "batteryCapex: 120,"), (APP, "solarOpexPct: 0.015,"),
    (APP, "batteryOpexPct: 0.02,"), (APP, "solarDegradationPct: 0.005,"), (APP, "solarLife: 30,"),
    (APP, "batteryLife: 20,"), (APP, "windOpexPct: 0.025,"), (APP, "windOffOpexPct: 0.035,"),
    (APP, "windLife: 30,"), (APP, "windOffLife: 30,"), (APP, "windDegradationPct: 0.002,"),
    (APP, "windOffDegradationPct: 0.002,"), (APP, "wacc: 0.07,"), (APP, "ilr: 1.3,"),
    (APP, "includeDieselBackup: false,"), (APP, "includeOffshore: true,"),
    (APP, "WIND_WACC_PREMIUM_DEFAULT = { on: 0.0, off: 0.0092 }"),
    (APP, "onshoreObserved: { 2023: 1216.084, 2024: 1066.656, 2025: 972.84 }"),
    (APP, "onshoreRefined2025: 1025.743,"), (APP, "onshoreRefined2035: 792.491,"),
    (APP, "offshoreGlobal2025: 2930.949,"),
    (APP, "deaFixedAc: { 2025: 2.780229479, 2035: 2.248224305, 2050: 1.985692992 }"),
    (APP, "{ year: 2035, factor: 0.61 }"), (APP, "{ year: 2050, factor: 0.50 }"),
    (APP, "{ year: 2035, factor: 0.66 }"), (APP, "{ year: 2050, factor: 0.55 }"),
    (APP, "let waccMode = 'global';"), (APP, "let capexMode = 'global';"),
    (APP, "const COST_BASE_YEAR = 2026;"),                     # T067: the cost year is a constant
    (APP, "const baseYear = COST_BASE_YEAR;"),
    (CONSTS, "export const BASE_LOAD_MW = 1000;"),
]


def to_fixed(v, d):
    """JS Number.prototype.toFixed: exact binary value, ties to the larger n."""
    if v is None or not np.isfinite(v):
        return '-'
    q = Decimal(1).scaleb(-d)
    return str(Decimal(float(v)).quantize(q, rounding=ROUND_HALF_UP))


def num(v):
    """JS String(n) for the integral capacities in a digest."""
    return str(int(v)) if float(v).is_integer() else repr(float(v))


def digest(res):
    out = []
    for k in range(len(res['ids'])):
        if not res['priced'][k]:
            continue
        w = res['wind_gw'][k]
        interp = bool(res.get('interpolated', np.zeros(len(res['ids']), bool))[k])
        surf = (f"both:{num(res['wind_on_gw'][k])}+{num(res['wind_off_gw'][k])}" if res['surface'][k] == 'both'
                else (res['surface'][k] if w else 'on'))
        out.append('|'.join([
            str(int(res['ids'][k])), num(res['solar_gw'][k]), num(w), surf,
            to_fixed(res['batt_gwh'][k], 2) if interp else num(res['batt_gwh'][k]),
            to_fixed(res['lcoe'][k], 2), '1' if res['meets'][k] else '0', to_fixed(res['cf'][k], 4),
            to_fixed(res['saving'][k], 2), to_fixed(res['max_lcoe'][k], 2), to_fixed(res['nowind_lcoe'][k], 2),
        ]) + ('|i' if interp else ''))
    return sorted(out)


def main():
    ok = True
    for text, needle in NEEDLES:
        if needle not in text:
            print(f'FAIL constant not found in app code: {needle}')
            ok = False
    print(f'{"PASS" if ok else "FAIL"} {len(NEEDLES)} ported constants present in app code')

    oracle = json.loads((ROOT / 'checks/oracle.json').read_text())
    m = engine.load_matrix()
    lcoe, cf = engine.lcoe_matrix(m, year=engine.BASE_YEAR)
    keys = [('lcoe_t90', 90, True), ('lcoe_t80', 80, True), ('lcoe_t80_onshore', 80, False)]
    runs = [(k, t, o, False, oracle[k]) for k, t, o in keys]
    if m.get('addon'):
        ao = json.loads(gzip.decompress((ROOT / 'checks/addon_oracle.json.gz').read_bytes()))
        if ao['meta']['addon_json_sha256'] != m['addon']['manifest_sha256']:
            print('FAIL checks/addon_oracle.json.gz is for another addon.json')
            ok = False
        runs += [(f'{k} + add-on', t, o, True, ao['keys'][k]['digest'])
                 for k, t, o in keys + [('lcoe_t99', 99, True)]]
    for key, target, incl_off, with_addon, want in runs:
        got = digest(engine.search(m, lcoe, cf, target / 100, include_offshore=incl_off, addon=with_addon))
        diff = [i for i, (a, b) in enumerate(zip(got, want)) if a != b]
        same = len(got) == len(want) and not diff
        print(f'{"PASS" if same else "FAIL"} {key}: {len(got)} engine rows vs {len(want)} app rows, {len(diff)} differ')
        for i in diff[:5]:
            print(f'   engine {got[i]}\n   app    {want[i]}')
        ok &= same
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
