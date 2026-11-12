// article-charts.js – the article's round-8 charts (T091, D-170), drawn the same way on both versions of the article:
// charts.html (charts-page.js, static) and the scrolly index.html (story.js, with the scroll motion of story-charts.js).
// One copy, so the two versions cannot drift apart. Every function takes a context:
//   ctx.el(id)        the chart's node ([data-chart="id"]) or null (a chart missing from the page is skipped)
//   ctx.tracked(id)   the summary's values, recording each key the chart reads (a missing key is an error)
//   ctx.token(name)   a CSS custom property of the page
//   ctx.state         the page's window.__article: errors, and the checks' readouts (plannedHist, peopleHist, latPeople)
import { nf } from './format.js';
import { chartKey, histogram, linePanels, css } from './charts.js';
import { groupedBars } from './story-charts.js';

const usd = x => `$${nf.format(Math.round(x))}`;
const pct = x => `${Math.round(x * 100)}%`;
// Bands of absolute latitude (model.js ABS_BANDS), high latitude first, as story-charts.js
const BANDS = [['a55p', '55°+'], ['a45_55', '45–55°'], ['a30_45', '30–45°'], ['a15_30', '15–30°'], ['a0_15', '0–15°']];

/** The summary-only charts: section 1's saving by latitude and uptime, section 7's countries, section 8's bands. */
export function drawSummaryCharts(ctx) {
    const { el, tracked, token } = ctx;
    const narrow = ((el('latsave') || el('multcountries') || el('bandsave') || el('backupbands'))?.clientWidth || 600) < 480;

    // Section 1 (T091 round 6, the human): the saving from adding wind by band of latitude, 50% to 99% uptime
    // (lb.saving.<band>.<T>.2026: demand-weighted median where both builds reach the target), one line per band
    if (el('latsave')) {
        const v = tracked('latsave');
        const TS = [50, 60, 70, 75, 80, 85, 90, 95, 97, 99], TOP = 200;
        const series = BANDS.map(([id, label], k) => {
            const points = TS.map(t => [t, v[`lb.saving.${id}.${t}.2026`]]);
            // the human: cap the axis at $200; the far north runs off it (linePanels writes its 99% value where it leaves)
            const last = points[points.length - 1][1];
            return { label: last > TOP ? `${label} ↑ ${usd(last)}` : `${label} ${usd(last)}`, color: token(`--c-lat-${k + 1}`), points };
        });
        const top = TOP;
        linePanels(el('latsave'), {
            height: narrow ? 220 : 260, labelWidth: narrow ? 100 : 120, noEndMarker: true, endLabels: 'all', offscaleNote: false, xTitle: 'Uptime',
            x: { domain: [50, 99], ticks: narrow ? [50, 70, 90, 99] : [50, 60, 70, 80, 90, 99], format: t => `${t}%` },
            y: { domain: [0, top], ticks: d3.range(0, top + 1, 50), format: usd },
            panels: [{ title: '', series }]
        });
    }

    // Section 7 (the human, T091 round 4): countries whose wind potential on their own land and coast is at least 1, 2, 5
    // and 10 times their national electricity demand, conservative and technical cases (s7.<case>.<k>x.countriesNational,
    // of s7.countries); national, so it does not depend on how the atlas draws its regions
    if (el('multcountries')) {
        const v = tracked('multcountries');
        const n = x => nf.format(Math.round(x));
        groupedBars(el('multcountries'), {
            horizontal: true, barH: 11,   // tall enough that the two value labels of a row never touch, phones included
            series: [{ label: 'Conservative case', color: token('--c-wind') }, { label: 'Technical case', color: token('--c-tier130') }],
            max: 180, ticks: [0, 30, 60, 90, 120, 150, 180], format: n,
            panels: [{ groups: [1, 2, 5, 10].map(k => ({ label: `At least ${k}×`, values: ['cons', 'tech'].map(c => v[`s7.${c}.${k}x.countriesNational`]) })) }]
        });
    }

    // Section 8: the saving from wind by band of latitude, 2026 and 2050. T100 (the human, 9 Nov 2026: "the 90% case"): on
    // power every hour of the year, the 90% build with diesel or gas backup (s8bk.band.*, derive_t100.py); before, 99%
    // uptime (s8.band.*, T090), which the scrolly's section 8 morph still uses
    if (el('bandsave')) {
        const v = tracked('bandsave');
        groupedBars(el('bandsave'), {
            series: [{ label: '2026', color: token('--c-context') }, { label: '2050', color: token('--c-wind') }],
            max: 150, ticks: [0, 50, 100, 150], format: usd, labelMin: 15,
            panels: [{ groups: BANDS.map(([id, label]) => ({ label, values: [2026, 2050].map(Y => v[`s8bk.band.${id}.saving.${Y}`]) })) }]
        });
    }

    // The summary's last chart (T100, Kingsmill Bond's comment 4, approved by the human, 9 Nov 2026): the uptime ladder – the
    // world's demand-weighted median cost as uptime rises, solar and batteries against with wind (ladder.*, derive_ladder.py
    // on run_story.mjs's runs), and every hour of the year with backup as separate points
    if (el('ladder')) {
        const v = tracked('ladder');
        const node = el('ladder');
        const TS = [25, 30, 40, 50, 60, 70, 80, 90, 95, 99];
        const series = [{ id: 'sb', label: 'Solar + batteries', color: token('--c-sb') }, { id: 'sbw', label: 'Solar + batteries + wind', color: token('--c-wind') }];
        const pts = series.map(s => ({ ...s, line: TS.map(t => [t, v[`ladder.${s.id}.${t}`]]), every: v[`ladder.${s.id}.100`] }));
        ctx.state.ladder = Object.fromEntries(pts.map(p => [p.id, { line: p.line.map(([, y]) => y), every: p.every }]));
        ladderChart(node, { series: pts, max: 200, ticks: [0, 50, 100, 150, 200] });
    }

    // Section 4 (T100, the human, 9 Nov 2026: in place of the cost split): power every hour of the year by the uptime the
    // renewable build reaches, gas or diesel backup for the rest; world demand-weighted averages (ladder.bk.*, derive_ladder.py)
    if (el('bkcurve')) {
        const v = tracked('bkcurve');
        const TS = [60, 70, 80, 90, 95, 99];
        const series = [{ id: 'sb', label: 'Solar + batteries', color: token('--c-sb') }, { id: 'sbw', label: 'Solar + batteries + wind', color: token('--c-wind') }];
        const pts = series.map(s => ({ ...s, line: TS.map(t => [t, v[`ladder.bk.${s.id}.${t}`]]) }));
        ctx.state.bkcurve = Object.fromEntries(pts.map(p => [p.id, p.line.map(([, y]) => y)]));
        // the human's point: with wind the build reaches 95% for what solar and batteries pay for 80% (a dashed guide at that cost)
        const guide = { from: '80%', to: '95%', v: v['ladder.bk.sb.80'], w: v['ladder.bk.sbw.95'], label: 'Same cost' };
        ctx.state.bkcurve.guide = [guide.v, guide.w];
        ladderChart(el('bkcurve'), { series: pts, max: 250, ticks: [0, 50, 100, 150, 200, 250], xTitle: 'Uptime of the renewable build', guide });
    }

    // Section 4 (T100, the human chose "show the cost split", 9 Nov 2026): the cost of power every hour of the year (the 90%
    // build with diesel or gas backup) split into the renewable part and the backup, solar and batteries alone against with
    // wind; the world, then by band of absolute latitude (s4bk.*, derive_t100.py: demand-weighted means, so the parts add up)
    if (el('backupbands')) {
        const v = tracked('backupbands');
        const node = el('backupbands');
        const builds = [{ id: 'sb', label: 'Solar + batteries', color: token('--c-sb') }, { id: 'sbw', label: 'Solar + batteries + wind', color: token('--c-wind') }];
        const backup = { label: 'Backup', color: token('--c-gas') };
        const groups = [['world', 'World'], ...BANDS].map(([id, label]) => ({ label, bars: builds.map(b => ({ ...b, renew: v[`s4bk.${id}.${b.id}.renew`], backup: v[`s4bk.${id}.${b.id}.backup`] })) }));
        splitBars(node, { keys: [...builds, backup], backupColor: backup.color, groups, max: 200, ticks: [0, 50, 100, 150, 200] });
    }
}

// Section 6 (T091 round 6, the human: "the histogram chart from the tool"): planned coal and gas by the cost of power
// every hour in its region, from the cheapest solar, wind and battery build for 90% uptime (story-cells c100) with
// diesel or gas backup for the rest, in $5/MWh bands, as a share of all planned capacity; stacked coal and gas
// (story-planned.json, scripts/article/tools/planned-split.py). The totals must equal the summary's s6.planned.*; the
// marker gives the share below $100/MWh.
export function drawPlannedHist(ctx, d) {
    const { el, tracked, token, state } = ctx;
    const LO = 50, HI = 175, W = 5;
    const one = (id, cost) => {
        if (!el(id) || !d.planned || !cost) return;
        const v = tracked(id);
        const total = v['s6.planned.gw'], { coal, gas } = d.planned;
        const bins = d3.range(LO, HI, W).map(x0 => ({ x0, x1: x0 + W, values: [0, 0] }));
        let sumC = 0, sumG = 0, below = 0;
        for (let i = 0; i < coal.length; i++) {
            const p = coal[i] + gas[i];
            if (!(p > 0)) continue;
            sumC += coal[i]; sumG += gas[i];
            if (!Number.isFinite(cost[i])) { state.errors.push(`${id}: planned capacity in region ${i} with no cost`); continue; }
            if (cost[i] < 100) below += p;
            const b = bins[Math.min(bins.length - 1, Math.max(0, Math.floor((cost[i] - LO) / W)))];
            b.values[0] += coal[i] / total; b.values[1] += gas[i] / total;
        }
        if (Math.abs(sumC - v['s6.planned.coal.gw']) > 0.5 || Math.abs(sumG - v['s6.planned.gas.gw']) > 0.5) {
            state.errors.push(`${id}: coal ${sumC} GW, gas ${sumG} GW, not the summary's`);
        }
        (state.plannedHist ||= {})[id] = { coal: sumC, gas: sumG, below100: below / total };
        histogram(el(id), {
            series: [{ label: 'Planned coal', color: token('--c-coal') }, { label: 'Planned gas', color: token('--c-gas') }],
            bins, xTitle: 'Cost of firm solar and wind power where it is planned ($/MWh)', x: { domain: [LO, HI], ticks: d3.range(LO, HI + 1, 25), format: x => `$${x}` },
            y: { ticks: [0, 0.05, 0.1, 0.15, 0.2, 0.25], format: t => `${Math.round(t * 100)}%` },
            marker: { x: 100, label: `${pct(below / total)} below $100/MWh` }
        });
    };
    one('planhist', d.story.c100);
    // one('planhist95', d.backup95): the 95% version (story-backup95.json), tried and dropped (the human: keep 90%)
}

/** T100: the uptime ladder: a line per build over the uptime targets (an even step per target, as a ladder), then a gap and
 *  "Every hour" as a point per build; the value written at 99% and at every hour. */
function ladderChart(node, spec) {
    node.innerHTML = '';
    chartKey(node, spec.series.map(s => ({ color: s.color, label: s.label })));
    const c = { text: css('--text'), muted: css('--muted'), grid: css('--grid'), axis: css('--axis') };
    const width = Math.max(280, Math.round(node.clientWidth || 320)), narrow = width < 520;
    const m = { top: 12, right: narrow ? 30 : 40, bottom: 34, left: 40 }, ph = narrow ? 200 : 240;
    const h = m.top + ph + m.bottom;
    const svg = d3.select(node).append('svg').attr('role', 'img').attr('viewBox', `0 0 ${width} ${h}`).attr('width', width).attr('height', h)
        .attr('aria-label', node.closest('figure')?.querySelector('.chart-title')?.textContent.trim() || 'Chart').style('font-family', 'var(--font-sans)');
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    const TS = spec.series[0].line.map(([t]) => t);
    const hasEvery = spec.series.every(s => Number.isFinite(s.every));   // T100: the backup curve has no separate point
    const cats = hasEvery ? [...TS.map(t => `${t}%`), '', 'Every hour'] : TS.map(t => `${t}%`);
    const x = d3.scalePoint().domain(cats).range([0, width - m.left - m.right]).padding(0.3);
    const y = d3.scaleLinear().domain([0, spec.max]).range([ph, 0]);
    spec.ticks.forEach((t) => {
        g.append('line').attr('x1', 0).attr('x2', width - m.left - m.right).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', t === 0 ? c.axis : c.grid);
        g.append('text').attr('x', -6).attr('y', y(t) + 4).attr('text-anchor', 'end').attr('fill', c.muted).attr('font-size', 10.5).text(usd(t));
    });
    cats.forEach((k, i) => {
        if (!k) return;
        const show = !narrow || [0, 3, 7, 9].includes(i) || k === 'Every hour';
        if (show) g.append('text').attr('x', x(k)).attr('y', ph + 15).attr('text-anchor', 'middle').attr('fill', c.muted).attr('font-size', narrow ? 9.5 : 10.5).text(k === 'Every hour' && narrow ? 'Every hr' : k);
    });
    g.append('text').attr('x', (x(`${TS[0]}%`) + x('99%')) / 2).attr('y', ph + 30).attr('text-anchor', 'middle').attr('fill', c.muted).attr('font-size', 10.5).text(spec.xTitle || 'Uptime');
    spec.series.forEach((s) => {
        const line = d3.line().x(([t]) => x(`${t}%`)).y(([, v]) => y(Math.min(v, spec.max)));
        g.append('path').attr('d', line(s.line)).attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2.25);
        s.line.forEach(([t, v]) => g.append('circle').attr('cx', x(`${t}%`)).attr('cy', y(v)).attr('r', 2.5).attr('fill', s.color));
        if (hasEvery) g.append('circle').attr('cx', x('Every hour')).attr('cy', y(s.every)).attr('r', 4.5).attr('fill', s.color);
    });
    // values at 99% and at every hour, the higher of each pair above its point, the lower below
    const label = (k, vals) => {
        const [lo, hi] = [...vals].sort((a, b) => a.v - b.v);
        g.append('text').attr('class', 'ladder-val').attr('x', x(k)).attr('y', y(hi.v) - 8).attr('text-anchor', 'middle').attr('fill', c.text).attr('font-size', 10.5).text(usd(hi.v));
        // the lower value right of its point at 99% (clear of the rising line), below it at every hour
        const left = k === '99%';
        g.append('text').attr('class', 'ladder-val').attr('x', x(k) + (left ? 8 : 0)).attr('y', left ? y(lo.v) + 4 : y(lo.v) + 16).attr('text-anchor', left ? 'start' : 'middle').attr('fill', c.text).attr('font-size', 10.5).text(usd(lo.v));
    };
    label('99%', spec.series.map(s => ({ v: s.line[s.line.length - 1][1] })));
    if (spec.guide) {   // a light dashed line between two points at (about) the same cost, with a short label
        const gd = spec.guide, gy = y(gd.v);
        g.append('line').attr('class', 'ladder-guide').attr('x1', x(gd.from)).attr('x2', x(gd.to)).attr('y1', gy).attr('y2', gy).attr('stroke', c.muted).attr('stroke-dasharray', '4 3').attr('stroke-width', 1.25);
        g.append('text').attr('class', 'ladder-guide').attr('x', (x(gd.from) + x(gd.to)) / 2).attr('y', gy - 6).attr('text-anchor', 'middle').attr('fill', c.muted).attr('font-size', 10.5).text(`${gd.label}, ${usd(gd.v)}`);
    }
    if (hasEvery) label('Every hour', spec.series.map(s => ({ v: s.every })));
    else {   // the first point's values, left of the line
        const first = spec.series.map(s => s.line[0][1]).sort((a, b) => a - b);
        g.append('text').attr('class', 'ladder-val').attr('x', x(cats[0])).attr('y', y(first[1]) - 8).attr('text-anchor', 'middle').attr('fill', c.text).attr('font-size', 10.5).text(usd(first[1]));
        g.append('text').attr('class', 'ladder-val').attr('x', x(cats[0])).attr('y', y(first[0]) + 16).attr('text-anchor', 'middle').attr('fill', c.text).attr('font-size', 10.5).text(usd(first[0]));
    }
}

/** T100: horizontal bars, two per group (without and with wind), each split into its renewable part (the build's colour)
 *  and its backup (one colour, its value written inside when it fits); the total at the bar's end; a bar past `max` is cut
 *  at the axis and its total marked with an arrow. */
function splitBars(node, spec) {
    node.innerHTML = '';
    chartKey(node, spec.keys.map(k => ({ color: k.color, label: k.label })));
    const c = { text: css('--text'), muted: css('--muted'), grid: css('--grid'), axis: css('--axis') };
    const width = Math.max(280, Math.round(node.clientWidth || 320)), narrow = width < 520;
    const labelW = narrow ? 64 : 96, barH = narrow ? 12 : 14, gap = 3, rowH = 2 * barH + gap + (narrow ? 12 : 16);
    const m = { top: 4, right: 48, bottom: 22, left: labelW };
    const h = m.top + m.bottom + rowH * spec.groups.length;
    const svg = d3.select(node).append('svg').attr('role', 'img').attr('viewBox', `0 0 ${width} ${h}`).attr('width', width).attr('height', h)
        .attr('aria-label', node.closest('figure')?.querySelector('.chart-title')?.textContent.trim() || 'Chart').style('font-family', 'var(--font-sans)');
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    const x = d3.scaleLinear().domain([0, spec.max]).range([0, width - m.left - m.right]);
    spec.ticks.forEach((t) => {
        g.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', 0).attr('y2', rowH * spec.groups.length).attr('stroke', t === 0 ? c.axis : c.grid);
        g.append('text').attr('x', x(t)).attr('y', rowH * spec.groups.length + 15).attr('text-anchor', 'middle').attr('fill', c.muted).attr('font-size', 10.5).text(usd(t));
    });
    spec.groups.forEach((gr, k) => {
        const row = g.append('g').attr('class', 'sb-row').attr('transform', `translate(0,${k * rowH})`);
        row.append('text').attr('x', -8).attr('y', barH + 4).attr('text-anchor', 'end').attr('fill', c.text).attr('font-size', narrow ? 11 : 12).text(gr.label);
        gr.bars.forEach((b, j) => {
            const y = j * (barH + gap), total = b.renew + b.backup, cut = total > spec.max;
            const xr = x(Math.min(b.renew, spec.max)), xt = x(Math.min(total, spec.max));
            row.append('rect').attr('x', 0).attr('y', y).attr('width', Math.max(1, xr)).attr('height', barH).attr('fill', b.color);
            if (xt > xr) row.append('rect').attr('x', xr).attr('y', y).attr('width', xt - xr).attr('height', barH).attr('fill', spec.backupColor);
            if (xt - xr >= 24) row.append('text').attr('class', 'sb-backup').attr('x', (xr + xt) / 2).attr('y', y + barH - 3).attr('text-anchor', 'middle').attr('fill', css('--panel')).attr('font-size', 9.5).text(usd(b.backup));
            row.append('text').attr('class', 'sb-total').attr('x', xt + 4).attr('y', y + barH - 3).attr('fill', c.text).attr('font-size', 10.5).text(cut ? `${usd(total)} →` : usd(total));
        });
    });
}

// Section 5 (the human, 6 Nov 2026), in place of the population cartogram and the land/people/demand chart:
// (a) pophist: the share of the world's people by the cost of power every hour where they live (story-cells c100: the
//     cheapest solar, wind and battery build for 90% uptime with diesel or gas backup for the rest), in $5/MWh bands;
//     the people-weighted median must equal the summary's s4.total.sbw.people (the text's number);
// (b) latpeople: by 5° band of latitude, the share of people (bars, left) and the people-weighted median cost of 90%
//     uptime without and with wind (lines, right; story-cells c90sb, c90), on one latitude axis.
export function wmedian(pairs) {
    const s = pairs.filter(([c, w]) => Number.isFinite(c) && w > 0).sort((a, b) => a[0] - b[0]);
    const tot = s.reduce((t, [, w]) => t + w, 0);
    let acc = 0;
    for (const [c, w] of s) { acc += w; if (acc >= tot / 2) return c; }
    return NaN;
}

export function drawPeopleCharts(ctx, d) {
    const { el, tracked, token, state } = ctx;
    const S = d.story, lat = d.cells.lat, n = lat.length;
    if (!S?.pop) return;
    let P = 0;
    for (let i = 0; i < n; i++) if (S.pop[i] > 0) P += S.pop[i];
    if (el('pophist')) {
        const v = tracked('pophist');
        const LO = 40, HI = 180, W = 5;
        const bins = d3.range(LO, HI, W).map(x0 => ({ x0, x1: x0 + W, values: [0] }));
        let below = 0, nocost = 0;
        for (let i = 0; i < n; i++) {
            const p = S.pop[i], c = S.c100[i];
            if (!(p > 0)) continue;
            if (!Number.isFinite(c)) { nocost += p; continue; }
            if (c < 100) below += p;
            bins[Math.min(bins.length - 1, Math.max(0, Math.floor((c - LO) / W)))].values[0] += p / P;
        }
        if (nocost > 0) state.errors.push(`pophist: ${Math.round(nocost)} people in regions with no cost`);
        const med = wmedian(Array.from(S.c100, (c, i) => [c, S.pop[i]]));
        if (Math.abs(med - v['s4.total.sbw.people']) > 1) state.errors.push(`pophist: people-weighted median ${med}, the summary's s4.total.sbw.people ${v['s4.total.sbw.people']}`);
        state.peopleHist = { below100: below / P, median: med };
        histogram(el('pophist'), {
            series: [{ label: 'Solar + batteries + wind, with backup', color: token('--c-wind') }], noKey: true,
            bins, xTitle: 'Cost of firm solar and wind power ($/MWh)', x: { domain: [LO, HI], ticks: d3.range(LO, HI + 1, 20), format: x => `$${x}` },
            y: { ticks: [0, 0.05, 0.1, 0.15, 0.2], format: t => `${Math.round(t * 100)}%` },
            marker: { x: 100, label: `${pct(below / P)} of people below $100/MWh` }
        });
    }
    if (el('latpeople')) {
        // T100 (the human, 9 Nov 2026): weighted by electricity demand, not people – the bars and the band medians of both
        // cost lines (the article uses demand weighting from section 2 on)
        const LO = -55, HI = 75, STEP = 5, MIN_SHARE = 0.001;   // costs only where a band holds at least 0.1% of the demand
        // and (the human, 9 Nov 2026) the share of people in each band beside the share of demand
        const bands = d3.range(LO, HI, STEP).map(lo => ({ lo, hi: lo + STEP, mid: lo + STEP / 2, p: 0, pp: 0, sb: [], w: [] }));
        let DT = 0;
        for (let i = 0; i < n; i++) {
            const b = bands[Math.min(bands.length - 1, Math.max(0, Math.floor((lat[i] - LO) / STEP)))];
            if (S.pop[i] > 0) b.pp += S.pop[i];
            const p = S.demand[i];
            if (!(p > 0)) continue;
            DT += p;
            b.p += p; b.sb.push([S.c90sb[i], p]); b.w.push([S.c90[i], p]);
        }
        for (const b of bands) { b.share = b.p / DT; b.popShare = b.pp / P; b.costSb = b.share >= MIN_SHARE ? wmedian(b.sb) : NaN; b.costW = b.share >= MIN_SHARE ? wmedian(b.w) : NaN; }
        state.latPeople = bands.map(({ lo, share, popShare, costSb, costW }) => ({ lo, share, popShare, costSb, costW }));
        // (the people bars were tried beside the demand and dropped: the human, 9 Nov 2026; latitudeProfile can still draw them)
        latitudeProfile(el('latpeople'), { bands, LO, HI, maxCost: 300, shareTitle: ['Demand (%)', 'Share of electricity demand (%)'],
            people: { label: 'Share of electricity demand', color: token('--c-people') },
            series: [{ key: 'costSb', label: 'Solar + batteries', color: token('--c-sb') }, { key: 'costW', label: 'Solar + batteries + wind', color: token('--c-wind') }] });
    }
}

/** Two panels on one latitude axis (north up): bars of the share of people per band (left) and one line per series of
 * the band's cost (right; a value past maxCost is drawn at the edge with its value written beside it). */
function latitudeProfile(node, spec) {
    // T100 (the human, 9 Nov 2026): demand and people bars side by side in each band; example cities under the latitude
    // labels (desktop); the cost lines run off the panel (clipped, no capped labels); arrows where adding wind cuts the cost
    node.innerHTML = '';
    const keyItems = [{ color: spec.people.color, label: spec.people.label }, ...(spec.pop ? [{ color: spec.pop.color, label: spec.pop.label }] : []),
        ...spec.series.map(s => ({ color: s.color, label: s.label }))];
    chartKey(node, keyItems);
    const c = { text: css('--text'), muted: css('--muted'), grid: css('--grid'), axis: css('--axis') };
    const width = Math.max(280, Math.round(node.clientWidth || 320)), narrow = width < 480;
    const m = { top: 26, right: 14, bottom: 26, left: narrow ? 40 : 112 }, H = narrow ? 320 : 400, gap = narrow ? 14 : 28;
    const iw = width - m.left - m.right, ih = H - m.top - m.bottom;
    const lw = Math.round(iw * (narrow ? 0.36 : 0.32)), rw = iw - lw - gap;
    const svg = d3.select(node).append('svg').attr('viewBox', `0 0 ${width} ${H}`).attr('width', width).attr('height', H)
        .attr('role', 'img').attr('aria-label', node.closest('figure')?.querySelector('.chart-title')?.textContent.trim() || 'Chart')
        .style('font-family', 'var(--font-sans)');
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    const y = d3.scaleLinear().domain([spec.LO, spec.HI]).range([ih, 0]);
    const latFmt = t => (t === 0 ? 'Equator' : `${Math.abs(t)}°${t > 0 ? 'N' : 'S'}`);
    const LATS = [-45, -30, -15, 0, 15, 30, 45, 60, 75].filter(t => t >= spec.LO && t <= spec.HI);
    // example cities within a few degrees of each latitude line (Oslo 59.9°N, Helsinki 60.2°N; Milan and Montreal 45.5°N;
    // Cairo 30.0°N, Shanghai 31.2°N; Dakar 14.7°N, Manila 14.6°N; Quito 0.2°S, Singapore 1.3°N; Lima 12.0°S, Brasília 15.8°S;
    // Durban 29.9°S, Porto Alegre 30.0°S; Dunedin 45.9°S)
    const CITIES = { 60: 'Oslo, Helsinki', 45: 'Milan, Montreal', 30: 'Cairo, Shanghai', 15: 'Dakar, Manila', 0: 'Quito, Singapore',
        '-15': 'Lima, Brasília', '-30': 'Durban, Porto Alegre', '-45': 'Dunedin' };
    const shareMax = d3.max(spec.bands, b => Math.max(b.share, spec.pop ? b.popShare : 0));
    const maxShare = Math.ceil(shareMax * 20) / 20;
    const xp = d3.scaleLinear().domain([0, maxShare]).range([0, lw]);
    const xc = d3.scaleLinear().domain([0, spec.maxCost]).range([0, rw]);
    const shareTitle = spec.shareTitle || ['People (%)', 'Share of people (%)'];
    const panels = [[0, lw, narrow ? shareTitle[0] : shareTitle[1], xp, d3.range(0, maxShare + 1e-9, narrow ? 0.1 : 0.05), t => `${Math.round(t * 100)}%`],   // T101: fewer ticks on phones
        [lw + gap, rw, 'Cost of 90% uptime ($/MWh)', xc, d3.range(0, spec.maxCost + 1, 100), t => `$${t}`]];
    for (const [k, [x0, w, title, x, ticks, fmt]] of panels.entries()) {
        const pg = g.append('g').attr('transform', `translate(${x0},0)`);
        pg.append('text').attr('x', 0).attr('y', -12).attr('fill', c.text).attr('font-size', 12).attr('font-weight', 600).text(title);
        LATS.forEach(t => pg.append('line').attr('x1', 0).attr('x2', w).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', t === 0 ? c.axis : c.grid));
        ticks.forEach((t, j) => {
            // the labels where the two panels meet lean inwards, so they never touch
            const anchor = k === 0 && j === ticks.length - 1 ? 'end' : k === 1 && j === 0 ? 'start' : 'middle';
            pg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', ih).attr('y2', ih + 4).attr('stroke', c.axis);
            pg.append('text').attr('x', x(t)).attr('y', ih + 17).attr('text-anchor', anchor).attr('fill', c.muted).attr('font-size', 10.5).text(fmt(t));
        });
        pg.append('line').attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', ih).attr('stroke', c.axis);
    }
    LATS.forEach((t) => {
        g.append('text').attr('x', -6).attr('y', y(t) + 4).attr('text-anchor', 'end').attr('fill', c.muted).attr('font-size', 10.5).text(latFmt(t));
        if (!narrow && CITIES[t]) g.append('text').attr('class', 'lat-city').attr('x', -6).attr('y', y(t) + 16).attr('text-anchor', 'end')
            .attr('fill', c.muted).attr('font-size', 9.5).attr('font-style', 'italic').text(CITIES[t]);
    });
    // each band: demand on top, people below (half height each), or one bar when the chart has no people
    spec.bands.forEach((b) => {
        const top = y(b.hi) + 0.5, h = Math.max(0, y(b.lo) - y(b.hi) - 1);
        if (spec.pop) {
            g.append('rect').attr('class', 'grow-x').attr('x', 0).attr('y', top).attr('width', xp(b.share)).attr('height', h / 2).attr('fill', spec.people.color);
            g.append('rect').attr('class', 'grow-x').attr('x', 0).attr('y', top + h / 2).attr('width', xp(b.popShare)).attr('height', h / 2).attr('fill', spec.pop.color);
        } else {
            g.append('rect').attr('class', 'grow-x').attr('x', 0).attr('y', top).attr('width', xp(b.share)).attr('height', h).attr('fill', spec.people.color);
        }
    });
    const rg = g.append('g').attr('transform', `translate(${lw + gap},0)`);
    const clipId = `latclip-${Math.random().toString(36).slice(2, 8)}`;
    rg.append('clipPath').attr('id', clipId).append('rect').attr('x', 0).attr('y', -2).attr('width', rw).attr('height', ih + 4);
    const clipped = rg.append('g').attr('clip-path', `url(#${clipId})`);
    // arrows from the solar and battery line to the line with wind, where wind cuts the cost by $15/MWh or more (every other
    // such band), under the lines; an arrow off the panel starts at its right edge
    const [sb, sw] = spec.series;
    if (sb && sw) {
        const mk = `${clipId}-arrow`;
        svg.append('defs').append('marker').attr('id', mk).attr('viewBox', '0 0 8 8').attr('refX', 7).attr('refY', 4).attr('markerWidth', 6).attr('markerHeight', 6)
            .attr('orient', 'auto').append('path').attr('d', 'M0,0 L8,4 L0,8 Z').attr('fill', c.grid);   // a light grey (the human)
        const drawn = [];
        spec.bands.filter(b => Number.isFinite(b[sb.key]) && Number.isFinite(b[sw.key]) && b[sb.key] - b[sw.key] >= 15)
            .filter((_, k) => k % 2 === 0).forEach((b) => {
                const x1 = xc(Math.min(b[sb.key], spec.maxCost)) - 4, x2 = xc(b[sw.key]) + 4;
                if (x1 - x2 < 14) return;
                clipped.append('line').attr('class', 'lat-arrow').attr('x1', x1).attr('x2', x2).attr('y1', y(b.mid)).attr('y2', y(b.mid))
                    .attr('stroke', c.grid).attr('stroke-width', 1.5).attr('marker-end', `url(#${mk})`);
                drawn.push({ x1, x2, y: y(b.mid), onChart: b[sb.key] <= spec.maxCost });
            });
        // one label (the human): above the longest arrow whose start is on the chart, else the first
        const lab = drawn.filter(a => a.onChart).sort((a, b) => (b.x1 - b.x2) - (a.x1 - a.x2))[0] || drawn[0];
        // on a phone the arrows are short: the label sits right of the arrow's start (past the solar and battery line), kept inside
        // the panel, so it never lies over the lines (T101)
        if (lab) clipped.append('text').attr('class', 'lat-arrow-label')
            .attr('x', narrow ? Math.min(lab.x1 + 8, rw - 60) : (lab.x1 + lab.x2) / 2).attr('y', lab.y + (narrow ? 4 : -5))
            .attr('text-anchor', narrow ? 'start' : 'middle').attr('fill', c.muted).attr('font-size', narrow ? 9.5 : 10.5).text('Adding wind');
    }
    for (const s of spec.series) {
        const pts = spec.bands.filter(b => Number.isFinite(b[s.key])).map(b => [b[s.key], b.mid]);
        clipped.append('path').attr('d', d3.line().x(p => xc(p[0])).y(p => y(p[1]))(pts)).attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2.25).attr('stroke-linejoin', 'round');
    }
}
