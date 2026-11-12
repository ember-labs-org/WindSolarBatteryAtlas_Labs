// story-morph.js – the map turns into the chart (story.html, T087 design v3; shapes and treemaps since T090 round 2).
//
// One engine for every segment. Each region keeps its real shape: the morph starts from the map's own Voronoi polygon
// (its largest land piece, data/story-shapes.json, resampled to N points), in the map's colour, at its true size on the
// map. As it travels, the polygon morphs point by point into its target tile: position, shape and size together. The
// target is a rectangle in a bar (or, for the people/demand maps of section 5, a square at the region's site sized by
// its weight), its N points starting at the top-left corner and running clockwise, as the polygon's do, so nothing
// twists. Both point sets are computed once per layout; a frame is a lerp and a fill per region. A region is never
// drawn bigger than the larger of its polygon and its tile (the area is clamped about its centroid if a lerp would
// swell it). Regions a layout leaves out (no weight, no group) fade out in place.
//
// A bar is a squarified treemap of the whole bar rectangle (width fixed, height ∝ the bar's total weight): near-square
// tiles, drawn with a uniform hairline gap of the stage colour, no outlines. Tiles are ordered so colours band from the
// lightest at the top to the darkest at the bottom; a layout may stack segments (section 6's tiers) bottom up, each its
// own treemap. Tiles under 1.5 px merge into a "rest" strip at the top of their segment, side by side and without gaps,
// so the bar's total stays exact.
//
// Each pile layout has its own chart head (title, subtitle with units, an optional note, the legend), in HTML above the
// plot, and its own bar labels (SVG). Heads and labels fade monotonically with the tiles' arrival; between two pile
// layouts the leaving ones fade out before the landing ones fade in. Checked by scripts/article/tools/stage-probe.mjs.
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// a gentle sine in-out: the scene already eases the scroll (smooth), so a steep cubic here bunched the flight into a sliver
const ease = t => 0.5 - 0.5 * Math.cos(Math.PI * t);
const SVGNS = 'http://www.w3.org/2000/svg';
const LABEL_SPACE = 44;        // px between the head and the tallest pile, for the value labels above the piles
const GAP = 0.75;              // px: the hairline between landed tiles (the stage colour shows through)
const REST_SIDE = 1.5;         // px: tiles smaller than this merge into the rest strip of their segment

/** N points along the rectangle [x, y, w, h], clockwise from its top-left corner, each side's share ∝ its length. */
function rectPoints(N, x, y, w, h, out, o) {
    const L = 2 * (w + h);
    const sides = [[x, y, 1, 0, w], [x + w, y, 0, 1, h], [x + w, y + h, -1, 0, w], [x, y + h, 0, -1, h]];
    // whole points per side (at least one: its corner), largest remainders to the longest sides
    const want = sides.map(s => (L > 0 ? N * s[4] / L : N / 4));
    const cnt = want.map(v => Math.max(1, Math.floor(v)));
    let left = N - cnt.reduce((a, b) => a + b, 0);
    const byRem = want.map((v, k) => [v - Math.floor(v), k]).sort((a, b) => b[0] - a[0]);
    for (let j = 0; left > 0; j = (j + 1) % 4) { cnt[byRem[j][1]]++; left--; }
    for (let j = 0; left < 0; j = (j + 1) % 4) { const k = byRem[3 - j][1]; if (cnt[k] > 1) { cnt[k]--; left++; } }
    let p = o;
    sides.forEach(([sx, sy, dx, dy, len], k) => {
        for (let m = 0; m < cnt[k]; m++) { const t = len * m / cnt[k]; out[p++] = sx + dx * t; out[p++] = sy + dy * t; }
    });
}

/** Shoelace area of N points at offset o of a flat array (absolute), taken about the first point (screen coordinates in
 *  float32 would otherwise lose a small tile's area to rounding). */
function areaOf(a, o, N) {
    const x0 = a[o], y0 = a[o + 1];
    let s = 0;
    for (let j = 0; j < N; j++) {
        const k = (j + 1) % N;
        s += (a[o + 2 * j] - x0) * (a[o + 2 * k + 1] - y0) - (a[o + 2 * k] - x0) * (a[o + 2 * j + 1] - y0);
    }
    return Math.abs(s) / 2;
}

/**
 * Squarified treemap (Bruls et al. 2000, d3.treemapSquarify) of the rectangle [x, yTop, w, h] for the areas in their
 * given order (the order sets the colour banding), with a rest strip of the tiles under REST_SIDE on top. Returns per
 * tile [x, y, w, h, rest].
 */
function treemapBar(areas, x, yTop, w, h) {
    const out = new Array(areas.length);
    let rest = [], main = [];
    areas.forEach((a, k) => { if (!(a > 0)) out[k] = [x, yTop, 0, 0, 1]; else (a < REST_SIDE * REST_SIDE ? rest : main).push(k); });
    // Squarify; a tile it still leaves thinner than REST_SIDE or worse than 1:8 (where a run of small tiles meets a big
    // one) joins the rest strip, and the treemap is laid out again, until none is left (a few rounds at most).
    let leaves = [], rh = 0;
    for (let round = 0; round < 40; round++) {
        const restA = rest.reduce((s, k) => s + areas[k], 0);
        rh = w > 0 ? restA / w : 0;
        leaves = [];
        if (main.length) {
            const root = d3.hierarchy({ children: main.map(k => ({ k, v: areas[k] })) }).sum(d => d.v || 0);
            d3.treemap().tile(d3.treemapSquarify).size([w, Math.max(0, h - rh)]).round(false)(root);
            leaves = root.leaves();
        }
        // (as drawn: less the hairline gap)
        const thin = new Set(leaves.filter((l) => { const a = l.x1 - l.x0 - GAP, b = l.y1 - l.y0 - GAP; return Math.min(a, b) < REST_SIDE || Math.max(a / b, b / a) > 8; }).map(l => l.data.k));
        if (!thin.size) break;
        rest = [...rest, ...main.filter(k => thin.has(k))];
        main = main.filter(k => !thin.has(k));
    }
    // the rest strip in the bar's colour order (lightest first), so its slivers read as one smooth band, not as noise
    rest.sort((a, b) => a - b);
    let rx = x;
    for (const k of rest) { const ww = areas[k] / Math.max(rh, 1e-9); out[k] = [rx, yTop, ww, rh, 1]; rx += ww; }
    for (const leaf of leaves) out[leaf.data.k] = [x + leaf.x0, yTop + rh + leaf.y0, leaf.x1 - leaf.x0, leaf.y1 - leaf.y0, 0];
    return out;
}

export function createMorph(el, map, rows, plotRect, shapes) {
    const canvas = document.createElement('canvas');
    canvas.className = 'smap-dots';
    canvas.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'smap-axes');
    svg.setAttribute('aria-hidden', 'true');
    const heads = document.createElement('div');
    heads.className = 'morph-heads';
    el.append(canvas, svg, heads);
    const ctx = canvas.getContext('2d');
    const N = shapes.N;
    const sets = {};
    let W = 0, H = 0, dpr = 1, shown = false, lastPile = 0;
    const stats = { drawn: 0, growth: 0 };
    const BATCH_MAX = 32;
    function setFill(key) {
        const c = Math.floor(key / 11);
        ctx.globalAlpha = (key % 11) / 10;
        ctx.fillStyle = `rgb(${((c >> 12) & 63) * 4 + 2},${((c >> 6) & 63) * 4 + 2},${(c & 63) * 4 + 2})`;
    }       // per frame: regions drawn; largest area / max(polygon, tile)
    // unit square, N points, clockwise from the top-left (the map squares of section 5 are scaled from it)
    const SQ = new Float32Array(2 * N);
    rectPoints(N, -1, -1, 2, 2, SQ, 0);
    // scratch buffers for one frame
    const pa = new Float64Array(2 * N), pb = new Float64Array(2 * N), pc = new Float64Array(2 * N);

    function size() {
        const r = el.getBoundingClientRect();
        W = Math.round(r.width); H = Math.round(r.height);
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = W * dpr; canvas.height = H * dpr;
        canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('width', W); svg.setAttribute('height', H);
        for (const s of Object.values(sets)) build(s);
    }

    /**
     * spec: { items: [row index], weight(i), mapRadius(i, k, w) (px at camera zoom k: half the side of a map square),
     *   layouts: { name: { kind: 'map' | 'pile', weight(i)?, colour(i) -> css, group(i) -> index or -1, groups: [label],
     *   stack(i)? (segment, bottom up), axes(g, geom)?, head: { title, sub, note?, legend (html) }? } } }
     */
    function define(id, spec) {
        sets[id] = { id, spec, L: {} };
        if (W) build(sets[id]);
    }

    function headEl(head) {
        const d = document.createElement('div');
        d.className = 'morph-head';
        d.style.opacity = '0';
        d.innerHTML = `<p class="morph-head__title">${head.title}</p>` + (head.sub ? `<p class="morph-head__sub">${head.sub}</p>` : '')
            + (head.note ? `<p class="morph-head__note">${head.note}</p>` : '') + (head.legend ? `<div class="morph-head__legend">${head.legend}</div>` : '');
        return d;
    }

    function build(s) {
        const { spec } = s;
        const n = spec.items.length;
        const P = plotRect(W, H);
        // each region's polygon in world space (the map's projection, before the camera) and its area there
        s.poly = new Float64Array(n * 2 * N);
        s.has = new Uint8Array(n);
        s.polyA = new Float32Array(n);
        s.fbuf = new Float64Array(n * 2 * N); s.fkey = new Int32Array(n); s.fidx = new Uint32Array(n);   // a frame's shapes
        spec.items.forEach((i, q) => {
            const raw = shapes.pts[i];
            if (!raw) return;
            s.has[q] = 1;
            for (let j = 0; j < N; j++) { const w = map.rawToWorld(raw[2 * j], raw[2 * j + 1]); s.poly[q * 2 * N + 2 * j] = w[0]; s.poly[q * 2 * N + 2 * j + 1] = w[1]; }
            s.polyA[q] = areaOf(s.poly, q * 2 * N, N);
        });
        // a stagger per region (west to east on the map), so the shapes stream rather than move as one block
        s.stag = Float32Array.from(spec.items, (i) => { const p = map.siteScreen(i); return Math.min(1, Math.max(0, p[0] / Math.max(1, W))); });
        // The heads of this set's pile layouts, laid out once at the plot's width; the plot starts below the tallest,
        // so layouts with the same groups keep the same tile positions.
        for (const L of Object.values(s.L)) L.head?.remove();
        const hs = {};
        let headH = 0;
        for (const [name, L] of Object.entries(spec.layouts)) {
            if (L.kind !== 'pile' || !L.head) continue;
            const h = headEl(L.head);
            h.style.left = `${P.x0}px`; h.style.top = `${P.y0}px`; h.style.width = `${Math.max(120, P.x1 - P.x0)}px`;
            heads.appendChild(h);
            hs[name] = h;
            headH = Math.max(headH, h.offsetHeight);
        }
        const top = P.y0 + headH + LABEL_SPACE;
        const none = d3.color(getComputedStyle(document.documentElement).getPropertyValue('--n2').trim()) || d3.rgb(176, 183, 198);
        for (const [name, L] of Object.entries(spec.layouts)) {
            const w = L.weight || spec.weight;
            const col = new Float32Array(n * 3);
            const lum = new Float32Array(n);
            spec.items.forEach((i, k) => {
                const rgb = (d3.color(L.colour(i)) || none).rgb();
                col.set([rgb.r, rgb.g, rgb.b], k * 3);
                lum[k] = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
            });
            const out = { kind: L.kind, pts: null, rect: null, area: new Float32Array(n), in: new Uint8Array(n), col, axes: null, head: hs[name] || null, wf: w };
            if (L.kind === 'pile') {
                const G = L.groups.length;
                const gap = Math.max(8, (P.x1 - P.x0) * 0.04);
                const colW = Math.min(110, ((P.x1 - P.x0) - gap * (G - 1)) / G);
                const x0 = P.x0 + ((P.x1 - P.x0) - (colW * G + gap * (G - 1))) / 2;
                const tot = new Array(G).fill(0);
                spec.items.forEach((i) => { const g = L.group(i); if (g >= 0) tot[g] += Math.max(0, w(i)); });
                const avail = Math.max(40, P.y1 - top);
                const perW = Math.max(...tot) > 0 ? (avail * colW) / Math.max(...tot) : 0;   // px² per unit weight
                out.pts = new Float64Array(n * 2 * N);
                out.rect = new Float64Array(n * 5);          // x, y, w, h, rest: the landed tile as drawn (gap applied)
                // members by bar and segment; inside a segment the colour bands from the lightest (top) to the darkest
                // (bottom), in seven steps of luminance, the larger tiles first within a step (squarify likes them so)
                const bars = Array.from({ length: G }, () => new Map());
                spec.items.forEach((i, k) => {
                    const g = L.group(i), ww = Math.max(0, w(i));
                    if (g < 0 || !(ww > 0)) return;
                    const sg = L.stack ? L.stack(i) : 0;
                    if (!bars[g].has(sg)) bars[g].set(sg, []);
                    bars[g].get(sg).push(k);
                    out.in[k] = 1;
                });
                bars.forEach((segs, g) => {
                    let yb = P.y1;
                    const bx = x0 + g * (colW + gap);
                    for (const sg of [...segs.keys()].sort((a, b) => a - b)) {
                        const ks = segs.get(sg).sort((a, b) => (Math.round(lum[b] / 36) - Math.round(lum[a] / 36)) || (w(spec.items[b]) - w(spec.items[a])));
                        const areas = ks.map(k => Math.max(0, w(spec.items[k])) * perW);
                        const hSeg = areas.reduce((a, b) => a + b, 0) / colW;
                        const rects = treemapBar(areas, bx, yb - hSeg, colW, hSeg);
                        ks.forEach((k, j) => {
                            let [x, y, ww, hh, rest] = rects[j];
                            if (!rest) { x += GAP / 2; y += GAP / 2; ww = Math.max(0.1, ww - GAP); hh = Math.max(0.1, hh - GAP); }
                            out.rect.set([x, y, ww, hh, rest], k * 5);
                            // a rest-strip sliver is drawn a pixel wider than its tile (the layout stays exact): sub-pixel
                            // slivers anti-aliased one by one let the stage show through and greyed the strip (the human,
                            // T091 round 9: "the grey block on top of the bars")
                            const wd = rest ? Math.min(ww + 1, bx + colW - x) : ww;
                            rectPoints(N, x, y, wd, hh, out.pts, k * 2 * N);
                            out.area[k] = wd * hh;   // as drawn: the frame clamps a shape to its ends' areas
                        });
                        yb -= hSeg;
                    }
                });
                out.geom = { P: { ...P, y0: top }, x0, colW, gap, G, heights: tot.map(t => t * perW / colW), totals: tot };
            } else {
                spec.items.forEach((i, k) => { out.in[k] = w(i) > 0 ? 1 : 0; });
            }
            if (L.axes) {
                const g = document.createElementNS(SVGNS, 'g');
                g.setAttribute('opacity', '0');
                L.axes(g, out.geom || { P }, d3.select(g));
                out.axes = g;
            }
            s.L[name] = out;
        }
        svg.replaceChildren(...Object.values(sets).flatMap(q => Object.values(q.L).map(l => l.axes).filter(Boolean)));
    }

    // Region q's N points at one end of a transition, in screen px, into buf: its tile in a pile layout, a square at its
    // site on a map layout, or (no layout: the polygon map) its own polygon under the camera. Returns its area.
    function endPoints(s, L, q, i, cam, buf) {
        if (L && L.kind === 'pile' && L.in[q]) { buf.set(L.pts.subarray(q * 2 * N, (q + 1) * 2 * N)); return L.area[q]; }
        if (L && L.kind === 'map' && L.in[q]) {
            const p = map.siteScreen(i), r = s.spec.mapRadius(i, cam.k, L.wf);
            for (let j = 0; j < N; j++) { buf[2 * j] = p[0] + r * SQ[2 * j]; buf[2 * j + 1] = p[1] + r * SQ[2 * j + 1]; }
            return 4 * r * r;
        }
        if (!s.has[q]) { const p = map.siteScreen(i); for (let j = 0; j < N; j++) { buf[2 * j] = p[0]; buf[2 * j + 1] = p[1]; } return 0; }
        const o = q * 2 * N;
        for (let j = 0; j < N; j++) { buf[2 * j] = cam.k * s.poly[o + 2 * j] + cam.x; buf[2 * j + 1] = cam.k * s.poly[o + 2 * j + 1] + cam.y; }
        return s.polyA[q] * cam.k * cam.k;
    }

    /** Draw set `id` between layouts A and B (either may be null: the polygon map) at t; returns how far the view is shapes. */
    function render(id, A, B, t) {
        const s = sets[id];
        if (!s || (!A && !B)) { hide(); return 0; }
        const n = s.spec.items.length;
        const cam = map.camera;
        const LA = A ? s.L[A] : null, LB = B ? s.L[B] : null;
        // Phases: the shapes come up over the map's own polygons, identical to them (t 0-0.06), while the map fades
        // (0-0.18); they then travel and morph (staggered by ≤ 15%, on a slight arc) and land; the reverse on the way back.
        const appear = !LA ? smooth(0, 0.06, t) : !LB ? 1 - smooth(0.94, 1, t) : 1;
        const shapesOn = !LA ? smooth(0, 0.18, t) : !LB ? 1 - smooth(0.82, 1, t) : 1;
        const f = !LA ? smooth(0.12, 0.9, t) : !LB ? smooth(0.1, 0.88, t) : smooth(0.08, 0.92, t);
        const L0 = LA || LB, L1 = LB || LA;          // colours at each end
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const ST = 0.15;
        let drawn = 0, growth = 0, m = 0;
        for (let q = 0; q < n; q++) {
            const i = s.spec.items[q];
            const inA = LA ? LA.in[q] : 1, inB = LB ? LB.in[q] : 1;
            if (!inA && !inB) continue;
            const d0 = ST * s.stag[q];
            const u = ease(Math.min(1, Math.max(0, (f - d0) / (1 - ST))));
            // a region one end leaves out stays where it is at the other end and fades
            let aA, aB;
            if (inA && inB) { aA = endPoints(s, LA, q, i, cam, pa); aB = endPoints(s, LB, q, i, cam, pb); }
            else if (inA) { aA = endPoints(s, LA, q, i, cam, pa); pb.set(pa); aB = aA; }
            else { aB = endPoints(s, LB, q, i, cam, pb); pa.set(pb); aA = aB; }
            const alpha = (inA && inB ? 1 : inA ? 1 - u : u) * appear;
            if (alpha <= 0.01) continue;
            // the lerp, lifted on an arc while it travels
            let cxa = 0, cya = 0, cxb = 0, cyb = 0;
            for (let j = 0; j < N; j++) { cxa += pa[2 * j]; cya += pa[2 * j + 1]; cxb += pb[2 * j]; cyb += pb[2 * j + 1]; }
            const lift = Math.sin(Math.PI * u) * Math.min(60, 0.1 * Math.hypot(cxb - cxa, cyb - cya) / N);
            for (let j = 0; j < 2 * N; j += 2) { pc[j] = pa[j] + (pb[j] - pa[j]) * u; pc[j + 1] = pa[j + 1] + (pb[j + 1] - pa[j + 1]) * u - lift; }
            // never bigger than the larger of its two ends: clamp the area about the centroid
            const lim = Math.max(aA, aB), a = areaOf(pc, 0, N);
            if (lim > 0 && a > lim) {
                let cx = 0, cy = 0;
                for (let j = 0; j < 2 * N; j += 2) { cx += pc[j]; cy += pc[j + 1]; }
                cx /= N; cy /= N;
                const k = Math.sqrt(lim / a);
                for (let j = 0; j < 2 * N; j += 2) { pc[j] = cx + (pc[j] - cx) * k; pc[j + 1] = cy + (pc[j + 1] - cy) * k; }
            }
            if (lim >= 0.25) growth = Math.max(growth, Math.min(1, a / lim));   // (clamped to 1 above; sub-pixel shapes not measured)
            if (inA && inB) drawn++;          // the regions in both layouts (those one end leaves out fade, counted apart)
            const c0 = q * 3;
            const cr = L0.col[c0] + (L1.col[c0] - L0.col[c0]) * u, cg = L0.col[c0 + 1] + (L1.col[c0 + 1] - L0.col[c0 + 1]) * u, cb = L0.col[c0 + 2] + (L1.col[c0 + 2] - L0.col[c0 + 2]) * u;
            // filled by colour below (6 bits a channel, within 2 of 255, and alpha in tenths) and alpha (tenths), filled once each below
            const key = ((cr >> 2) << 12 | (cg >> 2) << 6 | (cb >> 2)) * 11 + Math.round(alpha * 10);
            s.fkey[m] = key;
            s.fbuf.set(pc, m * 2 * N);
            s.fidx[m] = m;
            m++;
        }
        // fill by colour, at most BATCH_MAX shapes per path (a path of many overlapping pieces rasterises slowly); the
        // buffers are the set's own, so a frame allocates nothing
        const idx = s.fidx.subarray(0, m), fk = s.fkey;
        idx.sort((p, q) => fk[p] - fk[q]);
        for (let a0 = 0; a0 < m;) {
            const key = fk[idx[a0]];
            setFill(key);
            let a1 = a0;
            while (a1 < m && fk[idx[a1]] === key) {
                ctx.beginPath();
                for (let c = 0; c < BATCH_MAX && a1 < m && fk[idx[a1]] === key; c++, a1++) {
                    const o = idx[a1] * 2 * N, fb = s.fbuf;
                    ctx.moveTo(fb[o], fb[o + 1]);
                    for (let j = 2; j < 2 * N; j += 2) ctx.lineTo(fb[o + j], fb[o + j + 1]);
                    ctx.closePath();
                }
                ctx.fill();
            }
            a0 = a1;
        }
        ctx.globalAlpha = 1;
        stats.drawn = drawn; stats.growth = growth;
        // heads and labels: the landing layout's fade in as its tiles land, the leaving one's out as they leave;
        // between two piles, the leaving head and labels fade out before the landing ones fade in (no text over text)
        const both = LA?.kind === 'pile' && LB?.kind === 'pile' && A !== B;
        for (const [name, L] of Object.entries(s.L)) {
            const o = name === A && name === B ? (L.kind === 'pile' ? 1 : 0)
                : name === B && LB?.kind === 'pile' ? (both ? smooth(0.5, 0.75, t) : smooth(0.8, 1, t))
                    : name === A && LA?.kind === 'pile' ? (both ? 1 - smooth(0.25, 0.5, t) : 1 - smooth(0, 0.2, t)) : 0;
            const v = o.toFixed(3);
            L.axes?.setAttribute('opacity', v);
            if (L.head) { L.head.style.opacity = v; L.head.style.visibility = o > 0.001 ? 'visible' : 'hidden'; }
        }
        for (const q of Object.values(sets)) if (q !== s) for (const L of Object.values(q.L)) { L.axes?.setAttribute('opacity', '0'); if (L.head) { L.head.style.opacity = '0'; L.head.style.visibility = 'hidden'; } }
        canvas.style.visibility = 'visible';
        shown = true;
        // how far the tiles are in a chart layout (story.js fades the map's key by it)
        lastPile = (LA?.kind === 'pile' ? 1 - f : 0) + (LB?.kind === 'pile' ? f : 0);
        return shapesOn;
    }

    function hide() {
        if (!shown) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.visibility = 'hidden';
        svg.querySelectorAll('g').forEach(g => g.setAttribute('opacity', '0'));
        heads.querySelectorAll('.morph-head').forEach((h) => { h.style.opacity = '0'; h.style.visibility = 'hidden'; });
        shown = false;
        stats.drawn = 0; stats.growth = 0;
    }

    /** For the stage probe: a pile layout's landed tiles as drawn ([x, y, w, h, rest], screen px). */
    function landed(id, name) {
        const L = sets[id]?.L[name];
        if (!L?.rect) return [];
        const out = [];
        for (let q = 0; q < L.in.length; q++) if (L.in[q]) out.push(Array.from(L.rect.subarray(q * 5, q * 5 + 5)));
        return out;
    }

    size();
    document.fonts?.ready.then(() => { size(); });
    /** The map state whose colours a layout's tiles carry (story.js shows its caption and legend). */
    const stateOf = (id, layout) => sets[id]?.spec.layouts[layout]?.state || null;
    return { define, render, hide, resize: size, stateOf, landed, get sets() { return sets; }, get pile() { return shown ? lastPile : 0; },
        get drawn() { return stats.drawn; }, get growth() { return stats.growth; } };
}
