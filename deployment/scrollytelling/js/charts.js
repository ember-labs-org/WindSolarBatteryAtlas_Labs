// charts.js – the article's charts, drawn with d3 as SVG into a figure whose
// title, subtitle and source line are plain HTML in index.html. Ember chart
// rules: one message per chart, direct labels, horizontal gridlines only, no
// axis box, at most one annotation, five colours or fewer. Every colour is a
// token from css/article.css, read at draw time, so the light scheme redraws in
// its own colours.

const FONT = 'var(--font-sans)';

// The element whose CSS tokens the charts read (story.html draws some charts on its dark map stage, T087);
// null = the page's own (index.html never sets it).
let cssScope = null;
export function setCssScope(el) { cssScope = el || null; }
export function css(name, fallback) {
    const v = getComputedStyle(cssScope || document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

function ui() {
    return { text: css('--text', '#FFFFFF'), muted: css('--muted', '#B0B7C6'), grid: css('--grid', 'rgba(255,255,255,0.12)'),
        axis: css('--axis', '#B0B7C6'), bg: css('--panel', '#F5F7FA') };
}

function svgIn(el, width, height) {
    const svg = d3.select(el).append('svg')
        .attr('viewBox', `0 0 ${width} ${height}`)
        .attr('width', width).attr('height', height)
        .attr('role', 'img')
        .attr('aria-label', el.closest('figure')?.querySelector('.chart-title')?.textContent.trim() || 'Chart')
        .style('font-family', FONT);
    return svg;
}

function frame(el, height, margin) {
    el.innerHTML = '';
    const width = Math.max(260, Math.round(el.clientWidth || 320));
    const svg = svgIn(el, width, height);
    const inner = { w: width - margin.left - margin.right, h: height - margin.top - margin.bottom };
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    return { svg, g, width, inner };
}

function yGrid(g, y, w, ticks, fmt, { labels = true } = {}) {
    const c = ui();
    const ax = g.append('g').attr('class', 'y-grid');
    ticks.forEach((t) => {
        ax.append('line').attr('x1', 0).attr('x2', w).attr('y1', y(t)).attr('y2', y(t))
            .attr('stroke', t === 0 ? c.axis : c.grid).attr('stroke-width', 1);
        if (labels) {
            ax.append('text').attr('x', -6).attr('y', y(t) + 4).attr('text-anchor', 'end').attr('fill', c.muted)
                .attr('font-size', 11).text(fmt(t));
        }
    });
}

function xAxis(g, x, h, ticks, fmt) {
    const c = ui();
    const ax = g.append('g').attr('transform', `translate(0,${h})`);
    ticks.forEach((t) => {
        ax.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', 0).attr('y2', 4).attr('stroke', c.axis);
        ax.append('text').attr('x', x(t)).attr('y', 17).attr('text-anchor', 'middle')
            .attr('fill', c.muted).attr('font-size', 11).text(fmt(t));
    });
}

/** Spread label positions (y, px) at least `gap` apart, inside [lo, hi]. */
function spread(items, gap, lo, hi) {
    const s = items.slice().sort((a, b) => a.y - b.y);
    for (let i = 1; i < s.length; i++) if (s[i].y - s[i - 1].y < gap) s[i].y = s[i - 1].y + gap;
    const over = s.length ? s[s.length - 1].y - hi : 0;
    if (over > 0) {
        s[s.length - 1].y -= over;
        for (let i = s.length - 2; i >= 0; i--) if (s[i + 1].y - s[i].y < gap) s[i].y = s[i + 1].y - gap;
    }
    if (s.length && s[0].y < lo) {
        s[0].y = lo;
        for (let i = 1; i < s.length; i++) if (s[i].y - s[i - 1].y < gap) s[i].y = s[i - 1].y + gap;
    }
    return items;
}

/** Key above a chart (HTML): coloured line, label, optional bold weight. */
export function chartKey(el, items) {
    const fig = el.closest('figure');
    let key = fig.querySelector('.chart-key');
    if (!key) {
        key = document.createElement('div');
        key.className = 'chart-key';
        el.before(key);
    }
    key.innerHTML = items.map(it => `<span><i style="background:${it.color}"></i>${it.label}${it.weight ? ` <b>${it.weight}</b>` : ''}</span>`).join('');
}

/**
 * One or more line panels side by side (stacked when narrow), on one y scale.
 * spec: { height, x: { domain, ticks, format }, y: { domain, ticks, format },
 *   panels: [{ title, series: [{ label, color, points: [[x, y]], dash }] }],
 *   endLabels: 'all' | 'last' (which panels carry direct labels), xTitle }
 * A series that leaves the top of the plot is clipped, and its last value is
 * written at the edge where it leaves.
 */
export function linePanels(el, spec) {
    el.innerHTML = '';
    const c = ui();
    const width = Math.max(260, Math.round(el.clientWidth || 320));
    const n = spec.panels.length;
    const side = n > 1 && width >= 520;
    const labelW = spec.labelWidth ?? 74;
    const left = 40, gapX = side ? 34 : 0;
    const panelW = side ? (width - left - labelW - gapX * (n - 1)) / n : width - left - labelW;
    const panelH = spec.height || 240;
    const titleH = 22, xH = 24 + (spec.xTitle ? 16 : 0), gapY = 18;
    const height = side ? titleH + panelH + xH : n * (titleH + panelH + xH) + (n - 1) * gapY;
    const svg = svgIn(el, width, height);
    const x = d3.scaleLinear().domain(spec.x.domain).range([4, panelW - 4]);
    const y = d3.scaleLinear().domain(spec.y.domain).range([panelH, 0]);
    const yMax = spec.y.domain[1];
    spec.panels.forEach((p, k) => {
        const ox = side ? left + k * (panelW + gapX) : left;
        const oy = side ? 0 : k * (titleH + panelH + xH + gapY);
        const g = svg.append('g').attr('transform', `translate(${ox},${oy + titleH})`);
        svg.append('text').attr('x', ox).attr('y', oy + 13).attr('fill', c.text).attr('font-size', 12.5).attr('font-weight', 600).text(p.title);
        yGrid(g, y, panelW, spec.y.ticks, spec.y.format, { labels: !side || k === 0 });
        xAxis(g, x, panelH, spec.x.ticks, spec.x.format);
        if (spec.xTitle && (!side || k === n - 1 || n === 1)) {
            g.append('text').attr('x', side ? panelW : panelW / 2).attr('y', panelH + 34).attr('text-anchor', side ? 'end' : 'middle')
                .attr('fill', c.muted).attr('font-size', 11).text(spec.xTitle);
        }
        const clipId = `clip-${el.dataset.chart}-${k}`;
        g.append('clipPath').attr('id', clipId).append('rect').attr('x', -2).attr('y', -1).attr('width', panelW + 4).attr('height', panelH + 2);
        const line = d3.line().x(d => x(d[0])).y(d => y(d[1]));
        const labels = [];
        const offscale = [];
        p.series.forEach((s) => {
            const pts = s.points.filter(q => Number.isFinite(q[1]));
            if (!pts.length) return;
            g.append('path').datum(pts).attr('clip-path', `url(#${clipId})`).attr('fill', 'none').attr('stroke', s.color)
                .attr('stroke-width', 2.25).attr('stroke-linejoin', 'round').attr('stroke-dasharray', s.dash || null).attr('d', line);
            const last = pts[pts.length - 1];
            if (last[1] > yMax) {
                // Where the line leaves the plot: its last value, at the top edge.
                let i = pts.findIndex(q => q[1] > yMax);
                const a = pts[i - 1] || pts[i], b = pts[i];
                const t = b[1] === a[1] ? 0 : (yMax - a[1]) / (b[1] - a[1]);
                const xe = a[0] + t * (b[0] - a[0]);
                if (spec.offscaleNote !== false) offscale.push({ x: x(xe), text: `${spec.y.format(last[1])} at ${spec.x.format(last[0])}`, color: s.color });
            } else if (!spec.noEndMarker) {   // charts.html (T091): Ember line charts carry no markers
                g.append('circle').attr('cx', x(last[0])).attr('cy', y(last[1])).attr('r', 3)
                    .attr('fill', c.bg).attr('stroke', s.color).attr('stroke-width', 1.75);
            }
            if (spec.endLabels === 'all' || (spec.endLabels !== 'none' && (k === n - 1 || !side))) {
                labels.push({ y: y(Math.min(last[1], yMax)), text: s.label, color: s.color });
            }
        });
        offscale.forEach((o) => {
            g.append('text').attr('x', o.x - 6).attr('y', 12).attr('text-anchor', 'end')
                .attr('fill', o.color).attr('font-size', 11).attr('font-weight', 600).text(`↑ ${o.text}`);
        });
        spread(labels, 13, 4, panelH);
        labels.forEach((l) => {
            g.append('text').attr('x', panelW + 8).attr('y', l.y + 4).attr('fill', l.color)
                .attr('font-size', 11.5).attr('font-weight', 600).text(l.text);
        });
    });
}

/**
 * Small multiples on shared axes. spec: { cols (desktop), colsNarrow, height,
 *   x: { domain, ticks, format }, y: { domain, ticks, format },
 *   panels: [{ title, series: [{ label, color, points }] }], labelPanel (index whose lines carry labels) }
 */
export function smallMultiples(el, spec) {
    el.innerHTML = '';
    const c = ui();
    const width = Math.max(260, Math.round(el.clientWidth || 320));
    const narrow = width < 520;
    const cols = narrow ? (spec.colsNarrow || 2) : spec.cols;
    const rows = Math.ceil(spec.panels.length / cols);
    const left = 34, gapX = narrow ? 14 : 18, titleH = 18, xH = 20, gapY = 14;
    const panelW = (width - left - gapX * (cols - 1)) / cols;
    const panelH = spec.height || (narrow ? 96 : 110);
    const height = rows * (titleH + panelH + xH) + (rows - 1) * gapY;
    const svg = svgIn(el, width, height);
    const x = d3.scaleLinear().domain(spec.x.domain).range([3, panelW - 3]);
    const y = d3.scaleLinear().domain(spec.y.domain).range([panelH, 0]);
    spec.panels.forEach((p, k) => {
        const col = k % cols, row = Math.floor(k / cols);
        const ox = left + col * (panelW + gapX), oy = row * (titleH + panelH + xH + gapY);
        // One group per panel (class sm-panel), so story.html can highlight a panel; drawing unchanged.
        const pg = svg.append('g').attr('class', 'sm-panel');
        pg.append('text').attr('x', ox).attr('y', oy + 12).attr('fill', c.text).attr('font-size', 11.5).attr('font-weight', 600).text(p.title);
        const g = pg.append('g').attr('transform', `translate(${ox},${oy + titleH})`);
        yGrid(g, y, panelW, spec.y.ticks, spec.y.format, { labels: col === 0 });
        const xt = narrow && spec.x.ticksNarrow ? spec.x.ticksNarrow : spec.x.ticks;
        const ax = g.append('g').attr('transform', `translate(0,${panelH})`);
        xt.forEach((t, q) => {
            // The end ticks sit inside the panel, so neighbouring panels' labels never touch.
            const anchor = x(t) < 12 ? 'start' : x(t) > panelW - 12 ? 'end' : 'middle';
            ax.append('text').attr('x', x(t)).attr('y', 13).attr('text-anchor', anchor).attr('fill', c.muted).attr('font-size', 10).text(spec.x.format(t));
        });
        const line = d3.line().x(d => x(d[0])).y(d => y(d[1]));
        p.series.forEach((s) => {
            const pts = s.points.filter(q => Number.isFinite(q[1]));
            if (spec.area) {
                g.append('path').datum(pts).attr('fill', s.color).attr('fill-opacity', 0.18)
                    .attr('d', d3.area().x(d => x(d[0])).y0(y(0)).y1(d => y(d[1])));
            }
            g.append('path').datum(pts).attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2)
                .attr('stroke-linejoin', 'round').attr('d', line);
            if (spec.endValue && pts.length) {
                // Direct label: the last value, beside an open end marker.
                const last = pts[pts.length - 1];
                g.append('circle').attr('cx', x(last[0])).attr('cy', y(last[1])).attr('r', 3)
                    .attr('fill', c.bg).attr('stroke', s.color).attr('stroke-width', 1.75);
                g.append('text').attr('x', x(last[0]) - 6).attr('y', Math.max(10, y(last[1]) - 6)).attr('text-anchor', 'end')
                    .attr('fill', s.color).attr('font-size', 11).attr('font-weight', 600).text(spec.endValue(last[1]));
            }
        });
        if (p.note) {
            g.append('text').attr('x', panelW).attr('y', 10).attr('text-anchor', 'end').attr('fill', c.muted).attr('font-size', 10).text(p.note);
        }
        if (k === (spec.labelPanel ?? 0)) {
            p.series.forEach((s) => {
                const at = s.labelAt;
                if (!at) return;
                const pt = s.points.find(q => q[0] === at[0]);
                if (!pt) return;
                g.append('text').attr('x', x(pt[0])).attr('y', y(pt[1]) + at[1]).attr('text-anchor', at[2] || 'middle')
                    .attr('fill', s.color).attr('font-size', 10.5).attr('font-weight', 600).text(s.label);
            });
        }
    });
}

/**
 * Horizontal bars, two per resource (default and a lighter low case).
 * spec: { rows: [{ label, value, low, color, lowLabel }], format, max }
 */
export function barChart(el, spec) {
    const rowH = 60;
    const margin = { top: 4, right: 60, bottom: 0, left: 0 };
    const height = margin.top + margin.bottom + rowH * spec.rows.length;
    const { g, inner } = frame(el, height, margin);
    const c = ui();
    const x = d3.scaleLinear().domain([0, spec.max]).range([0, inner.w]);
    spec.rows.forEach((r, k) => {
        const top = k * rowH + 18;
        const barH = r.low != null ? 13 : 16;
        // One group per row; the default bar and value carry class bar-value, the low case bar-low
        // (story.html steps through them); drawing unchanged.
        const row = g.append('g').attr('class', 'bar-row').attr('data-row', k);
        row.append('text').attr('x', 0).attr('y', top - 6).attr('fill', c.text).attr('font-size', 12.5).text(r.label);
        row.append('rect').attr('class', 'bar-value').attr('x', 0).attr('y', top).attr('width', Math.max(1.5, x(r.value))).attr('height', barH).attr('fill', r.color);
        row.append('text').attr('class', 'bar-value').attr('x', x(r.value) + 6).attr('y', top + barH - 2).attr('fill', c.text)
            .attr('font-size', 12).attr('font-weight', 600).text(spec.format(r.value));
        if (r.low != null) {
            const ly = top + barH + 3;
            row.append('rect').attr('class', 'bar-low').attr('x', 0).attr('y', ly).attr('width', Math.max(1.5, x(r.low))).attr('height', barH)
                .attr('fill', r.color).attr('opacity', 0.45);
            row.append('text').attr('class', 'bar-low').attr('x', x(r.low) + 6).attr('y', ly + barH - 2).attr('fill', c.muted)
                .attr('font-size', 11).text(`${spec.format(r.low)} ${r.lowLabel || 'low case'}`);
        }
    });
}

/**
 * Dumbbell rows. spec: { rows: [{ label, sub, a, b, note }], max, ticks, format, colorA, colorB, labelA, labelB }
 * `a` (solar + batteries) may be null: then only `b` is drawn, with `note`. A value
 * beyond `max` is drawn as an arrow at the right edge with its value: nothing is
 * drawn outside the plot.
 */
export function dumbbell(el, spec) {
    const narrow = (el.clientWidth || 320) < 480;
    const labelW = narrow ? 96 : 150;
    const rowH = narrow ? 40 : 36;
    const margin = { top: narrow ? 48 : 30, right: narrow ? 46 : 56, bottom: 26, left: labelW };
    const height = margin.top + margin.bottom + rowH * spec.rows.length;
    const { g, inner } = frame(el, height, margin);
    const c = ui();
    const x = d3.scaleLinear().domain([0, spec.max]).range([0, inner.w]);
    const px = v => x(Math.min(v, spec.max));
    spec.ticks.forEach((t) => {
        g.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', -6).attr('y2', inner.h)
            .attr('stroke', t === 0 ? c.axis : c.grid);
        g.append('text').attr('x', x(t)).attr('y', inner.h + 17).attr('text-anchor', 'middle')
            .attr('fill', c.muted).attr('font-size', 11).text(spec.format(t));
    });
    // Key above the rows: the two dots, labelled once.
    const key = g.append('g').attr('transform', `translate(${narrow ? -labelW : 0},${narrow ? -36 : -18})`);
    [[spec.labelA, spec.colorA], [spec.labelB, spec.colorB]].forEach(([label, color], k) => {
        const kx = narrow ? 0 : (k === 0 ? 0 : Math.min(inner.w * 0.5, 150));
        const ky = narrow ? k * 18 : 0;
        key.append('circle').attr('cx', kx + 5).attr('cy', ky).attr('r', 5).attr('fill', color);
        key.append('text').attr('x', kx + 14).attr('y', ky + 4).attr('fill', color).attr('font-size', 12).attr('font-weight', 600).text(label);
    });
    const g0 = g;
    spec.rows.forEach((r, k) => {
        const cy = k * rowH + rowH / 2;
        const g = g0.append('g').attr('class', 'db-row');   // one group per row (story.html shows them in turn)
        g.append('text').attr('x', -10).attr('y', r.sub ? cy - 2 : cy + 4).attr('text-anchor', 'end').attr('fill', c.text)
            .attr('font-size', narrow ? 11.5 : 12.5).text(r.label);
        if (r.sub) {
            g.append('text').attr('x', -10).attr('y', cy + 11).attr('text-anchor', 'end').attr('fill', c.muted)
                .attr('font-size', narrow ? 10 : 10.5).text(r.sub);
        }
        const valueText = (v, xPos, anchor, suffix = '') => g.append('text').attr('x', xPos).attr('y', cy + 4).attr('text-anchor', anchor)
            .attr('fill', c.muted).attr('font-size', 11).text(spec.format(v) + suffix);
        // labelBoth (charts.html, T091): both values are always labelled (they sit on opposite sides of the line, so they
        // never collide); where the two round to the same value, one label says so
        const same = spec.labelBoth && r.a != null && spec.format(r.a) === spec.format(r.b);
        if (r.a != null) {
            g.append('line').attr('x1', px(r.a)).attr('x2', px(r.b)).attr('y1', cy).attr('y2', cy)
                .attr('stroke', c.axis).attr('stroke-width', 2);
            if (r.a > spec.max) {
                // Off the scale: an arrowhead at the edge, the value beside it.
                const xe = x(spec.max);
                g.append('path').attr('d', `M${xe - 9},${cy - 6}L${xe},${cy}L${xe - 9},${cy + 6}Z`).attr('fill', spec.colorA);
                valueText(r.a, xe + 6, 'start');
            } else {
                g.append('circle').attr('cx', px(r.a)).attr('cy', cy).attr('r', 6).attr('fill', spec.colorA);
                const aRight = r.a >= r.b;
                valueText(r.a, px(r.a) + (aRight ? 10 : -10), aRight ? 'start' : 'end', same ? ' either way' : '');
            }
        }
        g.append('circle').attr('cx', px(r.b)).attr('cy', cy).attr('r', 6).attr('fill', spec.colorB);
        if (r.a == null) {
            valueText(r.b, px(r.b) + 10, 'start');
        } else if (!same && (spec.labelBoth || Math.abs(px(r.a) - px(r.b)) > 34)) {
            const bLeft = r.b < r.a;
            valueText(r.b, px(r.b) + (bLeft ? -10 : 10), bLeft ? 'end' : 'start');
        }
    });
}

/**
 * Animated curves: one frame per year, each frame a set of lines (cost against
 * uptime, one per band), moving from year to year. The first year stays as a
 * dashed reference; the current year is drawn in full with direct labels. Play/pause in `controls` (loop: true starts again after the last year); with
 * prefers-reduced-motion, or before play, the final frame is drawn statically
 * with the first year as a dashed reference.
 * spec: { height, x, y, frames: [{ year, series: [{ id, label, color, points }] }], firstLabel }
 */
export function animatedCurves(el, spec, controls) {
    const state = el.__anim || (el.__anim = { k: spec.frames.length - 1, timer: null, playing: false });
    const c = ui();
    const width = Math.max(260, Math.round(el.clientWidth || 320));
    const labelW = spec.labelWidth ?? 74;
    const margin = { top: 14, right: labelW, bottom: 40, left: 40 };
    el.innerHTML = '';
    const svg = svgIn(el, width, spec.height || 280);
    const inner = { w: width - margin.left - margin.right, h: (spec.height || 280) - margin.top - margin.bottom };
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    const x = d3.scaleLinear().domain(spec.x.domain).range([4, inner.w - 4]);
    const y = d3.scaleLinear().domain(spec.y.domain).range([inner.h, 0]);
    yGrid(g, y, inner.w, spec.y.ticks, spec.y.format);
    xAxis(g, x, inner.h, spec.x.ticks, spec.x.format);
    if (spec.xTitle) {
        g.append('text').attr('x', inner.w / 2).attr('y', inner.h + 34).attr('text-anchor', 'middle').attr('fill', c.muted).attr('font-size', 11).text(spec.xTitle);
    }
    const line = d3.line().x(d => x(d[0])).y(d => y(d[1]));
    const ref = g.append('g');
    const cur = g.append('g');
    const yearText = g.append('text').attr('x', 8).attr('y', 22).attr('fill', c.text).attr('font-size', 22).attr('font-weight', 600);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function draw(k, animate) {
        state.k = k;
        const f = spec.frames[k];
        yearText.text(f.year);
        // The first year as a dashed neutral reference once the curves have moved (one colour, so it
        // never reads as a band: T077 colour check).
        ref.selectAll('path').data(k > 0 ? spec.frames[0].series : []).join('path')
            .attr('fill', 'none').attr('stroke', c.muted).attr('stroke-opacity', 0.6).attr('stroke-width', 1.25)
            .attr('stroke-dasharray', '3 3').attr('d', d => line(d.points.filter(q => Number.isFinite(q[1]))));
        const paths = cur.selectAll('path').data(f.series, d => d.id).join('path')
            .attr('fill', 'none').attr('stroke', d => d.color).attr('stroke-width', 2.5).attr('stroke-linejoin', 'round');
        const t = animate ? paths.transition().duration(700).ease(d3.easeCubicInOut) : paths;
        t.attr('d', d => line(d.points.filter(q => Number.isFinite(q[1]))));
        const labels = spread(f.series.map(s => {
            const pts = s.points.filter(q => Number.isFinite(q[1]));
            return { id: s.id, y: y(pts[pts.length - 1][1]), text: s.label, color: s.color };
        }), 13, 4, inner.h);
        const lt = cur.selectAll('text').data(labels, d => d.id).join('text')
            .attr('x', inner.w + 8).attr('fill', d => d.color).attr('font-size', 11.5).attr('font-weight', 600).text(d => d.text);
        (animate ? lt.transition().duration(700) : lt).attr('y', d => d.y + 4);
        if (k > 0 && spec.firstLabel) {
            ref.selectAll('text').data([0]).join('text').attr('x', inner.w).attr('y', -2)
                .attr('text-anchor', 'end').attr('fill', c.muted).attr('font-size', 10.5).text(spec.firstLabel);
        } else ref.selectAll('text').remove();
    }

    function stop() {
        clearInterval(state.timer);
        state.timer = null;
        state.playing = false;
        if (controls?.button) { controls.button.textContent = 'Play'; controls.button.setAttribute('aria-pressed', 'false'); }
    }
    function play() {
        if (reduced) { draw(spec.frames.length - 1, false); return; }
        state.playing = true;
        if (controls?.button) { controls.button.textContent = 'Pause'; controls.button.setAttribute('aria-pressed', 'true'); }
        if (state.k >= spec.frames.length - 1) draw(0, false);
        state.timer = setInterval(() => {
            if (state.k >= spec.frames.length - 1) {
                if (!controls?.loop) { stop(); return; }
                // Loop: hold the last year a beat, then start again from the first.
                if ((state.hold = (state.hold || 0) + 1) < 3) return;
                state.hold = 0;
                draw(0, false);
                return;
            }
            draw(state.k + 1, true);
        }, 1100);
    }
    if (controls?.button && !controls.button.__wired) {
        controls.button.__wired = true;
        controls.button.addEventListener('click', () => (el.__anim.playing ? el.__anim.stop() : el.__anim.play()));
    }
    state.play = play;
    state.stop = stop;
    state.draw = draw;            // draw(frame, animate): story.html sets the year from the scroll position
    state.frames = spec.frames.length;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    draw(reduced ? spec.frames.length - 1 : state.k, false);
    if (state.playing && !reduced) { state.playing = false; play(); }
    if (controls?.button) controls.button.hidden = reduced;
    return state;
}

/**
 * Stacked histogram (T091 round 6, as the atlas tool's "capacity to displace" histogram). spec: { height,
 * series: [{ label, color }], bins: [{ x0, x1, values: [one per series] }], x: { domain, ticks, format },
 * y: { ticks, format }, marker: { x, label } (one dashed line with its label at the top: the chart's annotation) }.
 */
export function histogram(el, spec) {
    const narrow = (el.clientWidth || 600) < 480;
    const margin = { top: 22, right: 10, bottom: spec.xTitle ? 42 : 24, left: 38 };
    const { g, inner } = frame(el, (spec.height || (narrow ? 240 : 290)) + (spec.xTitle ? 18 : 0), margin);
    const c = ui();
    const x = d3.scaleLinear().domain(spec.x.domain).range([0, inner.w]);
    if (spec.xTitle) g.append('text').attr('x', inner.w / 2).attr('y', inner.h + 36).attr('text-anchor', 'middle').attr('fill', c.muted).attr('font-size', 11.5).text(spec.xTitle);
    const top = spec.y.ticks[spec.y.ticks.length - 1];
    const y = d3.scaleLinear().domain([0, top]).range([inner.h, 0]);
    yGrid(g, y, inner.w, spec.y.ticks, spec.y.format);
    const gap = inner.w / ((spec.x.domain[1] - spec.x.domain[0]) / (spec.bins[0].x1 - spec.bins[0].x0)) > 10 ? 1 : 0.5;
    // The marker is a range, not a point (review, T091 round 9: a dashed line reads as one value, but its label is about
    // all the bars below it): a light band behind the bars up to marker.x, a bracket over it and the label above
    if (spec.marker) {
        const mx = x(spec.marker.x);
        g.append('rect').attr('class', 'hist-range').attr('x', 0).attr('y', -6).attr('width', mx).attr('height', inner.h + 6)
            .attr('fill', c.text).attr('fill-opacity', 0.06);
    }
    spec.bins.forEach((b) => {
        let base = 0;
        b.values.forEach((v, k) => {
            if (!(v > 0)) return;
            g.append('rect').attr('class', 'hist-bar').attr('x', x(b.x0) + gap / 2).attr('width', Math.max(0.5, x(b.x1) - x(b.x0) - gap))
                .attr('y', y(base + v)).attr('height', Math.max(0, y(base) - y(base + v))).attr('fill', spec.series[k].color);
            base += v;
        });
    });
    xAxis(g, x, inner.h, narrow ? spec.x.ticks.filter((_, k) => k % 2 === 0) : spec.x.ticks, spec.x.format);
    if (spec.marker) {
        const mx = x(spec.marker.x);
        g.append('path').attr('d', `M0.5,-2V-6H${mx - 0.5}V-2`).attr('fill', 'none').attr('stroke', c.text).attr('stroke-width', 1);
        g.append('text').attr('x', 2).attr('y', -11).attr('text-anchor', 'start')
            .attr('fill', c.text).attr('font-size', 12).attr('font-weight', 600).text(spec.marker.label);
    }
    if (!spec.noKey) chartKey(el, spec.series);   // noKey: one series, named by the title
}
