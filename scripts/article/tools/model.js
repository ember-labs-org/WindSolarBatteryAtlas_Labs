// model.js – the numbers behind "Harnessing the Winds", computed with the main
// atlas's own data and LCOE engine. Not published: build-summary.mjs and
// verify-article.mjs run it in the pinned Chromium, with deployment/ served at
// the root and this folder at /__article_tools/, so the relative URLs below
// resolve to the site's own worker and data.
//
// The searches run in the main app's worker (deployment/js/workers/lcoe-worker.js),
// the same code that draws the atlas's cost maps, with the app's default
// parameters except costs: Capex and WACC Local, as the atlas's Local mode (T077;
// no backup, both wind surfaces), and the base year pinned to 2026 (D-088: the article's numbers are 2026 costs; the
// app itself takes the calendar year). The aggregations mirror
// scripts/article/analyse.py (T040), so every value can be checked against the
// committed analysis outputs.

const APP_WORKER_URL = new URL('../js/workers/lcoe-worker.js', import.meta.url);
const DATA_URL = new URL('../data/', import.meta.url);
// Solar potential cases (T085, the app's Potential view: deployment/js/app.js SOLAR_DENSITY_CASES), MW/km² DC.
const SOLAR_DENSITY_LOW = 40, SOLAR_DENSITY_HIGH = 60;

export const BASE_YEAR = 2026;

// "Weak wind" (T063, definition W1; calibrated level since T068, D-146): a region whose
// windiest fifth of eligible land, and of eligible sea, averages below this net capacity
// factor after the level factors (on_cf_best x on_level_factor, likewise offshore; a
// missing factor counts as 1). The one place this
// threshold is set for the article's model; analyse.py WEAK_WIND_CF must match
// (verify-article compares the two through t1.noViable.* and nv.India.*).
export const WEAK_WIND_CF = 0.15;

// The sparse add-on builds (T058, D-127: the article's numbers include them),
// asked for explicitly in LOAD_MATRIX: no silent default. addon.json is pinned by
// its SHA-256; the run fails if the file differs or the worker does not load both
// sets, and verify-article.mjs fails if the payload lacks the add-on.
export const ADDON_REQUEST = Object.freeze({ manifest: 'addon.json', sets: Object.freeze(['wind_mix', 'large']) });
export const ADDON_JSON_SHA256 = '4861497ded8d42712af36414a27a1a7ff5c5bb00eba17fce22a96bfd2b61892b';

/** What is wrong with a LOAD_MATRIX payload's add-on request ([] if nothing). */
export function addonPayloadProblems(payload) {
    const a = payload?.addon;
    if (!a) return ['the LOAD_MATRIX payload has no add-on'];
    const out = [];
    if (a.manifest !== ADDON_REQUEST.manifest) out.push(`add-on manifest ${JSON.stringify(a.manifest)}, not ${ADDON_REQUEST.manifest}`);
    if (JSON.stringify(a.sets) !== JSON.stringify(ADDON_REQUEST.sets)) out.push(`add-on sets ${JSON.stringify(a.sets)}, not ${JSON.stringify(ADDON_REQUEST.sets)}`);
    return out;
}

// app.js `lcoeParams` defaults, the fields the worker reads. Copied, because
// app.js is not a module that can be imported; verify-article.mjs fails if
// any of these no longer appears verbatim in app.js.
export const LCOE_PARAMS = {
    solarCapex: 720,
    batteryCapex: 120,
    solarOpexPct: 0.015,
    batteryOpexPct: 0.02,
    solarDegradationPct: 0.005,
    solarLife: 30,
    batteryLife: 20,
    windWaccPremium: 0.0,
    windOffWaccPremium: 0.0092,
    windOpexPct: 0.025,
    windOffOpexPct: 0.035,
    windLife: 30,
    windOffLife: 30,
    windDegradationPct: 0.002,
    windOffDegradationPct: 0.002,
    includeOffshore: true,
    wacc: 0.07,
    ilr: 1.3,
    includeDieselBackup: false
};

// app.js WIND_GLOBAL_COST_INPUTS and WIND_GLOBAL_CAPEX (D-066).
export const WIND_GLOBAL_COST_INPUTS = {
    onshoreObserved: { 2023: 1216.084, 2024: 1066.656, 2025: 972.84 },
    onshoreRefined2025: 1025.743,
    onshoreRefined2035: 792.491,
    offshoreGlobal2025: 2930.949,
    deaFixedAc: { 2025: 2.780229479, 2035: 2.248224305, 2050: 1.985692992 }
};
export const WIND_GLOBAL_CAPEX = (() => {
    const s = WIND_GLOBAL_COST_INPUTS;
    const observed = Object.values(s.onshoreObserved);
    const onAnchor = observed.reduce((a, b) => a + b, 0) / observed.length;
    const on2035 = s.onshoreRefined2035;
    const on2050 = on2035 * Math.pow(s.onshoreRefined2035 / s.onshoreRefined2025, 15 / 10);
    const off = s.offshoreGlobal2025;
    const dea = s.deaFixedAc;
    return {
        on: { 2024: onAnchor, 2035: on2035, 2050: on2050 },
        off: { 2024: off, 2035: off * dea[2035] / dea[2025], 2050: off * dea[2050] / dea[2025] }
    };
})();
LCOE_PARAMS.windCapex = Math.round(WIND_GLOBAL_CAPEX.on[2024]);     // 1,085
LCOE_PARAMS.windOffCapex = Math.round(WIND_GLOBAL_CAPEX.off[2024]); // 2,931

// app.js LCOE_TIME_ANCHORS with baseYear = 2026.
const TIME_ANCHORS = (() => {
    const b = BASE_YEAR;
    const windFactors = (p) => [
        { year: b, factor: 1.0 }, { year: 2035, factor: p[2035] / p[2024] }, { year: 2050, factor: p[2050] / p[2024] }
    ];
    return {
        solar: [{ year: b, factor: 1.0 }, { year: 2035, factor: 0.61 }, { year: 2050, factor: 0.50 }],
        battery: [{ year: b, factor: 1.0 }, { year: 2035, factor: 0.66 }, { year: 2050, factor: 0.55 }],
        wind: windFactors(WIND_GLOBAL_CAPEX.on),
        windOff: windFactors(WIND_GLOBAL_CAPEX.off)
    };
})();

function interpolateFactor(year, anchors) {
    if (year <= anchors[0].year) return anchors[0].factor;
    for (let i = 0; i < anchors.length - 1; i += 1) {
        const a = anchors[i], b = anchors[i + 1];
        if (year <= b.year) {
            const t = (year - a.year) / (b.year - a.year || 1);
            return a.factor + t * (b.factor - a.factor);
        }
    }
    return anchors[anchors.length - 1].factor;
}

/** app.js applyLcoeTimeYear: capex multipliers for a year (clamped to 2026-2050). */
export function costMultipliers(year) {
    const y = Math.max(BASE_YEAR, Math.min(2050, year));
    return {
        solar: interpolateFactor(y, TIME_ANCHORS.solar),
        battery: interpolateFactor(y, TIME_ANCHORS.battery),
        wind: interpolateFactor(y, TIME_ANCHORS.wind),
        windOff: interpolateFactor(y, TIME_ANCHORS.windOff)
    };
}

/** Global-mode capex for a year, $/kW: what the take 5 text quotes. */
export function windCapex(year) {
    const m = costMultipliers(year);
    return { on: LCOE_PARAMS.windCapex * m.wind, off: LCOE_PARAMS.windOffCapex * m.windOff };
}

// ---------------------------------------------------------------------------
// Small data helpers
// ---------------------------------------------------------------------------
export function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
            } else field += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
        } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const head = rows.shift() || [];
    return { head, rows };
}

async function fetchCsv(file) {
    const r = await fetch(new URL(file, DATA_URL));
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
    return parseCsv(await r.text());
}

function column(csv, name) {
    const i = csv.head.indexOf(name);
    if (i < 0) throw new Error(`column ${name} missing`);
    return csv.rows.map(r => r[i]);
}

const toNum = (s) => (s === '' || s == null ? NaN : Number(s));

/** numpy-style weighted median (analyse.py wmedian): values may be +Infinity;
 *  null when there is no weight or the median is infinite. */
export function wmedian(values, weights, sel = null) {
    const idx = [];
    let total = 0;
    for (let i = 0; i < values.length; i++) {
        if (sel && !sel[i]) continue;
        const w = weights[i], v = values[i];
        if (!(w > 0) || Number.isNaN(v)) continue;
        idx.push(i);
    }
    if (!idx.length) return null;
    idx.sort((a, b) => (values[a] < values[b] ? -1 : values[a] > values[b] ? 1 : 0)); // stable
    const cw = new Float64Array(idx.length);
    for (let k = 0; k < idx.length; k++) { total += weights[idx[k]]; cw[k] = total; }
    if (!(total > 0)) return null;
    const half = 0.5 * cw[cw.length - 1];
    let lo = 0, hi = cw.length;             // searchsorted, side='left'
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cw[mid] < half) lo = mid + 1; else hi = mid; }
    const med = values[idx[Math.min(lo, idx.length - 1)]];
    return Number.isFinite(med) ? med : null;
}

/** Share of the weight (over `sel`, default all) where mask holds. */
export function share(mask, weights, sel = null) {
    let num = 0, den = 0;
    for (let i = 0; i < weights.length; i++) {
        if (sel && !sel[i]) continue;
        den += weights[i];
        if (mask[i]) num += weights[i];
    }
    return den > 0 ? num / den : null;
}

// ---------------------------------------------------------------------------
// The main app's worker
// ---------------------------------------------------------------------------
// A worker that says nothing for this long is treated as hung and the run fails
// (so a build or check stops rather than waiting for ever). Progress messages
// restart the clock.
const TIMEOUT_MS = { LOAD_MATRIX: 120000, SET_LOOKUPS: 30000, COMPUTE_BEST_LCOE: 60000, LOAD_SLICE: 120000 };
function timeoutFor(type) {
    return TIMEOUT_MS[type] || 60000;
}

function workerClient(url) {
    const worker = new Worker(url, { type: 'module' });
    let seq = 0;
    const pending = new Map();
    const arm = (job) => {
        clearTimeout(job.timer);
        job.timer = setTimeout(() => {
            pending.delete(job.requestId);
            worker.terminate();
            job.reject(new Error(`${job.type}: no answer from the LCOE worker within ${Math.round(timeoutFor(job.type) / 1000)} s`));
        }, timeoutFor(job.type));
    };
    worker.onmessage = (event) => {
        const { type, requestId, payload } = event.data || {};
        const job = pending.get(requestId);
        if (!job) return;
        if (type === 'PROGRESS') { arm(job); job.onProgress?.(payload); return; }
        clearTimeout(job.timer);
        pending.delete(requestId);
        if (type === 'RESULT') job.resolve(payload);
        else job.reject(new Error(payload?.message || 'worker error'));
    };
    worker.onerror = (event) => {
        event.preventDefault?.();
        const err = new Error(event.message || 'worker failed');
        pending.forEach((job) => { clearTimeout(job.timer); job.reject(err); });
        pending.clear();
    };
    return {
        post(type, payload, { transfer = [], onProgress } = {}) {
            const requestId = ++seq;
            return new Promise((resolve, reject) => {
                const job = { requestId, type, resolve, reject, onProgress, timer: null };
                pending.set(requestId, job);
                arm(job);
                worker.postMessage({ type, requestId, payload }, transfer);
            });
        },
        terminate() { worker.terminate(); }
    };
}

/** One summary slice's columns from the app's loader (lcoe-worker.js?load). */
function loadSlice(file) {
    return new Promise((resolve, reject) => {
        const loader = new Worker(new URL(APP_WORKER_URL.href + '?load'), { type: 'module' });
        const timer = setTimeout(() => {
            loader.terminate();
            reject(new Error(`LOAD_SLICE ${file}: no answer within ${Math.round(timeoutFor('LOAD_SLICE') / 1000)} s`));
        }, timeoutFor('LOAD_SLICE'));
        loader.onmessage = (event) => {
            clearTimeout(timer);
            loader.terminate();
            const { type, payload } = event.data || {};
            if (type === 'RESULT') resolve(payload);
            else reject(new Error(payload?.message || `slice loader failed: ${file}`));
        };
        loader.onerror = (event) => { event.preventDefault?.(); clearTimeout(timer); loader.terminate(); reject(new Error(event.message || 'loader failed')); };
        loader.postMessage({ type: 'LOAD_SLICE', file });
    });
}

/** Worker answer (columns, as encodeRows sends them) into per-cell arrays. */
function decodeAnswer(reply, cells) {
    const n = cells.n;
    const out = {
        priced: new Uint8Array(n), meets: new Uint8Array(n), lcoe: new Float64Array(n).fill(NaN),
        nwMeets: new Uint8Array(n), nwLcoe: new Float64Array(n).fill(NaN), saving: new Float64Array(n).fill(NaN),
        windShare: new Float64Array(n).fill(NaN), solarGw: new Float64Array(n), windGw: new Int8Array(n),
        battGwh: new Float64Array(n), off: new Uint8Array(n), cf: new Float64Array(n).fill(NaN),
        // The build's delivered energy after degradation, MWh a year (T095: cost per MWh of the full load).
        energy: new Float64Array(n).fill(NaN),
        // The no-wind comparator (T058): a slider build without wind meets the target;
        // the no-wind build is a large add-on build; its solar and battery.
        nwStd: new Uint8Array(n), nwLarge: new Uint8Array(n),
        nwSolar: new Float64Array(n).fill(NaN), nwBatt: new Float64Array(n).fill(NaN),
        nwStdLcoe: new Float64Array(n).fill(NaN)
    };
    let get;
    let count;
    if (reply.columns) {
        const { n: rows, keys, cols } = reply.columns;
        count = rows;
        const byKey = Object.fromEntries(keys.map((k, j) => [k, cols[j]]));
        get = (key, i) => {
            const c = byKey[key];
            if (!c) return undefined;
            return c.tag && c.tag[i] ? c.dict[c.num[i]] : c.num[i];
        };
    } else {
        count = reply.rows.length;
        get = (key, i) => reply.rows[i][key];
    }
    for (let r = 0; r < count; r++) {
        const li = cells.indexById.get(Number(get('location_id', r)));
        if (li === undefined) continue;
        out.priced[li] = 1;
        out.meets[li] = get('meetsTarget', r) ? 1 : 0;
        const l = get('lcoe', r);
        out.lcoe[li] = Number.isFinite(l) ? l : NaN;
        out.nwMeets[li] = get('noWindMeetsTarget', r) ? 1 : 0;
        const nl = get('noWindLcoe', r);
        out.nwLcoe[li] = Number.isFinite(nl) ? nl : NaN;
        const s = get('windSaving', r);
        out.saving[li] = Number.isFinite(s) ? s : NaN;
        out.windShare[li] = get('windShare', r);
        out.solarGw[li] = get('solar_gw', r);
        out.windGw[li] = get('wind_gw', r);
        out.battGwh[li] = get('batt_gwh', r);
        out.off[li] = get('wind_surface', r) === 'off' && get('wind_gw', r) > 0 ? 1 : 0;
        out.cf[li] = get('annual_cf', r);
        const e = get('annual_energy_mwh', r);
        out.energy[li] = Number.isFinite(e) ? e : NaN;
        out.nwStd[li] = get('noWindStdMeets', r) ? 1 : 0;
        out.nwLarge[li] = get('noWindAddon', r) === 'large' ? 1 : 0;
        const ns = get('noWindSolar', r), nb = get('noWindBatt', r);
        out.nwSolar[li] = Number.isFinite(ns) ? ns : NaN;
        out.nwBatt[li] = Number.isFinite(nb) ? nb : NaN;
        const nsl = get('noWindStdLcoe', r);
        out.nwStdLcoe[li] = Number.isFinite(nsl) ? nsl : NaN;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Costs: Capex Local + WACC Global (T091, the human, 5 Nov 2026: compare the physics, not the financing; one 7% cost
// of capital everywhere, the atlas's WACC Global default, LCOE_PARAMS.wacc; T077 to T090 used WACC Local too). The
// lookups the worker prices with are built as app.js builds them (ensureWaccDataLoaded, ensureLocalCapexDataLoaded,
// serializeWaccMap, serializeWindWaccMap, serializeLocalCapexMap, interpolateLocalCapex, localWindCapex,
// windOffFloatingPriced), and sent with SET_LOOKUPS for each cost year; with WACC Global the cost-of-capital maps are
// not sent (app.js sends them only when waccMode is 'local'), so the worker uses params.wacc everywhere. A cell with no
// local capex falls back to the Global inputs inside the worker, as in the app. verify-article compares the result
// with the real app driven in the same mode (scripts/article/out/local_sensitivity.csv, scenario
// 'local capex + global WACC', recorded by drive_app.mjs).
// ---------------------------------------------------------------------------
export const COST_MODE = Object.freeze({ capex: 'local', wacc: 'global' });
export const COST_SCENARIO = 'local capex + global WACC';   // its rows in local_sensitivity.csv
// app.js COST_BASE_YEAR and LOCAL_ANCHOR_YEARS.
export const LOCAL_ANCHOR_YEARS = [BASE_YEAR, 2035, 2050];
const optNum = (s) => (s === '' || s == null ? null : (Number.isFinite(Number(s)) ? Number(s) : null));   // data.js parseOptionalNumber
const isFloatingWindClass = (c) => typeof c === 'string' && c.startsWith('floating');

export async function loadLocalCosts() {
    const [wacc, windWacc, capex] = await Promise.all([
        fetchCsv('voronoi_wacc.csv'), fetchCsv('voronoi_wacc_wind.csv'), fetchCsv('voronoi_local_capex.csv')
    ]);
    const rowsOf = (csv) => csv.rows.map(r => Object.fromEntries(csv.head.map((h, i) => [h, r[i]])));
    const waccMap = new Map();
    for (const r of rowsOf(wacc)) {
        const id = Number(r.location_id), w = Number(r.wacc_percent);
        if (!Number.isFinite(id) || !Number.isFinite(w)) continue;
        waccMap.set(id, w / 100);
    }
    const windWaccMap = new Map();
    const pct = v => (Number.isFinite(v) ? v / 100 : undefined);
    for (const r of rowsOf(windWacc)) {
        const id = Number(r.location_id);
        if (!Number.isFinite(id)) continue;
        const on = pct(optNum(r.wind_on_wacc_percent));
        const fixedOff = pct(optNum(r.wind_off_fixed_wacc_percent) ?? optNum(r.wind_off_wacc_percent));
        const floatOff = isFloatingWindClass(r.wind_off_class || null) ? pct(optNum(r.wind_off_float_wacc_percent)) : undefined;
        windWaccMap.set(id, { fixed: { on, off: fixedOff }, float: Number.isFinite(floatOff) ? { on, off: floatOff } : null });
    }
    const capexMap = new Map();
    for (const r of rowsOf(capex)) {
        const id = Number(r.location_id);
        if (!Number.isFinite(id)) continue;
        const solar = ['2024', '2035', '2050'].map(y => Number(r[`solar_${y}`]));
        const battery = ['2024', '2035', '2050'].map(y => Number(r[`battery_${y}`]));
        if (![...solar, ...battery].every(Number.isFinite)) continue;
        const years = (prefix) => {
            const v = ['2024', '2035', '2050'].map(y => optNum(r[`${prefix}_${y}`]));
            return v.every(Number.isFinite) ? v : null;
        };
        const floating = isFloatingWindClass(r.wind_off_class || null);
        capexMap.set(id, {
            solar, battery, windOn: years('wind_on'), windOnOm: years('wind_on_om'),
            windOffFixed: years('wind_off_fixed'), windOffFixedOm: years('wind_off_fixed_om'),
            windOffFloat: floating ? years('wind_off_float') : null, windOffFloatOm: floating ? years('wind_off_float_om') : null
        });
    }
    return { waccMap, windWaccMap, capexMap };
}

/** app.js interpolateLocalCapex. */
export function interpolateLocalCapex(year, values) {
    if (!Array.isArray(values) || values.length < 3) return null;
    const [vBase, v2035, v2050] = values;
    const [y0, y1, y2] = LOCAL_ANCHOR_YEARS;
    if (![vBase, v2035, v2050].every(Number.isFinite)) return null;
    if (year <= y0) return vBase;
    if (year >= y2) return v2050;
    if (year <= y1) return vBase + ((v2035 - vBase) * (year - y0)) / (y1 - y0);
    return v2035 + ((v2050 - v2035) * (year - y1)) / (y2 - y1);
}

/** Demand-weighted medians of the local inputs, for the text (T077): capex in 2026, 2035
 *  and 2050 ($/kW, batteries $/kWh) and the cost of capital, over cells with a local figure. */
export function localCostValues(cells, costs) {
    const v = {};
    const n = cells.n;
    for (const Y of [BASE_YEAR, 2035, 2050]) {
        const look = localLookups(costs, Y).localCapexByLocation;
        for (const [k, f] of [['solar', 'solar'], ['battery', 'battery'], ['on', 'windOn'], ['off', 'windOff']]) {
            const a = new Float64Array(n).fill(NaN);
            for (let i = 0; i < n; i++) { const e = look[cells.ids[i]]; if (e && Number.isFinite(e[f])) a[i] = e[f]; }
            v[`lcap.${k}.${Y}`] = wmedian(a, cells.demand);
        }
    }
    const w = new Float64Array(n).fill(NaN), wOn = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
        const x = costs.waccMap.get(cells.ids[i]);
        if (Number.isFinite(x)) w[i] = x;
        const y = costs.windWaccMap.get(cells.ids[i])?.fixed?.on;
        if (Number.isFinite(y)) wOn[i] = y;
    }
    v['lcap.wacc'] = wmedian(w, cells.demand);
    v['lcap.waccOn'] = wmedian(wOn, cells.demand);
    return v;
}

// ---------------------------------------------------------------------------
// Take 5's map (T077 round 2): the levelised cost of a stand-alone onshore wind farm at each
// region's simulated site, Local costs, in 2026, 2035 and 2050. The worker's wind terms
// (lcoe-worker.js precomputeLcoePerLocation, computeLcoeMetrics): capex x CRF at the wind
// cost of capital over the wind life, plus O&M (local $/kW/yr, else the Global share of
// capex), over the site's ten-year mean output with the levelised degradation factor. The
// local capex paths are linear between the anchor years, so the page interpolates between
// these three values exactly.
// ---------------------------------------------------------------------------
function crf(rate, years) {
    if (!Number.isFinite(rate) || !(years > 0)) return 0;
    if (rate === 0) return 1 / years;
    const pow = Math.pow(1 + rate, years);
    return (rate * pow) / (pow - 1);
}
function growthMultiplier(growth, rate, years) {   // lcoe-worker.js levelizedGrowthMultiplier
    if (!(years > 0)) return 0;
    const c = crf(rate, years);
    const ratio = (1 + growth) / (1 + rate);
    const pv = Math.abs(ratio - 1) < 1e-12 ? years / (1 + rate) : (1 / (1 + growth)) * ratio * (1 - Math.pow(ratio, years)) / (1 - ratio);
    return pv * c;
}
export const WIND_LCOE_YEARS = [BASE_YEAR, 2035, 2050];
export function windLcoe(cells, costs, year) {
    const look = localLookups(costs, year);
    const m = costMultipliers(year);
    const P = LCOE_PARAMS;
    const out = new Float64Array(cells.n).fill(NaN);
    for (let i = 0; i < cells.n; i++) {
        const cf = cells.onCf[i];
        if (!cells.onViable[i] || !(cf > 0)) continue;
        const id = cells.ids[i];
        const lc = look.localCapexByLocation[id];
        const capex = Number.isFinite(lc?.windOn) ? lc.windOn : P.windCapex * m.wind;
        const opexPct = Number.isFinite(lc?.windOn) && Number.isFinite(lc?.windOnOm) ? lc.windOnOm / capex : P.windOpexPct;
        // WACC Global (COST_MODE): no maps, so every cell takes P.wacc (+ the onshore premium), as the worker does
        const solarWacc = Number.isFinite(look.waccByLocation?.[id]) ? look.waccByLocation[id] : P.wacc;
        const ww = look.windWaccByLocation?.[id];
        const rate = Number.isFinite(ww?.on) ? ww.on : solarWacc + (P.windWaccPremium || 0);
        const deg = growthMultiplier(-(P.windDegradationPct || 0), rate, P.windLife);
        out[i] = (capex * crf(rate, P.windLife) + capex * opexPct) / (8.76 * cf * deg);
    }
    return out;
}

/** The SET_LOOKUPS payload app.js currentLcoeLookups() sends in Local mode for `year`. */
export function localLookups(costs, year) {
    const look = { ...waccLookups(costs), ...capexLookups(costs, year) };
    // WACC Global (COST_MODE): no cost-of-capital maps, as app.js sends none unless waccMode is 'local'
    if (COST_MODE.wacc !== 'local') { look.waccByLocation = null; look.windWaccByLocation = null; }
    return look;
}

/** The atlas's own cost-of-capital lookups (WACC Local), whatever COST_MODE says: T091's cost-of-capital lens. */
export function waccLookups(costs) {
    const { waccMap, windWaccMap, capexMap } = costs;
    const floatingPriced = id => Boolean(capexMap.get(id)?.windOffFloat) && Boolean(windWaccMap.get(id)?.float);
    const waccByLocation = {};
    waccMap.forEach((v, id) => { if (Number.isFinite(v)) waccByLocation[id] = v; });
    const windWaccByLocation = {};
    windWaccMap.forEach((entry, id) => {
        const rates = entry ? (floatingPriced(id) ? entry.float : entry.fixed) : null;
        if (!rates) return;
        if (!Number.isFinite(rates.on) && !Number.isFinite(rates.off)) return;
        windWaccByLocation[id] = { on: Number.isFinite(rates.on) ? rates.on : undefined, off: Number.isFinite(rates.off) ? rates.off : undefined };
    });
    return { waccByLocation, windWaccByLocation };
}

/** The atlas's full Local mode (Capex Local + WACC Local), whatever COST_MODE says: T091's cost-of-capital lens, which
 *  shows the cost with each region's own cost of capital (the article's numbers before 5 Nov 2026). */
export function localModeLookups(costs, year) {
    return { ...waccLookups(costs), ...capexLookups(costs, year, { capex: 'local', wacc: 'local' }) };
}

function capexLookups(costs, year, mode = COST_MODE) {
    const { windWaccMap, capexMap } = costs;
    // app.js windOffFloatingPriced: a site is priced as floating only in Capex Local + WACC Local, and only where it has
    // both a floating capex and a floating cost of capital; under WACC Global every offshore site takes the fixed-bottom capex
    const floatingPriced = id => mode.capex === 'local' && mode.wacc === 'local'
        && Boolean(capexMap.get(id)?.windOffFloat) && Boolean(windWaccMap.get(id)?.float);
    const localCapexByLocation = {};
    capexMap.forEach((entry, id) => {
        const solar = interpolateLocalCapex(year, entry.solar);
        const battery = interpolateLocalCapex(year, entry.battery);
        if (!Number.isFinite(solar) || !Number.isFinite(battery)) return;
        const floating = floatingPriced(id);
        const value = vals => { const v = interpolateLocalCapex(year, vals); return Number.isFinite(v) ? v : undefined; };
        localCapexByLocation[id] = {
            solar, battery,
            windOn: value(entry.windOn), windOff: value(floating ? entry.windOffFloat : entry.windOffFixed),
            windOnOm: value(entry.windOnOm), windOffOm: value(floating ? entry.windOffFloatOm : entry.windOffFixedOm)
        };
    });
    return { localCapexByLocation, dieselByLocation: null, gasByLocation: null };
}

// ---------------------------------------------------------------------------
// Cells: positions, weights and the wind resource
// ---------------------------------------------------------------------------
export async function loadCells() {
    const [slice, demand, pop, wind, offshore, countries] = await Promise.all([
        loadSlice('summary_w0.parquet'),
        fetchCsv('voronoi_electricity_demand.csv'),
        fetchCsv('voronoi_population_2020.csv'),
        fetchCsv('voronoi_wind_resource.csv'),
        fetchCsv('voronoi_wind_potential_offshore.csv'),
        fetchCsv('voronoi_overlapping_countries.csv')
    ]);
    // Positions: the summary slice's own (float32) coordinates, one per id,
    // ids ascending as the app's matrixLocationIds.
    const first = new Map();
    for (let r = 0; r < slice.n; r++) {
        const id = Number(slice.id[r]);
        if (!first.has(id)) first.set(id, r);
    }
    const ids = [...first.keys()].sort((a, b) => a - b);
    const n = ids.length;
    const cells = {
        n, ids: Int32Array.from(ids), indexById: new Map(ids.map((id, i) => [id, i])),
        lat: new Float64Array(n), lon: new Float64Array(n),
        pop: new Float64Array(n), demand: new Float64Array(n), mapCell: new Uint8Array(n),
        ones: new Float64Array(n).fill(1), country: new Array(n).fill('(none)'),
        windViable: new Uint8Array(n), windWeak: new Uint8Array(n), onViable: new Uint8Array(n), offViable: new Uint8Array(n),
        onArea: new Float64Array(n), onCf: new Float64Array(n).fill(NaN), onCfP50: new Float64Array(n).fill(NaN),
        offCf: new Float64Array(n).fill(NaN), offCfP50: new Float64Array(n).fill(NaN), onFactor: new Float64Array(n).fill(1), offFactor: new Float64Array(n).fill(1), speed: new Float64Array(n).fill(NaN),
        fixedGw: new Float64Array(n), floatingGw: new Float64Array(n)
    };
    ids.forEach((id, i) => {
        const r = first.get(id);
        cells.lat[i] = slice.lat[r];
        cells.lon[i] = slice.lon[r];
    });
    const idx = (csv) => column(csv, 'location_id').map(v => cells.indexById.get(Number(v)));

    // Demand (Chen et al. 2022, about 2019): TWh/yr. Its cells are the map cells.
    const dIdx = idx(demand), dKwh = column(demand, 'annual_demand_kwh');
    dIdx.forEach((i, k) => {
        if (i === undefined) return;
        const v = toNum(dKwh[k]);
        cells.demand[i] = Number.isFinite(v) ? v / 1e9 : 0;
        cells.mapCell[i] = 1;
    });
    // Population (GPW v4 2020), joined on the app's 2-decimal coordinate key.
    const key = (la, lo) => `${Number(la).toFixed(2)},${Number(lo).toFixed(2)}`;
    const pmap = new Map();
    const pLat = column(pop, 'latitude'), pLon = column(pop, 'longitude'), pVal = column(pop, 'population_2020');
    pLat.forEach((la, k) => pmap.set(key(toNum(la), toNum(pLon[k])), toNum(pVal[k])));
    for (let i = 0; i < n; i++) {
        const v = pmap.get(key(cells.lat[i], cells.lon[i]));
        cells.pop[i] = Number.isFinite(v) ? v : 0;
    }
    // Wind resource.
    const wIdx = idx(wind);
    const wc = (name) => column(wind, name);
    const onV = wc('on_viable'), offV = wc('off_viable'), onA = wc('on_viable_area_km2'), onF = wc('on_final_cf'),
        onP = wc('on_cf_p50'), offF = wc('off_final_cf'), offP = wc('off_cf_p50'), spd = wc('on_site_speed_100m'),
        onB = wc('on_cf_best'), offB = wc('off_cf_best'), onLf = wc('on_level_factor'), offLf = wc('off_level_factor');
    // Weak wind (WEAK_WIND_CF above; as analyse.py): neither the windiest fifth of eligible
    // land nor that of eligible sea (500 km2 at least, D-134) reaches the threshold.
    cells.windWeak.fill(1);
    wIdx.forEach((i, k) => {
        if (i === undefined) return;
        cells.onViable[i] = toNum(onV[k]) === 1 ? 1 : 0;
        cells.offViable[i] = toNum(offV[k]) === 1 ? 1 : 0;
        cells.windViable[i] = cells.onViable[i] || cells.offViable[i];
        const ge = (x) => Number.isFinite(x) && x >= WEAK_WIND_CF;
        const lf = (x) => (Number.isFinite(x) ? x : 1);
        cells.windWeak[i] = ge(toNum(onB[k]) * lf(toNum(onLf[k]))) || ge(toNum(offB[k]) * lf(toNum(offLf[k]))) ? 0 : 1;
        cells.onArea[i] = toNum(onA[k]);
        cells.onCf[i] = toNum(onF[k]);
        cells.onCfP50[i] = toNum(onP[k]);
        cells.offCf[i] = toNum(offF[k]);
        cells.offCfP50[i] = toNum(offP[k]);
        if (Number.isFinite(toNum(onLf[k]))) cells.onFactor[i] = toNum(onLf[k]);
        if (Number.isFinite(toNum(offLf[k]))) cells.offFactor[i] = toNum(offLf[k]);
        cells.speed[i] = toNum(spd[k]);
    });
    const oIdx = idx(offshore), fx = column(offshore, 'fixed_gw'), fl = column(offshore, 'floating_gw');
    oIdx.forEach((i, k) => {
        if (i === undefined) return;
        cells.fixedGw[i] = toNum(fx[k]) || 0;
        cells.floatingGw[i] = toNum(fl[k]) || 0;
    });
    // Take 3's map (T077 round 2): share of each region's 2024 onshore wind output in
    // November-February, from the atlas's daily capacity factors (tools/winter_share.py).
    cells.windNF = new Float64Array(n).fill(NaN);
    {
        const r = await fetch(new URL('./data/winter_share_2024.csv', import.meta.url));
        if (!r.ok) throw new Error('winter_share_2024.csv not found');
        const csv = parseCsv(await r.text());
        const ids = column(csv, 'location_id'), nf = column(csv, 'wind_on_nf');
        ids.forEach((id, k) => { const i = cells.indexById.get(Number(id)); if (i !== undefined) cells.windNF[i] = toNum(nf[k]); });
    }
    // Wind potential by definition (T083), the app's own file (deployment/data/voronoi_wind_potential_defs.csv,
    // from pipeline/scripts/pipeline/wind/t083/potential_defs.py). Conservative case: onshore as T078 (D-150:
    // calibrated CF, 3 MW/km2, 20% cut-off on the calibrated CF) and offshore on the World Bank/ESMAP
    // definition (ESMAP's capacity, 20% cut-off). Technical case: onshore pixel by pixel (T078's P0: own CF before
    // calibration, 5 MW/km2, >= 15%) and offshore on the IEA (2019) definition.
    // Fixed-bottom and floating each from their own sea. Empty values (capacity, no estimate) count as zero.
    cells.consOnGw = new Float64Array(n); cells.consOnTwh = new Float64Array(n);
    cells.consFixGw = new Float64Array(n); cells.consFixTwh = new Float64Array(n);
    cells.consFlGw = new Float64Array(n); cells.consFlTwh = new Float64Array(n);
    cells.techOnGw = new Float64Array(n); cells.techOnTwh = new Float64Array(n);
    cells.ieaFixGw = new Float64Array(n); cells.ieaFixTwh = new Float64Array(n);
    cells.ieaFlGw = new Float64Array(n); cells.ieaFlTwh = new Float64Array(n);
    {
        const csv = await fetchCsv('voronoi_wind_potential_defs.csv');
        const ids = column(csv, 'location_id');
        const cols = [['consOnGw', 'on_cons_gw'], ['consOnTwh', 'on_cons_twh'], ['techOnGw', 'on_tech_gw'], ['techOnTwh', 'on_tech_twh'], ['consFixGw', 'fix_esmap_gw'],
            ['consFixTwh', 'fix_esmap_twh'], ['consFlGw', 'fl_esmap_gw'], ['consFlTwh', 'fl_esmap_twh'],
            ['ieaFixGw', 'fix_iea_gw'], ['ieaFixTwh', 'fix_iea_twh'], ['ieaFlGw', 'fl_iea_gw'], ['ieaFlTwh', 'fl_iea_twh']]
            .map(([k, c]) => [k, column(csv, c)]);
        ids.forEach((id, k) => {
            const i = cells.indexById.get(Number(id));
            if (i === undefined) return;
            for (const [key, col] of cols) cells[key][i] = toNum(col[k]) || 0;
        });
    }
    // Solar technical potential (Global Solar Atlas level 1, the Potential map default) and its
    // policy-constrained level 2 (T078: the low end of the solar range); all rows, as analyse.py.
    {
        const pv = await fetchCsv('voronoi_pvout_potential.csv');
        const s1 = column(pv, 'total_level1_twh_y'), s2 = column(pv, 'total_level2_twh_y');
        cells.solarL1Twh = s1.reduce((a, x) => a + (toNum(x) || 0), 0);   // = the embedded t2.solar.twh (analyse.py), not re-emitted
        cells.solarL2Twh = s2.reduce((a, x) => a + (toNum(x) || 0), 0);
        // T085: the solar cases, as the app's Potential view computes them (app.js applySolarPotentialCase):
        // ground-mount is linear in the density, the file holds the default (50 MW/km², D-156); rooftop is
        // always the whole footprint (D-157). Low case = Level 2 land at 40 MW/km²; high = Level 1 at 60 MW/km².
        const total = c => column(pv, c).reduce((a, x) => a + (toNum(x) || 0), 0);
        const dens = [...new Set(column(pv, 'assumed_mw_per_km2').map(toNum))];
        if (dens.length !== 1) throw new Error('solar potential: density not uniform');
        cells.solarDensity = dens[0];
        const g1 = total('pvout_level1_twh_y'), g2 = total('pvout_level2_twh_y');
        const roof = total('rooftop_twh_y');
        cells.solarLowTwh = g2 * SOLAR_DENSITY_LOW / cells.solarDensity + roof;
        cells.solarHighTwh = g1 * SOLAR_DENSITY_HIGH / cells.solarDensity + roof;
    }
    // Dominant country per cell (analyse.py take 4 examples).
    const cIdx = idx(countries), cName = column(countries, 'country_name');
    cIdx.forEach((i, k) => { if (i !== undefined && cName[k]) cells.country[i] = cName[k]; });
    return cells;
}

// ---------------------------------------------------------------------------
// Take 2: technical wind potential (T014 Potential-map conventions)
// ---------------------------------------------------------------------------
const TWH_PER_GW_CF = 8.76;

export function windPotential(cells) {
    const n = cells.n;
    const p = {
        on5Gw: new Float64Array(n), on5Twh: new Float64Array(n), on3Gw: new Float64Array(n), on3P50Twh: new Float64Array(n),
        offFixedTwh: new Float64Array(n), offFixedP50Twh: new Float64Array(n), offFloatTwh: new Float64Array(n),
        windTwh: new Float64Array(n), windTwhLow: new Float64Array(n), windTwhCons: new Float64Array(n), windTwhTech: new Float64Array(n),
        multiple: new Float64Array(n).fill(NaN), multipleUb: new Float64Array(n).fill(NaN)
    };
    for (let i = 0; i < n; i++) {
        if (!cells.mapCell[i]) continue;
        const onv = cells.onViable[i] === 1;
        const offCf = Number.isFinite(cells.offCf[i]) ? cells.offCf[i] : 0;
        const offv = cells.offViable[i] === 1 && offCf > 0;
        const area = Number.isFinite(cells.onArea[i]) ? cells.onArea[i] : 0;
        const onCf = Number.isFinite(cells.onCf[i]) ? cells.onCf[i] : 0;
        // The cautious case's median land carries the level factors too (T063 audit M1), as analyse.py.
        const onP50 = Number.isFinite(cells.onCfP50[i]) ? cells.onCfP50[i] * cells.onFactor[i] : 0;
        const offP50 = Number.isFinite(cells.offCfP50[i]) ? cells.offCfP50[i] * cells.offFactor[i] : 0;
        p.on5Gw[i] = onv ? area * 5 / 1000 : 0;
        p.on3Gw[i] = onv ? area * 3 / 1000 : 0;
        p.on5Twh[i] = onv && onCf > 0 ? p.on5Gw[i] * onCf * TWH_PER_GW_CF : 0;
        p.on3P50Twh[i] = onv ? p.on3Gw[i] * onP50 * TWH_PER_GW_CF : 0;
        p.offFixedTwh[i] = offv ? cells.fixedGw[i] * offCf * TWH_PER_GW_CF : 0;
        p.offFixedP50Twh[i] = offv ? cells.fixedGw[i] * offP50 * TWH_PER_GW_CF : 0;
        p.offFloatTwh[i] = offv ? cells.floatingGw[i] * offCf * TWH_PER_GW_CF : 0;
        p.windTwh[i] = p.on5Twh[i] + p.offFixedTwh[i];
        p.windTwhLow[i] = p.on3P50Twh[i] + p.offFixedP50Twh[i];
        p.windTwhCons[i] = cells.consOnTwh[i] + cells.consFixTwh[i];
        // T083: `multiple` (the take 2 map, layers.js) is the technical case, onshore technical plus fixed-bottom
        // offshore on the IEA definition; `multipleUb` keeps the old upper bound, which the committed analysis checks.
        p.multipleUb[i] = cells.demand[i] > 0 ? p.windTwh[i] / cells.demand[i] : Infinity;
        p.windTwhTech[i] = cells.techOnTwh[i] + cells.ieaFixTwh[i];
        p.multiple[i] = cells.demand[i] > 0 ? p.windTwhTech[i] / cells.demand[i] : Infinity;
    }
    return p;
}

const sum = (a, sel) => { let s = 0; for (let i = 0; i < a.length; i++) if (!sel || sel[i]) s += a[i]; return s; };

export function take2Values(cells, pot) {
    const v = {};
    const m = cells.mapCell;
    v['t2.on5.gw'] = sum(pot.on5Gw, m);
    v['t2.on5.twh'] = sum(pot.on5Twh, m);
    v['t2.on3p50.gw'] = sum(pot.on3Gw, m);
    v['t2.on3p50.twh'] = sum(pot.on3P50Twh, m);
    v['t2.offFixed.gw'] = sum(cells.fixedGw, m);
    v['t2.offFixed.twh'] = sum(pot.offFixedTwh, m);
    v['t2.offFixedP50.gw'] = v['t2.offFixed.gw'];
    v['t2.offFixedP50.twh'] = sum(pot.offFixedP50Twh, m);
    v['t2.offFloat.gw'] = sum(cells.floatingGw, m);
    v['t2.offFloat.twh'] = sum(pot.offFloatTwh, m);
    v['t2.demand.twh'] = sum(cells.demand, m);
    // Conservative case (T078, D-150; offshore World Bank/ESMAP since T083); the old upper bound is the set above.
    v['t2.cons.on.gw'] = sum(cells.consOnGw, m);
    v['t2.cons.on.twh'] = sum(cells.consOnTwh, m);
    v['t2.cons.offFixed.gw'] = sum(cells.consFixGw, m);
    v['t2.cons.offFixed.twh'] = sum(cells.consFixTwh, m);
    v['t2.cons.offFloat.gw'] = sum(cells.consFlGw, m);
    v['t2.cons.offFloat.twh'] = sum(cells.consFlTwh, m);
    v['t2.cons.solar.twh'] = cells.solarL2Twh;
    // T085: solar on the default case (Level 1 land, the file's density, all roofs) and its range.
    v['t2.solar.def.twh'] = cells.solarL1Twh;
    v['t2.solar.low.twh'] = cells.solarLowTwh;
    v['t2.solar.high.twh'] = cells.solarHighTwh;
    v['t2.solar.mwKm2'] = cells.solarDensity;
    v['t2.tech.on.gw'] = sum(cells.techOnGw, m);
    v['t2.tech.on.twh'] = sum(cells.techOnTwh, m);
    v['t2.iea.offFixed.gw'] = sum(cells.ieaFixGw, m);
    v['t2.iea.offFixed.twh'] = sum(cells.ieaFixTwh, m);
    v['t2.iea.offFloat.gw'] = sum(cells.ieaFlGw, m);
    v['t2.iea.offFloat.twh'] = sum(cells.ieaFlTwh, m);
    const coversCons = new Uint8Array(cells.n);
    for (let i = 0; i < cells.n; i++) {
        coversCons[i] = cells.demand[i] > 0 ? (pot.windTwhCons[i] / cells.demand[i] >= 1 ? 1 : 0) : 1;
    }
    const covers = pot.multipleUb.map(x => (x >= 1 ? 1 : 0));
    const coversTech = pot.multiple.map(x => (x >= 1 ? 1 : 0));
    const coversLow = new Uint8Array(cells.n);
    for (let i = 0; i < cells.n; i++) {
        coversLow[i] = cells.demand[i] > 0 ? (pot.windTwhLow[i] / cells.demand[i] >= 1 ? 1 : 0) : 1;
    }
    const band = (lo, hi) => Uint8Array.from(cells.lat, (la, i) => (m[i] && la >= lo && la < hi ? 1 : 0));
    for (const [id, sel] of [['world', m], ['n45p', band(45, 90)], ['s15_0', band(-15, 0)], ['n0_15', band(0, 15)]]) {
        v[`t2.cover.${id}`] = share(covers, cells.pop, sel);
        v[`t2.coverLow.${id}`] = share(coversLow, cells.pop, sel);
        v[`t2.coverCons.${id}`] = share(coversCons, cells.pop, sel);
        v[`t2.coverTech.${id}`] = share(coversTech, cells.pop, sel);
    }
    return v;
}

// ---------------------------------------------------------------------------
// Takes 1, 4 and 5 from the searches (analyse.py)
// ---------------------------------------------------------------------------
function classes(res) {
    const n = res.meets.length;
    const cheaper = new Uint8Array(n), only = new Uint8Array(n), both = new Uint8Array(n), hasWind = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const meets = res.meets[i] === 1, wind = res.windGw[i] > 0, nw = res.nwMeets[i] === 1;
        cheaper[i] = meets && wind && nw ? 1 : 0;
        only[i] = meets && !nw ? 1 : 0;
        both[i] = meets && nw ? 1 : 0;
        hasWind[i] = meets && wind ? 1 : 0;
    }
    return { cheaper, only, both, hasWind };
}

function bothReach(res, cls, w, sel = null) {
    const s = sel ? Uint8Array.from(cls.both, (b, i) => b && sel[i]) : cls.both;
    const a = wmedian(res.lcoe, w, s);
    const b = wmedian(res.nwLcoe, w, s);
    return { wind: a, sb: b, cut: a != null && b ? 1 - a / b : null };
}

const infWhereUnmet = (lcoe, meets) => Float64Array.from(lcoe, (l, i) => (meets[i] ? l : Infinity));

export function take1Values(cells, res, T, prefix) {
    const v = {};
    const cls = classes(res);
    const pct = Float64Array.from(res.saving, (s, i) => (cls.both[i] ? s / res.nwLcoe[i] : NaN));
    for (const [W, w] of [['cells', cells.ones], ['people', cells.pop], ['demand', cells.demand]]) {
        v[`${prefix}.cheaper.${W}.${T}`] = share(cls.cheaper, w);
        v[`${prefix}.only.${W}.${T}`] = share(cls.only, w);
        // Met, and the cheapest build has no wind (analyse.py share_no_gain; T063 weak-wind framing).
        v[`${prefix}.noGain.${W}.${T}`] = share(Uint8Array.from(res.meets, (m, i) => (m === 1 && !(res.windGw[i] > 0) ? 1 : 0)), w);
        v[`${prefix}.sbReach.${W}.${T}`] = share(res.nwMeets, w);
        // Solar + battery reach with the slider builds only (no add-on large builds).
        v[`${prefix}.sbStd.${W}.${T}`] = share(res.nwStd, w);
        const br = bothReach(res, cls, w);
        v[`${prefix}.sbBoth.${W}.${T}`] = br.sb;
        v[`${prefix}.windBoth.${W}.${T}`] = br.wind;
        v[`${prefix}.cut.${W}.${T}`] = br.cut;
        v[`${prefix}.saving.${W}.${T}`] = wmedian(res.saving, w, cls.cheaper);
        v[`${prefix}.savingPct.${W}.${T}`] = wmedian(pct, w, cls.cheaper);
        if (prefix === 't1' && T === 90) v[`t1.noViable.${W}`] = share(cells.windWeak, w);
    }
    return v;
}

/** T095: the article's backup chart, per MWh of the FULL load (1 GW x 8760 h), as its backup bar: each region's annual
 *  cost / the full load = LCOE x delivered energy / the full load (the hours the build misses go unserved); unmet
 *  regions +inf (as s4.curve). Demand- and people-weighted medians of the cheapest build with wind. The same keys for
 *  the build without wind (sb) come from analyse_t089.py's S+B search, embedded. */
export function curveLoadValues(cells, res, T) {
    const fullLoadMwh = 8760 * 1000;
    const perLoad = Float64Array.from(res.lcoe, (l, i) => (res.meets[i] ? l * res.energy[i] / fullLoadMwh : Infinity));
    return {
        [`s4.curveLoad.sbw.demand.${T}`]: wmedian(perLoad, cells.demand),
        [`s4.curveLoad.sbw.people.${T}`]: wmedian(perLoad, cells.pop)
    };
}

export const BAND_DEFS = {
    s90_45: [-90, -45], s45_30: [-45, -30], s30_15: [-30, -15], s15_0: [-15, 0], n0_15: [0, 15],
    n15_30: [15, 30], n30_45: [30, 45], n45_55: [45, 55], n55_65: [55, 65], n65_90: [65, 90],
    n45p: [45, 90], n50p: [50, 90], n55p: [55, 90], world: [-90, 90.0001]
};
export const COUNTRY_NAMES = {
    UK: 'United Kingdom', DE: 'Germany', US: 'United States of America', ES: 'Spain',
    PL: 'Poland', NL: 'Netherlands', SE: 'Sweden'
};

function bandMask(cells, [lo, hi]) {
    return Uint8Array.from(cells.lat, la => (la >= lo && la < hi ? 1 : 0));
}

export function take4Values(cells, res, resOn, T) {
    const v = {};
    const cls = classes(res);
    const w = cells.pop;
    const lw = infWhereUnmet(res.lcoe, res.meets);
    const lwOn = resOn ? infWhereUnmet(resOn.lcoe, resOn.meets) : null;
    for (const [id, def] of Object.entries(BAND_DEFS)) {
        const sel = id === 'world' ? null : bandMask(cells, def);
        v[`t4.sbReach.${id}.${T}`] = share(res.nwMeets, w, sel);
        v[`t4.sbStd.${id}.${T}`] = share(res.nwStd, w, sel);
        if (id === 'n50p') {
            // Where the no-wind build is a large add-on build: its solar and battery, median over regions.
            const sol = [], bat = [];
            for (let i = 0; i < cells.n; i++) {
                if (!sel[i] || !res.nwLarge[i] || !res.nwMeets[i]) continue;
                sol.push(res.nwSolar[i]); bat.push(res.nwBatt[i]);
            }
            const median = (a) => { const q = a.slice().sort((x, y) => x - y); const k = q.length; return k ? (k % 2 ? q[(k - 1) / 2] : (q[k / 2 - 1] + q[k / 2]) / 2) : null; };
            let nSel = 0;
            for (let i = 0; i < cells.n; i++) if (sel[i]) nSel++;
            v[`t4.lgWins.${id}.${T}`] = sol.length;
            v[`t4.lgRegions.${id}.${T}`] = nSel;
            v[`t4.lgSolar.${id}.${T}`] = median(sol);
            v[`t4.lgBatt.${id}.${T}`] = median(bat);
        }
        v[`t4.withWind.${id}.${T}`] = share(res.meets, w, sel);
        const br = bothReach(res, cls, w, sel);
        if (br.sb != null) {
            v[`t4.sbBoth.${id}.${T}`] = br.sb;
            v[`t4.windBoth.${id}.${T}`] = br.wind;
            v[`t4.cut.${id}.${T}`] = br.cut;
        }
        v[`t4.medWind.${id}.${T}`] = wmedian(lw, w, sel);
        if (lwOn) v[`t4.medWindOn.${id}.${T}`] = wmedian(lwOn, w, sel);
        if (T === 80) {
            let p = 0;
            for (let i = 0; i < cells.n; i++) if (!sel || sel[i]) p += w[i];
            v[`t4.people.${id}`] = p / 1e6;
        }
    }
    for (const [id, name] of Object.entries(COUNTRY_NAMES)) {
        const sel = Uint8Array.from(cells.country, c => (c === name ? 1 : 0));
        if (T === 90) v[`t4c.${id}.medWind.90`] = wmedian(lw, w, sel);
        v[`t4c.${id}.sbReach.${T}`] = share(res.nwMeets, w, sel);
        if (T === 80) {
            const br = bothReach(res, cls, w, sel);
            if (br.cut != null) v[`t4c.${id}.cut.80`] = br.cut;
        }
    }
    return v;
}

/**
 * Headline candidates (T058, for the human's reframe; not yet bound in the text).
 * For people and demand at target T:
 *   hw.lower    – the cheapest build has wind and solar + battery (standard or large) also reaches T
 *                 (the same comparator as t1.cheaper: the cheapest build with wind costs less);
 *   hw.lower15  – of those, the saving is more than $15/MWh;
 *   hw.windOnly – only a build with wind reaches T (solar + battery cannot, even with large builds);
 *   hw.lowerStd, hw.lower15Std – the same with only the slider (configs.json) solar + battery
 *                 builds as the comparator (rows whose cheapest build has wind);
 *   hw.medSaving – median saving among hw.lower regions.
 */
export function headlineValues(cells, res, T) {
    const v = {};
    const cls = classes(res);
    const n = res.meets.length;
    const lower15 = new Uint8Array(n), lowerStd = new Uint8Array(n), lower15Std = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        lower15[i] = cls.cheaper[i] && res.saving[i] > 15 ? 1 : 0;
        const std = res.meets[i] && res.windGw[i] > 0 && Number.isFinite(res.nwStdLcoe[i]) ? res.nwStdLcoe[i] - res.lcoe[i] : NaN;
        lowerStd[i] = std > 0 ? 1 : 0;
        lower15Std[i] = std > 15 ? 1 : 0;
    }
    for (const [W, w] of [['people', cells.pop], ['demand', cells.demand]]) {
        v[`hw.lower.${W}.${T}`] = share(cls.cheaper, w);
        v[`hw.lower15.${W}.${T}`] = share(lower15, w);
        v[`hw.windOnly.${W}.${T}`] = share(cls.only, w);
        v[`hw.lowerStd.${W}.${T}`] = share(lowerStd, w);
        v[`hw.lower15Std.${W}.${T}`] = share(lower15Std, w);
        v[`hw.medSaving.${W}.${T}`] = wmedian(res.saving, w, cls.cheaper);
    }
    return v;
}

export function take5Values(cells, res, Y) {
    const v = {};
    const cls = classes(res);
    const d = cells.demand, p = cells.pop;
    const br = bothReach(res, cls, d);
    v[`t5.sbBoth.demand.${Y}`] = br.sb;
    v[`t5.windBoth.demand.${Y}`] = br.wind;
    v[`t5.cut.demand.${Y}`] = br.cut;
    v[`t5.cheaper.demand.${Y}`] = share(cls.cheaper, d);
    v[`t5.only.demand.${Y}`] = share(cls.only, d);
    v[`t5.sbReach.demand.${Y}`] = share(res.nwMeets, d);
    v[`t5.cheaper.people.${Y}`] = share(cls.cheaper, p);
    v[`t5.only.people.${Y}`] = share(cls.only, p);
    const north = bandMask(cells, BAND_DEFS.n45p);
    v[`t5.hasWind.n45p.people.${Y}`] = share(cls.hasWind, p, north);
    v[`t5.hasWind.n45p.demand.${Y}`] = share(cls.hasWind, d, north);
    return v;
}

export function noViableValues(cells) {
    const v = {};
    const sel = Uint8Array.from(cells.country, (c, i) => (c === 'India' && cells.windWeak[i] ? 1 : 0));
    const speeds = [], cfs = [];
    for (let i = 0; i < cells.n; i++) {
        if (!sel[i]) continue;
        if (Number.isFinite(cells.speed[i])) speeds.push(cells.speed[i]);
        if (Number.isFinite(cells.onCfP50[i])) cfs.push(cells.onCfP50[i]);
    }
    const median = (a) => { const s = a.slice().sort((x, y) => x - y); const k = s.length; return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2; };
    v['nv.India.cells'] = sel.reduce((a, b) => a + b, 0);
    v['nv.India.speed'] = median(speeds);
    v['nv.India.cf'] = median(cfs);
    v['n.cells'] = cells.n;
    v['n.peopleBn'] = sum(cells.pop) / 1e9;
    v['n.demandTwh'] = sum(cells.demand);
    return v;
}

// ---------------------------------------------------------------------------
// Latitude bands (T077): absolute latitude, both hemispheres together, weighted
// by electricity demand. 0–15° is the low-wind tropics, 15–30° the sunny
// subtropical belt (the Sahara, Arabia, northern India, Mexico), 30–45° the
// mid-latitudes (the Mediterranean, most of China and the United States), 45–55°
// north-west and central Europe, the northern United States and southern Canada,
// and 55° and above the Nordics, Scotland, the Baltics, Russia and Canada.
// ---------------------------------------------------------------------------
export const ABS_BANDS = { a0_15: [0, 15], a15_30: [15, 30], a30_45: [30, 45], a45_55: [45, 55], a55p: [55, 90.0001] };
function absBandMask(cells, [lo, hi]) {
    return Uint8Array.from(cells.lat, la => (Math.abs(la) >= lo && Math.abs(la) < hi ? 1 : 0));
}

/** Take 3's map, in the map's view of Europe (34–71°N, 12°W–40°E; map.js VIEWS.europe): demand
 *  share of regions whose onshore wind delivers more than a third of its 2024 output in
 *  November–February, and the demand-weighted median share. */
export function winterValues(cells) {
    const sel = Uint8Array.from(cells.lat, (la, i) => (la >= 34 && la <= 71 && cells.lon[i] >= -12 && cells.lon[i] <= 40 && cells.onViable[i] && Number.isFinite(cells.windNF[i]) ? 1 : 0));
    return {
        'win.eu.above': share(Uint8Array.from(cells.windNF, x => (x > 1 / 3 ? 1 : 0)), cells.demand, sel),
        'win.eu.median': wmedian(cells.windNF, cells.demand, sel)
    };
}

export function bandWeights(cells) {
    const v = {};
    for (const [id, def] of Object.entries(ABS_BANDS)) {
        const sel = absBandMask(cells, def);
        v[`lb.demand.${id}`] = share(sel, cells.demand);
        v[`lb.people.${id}`] = share(sel, cells.pop);
    }
    return v;
}

/** Per band and the world, demand-weighted: like-for-like medians (both reach), the cut,
 *  solar + battery reach, and the median cost of the cheapest build (with wind where it pays). */
export function bandValues(cells, res, T, Y) {
    const v = {};
    const cls = classes(res);
    const w = cells.demand;
    const best = infWhereUnmet(res.lcoe, res.meets);
    for (const [id, def] of [...Object.entries(ABS_BANDS), ['world', null]]) {
        const sel = def ? absBandMask(cells, def) : null;
        const br = bothReach(res, cls, w, sel);
        v[`lb.sb.${id}.${T}.${Y}`] = br.sb;
        v[`lb.wind.${id}.${T}.${Y}`] = br.wind;
        v[`lb.cut.${id}.${T}.${Y}`] = br.cut;
        v[`lb.reach.${id}.${T}.${Y}`] = share(res.nwMeets, w, sel);
        v[`lb.best.${id}.${T}.${Y}`] = wmedian(best, w, sel);
        v[`lb.cheaper.${id}.${T}.${Y}`] = share(cls.cheaper, w, sel);
        // Median saving from adding wind, $/MWh, where both reach the target (T077 round 2, chart 1).
        v[`lb.saving.${id}.${T}.${Y}`] = wmedian(res.saving, w, sel ? Uint8Array.from(cls.both, (b, i) => b && sel[i]) : cls.both);
    }
    return v;
}

// ---------------------------------------------------------------------------
// The run: load, search, aggregate. Calls back as each piece lands.
// ---------------------------------------------------------------------------
export const TARGETS = [50, 60, 70, 75, 80, 85, 90, 95, 97, 99];
export const YEARS = [2026, 2030, 2035, 2040, 2045, 2050];

/** Scenario id: 2026 targets are t<T>; 90% in later years y<Y> (the maps read these); other targets y<Y>t<T>. */
export const scenarioId = (T, Y) => (Y === BASE_YEAR ? `t${T}` : T === 90 ? `y${Y}` : `y${Y}t${T}`);

// Search order: what the maps need first, then year by year (one SET_LOOKUPS per year).
function scenarios() {
    const list = [];
    for (const Y of YEARS) {
        const order = Y === BASE_YEAR ? [90, 80, ...TARGETS.filter(t => t !== 90 && t !== 80)] : [90, ...TARGETS.filter(t => t !== 90)];
        for (const T of order) list.push({ id: scenarioId(T, Y), target: T, year: Y, offshore: true });
        if (Y === BASE_YEAR) {
            list.push({ id: 'on90', target: 90, year: BASE_YEAR, offshore: false });
            list.push({ id: 'on80', target: 80, year: BASE_YEAR, offshore: false });
        }
    }
    return list;
}

export async function runModel({ onCells, onScenario, onValues, onProgress } = {}) {
    const t0 = performance.now();
    const manifestP = fetch(new URL('configs.json', DATA_URL)).then(r => {
        if (!r.ok) throw new Error('configs.json not found');
        return r.json();
    });
    const costsP = loadLocalCosts();
    const cells = await loadCells();
    const pot = windPotential(cells);
    onCells?.(cells, pot);
    onValues?.({ ...take2Values(cells, pot), ...noViableValues(cells), ...bandWeights(cells), ...winterValues(cells) });

    const manifest = await manifestP;
    const costs = await costsP;
    onValues?.(localCostValues(cells, costs));
    cells.windLcoe = Object.fromEntries(WIND_LCOE_YEARS.map(y => [y, windLcoe(cells, costs, y)]));
    {
        const v = {};
        for (const y of WIND_LCOE_YEARS) v[`wl.median.${y}`] = wmedian(cells.windLcoe[y], cells.demand);
        onValues?.(v);
    }
    const configs = manifest.configs.map(({ i, summary, solar, wind, batt, surface }) => ({ i, summary, solar, wind, batt, surface }));
    const addonBytes = await fetch(new URL(ADDON_REQUEST.manifest, DATA_URL)).then(r => {
        if (!r.ok) throw new Error(`${ADDON_REQUEST.manifest} not found`);
        return r.arrayBuffer();
    });
    const addonSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', addonBytes)),
        b => b.toString(16).padStart(2, '0')).join('');
    if (addonSha !== ADDON_JSON_SHA256) {
        throw new Error(`${ADDON_REQUEST.manifest} SHA-256 ${addonSha} is not the one pinned in model.js (${ADDON_JSON_SHA256})`);
    }
    const client = workerClient(APP_WORKER_URL);
    const locationIds = Int32Array.from(cells.ids);
    const payload = { configs, locationIds: locationIds.buffer,
        addon: { manifest: ADDON_REQUEST.manifest, sets: [...ADDON_REQUEST.sets] } };
    const addon = { payload: payload.addon ? { ...payload.addon } : null, sha256: addonSha, active: null };
    const loaded = await client.post('LOAD_MATRIX', payload, {
        transfer: [locationIds.buffer],
        onProgress: (p) => onProgress?.({ stage: 'matrix', ...p })
    });
    addon.active = loaded?.addon || null;
    if (payload.addon && JSON.stringify(addon.active) !== JSON.stringify(ADDON_REQUEST.sets)) {
        throw new Error(`the LCOE worker did not load the add-on: ${loaded?.addonError || JSON.stringify(addon.active)}`);
    }
    const results = {};
    const timings = {};
    let lookupYear = null;
    for (const s of scenarios()) {
        if (s.year !== lookupYear) {
            await client.post('SET_LOOKUPS', localLookups(costs, s.year));
            lookupYear = s.year;
        }
        const ts = performance.now();
        const reply = await client.post('COMPUTE_BEST_LCOE', {
            targetCf: s.target / 100,
            params: { ...LCOE_PARAMS, includeOffshore: s.offshore, targetCf: s.target / 100 },
            costMultipliers: costMultipliers(s.year)
        });
        results[s.id] = decodeAnswer(reply, cells);
        timings[s.id] = Math.round(performance.now() - ts);
        onScenario?.(s.id, results[s.id], cells);
        const v = {};
        if (s.offshore) Object.assign(v, bandValues(cells, results[s.id], s.target, s.year));
        if (s.year === BASE_YEAR && s.offshore && [80, 90, 99].includes(s.target)) Object.assign(v, headlineValues(cells, results[s.id], s.target));
        if (s.year === BASE_YEAR && s.offshore) Object.assign(v, take1Values(cells, results[s.id], s.target, 't1'));
        if (s.year === BASE_YEAR && s.offshore && [90, 95, 99].includes(s.target)) Object.assign(v, curveLoadValues(cells, results[s.id], s.target));
        if (s.year === BASE_YEAR && !s.offshore) Object.assign(v, take1Values(cells, results[s.id], s.target, 't1on'));
        if (s.target === 90 && s.offshore) Object.assign(v, take5Values(cells, results[s.id], s.year));
        for (const T of [80, 90]) {
            if (results[`t${T}`] && results[`on${T}`] && (s.id === `t${T}` || s.id === `on${T}`)) {
                Object.assign(v, take4Values(cells, results[`t${T}`], results[`on${T}`], T));
            }
        }
        onValues?.(v);
    }
    client.terminate();
    return { cells, pot, results, timings, addon, costMode: COST_MODE, totalMs: Math.round(performance.now() - t0) };
}
