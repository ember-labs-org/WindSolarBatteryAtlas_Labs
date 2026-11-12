// T099: the Supply-Demand charts' LCOE axis and histogram bins (offline, no browser; check pages
// block Chart.js, so the charts themselves are not drawn in the browser checks).
// usage: node checks/population_chart_bins.mjs
// Runs app.js's own code, the source from `const LCOE_AXIS_CAPS` to the latitude-band helper
// (lcoeAxisCap, histogramBins and the real builders buildHistogramWithAvailability and
// buildStackedHistogram), on synthetic cells shaped like the app's runs: a demand layer in cheap
// cells, plus supply cells that hold no demand (far-north cells up to about $5,900/MWh and a
// cheap empty cell), and dear runs with a heavy 3-5% tail. The bins must follow the demand layer
// only, weighted by it, and stop at the latitude-axis cap ($300/400/500).
import fs from 'node:fs';
import path from 'node:path';
import { SITE } from './lib.mjs';

const src = fs.readFileSync(path.join(SITE, 'js', 'app.js'), 'utf8');
const a = src.indexOf('const LCOE_AXIS_CAPS');
const b = src.indexOf('// Sum raw supply (TWh/yr) and demand (TWh/yr) into latitude bands.');
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed++; };
check(a > 0 && b > a, 'app.js defines the T099 LCOE helpers and the histogram builders');
if (failed) process.exit(1);
const stubs = {
    ALL_FUELS: ['coal', 'oil_gas', 'bioenergy', 'nuclear'],
    FUEL_LABELS: { coal: 'Coal', oil_gas: 'Oil and gas', bioenergy: 'Bioenergy', nuclear: 'Nuclear' },
    FUEL_COLORS: { coal: 'c', oil_gas: 'g', bioenergy: 'b', nuclear: 'n' },
    DATA_COLOURS: { plantFallback: 'x' },
    capitalizeWord: s => s, potentialAreaById: new Map(), getPotentialRowComponents: () => null
};
const app = new Function(...Object.keys(stubs),
    `${src.slice(a, b)}; return { lcoeAxisCap, histogramBins, buildHistogramWithAvailability, buildStackedHistogram };`)(...Object.values(stubs));

// Deterministic pseudo-random numbers.
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const cum = shares => { let s = 0; return shares.map(v => (s += v)); };

function scenario(name, { lo, hi, n, farNorth, scale = 1, heavyTail = 0 }) {
    const demand = [];
    for (let i = 0; i < n; i++) {
        const v = (lo + (hi - lo) * Math.pow(rnd(), 1.6)) * scale;
        demand.push({ location_id: i, latitude: -40 + 100 * rnd(), metric: v, weight: 1 + 1000 * rnd() });
    }
    // Supply cells: every demand cell, plus far-north cells (no demand) and one cheap empty cell.
    const supply = demand.map(d => ({ location_id: d.location_id, metric: d.metric }));
    for (let i = 0; i < farNorth; i++) supply.push({ location_id: n + i, metric: (400 + 5500 * rnd()) * scale });
    supply.push({ location_id: n + farNorth, metric: 12 });
    // Sparse far-north demand: 4% of the cells, dear, holding well under 1% of the weight (as the
    // Arctic cells of the population layer do). By cell count they would set the range.
    for (let i = 0; i < Math.round(0.04 * n); i++) demand.push({ location_id: n + i, latitude: 78, metric: (rnd() < 0.5 ? 150 + 150 * rnd() : 300 + 5200 * rnd()) * scale, weight: 0.01 });

    // Optional heavy dear tail: high-latitude demand holding `heavyTail` of the weight at $800-2,800
    // (the electricity-demand layer in a dear run).
    if (heavyTail) {
        const main = demand.reduce((s, d) => s + d.weight, 0);
        const k = Math.round(0.05 * n);
        for (let i = 0; i < k; i++) demand.push({ location_id: 2 * n + i, latitude: 65, metric: 800 + 2000 * rnd(), weight: heavyTail * main / (1 - heavyTail) / k });
    }

    const h = app.buildHistogramWithAvailability(demand, supply, 'lcoe', 50, {});
    const regular = h.buckets.filter(x => Number.isFinite(x.max));
    const step = regular[0].max - regular[0].min;
    const total = demand.reduce((s, d) => s + d.weight, 0);
    const minDemand = Math.min(...demand.map(d => d.metric));
    const c = cum(h.demandShare);
    console.log(`INFO ${name}: ${h.labels.length} bins, ${h.labels[0]} … ${h.labels[h.labels.length - 1]}`);
    check(regular.length <= 25 && [10, 20, 25, 50, 100, 200, 250, 500, 1000].includes(step),
        `${name}: at most 25 round bins ($${step} wide)`);
    check(regular[0].min <= minDemand && minDemand < regular[0].max,
        `${name}: the first bin starts at the cheapest demand cell (${h.labels[0]}), not at an empty supply cell ($12)`);
    check(Math.abs(c[c.length - 1] - 100) < 1e-6, `${name}: shares add up to 100%`);
    const over = h.buckets[h.buckets.length - 1];
    const overShare = h.demandShare[h.demandShare.length - 1];
    const beyond = 100 * demand.filter(d => d.metric >= over.min).reduce((s, d) => s + d.weight, 0) / total;
    check(over.max === Infinity && Math.abs(overShare - beyond) < 1e-6,
        `${name}: an "${over.label}" bin holds everything dearer (${overShare.toFixed(2)}%)`);
    if (weightedP(demand, 0.99) <= 300) check(overShare <= 1.0001, `${name}: with the layer below $300, the "Over" bin holds 1% or less`);
    check(over.min <= 500, `${name}: the regular bins end at $500/MWh at most (the latitude-axis cap) – ${over.label}`);
    const wall = c.slice(0, -1).filter(v => v >= 95).length;
    check(wall <= 3, `${name}: at most 3 regular bars at >= 95% cumulative (${wall}), no wall of near-100% bars`);
    const axisCap = app.lcoeAxisCap(demand.map(d => d.metric), demand.map(d => d.weight));
    const endBelow = weightedP(demand.filter(d => d.metric < axisCap), 0.99);
    const want = Math.min(8, Math.ceil((endBelow - minDemand) / 10));
    check(regular.length >= want, `${name}: bins fine enough to show the spread (${regular.length} regular bins, want >= ${want})`);
    check(over.min <= endBelow + step,`${name}: the regular bins end at the weighted 99th percentile below the $${axisCap} cap ($${Math.round(endBelow)}), not at the far-north cells (${over.label})`);
    const plateau = c.slice(0, -1).filter(v => v >= 99.9).length;
    check(plateau <= 1, `${name}: cumulative bars reach 99.9% in at most one regular bin (${plateau}), no wall of 100% bars`);
    check(c[0] < 50, `${name}: cumulative share starts low (first bin ${c[0].toFixed(1)}%)`);
    const busy = h.demandShare.slice(0, -1).filter(v => v > 0).length;
    check(busy >= Math.min(8, regular.length * 0.6), `${name}: most bins carry weight (${busy} of ${regular.length})`);
    void total;
    return { demand, supply };
}
function weightedP(rows, q) {
    const s = rows.slice().sort((x, y) => x.metric - y.metric);
    const t = s.reduce((acc, r) => acc + r.weight, 0);
    let acc = 0;
    for (const r of s) { acc += r.weight; if (acc >= q * t) return r.metric; }
    return s[s.length - 1].metric;
}

const def = scenario('default-like', { lo: 33, hi: 140, n: 3000, farNorth: 40 });
const dear = scenario('dear run (onshore off, WACC 15%, 99%)', { lo: 90, hi: 700, n: 3000, farNorth: 400 });
scenario('dear run, electricity demand with a 4% dear tail', { lo: 90, hi: 400, n: 3000, farNorth: 400, heavyTail: 0.04 });
scenario('dear run, 3% dear tail', { lo: 60, hi: 250, n: 3000, farNorth: 400, heavyTail: 0.03 });

// Latitude chart axis: $300/MWh by default; a dear demand layer may take it to $500 at most;
// unweighted far-north cells never do.
const cap = rows => app.lcoeAxisCap(rows.supply.map(r => r.metric),
    rows.supply.map(r => { const d = rows.demand.find(x => x.location_id === r.location_id); return d ? d.weight : 0; }));
check(cap(def) === 300, `latitude axis cut at $300/MWh by default (got ${cap(def)})`);
const dearCap = cap(dear);
check(dearCap >= 300 && dearCap <= 500, `latitude axis at most $500/MWh in a dear run (got ${dearCap})`);
check(app.lcoeAxisCap([50, 60, 70, 5000, 5800], [1000, 1000, 1000, 0, 0]) === 300, 'far-north cells without demand do not move the latitude axis');

// The stacked plant histogram uses the same bins, weighted by capacity.
const plants = def.demand.slice(0, 600).map((d, i) => ({ ...d, fuel: ['coal', 'oil_gas', 'bioenergy', 'nuclear'][i % 4] }));
const st = app.buildStackedHistogram(plants, 'lcoe', new Set(['coal', 'oil_gas', 'bioenergy', 'nuclear']), 50, {});
const stTotal = st.datasets.reduce((s, ds) => s + ds.data.reduce((x, y) => x + y, 0), 0);
const plantTotal = plants.reduce((s, p) => s + p.weight, 0);
check(Math.abs(stTotal - plantTotal) < 1e-6 * plantTotal, 'stacked plant histogram: every MW lands in a bin');
check(st.labels.length <= 26 && /^\$\d/.test(st.labels[0]), `stacked plant histogram: round LCOE bins (${st.labels[0]} … ${st.labels[st.labels.length - 1]})`);

// Non-LCOE metrics keep equal-width bins over the values drawn.
const cf = app.histogramBins([0.3, 0.5, 0.75], 'cf', 50);
check(cf.buckets.length === 50 && cf.indexOf(0.75) === 49 && cf.indexOf(0.3) === 0, 'capacity factor: 50 equal bins from the smallest to the largest value');

console.log(failed ? `population_chart_bins: ${failed} failed` : 'population_chart_bins: all passed');
process.exit(failed ? 1 : 0);
