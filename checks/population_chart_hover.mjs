// T099: the Supply-Demand charts in the browser: the latitude chart's LCOE axis, hovering the edge
// triangles, and the "Over $x" bin's subset map. Needs Chart.js, which the app loads from its pinned
// CDN URL and the other check pages block: it runs only with CHARTJS_CDN=1 (one request to
// cdn.jsdelivr.net/npm/chart.js@4.4.1, SRI-checked by the app) and otherwise skips.
// usage: CHARTJS_CDN=1 node checks/population_chart_hover.mjs
import path from 'node:path';
import { serve, resolveBrowser, waitForFirstMap } from './lib.mjs';

if (process.env.CHARTJS_CDN !== '1') {
    console.log('INFO population_chart_hover: skipped (needs Chart.js from its CDN; set CHARTJS_CDN=1)');
    process.exit(0);
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const VENDOR = path.join(path.dirname(new URL(import.meta.url).pathname), 'vendor');
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed++; };
const { server, base } = await serve();
const browser = await chromium.launch({ executablePath: resolveBrowser().exe });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => {
    const u = route.request().url();
    if (u.includes('leaflet.js')) return route.fulfill({ path: path.join(VENDOR, 'leaflet.js'), contentType: 'text/javascript' });
    if (u.includes('leaflet.css')) return route.fulfill({ path: path.join(VENDOR, 'leaflet.css'), contentType: 'text/css' });
    if (u.includes('d3js.org')) return route.fulfill({ path: path.join(VENDOR, 'd3.v7.min.js'), contentType: 'text/javascript' });
    if (u.startsWith('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/')) return route.continue();
    return route.abort();
});
await page.addInitScript(() => { let v; Object.defineProperty(window, 'L', { configurable: true, get: () => v, set: x => { v = x; x.Map.addInitHook(function () { (window.__lmaps ||= []).push(this); }); } }); });
const clickSel = sel => page.evaluate(sel => { const el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length) || document.querySelector(sel); el?.click(); return !!el; }, sel);
const settle = async (ms = 2500) => { await page.waitForFunction(() => !document.getElementById('map-busy'), null, { timeout: 180000 }).catch(() => {}); await page.waitForTimeout(ms); };
await page.goto(`${base}/index.html?debug`);
await waitForFirstMap(page);
await page.evaluate(() => document.querySelector('.tour-nudge__close')?.click());
await clickSel('header button[data-mode="population"]'); await settle(6000);
await clickSel('#population-display-toggle [data-mode="charts"]'); await settle(3000);
await clickSel('#population-overlay-mode [data-overlay="lcoe"]'); await settle(5000);

// Latitude chart: axis cut at $300/MWh, triangles at the edge carry their real cost.
const lat = await page.evaluate(() => {
    const c = Object.values(Chart.instances).find(x => x.canvas.id === 'population-chart-lat-combined');
    const di = c.data.datasets.findIndex(d => d.pointStyle === 'triangle');
    const meta = di >= 0 ? c.getDatasetMeta(di) : null;
    const el = meta?.data?.[0];
    const r = c.canvas.getBoundingClientRect();
    return { max: c.scales.xSupply.max, di, n: di >= 0 ? c.data.datasets[di].data.length : 0, values: di >= 0 ? c.data.datasets[di].data.map(p => p.value) : [],
        at: el ? [r.left + el.x, r.top + el.y] : null };
});
check(lat.max === 300, `latitude chart: LCOE axis ends at $300/MWh by default (${lat.max})`);
check(lat.n > 0 && lat.values.every(v => v > 300), `latitude chart: ${lat.n} cells above it drawn as edge triangles with their real cost (${lat.values.map(Math.round).join(', ')})`);
if (lat.at) {
    await page.evaluate(() => document.getElementById('population-chart-lat-combined').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    const pos = await page.evaluate(() => {
        const c = Object.values(Chart.instances).find(x => x.canvas.id === 'population-chart-lat-combined');
        const di = c.data.datasets.findIndex(d => d.pointStyle === 'triangle');
        const el = c.getDatasetMeta(di).data[0]; const r = c.canvas.getBoundingClientRect();
        return [r.left + el.x, r.top + el.y];
    });
    await page.mouse.move(pos[0] - 1, pos[1]);
    await page.waitForTimeout(500);
    const tip = await page.evaluate(() => {
        const c = Object.values(Chart.instances).find(x => x.canvas.id === 'population-chart-lat-combined');
        return (c.tooltip?.dataPoints || []).map(p => `${p.dataset.label}: ${p.raw?.value ?? p.parsed.x}`);
    });
    check(tip.some(t => /beyond the axis/.test(t)), `hovering an edge triangle shows its tooltip (${tip.join(' | ') || 'none'})`);
}

// Histogram: the "Over $x" bin opens a subset map titled with its range, with its cells in view.
const hist = await page.evaluate(() => {
    const c = Object.values(Chart.instances).find(x => x.canvas.id === 'population-chart-histogram');
    return { labels: c.data.labels };
});
const overIdx = hist.labels.findIndex(l => /^Over /.test(l));
check(overIdx === hist.labels.length - 1, `histogram: last bin "${hist.labels[hist.labels.length - 1]}"`);
if (overIdx >= 0) {
    await page.evaluate(i => {
        const c = Object.values(Chart.instances).find(x => x.canvas.id === 'population-chart-histogram');
        c.options.onClick({}, [{ index: i }]);
    }, overIdx);
    await page.waitForTimeout(2500);
    const sub = await page.evaluate(() => {
        const title = document.getElementById('subset-map-title')?.textContent || '';
        const m = (window.__lmaps || []).find(x => x.getContainer().id === 'subset-map');
        return { title, open: !document.getElementById('subset-map-modal').classList.contains('hidden'), zoom: m?.getZoom(), b: m ? m.getBounds().toBBoxString() : null };
    });
    check(sub.open && /over \$/i.test(sub.title), `"Over" bin: subset map open, title "${sub.title}"`);
    check(sub.b !== null, `"Over" bin: subset map view ${sub.b} (zoom ${sub.zoom})`);
}
check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close(); server.close();
console.log(failed ? `population_chart_hover: ${failed} failed` : 'population_chart_hover: all passed');
process.exit(failed ? 1 : 0);
