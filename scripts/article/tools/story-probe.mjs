// story-probe.mjs – story.html's map colours (T087): what is drawn, what the legend shows and what
// story-layers.js gives each region must agree, state by state. Run from the repo root:
//
//   node scripts/article/tools/story-probe.mjs
//
// 1. Drawn: for every state (windcost and T090's saving99y at 2026 and 2050), the page draws the layer as it does when
//    scrolling and reads the canvas pixel at every 7th region's site (sites on land); each must be within
//    ΔE2000 2 of the region's colour (95th percentile); only sites at least 1.5 px inside a cell of 25 px² or more and 1.5 px from the coast, so the pixel is the cell's own.
// 2. Legend bar: the rendered bar (a CSS gradient of the ramp's stops) against the ramp at 7 positions,
//    ΔE2000 <= 3 (the same tolerance as checks/legend_probe.mjs).
// 3. Legend chips: each chip's colour is one the map draws for that state (categories and, for the
//    bucketed potential map, each bucket), exactly.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { serve, openPage, browserLine } = await import(path.join(ROOT, 'checks/lib.mjs'));
const { decodePng, de2000, lab, hex } = await import(path.join(ROOT, 'checks/colour_lib.mjs'));

const lines = [];
let failed = false;
const check = (ok, msg) => { lines.push(`${ok ? 'PASS' : 'FAIL'} story-probe ${msg}`); failed ||= !ok; };
const { server, base } = await serve();
const { browser, page, errors } = await openPage();
console.log(browserLine());
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${base}/scrollytelling/index.html`);
await page.waitForFunction(() => window.__article?.ready, null, { timeout: 60000 });
const de = (a, b) => de2000(lab(a), lab(b));
const q = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };

const CASES = [['windcf'], ['cost-sb'], ['cost-wind'], ['cost99'], ['cost100'], ['saving'], ['potential'], ['potential-cons'], ['drought-solar'], ['drought-wind'], ['drought-both'], ['winter'], ['windcost', 2026], ['windcost', 2050], ['potential-gw'], ['saving100y', 2026], ['saving100y', 2050]];   // T090: the last three (T101: the firm-power saving, as the article)
for (const [name, year] of CASES) {
    const samples = await page.evaluate(([n, y]) => window.__article.probeLayer(n, y ?? 2026, 1), [name, year]);
    const d = samples.map(s => de(s.drawn, hex(s.want)));
    const p95 = q(d, 0.95), med = q(d, 0.5);
    check(samples.length > 300 && p95 <= 2, `drawn ${name}${year ? ` ${year}` : ''}: ${samples.length} region sites, ΔE2000 median ${med.toFixed(2)}, 95th ${p95.toFixed(2)}, max ${Math.max(...d).toFixed(2)} (≤ 2)`);
}

// Legends: shown in the stage's legend box, one state at a time.
await page.evaluate(() => window.scrollTo(0, window.__article.yForStep(0)));
await page.waitForTimeout(1200);
const LEG = [['windcf', 'windcf'], ['cost-sb', 'cost90'], ['cost-wind', 'cost90'], ['cost99', 'cost90'], ['cost100', 'cost90'], ['drought-solar', null], ['potential-cons', null], ['saving', null], ['winter', 'winter'], ['windcost', 'windcost'], ['potential', null], ['potential-gw', 'potentialGw'], ['saving100y', null], ['planned-130', null]];
for (const [name, rampName] of LEG) {
    await page.evaluate((n) => { document.getElementById('map-legend').innerHTML = window.__article.legendFor(n); }, name);
    await page.waitForTimeout(150);
    if (rampName) {
        const bar = page.locator('#map-legend .legend-bar');
        const box = await bar.boundingBox();
        const img = decodePng(await page.screenshot({ clip: box, scale: 'css' }));
        const worst = [];
        for (const f of [0.02, 1 / 6, 2 / 6, 0.5, 4 / 6, 5 / 6, 0.98]) {
            const x = Math.min(img.w - 1, Math.round(f * (img.w - 1))), y = Math.floor(img.h / 2);
            const got = img.px(x, y);
            const want = hex(await page.evaluate(([n, fr]) => window.__article.rampAt(n, fr), [rampName, (x + 0.5) / img.w]));
            worst.push(de(got, want));
        }
        check(Math.max(...worst) <= 3, `legend bar ${name}: 7 positions against the drawn ramp, worst ΔE2000 ${Math.max(...worst).toFixed(2)} (≤ 3)`);
    }
    // chips: each chip colour must be one the state draws
    const { chips, drawn } = await page.evaluate((n) => {
        const toHex = (c) => '#' + c.match(/\d+/g).slice(0, 3).map(v => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
        const chips = [...document.querySelectorAll('#map-legend .legend-chip i')].map(i => toHex(getComputedStyle(i).backgroundColor));
        if (n.startsWith('planned')) return { chips, drawn: window.__article.plannedColours(n) };   // the dots (T090 tiers)
        const dump = window.__article.dumpStoryLayers().find(d => d.name === n && (n !== 'windcost' || d.year === 2026));
        if (!dump) return { chips, drawn: [] };
        const drawn = [...new Set(dump.fill.filter(Boolean).map(c => c.toUpperCase()))];
        return { chips, drawn };
    }, name);
    const missing = chips.filter(c => !drawn.includes(c));
    check(!missing.length, `legend chips ${name}: ${chips.length ? chips.join(' ') : '(none: no region falls in a category)'} all drawn on the map${missing.length ? `; not drawn: ${missing.join(' ')}` : ''}`);
}
// Self-test: the drawn comparison catches a wrong colour (windcf pixels against the winter colours).
{
    const samples = await page.evaluate(() => window.__article.probeLayer('windcf', 2026, 1));
    const wrong = await page.evaluate(() => window.__article.dumpStoryLayers().find(d => d.name === 'winter').fill);
    const d = samples.filter(s => wrong[s.i]).map(s => de(s.drawn, hex(wrong[s.i])));
    check(q(d, 0.95) > 2, `self-test: windcf as drawn against the winter colours is caught (95th ΔE2000 ${q(d, 0.95).toFixed(1)})`);
}
check(!errors.length, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
lines.forEach(l => console.log(l));
console.log(failed ? 'STORY PROBE FAILED' : 'STORY PROBE PASSED');
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
