// voronoi-canvas.js — render a Voronoi map on a single <canvas> instead of
// ~5,000 SVG <path> nodes. This is the default path (FEATURE_VORONOI_CANVAS is on);
// ?canvas=0 falls back to SVG for A/B checks. One instance per Leaflet map
// (primary, supply, subset).
//
// WHY: ~5,000 SVG cells force the browser to lay out/paint thousands of DOM nodes
// on every recolor/pan/zoom — measured at 50-190ms/render and the dominant cause
// of interaction lag on weak GPUs/Safari. One canvas draw collapses that.
//
// IDENTITY: we reuse d3's own geometry so the pixels match the SVG path — the land
// mask via d3.geoPath(transform, ctx) and each cell via voronoi.renderCell(i, ctx).
// Positioning: a canvas in a Leaflet pane, so the drag transform carries
// it). The SVG cells' time-based behaviors are replicated by a small rAF engine:
//   - 0.9s fill cross-fade on recolor (`.transition-color`), done by blending two
//     pre-drawn canvases (old frame, new frame) rather than redrawing every cell per
//     frame; skipped under prefers-reduced-motion
//   - chart→map highlight (dim non-matching, 100ms in / 200ms out)
// The loop idles (no rAF) whenever nothing is animating.
//
// PAN: cells and the land path are built in Leaflet LAYER coordinates, which a pan
// does not change (only the map pane moves). A pan therefore only re-pins the canvas
// and redraws once with a translated context; the Delaunay/Voronoi is rebuilt only
// when the zoom, pixel origin or point set changes, and the land Path2D is cached per
// zoom + pixel origin.
//
// HIT-TESTING: delaunay.find(x,y) gated by isPointInPath(landPath), plus an optional
// per-view radius around each site (handlers.hitRadius) that stands in for the
// invisible L.circleMarkers map.js used to add as hover/click targets. Hover, click,
// popup and cursor all come from this one hit-test. A key→index map supports
// cross-map highlight (highlightKey) and chart highlight (setHighlightSet).

import { DATA_COLOURS } from './constants.js';

function dpr() {
    const r = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(r, 2); // match the chart DPI cap
}
// Static base frames are shown through a 'bitmaprenderer' canvas (T037), which
// needs createImageBitmap(canvas) to resolve before the next task, as in Chrome.
// Probed once at load, as basemap.js does (T027); without it the base canvas
// simply stays on the page.
let snapshotInTask = false;
try {
    const probe = typeof document !== 'undefined' && document.createElement('canvas');
    if (probe && probe.getContext('bitmaprenderer') && typeof createImageBitmap === 'function') {
        probe.width = probe.height = 1;
        let nextTask = false;
        const mc = new MessageChannel();
        mc.port1.onmessage = () => { nextTask = true; mc.port1.close(); };
        mc.port2.postMessage(0);
        createImageBitmap(probe).then(bm => { snapshotInTask = !nextTask; bm.close(); }, () => {});
    }
} catch (_) { snapshotInTask = false; }

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function lerp(a, b, t) { return a + (b - a) * t; }

// cubic-bezier(0.25,0.1,0.25,1) — the CSS `ease` curve (recolor cross-fade).
function cssEase(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const x1 = 0.25, y1 = 0.1, x2 = 0.25, y2 = 1;
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    let t = x;
    for (let i = 0; i < 5; i++) {
        const fx = ((ax * t + bx) * t + cx) * t - x;
        if (Math.abs(fx) < 1e-4) break;
        const d = (3 * ax * t + 2 * bx) * t + cx;
        if (Math.abs(d) < 1e-6) break;
        t -= fx / d;
    }
    return ((ay * t + by) * t + cy) * t;
}

// One fill layer's colours per cell (single mode, or dual base / overlay).
// setTarget reports how the new colours relate to the old: 'same', 'fade' (same
// cells, some colour changed) or 'snap' (a different cell set: no cross-fade).
function createFillState() {
    let colors = [];
    return {
        get displayed() { return colors; },
        setTarget(target) {
            const prev = colors;
            colors = target;
            if (prev.length !== target.length) return 'snap';
            for (let i = 0; i < target.length; i++) {
                const a = prev[i], b = target[i];
                if (a === b) continue;
                if (a == null || b == null || a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]) return 'fade';
            }
            return 'same';
        },
        reset() { colors = []; },
    };
}

function prefersReducedMotion() {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const NA_FILL = '__na__'; // sentinel a fillAccessor returns for no-data sample cells
// Hatch drawn over a cell's colour where wind is not viable (T033): thin lines
// running top-left to bottom-right, every `period` px, anchored at layer point
// (0,0). Each dark line has a faint light one `shift` px to its right, so it reads
// on dark and bright colours alike. The no-data hatch instead replaces the colour
// with a grey wash and light lines the other way. map.js builds the SVG pattern
// (?canvas=0) from the same values. `alpha` scales both lines (T096: softer, as an
// offshore-only build hatches every inland region), so the cell colour shows through.
const WIND_HATCH = { period: 8, width: 1, shift: 2, alpha: 0.5, stroke: DATA_COLOURS.hatchStroke, light: DATA_COLOURS.hatchLight };
// Path data of the SVG pattern tile: lines x - y = kP + offset, k = -1..1, which
// cover the P×P tile and meet across its edges.
function windHatchLines(offset) {
    const P = WIND_HATCH.period;
    let d = '';
    for (let k = -1; k <= 1; k++) d += `M${k * P + offset},0L${k * P + offset + P},${P}`;
    return d;
}
// Per-cell hatch flags, 1 where `hatch(row)` is true; null when no cell is hatched.
function hatchFlags(rows, hatch) {
    if (typeof hatch !== 'function') return null;
    let flags = null;
    for (let i = 0; i < rows.length; i++) {
        if (hatch(rows[i])) { if (!flags) flags = new Uint8Array(rows.length); flags[i] = 1; }
    }
    return flags;
}
function sameFlags(a, b) {
    if (!a || !b) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
// A hatch that appears or goes with no colour change still needs a new frame.
function withHatchChange(change, prev, next) {
    return change === 'same' && !sameFlags(prev, next) ? 'fade' : change;
}

export function createVoronoiCanvasLayer(map, d3, L, deps) {
    // deps: { getColor, fireMarkerEvent, getRowKey }
    const paneName = 'voronoiCanvas-' + (map._leaflet_id || 'main');
    const pane = map.createPane(paneName);
    pane.style.zIndex = '405';
    pane.style.pointerEvents = 'none';

    const base = L.DomUtil.create('canvas', 'leaflet-voronoi-canvas', pane);
    const still = L.DomUtil.create('canvas', 'leaflet-voronoi-canvas', pane);
    const hover = L.DomUtil.create('canvas', 'leaflet-voronoi-canvas', pane);
    for (const c of [base, still, hover]) { c.style.position = 'absolute'; c.style.pointerEvents = 'none'; }
    still.style.visibility = 'hidden';
    const bctx = base.getContext('2d');
    const hctx = hover.getContext('2d');

    function parseRGBA(str) {
        if (str === NA_FILL) return null;
        const c = d3.color(str);
        if (!c) return null;
        const rgb = c.rgb();
        return [rgb.r, rgb.g, rgb.b, (c.opacity == null ? 1 : c.opacity)];
    }
    function rgbaStr(a) { return 'rgba(' + (a[0] | 0) + ',' + (a[1] | 0) + ',' + (a[2] | 0) + ',' + a[3] + ')'; }

    // ---- geometry / state ----
    let delaunay = null, voronoi = null;
    let rows = [];
    let landPath = null;
    const landPathCache = new Map(); // `${zoom}|${pixelOrigin}` → land Path2D in layer coords
    let landPathWorld = null;        // the GeoJSON those paths were built from
    let mode = 'single';
    let indexByKey = new Map();
    const fillState = createFillState();
    let cellMeta = [];         // {fillOpacity, stroke, weight, na} per cell (single mode)
    let cellHatch = null;      // wind-hatch flags per cell (single mode), see WIND_HATCH
    const baseState = createFillState();
    const overlayState = createFillState();
    let baseOpacity = 0.5, overlayOpacity = 0.5, baseStroke = 'rgba(255,255,255,0.08)';
    let hasBase = false, hasOverlay = false;

    // Cross-fade: fadeFrom is the frame on screen when the new colours arrived, fadeTo
    // the new frame; each animation frame blends the two instead of redrawing cells.
    let crossfading = false, crossStart = 0;
    const crossDur = 900;
    let fadeFrom = null, fadeTo = null;
    let rafId = null;
    let hoveredIndex = -1, externIndex = -1;
    let markerIndex = -1;  // row whose marker events last fired mouseover (see hitTest)
    let curHandlers = null;
    let visible = false;
    let geomKey = null;
    let baseBlank = true;        // the base canvas holds no frame (new, or just resized)
    let lastWorld = null; // cached worldGeoJSON, so a view change can re-project
    let origin = { x: 0, y: 0 }; // layer point under the canvas's top-left corner
    let drawnView = null;        // the view the base bitmap was last drawn for
    let refreshPending = false;

    // chart highlight (dim non-matching)
    const hi = { set: null, factor: 0, target: 0, start: 0, dur: 100, fromFactor: 0 };

    // No-data diagonal hatch (matches the SVG na-hatch pattern), built once. Its tiles
    // stay anchored to the canvas corner, as when cells were drawn in container space.
    let naPattern = null, naPatternOrigin = null;
    function getNaPattern() {
        if (!naPattern) {
            const p = document.createElement('canvas'); p.width = 6; p.height = 6;
            const pc = p.getContext('2d');
            pc.fillStyle = DATA_COLOURS.hatchFill; pc.fillRect(0, 0, 6, 6);
            pc.strokeStyle = DATA_COLOURS.hatchLine; pc.lineWidth = 1.5;
            pc.beginPath(); pc.moveTo(-1, 5); pc.lineTo(5, -1); pc.moveTo(1, 7); pc.lineTo(7, 1); pc.stroke();
            naPattern = bctx.createPattern(p, 'repeat');
        }
        if (naPatternOrigin !== origin) {
            naPattern.setTransform(new DOMMatrix([1, 0, 0, 1, origin.x, origin.y]));
            naPatternOrigin = origin;
        }
        return naPattern;
    }
    // Wind-not-viable hatch lines of cell i: the lines x - y = kP (dark) and
    // x - y = kP + shift (light) in layer coordinates, cut to the cell's convex
    // polygon, so they are the lines of the SVG pattern. Stroking only the lines
    // rasterises far fewer pixels than a pattern fill of the whole cell (about a
    // fifth of the extra cost at 4x CPU). Cached per Voronoi, built on first use.
    let hatchVoronoi = null, hatchPaths = [];
    const cellPts = []; let cellN = 0;
    const cellRecorder = {
        moveTo(x, y) { cellPts[cellN++] = x; cellPts[cellN++] = y; },
        lineTo(x, y) { cellPts[cellN++] = x; cellPts[cellN++] = y; },
        closePath() {},
    };
    function hatchLinesInto(path, offset, cmin, cmax) {
        const P = WIND_HATCH.period;
        for (let c = Math.ceil((cmin - offset) / P) * P + offset; c <= cmax; c += P) {
            // A convex polygon crosses the line twice: at the edges whose ends lie on
            // either side of it.
            let found = false, x0 = 0, y0 = 0;
            for (let k = 0; k < cellN; k += 2) {
                const ax = cellPts[k], ay = cellPts[k + 1], bx = cellPts[k + 2], by = cellPts[k + 3];
                const fa = ax - ay - c, fb = bx - by - c;
                if ((fa <= 0) === (fb <= 0)) continue;
                const t = fa / (fa - fb), x = ax + t * (bx - ax), y = ay + t * (by - ay);
                if (!found) { x0 = x; y0 = y; found = true; } else { path.moveTo(x0, y0); path.lineTo(x, y); break; }
            }
        }
    }
    function cellHatchPaths(vor, i) {
        if (vor !== hatchVoronoi) { hatchVoronoi = vor; hatchPaths = []; }
        let hp = hatchPaths[i];
        if (!hp) {
            hp = hatchPaths[i] = { dark: new Path2D(), light: new Path2D() };
            cellN = 0;
            vor.renderCell(i, cellRecorder);
            if (cellN >= 6) {
                cellPts[cellN] = cellPts[0]; cellPts[cellN + 1] = cellPts[1]; // close the ring
                let cmin = Infinity, cmax = -Infinity;
                for (let k = 0; k < cellN; k += 2) { const v = cellPts[k] - cellPts[k + 1]; if (v < cmin) cmin = v; if (v > cmax) cmax = v; }
                hatchLinesInto(hp.dark, 0, cmin, cmax);
                hatchLinesInto(hp.light, WIND_HATCH.shift, cmin, cmax);
            }
        }
        return hp;
    }

    function size() {
        const s = map.getSize();
        const ratio = dpr();
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        if (base.width !== s.x * ratio || base.height !== s.y * ratio || !origin || origin.x !== topLeft.x || origin.y !== topLeft.y) touchBase();
        if (base.width !== s.x * ratio || base.height !== s.y * ratio) {
            baseBlank = true;
            base.width = s.x * ratio; base.height = s.y * ratio;
            base.style.width = s.x + 'px'; base.style.height = s.y + 'px';
        }
        L.DomUtil.setPosition(base, topLeft);
        if (!origin || origin.x !== topLeft.x || origin.y !== topLeft.y) origin = topLeft;
        // Geometry is in layer coordinates: shift it so `origin` lands on the canvas corner.
        // (The hover canvas is sized and placed by drawHover.)
        bctx.setTransform(ratio, 0, 0, ratio, -origin.x * ratio, -origin.y * ratio);
        return s;
    }

    function clearCanvas(ctx, canvas) {
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
    }

    function resolveStyle(row, fillAccessor) {
        const style = fillAccessor ? fillAccessor(row) : null; // mirror applyCellStyle()
        if (style && typeof style === 'object') {
            return { fill: style.fillColor || style.color, fillOpacity: Number.isFinite(style.fillOpacity) ? style.fillOpacity : 0.6, stroke: style.color || 'rgba(255,255,255,0.08)', weight: Number.isFinite(style.weight) ? style.weight : 0.5, na: (style.fillColor || style.color) === NA_FILL };
        }
        const fill = style || deps.getColor(row.annual_cf);
        // No data and target not met are drawn solid (T062): at 0.6 over the land the
        // black would sit too close to the darkest ramp steps (applyCellStyle in map.js too).
        return { fill, fillOpacity: fill === DATA_COLOURS.noData ? 1 : 0.6, stroke: 'rgba(255,255,255,0.08)', weight: 0.5, na: fill === NA_FILL };
    }

    // The land path only depends on the projection (zoom + pixel origin), so it is
    // projected once per zoom and reused across pans, recolours and new point sets.
    function landPathFor(worldGeoJSON) {
        if (!worldGeoJSON) return null;
        if (worldGeoJSON !== landPathWorld || landPathCache.size > 8) { landPathCache.clear(); landPathWorld = worldGeoJSON; }
        const po = map.getPixelOrigin();
        const key = `${map.getZoom()}|${po.x},${po.y}`;
        let p2d = landPathCache.get(key);
        if (!p2d) {
            const transform = d3.geoTransform({ point(x, y) { const p = map.latLngToLayerPoint(new L.LatLng(y, x)); this.stream.point(p.x, p.y); } });
            p2d = new Path2D();
            d3.geoPath(transform, p2d)(worldGeoJSON);
            landPathCache.set(key, p2d);
        }
        return p2d;
    }

    // The key only samples the point set, so a reuse also checks every site.
    let geomSites = null;
    function sameSites() {
        if (!geomSites || geomSites.length !== 2 * rows.length) return false;
        for (let i = 0; i < rows.length; i++) {
            if (geomSites[2 * i] !== +rows[i].latitude || geomSites[2 * i + 1] !== +rows[i].longitude) return false;
        }
        return true;
    }

    function ensureGeometry(s, worldGeoJSON) {
        landPath = landPathFor(worldGeoJSON);
        // Cells are in LAYER coordinates, which only change with the zoom or the pixel
        // origin. A drag just translates the map pane, so it is a cache hit: size()
        // re-pins the canvas and the draw is translated, with no Delaunay rebuild.
        const po = map.getPixelOrigin();
        const key = `${map.getZoom()}|${po.x},${po.y}|${rows.length}|${rows[0]?.location_id ?? ''}|${rows[rows.length - 1]?.location_id ?? ''}`;
        if (key === geomKey && voronoi && sameSites()) return false;
        const pts = new Array(rows.length);
        geomSites = new Float64Array(2 * rows.length);
        for (let i = 0; i < rows.length; i++) {
            const p = map.latLngToLayerPoint([rows[i].latitude, rows[i].longitude]);
            pts[i] = [p.x, p.y];
            geomSites[2 * i] = rows[i].latitude; geomSites[2 * i + 1] = rows[i].longitude;
        }
        delaunay = d3.Delaunay.from(pts);
        // Bounds: the viewport plus a buffer (as before), widened to the whole projected
        // world so a later pan never exposes a bounds edge inside the land.
        const buf = Math.max(s.x, s.y);
        let x0 = origin.x - buf, y0 = origin.y - buf, x1 = origin.x + s.x + buf, y1 = origin.y + s.y + buf;
        const wb = map.getPixelWorldBounds();
        if (wb) {
            x0 = Math.min(x0, wb.min.x - po.x - 1); y0 = Math.min(y0, wb.min.y - po.y - 1);
            x1 = Math.max(x1, wb.max.x - po.x + 1); y1 = Math.max(y1, wb.max.y - po.y + 1);
        }
        voronoi = delaunay.voronoi([x0, y0, x1, y1]);
        indexByKey = new Map();
        if (deps.getRowKey) { for (let i = 0; i < rows.length; i++) { const k = deps.getRowKey(rows[i]); if (k != null) indexByKey.set(k, i); } }
        geomKey = key;
        return true;
    }

    function currentView() { return { geomKey, x: origin.x, y: origin.y, w: base.width, h: base.height, landPath }; }
    function viewIsDrawn() {
        const v = drawnView;
        return !!v && v.geomKey === geomKey && v.x === origin.x && v.y === origin.y && v.w === base.width && v.h === base.height && v.landPath === landPath;
    }

    // What a frame is drawn from. A chunked frame (see "chunked frames") keeps the
    // snapshot it started with, so later renders cannot mix into it.
    function sceneState() {
        const layers = mode === 'dual'
            ? [hasBase && { disp: baseState.displayed, opacity: baseOpacity, stroke: baseStroke, weight: 0.5 },
                hasOverlay && { disp: overlayState.displayed, opacity: overlayOpacity, stroke: 'none', weight: 0 }].filter(Boolean)
            : [{ disp: fillState.displayed, opacity: null, stroke: null, weight: null, hatch: cellHatch }];
        return { voronoi, landPath, geomKey, mode, cellMeta, n: rows.length, layers };
    }

    function fillCells(ctx, st, layer, from, to) {
        const disp = layer.disp, cellMeta = st.cellMeta, voronoi = st.voronoi;
        const opacity = layer.opacity, stroke = layer.stroke, weight = layer.weight, hatch = layer.hatch;
        const hiOn = hi.factor > 0 && hi.set;
        for (let i = from; i < to; i++) {
            const df = disp[i];
            const meta = cellMeta[i];
            const na = st.mode === 'single' && meta && meta.na;
            if (df == null && !na) continue;
            let op = opacity != null ? opacity : (meta ? meta.fillOpacity : 0.6);
            let w = weight != null ? weight : (meta ? meta.weight : 0);
            let strk = stroke != null ? stroke : (meta ? meta.stroke : 'rgba(255,255,255,0.08)');
            // chart highlight: dim non-matching
            if (hiOn) {
                const match = hi.set.has(i); const f = hi.factor;
                op = lerp(op, match ? 0.95 : 0.05, f);
                if (match) { strk = '#ffffff'; w = lerp(w, 1, f); } else { w = lerp(w, 0, f); }
            }
            ctx.beginPath();
            voronoi.renderCell(i, ctx);
            ctx.globalAlpha = op;
            ctx.fillStyle = na ? getNaPattern() : rgbaStr(df);
            ctx.fill();
            // Wind-not-viable hatch over the colour, at the cell's opacity.
            if (hatch && hatch[i]) {
                const hp = cellHatchPaths(voronoi, i);
                ctx.lineWidth = WIND_HATCH.width;
                ctx.globalAlpha = op * WIND_HATCH.alpha;
                ctx.strokeStyle = WIND_HATCH.stroke; ctx.stroke(hp.dark);
                ctx.strokeStyle = WIND_HATCH.light; ctx.stroke(hp.light);
            }
            ctx.globalAlpha = 1;
            if (w > 0 && strk !== 'none') { ctx.lineWidth = w; ctx.strokeStyle = strk; ctx.stroke(); }
        }
    }

    // Draws entries [from, to) of the scene: each layer's cells in row order, layer
    // after layer. A whole scene is one call; a chunked frame makes several, each
    // in the same order, which gives the same pixels.
    // LAND: cells are drawn unclipped and the frame is masked to the land once, when
    // its last entry is drawn. Clipping every cell to the ~26k-vertex coastline
    // cost about 3-4x more raster. The mask changes only anti-aliasing: on the
    // coastline, and by a few levels on cell edges, which Skia rasterises slightly
    // differently when no complex clip is set (see team/handoffs/T020.md).
    function drawScene(ctx, canvas, st = sceneState(), from = 0, to = Infinity) {
        if (from === 0) clearCanvas(ctx, canvas);
        if (!st.voronoi) return;
        ctx.save();
        ctx.lineJoin = 'round';
        st.layers.forEach((layer, k) => {
            const a = Math.max(from - k * st.n, 0), b = Math.min(to - k * st.n, st.n);
            if (a < b) fillCells(ctx, st, layer, a, b);
        });
        if (st.landPath && to >= st.layers.length * st.n) {
            ctx.globalCompositeOperation = 'destination-in';
            ctx.globalAlpha = 1; ctx.fillStyle = '#000';
            ctx.fill(st.landPath);
        }
        ctx.restore();
    }

    // ---- frames ----
    // At world zooms the whole projected world fits a modest canvas, so the scene is
    // drawn once into a world-sized frame and the visible canvas only blits it: a pan
    // costs one drawImage instead of re-rasterising ~5,000 cells. Before the
    // land path exists, at large zooms, or when the blit would not land on whole
    // device pixels, cells are drawn straight onto the visible canvas instead.
    // A frame is { c, x0, y0, world }: a canvas and the layer point at its corner.
    const WORLD_FRAME_MAX = 4096; // device px per side
    let scene = null;             // world frame the base canvas currently shows
    let fadeE = 0;

    function worldRect() {
        if (!landPath) return null;
        const wb = map.getPixelWorldBounds();
        if (!wb) return null;
        const ratio = dpr(), po = map.getPixelOrigin();
        // Whole pixels: the projected world bounds carry float noise (e.g. 1e-13).
        const x0 = Math.floor(wb.min.x) - po.x, y0 = Math.floor(wb.min.y) - po.y;
        const w = Math.ceil((Math.ceil(wb.max.x) - po.x - x0) * ratio), h = Math.ceil((Math.ceil(wb.max.y) - po.y - y0) * ratio);
        if (w > WORLD_FRAME_MAX || h > WORLD_FRAME_MAX) return null;
        if (!Number.isInteger((x0 - origin.x) * ratio) || !Number.isInteger((y0 - origin.y) * ratio)) return null;
        return { x0, y0, w, h, ratio };
    }
    function freeFrame(f) { if (f) { f.c.width = 0; f.c.height = 0; } return null; }
    // Draw the current state into a frame, reusing `prev`'s canvas when it fits.
    function renderFrame(prev) {
        const r = worldRect();
        const w = r ? r.w : base.width, h = r ? r.h : base.height;
        let c;
        if (prev && prev.c.width === w && prev.c.height === h) c = prev.c;
        else { freeFrame(prev); c = document.createElement('canvas'); c.width = w; c.height = h; }
        const ctx = c.getContext('2d');
        if (r) ctx.setTransform(r.ratio, 0, 0, r.ratio, -r.x0 * r.ratio, -r.y0 * r.ratio);
        else ctx.setTransform(bctx.getTransform());
        drawScene(ctx, c);
        return r ? { c, x0: r.x0, y0: r.y0, world: true, geomKey, landPath } : { c, x0: origin.x, y0: origin.y, world: false };
    }
    function blit(f, alpha, op) {
        const ratio = dpr();
        bctx.save(); bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.globalAlpha = alpha; bctx.globalCompositeOperation = op;
        bctx.drawImage(f.c, Math.round((f.x0 - origin.x) * ratio), Math.round((f.y0 - origin.y) * ratio));
        bctx.restore();
    }
    function showFrame(f) { touchBase(); clearCanvas(bctx, base); blit(f, 1, 'source-over'); baseBlank = false; }
    function sceneFits() {
        if (!scene || scene.geomKey !== geomKey || scene.landPath !== landPath) return false;
        const r = worldRect();
        return !!r && r.x0 === scene.x0 && r.y0 === scene.y0 && r.w === scene.c.width && r.h === scene.c.height;
    }

    // Draws the current state at once. That puts the newest pending request on
    // screen, so any chunked frame still in progress is dropped and that request's
    // onDrawn fires.
    function draw() {
        touchBase();
        const onDrawn = settleJobs();
        if (worldRect()) { scene = renderFrame(scene); showFrame(scene); }
        else { scene = freeFrame(scene); drawScene(bctx, base); baseBlank = false; }
        drawnView = currentView();
        if (onDrawn) onDrawn();
    }

    // ---- cross-fade between two pre-drawn frames ----
    // `to` is a frame already drawn for the new colours (a chunked frame); without
    // it the new frame is drawn here.
    function beginFade(to) {
        let from;
        if (!crossfading && sceneFits()) { from = scene; scene = null; }
        else {
            // Mid-fade (or no world frame): start from exactly what is on screen.
            const c = document.createElement('canvas'); c.width = base.width; c.height = base.height;
            const ctx = c.getContext('2d'); ctx.globalCompositeOperation = 'copy'; ctx.drawImage(base, 0, 0);
            from = { c, x0: origin.x, y0: origin.y, world: false };
        }
        dropFade();
        fadeFrom = from;
        fadeTo = to || renderFrame(null);
        crossStart = performance.now(); crossfading = true; fadeE = 0;
        startAnim();
    }
    // 'lighter' adds the two weighted frames, an exact per-pixel mix of old and new.
    function blendFade(e) {
        touchBase();
        fadeE = e;
        clearCanvas(bctx, base);
        blit(fadeFrom, 1 - e, 'source-over');
        blit(fadeTo, e, 'lighter');
    }
    function finishFade() {
        showFrame(fadeTo);
        freeFrame(scene);
        scene = fadeTo.world ? fadeTo : null;
        if (scene) fadeTo = null;
        dropFade();
    }
    function dropFade() {
        crossfading = false;
        // Zero-size the buffers so their backing stores are freed between fades.
        fadeFrom = freeFrame(fadeFrom);
        fadeTo = freeFrame(fadeTo);
    }
    // After new fills are set: cross-fade from the frame on screen, keep an in-flight
    // fade heading for the same colours, or show the new frame straight away. `to`
    // is the new frame if it is already drawn (a chunked frame).
    function presentNow(change, allowFade, to) {
        if (allowFade && visible && viewIsDrawn() && !prefersReducedMotion()) {
            if (change === 'fade') { lastShown = performance.now(); beginFade(to); return; }
            if (change === 'same' && crossfading) { if (to) { freeFrame(fadeTo); fadeTo = to; } else fadeTo = renderFrame(fadeTo); return; }
        }
        lastShown = performance.now();
        dropFade();
        if (!to) { draw(); return; }
        freeFrame(scene); scene = to;
        showFrame(scene);
        drawnView = { ...currentView(), geomKey: to.geomKey, landPath: to.landPath };
    }

    // ---- chunked frames ----
    // Rasterising a whole frame of ~5,000 cells takes about 0.25-0.3 s at 4x CPU
    // throttle (with the old per-cell coastline clip it was 0.4-0.5 s), all in the
    // task that first blits the frame or at the end of the task that drew it. So a
    // large scene is drawn into an off-screen world frame CHUNK_CELLS cells per
    // animation frame instead, each chunk rasterised in its own task. Chunks keep
    // the row order and the land mask comes after the last one, which gives the
    // same pixels as one pass. Two chunks for the ~5,000-cell grid keep each task
    // well under the freeze budget without delaying the result by more frames.
    // The frame on screen stays until the new one is complete, then
    // the new one is presented as it would have been at once (cross-fade or swap),
    // so a partly drawn map is never shown. A render that arrives meanwhile replaces
    // the frame in progress, unless the screen has not changed for STALE_MS: then
    // it waits for that frame (only the newest waits), so a long slider sweep still
    // shows complete frames as it goes.
    const CHUNK_CELLS = 2500;
    const STALE_MS = 1000;
    let lastShown = 0;   // when new colours last reached the base canvas
    let job = null;      // { st, f, next, total, change, allowFade, onDrawn, raf }
    let queued = null;   // newest request waiting for `job`: { change, allowFade, onDrawn }
    let shownUntilHidden = false; // hidden in this task, still holding the frame it showed

    // How the new colours relate to the screen when an unshown request is replaced.
    function mergeChange(a, b) { return (a === 'snap' || b === 'snap') ? 'snap' : (a === 'fade' || b === 'fade') ? 'fade' : 'same'; }

    function canChunk() {
        return (visible || shownUntilHidden) && !baseBlank && hi.factor === 0 && hi.target === 0
            && sceneSize() > CHUNK_CELLS && !!worldRect();
    }
    function sceneSize() { return rows.length * (mode === 'dual' ? (hasBase ? 1 : 0) + (hasOverlay ? 1 : 0) : 1); }

    function present(change, allowFade, onDrawn, chunked) {
        allowFade = allowFade && visible; // a render after hide() swaps in, as it did at once
        // The previous request never reached the screen: the new one replaces it,
        // and its change is measured from what is on screen.
        if (queued) { change = mergeChange(queued.change, change); allowFade = allowFade && queued.allowFade; queued = null; }
        if (chunked && canChunk()) {
            const req = { change, allowFade, onDrawn };
            if (job && job.next > 0 && performance.now() - lastShown > STALE_MS) queued = req;
            else {
                if (job) { req.change = mergeChange(job.change, change); req.allowFade = allowFade && job.allowFade; dropJob(); }
                startJob(req);
            }
            return;
        }
        if (job) { change = mergeChange(job.change, change); allowFade = allowFade && job.allowFade; dropJob(); }
        presentNow(change, allowFade);
        if (onDrawn) onDrawn();
    }

    function startJob(req) {
        const r = worldRect(), st = sceneState();
        const c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
        c.getContext('2d').setTransform(r.ratio, 0, 0, r.ratio, -r.x0 * r.ratio, -r.y0 * r.ratio);
        job = { ...req, st, next: 0, total: st.layers.length * st.n, raf: requestAnimationFrame(stepJob),
            f: { c, x0: r.x0, y0: r.y0, world: true, geomKey: st.geomKey, landPath: st.landPath } };
    }
    function stepJob() {
        const j = job;
        j.raf = null;
        const end = Math.min(j.total, j.next + CHUNK_CELLS);
        drawScene(j.f.c.getContext('2d'), j.f.c, j.st, j.next, end);
        j.next = end;
        if (end < j.total) { j.raf = requestAnimationFrame(stepJob); return; }
        job = null;
        const r = worldRect();
        if (!r || r.x0 !== j.f.x0 || r.y0 !== j.f.y0 || r.w !== j.f.c.width || r.h !== j.f.c.height) {
            // The projection moved under the frame: draw the newest state at once.
            freeFrame(j.f);
            if (!queued) queued = j;
            draw();
            drawHover();
            return;
        }
        presentNow(j.change, j.allowFade, j.f);
        if (j.onDrawn) j.onDrawn();
        if (queued) { const q = queued; queued = null; startJob(q); }
    }
    function dropJob() {
        if (!job) return;
        if (job.raf != null) cancelAnimationFrame(job.raf);
        freeFrame(job.f);
        job = null;
    }
    // Drops every pending request; returns the newest one's onDrawn, which a caller
    // that then draws the current state should call.
    function settleJobs() {
        const req = queued || job;
        queued = null;
        dropJob();
        return req ? req.onDrawn : null;
    }

    function anyAnimating() { return crossfading || hi.factor !== hi.target; }
    function tick() {
        rafId = null;
        const now = performance.now();
        // cross-fade
        if (crossfading) {
            const t = clamp01((now - crossStart) / crossDur);
            if (t >= 1) finishFade();
            else blendFade(cssEase(t));
        }
        let redraw = false;
        // highlight factor
        if (hi.factor !== hi.target) {
            redraw = true;
            const t = clamp01((now - hi.start) / hi.dur);
            hi.factor = lerp(hi.fromFactor, hi.target, t);
            if (t >= 1) { hi.factor = hi.target; if (hi.target === 0) hi.set = null; }
        }
        if (redraw) draw();
        if (anyAnimating()) rafId = requestAnimationFrame(tick);
    }
    function startAnim() { if (rafId == null) rafId = requestAnimationFrame(tick); }
    function stopAnim() { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } dropFade(); }

    // Hover rim(s): the hovered cell's outline, and the cell highlighted from the
    // other map, stroked under the land clip. Skia builds the clip's coverage mask
    // over the whole clip area, and the land path spans the map, so on a map-sized
    // canvas that mask was most of the hover cost: 28-43 ms of raster per hovered
    // cell at 4x CPU (T027, T037). So the hover canvas is only a band of whole
    // device rows: the map's full width, from RIM_BAND css px above the rims to
    // RIM_BAND below. Its left and right are the map's, so land edges are cut only
    // at the band's top and bottom; that changes the rim's anti-aliasing on a few
    // pixels of under 1% of cells (team/handoffs/T037.md). A small canvas also
    // costs less to re-produce, which happens on every frame for every visible 2D
    // canvas here, and an empty one is hidden.
    // Where the device pixel ratio is not a whole number, a band would not start on
    // a whole css pixel, so the canvas stays map-sized and the band is a clip.
    const RIM_BAND = 32;
    let hoverShown = true; // the hover canvas is not hidden by drawHover (it starts empty)
    function rimRows(idx, band) {
        if (idx < 0 || idx >= rows.length) return band;
        cellN = 0;
        voronoi.renderCell(idx, cellRecorder);
        for (let k = 1; k < cellN; k += 2) { const y = cellPts[k]; if (y < band.y0) band.y0 = y; if (y > band.y1) band.y1 = y; }
        return band;
    }
    function drawHover() {
        const ratio = dpr(), w = base.width, h = base.height;
        let top = 0, bottom = 0;
        if (voronoi) {
            const band = rimRows(externIndex, rimRows(hoveredIndex, { y0: Infinity, y1: -Infinity }));
            if (band.y0 <= band.y1) {
                top = Math.max(0, Math.floor((band.y0 - origin.y - RIM_BAND) * ratio));
                bottom = Math.min(h, Math.ceil((band.y1 - origin.y + RIM_BAND) * ratio));
            }
        }
        const has = bottom > top;
        if (!has) {
            if (hoverShown) { clearCanvas(hctx, hover); hoverShown = false; hover.style.visibility = 'hidden'; }
            return;
        }
        const whole = Number.isInteger(ratio);
        // The canvas spans whole css pixels: with a whole ratio, rows top..bottom
        // rounded out to multiples of it.
        const y0 = whole ? Math.floor(top / ratio) * ratio : 0, y1 = whole ? Math.min(h, Math.ceil(bottom / ratio) * ratio) : h;
        if (hover.width !== w || hover.height !== y1 - y0) {
            hover.width = w; hover.height = y1 - y0;
            hover.style.width = (w / ratio) + 'px'; hover.style.height = ((y1 - y0) / ratio) + 'px';
        } else clearCanvas(hctx, hover);
        L.DomUtil.setPosition(hover, L.point(origin.x, origin.y + y0 / ratio));
        if (!hoverShown) { hoverShown = true; hover.style.visibility = ''; }
        const rim = (idx) => { if (idx < 0 || idx >= rows.length) return; hctx.beginPath(); voronoi.renderCell(idx, hctx); hctx.stroke(); };
        hctx.save();
        if (landPath && !whole) { hctx.setTransform(1, 0, 0, 1, 0, 0); hctx.beginPath(); hctx.rect(0, top, w, bottom - top); hctx.clip(); }
        hctx.setTransform(ratio, 0, 0, ratio, -origin.x * ratio, -origin.y * ratio - y0);
        if (landPath) hctx.clip(landPath);
        hctx.lineJoin = 'round'; hctx.lineWidth = 1.2; hctx.strokeStyle = '#ffffff'; hctx.globalAlpha = 1;
        rim(hoveredIndex);
        if (externIndex !== hoveredIndex) rim(externIndex);
        hctx.restore();
    }

    // ---- static base frame on a bitmaprenderer canvas ----
    // Here every visible 2D canvas is re-produced (copied) on every frame Chrome
    // commits, changed or not: ~4 ms per frame at 4x for the map-sized base
    // canvas, and up to ~40 ms under CPU load, in every hover frame (T037). Once
    // the base canvas has been still for FREEZE_MS, a snapshot of it is shown on
    // the 'bitmaprenderer' canvas `still`, which costs almost nothing per frame,
    // and the 2D canvas is hidden (a hidden canvas is not re-produced). The
    // snapshot shares the 2D canvas's pixels, so this holds no second buffer.
    // Anything that changes the base canvas first shows it again (touchBase), so
    // fades, highlights and redraws run exactly as before; the first change after
    // a snapshot copies the pixels once (copy-on-write).
    const FREEZE_MS = 300;
    const stillView = still.getContext('bitmaprenderer');
    let frozen = false, baseRev = 0, freezeTimer = null;
    function touchBase() {
        baseRev++;
        if (frozen) {
            frozen = false;
            base.style.visibility = '';
            still.style.visibility = 'hidden';
            stillView.transferFromImageBitmap(null);
        }
        if (snapshotInTask && freezeTimer == null) freezeTimer = setTimeout(freeze, FREEZE_MS);
    }
    function canFreeze() { return visible && !frozen && !baseBlank && !anyAnimating() && base.width > 0 && base.height > 0; }
    let freezeSeen = -1;
    function freeze() {
        freezeTimer = null;
        // Changed since the timer was set: wait until it has been still for FREEZE_MS.
        if (baseRev !== freezeSeen) { freezeSeen = baseRev; freezeTimer = setTimeout(freeze, FREEZE_MS); return; }
        if (!canFreeze()) return;
        const rev = baseRev;
        createImageBitmap(base).then(bm => {
            if (rev !== baseRev || !canFreeze()) { bm.close(); return; }
            L.DomUtil.setPosition(still, origin);
            still.style.width = base.style.width; still.style.height = base.style.height;
            stillView.transferFromImageBitmap(bm);
            still.style.visibility = '';
            base.style.visibility = 'hidden';
            frozen = true;
        }, () => {});
    }

    function show() { if (!visible) { base.style.display = ''; still.style.display = ''; hover.style.display = ''; visible = true; } }
    function hide() {
        flushMove();
        // A mode switch hides the layer and renders the new view in the same task, so
        // nothing is painted in between: until then the canvas still holds the last
        // frame the user saw, which can stay up (and pan, as `scene`) while a chunked
        // frame is drawn. If the layer stays hidden, the frame is freed after the task.
        if (visible && drawnView && !shownUntilHidden) {
            shownUntilHidden = true;
            queueMicrotask(() => { shownUntilHidden = false; if (!visible) scene = freeFrame(scene); });
        }
        if (visible) { base.style.display = 'none'; still.style.display = 'none'; hover.style.display = 'none'; visible = false; }
        touchBase(); // drop the snapshot, if any
        settleJobs();
        stopAnim();
        hi.set = null; hi.factor = 0; hi.target = 0;
        // The geometry is kept: the next view usually has the same sites (capacity and
        // cost views do), and ensureGeometry checks every site before reusing it.
        drawnView = null; hoveredIndex = -1; externIndex = -1; markerIndex = -1;
        if (!shownUntilHidden) scene = freeFrame(scene);
        setCursor(false);
    }
    function isActive() { return visible && rows.length > 0; }

    function render(data, fillAccessor, worldGeoJSON, handlers, opts) {
        flushMove();
        opts = opts || {};
        curHandlers = handlers;
        mode = 'single';
        rows = data;
        lastWorld = worldGeoJSON;
        const s = size();
        const geometryChanged = ensureGeometry(s, worldGeoJSON);
        cellMeta = rows.map((r) => resolveStyle(r, fillAccessor));
        const target = cellMeta.map((st) => (st && st.fill != null) ? parseRGBA(st.fill) : null);
        const hatch = hatchFlags(rows, opts.hatch);
        const change = withHatchChange(fillState.setTarget(target), cellHatch, hatch);
        cellHatch = hatch;
        // onDrawn gets the rows coloured here and, if asked for (?debug), a snapshot of
        // them taken now, while their colours are fixed, not when the frame lands.
        const drawnRows = rows, snap = opts.onDrawn && opts.snapshot ? opts.snapshot(rows) : undefined;
        present(change, !geometryChanged && !opts.instant, opts.onDrawn && (() => opts.onDrawn(drawnRows, snap)), true);
        show();
        if (hoveredIndex >= rows.length) hoveredIndex = -1;
        if (markerIndex >= rows.length) markerIndex = -1;
        if (externIndex >= rows.length) externIndex = -1;
        drawHover();
        if (anyAnimating()) startAnim();
    }

    function renderDual(data, baseFill, overlayFill, worldGeoJSON, handlers, opts) {
        flushMove();
        opts = opts || {};
        curHandlers = handlers;
        mode = 'dual';
        rows = data;
        lastWorld = worldGeoJSON;
        hasBase = typeof baseFill === 'function'; hasOverlay = typeof overlayFill === 'function';
        baseOpacity = hasOverlay ? 0.5 : 0.85; overlayOpacity = hasBase ? 0.5 : 0.35;
        const s = size();
        const geometryChanged = ensureGeometry(s, worldGeoJSON);
        cellMeta = []; // dual has no per-cell meta; opacities/strokes are layer-wide
        let change = 'same';
        const merge = (c) => { if (c === 'snap' || change === 'snap') change = 'snap'; else if (c === 'fade') change = 'fade'; };
        for (const [on, fill, st] of [[hasBase, baseFill, baseState], [hasOverlay, overlayFill, overlayState]]) {
            if (on) merge(st.setTarget(rows.map((d) => { const c = fill(d); return c == null ? null : parseRGBA(c); })));
            else { if (st.displayed.length) merge('snap'); st.reset(); }
        }
        present(change, !geometryChanged && !opts.instant, opts.onDrawn, true);
        show();
        if (hoveredIndex >= rows.length) hoveredIndex = -1;
        if (markerIndex >= rows.length) markerIndex = -1;
        if (externIndex >= rows.length) externIndex = -1;
        drawHover();
        if (anyAnimating()) startAnim();
    }

    function highlightKey(key) {
        flushMove();
        const idx = (key != null && indexByKey.has(key)) ? indexByKey.get(key) : -1;
        if (idx === externIndex) return;
        externIndex = idx; drawHover();
    }
    function clearHighlight() { flushMove(); if (externIndex === -1) return; externIndex = -1; drawHover(); }

    // Chart→map highlight: dim non-matching cells. Accepts an array of matching row
    // keys, a predicate fn(row)->bool, or null to clear.
    function setHighlightSet(keysOrFn) {
        flushMove();
        let set = null;
        if (typeof keysOrFn === 'function') {
            set = new Set();
            for (let i = 0; i < rows.length; i++) { if (keysOrFn(rows[i])) set.add(i); }
        } else if (keysOrFn) {
            set = new Set();
            for (const k of keysOrFn) { if (indexByKey.has(k)) set.add(indexByKey.get(k)); }
        }
        // The dim animates by redrawing cells, so finish any colour fade (or frame
        // still being drawn) first.
        if (crossfading || job || queued) { dropFade(); draw(); }
        hi.fromFactor = hi.factor; hi.start = performance.now();
        if (set) { hi.set = set; hi.target = 1; hi.dur = 100; }
        else { hi.target = 0; hi.dur = 200; }
        startAnim();
    }

    // Hit-test. `cell` is the drawn cell under the pointer (nearest site, inside the
    // land clip), or -1; it drives the hover rim and the view's onHover/onOut/onClick.
    // Views that used to put an invisible L.circleMarker of radius `hitRadius` on
    // every site also hit within that radius of the nearest site, even just off the
    // coast: `near` is true there (exactly where one of those circles was, as they
    // all had one radius) and sets the pointer cursor. Like those circles, a hit
    // that is only `near` fires the row's marker events (tooltip, selection) but
    // not the rim or the view callbacks. `target` is the row those marker events
    // follow: the cell, else the circle Leaflet would have picked. (On land the
    // cell wins: the old hit-test fired after Leaflet's, so its row was what stayed.)
    const hit = { cell: -1, target: -1, near: false };
    function hitTest(lp) {
        hit.cell = -1; hit.target = -1; hit.near = false;
        if (!delaunay) return hit;
        const idx = delaunay.find(lp.x, lp.y);
        if (idx == null || idx < 0) return hit;
        // Don't hover a cell that isn't drawn (e.g. non-subset cells with a null fill
        // in the subset/comparison map) — matches the SVG, which has no element there.
        if (mode === 'single' && fillState.displayed[idx] == null) return hit;
        const r = (curHandlers && curHandlers.hitRadius) || 0;
        if (r > 0) {
            const dx = delaunay.points[2 * idx] - lp.x, dy = delaunay.points[2 * idx + 1] - lp.y;
            hit.near = Math.sqrt(dx * dx + dy * dy) <= r;
        }
        let inLand = true;
        if (landPath) {
            bctx.save(); bctx.setTransform(1, 0, 0, 1, 0, 0);
            inLand = bctx.isPointInPath(landPath, lp.x, lp.y);
            bctx.restore();
        }
        if (inLand) hit.cell = idx;
        if (inLand) hit.target = idx;
        else if (hit.near) hit.target = topSiteWithin(idx, lp.x, lp.y, r);
        return hit;
    }
    // Leaflet gave a pointer inside several circles to the last one drawn, i.e. the
    // highest row index (circles were added in row order). Sites within r of the
    // pointer are found by walking Delaunay neighbours out from the nearest one.
    function topSiteWithin(idx, x, y, r) {
        const pts = delaunay.points, r2 = r * r;
        const within = (i) => { const dx = pts[2 * i] - x, dy = pts[2 * i + 1] - y; return dx * dx + dy * dy <= r2; };
        let best = idx;
        const seen = new Set([idx]), queue = [idx];
        while (queue.length) {
            const i = queue.pop();
            for (const j of delaunay.neighbors(i)) {
                if (seen.has(j)) continue;
                seen.add(j);
                if (!within(j)) continue;
                if (j > best && !(mode === 'single' && fillState.displayed[j] == null)) best = j;
                queue.push(j);
            }
        }
        return best;
    }
    function setHover(idx) { if (idx === hoveredIndex) return; hoveredIndex = idx; drawHover(); }

    // Pointer cursor over a hit target. The pointer is over the map container itself
    // (the panes don't take pointer events), whose `leaflet-grab` cursor beats the
    // `leaflet-interactive` class, so the cursor is set inline. It is dropped while
    // the map is dragged, so leaflet.css shows `grabbing` as it did over the markers.
    const cursorEl = map.getContainer();
    let cursorOn = false;
    function setCursor(on) {
        if (on && map.dragging && map.dragging.moving()) on = false;
        if (on === cursorOn) return;
        cursorOn = on;
        cursorEl.style.cursor = on ? 'pointer' : '';
    }
    map.on('dragstart', () => setCursor(false));

    // Move to a new hit: outs (marker, then view callback) before overs, as before.
    function moveTo(e, cell, target) {
        const h = curHandlers || {};
        const markers = !!h.useMarkerEvents, opts = h.options || null;
        if (!markers) target = cell;
        const prevCell = hoveredIndex, prevTarget = markerIndex;
        if (prevTarget !== target && prevTarget >= 0 && markers) deps.fireMarkerEvent(rows[prevTarget], 'mouseout');
        if (prevCell !== cell && prevCell >= 0 && opts && opts.onOut) opts.onOut(e, rows[prevCell]);
        markerIndex = target;
        setHover(cell);
        if (prevTarget !== target && target >= 0 && markers) deps.fireMarkerEvent(rows[target], 'mouseover');
        if (prevCell !== cell && cell >= 0 && opts && opts.onHover) opts.onHover(e, rows[cell]);
    }

    // Pointer moves are handled in a task of their own (T021). Chrome dispatches
    // mousemove at the start of a frame, so handling it there put the popup's DOM
    // update and forced layouts in the same main-thread task as the frame's style,
    // paint and canvas commit: 60-100 ms at 4x CPU. The listener only records the
    // event and where the pointer is in layer coordinates at that moment; the
    // hit-test, cursor, rim and marker/view callbacks run in a task posted right
    // after. Moves that arrive before it runs are coalesced and only the last is
    // handled, so tooltip, rim and cursor end as they would have. Everything else
    // that reads or changes the hover state (leave, click, pointer down, wheel,
    // render, hide, highlight, refresh) handles a pending move first, so the order
    // of events is kept.
    let pendingMove = null;   // { e, lp }
    const moveChannel = new MessageChannel();
    moveChannel.port1.onmessage = () => flushMove();
    function eventLayerPoint(e) { return map.containerPointToLayerPoint(map.mouseEventToContainerPoint(e)); }
    function onMove(e) {
        const queued = pendingMove !== null;
        pendingMove = { e, lp: eventLayerPoint(e) };
        if (!queued) moveChannel.port2.postMessage(0);
    }
    function flushMove() {
        const m = pendingMove;
        if (!m) return;
        pendingMove = null;
        handleMove(m.e, m.lp);
    }
    function handleMove(e, lp) {
        if (!visible || !curHandlers) { setCursor(false); return; }
        const h = curHandlers;
        if (!h.enableHoverSelect) { setCursor(false); return; }
        hitTest(lp);
        setCursor(hit.near);
        moveTo(e, hit.cell, hit.target);
    }
    function onLeave(e) {
        flushMove();
        setCursor(false);
        if (hoveredIndex < 0 && markerIndex < 0) return;
        moveTo(e, -1, -1);
    }
    function onClick(e) {
        flushMove();
        if (!visible || !curHandlers) return;
        const h = curHandlers;
        hitTest(eventLayerPoint(e));
        const markers = !!h.useMarkerEvents;
        const target = markers ? hit.target : hit.cell;
        if (target < 0) return;
        if (markers) deps.fireMarkerEvent(rows[target], 'click');
        if (hit.cell >= 0 && h.options && h.options.onClick) h.options.onClick(rows[hit.cell]);
    }

    // Keep the canvas on the basemap through every view change. Leaflet translates
    // the map pane during a drag, carrying the canvas with it; at the end the canvas
    // is re-pinned to the viewport and redrawn ONCE (next frame, so a zoomend +
    // moveend pair or a sync echo costs one draw). Geometry is only rebuilt when
    // the zoom or pixel origin moved. This does not depend on the app re-rendering on
    // moveend: a view or size change redraws the cells without a re-render.
    function refresh() {
        flushMove();
        refreshPending = false;
        if (!visible || !rows.length) return;
        const s = size();
        const rebuilt = ensureGeometry(s, lastWorld);
        if (!rebuilt && viewIsDrawn()) return;
        if (!rebuilt && worldRect()) {
            // Pan: re-place the pre-drawn world frame(s); no cell is redrawn.
            if (crossfading && fadeFrom.world && fadeTo.world) { blendFade(fadeE); drawnView = currentView(); drawHover(); return; }
            if (!crossfading && sceneFits()) { showFrame(scene); drawnView = currentView(); drawHover(); return; }
        }
        dropFade(); // otherwise a view change mid-fade lands on the new colours
        draw();
        drawHover();
    }
    function scheduleRefresh() {
        if (refreshPending) return;
        refreshPending = true;
        requestAnimationFrame(refresh);
    }
    map.on('moveend zoomend viewreset resize', scheduleRefresh);

    // Fast per-frame recolor (sample playback): same geometry + handlers, new data
    // (same ids/order) with new colours. No geometry rebuild, no handler change.
    function recolor(newData, fillAccessor, opts) {
        flushMove();
        opts = opts || {};
        if (mode !== 'single' || !voronoi || newData.length !== rows.length) return false;
        rows = newData;
        cellMeta = rows.map((r) => resolveStyle(r, fillAccessor));
        const target = cellMeta.map((st) => (st && st.fill != null) ? parseRGBA(st.fill) : null);
        const change = withHatchChange(fillState.setTarget(target), cellHatch, null);
        cellHatch = null; // sample frames are never hatched
        present(change, !opts.instant);
        return true;
    }

    const container = map.getContainer();
    container.addEventListener('mousemove', onMove);
    for (const t of ['mousedown', 'pointerdown', 'touchstart', 'wheel']) container.addEventListener(t, flushMove, { capture: true, passive: true });
    container.addEventListener('mouseleave', onLeave);
    map.on('click', (le) => onClick(le.originalEvent));

    return { render, renderDual, recolor, hide, show, isActive, highlightKey, clearHighlight, setHighlightSet, NA_FILL };
}

createVoronoiCanvasLayer.NA_FILL = NA_FILL;
createVoronoiCanvasLayer.WIND_HATCH = WIND_HATCH;
createVoronoiCanvasLayer.windHatchLines = windHatchLines;
