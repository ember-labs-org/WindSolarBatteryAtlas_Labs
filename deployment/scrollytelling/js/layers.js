// layers.js – the sticky map's states: what each take colours, its tooltip and
// its legend. Pure functions of the map data ({ cells, pot, results }, decoded
// from data/article-summary.json by summary.js), so the check can run the same
// code on the live model's own results and compare every cell
// (scripts/article/tools/verify-article.mjs). Uses the global d3.
import { LCOE_NO_DATA_COLOR, POTENTIAL_MULTIPLE_BUCKETS, RAMPS, DATA_COLOURS, rampScale } from '../../js/constants.js';
import { format, nf } from './format.js';

// Same as deployment/js/map.js (WIND_LAYER_COLORS, WIND_LAYER_PENDING_COLOR, both from the
// colour registry in js/constants.js, T062) and app.js WIND_SAVING_LEGEND_MAX, so the
// article's map reads like the atlas's wind layers.
export const WIND_LAYER_COLORS = RAMPS.green.stops;
export const PENDING_COLOR = DATA_COLOURS.pending;
export const WIND_SAVING_LEGEND_MAX = 50;
// Regions with no eligible land for wind (wind CF map), and wind potential below local
// demand (potential map): a neutral dark grey that recedes on the atlas's slate land and
// ocean, so the map highlights where wind works (T077). As drawn, at least 17 ΔE2000 from
// the land (no data) and 13 from the ocean and the darkest green step in every simulated
// colour-vision deficiency (team/handoffs/T077.md).
export const RECEDE_GREY = '#4A4A4A';
const NO_SITE_COLOR = RECEDE_GREY;
const LAND_COLOR = '#626E88';   // --map-land (the atlas's --el-slate): cells not drawn show it

/** Take 5's map: the anchor years of the wind cost paths; the page interpolates between them. */
export const WIND_LCOE_YEARS = [2026, 2035, 2050];
export const WIND_COST_RANGE = [2026, 2050];
/** Onshore wind LCOE of cell i in `year`: linear between the anchor years, as the local capex paths are. */
export function windLcoeAt(cells, i, year) {
    const y = Math.max(2026, Math.min(2050, year));
    const [a, b, c] = WIND_LCOE_YEARS.map(Y => cells.windLcoe[Y][i]);
    if (y <= 2035) return a + (b - a) * (y - 2026) / 9;
    return b + (c - b) * (y - 2035) / 15;
}
// Take 3's map: share of a region's 2024 onshore wind output in November–February. An even
// spread would put a third there; the green ramp starts at a third and saturates at 55%.
export const WINTER_EVEN = 1 / 3;
export const winterScale = () => d3.scaleSequential(d3.interpolateRgbBasis(WIND_LAYER_COLORS)).domain([WINTER_EVEN, 0.55]).clamp(true);
// The atlas's LCOE ramp (constants.js RAMPS.lcoe): cheap is bright.
export const windLcoeScale = () => rampScale('lcoe');

export const savingScale = () => d3.scaleSequential(d3.interpolateRgbBasis(WIND_LAYER_COLORS)).domain([0, WIND_SAVING_LEGEND_MAX]).clamp(true);
export const cfScale = () => d3.scaleSequential(d3.interpolateRgbBasis(WIND_LAYER_COLORS)).domain([0.15, 0.5]).clamp(true);

// The atlas's potential buckets, with "< 1×" in the receding grey rather than the atlas's purple:
// the article's map points to where wind works, not where it does not (T077, the human).
export const POTENTIAL_BUCKETS = POTENTIAL_MULTIPLE_BUCKETS.map((b, i) => (i === 0 ? { ...b, color: RECEDE_GREY } : b));

export function bucketOf(x) {
    for (const b of POTENTIAL_BUCKETS) if (b.max == null || x < b.max) return b;
    return POTENTIAL_BUCKETS[POTENTIAL_BUCKETS.length - 1];
}

function tip(cells, row, lines) {
    const c = cells.country[row.i];
    const head = c && c !== '(none)' ? c : `${row.latitude.toFixed(1)}°, ${row.longitude.toFixed(1)}°`;
    return `<div class="tt-head">${head}</div>${lines.map(l => `<div>${l}</div>`).join('')}`;
}

function gradientLegend(title, colors, labels, chips = []) {
    return `<div class="legend-title">${title}</div>`
        + `<div class="legend-bar" style="background:linear-gradient(to right, ${colors.join(', ')})"></div>`
        + `<div class="legend-labels">${labels.map(l => `<span>${l}</span>`).join('')}</div>`
        + chips.map(([c, t]) => `<div class="legend-chip"><i style="background:${c}"></i>${t}</div>`).join('');
}

function windCfLayer(d) {
    const s = cfScale();
    const c = d.cells;
    return {
        fill: r => (c.onViable[r.i] && Number.isFinite(c.onCf[r.i]) ? s(c.onCf[r.i]) : NO_SITE_COLOR),
        tooltip: r => tip(c, r, [c.onViable[r.i] ? `Onshore capacity factor: ${format(c.onCf[r.i], 'pct')}` : 'No eligible land for onshore wind'])
    };
}

function savingLayer(d, res) {
    const s = savingScale();
    return {
        fill: (r) => {
            const i = r.i;
            if (!res.priced[i] || !res.meets[i]) return LCOE_NO_DATA_COLOR;
            return Number.isFinite(res.saving[i]) ? s(Math.max(0, res.saving[i])) : PENDING_COLOR;
        },
        tooltip: (r) => {
            const i = r.i;
            if (!res.meets[i]) return tip(d.cells, r, ['90% uptime not reached']);
            return tip(d.cells, r, [`Saving from wind: ${format(Math.max(0, res.saving[i]), 'usd')}/MWh`,
                `Solar + batteries: ${format(res.nwLcoe[i], 'usd')} · with wind: ${format(res.lcoe[i], 'usd')}`]);
        }
    };
}

function savingLegend() {
    return gradientLegend('Saving from wind ($/MWh)', WIND_LAYER_COLORS, ['$0', '$25', `≥ $${WIND_SAVING_LEGEND_MAX}`],
        [[LCOE_NO_DATA_COLOR, 'Target not met']]);
}

function winterLayer(d) {
    const c = d.cells, s = winterScale();
    return {
        fill: (r) => {
            const x = c.windNF[r.i];
            if (!c.onViable[r.i] || !Number.isFinite(x)) return LCOE_NO_DATA_COLOR;
            return x < WINTER_EVEN ? RECEDE_GREY : s(x);
        },
        tooltip: r => tip(c, r, [c.onViable[r.i] && Number.isFinite(c.windNF[r.i])
            ? `Wind output in November–February: ${format(c.windNF[r.i], 'pct')} of the year's`
            : 'No eligible land for onshore wind'])
    };
}

function windCostLayer(d, year) {
    const c = d.cells, s = windLcoeScale();
    return {
        fill: (r) => {
            if (!c.onViable[r.i] || !Number.isFinite(c.windLcoe[2026][r.i])) return LCOE_NO_DATA_COLOR;
            return s(windLcoeAt(c, r.i, year));
        },
        tooltip: r => tip(c, r, [c.onViable[r.i] && Number.isFinite(c.windLcoe[2026][r.i])
            ? `Onshore wind, ${year}: ${format(windLcoeAt(c, r.i, year), 'usd')}/MWh`
            : 'No eligible land for onshore wind'])
    };
}

function potentialLayer(d) {
    const p = d.pot, c = d.cells;
    return {
        fill: r => (c.mapCell[r.i] ? bucketOf(p.multiple[r.i]).color : null),
        tooltip: r => (c.mapCell[r.i] ? tip(c, r, [Number.isFinite(p.multiple[r.i])
            ? `Wind potential: ${nf.format(Math.round(p.multiple[r.i]))}× local demand`
            : 'Wind potential: no recorded demand']) : null)
    };
}

/**
 * Map states by name. `layer(d, year)` returns { fill(row), tooltip(row) } for
 * rows { i, latitude, longitude }; `ready(d, year)` says whether its data is in.
 */
export const MAP_STATES = {
    windcf: {
        title: 'Onshore wind capacity factor',
        sub: 'Each region\'s simulated onshore site, 2015–2024 average',
        view: 'world',
        ready: d => !!d?.cells,
        layer: d => windCfLayer(d),
        legend: () => gradientLegend('Capacity factor', WIND_LAYER_COLORS, ['15%', '30%', '≥ 50%'], [[NO_SITE_COLOR, 'No eligible land']])
    },
    saving: {
        title: 'Saving from wind at 90% uptime',
        sub: '2026 costs, one cost of capital everywhere, $/MWh, against the cheapest solar + battery build',
        view: 'world',
        ready: d => !!d?.results?.t90,
        layer: d => savingLayer(d, d.results.t90),
        legend: savingLegend
    },
    'saving-europe': {
        title: 'Saving from wind at 90% uptime',
        sub: '2026 costs, one cost of capital everywhere, $/MWh, against the cheapest solar + battery build',
        view: 'europe',
        ready: d => !!d?.results?.t90,
        layer: d => savingLayer(d, d.results.t90),
        legend: savingLegend
    },
    potential: {
        title: 'Wind potential against local demand',
        sub: 'Onshore (5 MW/km²) and fixed-bottom offshore, × each region\'s demand',
        view: 'world',
        ready: d => !!d?.pot,
        layer: d => potentialLayer(d),
        legend: () => `<div class="legend-title">Wind potential / demand</div><div class="legend-grid">`
            + POTENTIAL_BUCKETS.map(b => `<div class="legend-chip"><i style="background:${b.color}"></i>${b.label}</div>`).join('')
            + `<div class="legend-chip"><i style="background:${LAND_COLOR}"></i>No data</div></div>`
    },
    winter: {
        title: 'Wind blows hardest in winter',
        sub: 'Share of each region\'s onshore wind output in November–February, 2024; an even spread is a third',
        view: 'europe',
        ready: d => !!d?.cells?.windNF,
        layer: d => winterLayer(d),
        legend: () => gradientLegend('Wind output in Nov–Feb', WIND_LAYER_COLORS, ['33%', '44%', '≥ 55%'],
            [[RECEDE_GREY, 'Under a third'], [LCOE_NO_DATA_COLOR, 'No eligible land']])
    },
    windcost: {
        title: year => `Cost of onshore wind power, ${year}`,
        sub: 'Levelised cost at each region\'s simulated site, local capital costs, one cost of capital, $/MWh',
        view: 'world',
        controls: true,
        ready: d => !!d?.cells?.windLcoe,
        layer: (d, year) => windCostLayer(d, year),
        legend: () => {
            const f = windLcoeScale();
            return `<div class="legend-title">Onshore wind ($/MWh)</div><div class="legend-bar" style="background:${f.css()}"></div>`
                + '<div class="legend-labels"><span>≤ $30</span><span>$140</span><span>≥ $250</span></div>'
                + `<div class="legend-chip"><i style="background:${LCOE_NO_DATA_COLOR}"></i>No eligible land</div>`;
        }
    }
};

/** Every drawable state, with the year where it matters: what the check compares. */
export const LAYER_CASES = [['windcf'], ['saving'], ['potential'], ['winter'], ...WIND_LCOE_YEARS.map(y => ['windcost', y])];
// (Years between the anchors are the same interpolation of the same three values on the page.)

/** Fill and tooltip of every cell for one state (the check's comparison). */
export function dumpLayer(d, rows, name, year) {
    const l = MAP_STATES[name].layer(d, year);
    return { fill: rows.map(r => l.fill(r)), tooltip: rows.map(r => l.tooltip(r)) };
}
