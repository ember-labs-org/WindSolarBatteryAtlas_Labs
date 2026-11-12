// summary-encode.js – runs the atlas model (model.js) in the browser and encodes
// what the article needs as deployment/scrollytelling/data/article-summary.json
// (format: deployment/scrollytelling/js/summary.js). Loaded at /__article_tools/
// by summary-lib.mjs, for build-summary.mjs (writes the file) and
// verify-article.mjs (rebuilds it and compares). Needs the global d3.
import { runModel, LCOE_PARAMS, windCapex, YEARS, BASE_YEAR, ABS_BANDS } from './model.js';
import { savingScale, cfScale, bucketOf, LAYER_CASES, WIND_LCOE_YEARS, winterScale, windLcoeScale, WINTER_EVEN, dumpLayer } from '../scrollytelling/js/layers.js';

/** Values the page shows that are arithmetic on other values, and the model's constants. */
export function derivedValues(v) {
    const d = {};
    const has = (...k) => k.every(x => Number.isFinite(v[x]));
    if (has('t2.on5.twh', 't2.offFixed.twh', 'ext.demand2025')) {
        d['t2.total.pwh'] = (v['t2.on5.twh'] + v['t2.offFixed.twh']) / 1000;
        d['t2.mult'] = (v['t2.on5.twh'] + v['t2.offFixed.twh']) / v['ext.demand2025'];
    }
    if (has('t2.on3p50.twh', 't2.offFixedP50.twh', 'ext.demand2025')) {
        d['t2.multLow'] = (v['t2.on3p50.twh'] + v['t2.offFixedP50.twh']) / v['ext.demand2025'];
    }
    // T083: the technical case, onshore pixel by pixel at 5 MW/km2 plus fixed-bottom offshore on the IEA (2019) definition.
    if (has('t2.tech.on.twh', 't2.iea.offFixed.twh', 'ext.demand2025')) {
        d['t2.tech.total.pwh'] = (v['t2.tech.on.twh'] + v['t2.iea.offFixed.twh']) / 1000;
        d['t2.multTech'] = (v['t2.tech.on.twh'] + v['t2.iea.offFixed.twh']) / v['ext.demand2025'];
    }
    if (has('t2.iea.offFixed.twh', 't2.iea.offFloat.twh')) d['t2.iea.total.pwh'] = (v['t2.iea.offFixed.twh'] + v['t2.iea.offFloat.twh']) / 1000;
    // T078 (D-150): the conservative case, the low end of the range.
    if (has('t2.cons.on.twh', 't2.cons.offFixed.twh', 'ext.demand2025')) {
        d['t2.cons.total.pwh'] = (v['t2.cons.on.twh'] + v['t2.cons.offFixed.twh']) / 1000;
        d['t2.multCons'] = (v['t2.cons.on.twh'] + v['t2.cons.offFixed.twh']) / v['ext.demand2025'];
    }
    // T086 (D-154 light D): onshore potential without dense forest and cropland, on the article's demand.
    if (has('ext.t086.cons.today.twh', 'ext.t086.cons.both.twh', 'ext.t086.tech.today.twh', 'ext.t086.tech.both.twh', 'ext.demand2025')) {
        d['t2.lc.fallCons'] = 1 - v['ext.t086.cons.both.twh'] / v['ext.t086.cons.today.twh'];
        d['t2.lc.fallTech'] = 1 - v['ext.t086.tech.both.twh'] / v['ext.t086.tech.today.twh'];
        d['t2.lc.multCons'] = v['ext.t086.cons.both.twh'] / v['ext.demand2025'];
        d['t2.lc.multTech'] = v['ext.t086.tech.both.twh'] / v['ext.demand2025'];
    }
    for (const t of ['onshore_wind', 'offshore_wind', 'solar_pv']) {
        if (has(`ext.lcoe.${t}.2010`, `ext.lcoe.${t}.2025`)) d[`ext.lcoeFall.${t}`] = 1 - v[`ext.lcoe.${t}.2025`] / v[`ext.lcoe.${t}.2010`];
    }
    const cuts = YEARS.map(y => v[`t5.cut.demand.${y}`]).filter(Number.isFinite);
    if (cuts.length === YEARS.length) { d['t5.cutMin'] = Math.min(...cuts); d['t5.cutMax'] = Math.max(...cuts); }
    const ch = YEARS.map(y => v[`t5.cheaper.demand.${y}`]).filter(Number.isFinite);
    if (ch.length === YEARS.length) { d['t5.cheaperMin'] = Math.min(...ch); d['t5.cheaperMax'] = Math.max(...ch); }
    // T077: take 3's nine countries, the range of each source's November–February share.
    for (const src of ['solar', 'wind']) {
        const xs = ['DE', 'UK', 'FR', 'ES', 'IT', 'PL', 'NL', 'SE', 'DK'].map(id => v[`t3m.${id}.${src}NF`]).filter(Number.isFinite);
        if (xs.length === 9) { d[`t3m.${src}NFMin`] = Math.min(...xs); d[`t3m.${src}NFMax`] = Math.max(...xs); }
    }
    // T077: how far the local onshore capital cost falls by 2035 (demand-weighted median).
    if (has('lcap.on.2026', 'lcap.on.2035')) d['lcap.onFall2035'] = 1 - v['lcap.on.2035'] / v['lcap.on.2026'];
    // T077: the cheapest build's cost in 2050 against 2026, every band, at 90% and 99% uptime
    // (chart 5's "about half as expensive by 2050 at every latitude").
    const halves = [];
    for (const id of Object.keys(ABS_BANDS)) for (const T of [90, 99]) {
        const a = v[`lb.best.${id}.${T}.2050`], b = v[`lb.best.${id}.${T}.${BASE_YEAR}`];
        if (Number.isFinite(a) && Number.isFinite(b)) halves.push(a / b);
    }
    if (halves.length === Object.keys(ABS_BANDS).length * 2) { d['lb.halfMin'] = Math.min(...halves); d['lb.halfMax'] = Math.max(...halves); }
    // T077: the smallest like-for-like cut at 90% uptime north of 30° (absolute latitude), any year
    // (chart 5b's "north of 30°, adding wind keeps a constant supply cheaper all the way to 2050").
    const cuts90 = [];
    for (const id of ['a30_45', 'a45_55', 'a55p']) for (const Y of YEARS) cuts90.push(v[`lb.cut.${id}.90.${Y}`]);
    if (cuts90.every(Number.isFinite)) d['lb.cutMinN30'] = Math.min(...cuts90);
    // Model constants (the app's defaults, pinned to 2026).
    for (const y of [2026, 2035, 2050]) {
        const c = windCapex(y);
        d[`cap.on.${y}`] = c.on;
        d[`cap.off.${y}`] = c.off;
    }
    for (const k of ['solarCapex', 'batteryCapex', 'wacc', 'windOffWaccPremium', 'solarDegradationPct', 'windDegradationPct']) {
        d[`p.${k}`] = LCOE_PARAMS[k];
    }
    return d;
}

// Rounding: the fewest decimals (or significant digits) from a starting point
// that keep `keep(x)` (every figure, bucket and colour the page derives from
// the value) the same as for the model's own value.
function quant(v, decimals, keep) {
    if (!Number.isFinite(v)) return null;
    const k = keep(v);
    for (let d = decimals; d <= 10; d++) {
        const p = 10 ** d;
        const x = Math.round(v * p) / p;
        if (keep(x) === k) return x;
    }
    return v;
}
function quantSig(v, sig, keep) {
    if (!Number.isFinite(v)) return null;
    const k = keep(v);
    for (let s = sig; s <= 17; s++) {
        const x = Number(v.toPrecision(s));
        if (keep(x) === k) return x;
    }
    return v;
}
const round12 = v => Number(v.toPrecision(12));

export function encodeSummary({ cells, pot, results }, values) {
    const n = cells.n;
    const cf = cfScale(), sav = savingScale(), win = winterScale(), wl = windLcoeScale();
    const keepWinter = x => `${Math.round(x * 100)}|${x < WINTER_EVEN ? 'g' : win(x)}`;
    const keepWl = x => `${Math.round(x)}|${wl(x)}`;
    const keepUsd = x => String(Math.round(x));
    const keepSaving = x => `${Math.round(Math.max(0, x))}|${sav(Math.max(0, x))}`;
    const keepCf = x => `${Math.round(x * 100)}|${cf(x)}`;
    const keepMultiple = x => `${bucketOf(x).label}|${Math.round(x)}`;
    // Coordinates: the slice's float32 values, written as the shortest decimal
    // that reads back (Math.fround) as the same float32, so the page's Voronoi
    // cells are exactly the app's.
    for (const a of [cells.lat, cells.lon]) {
        if (!a.every(x => Math.fround(x) === x)) throw new Error('site coordinates are not float32 values');
    }
    const keepCoord = x => Math.fround(x);

    const countries = [...new Set(cells.country)].sort();
    const cIndex = new Map(countries.map((c, i) => [c, i]));
    const ids = Array.from(cells.ids);
    const out = {
        about: 'Generated by scripts/article/tools/build-summary.mjs from the atlas\'s own LCOE model '
            + '(deployment/js/workers/lcoe-worker.js) at its default settings with Local costs (capex and WACC Local), base year 2026. Do not edit: re-run the tool. '
            + 'Format: deployment/scrollytelling/js/summary.js.',
        baseYear: BASE_YEAR,
        n,
        values: Object.fromEntries(Object.keys(values).sort().map(k => [k, round12(values[k])])),
        cells: {
            idDelta: ids.map((id, i) => id - (i ? ids[i - 1] : 0)),
            lat: Array.from(cells.lat, x => quant(x, 2, keepCoord)),   // read back with Math.fround
            lon: Array.from(cells.lon, x => quant(x, 2, keepCoord)),
            flags: Array.from({ length: n }, (_, i) => (cells.mapCell[i] ? 1 : 0) | (cells.onViable[i] ? 2 : 0)),
            onCf: Array.from({ length: n }, (_, i) => (cells.onViable[i] ? quant(cells.onCf[i], 3, keepCf) : null)),
            country: cells.country.map(c => cIndex.get(c)),
            countries,
            multiple: Array.from({ length: n }, (_, i) => (cells.mapCell[i] ? quantSig(pot.multiple[i], 3, keepMultiple) : null)),
            // T077 round 2: take 3's winter share and take 5's onshore wind LCOE at the anchor years.
            windNF: Array.from({ length: n }, (_, i) => (cells.onViable[i] && Number.isFinite(cells.windNF[i]) ? quant(cells.windNF[i], 3, keepWinter) : null)),
            ...Object.fromEntries(WIND_LCOE_YEARS.map(Y => [`wl${Y}`, Array.from({ length: n }, (_, i) => (Number.isFinite(cells.windLcoe[Y][i]) ? quant(cells.windLcoe[Y][i], 1, keepWl) : null))]))
        },
        results: {}
    };
    for (const id of ['t90']) {     // the saving maps (takes 1 and 4) read 2026 at 90%
        const r = results[id];
        const withSaving = true;
        const e = {
            flags: Array.from({ length: n }, (_, i) => (r.priced[i] ? 1 : 0) | (r.meets[i] ? 2 : 0) | (r.nwMeets[i] ? 4 : 0)),
            lcoe: Array.from({ length: n }, (_, i) => (r.meets[i] ? quant(r.lcoe[i], 2, keepUsd) : null))
        };
        if (withSaving) {
            e.nwLcoe = Array.from({ length: n }, (_, i) => (r.meets[i] && r.nwMeets[i] ? quant(r.nwLcoe[i], 2, keepUsd) : null));
            e.saving = Array.from({ length: n }, (_, i) => (r.meets[i] && r.nwMeets[i] ? quant(r.saving[i], 2, keepSaving) : null));
        }
        out.results[id] = e;
    }
    // Any site the written coordinates do not give back exactly (expected 0).
    let coordErr = 0;
    for (let i = 0; i < n; i++) coordErr = Math.max(coordErr, Math.abs(Math.fround(out.cells.lat[i]) - cells.lat[i]), Math.abs(Math.fround(out.cells.lon[i]) - cells.lon[i]));
    return { summary: out, coordErr };
}

/**
 * Run the model and encode the summary. `embedded`: the values the model cannot
 * compute (Ember monthly, IRENA, Local-cost sensitivity...), by key, from
 * build-snapshot.mjs. With `dumps`, also returns every cell's fill and tooltip
 * in every map state, drawn from the model's own (unrounded) results.
 */
export async function runAndEncode(embedded, { dumps = false } = {}) {
    const modelValues = {};
    const run = await runModel({ onValues: (v) => { for (const [k, x] of Object.entries(v)) if (x != null && Number.isFinite(x)) modelValues[k] = x; } });
    const all = { ...embedded, ...modelValues };
    Object.assign(all, derivedValues(all));
    const { summary, coordErr } = encodeSummary(run, all);
    const res = { summary, coordErr, modelValues, timings: run.timings, addon: run.addon, totalMs: run.totalMs };
    if (dumps) {
        const c = run.cells;
        const rows = Array.from(c.ids, (id, i) => ({ location_id: id, latitude: c.lat[i], longitude: c.lon[i], i }));
        const d = { cells: c, pot: run.pot, results: run.results };
        res.dumps = LAYER_CASES.map(([name, year]) => ({ name, year, ...dumpLayer(d, rows, name, year) }));
    }
    return res;
}
