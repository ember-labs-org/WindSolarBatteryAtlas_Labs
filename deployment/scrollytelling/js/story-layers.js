// story-layers.js – the story map's colours (story.html, T087): one gradient per map state, from the
// colour registry (constants.js STORY_RAMPS: Ember families, lightness rising with the measure).
//
// Each state classifies a region exactly as layers.js does (the same values, thresholds and categories,
// and layers.js's own tooltips); only the colour of the measure differs. index.html and the app keep
// layers.js's colours. Ramps are linear in sRGB between evenly spaced stops (in log space for windcost),
// which is what a CSS linear-gradient draws, so the legend bar shows exactly the drawn colours.
import { STORY_RAMPS, LCOE_NO_DATA_COLOR, STATIC_MAP_SCALES, STATIC_MAP_NEUTRALS } from '../../js/constants.js';
import { MAP_STATES, RECEDE_GREY, PENDING_COLOR, POTENTIAL_BUCKETS, WINTER_EVEN, windLcoeAt, bucketOf } from './layers.js';
import { format } from './format.js';

/** The ramp of a state as a function of its measure: colours linear in sRGB between evenly spaced stops. */
export function ramp(name) {
    const R = STORY_RAMPS[name];
    const [lo, hi] = R.domain;
    const t = R.log ? (v) => Math.log(v) : (v) => v;
    const n = R.stops.length - 1;
    const dom = R.stops.map((_, k) => t(lo) + (t(hi) - t(lo)) * k / n);
    const s = d3.scaleLinear().domain(dom).range(R.stops).interpolate(d3.interpolateRgb).clamp(true);
    const f = (v) => d3.color(s(t(v))).formatHex();
    f.at = (frac) => d3.color(s(t(lo) + (t(hi) - t(lo)) * frac)).formatHex();   // the colour at a fraction of the bar
    f.valueAt = (frac) => (R.log ? Math.exp(t(lo) + (t(hi) - t(lo)) * frac) : lo + (hi - lo) * frac);
    return f;
}

const POT = STORY_RAMPS.potential.stops;             // one per bucket above 1×
const potColour = (b) => (b.max === 1 ? RECEDE_GREY : POT[POTENTIAL_BUCKETS.indexOf(b) - 1]);

// T101 (audit B): the charts article's classes (constants.js STATIC_MAP_SCALES) for the saving and drought maps
const SCALE_OF = { saving: 'saving90', 'saving-europe': 'saving90', saving100y: 'saving99', 'drought-solar': 'drought', 'drought-wind': 'drought', 'drought-both': 'drought' };
function classColour(scaleName, v) {
    const sc = STATIC_MAP_SCALES[scaleName];
    let k = 0;
    while (k < sc.breaks.length && v >= sc.breaks[k]) k++;
    return sc.colours[k];
}
/** The class labels of a stepped scale, as static-map.js classLabel ("No saving", "$1–10", "Over $100"; "2–5%"). */
function classLabels(scaleName) {
    const sc = STATIC_MAP_SCALES[scaleName], b = sc.breaks, u = sc.fmt === 'int' ? sc.unit : '';
    const num = v => (sc.fmt === 'usd' ? `$${v}` : sc.fmt === 'pct' ? `${Math.round(v * 100)}%` : sc.fmt === 'x' ? `${v}×` : `${v}`);
    const range = (lo, hi) => (sc.fmt === 'usd' ? `$${lo}–${hi}` : sc.fmt === 'pct' ? `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`
        : sc.fmt === 'x' ? `${lo}–${hi}×` : `${lo}–${hi}${sc.unit}`);
    return sc.colours.map((_, k) => (k === 0 ? (sc.nil || `Under ${num(b[0])}${u}`) : k === b.length ? `Over ${num(b[b.length - 1])}${u}` : range(b[k - 1], b[k])));
}
const NOT_MET = STATIC_MAP_NEUTRALS.notMet;

function fills(name, d, year) {
    const c = d.cells;
    switch (name) {
    case 'windcf': {
        const s = ramp('windcf');
        return r => (c.onViable[r.i] && Number.isFinite(c.onCf[r.i]) ? s(c.onCf[r.i]) : RECEDE_GREY);
    }
    case 'saving':
    case 'saving-europe': {
        const res = d.results.t90;   // T101: the charts article's classes (saving90)
        return (r) => {
            if (!res.priced[r.i] || !res.meets[r.i]) return LCOE_NO_DATA_COLOR;
            return Number.isFinite(res.saving[r.i]) ? classColour('saving90', Math.max(0, res.saving[r.i])) : PENDING_COLOR;
        };
    }
    case 'cost-sb':
    case 'cost-wind': {
        // The cost of 90% uptime: the cheapest build without wind (cost-sb) or overall (cost-wind), as the
        // saving map's tooltip gives them (layers.js savingLayer)
        const s = ramp('cost90'), res = d.results.t90, col = name === 'cost-sb' ? res.nwLcoe : res.lcoe;
        return (r) => {
            if (!res.priced[r.i] || !res.meets[r.i] || !Number.isFinite(col[r.i])) return LCOE_NO_DATA_COLOR;
            return s(col[r.i]);
        };
    }
    case 'planned-all':
    case 'planned-sb':
    case 'planned-wind':
    case 'planned-130':
        return () => null;          // the land alone; the plants are dots (plannedPoints)
    case 'cost99':
    case 'cost100':
    case 'cost99y': {
        // story-cells.json (T087): the cheapest build at 99%, a 90% build with backup for the rest, and 99% by cost year
        const s = ramp('cost90'), S = d.story;
        const val = name === 'cost99' ? (i => S.c99[i]) : name === 'cost100' ? (i => S.c100[i]) : (i => costAtYear(S, i, year));
        return (r) => { const v = val(r.i); return Number.isFinite(v) ? s(v) : LCOE_NO_DATA_COLOR; };
    }
    case 'drought-solar':
    case 'drought-wind':
    case 'drought-both': {
        // T101: the charts article's classes; regions with no usable wind site (T088 left them out) its notMet neutral
        const col = d.story[{ 'drought-solar': 'droughtSolar', 'drought-wind': 'droughtWind', 'drought-both': 'droughtBoth' }[name]];
        return r => (Number.isFinite(col[r.i]) ? classColour('drought', col[r.i]) : (d.cells.mapCell[r.i] ? NOT_MET : null));
    }
    case 'potential-cons': {
        // T101: the charts article's classes (STATIC_MAP_SCALES.multiple: under 1x light green … over 100x deep green; no
        // recorded demand, the neutral no-data grey), so the two versions draw the same map
        const sc = STATIC_MAP_SCALES.multiple;
        return (r) => {
            if (!c.mapCell[r.i]) return null;
            const v = d.story.multCons[r.i];
            if (!(v < 1e8)) return STATIC_MAP_NEUTRALS.noData;
            let k = 0;
            while (k < sc.breaks.length && v >= sc.breaks[k]) k++;
            return sc.colours[k];
        };
    }
    case 'potential-gw': {
        // T090: buildable wind of the region's own, GW, conservative case (story-cells potGw); grey under 1 GW
        const s = ramp('potentialGw'), g = d.story.potGw;
        return r => (c.mapCell[r.i] ? (g[r.i] >= GW_MIN ? s(g[r.i]) : RECEDE_GREY) : null);
    }
    case 'saving99y': {
        // T090: what adding wind saves at 99% uptime in `year` (cheapest without wind minus cheapest overall, both
        // reaching 99%; linear between the cost years run, as cost99y)
        const s = ramp('saving99'), S = d.story;
        return (r) => { const v = savingAtYear(S, r.i, year); return Number.isFinite(v) ? s(Math.max(0, v)) : LCOE_NO_DATA_COLOR; };
    }
    case 'saving100y': {
        // T100 (the human, 9 Nov 2026: section 8 on the 90% case): what adding wind saves on power every hour of the year
        // in `year`: the 90% build with diesel or gas backup for the rest, without wind minus with (story-cells c100y<Y>,
        // c100sbY<Y>; linear between the cost years run)
        const S = d.story;   // T101: the charts article's classes (saving99: $1-25 … over $200)
        return (r) => { const v = savingAtYear(S, r.i, year, BK_COLS); return Number.isFinite(v) ? classColour('saving99', Math.max(0, v)) : LCOE_NO_DATA_COLOR; };
    }
    case 'potential':
        return r => (c.mapCell[r.i] ? potColour(bucketOf(d.pot.multiple[r.i])) : null);
    case 'winter': {
        const s = ramp('winter');
        return (r) => {
            const x = c.windNF[r.i];
            if (!c.onViable[r.i] || !Number.isFinite(x)) return LCOE_NO_DATA_COLOR;
            return x < WINTER_EVEN ? RECEDE_GREY : s(x);
        };
    }
    case 'windcost': {
        const s = ramp('windcost');
        return (r) => {
            if (!c.onViable[r.i] || !Number.isFinite(c.windLcoe[2026][r.i])) return LCOE_NO_DATA_COLOR;
            return s(windLcoeAt(c, r.i, year));
        };
    }
    default: throw new Error(`no story colours for ${name}`);
    }
}

// Planned coal and gas (GEM, announced coal and oil and gas, by region: data/voronoi_gem_capacity.csv, as T089):
// a dot per region with planned capacity, sized by GW; coloured by the cheapest tier at which the region's solar, wind and
// battery build reaches 80% uptime on local costs (Harnessing the Sun's test; T089's s6.local.*.under100.80; T090's $130 tier).
export const TIER_USD = 100;
export const TIER2_USD = 130;       // the human's choice (D-161)
/** The 99% cost of region i in `year`: linear between the cost years run (story-cells c99y<year>). */
export const COST_YEARS = [2026, 2030, 2035, 2040, 2045, 2050];
export function costAtYear(S, i, year, col = 'c99y') {
    const y = Math.max(2026, Math.min(2050, year));
    const k = Math.max(0, COST_YEARS.findIndex((Y, j) => y <= COST_YEARS[j + 1] || j === COST_YEARS.length - 2));
    const Y0 = COST_YEARS[k], Y1 = COST_YEARS[k + 1];
    const a = S[`${col}${Y0}`][i], b = S[`${col}${Y1}`][i];
    return a + (b - a) * (y - Y0) / (Y1 - Y0);
}
/** T090: the saving from wind at 99% uptime in `year` (NaN where either build misses 99%); T100: cols = BK_COLS gives
 *  the saving on power every hour of the year (the 90% build with backup). */
export const BK_COLS = ['c100sbY', 'c100y'];
export function savingAtYear(S, i, year, [sbCol, col] = ['c99sbY', 'c99y']) {
    return costAtYear(S, i, year, sbCol) - costAtYear(S, i, year, col);
}
/** T090: buildable wind below this many GW reads as "under 1 GW" (grey), the threshold of section 7. */
export const GW_MIN = 1;
const [PL_ALL, PL_SB, PL_WIND, PL_130] = STORY_RAMPS.planned.categories;
export const STORY_PLANNED_COLOURS = [PL_ALL, PL_SB, PL_WIND, PL_130];
/** The tier of region i: 1 solar and batteries under $100/MWh, 2 with wind under $100, 3 with wind under $130, 0 the
 *  rest; each at 80% uptime (the Harnessing the Sun test), local costs. */
export function plannedClass(d, i) {
    const S = d.story;
    if (S.c80sb[i] <= TIER_USD) return 1;
    if (S.c80[i] <= TIER_USD) return 2;
    return S.c80[i] <= TIER2_USD ? 3 : 0;
}
// the tiers each map state shows (the rest grey)
const SHOWN = { 'planned-all': 0, 'planned-sb': 1, 'planned-wind': 2, 'planned-130': 3 };
export function plannedPoints(name, d, rows) {
    const out = [];
    for (const r of rows) {
        const gw = d.story.planned[r.i] || 0;
        if (!(gw > 0)) continue;
        const c = plannedClass(d, r.i);
        const colour = c >= 1 && c <= SHOWN[name] ? STORY_PLANNED_COLOURS[c] : PL_ALL;
        out.push({ lon: r.longitude, lat: r.latitude, r: 1.2 + 2.2 * Math.sqrt(gw), colour, i: r.i, gw });
    }
    return out;
}
/** GW of planned coal and gas, all and by tier (the check compares them with T089 and T090). */
export function plannedTotals(d, rows) {
    const t = { all: 0, sb: 0, sbw: 0, sbw130: 0 };
    for (const r of rows) {
        const gw = d.story.planned[r.i] || 0;
        const c = plannedClass(d, r.i);
        t.all += gw; if (c === 1) t.sb += gw; if (c === 1 || c === 2) t.sbw += gw; if (c >= 1) t.sbw130 += gw;
    }
    return t;
}

// States the story map adds to layers.js's (their caption; their tooltip is the saving map's, which gives both costs).
// Captions (the human, T091 round 9: least text): the title says what the map shows, the subtitle its unit; the basis
// (2026 costs, one 7% cost of capital) is stated once in the text and in every source line.
export const STORY_STATES = {
    'cost-sb': { title: 'Cost of 90% uptime: solar and batteries', sub: '$/MWh', tooltipOf: 'saving' },
    'cost-wind': { title: 'Cost of 90% uptime: solar, batteries and wind', sub: '$/MWh', tooltipOf: 'saving' },
    'saving': { title: 'Saving from adding wind, 90% uptime', sub: '$/MWh', tooltipOf: 'saving' },
    'saving-europe': { title: 'Saving from adding wind, 90% uptime', sub: '$/MWh', tooltipOf: 'saving-europe' },
    'planned-all': { title: 'Coal and gas plants in planning', sub: 'Dot size: capacity', tip: 'planned' },
    'planned-130': { title: 'Coal and gas plants in planning', sub: 'Dot size: capacity', tip: 'planned' },
    'planned-sb': { title: 'Coal and gas plants in planning', sub: 'Dot size: capacity', tip: 'planned' },
    'planned-wind': { title: 'Coal and gas plants in planning', sub: 'Dot size: capacity', tip: 'planned' },
    'cost99': { title: 'Cost of 99% uptime: solar, batteries and wind', sub: '$/MWh', tip: 'cost99' },
    'cost100': { title: 'Cost of firm power: 90% renewables, gas or diesel for the rest', sub: '$/MWh', tip: 'cost100' },
    'cost99y': { title: year => `Cost of 99% uptime, ${year}`, sub: '$/MWh', tip: 'cost99y' },
    'drought-solar': { title: 'How often solar runs low for a week', sub: 'Share of weeks in a lull', tip: 'droughtSolar' },
    'drought-wind': { title: 'How often wind runs low for a week', sub: 'Share of weeks in a lull', tip: 'droughtWind' },
    'drought-both': { title: 'How often both run low in the same week', sub: 'Share of weeks', tip: 'droughtBoth' },
    'potential-cons': { title: 'Wind potential, as a multiple of local demand', sub: 'Conservative case', tip: 'multCons' },
    'potential-gw': { title: 'Wind each region could build', sub: 'GW, conservative case', tip: 'potGw' },
    'saving99y': { title: year => `Saving from adding wind, 99% uptime, ${year}`, sub: '$/MWh', tip: 'saving99y' },
    'saving100y': { title: year => `Saving from adding wind, firm power, ${year}`, sub: '$/MWh', tip: 'saving100y' }
};
const tipHead = (d, r) => { const c = d.cells.country[r.i]; return `<div class="tt-head">${c && c !== '(none)' ? c : `${r.latitude.toFixed(1)}°, ${r.longitude.toFixed(1)}°`}</div>`; };
function storyTip(name, d, year) {
    const S = d.story, k = STORY_STATES[name].tip;
    const usd = v => (Number.isFinite(v) ? format(v, 'usd') + '/MWh' : 'target not met');
    return (r) => {
        const i = r.i;
        if (k === 'planned') return S.planned[i] > 0 ? `${tipHead(d, r)}<div>Planned coal and gas: ${format(S.planned[i], 'int')} GW</div><div>80% uptime: ${usd(S.c80sb[i])} without wind · ${usd(S.c80[i])} with</div>` : null;
        if (k === 'cost99') return `${tipHead(d, r)}<div>99% uptime: ${usd(S.c99[i])}</div>`;
        if (k === 'cost100') return `${tipHead(d, r)}<div>Firm power, with backup: ${usd(S.c100[i])}</div>`;
        if (k === 'cost99y') return `${tipHead(d, r)}<div>99% uptime, ${year}: ${usd(costAtYear(S, i, year))}</div>`;
        if (k === 'potGw') return d.cells.mapCell[i] ? `${tipHead(d, r)}<div>Buildable wind: ${format(S.potGw[i], S.potGw[i] < 10 ? 'd1' : 'int')} GW</div>` : null;
        if (k === 'saving99y') { const v = savingAtYear(S, i, year); return `${tipHead(d, r)}<div>99% uptime, ${year}: ${usd(costAtYear(S, i, year, 'c99sbY'))} without wind · ${usd(costAtYear(S, i, year))} with</div>${Number.isFinite(v) ? `<div>Saving: ${format(Math.max(0, v), 'usd')}/MWh</div>` : ''}`; }
        if (k === 'saving100y') { const v = savingAtYear(S, i, year, BK_COLS); return `${tipHead(d, r)}<div>Firm power, with backup, ${year}: ${usd(costAtYear(S, i, year, 'c100sbY'))} without wind · ${usd(costAtYear(S, i, year, 'c100y'))} with</div>${Number.isFinite(v) ? `<div>Saving: ${format(Math.max(0, v), 'usd')}/MWh</div>` : ''}`; }
        if (k === 'multCons') return d.cells.mapCell[i] ? `${tipHead(d, r)}<div>Wind potential: ${S.multCons[i] >= 1e8 ? 'no recorded demand' : `${format(S.multCons[i], 'int')}× local demand`}</div>` : null;
        const v = S[k][i];
        return Number.isFinite(v) ? `${tipHead(d, r)}<div>Weeks in a lull: ${format(v, 'pct')}</div>` : null;
    };
}
/** A state's caption { title, sub }, from layers.js or STORY_STATES. */
export const stateDef = (name) => STORY_STATES[name] || MAP_STATES[name];

/** { fill(row), tooltip(row) } for a state: the story's colour, layers.js's tooltip. */
export function storyLayer(name, d, year) {
    if (STORY_STATES[name]?.tip) return { fill: fills(name, d, year), tooltip: storyTip(name, d, year) };
    const t = STORY_STATES[name]?.tooltipOf || name;
    return { fill: fills(name, d, year), tooltip: MAP_STATES[t].layer(d, year).tooltip };
}

/** The tiers' legend, up to tier n (80% uptime, local costs): the dots' on the map, the tiles' in the morph. */
export function plannedLegend(n = 3) {
    const tiers = [[PL_SB, 'Solar and batteries under $100/MWh'], [PL_WIND, 'Adding wind, under $100/MWh'], [PL_130, 'Solar, wind and batteries under $130/MWh']].slice(0, n);
    return '<div class="legend-title">Cheapest alternative at 80% uptime</div><div class="legend-tiers">'
        + tiers.map(([c, t]) => chip(c, t)).join('') + chip(PL_ALL, n ? 'Above that' : 'In planning') + '</div>';
}
const chip = (c, t) => `<div class="legend-chip"><i style="background:${c}"></i>${t}</div>`;
/** T101: a stepped scale's classes as chips (all of them, as charts.html), then neutral chips (shown only where drawn). */
const classChips = (scaleName, neutrals = []) => '<div class="legend-grid" data-classes="' + scaleName + '">'
    + STATIC_MAP_SCALES[scaleName].colours.map((c, k) => chip(c, classLabels(scaleName)[k])).join('')
    + neutrals.map(([c, t]) => chip(c, t)).join('') + '</div>';
function bar(name, title, labels, chips) {
    const st = STORY_RAMPS[name].stops;
    return (title ? `<div class="legend-title">${title}</div>` : '')
        + `<div class="legend-bar" data-ramp="${name}" style="background:linear-gradient(to right, ${st.join(', ')})"></div>`
        + `<div class="legend-labels">${labels.map(l => `<span>${l}</span>`).join('')}</div>`
        + `<div class="legend-chips">${chips.map(([c, t]) => chip(c, t)).join('')}</div>`;
}

const USED = new Map();
const CATEGORY = new Set([RECEDE_GREY, LCOE_NO_DATA_COLOR, PENDING_COLOR, STATIC_MAP_NEUTRALS.notMet, ...STORY_RAMPS.potential.stops]);
/** Legend HTML of a state; labels at the bar's ends and middle, from the ramp's own domain. With the map
 *  data `d`, a category chip is listed only if some region is drawn in it. */
export function storyLegend(name, d = null, year = 2026) {
    if (d && !name.startsWith('planned') && name !== 'potential-cons') {   // T101: potential-cons shows all its classes, as charts.html
        // the colours a state draws, once per state (a legend swap must not recolour every region on the main thread)
        const key = `${name}|${year}`;
        let used = USED.get(key);
        if (!used) { const f = fills(name, d, year); used = new Set(Array.from(d.cells.ids, (_, i) => (CATEGORY.has(f({ i })) ? f({ i }) : null))); USED.set(key, used); }
        const html = storyLegend(name);
        return html.replace(/<div class="legend-chip"><i style="background:(#[0-9A-Fa-f]{6})"><\/i>[^<]*<\/div>/g, (m, c) => (used.has(c) || !CATEGORY.has(c) ? m : ''));   // T101: only neutrals are dropped
    }
    const mid = (n, f) => format(ramp(n).valueAt(0.5), f);
    switch (name) {
    case 'windcf': return bar('windcf', 'Average onshore wind capacity factor (%)', ['≤ 15%', mid('windcf', 'pct'), '≥ 50%'], [[RECEDE_GREY, 'No eligible land']]);
    case 'saving':
    case 'saving-europe': return classChips('saving90', [[LCOE_NO_DATA_COLOR, 'Target not met']]);
    case 'winter': return bar('winter', 'Wind output in Nov–Feb', ['33%', mid('winter', 'pct'), '≥ 55%'],
        [[RECEDE_GREY, 'Under a third'], [LCOE_NO_DATA_COLOR, 'No eligible land']]);
    case 'windcost': return bar('windcost', 'Onshore wind ($/MWh, log scale)', ['≤ $25', mid('windcost', 'usd'), '≥ $150'],
        [[LCOE_NO_DATA_COLOR, 'No eligible land']]);
    case 'cost100': return bar('cost90', '', ['≤ $50', mid('cost90', 'usd'), '≥ $200'], [[LCOE_NO_DATA_COLOR, 'No data']]);   // T101: every region with a cost reaches it
    case 'cost99':
    case 'cost99y':
    case 'cost-sb':
    case 'cost-wind': return bar('cost90', '', ['≤ $50', mid('cost90', 'usd'), '≥ $200'], [[LCOE_NO_DATA_COLOR, 'Target not met']]);
    case 'planned-all':
    case 'planned-sb':
    case 'planned-wind':
    case 'planned-130': return plannedLegend(SHOWN[name]);
    case 'drought-solar':
    case 'drought-wind':
    case 'drought-both': return classChips('drought', [[NOT_MET, STATIC_MAP_SCALES.drought.notMet]]);
    case 'potential-gw': return bar('potentialGw', '', ['1', mid('potentialGw', 'int'), '≥ 300'], [[RECEDE_GREY, 'Under 1 GW']]);
    case 'saving99y': return bar('saving99', '', ['$0', mid('saving99', 'usd'), '≥ $200'], [[LCOE_NO_DATA_COLOR, 'Target not met']]);
    case 'saving100y': return classChips('saving99', [[LCOE_NO_DATA_COLOR, 'No data']]);
    case 'potential-cons': {   // T101: the classes of the charts article's map
        const sc = STATIC_MAP_SCALES.multiple, lab = ['Under 1×', '1–2×', '2–10×', '10–100×', 'Over 100×'];
        return '<div class="legend-grid">' + sc.colours.map((col, k) => chip(col, lab[k])).join('') + chip(STATIC_MAP_NEUTRALS.noData, sc.noData) + '</div>';
    }
    case 'potential': return '<div class="legend-grid">'
        + POTENTIAL_BUCKETS.map(b => chip(potColour(b), b.label)).join('') + '</div>';
    default: return '';
    }
}

/** Every state's story colours for every cell (the probe compares them with the drawn pixels). */
export function dumpStoryLayer(d, rows, name, year) {
    const f = fills(name, d, year);
    return rows.map(r => f(r));
}
