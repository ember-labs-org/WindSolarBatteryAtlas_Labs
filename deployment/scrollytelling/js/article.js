// article.js – "Harnessing the Winds": binds the numbers, draws the charts and
// drives the sticky map as each take scrolls into view.
//
// Numbers: every figure in the text sits in a <span data-n="key" data-f="format">
// whose static text is the audited value. The page loads one small file,
// data/article-summary.json (summary.js), made by scripts/article/tools/build-summary.mjs
// from the main atlas's own model with Local costs (capex and WACC Local) at 2026, and
// shows its values. A span whose static text does not read as the summary's
// value is recorded (window.__article.textMismatch). The page runs no model:
// scripts/article/tools/verify-article.mjs re-runs it and fails if the summary,
// the text or any map cell differs.
import { loadSummary } from './summary.js';
import { linePanels, smallMultiples, barChart, dumbbell, animatedCurves, chartKey } from './charts.js';
import { initMap, setCells, paint, clear, setView } from './map.js';
import { MAP_STATES, LAYER_CASES, dumpLayer } from './layers.js';
import { format, nf } from './format.js';


const state = {
    v: {},              // the summary's values
    data: null,         // decoded map data { cells, pot, results }
    rows: [],
    textMismatch: [],
    errors: [],
    ready: false,
    mapState: null,
    year: 2026,          // take 5's map: the cost year on the slider
    yearTimer: null
};
window.__article = state;
state.values = () => ({ ...state.v });
// Fill and tooltip of every cell in every map state (for the check).
state.dumpLayers = () => LAYER_CASES.map(([name, year]) => ({ name, year, ...dumpLayer(state.data, state.rows, name, year) }));
const values = () => state.v;

function bindNumbers(firstPass) {
    const v = values();
    document.querySelectorAll('[data-n]').forEach((el) => {
        const key = el.dataset.n, f = el.dataset.f;
        const val = v[key];
        if (!Number.isFinite(val)) {
            if (firstPass) state.textMismatch.push({ key, text: el.textContent.trim(), expected: null });
            return;
        }
        const text = format(val, f);
        if (firstPass && el.textContent.trim() !== text) {
            state.textMismatch.push({ key, text: el.textContent.trim(), expected: text });
            console.warn(`[article] text for ${key} reads "${el.textContent.trim()}", the summary gives "${text}"`);
        }
        el.textContent = text;
    });
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
// Chart colours are the page's tokens (css/article.css), so the light scheme redraws in its own.
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const COLORS = {};
function readColors() {
    Object.assign(COLORS, {
        sb: token('--c-context'), solar: token('--c-solar'), wind: token('--c-wind'), demand: token('--c-context'),
        offshore: token('--c-band-4'), bands: [1, 2, 3, 4, 5].map(k => token(`--c-band-${k}`))
    });
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Latitude bands of absolute latitude (model.js ABS_BANDS), demand-weighted throughout.
// Ordered high latitude to low everywhere (keys, panels, labels): the north at the top.
const BANDS = [['a55p', '55°+'], ['a45_55', '45–55°'], ['a30_45', '30–45°'], ['a15_30', '15–30°'], ['a0_15', '0–15°']];
const CURVE_TARGETS = [50, 60, 70, 75, 80, 85, 90, 95, 97, 99];
const ANIM_YEARS = [2026, 2030, 2035, 2040, 2045, 2050];
// Take 4: rows by signed latitude, each with an example city from the atlas's city list
// (pipeline/scripts/pipeline/tenyear/weather.py CITIES).
const BAND_ROWS = [
    ['n65_90', '65°N–90°N', 'Tromsø'], ['n55_65', '55°N–65°N', 'Stockholm'], ['n45_55', '45°N–55°N', 'Berlin'],
    ['n30_45', '30°N–45°N', 'Madrid'], ['n15_30', '15°N–30°N', 'Delhi'], ['n0_15', '0°–15°N', 'Lagos'],
    ['s15_0', '15°S–0°', 'Jakarta'], ['s30_15', '30°S–15°S', 'Johannesburg'], ['s45_30', '45°S–30°S', 'Buenos Aires']
];
// Take 3: nine European countries, north to south.
const EU9 = [['SE', 'Sweden'], ['DK', 'Denmark'], ['UK', 'United Kingdom'], ['NL', 'Netherlands'], ['PL', 'Poland'],
    ['DE', 'Germany'], ['FR', 'France'], ['IT', 'Italy'], ['ES', 'Spain']];

function bandKey(el, v) {   // high latitude first
    chartKey(el, BANDS.map(([id, label], k) => ({ color: COLORS.bands[k], label, weight: `${format(v[`lb.demand.${id}`], 'pct')} of demand` })));
}

function renderCharts() {
    readColors();
    const v = values();
    const usd = x => `$${nf.format(x)}`;
    const el = (id) => document.querySelector(`[data-chart="${id}"]`);
    const narrow = (el('t1')?.clientWidth || 600) < 480;
    const pctTick = t => `${t}%`;
    const uptimeX = { domain: [50, 99], ticks: [50, 60, 70, 80, 90, 99], format: pctTick };
    const curve = (metric, id, Y) => CURVE_TARGETS.map(t => [t, v[`lb.${metric}.${id}.${t}.${Y}`]]);

    // Take 1: the saving from adding wind as uptime rises, one panel per band (high to low
    // latitude, reading order) and the world, on shared axes.
    const saveMax = Math.max(...[...BANDS.map(b => b[0]), 'world'].flatMap(id => CURVE_TARGETS.map(t => v[`lb.saving.${id}.${t}.2026`])).filter(Number.isFinite));
    const saveTop = Math.ceil(saveMax / 100) * 100;
    smallMultiples(el('t1'), {
        cols: 3, colsNarrow: 2, height: narrow ? 100 : 120,
        x: { domain: [50, 99], ticks: [50, 75, 99], format: pctTick },
        y: { domain: [0, saveTop], ticks: d3.range(0, saveTop + 1, saveTop > 300 ? 200 : 100), format: usd },
        area: true, endValue: usd,
        panels: [...BANDS, ['world', 'World']].map(([id, label]) => ({
            title: label,
            series: [{ label: 'Saving from wind', color: COLORS.wind, points: CURVE_TARGETS.map(t => [t, v[`lb.saving.${id}.${t}.2026`]]) }]
        }))
    });

    const pwh = x => nf.format(Math.round(x));
    barChart(el('t2'), {
        max: Math.max(v['t2.tech.on.twh'] / 1000, 1) * 1.02,
        format: pwh,
        rows: [
            { label: 'Onshore wind', value: v['t2.tech.on.twh'] / 1000, low: v['t2.cons.on.twh'] / 1000, color: COLORS.wind, lowLabel: 'conservative case' },
            { label: 'Offshore wind, fixed-bottom', value: v['t2.iea.offFixed.twh'] / 1000, low: v['t2.cons.offFixed.twh'] / 1000, color: COLORS.offshore, lowLabel: 'conservative case' },
            { label: 'Offshore wind, floating', value: v['t2.iea.offFloat.twh'] / 1000, low: v['t2.cons.offFloat.twh'] / 1000, color: COLORS.offshore, lowLabel: 'conservative case' },
            { label: 'World electricity demand, 2025', value: v['ext.demand2025'] / 1000, color: COLORS.demand }
        ]
    });

    // Take 3: nine countries, the same axes, solar and wind by month.
    chartKey(el('t3'), [{ color: COLORS.solar, label: 'Solar' }, { color: COLORS.wind, label: 'Wind' }]);
    smallMultiples(el('t3'), {
        cols: 3, colsNarrow: 3, height: narrow ? 70 : 90,
        x: { domain: [1, 12], ticks: [1, 4, 7, 10], format: m => MONTHS[m - 1][0] },
        y: { domain: [0, 18], ticks: [0, 5, 10, 15], format: p => `${p}%` },
        labelPanel: -1,
        panels: EU9.map(([id, name]) => ({
            title: name,
            series: [
                { label: 'Solar', color: COLORS.solar, points: MONTHS.map((_, i) => [i + 1, v[`t3m.${id}.solar.${i + 1}`] * 100]), labelAt: [6, -6, 'middle'] },
                { label: 'Wind', color: COLORS.wind, points: MONTHS.map((_, i) => [i + 1, v[`t3m.${id}.wind.${i + 1}`] * 100]), labelAt: [12, -6, 'end'] }
            ]
        }))
    });

    // Take 4: by latitude, people-weighted, 80% uptime, with an example city per band.
    dumbbell(el('t4'), {
        max: 200, ticks: [0, 50, 100, 150, 200], format: usd,
        colorA: COLORS.sb, colorB: COLORS.wind, labelA: 'Solar + batteries', labelB: 'Solar + batteries + wind',
        rows: BAND_ROWS.map(([id, label, city]) => {
            const reach = v[`t4.sbReach.${id}.80`];
            const compare = reach >= 0.7 && Number.isFinite(v[`t4.sbBoth.${id}.80`]);
            return compare
                ? { label, sub: city, a: v[`t4.sbBoth.${id}.80`], b: v[`t4.windBoth.${id}.80`] }
                : { label, sub: city, a: null, b: v[`t4.medWind.${id}.80`] };
        })
    });

    // Take 5a: the cost of high uptime against uptime, by band, year by year to 2050.
    const animEl = el('t5anim');
    bandKey(animEl, v);
    const fig = animEl.closest('figure');
    animatedCurves(animEl, {
        height: narrow ? 250 : 280,
        x: uptimeX, xTitle: 'Uptime: share of the load served',
        y: { domain: [0, 225], ticks: [0, 50, 100, 150, 200], format: usd },
        firstLabel: 'Dashed: 2026',
        frames: ANIM_YEARS.map(Y => ({ year: Y, series: BANDS.map(([id, label], k) => ({ id, label, color: COLORS.bands[k], points: curve('best', id, Y) })) }))
    }, { button: fig.querySelector('[data-play]'), loop: true });

    // Take 5b: per band, 90% uptime, solar + batteries alone against with wind, 2026-2050.
    chartKey(el('t5b'), [{ color: COLORS.sb, label: 'Solar + batteries' }, { color: COLORS.wind, label: 'Solar + batteries + wind' }]);
    smallMultiples(el('t5b'), {
        cols: 5, colsNarrow: 3, height: narrow ? 90 : 120,
        x: { domain: [2026, 2050], ticks: [2030, 2040, 2050], ticksNarrow: [2030, 2050], format: y => (narrow ? `’${String(y).slice(2)}` : String(y)) },
        y: { domain: [0, 300], ticks: [0, 100, 200, 300], format: usd },
        labelPanel: -1,
        panels: BANDS.map(([id, label]) => ({
            title: label,
            note: v[`lb.cut.${id}.90.2050`] < 0.005 && v[`lb.cut.${id}.90.2026`] < 0.005 ? 'lines coincide' : null,
            series: [
                { label: 'Solar + batteries', color: COLORS.sb, points: ANIM_YEARS.map(Y => [Y, v[`lb.sb.${id}.90.${Y}`]]) },
                { label: 'Solar + batteries + wind', color: COLORS.wind, points: ANIM_YEARS.map(Y => [Y, v[`lb.wind.${id}.90.${Y}`]]) }
            ]
        }))
    });
}

// Play the animation once, from 2026, when it first comes into view.
function autoplayOnce() {
    const animEl = document.querySelector('[data-chart="t5anim"]');
    if (!animEl || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
        if (!entries.some(e => e.isIntersecting)) return;
        io.disconnect();
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && animEl.__anim) {
            animEl.__anim.k = animEl.__anim.k >= 0 ? animEl.__anim.k : 0;
            animEl.__anim.play();
        }
    }, { threshold: 0.6 });
    io.observe(animEl);
}

// ---------------------------------------------------------------------------
// Map states (layers.js)
// ---------------------------------------------------------------------------
const els = {};
function applyMapState(name, { instant = false } = {}) {
    const def = MAP_STATES[name];
    if (!def) return;
    const entering = state.mapState !== name;
    state.mapState = name;
    setView(def.view);
    els.title.textContent = typeof def.title === 'function' ? def.title(state.year) : def.title;
    els.sub.textContent = def.sub;
    els.controls.hidden = !def.controls;
    if (def.blank) {
        clear();
        els.legend.innerHTML = '';
        els.legend.hidden = true;
        els.status.hidden = true;
        return;
    }
    if (!def.ready(state.data, state.year)) {
        // The summary has not arrived (or could not load): say so.
        els.legend.hidden = true;
        els.status.hidden = false;
        els.status.textContent = state.loadingText || 'Loading the map…';
        return;
    }
    els.status.hidden = true;
    els.legend.hidden = false;
    paint(def.layer(state.data, state.year), { instant });
    if (!instant || entering) els.legend.innerHTML = def.legend();
    // Take 5's map plays its years once, the first time it comes into view.
    if (entering && name === 'windcost' && !state.yearsPlayed && state.playYears) {
        state.yearsPlayed = true;
        setTimeout(() => state.mapState === 'windcost' && state.playYears(), 900);
    }
}

function refreshMap() {
    if (state.mapState) applyMapState(state.mapState);
}

// The section whose top has passed the trigger line sets the map.
function currentSection() {
    const sections = document.querySelectorAll('[data-map]');
    const phone = window.matchMedia('(max-width: 900px)').matches;
    const visualH = phone ? els.visual.getBoundingClientRect().height : 0;
    const line = phone ? visualH + (window.innerHeight - visualH) * 0.45 : window.innerHeight * 0.5;
    let pick = sections[0];
    sections.forEach((s) => { if (s.getBoundingClientRect().top <= line) pick = s; });
    return pick;
}

let scrollQueued = false;
function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
        scrollQueued = false;
        const s = currentSection();
        if (s && s.dataset.map !== state.mapState) applyMapState(s.dataset.map);
        document.querySelectorAll('.take').forEach(t => t.classList.toggle('is-active', t === s));
    });
}

function reportError(e) {
    state.errors.push(String(e?.stack || e));
    console.error('[article]', e);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
    for (const id of ['visual', 'title', 'sub', 'controls', 'legend', 'status', 'tooltip']) {
        els[id] = document.getElementById(id === 'visual' ? 'visual' : `map-${id}`);
    }
    // The summary and the basemap load in parallel.
    const summaryP = loadSummary();
    summaryP.catch(() => {});   // reported below
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (state.data) { try { renderCharts(); } catch (e) { reportError(e); } }
            onScroll();
        }, 150);
    });

    // Take 5's map: a year slider, 2026 to 2050, with Play (hidden under prefers-reduced-motion).
    const slider = document.getElementById('map-year');
    const yearLabel = document.getElementById('map-year-label');
    const playBtn = els.controls.querySelector('[data-map-play]');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    playBtn.hidden = reduced;
    const setYear = (y) => {
        state.year = y;
        slider.value = String(y);
        yearLabel.textContent = String(y);
        if (state.mapState === 'windcost') applyMapState('windcost', { instant: true });
    };
    const stopYears = () => {
        clearInterval(state.yearTimer);
        state.yearTimer = null;
        playBtn.textContent = 'Play';
        playBtn.setAttribute('aria-pressed', 'false');
    };
    const playYears = () => {
        if (reduced) return;
        if (state.year >= 2050) setYear(2026);
        playBtn.textContent = 'Pause';
        playBtn.setAttribute('aria-pressed', 'true');
        state.yearTimer = setInterval(() => {
            if (state.year >= 2050 || state.mapState !== 'windcost') { stopYears(); return; }
            setYear(state.year + 1);
        }, 280);
    };
    state.playYears = playYears;
    slider.addEventListener('input', () => { stopYears(); setYear(Number(slider.value)); });
    playBtn.addEventListener('click', () => (state.yearTimer ? stopYears() : playYears()));

    const mapP = initMap(document.getElementById('map'), els.tooltip);
    try {
        const d = await summaryP;
        state.data = d;
        state.v = d.values;
        state.rows = Array.from(d.cells.ids, (id, i) => ({ location_id: id, latitude: d.cells.lat[i], longitude: d.cells.lon[i], i }));
        setCells(state.rows);
        bindNumbers(true);
        try { renderCharts(); autoplayOnce(); } catch (e) { reportError(e); }
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { try { renderCharts(); refreshMap(); } catch (e) { reportError(e); } });
    } catch (e) {
        reportError(e);
        state.loadingText = 'The map data could not be loaded.';
        const statusEl = document.getElementById('model-status');
        statusEl.hidden = false;
        statusEl.classList.add('is-error');
        statusEl.textContent = 'The map and chart data could not be loaded; the text shows Ember\'s analysis.';
    }
    await mapP;
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    state.ready = true;
}

main().catch(reportError);
