// static-map.js – static maps for charts.html (T091): the scrolly map's states drawn once, without a stage, camera
// or motion, on Ember's light chart background, in stepped classes.
//
// The same regions (Voronoi cells around each region's site, cut to the land of data/world.geojson), projection and
// per-region values as the scrolly map (the values story-layers.js colours), classed with round breaks
// (constants.js STATIC_MAP_SCALES) so each class reads apart from its neighbours; "no data" and "target not met" are
// separate neutrals, never a class colour. Circles (a region's demand, its planned coal and gas) are drawn over the
// land. Hover shows the scrolly map's own tooltip.
//
// Drawing: one polygon or one region per fill, the regions cut to the coast with a land mask. WebKit (iPhone) left the
// land and the regions unfilled when they were one merged Path2D or clipped to one (the human, T091).
import { STATIC_MAP_SCALES, STATIC_MAP_NEUTRALS as N } from '../../js/constants.js';
import { storyLayer, savingAtYear, BK_COLS } from './story-layers.js';

// The world view of map.js VIEWS.world ([[-56, -168], [78, 178]]), copied so this page never loads the Leaflet map modules
const WORLD_BOX = [[-56, -168], [78, 178]];

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---- values and classes ---------------------------------------------------------------------------------------
// Each state's value per region, as the scrolly map's colours read it (story-layers.js fills): a number; NaN where the
// build never reaches the target ("target not met"); null where the region has no data.
const STATE_SCALE = {
    'cost-sb': 'cost', 'cost-wind': 'cost', cost99: 'cost', cost100: 'cost', saving: 'saving90', saving99y: 'saving99', saving100y: 'saving99',
    'drought-solar': 'drought', 'drought-wind': 'drought', 'drought-both': 'drought', 'potential-gw': 'potentialGw',
    'potential-cons': 'multiple', 'cost-local': 'cost', 'wacc-local': 'wacc'
};
export const scaleOf = (name) => STATE_SCALE[name];

export function stateValue(name, d, year = 2026) {
    const c = d.cells, S = d.story, res = d.results?.t90;
    switch (name) {
    case 'cost-sb':
    case 'cost-wind': {
        const col = name === 'cost-sb' ? res.nwLcoe : res.lcoe;
        return r => (!res.priced[r.i] || !res.meets[r.i] || !Number.isFinite(col[r.i]) ? NaN : col[r.i]);
    }
    case 'saving':
        return (r) => {
            if (!res.priced[r.i] || !res.meets[r.i]) return NaN;
            return Number.isFinite(res.saving[r.i]) ? Math.max(0, res.saving[r.i]) : null;
        };
    case 'cost99': return r => S.c99[r.i];
    case 'cost100': return r => S.c100[r.i];
    case 'saving99y': return (r) => { const v = savingAtYear(S, r.i, year); return Number.isFinite(v) ? Math.max(0, v) : NaN; };
    // every region with a priced build reaches every hour with backup; the rest (no build priced, no demand) are no data
    case 'saving100y': return (r) => { const v = savingAtYear(S, r.i, year, BK_COLS); return Number.isFinite(v) ? Math.max(0, v) : null; };
    case 'drought-solar':
    case 'drought-wind':
    case 'drought-both': {
        const col = S[{ 'drought-solar': 'droughtSolar', 'drought-wind': 'droughtWind', 'drought-both': 'droughtBoth' }[name]];
        // T088 left out the 155 regions with no usable wind site (best onshore capacity factor under 2%, as in the Amazon
        // and Congo basins, or no buildable onshore land): hatched as the scale's notMet, not "no data" (the human, T091 r6)
        return r => (Number.isFinite(col[r.i]) ? col[r.i] : NaN);
    }
    case 'potential-gw': return r => (c.mapCell[r.i] ? S.potGw[r.i] : null);
    // conservative potential / the region's own demand (story-cells multCons; >= 1e8 marks a region with no recorded demand)
    case 'potential-cons': return r => (c.mapCell[r.i] && S.multCons[r.i] < 1e8 ? S.multCons[r.i] : null);
    // T091 cost-of-capital lens (story-localwacc.json; scripts/article/analysis/t091/): the cheapest build at 90% with wind
    // with each region's own cost of capital (NaN where 90% is not met, as cost-wind), and that cost of capital itself
    case 'cost-local': return r => { const v = d.local.c90[r.i]; return Number.isFinite(v) ? v : NaN; };
    case 'wacc-local': return r => (Number.isFinite(d.local.waccLocal[r.i]) ? d.local.waccLocal[r.i] : null);
    default: throw new Error(`no static scale for ${name}`);
    }
}

/** The class (0 = lowest) of value v on a scale: the number of breaks at or below v. */
export function classOf(scale, v) {
    let k = 0;
    while (k < scale.breaks.length && v >= scale.breaks[k]) k++;
    return k;
}

/** row -> 'nodata' | 'notmet' | class index, for a state. */
export function staticClass(name, d, year) {
    const scale = STATIC_MAP_SCALES[STATE_SCALE[name]], val = stateValue(name, d, year);
    return (r) => { const v = val(r); return v == null ? 'nodata' : Number.isNaN(v) ? 'notmet' : classOf(scale, v); };
}

// A continuous scale's colour at value v: piecewise between its stops (log axis if `log`), blended in CIELAB, clamped.
const INTERP = new Map();
function interpolator(scale) {
    let f = INTERP.get(scale);
    if (!f) {
        const t = scale.log ? Math.log : (x => x);
        const s = d3.scaleLinear().domain(scale.stops.map(([v]) => t(v))).range(scale.stops.map(([, c]) => c)).interpolate(d3.interpolateLab).clamp(true);
        f = v => d3.color(s(t(v))).formatHex();
        f.t = t;
        INTERP.set(scale, f);
    }
    return f;
}
/** The colour of value v on a scale (continuous or stepped). */
export function scaleColour(scaleName, v) {
    const sc = STATIC_MAP_SCALES[scaleName];
    return sc.continuous ? interpolator(sc)(v) : sc.colours[classOf(sc, v)];
}
/** row -> { key: 'nodata' | 'notmet' | class index, colour (for a value) }, for a state. */
export function staticPaint(name, d, year) {
    const scaleName = STATE_SCALE[name], sc = STATIC_MAP_SCALES[scaleName], val = stateValue(name, d, year);
    return (r) => {
        const v = val(r);
        if (v == null) return { key: 'nodata', colour: N.noData };
        if (Number.isNaN(v)) return { key: 'notmet', colour: N.notMet };
        return { key: classOf(sc, v), colour: scaleColour(scaleName, v) };
    };
}

const num = (v, fmt) => (fmt === 'usd' ? `$${v}` : fmt === 'pct' ? `${Math.round(v * 100)}%` : fmt === 'x' ? `${v}×` : `${v}`);
const range = (lo, hi, fmt, unit) => (fmt === 'usd' ? `$${lo}–${hi}` : fmt === 'pct' ? `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`
    : fmt === 'x' ? `${lo}–${hi}×` : `${lo}–${hi}${unit}`);
/** The label of class k of a scale: "Under $60", "$60–80", "Over $200"; class 0 of a nil scale is its nil label. */
export function classLabel(scale, k) {
    const b = scale.breaks, u = scale.fmt === 'int' ? scale.unit : '';
    if (k === 0) return scale.nil || `Under ${num(b[0], scale.fmt)}${u}`;
    if (k === b.length) return `Over ${num(b[b.length - 1], scale.fmt)}${u}`;
    return range(b[k - 1], b[k], scale.fmt, scale.unit);
}
const HATCH_CSS = `repeating-linear-gradient(135deg, ${N.notMet} 0 1px, ${N.land} 1px 4px)`;
const TITLES = { cost: 'Cost of power ($/MWh)', saving90: 'Saving from adding wind ($/MWh)', saving99: 'Saving from adding wind ($/MWh)',
    drought: 'Share of weeks in a lull', potentialGw: 'Buildable wind (GW)',
    multiple: 'Wind potential, as a multiple of the region\'s own electricity demand',
    wacc: 'Cost of capital, each region\'s own (% a year)' };
/** A stepped legend: every class of the scale, then "Target not met" and "No data" if drawn (used: Set of keys). */
export function staticLegend(scaleName, used = new Set()) {
    const sc = STATIC_MAP_SCALES[scaleName];
    const step = (bg, label) => `<span class="legend-step"><i style="background:${bg}"></i>${label}</span>`;
    if (sc.continuous) {
        // a bar drawn from the map's own interpolator (48 samples, so the browser's sRGB blend between them is exact
        // to the eye), ticks at the stops on the same log axis; the neutrals as steps after it
        const f = interpolator(sc), lo = f.t(sc.stops[0][0]), hi = f.t(sc.stops[sc.stops.length - 1][0]);
        const at = v => (100 * (f.t(v) - lo) / (hi - lo)).toFixed(2);
        const samples = d3.range(49).map(k => { const v = Math.exp(lo + (hi - lo) * k / 48); return `${f(sc.log ? v : lo + (hi - lo) * k / 48)} ${(100 * k / 48).toFixed(2)}%`; });
        const ticks = sc.stops.map(([v], k) => {
            const label = k === 0 ? `≤ ${num(v, sc.fmt)}` : k === sc.stops.length - 1 ? `≥ ${num(v, sc.fmt)}` : num(v, sc.fmt);
            const minor = k > 0 && k < sc.stops.length - 1 && v !== 100;   // hidden on phones (css), where the labels would touch
            return `<span class="legend-tick${minor ? ' legend-tick--minor' : ''}" style="left:${at(v)}%">${label}</span>`;
        }).join('');
        const extra = (used.has('notmet') ? step(HATCH_CSS, sc.notMet || 'Target not met') : '') + (used.has('nodata') ? step(N.noData, sc.noData || 'No data') : '');
        return `<div class="legend-title">${TITLES[scaleName]}</div><div class="legend-continuous"><div class="legend-ramp" style="background:linear-gradient(to right, ${samples.join(', ')})"></div>`
            + `<div class="legend-ticks">${ticks}</div></div>` + (extra ? `<div class="legend-steps">${extra}</div>` : '');
    }
    return `<div class="legend-title">${TITLES[scaleName]}</div><div class="legend-steps">`
        + sc.colours.map((c, k) => step(c, classLabel(sc, k))).join('')
        + (used.has('notmet') ? step(HATCH_CSS, sc.notMet || 'Target not met') : '')
        + (used.has('nodata') ? step(N.noData, sc.noData || 'No data') : '')
        + '</div>';
}
/** The colour of a class (for circles): the class colour, or a neutral. */
export function classColour(scaleName, k) {
    return k === 'nodata' ? N.noData : k === 'notmet' ? N.notMet : STATIC_MAP_SCALES[scaleName].colours[k];
}
export const NEUTRALS = N;

// ---- geometry ---------------------------------------------------------------------------------------------------
/** The land as d3-geo expects it (as story-map.js): a ring whose area comes out above a hemisphere is reversed. */
export function rewound(world) {
    const fix = (geom) => {
        const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
        return {
            type: 'MultiPolygon',
            coordinates: polys.map(rings => (d3.geoArea({ type: 'Polygon', coordinates: rings }) > 2 * Math.PI ? rings.map(r => r.slice().reverse()) : rings))
        };
    };
    const feats = world.type === 'FeatureCollection' ? world.features : [world];
    return { type: 'FeatureCollection', features: feats.map(f => ({ type: 'Feature', properties: {}, geometry: fix(f.geometry || f) })) };
}

function boxFeature([[s, w], [n, e]]) {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
        const x = w + (e - w) * i / 24, y = s + (n - s) * i / 24;
        pts.push([x, s], [x, n], [w, y], [e, y]);
    }
    return { type: 'MultiPoint', coordinates: pts };
}

let tipEl = null;
function tooltip() {
    if (!tipEl) {
        tipEl = document.createElement('div');
        tipEl.className = 'map-tooltip static-map-tooltip';
        tipEl.hidden = true;
        document.body.appendChild(tipEl);
    }
    return tipEl;
}

/** A small hatch tile (diagonal lines on white) for "target not met", at the canvas's pixel ratio. */
function hatch(ctx, dpr) {
    const n = Math.max(4, Math.round(5 * dpr));
    const t = document.createElement('canvas');
    t.width = t.height = n;
    const c = t.getContext('2d');
    c.fillStyle = N.land;
    c.fillRect(0, 0, n, n);
    c.strokeStyle = N.notMet;
    c.lineWidth = Math.max(1, dpr * 0.8);
    c.beginPath();
    c.moveTo(0, n); c.lineTo(n, 0);
    c.moveTo(-n / 2, n / 2); c.lineTo(n / 2, -n / 2);
    c.moveTo(n / 2, n * 1.5); c.lineTo(n * 1.5, n / 2);
    c.stroke();
    return ctx.createPattern(t, 'repeat');
}

/**
 * Draw a map figure into el (a .chart-svg inside a figure.chart).
 * spec: { world, rows, d, scale: STATIC_MAP_SCALES key for the legend (or legendHtml),
 *   panels: [{ label, state, year, points: [{ lon, lat, r, colour, key }] | null, tip: row -> html }],
 *   parallels: [lat, ...] (dashed lines with a label), box: [[s, w], [n, e]], pointStroke: CSS token }
 * Returns { panels: [{ state, year, coloured, hist: { class key: regions }, points, pointHist }] } for the checks.
 */
export function staticMap(el, spec) {
    el.innerHTML = '';
    const { d, rows } = spec;
    const width = Math.max(260, Math.round(el.clientWidth || 320));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const box = spec.box || WORLD_BOX;
    // Web Mercator, as the tool's Leaflet maps (D-175), so a region looks the same in the article and the tool
    const proj = d3.geoMercator().fitWidth(width, boxFeature(box));
    const path = d3.geoPath(proj);
    const [[, y0], [, y1]] = path.bounds(boxFeature(box));
    proj.translate([proj.translate()[0], proj.translate()[1] - y0]);
    const height = Math.ceil(y1 - y0);
    // The land as single polygons (each outer ring with its own holes), drawn one at a time.
    const polys = spec.world.features.flatMap(f => f.geometry.coordinates.map(c => ({ type: 'Polygon', coordinates: c })));
    const sites = rows.map(r => proj([r.longitude, r.latitude]));
    const delaunay = d3.Delaunay.from(sites);
    const vor = delaunay.voronoi([-width, -height, 2 * width, 2 * height]);
    const C = { line: token('--muted'), text: token('--text'), panel: token('--panel') };

    // The legend sits above the panels; it is filled once every panel is drawn (it lists the neutrals actually used)
    const legend = document.createElement('div');
    legend.className = 'map-legend static-map-legend';
    el.appendChild(legend);
    const used = new Set();

    const out = [];
    const grid = document.createElement('div');
    grid.className = `static-map-grid static-map-grid--${spec.panels.length}`;
    el.appendChild(grid);
    for (const p of spec.panels) {
        const wrap = document.createElement('div');
        wrap.className = 'static-map-panel';
        grid.appendChild(wrap);
        // panel label as SVG text (like a chart's own labels; the number scan reads HTML text, not the drawing)
        const pw = Math.max(240, Math.round(wrap.clientWidth || width));
        const scale = pw / width;
        if (p.label) {
            const svg = d3.select(wrap).append('svg').attr('width', pw).attr('height', 20).attr('aria-hidden', 'true').style('font-family', 'var(--font-sans)');
            svg.append('text').attr('x', 0).attr('y', 14).attr('fill', C.text).attr('font-size', 12.5).attr('font-weight', 600).text(p.label);
        }
        // perPanelLegend (T091 cost-of-capital lens): panels on different scales each get their own legend, filled below
        const panelLegend = spec.perPanelLegend ? wrap.appendChild(Object.assign(document.createElement('div'), { className: 'map-legend static-map-legend' })) : null;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(pw * dpr);
        canvas.height = Math.round(height * scale * dpr);
        canvas.style.width = `${pw}px`;
        canvas.style.height = `${Math.round(height * scale)}px`;
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${p.label || ''} map`.trim());
        canvas.dataset.state = p.state || '';
        wrap.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const T = [dpr * scale, 0, 0, dpr * scale, 0, 0];
        const geo = (c) => d3.geoPath(proj, c);
        // the land mask, in the land colour: one polygon per fill
        const mask = document.createElement('canvas');
        mask.width = canvas.width;
        mask.height = canvas.height;
        const mctx = mask.getContext('2d', { willReadFrequently: true });
        mctx.setTransform(...T);
        mctx.fillStyle = N.land;
        for (const poly of polys) { mctx.beginPath(); geo(mctx)(poly); mctx.fill(); }
        // the regions, one fill each by class, then cut to the coast (destination-in) and laid over the land (destination-over)
        ctx.setTransform(...T);
        let coloured = 0;
        const hist = {};   // class key -> regions drawn in it (the checks read it)
        const scaleName = p.state ? STATE_SCALE[p.state] : null;
        if (scaleName) {
            const paint = staticPaint(p.state, d, p.year || 2026), pat = hatch(ctx, dpr * scale);
            // no borders between regions: within a class they carry nothing, and over dark classes they read as a mesh;
            // each region is stroked in its own fill (half a pixel) so neighbours join without a seam
            ctx.lineWidth = 0.5 / scale;
            rows.forEach((r, i) => {
                const { key: k, colour } = paint(r);
                const fill = k === 'notmet' ? pat : colour;
                ctx.beginPath();
                vor.renderCell(i, ctx);
                ctx.fillStyle = fill;
                ctx.fill();
                ctx.strokeStyle = fill;
                ctx.stroke();
                coloured++;
                hist[k] = (hist[k] || 0) + 1;
                if (typeof k === 'string') used.add(k);
            });
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'destination-in';
            ctx.drawImage(mask, 0, 0);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'destination-over';
        ctx.drawImage(mask, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.setTransform(...T);
        ctx.lineWidth = 0.6 / scale;
        ctx.strokeStyle = N.coast;
        for (const poly of polys) { ctx.beginPath(); geo(ctx)(poly); ctx.stroke(); }
        for (const lat of spec.parallels || []) {
            ctx.save();
            ctx.setLineDash([4 / scale, 3 / scale]);
            ctx.lineWidth = 1 / scale;
            ctx.strokeStyle = C.line;
            ctx.beginPath();
            geo(ctx)({ type: 'LineString', coordinates: d3.range(box[0][1], box[1][1] + 1, 2).map(lon => [lon, lat]) });
            ctx.stroke();
            ctx.restore();
        }
        const pointHist = {};
        if (p.points) {
            ctx.lineWidth = (spec.pointStroke ? 0.6 : 0.5) / scale;
            ctx.strokeStyle = spec.pointStroke ? token(spec.pointStroke) : C.panel;
            for (const q of [...p.points].sort((a, b) => b.r - a.r)) {
                const s = proj([q.lon, q.lat]);
                if (!s) continue;
                ctx.beginPath();
                ctx.arc(s[0], s[1], q.r / scale, 0, 2 * Math.PI);
                ctx.fillStyle = q.colour;
                ctx.fill();
                ctx.stroke();
                const key = q.key ?? q.colour;
                pointHist[key] = (pointHist[key] || 0) + 1;
                if (typeof q.key === 'string') used.add(q.key);
            }
        }
        // labels of the parallels, over the map at its left edge (SVG, as the panel label)
        if ((spec.parallels || []).length) {
            const svg = d3.select(wrap).append('svg').attr('class', 'static-map-over').attr('width', pw).attr('height', Math.round(height * scale))
                .attr('aria-hidden', 'true').style('font-family', 'var(--font-sans)');
            svg.style('top', `${canvas.offsetTop}px`);   // under the label (and a panel legend), on the canvas
            for (const lat of spec.parallels) {
                const s = proj([box[0][1] + 4, lat]);
                svg.append('text').attr('x', 2).attr('y', s[1] * scale - 4).attr('fill', C.line).attr('font-size', 10.5).attr('font-weight', 600)
                    .attr('paint-order', 'stroke').attr('stroke', C.panel).attr('stroke-width', 3).text(`${lat}°N`);
            }
        }
        // hover: the region under the pointer (the nearest site inside the land) and the state's tooltip
        const tipOf = p.tip || (p.state ? storyLayer(p.state, d, p.year || 2026).tooltip : null);
        if (tipOf) {
            canvas.addEventListener('mousemove', (e) => {
                const b = canvas.getBoundingClientRect();
                const x = (e.clientX - b.left) / scale, y = (e.clientY - b.top) / scale;
                const t = tooltip();
                const px = Math.floor(x * scale * dpr), py = Math.floor(y * scale * dpr);
                if (px < 0 || py < 0 || px >= mask.width || py >= mask.height || mctx.getImageData(px, py, 1, 1).data[3] < 128) { t.hidden = true; return; }
                const html = tipOf(rows[delaunay.find(x, y)]);
                if (!html) { t.hidden = true; return; }
                t.innerHTML = html;
                t.hidden = false;
                const tw = t.offsetWidth;
                t.style.left = `${Math.min(window.innerWidth - tw - 8, e.clientX + 14) + window.scrollX}px`;
                t.style.top = `${e.clientY + 14 + window.scrollY}px`;
            });
            canvas.addEventListener('mouseleave', () => { tooltip().hidden = true; });
        }
        if (panelLegend) panelLegend.innerHTML = staticLegend(scaleName, new Set(Object.keys(hist).filter(k => k === 'nodata' || k === 'notmet')));
        out.push({ state: p.state, year: p.year || 2026, scale: scaleName, coloured, hist, points: p.points ? p.points.length : 0, pointHist });
    }
    if (spec.perPanelLegend) legend.remove();
    else legend.innerHTML = spec.legendHtml || (staticLegend(spec.scale, used) + (spec.legendNote ? `<div class="legend-note">${spec.legendNote}</div>` : ''));
    return { panels: out, legendUsed: [...used] };
}

// ---- the population cartogram (T091 round 4) ------------------------------------------------------------------------
/** Rings of story-cartogram.json, decoded: [[x0, y0, dx, dy, ...] in units of q] -> [Float64Array of x, y, x, y, ...]. */
function decodeRings(rings, q = 1) {
    return rings.map((d) => {
        const out = new Float64Array(d.length);
        let x = 0, y = 0;
        for (let k = 0; k < d.length; k += 2) { x += d[k]; y += d[k + 1]; out[k] = x * q; out[k + 1] = y * q; }
        return out;
    });
}
function traceRings(ctx, rings) {
    for (const r of rings) {
        ctx.moveTo(r[0], r[1]);
        for (let k = 2; k < r.length; k += 2) ctx.lineTo(r[k], r[k + 1]);
        ctx.closePath();
    }
}
/** Even-odd point in rings (pure arithmetic: no Path2D, which WebKit mishandled here). */
function inRings(rings, x, y) {
    let inside = false;
    for (const r of rings) {
        for (let k = 0, j = r.length - 2; k < r.length; j = k, k += 2) {
            const xi = r[k], yi = r[k + 1], xj = r[j], yj = r[j + 1];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
    }
    return inside;
}
let CARTO = null;
/**
 * The atlas's regions redrawn with area proportional to population (scripts/article/analysis/t091/build_cartogram.py),
 * each coloured by a state's value (staticPaint), with thin country borders, the coast and labels of the most populous
 * countries. spec: { carto (story-cartogram.json), d, rows, state, scale, legendNote, tip }.
 */
export function cartogramMap(el, spec) {
    el.innerHTML = '';
    const { d, rows, carto } = spec;
    if (!CARTO || CARTO.src !== carto) {
        const q = carto.quantum ?? 0.1;
        const regions = carto.regions.map(rs => decodeRings(rs, q));
        const boxes = regions.map((rs) => {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const r of rs) for (let k = 0; k < r.length; k += 2) { x0 = Math.min(x0, r[k]); x1 = Math.max(x1, r[k]); y0 = Math.min(y0, r[k + 1]); y1 = Math.max(y1, r[k + 1]); }
            return [x0, y0, x1, y1];
        });
        CARTO = { src: carto, regions, boxes, countries: carto.countries.map(rs => decodeRings(rs, q)), coast: decodeRings(carto.coast, q) };
    }
    const width = Math.max(260, Math.round(el.clientWidth || 320));
    const scale = width / carto.width, height = Math.round(carto.height * scale);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const C = { text: token('--text'), panel: token('--panel') };
    const legend = document.createElement('div');
    legend.className = 'map-legend static-map-legend';
    el.appendChild(legend);
    const wrap = document.createElement('div');
    wrap.className = 'static-map-panel';
    el.appendChild(wrap);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Cartogram: each region drawn with an area proportional to its population');
    canvas.dataset.state = spec.state;
    wrap.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    const paint = staticPaint(spec.state, d), used = new Set(), hist = {};
    let coloured = 0;
    ctx.lineWidth = 0.6 / scale;
    rows.forEach((r, i) => {
        const rs = CARTO.regions[i];
        if (!rs || !rs.length) return;
        const { key, colour } = paint(r);
        ctx.beginPath();
        traceRings(ctx, rs);
        ctx.fillStyle = colour;
        ctx.fill('evenodd');
        ctx.strokeStyle = colour;       // seals the seam with its neighbours
        ctx.stroke();
        coloured++;
        hist[key] = (hist[key] || 0) + 1;
        if (typeof key === 'string') used.add(key);
    });
    // country borders (white hairlines), then the coast
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.7 / scale;
    ctx.strokeStyle = N.land;
    for (const rs of CARTO.countries) { ctx.beginPath(); traceRings(ctx, rs); ctx.stroke(); }
    ctx.lineWidth = 0.8 / scale;
    ctx.strokeStyle = N.coast;
    for (const r of CARTO.coast) { ctx.beginPath(); traceRings(ctx, [r]); ctx.stroke(); }
    // labels of the most populous countries (SVG over the canvas, like the other maps' labels)
    const svg = d3.select(wrap).append('svg').attr('class', 'static-map-over').attr('width', width).attr('height', height)
        .attr('aria-hidden', 'true').style('top', '0px').style('font-family', 'var(--font-sans)');
    const fs = width < 520 ? 9.5 : 11.5;
    // in population order (as the file lists them); a label that would touch one already placed is left out
    const placed = [];
    for (const l of carto.labels) {
        const t = svg.append('text').attr('x', l.x * scale).attr('y', l.y * scale).attr('text-anchor', 'middle').attr('dy', '0.35em')
            .attr('font-size', fs).attr('font-weight', 600).attr('fill', C.text)
            .attr('paint-order', 'stroke').attr('stroke', N.land).attr('stroke-opacity', 0.85).attr('stroke-width', 3).text(l.name);
        const b = t.node().getBBox();
        if (placed.some(p => b.x < p.x + p.width + 2 && p.x < b.x + b.width + 2 && b.y < p.y + p.height && p.y < b.y + b.height)) t.remove();
        else placed.push(b);
    }
    // hover: the region under the pointer (bounding boxes first, then the rings)
    const tipOf = spec.tip;
    canvas.addEventListener('mousemove', (e) => {
        const b = canvas.getBoundingClientRect();
        const x = (e.clientX - b.left) / scale, y = (e.clientY - b.top) / scale;
        const t = tooltip();
        let hit = -1;
        for (let i = 0; i < CARTO.boxes.length && hit < 0; i++) {
            const q = CARTO.boxes[i];
            if (x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3] && inRings(CARTO.regions[i], x, y)) hit = i;
        }
        const html = hit >= 0 ? tipOf(rows[hit]) : null;
        if (!html) { t.hidden = true; return; }
        t.innerHTML = html;
        t.hidden = false;
        t.style.left = `${Math.min(window.innerWidth - t.offsetWidth - 8, e.clientX + 14) + window.scrollX}px`;
        t.style.top = `${e.clientY + 14 + window.scrollY}px`;
    });
    canvas.addEventListener('mouseleave', () => { tooltip().hidden = true; });
    legend.innerHTML = staticLegend(spec.scale, used) + (spec.legendNote ? `<div class="legend-note">${spec.legendNote}</div>` : '');
    return { panels: [{ state: spec.state, year: 2026, scale: spec.scale, coloured, hist, points: 0, pointHist: {} }], legendUsed: [...used], cartogram: true };
}
