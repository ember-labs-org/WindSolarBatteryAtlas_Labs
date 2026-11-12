// Sparse add-on builds (T058): combined onshore + offshore wind (`wind_mix`) and
// large solar + battery builds (`large`), searched after the dense grid. Pure
// functions, no DOM: imported by the LCOE worker and by app.js's main-thread
// fallback, so both run the same add-on pass (lesson: one-search-for-partial-data).
//
// The pass continues the dense loop's running bests for one location. Every
// comparison is strict and add-on rows rank after every configs.json config
// (wind_mix before large, ascending j), so every exact tie keeps today's winner.
// Rows are priced with the same floating-point operations, in the same order, as
// computeLcoeMetrics (worker) and computeLcoeMetricsFast (app.js), so the LCOE a
// winner is chosen on is the LCOE its result row carries.

const BASE_LOAD_MW = 1000;

export const ADDON_SET_IDS = ['wind_mix', 'large'];

function clampCf(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

/**
 * Per-set config arrays from an addon.json set: solar, battery, onshore and
 * offshore capacity per config (index j), and, for `large`, the battery axis of
 * each solar level as contiguous runs of j in battery order.
 */
export function addonConfigArrays(set) {
    const n = set.configs.length;
    const solar = new Float64Array(n), batt = new Float64Array(n);
    const on = new Float64Array(n), off = new Float64Array(n);
    set.configs.forEach((c, k) => {
        if (c.j !== k) throw new Error(`addon.json ${set.id}: config ${k} has j ${c.j}`);
        solar[k] = c.solar;
        batt[k] = c.batt;
        on[k] = c.on || 0;
        off[k] = c.off || 0;
    });
    // Solar levels as runs [start, end) of j; within a run the battery must rise.
    const levelStart = [];
    for (let k = 0; k < n; k++) {
        if (k === 0 || solar[k] !== solar[k - 1]) levelStart.push(k);
        else if (set.id === 'large' && !(batt[k] > batt[k - 1])) {
            throw new Error(`addon.json large: battery not ascending at j ${k}`);
        }
    }
    levelStart.push(n);
    return { nCfg: n, solar, batt, on, off, levelStart: Int32Array.from(levelStart) };
}

/**
 * CSR of one set over the matrix's location order: offsets (nLoc + 1) and, per
 * row, the config j, CF and curtailed share. `cols` are the decoded parquet
 * columns { location_id, cfg, annual_cf, curtailed_share } in file order
 * (sorted by cfg, then location), so each location's rows come out in ascending j.
 */
export function buildAddonCsr(set, cols, locationIds) {
    const nLoc = locationIds.length;
    const locIndex = new Map();
    for (let i = 0; i < nLoc; i++) locIndex.set(Number(locationIds[i]), i);
    const n = cols.location_id.length;
    const nCfg = set.configs.length;
    const rowLoc = new Int32Array(n);
    const counts = new Int32Array(nLoc + 1);
    let kept = 0;
    for (let r = 0; r < n; r++) {
        const li = locIndex.get(Number(cols.location_id[r]));
        const j = cols.cfg[r];
        if (li === undefined || !(j >= 0 && j < nCfg)) { rowLoc[r] = -1; continue; }
        rowLoc[r] = li;
        counts[li + 1]++;
        kept++;
    }
    const offsets = new Int32Array(nLoc + 1);
    for (let i = 0; i < nLoc; i++) offsets[i + 1] = offsets[i] + counts[i + 1];
    const fill = offsets.slice(0, nLoc);
    const cfg = new Uint16Array(kept), cf = new Float32Array(kept), curt = new Float32Array(kept);
    for (let r = 0; r < n; r++) {
        const li = rowLoc[r];
        if (li < 0) continue;
        const k = fill[li]++;
        cfg[k] = cols.cfg[r];
        cf[k] = cols.annual_cf[r];
        curt[k] = cols.curtailed_share ? cols.curtailed_share[r] : 0;
    }
    // Rows of a location must be in ascending j (the tie-break order).
    for (let li = 0; li < nLoc; li++) {
        for (let k = offsets[li] + 1; k < offsets[li + 1]; k++) {
            if (!(cfg[k] > cfg[k - 1])) throw new Error(`${set.id}: rows of location ${locationIds[li]} not in ascending config order`);
        }
    }
    return { offsets, cfg, cf, curt };
}

/** The transferable buffers of a loaded add-on ({ sets: { id: {...} } }). */
export const ADDON_CSR_KEYS = ['offsets', 'cfg', 'cf', 'curt'];
export const ADDON_CFG_KEYS = ['solar', 'batt', 'on', 'off', 'levelStart'];

export function addonTransferList(addon) {
    const out = [];
    if (!addon) return out;
    for (const s of Object.values(addon.sets)) {
        for (const k of [...ADDON_CSR_KEYS, ...ADDON_CFG_KEYS]) if (s[k]) out.push(s[k].buffer);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Technology filter (T074)
//
// The LCOE view can switch solar, battery, onshore and offshore wind off. A
// build is eligible when every technology it uses is on: its tech bits AND the
// switched-off bits is zero. Each build's bits are computed once per grid or
// add-on set (16 combinations), so a search pays one AND per build. With every
// technology on the mask is 0 and nothing is skipped, so results are unchanged.
// Offshore is off when 'Include offshore wind' is unticked: the same switch.
// ---------------------------------------------------------------------------

export const TECH_SOLAR = 1, TECH_BATTERY = 2, TECH_ONSHORE = 4, TECH_OFFSHORE = 8;
export const TECH_KEYS = ['solar', 'battery', 'onshore', 'offshore'];
export const TECH_BITS = { solar: TECH_SOLAR, battery: TECH_BATTERY, onshore: TECH_ONSHORE, offshore: TECH_OFFSHORE };

/** The tech bits of one build from its capacities (> 0 means used). */
export function techBits(solar, batt, on, off) {
    return (solar > 0 ? TECH_SOLAR : 0) | (batt > 0 ? TECH_BATTERY : 0)
        | (on > 0 ? TECH_ONSHORE : 0) | (off > 0 ? TECH_OFFSHORE : 0);
}

/**
 * The switched-off bits of a search: params.techOff (solar, battery, onshore)
 * plus offshore when params.includeOffshore is false. 0 = every technology on.
 */
export function techOffMask(params) {
    const off = (params && params.techOff) & (TECH_SOLAR | TECH_BATTERY | TECH_ONSHORE);
    return off | (params && params.includeOffshore === false ? TECH_OFFSHORE : 0);
}

/**
 * Per-config tech bits of a dense grid ({ solarGw, windGw, battGwh, surfaceOff, nCfg }),
 * cached on it. An offshore config (surfaceOff) counts as offshore whatever its
 * wind, as the include-offshore rule has always skipped it.
 */
export function denseTechMask(m) {
    if (m.techMask) return m.techMask;
    const t = new Uint8Array(m.nCfg);
    for (let ci = 0; ci < m.nCfg; ci++) {
        const off = m.surfaceOff[ci] ? 1 : 0;
        t[ci] = techBits(m.solarGw[ci], m.battGwh[ci], off ? 0 : m.windGw[ci], 0) | (off ? TECH_OFFSHORE : 0);
    }
    m.techMask = t;
    return t;
}

/** The configs of a dense grid a mask excludes, cached per mask (at most 16 lists). */
export function excludedConfigs(m, offMask) {
    const t = denseTechMask(m);
    if (!m.excludedByMask) m.excludedByMask = new Array(16).fill(null);
    let list = m.excludedByMask[offMask];
    if (!list) {
        const out = [];
        for (let ci = 0; ci < t.length; ci++) if (t[ci] & offMask) out.push(ci);
        list = Int32Array.from(out);
        m.excludedByMask[offMask] = list;
    }
    return list;
}

/** Per-config tech bits of an add-on set ({ solar, batt, on, off, nCfg }), cached on it. */
export function addonSetTechMask(s) {
    if (s.techMask) return s.techMask;
    const n = s.nCfg ?? s.solar.length;
    const t = new Uint8Array(n);
    for (let j = 0; j < n; j++) t[j] = techBits(s.solar[j], s.batt[j], s.on[j], s.off[j]);
    s.techMask = t;
    return t;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * The cost coefficients of one location from either engine's `pre`
 * (precomputeLcoePerLocation in the worker or in app.js: same values, two
 * naming schemes).
 */
export function addonCoeffs(pre) {
    return {
        backup: pre.includeDieselBackup,
        solarCapexPerKw: pre.solarCapexPerKw,
        batteryCapex: pre.batteryCapexBase ?? pre.baseBatteryCapex,
        windOnCapex: pre.windOnCapexBase ?? pre.baseWindOnCapex,
        windOffCapex: pre.windOffCapexBase ?? pre.baseWindOffCapex,
        windOnCrf: pre.windOnCrf,
        windOffCrf: pre.windOffCrf,
        windOpexPct: pre.windOpexPct,
        windOffOpexPct: pre.windOffOpexPct,
        solarCrf: pre.solarCrf,
        batteryCrf: pre.batteryCrf,
        solarOpexPct: pre.solarOpexPct,
        batteryOpexPct: pre.batteryOpexPct,
        degS: pre.energyDegradationMult,
        degOn: pre.windOnDegradationMult,
        degOff: pre.windOffDegradationMult,
        cfS: pre.solarUnitCf,
        cfOn: pre.windOnUnitCf,
        cfOff: pre.windOffUnitCf,
        dieselFinite: Number.isFinite(pre.dieselFuelCostPerMwh),
        dieselCapexAnnual: pre.dieselCapexAnnual,
        dieselFuel: pre.dieselFuelCostPerMwh,
        gasUsable: Boolean(pre.gasAvailable) && Number.isFinite(pre.gasFuelCostPerMwh),
        gasCapexAnnual: pre.gasCapexAnnual,
        gasFuel: pre.gasFuelCostPerMwh
    };
}

/**
 * Degradation factor on the energy of a solar + onshore + offshore build: each
 * source's factor weighted by its share of the energy (capacity x the location's
 * unit CF), capacity shares where those are unknown. With one wind surface it is
 * blendedDegradation; the combined-build branch of computeLcoeMetrics calls this.
 */
export function blendedDegradation3(solarKw, onKw, offKw, solarCf, onCf, offCf, solarMult, onMult, offMult) {
    let s = solarKw * solarCf;
    let a = onKw * onCf;
    let o = offKw * offCf;
    if (!(s + a + o > 0)) { s = solarKw; a = onKw; o = offKw; }
    return (s * solarMult + a * onMult + o * offMult) / (s + a + o);
}

/**
 * LCOE of one add-on row, or NaN where it is skipped (not finite). Same
 * expressions as computeLcoeMetrics: a combined build (onKw and offKw both
 * > 0) takes its 'both' branch; anything else the no-wind expressions with
 * onshore wind 0 (every add-on row is one or the other).
 */
export function addonLcoe(k, solarKw, onKw, offKw, batteryKwh, cf) {
    const both = onKw > 0 && offKw > 0;
    const solarCapex = k.solarCapexPerKw * solarKw;
    const batteryCapex = k.batteryCapex * batteryKwh;
    let windAnnual, windOpex;
    if (both) {
        const onCapex = k.windOnCapex * onKw;
        const offCapex = k.windOffCapex * offKw;
        windAnnual = onCapex * k.windOnCrf + offCapex * k.windOffCrf;
        windOpex = onCapex * k.windOpexPct + offCapex * k.windOffOpexPct;
    } else {
        // No wind: wind_surface 'on' and 0 kW, exactly as a no-wind dense row.
        const windCapex = k.windOnCapex * 0;
        windAnnual = windCapex * k.windOnCrf;
        windOpex = windCapex * k.windOpexPct;
    }
    const solarAnnual = solarCapex * k.solarCrf;
    const batteryAnnual = batteryCapex * k.batteryCrf;
    const solarOpex = solarCapex * k.solarOpexPct;
    const batteryOpex = batteryCapex * k.batteryOpexPct;
    let annualCost = solarAnnual + batteryAnnual + windAnnual + solarOpex + batteryOpex + windOpex;
    let renewableMwh = cf * 8760 * BASE_LOAD_MW;
    renewableMwh *= both
        ? blendedDegradation3(solarKw, onKw, offKw, k.cfS, k.cfOn, k.cfOff, k.degS, k.degOn, k.degOff)
        : k.degS;
    if (!k.backup) {
        if (!Number.isFinite(renewableMwh) || renewableMwh <= 0) return NaN;
        const lcoe = annualCost / renewableMwh;
        return Number.isFinite(lcoe) ? lcoe : NaN;
    }
    // Backup on: the full baseload, the cheaper of diesel and gas for the shortfall
    // (the full load less the renewables' degraded energy).
    const annualEnergyMwh = 8760 * BASE_LOAD_MW;
    const backupEnergyMwh = Math.max(0, annualEnergyMwh - renewableMwh);
    const dieselTotalAnnual = k.dieselFinite ? k.dieselCapexAnnual + backupEnergyMwh * k.dieselFuel : Infinity;
    const gasTotalAnnual = k.gasUsable ? k.gasCapexAnnual + backupEnergyMwh * k.gasFuel : Infinity;
    const backupTotalAnnual = gasTotalAnnual < dieselTotalAnnual ? gasTotalAnnual : dieselTotalAnnual;
    if (!Number.isFinite(backupTotalAnnual)) return NaN;
    annualCost += backupTotalAnnual;
    const lcoe = annualCost / annualEnergyMwh;
    return Number.isFinite(lcoe) ? lcoe : NaN;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** A candidate add-on build (only made when it beats a running best). */
function candidate(setId, j, cfgArr, cf, curt, batt, interpolated, lcoe) {
    return {
        set: setId, j,
        solar: cfgArr.solar[j], on: cfgArr.on[j], off: cfgArr.off[j],
        batt, cf, curt, interpolated, lcoe
    };
}

/** Guarded linear interpolation along the battery axis (contract, Search). */
export function interpolateBattery(T, guard, b0, b1, c0, c1) {
    const tp = Math.min(T + guard, c1);
    const frac = (tp - c0) / (c1 - c0);
    return { b: b0 + (tp - c0) / (c1 - c0) * (b1 - b0), frac };
}

/**
 * Fresh running-best state for one location, target-CF mode. The dense loop
 * fills the numeric fields; addonPassTarget may replace a best with an add-on
 * candidate (then `best`, `noWind` or `fb` holds it; null = the dense one stands).
 */
export function newTargetState() {
    return {
        hasBest: false, bestLcoe: 0, best: null,
        hasNw: false, nwLcoe: 0, noWind: null,
        hasFb: false, fbCf: 0, fbLcoe: 0, fb: null
    };
}

export function newBudgetState() {
    return {
        hasBest: false, bestFirm: 0, bestLcoe: 0, best: null,
        hasCheap: false, cheapLcoe: 0, cheap: null
    };
}

/**
 * Target-CF mode, one location (index `li` of the CSR). wind_mix rows join
 * `best` and `fb` (and are skipped when offshore is excluded); large rows join
 * `best` and `noWind`, never `fb`: per solar level, the guarded interpolated
 * build priced at CF = T where the first battery reaching T has one below it that
 * misses T, then every simulated point reaching T, in battery order.
 */
export function addonPassTarget(addon, li, pre, targetCf, includeOffshore, st,
    offMask = includeOffshore ? 0 : TECH_OFFSHORE) {
    if (!addon) return st;
    const k = addonCoeffs(pre);
    const mix = addon.sets.wind_mix;
    if (mix && includeOffshore) {
        const { offsets, cfg, cf, curt } = mix;
        const tm = offMask ? addonSetTechMask(mix) : null;
        for (let r = offsets[li], end = offsets[li + 1]; r < end; r++) {
            const annualCf = cf[r];
            if (!(annualCf > 0)) continue;
            const j = cfg[r];
            if (tm && (tm[j] & offMask)) continue;      // T074: a switched-off technology
            const lcoe = addonLcoe(k, mix.solar[j] * 1_000_000, mix.on[j] * 1_000_000, mix.off[j] * 1_000_000,
                mix.batt[j] * 1_000_000, annualCf);
            if (lcoe !== lcoe) continue;
            if (annualCf >= targetCf && (!st.hasBest || lcoe < st.bestLcoe)) {
                st.hasBest = true; st.bestLcoe = lcoe;
                st.best = candidate('wind_mix', j, mix, annualCf, curt[r], mix.batt[j], false, lcoe);
            }
            if (!st.hasFb || annualCf > st.fbCf || (annualCf === st.fbCf && lcoe < st.fbLcoe)) {
                st.hasFb = true; st.fbCf = annualCf; st.fbLcoe = lcoe;
                st.fb = candidate('wind_mix', j, mix, annualCf, curt[r], mix.batt[j], false, lcoe);
            }
        }
    }
    const large = addon.sets.large;
    if (large) {
        const { offsets, cfg, cf, curt, levelStart } = large;
        const guard = Number.isFinite(large.guard) ? large.guard : 0.00005;
        const tm = offMask ? addonSetTechMask(large) : null;
        const r0 = offsets[li], r1 = offsets[li + 1];
        // Rows of the location by j (every region has every config, but don't rely on it).
        let r = r0;
        for (let lv = 0; lv + 1 < levelStart.length; lv++) {
            const jStart = levelStart[lv], jEnd = levelStart[lv + 1];
            while (r < r1 && cfg[r] < jStart) r++;
            let prev = -1;              // previous row of this level (battery below)
            let hit = -1;
            for (let q = r; q < r1 && cfg[q] < jEnd; q++) {
                if (cf[q] >= targetCf) { hit = q; break; }
                prev = q;
            }
            if (hit < 0) continue;
            const jh = cfg[hit];
            // `j` is the config the candidate stands for: the upper point for an
            // interpolated build, the point itself otherwise.
            // T074: a switched-off technology skips the candidate. An interpolated
            // build stands for its upper point j, whose battery is > 0.
            const consider = (batt, annualCf, curtShare, interpolated, j) => {
                if (!(annualCf > 0)) return;
                if (tm && (tm[j] & offMask)) return;
                const lcoe = addonLcoe(k, large.solar[j] * 1_000_000, 0, 0, batt * 1_000_000, annualCf);
                if (lcoe !== lcoe) return;
                // Unit tests pass st.trace to see every large candidate, in the order priced.
                if (st.trace) st.trace.push(candidate('large', j, large, annualCf, curtShare, batt, interpolated, lcoe));
                if (!st.hasBest || lcoe < st.bestLcoe) {
                    st.hasBest = true; st.bestLcoe = lcoe;
                    st.best = candidate('large', j, large, annualCf, curtShare, batt, interpolated, lcoe);
                }
                if (!st.hasNw || lcoe < st.nwLcoe) {
                    st.hasNw = true; st.nwLcoe = lcoe;
                    st.noWind = candidate('large', j, large, annualCf, curtShare, batt, interpolated, lcoe);
                }
            };
            // The battery below must be the previous config of this level (contiguous axis).
            if (prev >= 0 && cfg[prev] === jh - 1 && cf[prev] < targetCf) {
                const c0 = cf[prev], c1 = cf[hit];
                const { b, frac } = interpolateBattery(targetCf, guard, large.batt[jh - 1], large.batt[jh], c0, c1);
                consider(b, targetCf, curt[prev] + frac * (curt[hit] - curt[prev]), true, jh);
            }
            // Every simulated point of the level that meets T competes too, in
            // battery order: a bigger battery can be cheaper per MWh (interface 4).
            for (let q = hit; q < r1 && cfg[q] < jEnd; q++) {
                if (cf[q] >= targetCf) consider(large.batt[cfg[q]], cf[q], curt[q], false, cfg[q]);
            }
        }
    }
    return st;
}

/**
 * Target-LCOE (budget) mode, one location: wind_mix rows (unless offshore is
 * excluded) and large rows at simulated points only (D-125) join `best`
 * (highest firm CF within the budget, then cheaper) and `cheap`.
 */
export function addonPassBudget(addon, li, pre, targetLcoe, includeOffshore, st,
    offMask = includeOffshore ? 0 : TECH_OFFSHORE) {
    if (!addon) return st;
    const k = addonCoeffs(pre);
    const visit = (setId, s) => {
        const { offsets, cfg, cf, curt } = s;
        const tm = offMask ? addonSetTechMask(s) : null;
        for (let r = offsets[li], end = offsets[li + 1]; r < end; r++) {
            const annualCf = cf[r];
            if (!(annualCf > 0)) continue;
            const j = cfg[r];
            if (tm && (tm[j] & offMask)) continue;      // T074: a switched-off technology
            const lcoe = addonLcoe(k, s.solar[j] * 1_000_000, s.on[j] * 1_000_000, s.off[j] * 1_000_000,
                s.batt[j] * 1_000_000, annualCf);
            if (lcoe !== lcoe) continue;
            if (lcoe <= targetLcoe) {
                const firmCf = k.backup ? 1 : clampCf(annualCf);
                if (!st.hasBest || firmCf > st.bestFirm || (firmCf === st.bestFirm && lcoe < st.bestLcoe)) {
                    st.hasBest = true; st.bestFirm = firmCf; st.bestLcoe = lcoe;
                    st.best = candidate(setId, j, s, annualCf, curt[r], s.batt[j], false, lcoe);
                }
            }
            if (!st.hasCheap || lcoe < st.cheapLcoe) {
                st.hasCheap = true; st.cheapLcoe = lcoe;
                st.cheap = candidate(setId, j, s, annualCf, curt[r], s.batt[j], false, lcoe);
            }
        }
    };
    if (addon.sets.wind_mix && includeOffshore) visit('wind_mix', addon.sets.wind_mix);
    if (addon.sets.large) visit('large', addon.sets.large);
    return st;
}

/**
 * The fields of an add-on winner's result row (each engine lays them out in
 * its own key order). An interpolated row's CF is the target and its battery b*.
 */
export function addonRowFields(c) {
    const both = c.set === 'wind_mix';
    const windGw = both ? c.on + c.off : 0;
    return {
        solar_gw: c.solar,
        wind_gw: windGw,
        batt_gwh: c.batt,
        annual_cf: c.cf,
        wind_surface: both ? 'both' : 'on',
        _solarKw: c.solar * 1_000_000,
        _windKw: windGw * 1_000_000,
        _batteryKwh: c.batt * 1_000_000,
        _annualEnergyMwh: c.cf * 8760 * BASE_LOAD_MW,
        _windOnKw: (both ? c.on : 0) * 1_000_000,
        _windOffKw: (both ? c.off : 0) * 1_000_000,
        wind_on_gw: both ? c.on : 0,
        wind_off_gw: both ? c.off : 0,
        curtailed_share: c.curt,
        addon: c.set,
        interpolated: c.interpolated
    };
}

/** wind_on_gw / wind_off_gw of a dense build. */
export function denseWindSplit(windGw, offshore) {
    const w = windGw || 0;
    return offshore ? { on: 0, off: w } : { on: w, off: 0 };
}

/**
 * One combined wind build's rows (onshore `on` + offshore `off`, every solar and
 * battery level) from a loaded wind_mix CSR, as decodeAddonPair gives them:
 * { n, on, off, id, solar, batt, cf, curt }. Lets the page take them from the
 * LCOE worker (or the ?worker=0 matrix) instead of fetching and decoding the file again.
 */
export function addonPairColumns(set, locationIds, on, off) {
    const { offsets, cfg, cf, curt } = set;
    const want = new Uint8Array(set.nCfg);
    for (let j = 0; j < set.nCfg; j++) want[j] = set.on[j] === on && set.off[j] === off ? 1 : 0;
    let n = 0;
    for (let r = 0; r < cfg.length; r++) n += want[cfg[r]];
    const out = {
        n, on, off,
        id: new Float64Array(n), solar: new Float64Array(n), batt: new Float64Array(n),
        cf: new Float32Array(n), curt: new Float32Array(n)
    };
    let k = 0;
    for (let li = 0; li + 1 < offsets.length; li++) {
        for (let r = offsets[li]; r < offsets[li + 1]; r++) {
            const j = cfg[r];
            if (!want[j]) continue;
            out.id[k] = Number(locationIds[li]);
            out.solar[k] = set.solar[j];
            out.batt[k] = set.batt[j];
            out.cf[k] = cf[r];
            out.curt[k] = curt[r];
            k++;
        }
    }
    return out;
}
