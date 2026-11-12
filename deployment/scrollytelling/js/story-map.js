// story-map.js – the scrollytelling map (story.html, T087). d3 only, no Leaflet.
//
// Why not the article's Leaflet map (map.js): a scrubbed transition must not redraw the map on every
// scroll frame. Here each map state is drawn ONCE into its own canvas, with the same per-cell colours as
// the old map (layers.js `fill(row)`, painted at 0.8 opacity over the land as map.js does) and the same
// land outline (data/world.geojson). Scrolling then only changes each canvas's CSS opacity (the colour
// cross-fade) and CSS transform (pan and zoom), which the compositor does without the main thread.
//
// Geometry: an Equal Earth projection fitted once ("world space": the world fitted to the stage's safe
// area at zoom 1). The cells are the same Voronoi cells as the atlas's (one per region, around its site),
// built in world space. A camera { k, x, y } maps world space to the screen: s = k * p + (x, y).
//
// A layer is one (state, group) pair. Group 'world' covers the world views; each other region of map.js
// VIEWS (now 'europe') has its own group, drawn at that region's zoom so the zoomed map is sharp. Each group is drawn at the largest zoom among its views
// and covers the union of what they show, so any of its views is a pure CSS transform of it.
import { VIEWS as MAP_VIEWS } from './map.js';

// map.js's views, plus the story's own: the northern hemisphere's mid and high latitudes (T087, section 2).
export const VIEWS = { ...MAP_VIEWS, north: [[24, -170], [76, 180]] };

const DPR_CAP = 1.5;
const MAX_CANVAS = 4096;
const FILL_OPACITY = 1;       // story colours are drawn as they are (the legend shows exactly what is drawn)
const EDGE_WIDTH = 0.4;       // map.js paint(): cell edge weight (px)

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A GeoJSON outline of a [[south, west], [north, east]] box, sampled so a curved projection fits it. */
function boxFeature([[s, w], [n, e]]) {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
        const x = w + (e - w) * i / 24, y = s + (n - s) * i / 24;
        pts.push([x, s], [x, n], [w, y], [e, y]);
    }
    return { type: 'MultiPoint', coordinates: pts };
}

/**
 * The land as d3-geo expects it. d3 reads a polygon's ring order on the sphere (clockwise = the inside),
 * the reverse of GeoJSON's convention, so a polygon whose area comes out above a hemisphere is reversed.
 * (Leaflet, which the old map uses, ignores ring order.)
 */
function rewound(world) {
    const fix = (geom) => {
        const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
        const out = polys.map(rings => {
            const poly = { type: 'Polygon', coordinates: rings };
            return d3.geoArea(poly) > 2 * Math.PI ? rings.map(r => r.slice().reverse()) : rings;
        });
        return { type: 'MultiPolygon', coordinates: out };
    };
    const feats = world.type === 'FeatureCollection' ? world.features : [world];
    return { type: 'FeatureCollection', features: feats.map(f => ({ type: 'Feature', properties: {}, geometry: fix(f.geometry || f) })) };
}

/** The camera that fits world-space box b into screen rect r. */
function fit(b, r) {
    const k = Math.min((r.x1 - r.x0) / (b[1][0] - b[0][0]), (r.y1 - r.y0) / (b[1][1] - b[0][1]));
    return {
        k,
        x: r.x0 + ((r.x1 - r.x0) - k * (b[1][0] - b[0][0])) / 2 - k * b[0][0],
        y: r.y0 + ((r.y1 - r.y0) - k * (b[1][1] - b[0][1])) / 2 - k * b[0][1]
    };
}

/**
 * el: the container (position: relative, sized by CSS).
 * opts.rects(w, h) -> { safe: rect, full: rect } in container pixels: where the world view and the
 *   picture-only ("-full") views fit the map.
 * opts.world: the land GeoJSON; opts.rows: [{ i, latitude, longitude, location_id }].
 */
export function createStoryMap(el, { world, rows, rects }) {
    world = world ? rewound(world) : { type: 'FeatureCollection', features: [] };
    // One group per view region of map.js VIEWS (world, europe, ...): the view and its picture-only "-full".
    const groups = Object.fromEntries(Object.keys(VIEWS).map(v => [v, [v, `${v}-full`]]));
    let W = 0, H = 0, dpr = 1;
    let sites = [];
    let proj = null, landPath = null, voronoi = null, delaunay = null, cellPaths = null;
    let cams = {};             // view name -> camera
    let render = {};           // group -> { k, r0: [x, y], w, h } (render camera and covered region)
    const layers = new Map();  // key -> { canvas, group, version }
    let version = 0;           // geometry version: a resize makes every canvas stale
    let camera = { k: 1, x: 0, y: 0 };
    const probe = document.createElement('canvas').getContext('2d');

    function measure() {
        const r = el.getBoundingClientRect();
        W = Math.max(1, Math.round(r.width));
        H = Math.max(1, Math.round(r.height));
        dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
        const { safe, full } = rects(W, H);
        proj = d3.geoEqualEarth().fitExtent([[safe.x0, safe.y0], [safe.x1, safe.y1]], boxFeature(VIEWS.world));
        const path = d3.geoPath(proj);
        landPath = new Path2D(path(world) || '');
        const bbox = (b) => path.bounds(boxFeature(b));
        cams = {};
        for (const v of Object.keys(VIEWS)) {
            const b = bbox(VIEWS[v]);
            cams[v] = v === 'world' ? { k: 1, x: 0, y: 0 } : fit(b, safe);
            cams[`${v}-full`] = fit(b, full);
        }
        // Each group: drawn at its largest zoom, over the union of what its views show.
        for (const [g, views] of Object.entries(groups)) {
            const cs = views.map(v => cams[v]);
            let k = Math.max(...cs.map(c => c.k));
            const x0 = Math.min(...cs.map(c => -c.x / c.k)), y0 = Math.min(...cs.map(c => -c.y / c.k));
            const x1 = Math.max(...cs.map(c => (W - c.x) / c.k)), y1 = Math.max(...cs.map(c => (H - c.y) / c.k));
            k = Math.min(k, MAX_CANVAS / ((x1 - x0) * dpr), MAX_CANVAS / ((y1 - y0) * dpr));
            render[g] = { k, r0: [x0, y0], w: Math.ceil((x1 - x0) * k * dpr), h: Math.ceil((y1 - y0) * k * dpr) };
        }
        const pts = rows.map(r => proj([r.longitude, r.latitude]));
        sites = pts;
        delaunay = d3.Delaunay.from(pts);
        voronoi = delaunay.voronoi([-W, -H, 2 * W, 2 * H]);
        cellPaths = null;
        version++;
    }

    function cellPath(i) {
        if (!cellPaths) cellPaths = new Array(rows.length);
        if (cellPaths[i] === undefined) { const d = voronoi.renderCell(i); cellPaths[i] = d ? new Path2D(d) : null; }
        return cellPaths[i];
    }

    /** Draw cells [from, to) of `order` with colours from fill(row); land and ocean first when from = 0. */
    function paintCells(ctx, g, fill, order, from, to) {
        const R = render[g];
        ctx.setTransform(dpr * R.k, 0, 0, dpr * R.k, -dpr * R.k * R.r0[0], -dpr * R.k * R.r0[1]);
        if (from === 0) {
            ctx.fillStyle = token('--map-ocean');
            ctx.fillRect(R.r0[0], R.r0[1], R.w / (dpr * R.k), R.h / (dpr * R.k));
            ctx.fillStyle = token('--map-land');
            ctx.fill(landPath);
        }
        // Cells are batched into one path per colour, in chunks of at most CHUNK cells: Safari (Core Graphics) silently
        // draws nothing for a very large compound path, which left most of the map unpainted on iPhones once a few
        // colours covered thousands of cells (T091 round 9). Chunking costs nothing elsewhere.
        const CHUNK = 120;
        const byColour = new Map(), edges = [];
        let edgeN = CHUNK;
        for (let n = from; n < to; n++) {
            const i = order ? order[n] : n;
            const c = fill(rows[i]);
            if (c == null) continue;
            const d = cellPath(i);
            if (!d) continue;
            let q = byColour.get(c);
            if (!q || q.n >= CHUNK) { q = { p: new Path2D(), n: 0, prev: q }; byColour.set(c, q); }
            q.p.addPath(d); q.n++;
            if (edgeN >= CHUNK) { edges.push(new Path2D()); edgeN = 0; }
            edges[edges.length - 1].addPath(d); edgeN++;
        }
        ctx.save();
        ctx.clip(landPath);
        ctx.globalAlpha = FILL_OPACITY;
        for (const [c, last] of byColour) { ctx.fillStyle = c; for (let q = last; q; q = q.prev) ctx.fill(q.p); }
        ctx.globalAlpha = 1;
        ctx.lineJoin = 'round';
        ctx.lineWidth = EDGE_WIDTH / R.k;
        ctx.strokeStyle = token('--map-cell-edge');
        for (const e of edges) ctx.stroke(e);
        ctx.restore();
    }

    function newCanvas(g) {
        const c = document.createElement('canvas');
        c.width = render[g].w;
        c.height = render[g].h;
        c.style.width = `${render[g].w / dpr}px`;
        c.style.height = `${render[g].h / dpr}px`;
        c.setAttribute('aria-hidden', 'true');
        return c;
    }

    /** Dots over the map: [{ lon, lat, r (px at world zoom), colour }], largest first so small ones stay visible. */
    function paintPoints(ctx, g, points) {
        const R = render[g];
        ctx.setTransform(dpr * R.k, 0, 0, dpr * R.k, -dpr * R.k * R.r0[0], -dpr * R.k * R.r0[1]);
        ctx.lineWidth = 0.6 / R.k;
        ctx.strokeStyle = token('--map-ocean');
        for (const q of [...points].sort((a, b) => b.r - a.r)) {
            const p = proj([q.lon, q.lat]);
            if (!p) continue;
            ctx.beginPath();
            ctx.arc(p[0], p[1], q.r, 0, 2 * Math.PI);
            ctx.fillStyle = q.colour;
            ctx.fill();
            ctx.stroke();
        }
    }

    /** The canvas of layer `key` in group g, drawn with fill(row) (and dots, if given) if missing or stale. */
    function ensure(key, g, fill, points = null) {
        let L = layers.get(key);
        if (L && L.version === version) return L;
        if (L) L.canvas.remove();
        const canvas = newCanvas(g);
        canvas.dataset.layer = key;
        paintCells(canvas.getContext('2d'), g, fill, null, 0, rows.length);
        if (points) paintPoints(canvas.getContext('2d'), g, points);
        L = { canvas, group: g, version, opacity: -1 };
        // E layers stack above W layers.
        // Region layers stack above world layers.
        const firstR = [...el.querySelectorAll('canvas')].find(c => (layers.get(c.dataset.layer)?.group || 'world') !== 'world');
        if (g === 'world' && firstR) el.insertBefore(canvas, firstR); else el.appendChild(canvas);
        layers.set(key, L);
        place(L);
        return L;
    }

    /** Redraw an existing layer's colours in place (the windcost year). */
    function repaint(key, fill) {
        const L = layers.get(key);
        if (!L || L.version !== version) return false;
        paintCells(L.canvas.getContext('2d'), L.group, fill, null, 0, rows.length);
        return true;
    }

    function drop(key) {
        const L = layers.get(key);
        if (L) { L.canvas.remove(); layers.delete(key); }
    }

    function place(L) {
        const R = render[L.group];
        const s = camera.k / R.k;
        const tx = camera.k * R.r0[0] + camera.x, ty = camera.k * R.r0[1] + camera.y;
        L.canvas.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${s.toFixed(5)})`;
    }

    function setCamera(c) {
        camera = c;
        for (const L of layers.values()) if (L.version === version) place(L);
    }

    function setOpacity(key, o) {
        const L = layers.get(key);
        if (!L) return;
        const v = Math.round(o * 1000) / 1000;
        if (v === L.opacity) return;
        L.opacity = v;
        L.canvas.style.opacity = String(v);
        L.canvas.style.visibility = v > 0 ? 'visible' : 'hidden';
    }

    /** The camera between views a and b at t in [0, 1]: a smooth zoom (van Wijk and Nuij, d3.interpolateZoom). */
    function between(a, b, t) {
        const A = cams[a], B = cams[b];
        if (!A || !B) return A || B;
        const view = (c) => [(W / 2 - c.x) / c.k, (H / 2 - c.y) / c.k, W / c.k];
        const [cx, cy, w] = d3.interpolateZoom(view(A), view(B))(t);
        const k = W / w;
        return { k, x: W / 2 - k * cx, y: H / 2 - k * cy };
    }

    /** The region index under a container point, or -1 (outside the land or the cells). */
    function hit(px, py) {
        if (!delaunay) return -1;
        const x = (px - camera.x) / camera.k, y = (py - camera.y) / camera.k;
        if (!probe.isPointInPath(landPath, x, y)) return -1;
        return delaunay.find(x, y);
    }

    /** For the probe: the canvas pixel of region i's site in group g's canvas, or null if the site is off the land. */
    function sitePixel(g, i) {
        const p = proj([rows[i].longitude, rows[i].latitude]);
        if (!p || !probe.isPointInPath(landPath, p[0], p[1])) return null;
        const R = render[g];
        // only sites at least 1.5 px inside a cell of at least 25 px² as drawn (smaller cells are sub-pixel)
        const poly = voronoi.cellPolygon(i);
        if (!poly) return null;
        const s = R.k * dpr;
        if (Math.abs(d3.polygonArea(poly)) * s * s < 25) return null;
        let dmin = Infinity;
        for (let k = 0; k + 1 < poly.length; k++) {
            const [ax, ay] = poly[k], [bx, by] = poly[k + 1];
            const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
            const t = Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / L2));
            dmin = Math.min(dmin, Math.hypot(p[0] - ax - t * (bx - ax), p[1] - ay - t * (by - ay)));
        }
        if (dmin * s < 1.5) return null;
        // ...and at least 1.5 px from the coast (the land outline clips the cells)
        const r = 1.5 / s;
        for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
            if (!probe.isPointInPath(landPath, p[0] + dx, p[1] + dy)) return null;
        }
        return [Math.floor((p[0] - R.r0[0]) * R.k * dpr), Math.floor((p[1] - R.r0[1]) * R.k * dpr)];
    }

    /** The opening: draw the cells in `order`, a batch per frame, over `ms`; resolves when done. */
    function reveal(canvas, fill, order, ms, reduced) {
        const g = 'world';
        canvas.width = render[g].w;
        canvas.height = render[g].h;
        const ctx = canvas.getContext('2d');
        const R = render[g];
        canvas.style.width = `${R.w / dpr}px`;
        canvas.style.height = `${R.h / dpr}px`;
        canvas.style.left = `${R.r0[0] * camera.k + camera.x}px`;
        canvas.style.top = `${R.r0[1] * camera.k + camera.y}px`;
        if (reduced || !ms) {
            paintCells(ctx, g, fill, order, 0, order.length);
            return Promise.resolve();
        }
        paintCells(ctx, g, () => null, order, 0, 0);    // ocean and land
        return new Promise((resolve) => {
            const t0 = performance.now();
            let done = 0;
            const step = (now) => {
                const t = Math.min(1, (now - t0) / ms);
                const upto = Math.round(order.length * (1 - Math.pow(1 - t, 1.6)));
                if (upto > done) { paintCells(ctx, g, fill, order, done, upto); done = upto; }
                if (t < 1) requestAnimationFrame(step); else resolve();
            };
            requestAnimationFrame(step);
        });
    }

    measure();
    return {
        measure, ensure, repaint, drop, setCamera, setOpacity, between, hit, reveal, sitePixel,
        /** Region i's site on screen (container px) under the current camera (the morph's tiles start there). */
        siteScreen: (i) => [camera.k * sites[i][0] + camera.x, camera.k * sites[i][1] + camera.y],
        /** A point of data/story-shapes.json (Equal Earth raw units, y down) in world space (T090 round 2: the morph's shapes). */
        rawToWorld: (x, y) => { const k = proj.scale(), t = proj.translate(); return [t[0] + k * x, t[1] + k * y]; },
        get camera() { return camera; },
        get cams() { return cams; },
        get size() { return { W, H }; },
        get layers() { return layers; },
        get version() { return version; }
    };
}
