// story.js – "Harnessing the Winds" as a scrollytelling piece (story.html, T087).
//
// Same data contract as article.js: every figure in the text is a <span data-n data-f> whose static text is
// the audited value; the page loads data/article-summary.json and shows its values, recording any span
// whose text differs (window.__article.textMismatch). The map's colours and tooltips are layers.js's, so
// verify-article compares every cell of every state with the live model, as for index.html.
//
// Motion (GSAP + ScrollTrigger, self-hosted in vendor/): the opening map comes alive; the key numbers count
// up; short map segments in each section pin one shared map (story-map.js, colours from story-layers.js)
// and scrub it between states as the cards pass; the charts have their own motion (story-charts.js). With
// prefers-reduced-motion, nothing animates: each card switches the map when it reaches the middle.
import { loadSummary } from './summary.js';
import { MAP_STATES, LAYER_CASES, dumpLayer } from './layers.js';
import { storyLayer, storyLegend, dumpStoryLayer, ramp, stateDef, STORY_STATES, plannedPoints, plannedTotals, COST_YEARS } from './story-layers.js';
import { createMorph } from './story-morph.js';
import { defineSets } from './story-sets.js';

// Map states whose colours follow the cost year (a card with data-year-scrub moves it 2026 -> 2050)
const YEAR_STATES = new Set(['windcost', 'cost99y', 'saving99y', 'saving100y']);
import { format } from './format.js';
import { createStoryMap } from './story-map.js';
import { renderCharts, chartMotion, reapplyMotion, stepChart } from './story-charts.js';
import { drawSummaryCharts, drawPeopleCharts, drawPlannedHist } from './article-charts.js';
import { staticMap, scaleOf, rewound } from './static-map.js';

const MAP_PHONE = 0.72;     // phone: the map's share of the screen height (css/story.css .smap)
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const phoneQuery = window.matchMedia('(max-width: 900px)');

const state = {
    v: {},
    data: null,
    rows: [],
    textMismatch: [],
    errors: [],
    chartKeys: {},
    ready: false,
    mapState: null,
    year: 2026,
    p: 0                 // the scrolly's position, in steps (step i's card centred at p = i)
};
window.__article = state;
state.values = () => ({ ...state.v });
// The story's own colours of every cell (story-layers.js), for the probe.
state.dumpStoryLayers = () => [...LAYER_CASES, ...Object.keys(STORY_STATES).filter(n => !YEAR_STATES.has(n)).map(n => [n]), ['saving100y', 2026], ['saving100y', 2050]].map(([name, year]) => ({ name, year, fill: dumpStoryLayer(state.data, state.rows, name, year) }));
state.canDraw = (name) => { if (name.startsWith('dots:')) return Object.values(state.morph?.sets || {}).some(s => name.slice(5) in s.L); if (name.startsWith('chart:')) return !!document.querySelector(`.seg__chart [data-chart="${name.slice(6)}"] svg`); try { return typeof storyLayer(name, state.data, 2026).fill === 'function' && !!stateDef(name); } catch (e) { return false; } };
state.legendFor = (name) => storyLegend(name, state.data);
// The planned-capacity dots' colours of a state (the probe checks the tier legend against them).
state.plannedColours = (name) => [...new Set(plannedPoints(name, state.data, state.rows).map(p => p.colour.toUpperCase()))];
state.rampAt = (name, frac) => ramp(name).at(frac);
state.dumpLayers = () => LAYER_CASES.map(([name, year]) => ({ name, year, ...dumpLayer(state.data, state.rows, name, year) }));

function reportError(e) {
    state.errors.push(String(e?.stack || e));
    console.error('[story]', e);
}

/** The summary's values, recording each key a chart reads under `id`; a missing key is an error (as charts-page.js). */
function tracked(id) {
    const keys = (state.chartKeys[id] ||= new Set());
    return new Proxy(state.v, {
        get(t, k) {
            if (typeof k !== 'string') return t[k];
            keys.add(k);
            if (!Number.isFinite(t[k])) state.errors.push(`chart ${id}: no summary value for ${k}`);
            return t[k];
        }
    });
}
// The round-8 charts in the text (article-charts.js, the same as charts.html's): drawn on the page's light tokens
const CTX = {
    el: id => document.querySelector(`[data-chart="${id}"]`),
    tracked, state,
    token: name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
};
/** The round-8 charts: those from the summary at once, those from the per-region columns once these have loaded. */
function drawArticleCharts() {
    drawSummaryCharts(CTX);
    if (state.data?.story) drawPeopleCharts(CTX, state.data);
    if (state.data?.planned) drawPlannedHist(CTX, state.data);
}

function bindNumbers(firstPass) {
    document.querySelectorAll('[data-n]').forEach((el) => {
        const key = el.dataset.n, f = el.dataset.f;
        const val = state.v[key];
        if (!Number.isFinite(val)) {
            if (firstPass) state.textMismatch.push({ key, text: el.textContent.trim(), expected: null });
            return;
        }
        const text = format(val, f);
        if (firstPass && el.textContent.trim() !== text) {
            state.textMismatch.push({ key, text: el.textContent.trim(), expected: text });
            console.warn(`[story] text for ${key} reads "${el.textContent.trim()}", the summary gives "${text}"`);
        }
        el.textContent = text;
    });
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// 1. Opening: the world's onshore wind, drawn from the weakest region to the windiest
// ---------------------------------------------------------------------------
async function opening(world) {
    const box = document.querySelector('.opening__map');
    const canvas = document.getElementById('opening-map');
    const m = createStoryMap(box, {
        world, rows: state.rows,
        rects: (w, h) => {
            const safe = phoneQuery.matches
                ? { x0: 12, y0: Math.max(24, h * 0.05), x1: w - 12, y1: h * 0.48 }
                : { x0: Math.min(w * 0.38, 560), y0: h * 0.1, x1: w - 32, y1: h * 0.9 };
            return { safe, full: safe };
        }
    });
    const layer = storyLayer('windcf', state.data);
    const cf = state.data.cells.onCf, ok = state.data.cells.onViable;
    const order = state.rows.map(r => r.i).sort((a, b) => (ok[a] ? cf[a] : -1) - (ok[b] ? cf[b] : -1));
    // T090: a compact legend says what the opening map shows (the region mosaic, average onshore wind capacity factor)
    const leg = document.getElementById('opening-legend');
    if (leg) { leg.innerHTML = storyLegend('windcf', state.data); leg.hidden = false; }
    await m.reveal(canvas, layer.fill, order, 3200, reduced);
    document.querySelector('.opening').classList.add('is-alive');
}

// ---------------------------------------------------------------------------
// 2. Key findings: the big numbers count up once, the first time they come into view
// ---------------------------------------------------------------------------
function countUp() {
    const els = [...document.querySelectorAll('[data-count]')];
    if (reduced || !els.length) return;
    ScrollTrigger.create({
        trigger: '.findings', start: 'top 70%', once: true,
        onEnter: () => els.forEach((el, k) => {
            const v = state.v[el.dataset.n], f = el.dataset.f;
            if (!Number.isFinite(v)) return;
            const o = { x: 0 };
            gsap.to(o, {
                x: v, duration: 1.6, delay: k * 0.15, ease: 'power2.out',
                onUpdate: () => { el.textContent = format(o.x, f); },
                onComplete: () => { el.textContent = format(v, f); }
            });
        })
    });
}

// ---------------------------------------------------------------------------
// 4. The map segments: one map, moved into the segment being read
// ---------------------------------------------------------------------------
// Every section has a short segment (2-3 cards and a picture-only beat) where the paragraph it carries used
// to be. The stage (map canvases, caption, legend) is one element, re-parented into the sticky slot of the
// segment nearest the reading position, so the canvases are drawn once and reused. One scroll position p
// runs over all segments' steps (step i's card centred at p = i); between two segments nothing blends.
const els = {};
const regionOf = (view) => view.replace(/-full$/, '');                 // world, europe, ... (map.js VIEWS)
const layerName = (s) => (s === 'saving-europe' ? 'saving' : s);     // the same colours, at two zooms

function scrolly(world) {
    const slots = [...document.querySelectorAll('.seg__slot')];
    // A step shows the map (data-state, data-view) or a chart panel of its segment (data-chart, data-chart-step).
    // A chart step keeps the map state of its segment's nearest map step, so the map behind is ready.
    const steps = [...document.querySelectorAll('.seg .step')].map(el => ({
        el, state: el.dataset.state || null, view: el.dataset.view || 'world', chart: el.dataset.chart || null,
        dots: el.dataset.dots || null, dotsSet: el.closest('.seg').dataset.dotsSet || null,
        cs: Number(el.dataset.chartStep || 0), seg: slots.indexOf(el.closest('.seg').querySelector('.seg__slot'))
    }));
    steps.forEach((s, k) => {
        if (s.state) return;
        const near = [...steps.slice(0, k).reverse(), ...steps.slice(k + 1)].find(q => q.seg === s.seg && q.state);
        s.mapState = near ? near.state : null;
    });
    steps.forEach(s => { if (s.state) s.mapState = s.state; });
    let segOn = 0, lastY = window.scrollY, goingDown = true;
    const segOf = slots.map(sl => sl.closest('.seg'));
    let segNow = 0;   // T101: the segment on screen, whose claim heads the caption
    const firstOf = slots.map((_, k) => steps.findIndex(s => s.seg === k));
    const lastOf = slots.map((_, k) => steps.length - 1 - [...steps].reverse().findIndex(s => s.seg === k));
    // The states each region view shows, with the states next to them in the same segment (drawn at that
    // region's zoom too, so a glide in or out stays sharp).
    const regionStates = {};
    steps.forEach((s, k) => {
        const R = regionOf(s.view);
        if (R === 'world') return;
        const set = (regionStates[R] ||= new Set());
        for (const j of [k - 1, k, k + 1]) if (steps[j] && steps[j].seg === s.seg && steps[j].mapState) set.add(layerName(steps[j].mapState));
    });
    const n = steps.length;
    const last = n - 1;
    // Steps whose card scrubs the cost year 2026 -> 2050 as it passes (data-year-scrub); any number.
    const yearSteps = steps.map((s, k) => (s.el.hasAttribute('data-year-scrub') ? k : -1)).filter(k => k >= 0);
    const map = createStoryMap(els.map, {
        world, rows: state.rows,
        rects: (w, h) => {
            if (phoneQuery.matches) {
                const mh = h * MAP_PHONE;
                const r = { x0: 6, y0: 110, x1: w - 6, y1: mh - 6 };   // below the caption and legend
                return { safe: r, full: r };
            }
            const cardRight = Math.min(460, w * 0.36) + Math.max(16, Math.min(64, w * 0.05)) + 24;
            // the caption and legend sit in the top right: the map fits below them
            return { safe: { x0: cardRight, y0: Math.min(220, h * 0.24), x1: w - 24, y1: h - 40 }, full: { x0: 32, y0: Math.min(220, h * 0.24), x1: w - 32, y1: h - 32 } };
        }
    });
    state.storyMap = map;
    // The morph: the map's regions become dots and fly into a chart (story-morph.js; the sets in story-sets.js)
    const plotRect = (w, h) => (phoneQuery.matches
        ? { x0: 10, x1: w - 10, y0: 10, y1: h - 36 }      // h: the map box itself (72% of the screen on phones; T090 audit)
        : { x0: Math.min(460, w * 0.36) + Math.max(16, Math.min(64, w * 0.05)) + 56, x1: w - 48, y0: 36, y1: h - 76 });
    // (y0: the top of the chart head; the piles start below the tallest head of their set, story-morph.js)
    const morph = createMorph(els.map, map, state.rows, plotRect, state.data.shapes);
    defineSets(morph, state.data, state.rows);
    state.morph = morph;
    // Warm the morph once per set while the page is idle (the first frame of a set compiles its drawing path), so the
    // first scroll into a morph is as quick as the rest; drawn and cleared in the same task, never painted.
    {
        const idleW = window.requestIdleCallback || ((fn) => setTimeout(fn, 80));
        const todo = Object.entries(morph.sets).map(([id, s]) => [id, Object.keys(s.L)[0]]);
        const next = () => { const job = todo.shift(); if (!job) return; if (state.mapState == null || !String(state.mapState).startsWith('dots:')) { try { morph.render(job[0], null, job[1], 0.5); morph.hide(); } catch (e) { reportError(e); } } idleW(next); };
        idleW(next);
    }
    state.tilesDrawn = () => morph.drawn;
    state.tileGrowth = () => morph.growth;
    state.landed = (id, name) => morph.landed(id, name);
    // Work out each state's legend once, when the page is idle, so no legend swap costs a long task while scrolling
    {
        const names = [...new Set(steps.map(x => x.mapState).filter(Boolean))];
        const idle0 = window.requestIdleCallback || ((fn) => setTimeout(fn, 50));
        const next = () => { const nm = names.shift(); if (!nm) return; try { storyLegend(nm, state.data, state.year); } catch (e) { reportError(e); } idle0(next); };
        idle0(next);
    }

    // Layer fills, memoised per state and year.
    const fills = new Map();
    const layerOf = (name, year) => {
        const key = YEAR_STATES.has(name) ? `${name}:${year}` : name;
        if (!fills.has(key)) fills.set(key, storyLayer(name, state.data, year));
        return fills.get(key);
    };
    const drawnYear = {};
    // A year state's layer for one of the cost years is named "<state>~<year>" (the scrub crossfades them, below); a
    // plain year state's layer follows state.year (the probe).
    const ensure = (name0, g) => {
        const key = `${name0}@${g}`;
        const [name, ys] = name0.split('~');
        const pts = name.startsWith('planned') ? plannedPoints(name, state.data, state.rows) : null;
        const fresh = !map.layers.has(key);
        const L = map.ensure(key, g, layerOf(name, ys ? Number(ys) : state.year).fill, pts);
        if (ys && fresh) {
            // the cost years stack in order, later above earlier, so a crossfade only ever fades the later one in
            const cs = COST_YEARS.map(Y => map.layers.get(`${name}~${Y}@${g}`)?.canvas).filter(Boolean);
            for (let k = 1; k < cs.length; k++) if (cs[k - 1].nextSibling !== cs[k]) cs[k - 1].after(cs[k]);
        }
        if (!ys && YEAR_STATES.has(name) && drawnYear[name] == null) drawnYear[name] = state.year;
        return L;
    };
    /** The cost years either side of a (fractional) year, and how far between them it is. */
    const yearBracket = (yf) => {
        const k = Math.min(COST_YEARS.length - 2, Math.max(0, COST_YEARS.findIndex((Y, j) => j < COST_YEARS.length - 1 && yf <= COST_YEARS[j + 1])));
        const Y0 = COST_YEARS[k], Y1 = COST_YEARS[k + 1];
        return [Y0, Y1, Math.max(0, Math.min(1, (yf - Y0) / (Y1 - Y0)))];
    };

    // Step centres in document px, for p(scrollY): piecewise linear between centres.
    let centres = [], vh = window.innerHeight;
    function measureSteps() {
        vh = window.innerHeight;
        const anchor = 0.5;     // a card "arrives" when its step is centred (phone cards sit at the step's foot)
        centres = steps.map(s => { const r = s.el.getBoundingClientRect(); return window.scrollY + r.top + r.height / 2 - vh * anchor; });
    }
    function pAt(y) {
        if (y <= centres[0]) return (y - centres[0]) / vh;
        for (let i = 0; i < last; i++) if (y < centres[i + 1]) return i + (y - centres[i]) / (centres[i + 1] - centres[i]);
        return last + (y - centres[last]) / vh;
    }

    // For the checks and screenshots: the scroll position that puts the scrolly at p.
    state.yForStep = (p) => {
        measureSteps();
        const i = Math.max(0, Math.min(last - 1, Math.floor(p)));
        return p <= 0 ? centres[0] + p * vh : p >= last ? centres[last] + (p - last) * vh : centres[i] + (p - i) * (centres[i + 1] - centres[i]);
    };
    // For the stage probe (scripts/article/tools/stage-probe.mjs): draw the scene at p without scrolling.
    state.sceneAt = (p) => scene(p);
    state.steps = steps.map(s => ({ state: s.chart ? `chart:${s.chart}` : s.dots ? `dots:${s.dots}` : s.state, view: s.view, seg: s.seg }));

    // For the probe (scripts/article/tools/story-probe.mjs): draw a state's layer as the page does and read
    // the drawn pixel at a sample of region sites, beside the colour story-layers.js gives the region.
    state.probeLayer = (name, year = 2026, every = 7) => {
        const keep = state.year;
        state.year = year;
        const ln = layerName(name), key = `${ln}@world`;
        map.drop(key);
        for (const k of Object.keys(drawnYear)) delete drawnYear[k];
        const L = ensure(ln, 'world');
        const ctx = L.canvas.getContext('2d');
        const fill = layerOf(ln, year).fill;
        const out = [];
        for (let i = 0; i < state.rows.length; i += every) {
            const want = fill(state.rows[i]);
            const q = map.sitePixel('world', i);
            if (want == null || !q) continue;
            const d = ctx.getImageData(q[0], q[1], 1, 1).data;
            out.push({ i, want, drawn: [d[0], d[1], d[2]] });
        }
        map.drop(key);
        state.year = keep;
        for (const k of Object.keys(drawnYear)) delete drawnYear[k];
        scene(state.p);
        return out;
    };

    // The scene at position p: camera, layer opacities, caption and legend.
    let shown = null;          // the state whose caption and legend are up
    let userYear = null;       // a year set with the slider or Play holds until the scroll moves on
    let userYearAt = null;
    function scene(p) {
        if (!Number.isFinite(p)) { console.warn('[story] scene at', p, centres, vh); return; }
        state.p = p;
        if (reduced) p = Math.round(p);
        let pc = Math.max(0, Math.min(last, p));
        // The segment on screen decides: as its stage scrolls into view (before its first card) it shows its first
        // step, and scrolling back up into it, its last step – map, view and legend together (the human, T087).
        const want0 = steps[Math.round(pc)].seg;
        const vis = segOf.map((el) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); });
        // two segments in view at once (little text between them): the one being scrolled into wins
        if (window.scrollY !== lastY) { goingDown = window.scrollY > lastY; lastY = window.scrollY; }
        const down = goingDown;
        const inView = vis.map((v, k) => (v > 0 ? k : -1)).filter(k => k >= 0);
        const best = inView.includes(want0) && inView.length === 1 ? want0 : (down ? Math.max(...inView) : Math.min(...inView));
        if (inView.length && best !== want0) pc = best > want0 ? firstOf[best] : lastOf[best];
        const i = Math.min(last - 1, Math.floor(pc)), f = pc - i;
        const a = steps[i], b = steps[i + 1];
        // within a segment, a scrubbed blend; across two segments (text in between), a plain switch
        const t = a.seg === b.seg ? smooth(0.15, 0.85, f) : (f < 0.5 ? 0 : 1);   // a wide blend: motion flows over most of the scroll between two cards (T091 round 9, the human: super smooth)
        const seg = steps[Math.round(pc)].seg;
        if (seg !== segOn) { segOn = seg; slots[seg].appendChild(els.stage); els.tooltip.hidden = true; }
        // camera: a smooth zoom between the two steps' views
        const cam = a.view === b.view ? map.cams[a.view] : map.between(a.view, b.view, t);
        map.setCamera(cam);
        // A region's own layers fade in over the last part of the zoom into it
        const R = regionOf(t < 0.5 ? a.view : b.view) !== 'world' ? regionOf(t < 0.5 ? a.view : b.view) : regionOf(t < 0.5 ? b.view : a.view);
        const kW = map.cams.world.k;
        const wE = R === 'world' ? 0 : smooth(0.55, 0.95, Math.log(cam.k / kW) / Math.log(map.cams[R].k / kW));
        // chart panels of this segment: cross-fade with the map; the chart's own step follows the scroll
        let chartOp = 0;
        slots[seg].querySelectorAll('.seg__chart').forEach((pn) => {
            const id = pn.dataset.chartPanel;
            const o = (a.chart === id && a.seg === seg ? 1 - t : 0) + (b.chart === id && b.seg === seg ? t : 0);
            pn.style.opacity = String(o);
            pn.style.visibility = o > 0.001 ? 'visible' : 'hidden';
            chartOp = Math.max(chartOp, o);
        });
        els.stage.style.setProperty('--map-op', String(1 - chartOp));
        const cid = t < 0.5 ? (a.chart || b.chart) : (b.chart || a.chart);
        if (cid) {
            const cs = a.chart === b.chart ? a.cs + (b.cs - a.cs) * t : (a.chart === cid ? a.cs : b.cs);
            stepChart(cid, cs);
        }
        const fromS = a.mapState || b.mapState, toS = b.mapState || a.mapState;
        if (!fromS) {
            for (const key of map.layers.keys()) map.setOpacity(key, 0);
            state.mapState = cid ? `chart:${cid}` : null;
            return;
        }
        const from = layerName(fromS), to = layerName(toS), st = from === to ? 0 : t;
        // year: the windcost card scrubs 2026 to 2050
        const ys = yearSteps.find(k => steps[k].seg === steps[Math.round(pc)].seg);
        let yearF = state.year;
        if (ys != null) {
            if (userYear != null && Math.abs(p - userYearAt) > 0.05) userYear = null;
            yearF = userYear ?? (reduced ? state.year : 2026 + 24 * smooth(ys - 0.25, ys + 0.25, p));
            const y = Math.round(yearF);
            if (y !== state.year) setYear(y);
        }
        const want = new Map();
        const add = (key, o) => want.set(key, Math.max(want.get(key) || 0, o));
        // A year state as the scroll moves the year: the two cost years either side, painted once (prefetch, below), the
        // later faded in over the earlier – a GPU crossfade each frame instead of a repaint of every region each year
        const addYearly = (name, g, o) => {
            const [Y0, Y1, f] = yearBracket(yearF);
            add(`${name}~${Y0}@${g}`, o);
            if (f > 0.002) add(`${name}~${Y1}@${g}`, o * f);
        };
        add(`${from}@world`, 1);
        if (st > 0) add(`${to}@world`, st);
        if (wE > 0) {
            const RS = regionStates[R] || new Set();
            const fE = RS.has(from), tE = RS.has(to);
            if (fE) add(`${from}@${R}`, from === to ? wE : (tE ? wE : wE * (1 - st)));
            if (tE && st > 0) add(`${to}@${R}`, wE * st);
        }
        // the morph: dots of this segment's set between the two steps' layouts (null = the polygon map)
        const set = a.seg === seg ? a.dotsSet : b.dotsSet;
        const da = a.seg === seg ? a.dots : null, db = b.seg === seg ? b.dots : null;
        const dotness = set && (da || db) ? morph.render(set, da, db, a.seg === b.seg ? t : (t < 0.5 ? 0 : 1)) : (morph.hide(), 0);
        for (const [key, o] of [...want]) {
            const [name, g] = key.split('@');
            if (YEAR_STATES.has(name)) { want.delete(key); addYearly(name, g, o); }
        }
        // A blend keeps the outgoing state's layer at full strength and fades the incoming one in over it, so the incoming
        // layer must be stacked above it. A layer painted ahead of time (prefetch) can sit below; then the outgoing map
        // covered the incoming one, and once the blend was done the map no longer matched its legend (review, T091
        // round 9: "legend and map don't match"). Put the incoming layers on top as a blend starts, and drop the
        // outgoing state once the incoming one is fully in.
        if (st >= 0.999) for (const k of [...want.keys()]) if (k.split('@')[0].split('~')[0] === from) want.delete(k);
        for (const [key, o] of want) {
            const [name, g] = key.split('@');
            if (o > 0) ensure(name, g);
        }
        if (st > 0 && from !== to) {
            const of = (n) => [...want.keys()].filter(k => k.split('@')[0].split('~')[0] === n).map(k => map.layers.get(k)?.canvas).filter(Boolean);
            const A = of(from), B = of(to);
            for (const cb of B) for (const ca of A) {
                if (ca.parentNode === cb.parentNode && (ca.compareDocumentPosition(cb) & Node.DOCUMENT_POSITION_PRECEDING)) ca.after(cb);
            }
        }
        for (const [key, o] of want) map.setOpacity(key, o * (1 - dotness));
        els.stage.style.setProperty('--key-op', String(1 - morph.pile));
        for (const key of map.layers.keys()) if (!want.has(key)) map.setOpacity(key, 0);
        for (const ys of YEAR_STATES) {
            if (drawnYear[ys] !== state.year && [...map.layers.keys()].some(k => k.startsWith(`${ys}@`))) {
                for (const k of map.layers.keys()) if (k.startsWith(`${ys}@`)) map.repaint(k, layerOf(ys, state.year).fill);
                drawnYear[ys] = state.year;
            }
        }
        const dlay = t < 0.5 ? (da || db) : (db || da);
        const name = (dotness > 0.5 && dlay && morph.stateOf(set, dlay)) || (t < 0.5 ? fromS : toS);
        segNow = steps[Math.round(Math.max(0, Math.min(last, pc)))]?.seg ?? segNow;
        if (name !== shown || els.title.dataset.seg !== String(segNow) || (typeof stateDef(name).title === 'function' && els.title.dataset.year !== String(state.year))) showCaption(name);
        const dl = t < 0.5 ? (da || db) : (db || da);
        state.mapState = chartOp > 0.5 && cid ? `chart:${cid}` : dotness > 0.5 && dl ? `dots:${dl}` : name;
        prefetch(i);
    }

    function showCaption(name) {
        const def = stateDef(name);
        const changed = name !== shown;
        shown = name;
        state.legendState = name;
        const what = typeof def.title === 'function' ? def.title(state.year) : def.title;
        // T101 (audit A): the segment's claim, as the charts article's map title; the state's caption under it
        const claim = segOf[segNow]?.dataset.segTitle;
        els.title.textContent = claim || what;
        els.title.dataset.year = String(state.year);
        els.title.dataset.seg = String(segNow);
        els.sub.textContent = claim ? `${what} (${def.sub})` : def.sub;
        if (changed) {
            els.legend.innerHTML = storyLegend(name, state.data, state.year);
            // a short dip so the legend cross-fades with the map rather than swapping
            els.stage.classList.add('is-switching');
            clearTimeout(showCaption.timer);
            showCaption.timer = setTimeout(() => els.stage.classList.remove('is-switching'), 180);
        }
    }

    // Draw the next steps' layers ahead of time, when the main thread is idle; drop far ones.
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 60));
    let queued = false;
    function prefetch(i) {
        if (queued) return;
        queued = true;
        idle(() => {
            queued = false;
            const keep = new Set();
            for (let k = Math.max(0, i - 2); k <= Math.min(last, i + 3); k++) {
                const s = steps[k];
                if (!s.mapState) continue;
                const name = layerName(s.mapState);
                // a year state: each cost year's layer, earliest first, so the scrub only crossfades
                for (const nm of YEAR_STATES.has(name) ? COST_YEARS.map(Y => `${name}~${Y}`) : [name]) {
                    keep.add(`${nm}@world`);
                    for (const [R, set] of Object.entries(regionStates)) if (set.has(name) && steps.some(q => q.seg === s.seg && regionOf(q.view) === R)) keep.add(`${nm}@${R}`);
                }
            }
            for (const key of [...map.layers.keys()]) if (!keep.has(key)) map.drop(key);
            for (const key of keep) {
                if (!map.layers.has(key)) {
                    const [name, g] = key.split('@');
                    ensure(name, g);
                    map.setOpacity(key, 0);
                    prefetch(i);     // one layer per idle slot
                    return;
                }
            }
        });
    }

    // Year slider and Play (as index.html's map controls), in a card with data-year-scrub; optional.
    const slider = document.getElementById('map-year');
    const yearLabel = document.getElementById('map-year-label');
    const playBtn = document.querySelector('[data-map-play]');
    let timer = null;
    function setYear(y) {
        state.year = y;
        if (slider) slider.value = String(y);
        if (yearLabel) yearLabel.textContent = String(y);
    }
    const hold = (y) => { userYear = y; userYearAt = state.p; setYear(y); scene(state.p); };
    if (slider && playBtn) {
        playBtn.hidden = reduced;
        const stop = () => { clearInterval(timer); timer = null; playBtn.textContent = 'Play'; playBtn.setAttribute('aria-pressed', 'false'); };
        slider.addEventListener('input', () => { stop(); hold(Number(slider.value)); });
        playBtn.addEventListener('click', () => {
            if (timer) { stop(); return; }
            if (state.year >= 2050) hold(2026);
            playBtn.textContent = 'Pause';
            playBtn.setAttribute('aria-pressed', 'true');
            timer = setInterval(() => { if (state.year >= 2050) { stop(); return; } hold(state.year + 1); }, 280);
        });
    }

    // Tooltips: the region under the pointer, in the state on show.
    els.stage.addEventListener('mousemove', (e) => {
        const box = els.map.getBoundingClientRect();
        const x = e.clientX - box.left, y = e.clientY - box.top;
        const idx = map.hit(x, y);
        const tip = idx >= 0 && shown ? layerOf(shown, state.year).tooltip(state.rows[idx]) : null;
        if (!tip) { els.tooltip.hidden = true; return; }
        els.tooltip.innerHTML = tip;
        els.tooltip.hidden = false;
        const w = els.tooltip.offsetWidth, h = els.tooltip.offsetHeight;
        els.tooltip.style.left = `${Math.min(Math.max(8, x + 14), box.width - w - 8)}px`;
        els.tooltip.style.top = `${Math.min(Math.max(8, y - h - 10), box.height - h - 8)}px`;
    });
    els.stage.addEventListener('mouseleave', () => { els.tooltip.hidden = true; });

    // Scroll: a scrubbed proxy (smooths the wheel), or the raw position under reduced motion.
    const section = document.querySelector('.article');
    const proxy = { u: 0 };
    let st = null;
    const range = () => [centres[0] - vh, centres[last] + vh];
    function build() {
        if (st) st.kill();
        measureSteps();
        const apply = () => { const [a, b] = range(); scene(pAt(reduced ? window.scrollY : a + proxy.u * (b - a))); };
        if (reduced) {
            st = ScrollTrigger.create({ trigger: section, start: 'top bottom', end: 'bottom top', onUpdate: apply, onRefresh: () => { measureSteps(); apply(); } });
        } else {
            const tw = gsap.fromTo(proxy, { u: 0 }, { u: 1, ease: 'none', paused: true, immediateRender: false, onUpdate: apply });
            st = ScrollTrigger.create({
                trigger: section, scrub: 0.9, animation: tw,
                start: () => { measureSteps(); return range()[0]; }, end: () => range()[1]
            });
            const [a, b] = range();
            proxy.u = Math.min(1, Math.max(0, (window.scrollY - a) / (b - a)));
        }
        apply();
    }
    build();
    let t = null;
    // Rebuild when the map's own box changes size, not on every window resize (the human, 7 Nov 2026, on an iPhone):
    // a phone's browser bar fires resize while scrolling without changing the stage (sized in svh), and rebuilding then
    // dropped and repainted every layer; while a frame that loads small and grows afterwards (the app's artifact view)
    // changes the stage without changing the window's width, and the map stayed drawn for the tiny first size.
    let boxW = els.map.clientWidth, boxH = els.map.clientHeight;
    new ResizeObserver(() => {
        const w = els.map.clientWidth, h = els.map.clientHeight;
        if (!w || !h || (w === boxW && h === boxH)) return;
        boxW = w; boxH = h;
        clearTimeout(t);
        t = setTimeout(() => {
            map.measure();
            morph.resize();
            for (const key of [...map.layers.keys()]) map.drop(key);
            for (const k of Object.keys(drawnYear)) delete drawnYear[k];
            shown = null;
            build();
        }, 200);
    }).observe(els.map);
    return { build };
}

// ---------------------------------------------------------------------------
// The finance box (T101, as charts.html): each region's own cost of capital and the cost of 90% uptime with it, drawn
// by static-map.js while the box is open (the map takes its width from it), then the box folds
// ---------------------------------------------------------------------------
function financeMap(world) {
    const node = document.querySelector('[data-chart="map-wacc"]');
    const box = document.getElementById('finance-box');
    if (!node || !world) { if (box) box.open = false; return; }
    const d = state.data;
    const lens = (r) => {
        const name = d.cells.country[r.i];
        const usd = v => (Number.isFinite(v) ? `${format(v, 'usd')}/MWh` : 'target not met');
        return `<div class="tt-head">${name && name !== '(none)' ? name : `${r.latitude.toFixed(1)}°, ${r.longitude.toFixed(1)}°`}</div>`
            + (Number.isFinite(d.local.waccLocal[r.i]) ? `<div>Cost of capital: ${format(d.local.waccLocal[r.i], 'pct1')}</div>` : '')
            + `<div>With wind, at that rate: ${usd(d.local.c90[r.i])}</div><div>At ${format(d.local.wacc, 'pct')} everywhere: ${usd(d.story.c90[r.i])}</div>`;
    };
    state.maps ||= {};
    state.maps['map-wacc'] = staticMap(node, { scale: scaleOf('wacc-local'), perPanelLegend: true, d, rows: state.rows, world: rewound(world),
        panels: [{ state: 'wacc-local', tip: lens }, { label: 'Solar + batteries + wind, with that cost of capital', state: 'cost-local', tip: lens }] });
    if (box) box.open = false;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
    gsap.registerPlugin(ScrollTrigger);
    ScrollTrigger.config({ ignoreMobileResize: true });   // no refresh when the phone's browser bar shows or hides
    for (const id of ['title', 'sub', 'legend', 'status', 'tooltip']) els[id] = document.getElementById(`map-${id}`);
    els.map = document.getElementById('map');
    els.stage = document.getElementById('visual');

    // The top progress bar.
    gsap.to('.progress span', { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: reduced ? true : 0.2 } });

    const summaryP = loadSummary();
    const worldP = fetch(new URL('../../data/world.geojson', import.meta.url)).then(r => (r.ok ? r.json() : null));
    // The story's own per-region columns (scripts/article/analysis/t087/build_story_cells.py)
    const cellsP = fetch(new URL('../data/story-cells.json', import.meta.url)).then(r => (r.ok ? r.json() : Promise.reject(new Error('story-cells.json'))));
    cellsP.catch(() => {});
    // Each region's shape for the morph (scripts/article/analysis/t090/build_story_shapes.py): N points, first absolute
    // then differences, in Equal Earth raw units x scale
    const shapesP = fetch(new URL('../data/story-shapes.json', import.meta.url)).then(r => (r.ok ? r.json() : Promise.reject(new Error('story-shapes.json'))));
    shapesP.catch(() => {});
    // planned coal and gas per region, apart (scripts/article/tools/planned-split.py): the section 6 histogram
    const plannedP = fetch(new URL('../data/story-planned.json', import.meta.url)).then(r => (r.ok ? r.json() : Promise.reject(new Error('story-planned.json'))));
    plannedP.catch(() => {});
    // T101: the finance box's map (each region's own cost of capital), as on charts.html
    const localP = fetch(new URL('../data/story-localwacc.json', import.meta.url)).then(r => (r.ok ? r.json() : Promise.reject(new Error('story-localwacc.json'))));
    localP.catch(() => {});
    summaryP.catch(() => {});
    worldP.catch(() => {});
    els.status.textContent = 'Loading the map…';
    els.status.hidden = false;
    try {
        const d = await summaryP;
        state.data = d;
        state.v = d.values;
        state.rows = Array.from(d.cells.ids, (id, i) => ({ location_id: id, latitude: d.cells.lat[i], longitude: d.cells.lon[i], i }));
        bindNumbers(true);
        countUp();
        try { renderCharts(state.v); drawArticleCharts(); chartMotion(reduced); } catch (e) { reportError(e); }
    } catch (e) {
        reportError(e);
        els.status.textContent = 'The map data could not be loaded.';
        const s = document.getElementById('model-status');
        s.hidden = false;
        s.classList.add('is-error');
        s.textContent = 'The map and chart data could not be loaded; the text shows Ember\'s analysis.';
        state.ready = true;
        return;
    }
    const world = await worldP;
    try {
        const sc = await cellsP;
        const story = {};
        for (const [k, v] of Object.entries(sc)) if (Array.isArray(v)) story[k] = Float64Array.from(v, x => (x == null ? NaN : x));
        state.data.story = story;
        const sh = await shapesP;
        state.data.shapes = { N: sh.N, pts: sh.pts.map((p) => {
            if (!p) return null;
            const out = new Float32Array(p.length);
            let x = 0, y = 0;
            for (let j = 0; j < p.length; j += 2) { x += p[j]; y += p[j + 1]; out[j] = x / sh.scale; out[j + 1] = y / sh.scale; }
            return out;
        }) };
        state.plannedTotals = plannedTotals(state.data, state.rows);
        state.data.planned = await plannedP;
        drawArticleCharts();
        const lw = await localP;
        const f64 = a => Float64Array.from(a, x => (x == null ? NaN : x));
        state.data.local = { wacc: lw.wacc, c90: f64(lw.c90), waccLocal: f64(lw.waccLocal) };
        financeMap(world);
    } catch (e) { reportError(e); }
    els.status.hidden = true;
    const openingP = opening(world).catch(reportError);
    try { scrolly(world); } catch (e) { reportError(e); }
    let resizeTimer = null, chartsW = window.innerWidth;
    window.addEventListener('resize', () => {
        if (window.innerWidth === chartsW) return;   // the browser bar (height only): the charts are sized by width
        chartsW = window.innerWidth;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { try { renderCharts(state.v); drawArticleCharts(); reapplyMotion(reduced); } catch (e) { reportError(e); } ScrollTrigger.refresh(); }, 150);
    });
    window.addEventListener('load', () => ScrollTrigger.refresh());
    await openingP;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    state.ready = true;
}

main().catch(reportError);
