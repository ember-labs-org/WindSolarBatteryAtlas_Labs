"""Port of the atlas's LCOE search at app defaults (global cost mode), for T040.

Mirrors deployment/js/workers/lcoe-worker.js (fillLocationLcoe, computeBestLcoeMatrix)
and app.js precomputeLcoePerLocation with waccMode = capexMode = 'global', no
backup, operation for operation, so winners and tie-breaks match the app.
validate_engine.py proves it against the app's own recorded draws
(checks/oracle.json) and checks that every constant below still appears in app.js.

Everything is vectorised over locations: the arrays are (nLoc, nCfg) float64,
built from the float32 CF matrix exactly as the worker reads it.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'deployment' / 'data'

BASE_LOAD_MW = 1000.0          # constants.js
BASE_YEAR = 2026               # app.js LCOE_TIME_ANCHORS.baseYear = calendar year when run

# app.js lcoeParams defaults (global mode)
PARAMS = dict(
    solarCapex=720.0, batteryCapex=120.0, solarOpexPct=0.015, batteryOpexPct=0.02,
    solarDegradationPct=0.005, solarLife=30, batteryLife=20,
    windOpexPct=0.025, windOffOpexPct=0.035, windLife=30, windOffLife=30,
    windDegradationPct=0.002, windOffDegradationPct=0.002,
    wacc=0.07, ilr=1.3,
    windWaccPremium=0.0, windOffWaccPremium=0.0092,
)

# app.js WIND_GLOBAL_COST_INPUTS and WIND_GLOBAL_CAPEX (D-066)
WIND_INPUTS = dict(
    onshoreObserved={2023: 1216.084, 2024: 1066.656, 2025: 972.84},
    onshoreRefined2025=1025.743, onshoreRefined2035=792.491,
    offshoreGlobal2025=2930.949,
    deaFixedAc={2025: 2.780229479, 2035: 2.248224305, 2050: 1.985692992},
)


def wind_global_capex():
    s = WIND_INPUTS
    obs = list(s['onshoreObserved'].values())
    on_anchor = sum(obs) / len(obs)
    on2035 = s['onshoreRefined2035']
    on2050 = on2035 * math.pow(s['onshoreRefined2035'] / s['onshoreRefined2025'], 15 / 10)
    off = s['offshoreGlobal2025']
    dea = s['deaFixedAc']
    return {
        'on': {2024: on_anchor, 2035: on2035, 2050: on2050},
        'off': {2024: off, 2035: off * dea[2035] / dea[2025], 2050: off * dea[2050] / dea[2025]},
    }


WGC = wind_global_capex()
PARAMS['windCapex'] = float(round(WGC['on'][2024]))      # Math.round -> 1,085
PARAMS['windOffCapex'] = float(round(WGC['off'][2024]))  # 2,931


def time_anchors(base_year=BASE_YEAR):
    """app.js LCOE_TIME_ANCHORS: capex multipliers by year, linear between anchors."""
    def wf(path):
        return [(base_year, 1.0), (2035, path[2035] / path[2024]), (2050, path[2050] / path[2024])]
    return {
        'solar': [(base_year, 1.0), (2035, 0.61), (2050, 0.50)],
        'battery': [(base_year, 1.0), (2035, 0.66), (2050, 0.55)],
        'wind': wf(WGC['on']),
        'windOff': wf(WGC['off']),
    }


def interpolate_factor(year, anchors):
    if year <= anchors[0][0]:
        return anchors[0][1]
    for (ya, fa), (yb, fb) in zip(anchors, anchors[1:]):
        if year <= yb:
            t = (year - ya) / ((yb - ya) or 1)
            return fa + t * (fb - fa)
    return anchors[-1][1]


def cost_multipliers(year, base_year=BASE_YEAR):
    """app.js applyLcoeTimeYear: the year is clamped to [baseYear, 2050]."""
    y = max(base_year, min(2050, year))
    a = time_anchors(base_year)
    return {k: interpolate_factor(y, a[k]) for k in ('solar', 'battery', 'wind', 'windOff')}


def crf(rate, years):
    """utils.js capitalRecoveryFactor."""
    if years <= 0:
        return 0.0
    if rate == 0:
        return 1 / years
    p = math.pow(1 + rate, years)
    return (rate * p) / (p - 1)


def levelized_growth_multiplier(growth, rate, years):
    """utils.js levelizedGrowthMultiplier."""
    if not years > 0:
        return 0.0
    c = crf(rate, years)
    ratio = (1 + growth) / (1 + rate)
    if abs(ratio - 1) < 1e-12:
        pv = years / (1 + rate)
    else:
        pv = (1 / (1 + growth)) * ratio * (1 - math.pow(ratio, years)) / (1 - ratio)
    return pv * c


# ---------------------------------------------------------------------------
# The CF matrix, as data.js loadCfMatrix builds it
# ---------------------------------------------------------------------------
def load_matrix():
    cfg = json.loads((DATA / 'configs.json').read_text())['configs']
    n_cfg = len(cfg)
    solar = np.zeros(n_cfg, np.int8)
    wind = np.zeros(n_cfg, np.int8)
    batt = np.zeros(n_cfg, np.int8)
    off = np.zeros(n_cfg, np.uint8)
    by_slice = {}
    for c in cfg:
        i = c['i']
        solar[i], wind[i], batt[i] = c['solar'], c['wind'], c['batt']
        off[i] = 1 if (c['wind'] > 0 and c['surface'] == 'off') else 0
        by_slice.setdefault(c['summary'], []).append(c)
    # Location ids: every id in the slices (the app passes the slice positions'
    # ids; all 4,998 appear in every slice).
    ids = None
    cols = {}
    for f in by_slice:
        t = pq.read_table(DATA / f, columns=['location_id', 'solar_gw', 'wind_gw', 'batt_gwh', 'annual_cf'])
        cols[f] = {k: t.column(k).to_numpy() for k in t.column_names}
        u = np.unique(cols[f]['location_id'])
        ids = u if ids is None else np.union1d(ids, u)
    loc_index = {int(v): k for k, v in enumerate(ids)}
    cf = np.zeros((len(ids), n_cfg), np.float32)
    for f, cs in by_slice.items():
        trip = {(c['solar'] << 16) | (c['wind'] << 8) | c['batt']: c['i'] for c in cs}
        c = cols[f]
        key = (c['solar_gw'].astype(np.int64) << 16) | (c['wind_gw'].astype(np.int64) << 8) | c['batt_gwh'].astype(np.int64)
        ci = np.array([trip.get(int(k), -1) for k in key])
        li = np.array([loc_index[int(v)] for v in c['location_id']])
        ok = ci >= 0
        cf[li[ok], ci[ok]] = c['annual_cf'][ok]
    m = dict(cf=cf, ids=ids.astype(np.int64), solar=solar, wind=wind, batt=batt, off=off, n_cfg=n_cfg)
    # unitConfigIndices
    u = {'solar': -1, 'on': -1, 'off': -1}
    for i in range(n_cfg):
        if batt[i] != 0:
            continue
        if solar[i] == 1 and wind[i] == 0 and u['solar'] < 0:
            u['solar'] = i
        if solar[i] == 0 and wind[i] == 1:
            if off[i]:
                if u['off'] < 0:
                    u['off'] = i
            elif u['on'] < 0:
                u['on'] = i
    m['unit'] = u
    m['addon'] = load_addon(m['ids'])
    m['_coef'] = {}
    return m


# ---------------------------------------------------------------------------
# The sparse add-on (T058, D-127): deployment/js/addon.js, ported
# ---------------------------------------------------------------------------
def load_addon(ids):
    """addon.json and its two files, as per-row arrays (location index, j, CF),
    each set's rows ordered by location then j. None without addon.json."""
    mf = DATA / 'addon.json'
    if not mf.exists():
        return None
    import hashlib
    man = json.loads(mf.read_text())
    loc_index = {int(v): k for k, v in enumerate(ids)}
    out = {'manifest_sha256': hashlib.sha256(mf.read_bytes()).hexdigest()}
    for st in man['sets']:
        f = DATA / st['file']
        if hashlib.sha256(f.read_bytes()).hexdigest() != st['sha256']:
            raise RuntimeError(f'{f.name}: SHA-256 does not match addon.json')
        t = pq.read_table(f, columns=['location_id', 'cfg', 'annual_cf'])
        lid = t.column('location_id').to_numpy()
        li = np.array([loc_index.get(int(v), -1) for v in lid])
        j = t.column('cfg').to_numpy().astype(np.int64)
        cfv = t.column('annual_cf').to_numpy()
        keep = li >= 0
        order = np.lexsort((j[keep], li[keep]))
        cfgs = st['configs']
        assert all(c['j'] == k for k, c in enumerate(cfgs))
        out[st['id']] = dict(
            li=li[keep][order], j=j[keep][order], cf=cfv[keep][order],
            solar=np.array([c['solar'] for c in cfgs], np.float64), batt=np.array([c['batt'] for c in cfgs], np.float64),
            on=np.array([c.get('on', 0) for c in cfgs], np.float64), off=np.array([c.get('off', 0) for c in cfgs], np.float64),
            guard=st.get('guard'))
        if st['id'] == 'large':
            sol = out['large']['solar']
            out['large']['level'] = np.concatenate([[0], np.cumsum(sol[1:] != sol[:-1])]).astype(np.int64)
    return out


# ---------------------------------------------------------------------------
# LCOE of every config at every location (fillLocationLcoe, global mode)
# ---------------------------------------------------------------------------
def lcoe_matrix(m, year=BASE_YEAR, base_year=BASE_YEAR, params=None):
    p = dict(PARAMS)
    if params:
        p.update(params)
    mult = cost_multipliers(year, base_year)
    wacc = p['wacc']
    solar_capex_per_kw = (p['solarCapex'] * (mult['solar'] or 1)) / (p['ilr'] if p['ilr'] > 0 else 1)
    batt_capex = p['batteryCapex'] * (mult['battery'] or 1)
    won_capex = p['windCapex'] * (mult['wind'] or 1)
    woff_capex = p['windOffCapex'] * (mult['windOff'] or 1)
    won_wacc = wacc + (p['windWaccPremium'] or 0)
    woff_wacc = wacc + (p['windOffWaccPremium'] or 0)
    won_crf, woff_crf = crf(won_wacc, p['windLife']), crf(woff_wacc, p['windOffLife'])
    won_deg = levelized_growth_multiplier(-(p['windDegradationPct'] or 0), won_wacc, p['windLife'])
    woff_deg = levelized_growth_multiplier(-(p['windOffDegradationPct'] or 0), woff_wacc, p['windOffLife'])
    solar_crf, batt_crf = crf(wacc, p['solarLife']), crf(wacc, p['batteryLife'])
    energy_deg = levelized_growth_multiplier(-(p['solarDegradationPct'] or 0), wacc, p['solarLife'])

    cf32 = m['cf']
    cf = cf32.astype(np.float64)
    solar_kw = m['solar'].astype(np.float64) * 1_000_000
    batt_kwh = m['batt'].astype(np.float64) * 1_000_000
    wind_kw = m['wind'].astype(np.float64) * 1_000_000
    off = m['off'] == 1

    s_capex = solar_capex_per_kw * solar_kw
    b_capex = batt_capex * batt_kwh
    w_capex = np.where(off, woff_capex, won_capex) * wind_kw
    sA, sO = s_capex * solar_crf, s_capex * p['solarOpexPct']
    bA, bO = b_capex * batt_crf, b_capex * p['batteryOpexPct']
    wA = w_capex * np.where(off, woff_crf, won_crf)
    wO = w_capex * np.where(off, p['windOffOpexPct'], p['windOpexPct'])
    # Same left-to-right summation as the worker.
    cost = ((((sA + bA) + wA) + sO) + bO) + wO                      # (nCfg,)

    u = m['unit']
    nan = np.full(cf.shape[0], np.nan)
    unit_solar = cf[:, u['solar']] if u['solar'] >= 0 else nan
    unit_on = cf[:, u['on']] if u['on'] >= 0 else nan
    unit_off = cf[:, u['off']] if u['off'] >= 0 else nan

    # blendedDegradation per (location, config) where wind > 0
    wcf = np.where(off[None, :], unit_off[:, None], unit_on[:, None])  # (nLoc, nCfg)
    wmult = np.where(off, woff_deg, won_deg)[None, :]
    s = solar_kw[None, :] * unit_solar[:, None]
    w = wind_kw[None, :] * wcf
    bad = ~((s + w) > 0)
    s = np.where(bad, solar_kw[None, :], s)
    w = np.where(bad, wind_kw[None, :], w)
    with np.errstate(invalid='ignore', divide='ignore'):
        blended = (s * energy_deg + w * wmult) / (s + w)
    degr = np.where(wind_kw[None, :] > 0, blended, energy_deg)

    with np.errstate(invalid='ignore', divide='ignore'):
        energy = cf * 8760 * BASE_LOAD_MW
        energy = energy * degr
        lcoe = cost[None, :] / energy
    valid = (cf > 0) & np.isfinite(energy) & (energy > 0) & np.isfinite(lcoe)
    lcoe = np.where(valid, lcoe, np.nan)
    # What the add-on pass prices its rows with (addon.js addonCoeffs), for search().
    m.setdefault('_coef', {})[id(lcoe)] = dict(
        spk=solar_capex_per_kw, batt=batt_capex, won=won_capex, woff=woff_capex, won_crf=won_crf, woff_crf=woff_crf,
        won_opex=p['windOpexPct'], woff_opex=p['windOffOpexPct'], s_crf=solar_crf, b_crf=batt_crf,
        s_opex=p['solarOpexPct'], b_opex=p['batteryOpexPct'], dS=energy_deg, dOn=won_deg, dOff=woff_deg,
        uS=unit_solar, uOn=unit_on, uOff=unit_off)
    return lcoe, cf


def first_argmin(values, mask):
    """Index of the first minimum of values where mask, per row (-1 if none).
    Strict '<' in config order = first occurrence of the minimum."""
    v = np.where(mask, values, np.inf)
    idx = np.argmin(v, axis=1)
    has = mask.any(axis=1)
    return np.where(has, idx, -1)


def best_builds(m, lcoe, cf, target, include_offshore=True, no_wind=False):
    """computeBestLcoeMatrix for one target. Returns per-location dict of arrays:
    chosen config (meets target, else highest-CF fallback), meets flag, lcoe.
    no_wind=True restricts to configs without wind (the app's noWind search)."""
    valid = ~np.isnan(lcoe)
    if not include_offshore:
        valid &= (m['off'] == 0)[None, :]
    if no_wind:
        valid &= (m['wind'] == 0)[None, :]
    meets = valid & (cf >= target)
    best = first_argmin(lcoe, meets)
    # Fallback: most CF, then cheapest, first in config order.
    cfv = np.where(valid, cf, -np.inf)
    maxcf = cfv.max(axis=1)
    at_max = valid & (cf == maxcf[:, None])
    fb = first_argmin(lcoe, at_max)
    meets_any = best >= 0
    chosen = np.where(meets_any, best, fb)
    rows = np.arange(lcoe.shape[0])
    ch = np.where(chosen >= 0, chosen, 0)
    out_lcoe = np.where(chosen >= 0, lcoe[rows, ch], np.nan)
    out_cf = np.where(chosen >= 0, cf[rows, ch], np.nan)
    fbl = np.where(fb >= 0, lcoe[rows, np.where(fb >= 0, fb, 0)], np.nan)
    return dict(cfg=chosen, meets=meets_any, lcoe=out_lcoe, cf=out_cf, priced=fb >= 0,
                max_cfg=fb, max_lcoe=fbl, max_cf=np.where(fb >= 0, maxcf, np.nan))


def _addon_lcoe(k, li, solar_kw, on_kw, off_kw, batt_kwh, cf):
    """addon.js addonLcoe, no backup: combined builds (on and off > 0) take the
    three-source branch, everything else the no-wind expressions."""
    both = (on_kw > 0) & (off_kw > 0)
    s_capex = k['spk'] * solar_kw
    b_capex = k['batt'] * batt_kwh
    on_capex = k['won'] * on_kw
    off_capex = k['woff'] * off_kw
    w_ann = np.where(both, on_capex * k['won_crf'] + off_capex * k['woff_crf'], (k['won'] * 0.0) * k['won_crf'])
    w_opx = np.where(both, on_capex * k['won_opex'] + off_capex * k['woff_opex'], (k['won'] * 0.0) * k['won_opex'])
    cost = ((((s_capex * k['s_crf'] + b_capex * k['b_crf']) + w_ann) + s_capex * k['s_opex']) + b_capex * k['b_opex']) + w_opx
    s = solar_kw * k['uS'][li]
    a = on_kw * k['uOn'][li]
    o = off_kw * k['uOff'][li]
    bad = ~((s + a + o) > 0)
    s, a, o = np.where(bad, solar_kw, s), np.where(bad, on_kw, a), np.where(bad, off_kw, o)
    with np.errstate(invalid='ignore', divide='ignore'):
        d3 = (s * k['dS'] + a * k['dOn'] + o * k['dOff']) / (s + a + o)
        energy = cf * 8760 * BASE_LOAD_MW
        energy = energy * np.where(both, d3, k['dS'])
        lc = cost / energy
    ok = (cf > 0) & np.isfinite(energy) & (energy > 0) & np.isfinite(lc)
    return np.where(ok, lc, np.nan)


def _first_per_loc(li, *keys):
    """Index of the first row per location after sorting by keys (lexsort, last key first)."""
    if not len(li):
        return np.array([], np.int64), np.array([], np.int64)
    order = np.lexsort(tuple(reversed(keys)) + (li,))
    lis = li[order]
    first = np.r_[True, lis[1:] != lis[:-1]]
    return lis[first], order[first]


def addon_candidates(m, lcoe, target, include_offshore=True):
    """Every add-on candidate in target mode, as addon.js addonPassTarget prices them:
    dict of arrays (li, order, lcoe, cf, solar, on, off, batt, set: 0 wind_mix / 1 large,
    interp, best_ok, nowind_ok, fb_ok). Order is the tie-break order after configs.json."""
    A = m.get('addon')
    k = m['_coef'][id(lcoe)]
    parts = []
    if include_offshore and A.get('wind_mix'):
        w = A['wind_mix']
        j = w['j']
        cfv = w['cf'].astype(np.float64)
        lc = _addon_lcoe(k, w['li'], w['solar'][j] * 1_000_000, w['on'][j] * 1_000_000, w['off'][j] * 1_000_000,
                         w['batt'][j] * 1_000_000, cfv)
        ok = ~np.isnan(lc)
        parts.append(dict(li=w['li'][ok], order=j[ok].astype(np.float64), lcoe=lc[ok], cf=cfv[ok], solar=w['solar'][j][ok],
                          on=w['on'][j][ok], off=w['off'][j][ok], batt=w['batt'][j][ok], set=np.zeros(ok.sum(), np.int8),
                          interp=np.zeros(ok.sum(), bool), best_ok=(cfv >= target)[ok], nowind_ok=np.zeros(ok.sum(), bool),
                          fb_ok=np.ones(ok.sum(), bool)))
    if A.get('large'):
        L = A['large']
        li, j = L['li'], L['j']
        cfv = L['cf'].astype(np.float64)
        lv = L['level'][j]
        meet = cfv >= target
        key = li * 1000 + lv
        # First row reaching T per (location, level); rows are in (location, j) order.
        idx = np.nonzero(meet)[0]
        _, firsts = np.unique(key[idx], return_index=True)
        hit = idx[firsts]
        prev = hit - 1
        has_prev = (prev >= 0) & (key[np.maximum(prev, 0)] == key[hit]) & (j[np.maximum(prev, 0)] == j[hit] - 1)
        hp, pp = hit[has_prev], prev[has_prev]
        c0, c1 = cfv[pp], cfv[hp]
        guard = L['guard'] if L['guard'] is not None else 0.00005
        tp = np.minimum(target + guard, c1)
        b0, b1 = L['batt'][j[pp]], L['batt'][j[hp]]
        bstar = b0 + (tp - c0) / (c1 - c0) * (b1 - b0)
        tcf = np.full(len(hp), float(target))
        lc_i = _addon_lcoe(k, li[hp], L['solar'][j[hp]] * 1_000_000, np.zeros(len(hp)), np.zeros(len(hp)), bstar * 1_000_000, tcf)
        # Grid points reaching T (every one competes).
        gi = idx
        lc_g = _addon_lcoe(k, li[gi], L['solar'][j[gi]] * 1_000_000, np.zeros(len(gi)), np.zeros(len(gi)),
                           L['batt'][j[gi]] * 1_000_000, cfv[gi])
        for lis, order, lc, cfx, sol, batt, interp in [
                (li[hp], 10000 + 2.0 * j[hp], lc_i, tcf, L['solar'][j[hp]], bstar, True),
                (li[gi], 10000 + 2.0 * j[gi] + 1, lc_g, cfv[gi], L['solar'][j[gi]], L['batt'][j[gi]], False)]:
            ok = ~np.isnan(lc)
            n = int(ok.sum())
            parts.append(dict(li=lis[ok], order=order[ok], lcoe=lc[ok], cf=cfx[ok], solar=sol[ok], on=np.zeros(n), off=np.zeros(n),
                              batt=batt[ok], set=np.ones(n, np.int8), interp=np.full(n, interp), best_ok=np.ones(n, bool),
                              nowind_ok=np.ones(n, bool), fb_ok=np.zeros(n, bool)))
    if not parts:
        return None
    return {f: np.concatenate([p_[f] for p_ in parts]) for f in parts[0]}


def search(m, lcoe, cf, target, include_offshore=True, addon=True):
    """The app's per-location answer: chosen build plus its no-wind comparison
    (noWindLcoe, windSaving, noWindMeetsTarget), as computeBestLcoeMatrix sets them.
    With addon.json in the data (and addon=True) the add-on pass follows, as in the
    app (T058): strict comparisons, add-on rows after every dense config.
    T067 (T065-V-2): the app compares the float32 CFs with Math.fround(target), and hands
    the add-on pass the same float32 target, so a build exactly at the target meets it."""
    target = float(np.float32(target))
    a = best_builds(m, lcoe, cf, target, include_offshore)
    nw = best_builds(m, lcoe, cf, target, include_offshore, no_wind=True)
    has_nw = nw['cfg'] >= 0
    cfgs = np.where(a['cfg'] >= 0, a['cfg'], 0)
    n = len(m['ids'])
    res = dict(
        ids=m['ids'], priced=a['priced'].copy(), cfg=a['cfg'].copy(), meets=a['meets'].copy(), lcoe=a['lcoe'].copy(), cf=a['cf'].copy(),
        solar_gw=m['solar'][cfgs].astype(np.float64), wind_gw=m['wind'][cfgs].astype(np.float64), batt_gwh=m['batt'][cfgs].astype(np.float64),
        surface=np.where((m['off'][cfgs] == 1) & (m['wind'][cfgs] > 0), 'off', 'on').astype(object),
        wind_on_gw=np.where(m['off'][cfgs] == 1, 0, m['wind'][cfgs]).astype(np.float64),
        wind_off_gw=np.where(m['off'][cfgs] == 1, m['wind'][cfgs], 0).astype(np.float64),
        addon=np.full(n, None, object), interpolated=np.zeros(n, bool),
        max_lcoe=a['max_lcoe'].copy(), max_cf=a['max_cf'].copy(),
        nowind_lcoe=np.where(has_nw, nw['lcoe'], np.nan), nowind_meets=nw['meets'].copy(),
        nowind_cfg=nw['cfg'].copy(), nowind_max_cf=nw['max_cf'],
        # The no-wind comparator's build (T058): a slider (configs.json) build without wind
        # meets the target; the no-wind build is a large add-on build; its solar and battery.
        nowind_std_meets=nw['meets'].copy(), nowind_large=np.zeros(n, bool),
        nowind_std_lcoe=np.where(nw['meets'], nw['lcoe'], np.nan),
        nowind_solar=np.where(nw['cfg'] >= 0, m['solar'][np.maximum(nw['cfg'], 0)], np.nan).astype(np.float64),
        nowind_batt=np.where(nw['cfg'] >= 0, m['batt'][np.maximum(nw['cfg'], 0)], np.nan).astype(np.float64),
    )
    C = addon_candidates(m, lcoe, target, include_offshore) if (addon and m.get('addon')) else None
    if C is not None:
        dense_best = np.where(a['meets'], a['lcoe'], np.nan)
        # best (meets T): the add-on's cheapest, first in order, if strictly cheaper.
        sel = np.nonzero(C['best_ok'])[0]
        locs, rows = _first_per_loc(C['li'][sel], C['lcoe'][sel], C['order'][sel])
        rows = sel[rows]
        win = ~(C['lcoe'][rows] >= dense_best[locs])          # strictly cheaper, or no dense best
        best_loc, best_row = locs[win], rows[win]
        # no-wind best: large candidates only.
        sel = np.nonzero(C['nowind_ok'])[0]
        locs, rows = _first_per_loc(C['li'][sel], C['lcoe'][sel], C['order'][sel])
        rows = sel[rows]
        dnw = np.where(nw['meets'], nw['lcoe'], np.nan)
        win = ~(C['lcoe'][rows] >= dnw[locs])
        res['nowind_lcoe'][locs[win]] = C['lcoe'][rows[win]]
        res['nowind_meets'][locs[win]] = True
        res['nowind_cfg'][locs[win]] = -2
        res['nowind_large'][locs[win]] = True
        res['nowind_solar'][locs[win]] = C['solar'][rows[win]]
        res['nowind_batt'][locs[win]] = C['batt'][rows[win]]
        # fallback / max-config: wind_mix rows, most CF, then cheapest, then order.
        sel = np.nonzero(C['fb_ok'])[0]
        locs, rows = _first_per_loc(C['li'][sel], -C['cf'][sel], C['lcoe'][sel], C['order'][sel])
        rows = sel[rows]
        dcf, dl = a['max_cf'][locs], a['max_lcoe'][locs]
        ccf, cl = C['cf'][rows], C['lcoe'][rows]
        win = ~(a['priced'][locs]) | (ccf > dcf) | ((ccf == dcf) & (cl < dl))
        fb_loc, fb_row = locs[win], rows[win]
        res['max_lcoe'][fb_loc] = C['lcoe'][fb_row]
        res['max_cf'][fb_loc] = C['cf'][fb_row]
        res['priced'][fb_loc] = True

        def put(loc, row, meets):
            res['cfg'][loc] = -2
            res['meets'][loc] = meets
            res['lcoe'][loc] = C['lcoe'][row]
            res['cf'][loc] = C['cf'][row]
            res['solar_gw'][loc] = C['solar'][row]
            res['wind_gw'][loc] = C['on'][row] + C['off'][row]
            res['batt_gwh'][loc] = C['batt'][row]
            res['surface'][loc] = np.where(C['set'][row] == 0, 'both', 'on')
            res['wind_on_gw'][loc] = C['on'][row]
            res['wind_off_gw'][loc] = C['off'][row]
            res['addon'][loc] = np.where(C['set'][row] == 0, 'wind_mix', 'large')
            res['interpolated'][loc] = C['interp'][row]
        # A location with no best (dense or add-on) shows its fallback: the add-on's where it won.
        nomeet = ~a['meets']
        nomeet[best_loc] = False
        fbsel = nomeet[fb_loc]
        put(fb_loc[fbsel], fb_row[fbsel], False)
        put(best_loc, best_row, True)
    saving = np.where(np.isfinite(res['lcoe']) & np.isfinite(res['nowind_lcoe']), res['nowind_lcoe'] - res['lcoe'], np.nan)
    sg, wg = res['solar_gw'], res['wind_gw']
    res['saving'] = saving
    res['wind_share'] = np.where(sg + wg > 0, wg / np.where(sg + wg > 0, sg + wg, 1), 0.0)
    return res
