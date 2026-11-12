// story-sets.js – the morph's dot sets, one per segment that turns its map into a chart (T087 design v3).
// (story-morph.js orders the tiles inside a bar by colour, lightest on top; section 6 stacks its tiers.)
// Each set names its regions, the weight that sizes a tile and its layouts, each pile layout with its chart head (title,
// subtitle with units, legend; story-morph.js draws it); every number on the axes is computed here
// from the same data the map draws (story-cells.json and the summary), so the chart and the map cannot disagree.
import { storyLayer, storyLegend } from './story-layers.js';

// Cost bins of an even $20 (the human, T091 round 9: uneven bins drawn at one width misled), open at both ends
const COST_BINS = [[0, 60, '<60'], [60, 80, '60–80'], [80, 100, '80–100'], [100, 120, '100–120'], [120, 140, '120–140'],
    [140, 160, '140–160'], [160, 180, '160–180'], [180, 200, '180–200'], [200, Infinity, '200+']];
const token = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const binOf = (bins, v) => (Number.isFinite(v) ? bins.findIndex(([a, b]) => v >= a && v < b) : -1);
const pctOf = x => `${Math.round(x * 100)}%`;

/** A small key of coloured labels (the value labels above the bars use the same colours, so no arrows or notes). */
const key = (items) => '<div class="legend-chips">' + items.map(([c, t]) => `<div class="legend-chip"><i style="background:${c}"></i>${t}</div>`).join('') + '</div>';

/** The cost piles' range under $100/MWh (the first three bins) as a faint band, labelled with its share (review, T091
 * round 9: a range, not a line). share: a fraction, or null. */
const under100 = (share) => (sel, geom) => {
    const { P, x0, colW, gap } = geom;
    // the band's label sits above the bars' value labels (between the head and the tallest bar's label)
    const x1 = x0 + 3 * (colW + gap) - gap / 2, top = P.y0 - 40;
    sel.append('rect').attr('x', x0 - 6).attr('y', top).attr('width', x1 - x0 + 6).attr('height', P.y1 - top)
        .attr('fill', token('--map-text')).attr('fill-opacity', 0.07).attr('rx', 2);
    sel.append('text').attr('x', x0).attr('y', top + 13).attr('fill', token('--map-text')).attr('font-size', colW < 44 ? 10.5 : 12.5)
        .attr('font-weight', 600).text(`Under $100/MWh${share == null ? '' : `: ${pctOf(share)}`}`);
};

/** A pile chart's axes (the human, T091 round 9: "what is on the horizontal axis? put it next to it"; least text):
 * group labels under the bars and the axis title under them; above each bar its value, either the bar's share of the
 * whole (share: true) or above(k) = [[text, colour], …], coloured as the head's key; extra(sel, geom) adds more. */
function pileAxes(labels, { xTitle, share = false, above = null, extra = null } = {}) {
    return (g, geom, sel) => {
        const { P, x0, colW, gap, heights, totals } = geom;
        const narrow = colW < 44;                 // phone
        const ink = token('--map-text'), muted = token('--map-muted');
        const right = x0 + labels.length * (colW + gap) - gap;
        extra?.(sel, geom);
        sel.append('line').attr('x1', x0 - 6).attr('x2', right + 6).attr('y1', P.y1 + 0.5).attr('y2', P.y1 + 0.5).attr('stroke', muted).attr('stroke-opacity', 0.6);
        const fs = narrow ? 9.5 : 11.5;
        labels.forEach((l, k) => {
            const cx = x0 + k * (colW + gap) + colW / 2;
            sel.append('text').attr('x', cx).attr('y', P.y1 + 15).attr('text-anchor', 'middle').attr('fill', muted).attr('font-size', fs).text(l);
            const sum = totals.reduce((a, b) => a + b, 0);
            const f = totals[k] / sum;
            if (share && !(f > 0)) return;              // an empty bin: no label
            const parts = share ? [[f < 0.005 ? '<1%' : pctOf(f), ink]] : above?.(k);
            if (!parts) return;
            const t = sel.append('text').attr('x', cx).attr('y', P.y1 - heights[k] - 7).attr('text-anchor', 'middle').attr('font-size', narrow ? 10 : 12.5).attr('font-weight', 600);
            parts.forEach(([txt, col], q) => t.append('tspan').attr('fill', col).text((q ? ' ' : '') + txt));
        });
        if (xTitle) sel.append('text').attr('x', (x0 + right) / 2).attr('y', P.y1 + (narrow ? 30 : 33)).attr('text-anchor', 'middle')
            .attr('fill', ink).attr('font-size', narrow ? 10.5 : 12.5).text(xTitle);
    };
}

export function defineSets(morph, d, rows) {
    const S = d.story, c = d.cells, V = d.values;
    const all = rows.map(r => r.i);
    const dem = i => S.demand[i] || 0, pop = i => S.pop[i] || 0;
    const mapR = (wMax, rMax) => (i, k, w) => Math.max(0.6, rMax * Math.sqrt(Math.max(0, w(i)) / wMax)) * Math.min(2.2, Math.sqrt(k));
    const maxOf = (items, f) => items.reduce((m, i) => Math.max(m, f(i)), 0);
    const fillOf = (state, year = 2026) => storyLayer(state, d, year).fill;
    const colour = (state, year = 2026) => { const f = fillOf(state, year); return i => f(rows[i]) || token('--map-land'); };
    const legend = (state, year = 2026) => storyLegend(state, d, year);
    const shareOf = (items, w, test) => { let a = 0, b = 0; for (const i of items) { b += w(i); if (test(i)) a += w(i); } return b > 0 ? a / b : NaN; };

    // The heads (the human, T091 round 9: least text): a short title, the bar's measure with its unit as the subtitle,
    // the x axis titled under the bars, values on the bars; a key only where label colours need one. No colour legend
    // where the tiles' colour repeats the x axis.
    const grey = token('--map-muted'), green = token('--g3');
    // 1. The shift: tiles sized by demand into a histogram of the cost of 90% uptime, without and then with wind
    {
        const items = all.filter(i => c.mapCell[i] && dem(i) > 0 && Number.isFinite(S.c90sb[i]));
        // the band's share is the summary's (T089 s1.under100.*), the number the text gives; the tiles are the same regions
        const hist = (k, state, shareKey, title) => ({
            kind: 'pile', state, colour: colour(state), groups: COST_BINS.map(b => b[2]), group: i => binOf(COST_BINS, S[k][i]), order: i => S[k][i],
            head: { title, sub: 'Share of world electricity demand' },
            axes: pileAxes(COST_BINS.map(b => b[2]), { xTitle: 'Cost of 90% uptime ($/MWh)', share: true, extra: under100(V[shareKey]) })
        });
        morph.define('s1', { items, weight: dem, mapRadius: mapR(maxOf(items, dem), 16), layouts: {
            'hist-sb': hist('c90sb', 'cost-sb', 's1.under100.sb.demand.90', 'Solar and batteries alone'),
            'hist-w': hist('c90', 'cost-wind', 's1.under100.sbw.demand.90', 'With wind added') } });
    }
    // T101: sections 2, 5, 7 and 8's morphs (latitude bands, people by cost, wind to add, the 99% saving to 2050) are gone with
    // the charts they made; section 1's is the one the text still uses
}
