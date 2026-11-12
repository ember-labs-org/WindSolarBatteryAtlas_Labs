// Node unit tests of the add-on pass (deployment/js/addon.js, T058) on small
// synthetic CSRs: ties, first point meets T, T above the axis top, the guard at
// the upper point, includeOffshore false, backup on and fractional battery
// pricing. The add-on's prices are also checked against the engines' own
// computeLcoeMetrics (worker) and computeLcoeMetricsFast (app.js), extracted
// from their source, for single-surface, no-wind and combined rows.
// No browser and no data files: run with `node checks/addon_unit.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(process.env.ATLAS_SITE || path.join(HERE, '..', 'deployment'));
const A = await import(pathToFileURL(path.join(SITE, 'js', 'addon.js')).href);

const results = [];
const check = (ok, name, detail = '') => results.push({ ok: !!ok, name, detail });

// ---------------------------------------------------------------------------
// The engines' pricing functions, extracted from their source (as check_cost does).
// ---------------------------------------------------------------------------
function extract(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1);
}
const workerSrc = fs.readFileSync(path.join(SITE, 'js', 'workers', 'lcoe-worker.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(SITE, 'js', 'app.js'), 'utf8');
const prelude = `const BASE_LOAD_MW = 1000;
function clampCf(v) { if (!Number.isFinite(v)) return 0; return Math.max(0, Math.min(1, v)); }`;
const workerMetrics = new Function('blendedDegradation3', `${prelude}
${extract(workerSrc, 'blendedDegradation')}
${extract(workerSrc, 'computeLcoeMetrics')}
return computeLcoeMetrics;`)(A.blendedDegradation3);
const appMetrics = new Function('blendedDegradation3', `${prelude}
${extract(appSrc, 'blendedDegradation')}
${extract(appSrc, 'computeLcoeMetricsFast')}
return computeLcoeMetricsFast;`)(A.blendedDegradation3);

// A location's `pre`, in both engines' naming, with odd numbers so every term matters.
function makePre(backup = false, gas = true) {
    const common = {
        includeDieselBackup: backup, solarCapexPerKw: 512.3, windOnCrf: 0.0812, windOffCrf: 0.0934,
        windOpexPct: 0.025, windOffOpexPct: 0.035, solarCrf: 0.0721, batteryCrf: 0.1103,
        solarOpexPct: 0.015, batteryOpexPct: 0.02, energyDegradationMult: 0.9712,
        windOnDegradationMult: 0.9834, windOffDegradationMult: 0.9791,
        solarUnitCf: 0.1734, windOnUnitCf: 0.3121, windOffUnitCf: 0.4417,
        dieselPricing: backup ? { effectivePrice: 1.1 } : null, dieselFuelCostPerMwh: backup ? 314.3 : 0,
        dieselCapexAnnual: backup ? 33_123_456 : 0, dieselContext: null,
        gasAvailable: backup && gas, gasPricing: null, gasFuelCostPerMwh: backup && gas ? 61.7 : Infinity,
        gasCapexAnnual: backup && gas ? 71_234_567 : 0, gasContext: null
    };
    return {
        worker: { ...common, batteryCapexBase: 231.7, windOnCapexBase: 1312.4, windOffCapexBase: 3423.9 },
        app: { ...common, baseBatteryCapex: 231.7, baseWindOnCapex: 1312.4, baseWindOffCapex: 3423.9 }
    };
}

function rowFor(f, locationId = 7) {
    return { location_id: locationId, solar_gw: f.solar_gw, wind_gw: f.wind_gw, batt_gwh: f.batt_gwh,
        annual_cf: f.annual_cf, wind_surface: f.wind_surface, _solarKw: f._solarKw, _windKw: f._windKw,
        _batteryKwh: f._batteryKwh, _annualEnergyMwh: f._annualEnergyMwh, _windOnKw: f._windOnKw, _windOffKw: f._windOffKw };
}

// ---------------------------------------------------------------------------
// Synthetic add-on: 2 locations; wind_mix pairs (1,1) and (2,1) x solar {0,1} x batt {0,2};
// large: solar {20, 30} x batt {36, 48, 96} (j 0-5).
// ---------------------------------------------------------------------------
function makeAddon({ mixCf, largeCf, largeCurt = null }) {
    const mixSet = { id: 'wind_mix', configs: [] };
    for (const [on, off] of [[1, 1], [2, 1]]) for (const solar of [0, 1]) for (const batt of [0, 2]) {
        mixSet.configs.push({ j: mixSet.configs.length, solar, batt, on, off });
    }
    const largeSet = { id: 'large', guard: 0.00005, configs: [] };
    for (const solar of [20, 30]) for (const batt of [36, 48, 96]) largeSet.configs.push({ j: largeSet.configs.length, solar, batt });
    const toCols = (set, cfByLoc, curtByLoc) => {
        const cols = { location_id: [], cfg: [], annual_cf: [], curtailed_share: [] };
        for (let j = 0; j < set.configs.length; j++) {
            for (const [loc, cfs] of Object.entries(cfByLoc)) {
                cols.location_id.push(Number(loc)); cols.cfg.push(j); cols.annual_cf.push(Math.fround(cfs[j]));
                cols.curtailed_share.push(Math.fround(curtByLoc?.[loc]?.[j] ?? 0.1 * j));
            }
        }
        return { location_id: Int32Array.from(cols.location_id), cfg: Uint16Array.from(cols.cfg),
            annual_cf: Float32Array.from(cols.annual_cf), curtailed_share: Float32Array.from(cols.curtailed_share) };
    };
    const ids = [3, 7];
    const sets = {};
    sets.wind_mix = { id: 'wind_mix', ...A.buildAddonCsr(mixSet, toCols(mixSet, mixCf), ids), ...A.addonConfigArrays(mixSet), guard: null };
    sets.large = { id: 'large', ...A.buildAddonCsr(largeSet, toCols(largeSet, largeCf, largeCurt), ids), ...A.addonConfigArrays(largeSet), guard: 0.00005 };
    return { sets };
}

const lo = new Array(8).fill(0.1);
const pre = makePre(false);
const k = A.addonCoeffs(pre.worker);

// 1. Pricing equals both engines, for every add-on row kind.
{
    const cands = [
        { set: 'wind_mix', j: 0, solar: 1, on: 2, off: 1, batt: 2, cf: Math.fround(0.8123), curt: 0.1, interpolated: false },
        { set: 'wind_mix', j: 0, solar: 0, on: 1, off: 3, batt: 0, cf: Math.fround(0.4567), curt: 0.1, interpolated: false },
        { set: 'large', j: 0, solar: 30, on: 0, off: 0, batt: 1234.5678, cf: 0.99, curt: 0.2, interpolated: true },
        { set: 'large', j: 0, solar: 200, on: 0, off: 0, batt: 4608, cf: Math.fround(0.9987), curt: 0.2, interpolated: false }
    ];
    let worst = 0, n = 0;
    for (const backup of [false, true]) for (const gas of [true, false]) {
        const p = makePre(backup, gas);
        const kk = A.addonCoeffs(p.worker);
        const kApp = A.addonCoeffs(p.app);
        for (const c of cands) {
            const f = A.addonRowFields(c);
            const mine = A.addonLcoe(kk, f._solarKw, f._windOnKw, f._windOffKw, f._batteryKwh, f.annual_cf);
            const mineApp = A.addonLcoe(kApp, f._solarKw, f._windOnKw, f._windOffKw, f._batteryKwh, f.annual_cf);
            const w = workerMetrics(rowFor(f), p.worker).lcoe;
            const a = appMetrics(rowFor(f), p.app).lcoe;
            n++;
            if (!(mine === w && mine === a && mineApp === a)) worst = Math.max(worst, Math.abs(mine - w), Math.abs(mine - a), 1e-300);
        }
    }
    check(worst === 0, 'addonLcoe equals computeLcoeMetrics (worker) and computeLcoeMetricsFast (app.js) bit for bit',
        `${n} rows (combined, large interpolated and simulated; backup off/on, gas on/off); worst |diff| ${worst}`);
    // The combined branch really is three-source: a two-source blend would give another number.
    const f = A.addonRowFields(cands[0]);
    const three = workerMetrics(rowFor(f), pre.worker).lcoe;
    const asOnshore = workerMetrics({ ...rowFor(f), wind_surface: 'on' }, pre.worker).lcoe;
    check(three !== asOnshore, 'the combined branch differs from pricing all wind as onshore', `${three} vs ${asOnshore}`);
}

// 2. Ties: an add-on row priced exactly at the dense best loses; first j wins among add-on rows.
{
    const addon = makeAddon({ mixCf: { 3: lo, 7: [0.5, 0.85, 0.5, 0.85, 0.5, 0.85, 0.5, 0.85] }, largeCf: { 3: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], 7: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1] } });
    const mix = addon.sets.wind_mix;
    const li = 1;   // location 7
    // The cheapest wind_mix row meeting 0.8: price every one, find the min.
    const prices = [];
    for (let r = mix.offsets[li]; r < mix.offsets[li + 1]; r++) {
        const j = mix.cfg[r];
        if (mix.cf[r] >= 0.8) prices.push({ j, lcoe: A.addonLcoe(k, mix.solar[j] * 1e6, mix.on[j] * 1e6, mix.off[j] * 1e6, mix.batt[j] * 1e6, mix.cf[r]) });
    }
    const min = prices.reduce((a, b) => (b.lcoe < a.lcoe ? b : a));
    let st = A.newTargetState();
    st.hasBest = true; st.bestLcoe = min.lcoe; st.hasFb = true; st.fbCf = 0.9; st.fbLcoe = 1;
    A.addonPassTarget(addon, li, pre.worker, 0.8, true, st);
    check(st.best === null && st.bestLcoe === min.lcoe, 'tie: an add-on row equal to the dense best does not replace it', `bestLcoe ${st.bestLcoe}`);
    st = A.newTargetState();
    st.hasBest = true; st.bestLcoe = min.lcoe * (1 + 1e-12); st.hasFb = true; st.fbCf = 0.9; st.fbLcoe = 1;
    A.addonPassTarget(addon, li, pre.worker, 0.8, true, st);
    check(st.best && st.best.j === min.j, 'an add-on row strictly cheaper than the dense best replaces it', `j ${st.best?.j}`);
    // Fallback tie: same CF and same LCOE as the dense max-config keeps the dense one.
    const r0 = mix.offsets[li] + 1;   // j 1: cf 0.85
    const j1 = mix.cfg[r0];
    const l1 = A.addonLcoe(k, mix.solar[j1] * 1e6, mix.on[j1] * 1e6, mix.off[j1] * 1e6, mix.batt[j1] * 1e6, mix.cf[r0]);
    st = A.newTargetState();
    st.hasFb = true; st.fbCf = mix.cf[r0]; st.fbLcoe = l1;
    A.addonPassTarget(addon, li, pre.worker, 0.99, true, st);
    // Rows with cf 0.85 that are cheaper than j 1 could still win; only an exact tie must not.
    const cheaperSameCf = prices.some(p => p.j !== j1 && p.lcoe < l1);
    check(cheaperSameCf ? st.fb !== null : st.fb === null, 'tie: the fallback keeps the dense build on equal CF and LCOE', `fb ${JSON.stringify(st.fb && st.fb.j)}`);
    // Two add-on rows at exactly the same price: the lower j wins. Build a CSR with identical rows.
    const dup = makeAddon({ mixCf: { 3: lo, 7: lo }, largeCf: { 3: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], 7: [0.995, 0.995, 0.995, 0.995, 0.995, 0.995] } });
    dup.sets.large.solar.fill(20); dup.sets.large.batt.fill(36);   // every large config the same build
    dup.sets.large.levelStart = Int32Array.from([0, 1, 2, 3, 4, 5, 6]);
    st = A.newTargetState();
    A.addonPassTarget(dup, 1, pre.worker, 0.99, true, st);
    check(st.best && st.best.set === 'large' && st.best.j === 0 && st.noWind.j === 0, 'tie between add-on rows: the first in j order wins', `best j ${st.best?.j}`);
}

// 3. Large rows: first point meets T, interpolation, guard at the upper point, T above the axis top.
{
    const T = 0.9;
    const none = [0.1, 0.1, 0.1];
    const price = (solar, batt, cf) => A.addonLcoe(k, solar * 1e6, 0, 0, batt * 1e6, cf);
    // (a) solar 20 only: the first battery (36) already meets T -> the simulated point, not interpolated.
    let addon = makeAddon({ mixCf: { 3: lo, 7: lo }, largeCf: { 3: [0.92, 0.95, 0.97, ...none], 7: [...none, ...none] } });
    let st = A.newTargetState();
    A.addonPassTarget(addon, 0, pre.worker, T, true, st);
    check(st.best && st.best.j === 0 && st.best.batt === 36 && !st.best.interpolated && st.bestLcoe === price(20, 36, Math.fround(0.92))
        && st.noWind && st.nwLcoe === st.bestLcoe,
        'first point meets T: the simulated point, for best and noWind', JSON.stringify({ j: st.best?.j, b: st.best?.batt, i: st.best?.interpolated }));
    check(!st.fb || st.fb.set !== 'large', 'large rows never enter the fallback / max-config', JSON.stringify(st.fb && st.fb.set));
    // (b) solar 30 only, T between batteries 48 and 96: interpolated b* and the grid point 96 are both candidates.
    addon = makeAddon({ mixCf: { 3: lo, 7: lo }, largeCf: { 3: [...none, 0.85, 0.89, 0.93], 7: [...none, ...none] },
        largeCurt: { 3: [0, 0, 0, 0.4, 0.5, 0.7], 7: [0, 0, 0, 0, 0, 0] } });
    const c48 = Math.fround(0.89), c96 = Math.fround(0.93);
    const tp = Math.min(T + 0.00005, c96);
    const frac = (tp - c48) / (c96 - c48);
    const bStar = 48 + (tp - c48) / (c96 - c48) * (96 - 48);
    const pI = price(30, bStar, T), pG = price(30, 96, c96);
    st = A.newTargetState();
    A.addonPassTarget(addon, 0, pre.worker, T, true, st);
    const b = st.best;
    check(b && b.lcoe === Math.min(pI, pG) && b.interpolated === (pI <= pG), 'interpolated b* and its grid point are both priced; the cheaper wins',
        `interpolated ${pI}, grid ${pG}`);
    if (b && b.interpolated) {
        check(b.batt === bStar && b.cf === T && Math.abs(b.curt - (Math.fround(0.5) + frac * (Math.fround(0.7) - Math.fround(0.5)))) < 1e-15,
            'interpolated build: b* by the guarded linear rule, CF = T, curtailment on the same fraction', `b* ${b.batt}`);
        check(b.batt > 48 && b.batt < 96 && !Number.isInteger(b.batt), 'fractional battery from interpolation', `${b.batt}`);
        const f = A.addonRowFields(b);
        const w = workerMetrics(rowFor(f), pre.worker);
        check(w.lcoe === b.lcoe && f._batteryKwh === b.batt * 1e6 && f._annualEnergyMwh === T * 8760 * 1000 && f.batt_gwh === b.batt && f.annual_cf === T,
            'fractional battery priced at b* x 1e6 kWh and CF = T, equal to computeLcoeMetrics', `${w.lcoe}`);
    }
    // Every simulated point meeting T is a candidate, after the interpolated one, in battery order.
    {
        const a2 = makeAddon({ mixCf: { 3: lo, 7: lo }, largeCf: { 3: [0.80, 0.95, 0.99, ...none], 7: [...none, ...none] } });
        const s2 = A.newTargetState();
        s2.trace = [];
        A.addonPassTarget(a2, 0, pre.worker, T, true, s2);
        check(s2.trace.map(c => `${c.batt}${c.interpolated ? 'i' : ''}`).join(',') === `${s2.trace[0]?.batt}i,48,96`
            && s2.trace[0].batt > 36 && s2.trace[0].batt < 48,
            'every grid point meeting T competes, after the interpolated build, in battery order',
            s2.trace.map(c => `${c.batt.toFixed(3)}${c.interpolated ? 'i' : ''}`).join(','));
    }
    // The grid point wins when the dense best already sits between the two prices.
    st = A.newTargetState();
    st.hasBest = true; st.bestLcoe = Math.max(pI, pG);
    A.addonPassTarget(addon, 0, pre.worker, T, true, st);
    check(st.best && st.bestLcoe === Math.min(pI, pG), 'only a strictly cheaper candidate replaces the running best');
    // (c) T above the axis top at every level: no large candidate.
    addon = makeAddon({ mixCf: { 3: lo, 7: lo }, largeCf: { 3: [0.80, 0.88, 0.89, 0.80, 0.85, 0.87], 7: [...none, ...none] } });
    st = A.newTargetState();
    A.addonPassTarget(addon, 0, pre.worker, T, true, st);
    check(!st.hasBest && !st.hasNw, 'T above the top of the battery axis: no large candidate', JSON.stringify(st.best));
    // (d) Guard at the upper point: c_hi just above T (inside the guard) -> b* = b_hi exactly, still interpolated.
    addon = makeAddon({ mixCf: { 3: lo, 7: lo }, largeCf: { 3: [0.80, 0.85, 0.90002, ...none], 7: [...none, ...none] } });
    st = A.newTargetState();
    A.addonPassTarget(addon, 0, pre.worker, T, true, st);
    const pInterp = price(20, 96, T), pGrid = price(20, 96, Math.fround(0.90002));
    check(st.best && st.best.batt === 96 && st.best.interpolated === (pInterp <= pGrid),
        'guard at the upper point: b* = b_hi exactly (T + guard passes c_hi)', `best batt ${st.best?.batt}, interpolated ${st.best?.interpolated}; ${pInterp} vs ${pGrid}`);
    st = A.newTargetState();
    st.trace = [];
    A.addonPassTarget(addon, 0, pre.worker, T, true, st);
    check(st.trace.length === 2 && st.trace[0].interpolated && st.trace[0].batt === 96 && st.trace[0].cf === T
        && !st.trace[1].interpolated && st.trace[1].batt === 96 && st.trace[0].j === 2 && st.trace[1].j === 2,
        'guard at the upper point: the interpolated candidate has b* = b_hi exactly and comes before the grid point',
        JSON.stringify(st.trace.map(c => [c.batt, c.cf, c.interpolated])));
    const ib = A.interpolateBattery(T, 0.00005, 48, 96, Math.fround(0.85), Math.fround(0.90002));
    check(ib.b === 96 && ib.frac === 1, 'interpolateBattery caps T + guard at c_hi and returns b_hi exactly', JSON.stringify(ib));
    // Budget mode: large rows at simulated points only.
    addon = makeAddon({ mixCf: { 3: lo, 7: lo }, largeCf: { 3: [...none, 0.85, 0.89, 0.93], 7: [...none, ...none] } });
    const sb = A.newBudgetState();
    A.addonPassBudget(addon, 0, pre.worker, 1e9, true, sb);
    check(sb.best && !sb.best.interpolated && sb.cheap && !sb.cheap.interpolated && Number.isInteger(sb.best.batt),
        'budget mode: large rows at simulated points only', JSON.stringify({ best: sb.best?.batt, cheap: sb.cheap?.batt }));
}

// 4. includeOffshore false: wind_mix skipped, large used.
{
    const addon = makeAddon({ mixCf: { 3: [0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95], 7: lo },
        largeCf: { 3: [0.95, 0.96, 0.97, 0.95, 0.96, 0.97], 7: lo.slice(0, 6) } });
    const on = A.newTargetState();
    A.addonPassTarget(addon, 0, pre.worker, 0.9, true, on);
    const off = A.newTargetState();
    A.addonPassTarget(addon, 0, pre.worker, 0.9, false, off);
    check(on.fb && on.fb.set === 'wind_mix', 'offshore included: wind_mix rows reach the fallback');
    check(!off.fb && off.best && off.best.set === 'large' && off.noWind, 'offshore excluded: no wind_mix row anywhere; large rows still used',
        JSON.stringify({ best: off.best?.set, fb: off.fb }));
    const ob = A.newBudgetState();
    A.addonPassBudget(addon, 0, pre.worker, 1e9, false, ob);
    check(ob.best?.set === 'large' && ob.cheap?.set === 'large', 'offshore excluded (budget): only large rows');
}

// 5. Backup on: energy is the full baseload; the backup serves the full load less the
// renewables' degraded energy (CF, or T for an interpolated row, x the degradation), cheaper fuel.
{
    const p = makePre(true, true);
    const kb = A.addonCoeffs(p.worker);
    const T = 0.9;
    const solarKw = 30e6, battKwh = 61.234e6;
    const cost = (() => {
        const sc = 512.3 * solarKw, bc = 231.7 * battKwh, wc = 1312.4 * 0;
        return sc * 0.0721 + bc * 0.1103 + wc * 0.0812 + sc * 0.015 + bc * 0.02 + wc * 0.025;
    })();
    const backupE = Math.max(0, 8760 * 1000 - T * 8760 * 1000 * 0.9712);   // no wind: the solar degradation
    const diesel = 33_123_456 + backupE * 314.3, gas = 71_234_567 + backupE * 61.7;
    const want = (cost + Math.min(diesel, gas)) / (8760 * 1000);
    const got = A.addonLcoe(kb, solarKw, 0, 0, battKwh, T);
    check(got === want, 'backup on: full baseload, backup on the load less the degraded T, cheaper of diesel and gas (independent formula)', `${got} vs ${want}`);
    // The old rule (backup on 1 - T, the degradation ignored) gives another number.
    const oldE = Math.max(0, 1 - T) * 8760 * 1000;
    const wantOld = (cost + Math.min(33_123_456 + oldE * 314.3, 71_234_567 + oldE * 61.7)) / (8760 * 1000);
    check(got !== wantOld && got > wantOld, 'backup on: the backup also covers what the renewables lose to ageing', `${got} vs ${wantOld}`);
    const addon = makeAddon({ mixCf: { 3: lo, 7: lo }, largeCf: { 3: [0.85, 0.89, 0.93, 0.1, 0.1, 0.1], 7: lo.slice(0, 6) } });
    const st = A.newTargetState();
    A.addonPassTarget(addon, 0, p.worker, T, true, st);
    check(st.best && st.best.set === 'large', 'backup on: large rows still searched in target mode', JSON.stringify({ b: st.best?.batt, i: st.best?.interpolated }));
}

// 6. CSR building: offsets, ascending j per location, unknown locations dropped.
{
    const set = { id: 'wind_mix', configs: [0, 1, 2].map(j => ({ j, solar: j, batt: 0, on: 1, off: 1 })) };
    const cols = { location_id: Int32Array.from([5, 9, 5, 9, 11, 5]), cfg: Uint16Array.from([0, 0, 1, 1, 1, 2]),
        annual_cf: Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), curtailed_share: Float32Array.from([0, 0, 0, 0, 0, 0]) };
    const c = A.buildAddonCsr(set, cols, [5, 9]);
    check(Array.from(c.offsets).join() === '0,3,5' && Array.from(c.cfg).join() === '0,1,2,0,1',
        'CSR over the matrix location order: offsets and ascending config per location', `${Array.from(c.offsets)} / ${Array.from(c.cfg)}`);
}

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'} addon-unit ${r.name}${r.detail ? ` – ${r.detail}` : ''}`);
}
console.log(`${failed ? 'FAIL' : 'PASS'} addon-unit ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
