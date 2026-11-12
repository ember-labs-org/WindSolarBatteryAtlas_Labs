// charts-page.js – charts.html, the charts-only version of the article (T091): binds the numbers and draws every
// chart statically from the summary. No map, no scroll-driven motion, no GSAP.
//
// Numbers: as story.js, every figure in the text is a <span data-n data-f> whose static text is the committed
// summary's value; a span that does not read as the summary's value is recorded (window.__article.textMismatch).
// Charts: every summary key a chart reads is recorded (window.__article.chartKeys); a key the summary does not have
// is an error, so no chart can draw an empty bar silently. verify-article.mjs checks both.
import { loadSummary } from './summary.js';
import { format, nf } from './format.js';
import { smallMultiples, barChart, dumbbell, chartKey } from './charts.js';
import { drawV2Charts } from './story-charts.js';
import { drawSummaryCharts, drawPlannedHist as plannedHist, drawPeopleCharts as peopleCharts } from './article-charts.js';
import { staticMap, rewound, staticPaint, scaleOf } from './static-map.js';
import { storyLayer, storyLegend, plannedPoints, plannedTotals } from './story-layers.js';

const state = { v: {}, textMismatch: [], errors: [], chartKeys: {}, maps: {}, ready: false };
window.__article = state;
state.values = () => ({ ...state.v });

function reportError(e) {
    state.errors.push(String(e?.stack || e));
    console.error(e);
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
            console.warn(`[article] text for ${key} reads "${el.textContent.trim()}", the summary gives "${text}"`);
        }
        el.textContent = text;
    });
}

/** The summary's values, recording each key a chart reads under `id`; a missing key is an error. */
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

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const el = (id) => document.querySelector(`[data-chart="${id}"]`);
const usd = x => `$${nf.format(Math.round(x))}`;
const pct = x => `${Math.round(x * 100)}%`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Bands of absolute latitude (model.js ABS_BANDS), high latitude first, as story-charts.js
const BANDS = [['a55p', '55°+'], ['a45_55', '45–55°'], ['a30_45', '30–45°'], ['a15_30', '15–30°'], ['a0_15', '0–15°']];
const YEARS = [2026, 2030, 2035, 2040, 2045, 2050];
// Nine European countries, north to south (as story-charts.js, take 3)
const EU9 = [['SE', 'Sweden'], ['DK', 'Denmark'], ['UK', 'United Kingdom'], ['NL', 'Netherlands'], ['PL', 'Poland'],
    ['DE', 'Germany'], ['FR', 'France'], ['IT', 'Italy'], ['ES', 'Spain']];

function draw() {
    const C = {
        sb: token('--c-sb'), wind: token('--c-wind'), solar: token('--c-solar'), demand: token('--c-context'),
        offshore: token('--c-band-4'), fossil: token('--n2'), tier130: token('--c-tier130'),
        people: token('--c-people'), demandShare: token('--c-demand-share'), y2026: token('--c-context')
    };
    const narrow = (el('bands90')?.clientWidth || 600) < 480;

    // The article v2's charts still on this page (drought, backup), as index.html draws them
    {
        const v = tracked('v2');
        drawV2Charts(v);
    }

    // Section 2: the cost of 90% uptime by band of latitude, without and with wind (s2.<band>.*, demand-weighted); T100: not
    // in the human's draft of 9 Nov 2026, so drawn only if the page has it
    if (el('bands90')) {
        const v = tracked('bands90');
        dumbbell(el('bands90'), {
            max: 300, ticks: [0, 100, 200, 300], format: usd,
            colorA: C.sb, colorB: C.wind, labelA: 'Solar + batteries', labelB: 'Solar + batteries + wind', labelBoth: true,
            rows: BANDS.map(([id, label]) => ({
                label, sub: `${format(v[`lb.demand.${id}`], 'pct')} of demand`,
                a: v[`s2.${id}.sb_demand.90`], b: v[`s2.${id}.sbw_demand.90`]
            }))
        });
    }

    // Section 2: solar and wind by month, nine European countries (the article's chart 3, without the hover motion)
    {
        const v = tracked('t3');
        chartKey(el('t3'), [{ color: C.solar, label: 'Solar' }, { color: C.wind, label: 'Wind' }]);
        smallMultiples(el('t3'), {
            cols: 3, colsNarrow: 3, height: narrow ? 70 : 90,
            x: { domain: [1, 12], ticks: [1, 4, 7, 10], format: m => MONTHS[m - 1][0] },
            y: { domain: [0, 18], ticks: [0, 5, 10, 15], format: p => `${p}%` },
            labelPanel: -1,
            panels: EU9.map(([id, name]) => ({
                title: narrow && name === 'United Kingdom' ? 'UK' : name,   // the panel is too narrow for the full name on phones
                series: [
                    { label: 'Solar', color: C.solar, points: MONTHS.map((_, i) => [i + 1, v[`t3m.${id}.solar.${i + 1}`] * 100]) },
                    { label: 'Wind', color: C.wind, points: MONTHS.map((_, i) => [i + 1, v[`t3m.${id}.wind.${i + 1}`] * 100]) }
                ]
            }))
        });
    }

    // Sections 1, 7 and 8: the saving by latitude and uptime, the countries, the saving to 2050 (article-charts.js,
    // shared with the scrolly)
    drawSummaryCharts(CTX);

    // Section 6: the planned coal and gas pipeline and its tiers at 80% uptime (s6.*, T089/T090)
    if (el('tiers')) {   // T091 round 6: no longer on the page (the planned histogram replaced it); kept for a quick return
        const v = tracked('tiers');
        const gw = x => `${nf.format(Math.round(x))} GW`;
        barChart(el('tiers'), {
            max: 900, format: gw,
            rows: [
                { label: 'All planned coal and gas', value: v['s6.planned.gw'], color: C.fossil },
                { label: 'Solar + batteries, under $100/MWh', value: v['s6.local.sb.under100.80.gw'], color: C.sb },
                { label: 'Solar + batteries + wind, under $100/MWh', value: v['s6.local.sbw.under100.80.gw'], color: C.wind },
                { label: 'Solar + batteries + wind, under $130/MWh', value: v['s6.local.sbw.under130.80.gw'], color: C.tier130 }
            ]
        });
    }
}


// ---------------------------------------------------------------------------
// Maps (T091 round 2): each scrolly map segment as one static map figure, drawn with the scrolly map's own colours
// (story-layers.js), legend and tooltips. data: the summary (sites, results), story-cells.json, data/world.geojson.
// ---------------------------------------------------------------------------
// The drought maps (T091 round 6, the human): T088 measured droughts only where there is a usable wind site (best
// onshore capacity factor of at least 2%, buildable onshore land). The 155 regions without one (the Amazon and Congo
// basins, islands, a few inland deserts) take the mean of their six nearest measured regions, for solar, wind and both,
// so the map has no holes (the human: no note needed). The article's numbers do not use these estimates.
const DROUGHT_KEYS = ['droughtSolar', 'droughtWind', 'droughtBoth'];
function fillDroughtGaps(d) {
    const S = d.story, { lat, lon } = d.cells, rad = Math.PI / 180, K = 6;
    const have = [], gaps = [];
    for (let i = 0; i < lat.length; i++) (Number.isFinite(S.droughtWind[i]) ? have : gaps).push(i);
    for (const i of gaps) {
        const ci = Math.cos(lat[i] * rad);
        const near = have.map(j => { const dx = (lon[j] - lon[i] + 540) % 360 - 180, dy = lat[j] - lat[i]; return [dx * dx * ci * ci + dy * dy, j]; })
            .sort((a, b) => a[0] - b[0]).slice(0, K);
        for (const k of DROUGHT_KEYS) S[k][i] = near.reduce((t, [, j]) => t + S[k][j], 0) / K;
    }
}

const MAPS = {
    // §1: cost of 90% uptime without wind, then with it (the scrolly's cost-sb -> cost-wind), at the article's common cost
    // of capital (T091, the human: compare the physics, not the financing)
    'map-cost90': { legend: 'cost-sb', panels: [{ label: 'Solar + batteries', state: 'cost-sb' }, { label: 'Solar + batteries + wind', state: 'cost-wind' }] },
    // §1, the cost-of-capital lens (T091): each region's own cost of capital, and the cost with wind it gives (two scales)
    'map-wacc': { perPanelLegend: true, panels: [{ state: 'wacc-local' },   // its legend title names it
        { label: 'Solar + batteries + wind, with that cost of capital', state: 'cost-local' }] },
    // §2: what wind saves; the north (dashed: 45°N)
    'map-saving': { legend: 'saving', parallels: [45], panels: [{ state: 'saving' }] },
    // §3: weeks of drought: solar, wind, both at once (one scale)
    'map-drought': { legend: 'drought-solar', panels: [{ label: 'Solar lull', state: 'drought-solar' }, { label: 'Wind lull', state: 'drought-wind' }, { label: 'Both at once', state: 'drought-both' }] },
    // §4: 99% with batteries, against a 90% build with gas backup for the rest
    'map-backup': { legend: 'cost99', panels: [{ label: '99% uptime with solar, wind and batteries', state: 'cost99' }, { label: 'Firm power: a 90% build with gas or diesel backup', state: 'cost100' }] },
    // §6: planned coal and gas by the cheapest alternative at 80% uptime (all tiers)
    'map-planned': { legend: 'planned-130', panels: [{ state: 'planned-130', planned: true }] },
    // §7: the wind each region could build
    'map-potential': { legend: 'potential-cons', panels: [{ state: 'potential-cons' }] },
    // §8: the saving from wind on power every hour of the year (the 90% build with backup), 2026 and 2050 (T100, the human:
    // "the 90% case"; the id stays for the checks)
    'map-saving99': { legend: 'saving100y', panels: [{ label: '2026', state: 'saving100y', year: 2026 }, { label: '2050', state: 'saving100y', year: 2050 }] }
};

function drawMaps(d, rows, world) {
    const w = (el('map-cost90')?.clientWidth || 780);
    const k = Math.min(1, w / 780);   // circle sizes follow the map's width
    for (const [id, m] of Object.entries(MAPS)) {
        const node = el(id);
        if (!node) continue;
        let spec;
        if (m.demandCircles) {
            // a circle per region, area = demand, coloured by the class of its cost of 90% uptime with wind (the cost scale)
            const S = d.story, paint = staticPaint('cost-wind', d), tip = storyLayer('cost-wind', d).tooltip;
            const max = Math.max(...rows.map(r => S.demand[r.i] || 0));
            const points = rows.filter(r => S.demand[r.i] > 0 && d.cells.mapCell[r.i]).map((r) => {
                const c = paint(r);
                return { lon: r.longitude, lat: r.latitude, r: 0.4 + 16 * k * Math.sqrt(S.demand[r.i] / max), colour: c.colour, key: c.key };
            });
            spec = { scale: 'cost', legendNote: 'Circle area: the region\'s electricity demand', panels: [{ state: null, points, tip }] };
        } else if (m.panels[0].planned) {
            spec = { legendHtml: storyLegend(m.legend), pointStroke: '--muted',
                panels: m.panels.map(p => ({ ...p, points: plannedPoints(p.state, d, rows).map(q => ({ ...q, r: q.r * 0.75 * k })) })) };
        } else {
            // the cost-of-capital lens panels have no story-layers state: their tooltips give the region's cost of capital and
            // its cost with wind at that rate and at the article's common rate
            const lens = (r) => {
                const name = d.cells.country[r.i];
                const usd = v => (Number.isFinite(v) ? `${format(v, 'usd')}/MWh` : 'target not met');
                return `<div class="tt-head">${name && name !== '(none)' ? name : `${r.latitude.toFixed(1)}°, ${r.longitude.toFixed(1)}°`}</div>`
                    + (Number.isFinite(d.local.waccLocal[r.i]) ? `<div>Cost of capital: ${format(d.local.waccLocal[r.i], 'pct1')}</div>` : '')
                    + `<div>With wind, at that rate: ${usd(d.local.c90[r.i])}</div><div>At ${format(d.local.wacc, 'pct')} everywhere: ${usd(d.story.c90[r.i])}</div>`;
            };
            const panels = m.panels.map(p => (p.state === 'cost-local' || p.state === 'wacc-local' ? { ...p, tip: lens } : p));
            spec = { scale: scaleOf(m.panels[0].state), parallels: m.parallels, perPanelLegend: m.perPanelLegend, panels };
        }
        state.maps[id] = staticMap(node, { ...spec, d, rows, world });
    }
    state.plannedTotals = plannedTotals(d, rows);
}

// Sections 5 and 6 (article-charts.js, shared with the scrolly)
const CTX = { el, tracked, token, state };
const drawPlannedHist = d => plannedHist(CTX, d);
const drawPeopleCharts = d => peopleCharts(CTX, d);

async function main() {
    try {
        const worldP = fetch(new URL('../../data/world.geojson', import.meta.url)).then(r => (r.ok ? r.json() : Promise.reject(new Error('world.geojson'))));
        const cellsP = fetch(new URL('../data/story-cells.json', import.meta.url)).then(r => (r.ok ? r.json() : Promise.reject(new Error('story-cells.json'))));
        // the cost-of-capital lens: each region's own cost of capital and the cost of 90% uptime with it (scripts/article/analysis/t091/)
        const localP = fetch(new URL('../data/story-localwacc.json', import.meta.url)).then(r => (r.ok ? r.json() : Promise.reject(new Error('story-localwacc.json'))));
        localP.catch(() => {});
        // planned coal and gas per region, apart (scripts/article/tools/planned-split.py): the section 6 histogram
        const plannedP = fetch(new URL('../data/story-planned.json', import.meta.url)).then(r => (r.ok ? r.json() : Promise.reject(new Error('story-planned.json'))));
        plannedP.catch(() => {});
        worldP.catch(() => {});
        cellsP.catch(() => {});
        const d = await loadSummary();
        state.data = d;
        state.v = d.values;
        bindNumbers(true);
        draw();
        // The maps: the story's own per-region columns and the land, as the scrolly map
        const sc = await cellsP;
        d.story = {};
        for (const [k, v] of Object.entries(sc)) if (Array.isArray(v)) d.story[k] = Float64Array.from(v, x => (x == null ? NaN : x));
        state.rows = Array.from(d.cells.ids, (id, i) => ({ location_id: id, latitude: d.cells.lat[i], longitude: d.cells.lon[i], i }));
        fillDroughtGaps(d);
        const lw = await localP;
        const f64 = a => Float64Array.from(a, x => (x == null ? NaN : x));
        d.local = { wacc: lw.wacc, c90: f64(lw.c90), waccLocal: f64(lw.waccLocal) };
        state.world = rewound(await worldP);
        drawMaps(d, state.rows, state.world);
        drawPeopleCharts(d);
        d.planned = await plannedP;
        drawPlannedHist(d);
    } catch (e) {
        reportError(e);
    }
    let resizeTimer = null;
    let lastW = window.innerWidth;
    window.addEventListener('resize', () => {
        if (window.innerWidth === lastW) return;   // phones fire resize on scroll (the URL bar): redraw on width only
        lastW = window.innerWidth;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { try { draw(); if (state.world) { drawMaps(state.data, state.rows, state.world); drawPeopleCharts(state.data); } if (state.data?.planned) drawPlannedHist(state.data); } catch (e) { reportError(e); } }, 150);
    });
    state.chartKeyList = () => Object.fromEntries(Object.entries(state.chartKeys).map(([k, s]) => [k, [...s]]));
    state.ready = true;
}

main();
