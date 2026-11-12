// story-charts.js – story.html's charts (T087): index.html's six (the same charts, colours and data as
// article.js renderCharts(), copied so index.html is untouched) and the four new ones of the article v2 (shift,
// droughts, backup, planned coal and gas), drawn with groupedBars() below. Each chart's motion is chosen in the
// HTML (data-motion, see chartMotion). Every value comes from the summary; a chart missing from the page is skipped.
import { smallMultiples, barChart, dumbbell, animatedCurves, chartKey, setCssScope } from './charts.js';
import { format, nf } from './format.js';

// Chart colours are the page's tokens (css/article.css), so the light scheme redraws in its own.
let SCOPE = null;
const token = (name) => getComputedStyle(SCOPE || document.documentElement).getPropertyValue(name).trim();
/** Draw the next charts with the tokens of el's chart panel (the dark map stage) or, for null, the page's. */
function scope(el) {
    SCOPE = el?.closest('.seg__chart') || null;
    setCssScope(SCOPE);
    readColors();
}
const COLORS = {};
function readColors() {
    Object.assign(COLORS, {
        sb: token('--c-sb'), solar: token('--c-solar'), wind: token('--c-wind'), demand: token('--c-context'),
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

// ---------------------------------------------------------------------------
// Grouped bars (Ember chart style: horizontal gridlines only, no axis box, direct value labels where they fit,
// a key above). spec: { panels: [{ title, groups: [{ label, values: [..] }] }], series: [{ label, color }],
//   max, ticks, format, labelFormat, horizontal, height }. Horizontal: one row per group, bars stacked within it.
// Groups carry class gb-row (motion "rows").
// ---------------------------------------------------------------------------
function ui2() {
    return { text: token('--text'), muted: token('--muted'), grid: token('--grid'), axis: token('--axis') };
}
export function groupedBars(el, spec) {
    if (!el) return;
    el.innerHTML = '';
    chartKey(el, spec.series.map(s => ({ color: s.color, label: s.label })));
    const c = ui2();
    const width = Math.max(280, Math.round(el.clientWidth || 320));
    const narrow = width < 520;
    const svg = d3.select(el).append('svg').attr('role', 'img')
        .attr('aria-label', el.closest('figure')?.querySelector('.chart-title')?.textContent.trim() || 'Chart')
        .style('font-family', 'var(--font-sans)');
    const fmt = spec.labelFormat || spec.format;
    // horizontalNarrow (charts.html, T091): on a narrow screen, rows instead of columns, so category labels never collide
    if (spec.horizontal || (narrow && spec.horizontalNarrow)) {
        const groups = spec.panels[0].groups;
        const labelW = narrow ? 92 : 130, barH = spec.barH || (narrow ? 7 : 9), gap = 2, rowH = spec.series.length * (barH + gap) + (narrow ? 12 : 14);
        const m = { top: 6, right: 44, bottom: 22, left: labelW };
        const h = m.top + m.bottom + rowH * groups.length;
        svg.attr('viewBox', `0 0 ${width} ${h}`).attr('width', width).attr('height', h);
        const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
        const iw = width - m.left - m.right;
        const x = d3.scaleLinear().domain([0, spec.max]).range([0, iw]);
        spec.ticks.forEach((t) => {
            g.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', 0).attr('y2', rowH * groups.length).attr('stroke', t === 0 ? c.axis : c.grid);
            g.append('text').attr('x', x(t)).attr('y', rowH * groups.length + 15).attr('text-anchor', 'middle').attr('fill', c.muted).attr('font-size', 10.5).text(spec.format(t));
        });
        groups.forEach((gr, k) => {
            const row = g.append('g').attr('class', 'gb-row').attr('transform', `translate(0,${k * rowH})`);
            row.append('text').attr('x', -8).attr('y', (spec.series.length * (barH + gap)) / 2 + 4).attr('text-anchor', 'end').attr('fill', c.text).attr('font-size', narrow ? 11 : 12).text(String(gr.label).replace(/\n/g, ' '));
            gr.values.forEach((val, j) => {
                const y = j * (barH + gap);
                row.append('rect').attr('x', 0).attr('y', y).attr('width', Math.max(1, x(val))).attr('height', barH).attr('fill', spec.series[j].color);
                if (!spec.noLabels) row.append('text').attr('x', x(val) + 4).attr('y', y + barH - 1).attr('fill', c.muted).attr('font-size', 10).text(fmt(val));
            });
        });
        return;
    }
    const P = spec.panels.length, cols = narrow ? 1 : P, rows = Math.ceil(P / cols);
    const m = { top: 22, right: 6, bottom: 34, left: 40 }, gapX = 26, gapY = 18;
    const ph = spec.height || (narrow ? 170 : 210);
    const pw = (width - m.left - m.right - gapX * (cols - 1)) / cols;
    const h = rows * (m.top + ph + m.bottom) + (rows - 1) * gapY;
    svg.attr('viewBox', `0 0 ${width} ${h}`).attr('width', width).attr('height', h);
    const y = d3.scaleLinear().domain([0, spec.max]).range([ph, 0]);
    spec.panels.forEach((p, k) => {
        const ox = m.left + (k % cols) * (pw + gapX), oy = Math.floor(k / cols) * (m.top + ph + m.bottom + gapY) + m.top;
        const g = svg.append('g').attr('transform', `translate(${ox},${oy})`);
        if (p.title) g.append('text').attr('x', 0).attr('y', -9).attr('fill', c.text).attr('font-size', 12).attr('font-weight', 600).text(p.title);
        spec.ticks.forEach((t) => {
            g.append('line').attr('x1', 0).attr('x2', pw).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', t === 0 ? c.axis : c.grid);
            if (k % cols === 0) g.append('text').attr('x', -6).attr('y', y(t) + 4).attr('text-anchor', 'end').attr('fill', c.muted).attr('font-size', 10.5).text(spec.format(t));
        });
        const x0 = d3.scaleBand().domain(p.groups.map(gr => gr.label)).range([0, pw]).paddingInner(0.28).paddingOuter(0.1);
        const x1 = d3.scaleBand().domain(d3.range(spec.series.length)).range([0, x0.bandwidth()]).padding(0.08);
        const labels = x1.bandwidth() >= (spec.labelMin || 22) && !spec.noLabels, lf = x1.bandwidth() < 22 ? 8.5 : 10;   // labelMin: T100 (bandsave on phones)
        p.groups.forEach((gr, gi) => {
            const row = g.append('g').attr('class', `gb-row gb-g${gi}`).attr('transform', `translate(${x0(gr.label)},0)`);
            gr.values.forEach((val, j) => {
                row.append('rect').attr('class', `gb-s${j}`).attr('x', x1(j)).attr('y', y(Math.min(val, spec.max))).attr('width', x1.bandwidth()).attr('height', ph - y(Math.min(val, spec.max))).attr('fill', spec.series[j].color);
                if (labels) row.append('text').attr('class', `gb-s${j}`).attr('x', x1(j) + x1.bandwidth() / 2).attr('y', y(Math.min(val, spec.max)) - 4).attr('text-anchor', 'middle').attr('fill', c.muted).attr('font-size', lf).text(fmt(val));
            });
            const words = String(gr.label).split('\n');
            words.forEach((w, q) => row.append('text').attr('x', x0.bandwidth() / 2).attr('y', ph + 15 + q * 12).attr('text-anchor', 'middle').attr('fill', c.text).attr('font-size', narrow ? 10.5 : 11.5).text(w));
        });
    });
}

// The ten countries with the most planned coal and gas (team/reports/T089-tables/s6_countries.csv order; keys s6c.<row>)
const PLANNED_COUNTRIES = ['China', 'United States', 'India', 'Brazil', 'Saudi Arabia', 'Bangladesh', 'Nigeria', 'Viet Nam', 'Russia', 'Mexico'];
const DROUGHT_GROUPS = [['world', 'World'], ['eu', 'Europe'], ['na', 'North\nAmerica'], ['ca', 'Canada'], ['usn', 'Northern\nUS'], ['de', 'Germany']];

function newCharts(v, opts = {}) {
    const el = (id) => document.querySelector(`[data-chart="${id}"]`);
    const pct = x => `${Math.round(x * 100)}%`;
    const usd = x => `$${nf.format(Math.round(x))}`;
    const both = [{ label: 'Solar + batteries', color: COLORS.sb }, { label: 'Solar + batteries + wind', color: COLORS.wind }];
    // (a) the shift at 90% uptime
    groupedBars(el('shift'), {
        series: both, max: 0.8, ticks: [0, 0.2, 0.4, 0.6, 0.8], format: pct,
        panels: [['demand', 'Share of electricity demand'], ['people', 'Share of people']].map(([w, title]) => ({
            title, groups: [60, 80, 100].map(t => ({ label: `Under $${t}`, values: ['sb', 'sbw'].map(b => v[`s1.under${t}.${b}.${w}.90`]) }))
        }))
    });
    // (b) week-long droughts
    scope(el('drought'));
    groupedBars(el('drought'), {
        // the equal mix dropped (the human, 6 Nov 2026: "just solar drought, wind drought, both at once")
        series: [{ label: 'Solar lull', color: COLORS.solar }, { label: 'Wind lull', color: COLORS.wind },
            { label: 'Both at once', color: COLORS.bands[0] }],
        max: 0.25, ticks: [0, 0.05, 0.1, 0.15, 0.2, 0.25], format: pct, noLabels: true, horizontalNarrow: !!opts.static,
        panels: [{ groups: DROUGHT_GROUPS.map(([id, label]) => ({ label, values: ['solarWeeks', 'windWeeks', 'bothWeeks'].map(k => v[`dunkel.${id}.${k}`]) })) }]
    });
    // (c) from 90% to 99% and to 100% with backup, every bar per MWh of the full load (T095, the human, 6 Nov 2026):
    // the 90/95/99 bars s4.curveLoad (annual cost / the full load; the hours a build misses go unserved), the backup
    // bar s4.curve.*.100 (per MWh of the full load already)
    scope(el('backup'));
    groupedBars(el('backup'), {
        series: both, max: 200, ticks: [0, 50, 100, 150, 200], format: usd,
        panels: [{ groups: [['90', '90% uptime'], ['95', '95% uptime'], ['99', '99% uptime'], ['100', '90% + gas\nbackup']].map(([t, label]) => ({ label,
            values: ['sb', 'sbw'].map(b => v[t === '100' ? `s4.curve.${b}.demand.100` : `s4.curveLoad.${b}.demand.${t}`]) })) }]
    });
    // (e) where people live: the median cost of 90% uptime weighted by land, people and demand
    scope(el('weights'));
    groupedBars(el('weights'), {
        series: both, max: 125, ticks: [0, 25, 50, 75, 100, 125], format: usd,
        panels: [{ groups: [['area', 'Land'], ['people', 'People'], ['demand', 'Electricity\ndemand']].map(([w, label]) => ({ label, values: ['sb', 'sbw'].map(b => v[`s5.med.${b}.${w}.90`]) })) }]
    });
    // (d) planned coal and gas, ten countries
    scope(null);
    groupedBars(el('planned'), {
        horizontal: true,
        series: [{ label: 'Planned coal and gas', color: token('--n2') }, { label: 'Solar + batteries under $100/MWh', color: COLORS.sb }, { label: 'With wind under $100/MWh', color: COLORS.wind }],
        max: 400, ticks: [0, 100, 200, 300, 400], format: x => `${nf.format(Math.round(x))} GW`, labelFormat: x => nf.format(Math.round(x)),
        panels: [{ groups: PLANNED_COUNTRIES.map((name, k) => ({ label: name, values: ['planned_gw', 'sb_under100_90', 'sbw_under100_90'].map(c => v[`s6c.${k}.${c}`]) })) }]
    });
}

// ---------------------------------------------------------------------------
// Chart steps in a map segment (story.js scene): a panel's chart is revealed as its cards pass. The figure's
// data-reveal says how: "series" (bars appear series by series), "groups" (group by group) or "frames"
// (an animated chart's frames, e.g. the years of t5anim). Steps are continuous: 1.5 = halfway into the second.
// ---------------------------------------------------------------------------
const lastStep = {};
export function stepChart(id, cs) {
    lastStep[id] = cs;
    const el = document.querySelector(`[data-chart="${id}"]`);
    const mode = el?.closest('figure')?.dataset.reveal;
    if (!el || !mode) return;
    if (mode === 'frames') {
        const a = el.__anim;
        if (a?.draw && !a.playing) { const k = Math.max(0, Math.min(a.frames - 1, Math.round(cs))); if (k !== a.k) a.draw(k, true); }
        return;
    }
    const sel = mode === 'series' ? 'gb-s' : 'gb-g';
    for (let j = 0; j < 12; j++) {
        const o = Math.max(0, Math.min(1, cs - j));
        el.querySelectorAll(`.${sel}${j}`).forEach((n) => { n.style.opacity = String(o); });
    }
}

/** The five charts of the article v2 (shift, drought, backup, weights, planned) on the page's own tokens, for
 * charts.html (T091), which draws them without the map stage or motion. */
export function drawV2Charts(v) {
    scope(null);
    readColors();
    newCharts(v, { static: true });
    scope(null);
}

export function renderCharts(v) {
    renderAll(v);
    for (const [id, cs] of Object.entries(lastStep)) stepChart(id, cs);
}

function renderAll(v) {
    readColors();
    newCharts(v);
    const usd = x => `$${nf.format(x)}`;
    const el = (id) => document.querySelector(`[data-chart="${id}"]`);
    const narrow = ((el('t1') || el('t3'))?.clientWidth || 600) < 480;
    const pctTick = t => `${t}%`;
    const uptimeX = { domain: [50, 99], ticks: [50, 60, 70, 80, 90, 99], format: pctTick };
    const curve = (metric, id, Y) => CURVE_TARGETS.map(t => [t, v[`lb.${metric}.${id}.${t}.${Y}`]]);

    // Take 1: the saving from adding wind as uptime rises, one panel per band (high to low
    // latitude, reading order) and the world, on shared axes.
    const saveMax = Math.max(...[...BANDS.map(b => b[0]), 'world'].flatMap(id => CURVE_TARGETS.map(t => v[`lb.saving.${id}.${t}.2026`])).filter(Number.isFinite));
    const saveTop = Math.ceil(saveMax / 100) * 100;
    if (el('t1')) smallMultiples(el('t1'), {
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
    if (el('t2')) barChart(el('t2'), {
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
    if (el('t3')) chartKey(el('t3'), [{ color: COLORS.solar, label: 'Solar' }, { color: COLORS.wind, label: 'Wind' }]);
    if (el('t3')) smallMultiples(el('t3'), {
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
    if (el('t4')) dumbbell(el('t4'), {
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
    // (T091 round 8 dropped it from the scrolly; kept for a quick return)
    const animEl = el('t5anim');
    if (animEl) {
        const fig = animEl.closest('figure');
        scope(animEl);
        bandKey(animEl, v);
        animatedCurves(animEl, {
            height: narrow ? 250 : 280,
            x: uptimeX, xTitle: 'Uptime: share of the load served',
            y: { domain: [0, 225], ticks: [0, 50, 100, 150, 200], format: usd },
            firstLabel: 'Dashed: 2026',
            frames: ANIM_YEARS.map(Y => ({ year: Y, series: BANDS.map(([id, label], k) => ({ id, label, color: COLORS.bands[k], points: curve('best', id, Y) })) }))
        }, { button: fig.querySelector('[data-play]'), loop: true });
        scope(null);
    }

    // Take 5b: per band, 90% uptime, solar + batteries alone against with wind, 2026-2050.
    if (el('t5b')) chartKey(el('t5b'), [{ color: COLORS.sb, label: 'Solar + batteries' }, { color: COLORS.wind, label: 'Solar + batteries + wind' }]);
    if (el('t5b')) smallMultiples(el('t5b'), {
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

// ---------------------------------------------------------------------------
// Chart motion (T087 phase F): a component per motion type, chosen in the HTML with data-motion on the
// figure, so a chart can sit in any section and sections can be reordered.
//   data-motion="draw-in"      lines draw in, areas and end labels fade in, once, on entry (any line chart)
//   data-motion="stepped"      the figure is pinned while the bars build up in steps; data-steps lists the
//                              bar rows revealed at each step, e.g. "0|1,2" (rows without a low case stay)
//   data-motion="rows"         rows (.db-row or .bar-row) appear one by one, once, on entry
//   data-motion="scrub-years"  the figure is pinned and its frame (year) follows the scroll; Play kept
//   data-motion="hover"        the panel under the pointer stands out (css/story.css; small multiples)
//   data-motion="grow"         once, on entry: histogram bars rise from the axis, horizontal bars (.grow-x) grow from
//                              the left, lines draw in, then the labels fade in (the round-8 charts, article-charts.js;
//                              they draw after the per-region data loads, so the figure waits hidden until it enters)
//   (none)                     static
// With reduced motion every chart shows its final state and nothing is pinned. Pinned length: data-pin
// (% of the viewport, default 150).
// ---------------------------------------------------------------------------
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const figs = () => [...document.querySelectorAll('figure[data-motion]')];
const svgOf = (fig) => fig.querySelector('.chart-svg svg');
const motion = new WeakMap();     // figure -> { entered, p }

const LINE_BITS = '.sm-panel circle, .sm-panel g > text[font-weight="600"]';
function prepDrawIn(fig) {
    const svg = svgOf(fig);
    if (!svg) return;
    svg.querySelectorAll('path').forEach((p) => {
        if (p.getAttribute('fill') === 'none') {
            const L = p.getTotalLength();
            p.style.strokeDasharray = `${L} ${L}`;
            p.style.strokeDashoffset = String(L);
        } else p.style.opacity = '0';
    });
    svg.querySelectorAll(LINE_BITS).forEach(n => { n.style.opacity = '0'; });
}
function drawIn(fig) {
    const svg = svgOf(fig);
    if (!svg) return;
    const paths = [...svg.querySelectorAll('path')];
    gsap.to(paths.filter(p => p.getAttribute('fill') === 'none'), { strokeDashoffset: 0, duration: 1.4, ease: 'power2.out', stagger: 0.08 });
    gsap.to(paths.filter(p => p.getAttribute('fill') !== 'none'), { opacity: 1, duration: 0.9, delay: 0.5, stagger: 0.08 });
    gsap.to(svg.querySelectorAll(LINE_BITS), { opacity: 1, duration: 0.5, delay: 1.2, stagger: 0.08 });
}
/** The round-8 charts' entrance: bars rise, lines draw, labels follow. */
function growIn(fig) {
    fig.classList.remove('motion-wait');
    const svg = svgOf(fig);
    if (!svg) return;
    const ease = 'power2.out';
    const up = svg.querySelectorAll('rect.hist-bar'), across = svg.querySelectorAll('rect.grow-x');
    if (up.length) gsap.from(up, { scaleY: 0, transformOrigin: '50% 100%', duration: 0.8, ease, stagger: { amount: 0.5 } });
    if (across.length) gsap.from(across, { scaleX: 0, transformOrigin: '0% 50%', duration: 0.8, ease, stagger: { amount: 0.45, from: 'end' } });
    const lines = [...svg.querySelectorAll('path')].filter(p => p.getAttribute('fill') === 'none' && Number(p.getAttribute('stroke-width')) >= 2);
    lines.forEach((p) => { const L = p.getTotalLength(); gsap.fromTo(p, { strokeDasharray: `${L} ${L}`, strokeDashoffset: L }, { strokeDashoffset: 0, duration: 1.3, delay: 0.25, ease }); });
    const labels = svg.querySelectorAll('text[font-weight="600"], circle');
    if (labels.length) gsap.from(labels, { opacity: 0, duration: 0.5, delay: 0.7, stagger: 0.04 });
}
const rowsOf = (fig) => fig.querySelectorAll('.db-row, .bar-row, .gb-row');

/** Stepped bars at p in [0, 1]: step k of n reveals its rows' default bars over its share of the scroll. */
function steppedAt(fig, p) {
    const steps = (fig.dataset.steps || '').split('|').map(x => x.split(',').map(Number));
    const n = steps.length;
    fig.querySelectorAll('.bar-row').forEach((row) => {
        const k = Number(row.dataset.row);
        const s = steps.findIndex(list => list.includes(k));
        const g = s < 0 || !row.querySelector('.bar-low') ? 1 : smoothstep((s + 0.15) / n, (s + 0.85) / n, p);
        row.querySelectorAll('rect.bar-value').forEach((r) => {
            if (!r.dataset.w) r.dataset.w = r.getAttribute('width');
            r.setAttribute('width', String(Math.max(0, Number(r.dataset.w) * g)));
        });
        row.querySelectorAll('text.bar-value').forEach((t) => { t.style.opacity = String(g); });
        row.style.opacity = String(s > 0 ? 0.35 + 0.65 * smoothstep((s - 0.1) / n, (s + 0.1) / n, p) : 1);
    });
}
function yearsAt(fig, p, animate = true) {
    const a = fig.querySelector('.chart-svg')?.__anim;
    if (!a?.draw) return;
    const k = Math.round(p * (a.frames - 1));
    if (k !== a.k && !a.playing) a.draw(k, animate);
}

/** Re-apply each chart's motion state after a redraw (resize). */
export function reapplyMotion(reduced) {
    if (reduced) return;
    for (const fig of figs()) {
        const m = motion.get(fig);
        if (!m) continue;
        const type = fig.dataset.motion;
        if (type === 'draw-in' && !m.entered) prepDrawIn(fig);
        if (type === 'rows' && !m.entered) rowsOf(fig).forEach(r => { r.style.opacity = '0'; });
        if (type === 'stepped') steppedAt(fig, m.p);
        if (type === 'scrub-years') yearsAt(fig, m.p, false);
        if (type === 'grow' && !m.entered) fig.classList.add('motion-wait');
    }
}

export function chartMotion(reduced) {
    if (reduced) return;
    for (const fig of figs()) {
        const m = { entered: false, p: 0 };
        motion.set(fig, m);
        const type = fig.dataset.motion;
        const once = (fn) => ScrollTrigger.create({ trigger: fig, start: 'top 72%', once: true, onEnter: () => { m.entered = true; fn(); } });
        const pin = (fn) => ScrollTrigger.create({
            trigger: fig, start: () => (fig.offsetHeight > window.innerHeight * 0.9 ? 'top top' : 'center center'),
            end: `+=${Number(fig.dataset.pin) || 150}%`, pin: true, scrub: 0.4, onUpdate: s => { m.p = s.progress; fn(s.progress); }
        });
        if (type === 'draw-in') once(() => drawIn(fig));
        else if (type === 'rows') once(() => gsap.to(rowsOf(fig), { opacity: 1, duration: 0.45, stagger: 0.16, ease: 'power1.out' }));
        else if (type === 'stepped') pin(p => steppedAt(fig, p));
        else if (type === 'scrub-years') pin(p => yearsAt(fig, p));
        else if (type === 'grow') once(() => growIn(fig));
    }
    reapplyMotion(false);
}
