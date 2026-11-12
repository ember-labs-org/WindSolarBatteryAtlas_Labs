// T062: the legend bar shows the colours the map draws, for the ramps the app draws (cf,
// lcoe, green, population (log), no_access (log), delta (diverging), drought). resource_cf
// is no longer drawn anywhere (T097 removed the Potential map's wind CF display, its last
// use); its registry entry is still tested by team/reports/T062-ramps/check.py.
// Part A, where the drawn rows are recorded (capacity, LCOE, wind share), for 7
// values v across the domain:
//   legend: the rendered legend bar's pixel at the position of v (screenshot);
//   LUT:    the registry's colour for v (rampScale, imported in the page);
//   map:    the canvas pixel at the site of drawn cells whose value is near v
//           (the Voronoi canvas holds the cell colour at its fill opacity).
// Part B, for every ramp: the legend bar at 7 positions against the lookup table at
// the same fraction (<= 3), and "every map colour lies on the legend's ramp": map
// pixels sampled on a 90x90 grid, those that are neither ocean, bare land nor no data,
// each within ΔE 6 of the lookup table composited at the opacity drawn (95th
// percentile). Thresholds (contract section 3): legend-LUT <= 3; map-LUT <= 6. Fonts are not needed.
// Part C (T075, legend_probe_c.mjs): categorical and point layers, toggle state, the article.
// usage: node checks/legend_probe.mjs [--ab-only]
import path from 'node:path';
import { serve, openPage, waitForFirstMap, setRange, waitDrawn, SITE } from './lib.mjs';

import { decodePng, de2000, hex } from './colour_lib.mjs';

const lines = []; let failed = false;
const check = (ok, msg) => { lines.push(`${ok ? 'PASS' : 'FAIL'} legend-probe ${msg}`); failed ||= !ok; };

const { server, base } = await serve();
const { browser, page } = await openPage();
await page.addInitScript(() => {
    let L; Object.defineProperty(window, 'L', { configurable: true, get: () => L, set: v => { L = v; if (v && v.Map && !v.__hooked) { v.__hooked = true; v.Map.addInitHook(function () { (window.__lmaps ||= []).push(this); }); } } });
});
await page.goto(`${base}/index.html?debug`);
await waitForFirstMap(page);
await page.evaluate(() => document.querySelector('.tour-nudge__close')?.click());

// Legend pixels and LUT colours for a ramp at values vs.
async function legendVsLut(barSel, ramp, domain, vs, label) {
    const bar = await page.$(barSel);
    const box = await bar.boundingBox();
    const png = decodePng(await page.screenshot({ clip: box }));
    const ref = await page.evaluate(async ([ramp, domain, vs]) => {
        const m = await import('./js/constants.js');
        const f = m.rampScale(ramp, domain || undefined);
        return vs.map(v => ({ v, hex: f(v), t: f.fraction(v) }));
    }, [ramp, domain, vs]);
    let worst = 0;
    for (const r of ref) {
        const x = Math.min(png.w - 2, Math.max(1, Math.round(r.t * (png.w - 1))));
        worst = Math.max(worst, de2000(png.px(x, Math.floor(png.h / 2)), hex(r.hex)));
    }
    check(worst <= 3, `${label}: legend bar vs lookup table, max ΔE ${worst.toFixed(2)} at ${vs.length} values (<= 3)`);
    return ref;
}
// Map colour: the screenshot pixel at the site of drawn cells whose value is within
// tol of v, against the lookup-table colour composited as the map draws it
// (cell fill at ALPHA = 0.6 over the land colour).
const LAND = hex('#626E88'), ALPHA = 0.6;   // cells' fillOpacity (voronoi-canvas.js resolveStyle)
const drawnAs = h => hex(h).map((c, i) => Math.round(c * ALPHA + LAND[i] * (1 - ALPHA)));
async function mapVsLut(view, field, ref, tol, label) {
    const pts = await page.evaluate(([view, field, ref, tol]) => {
        const rec = window.__drawn?.views?.[view]; const rows = rec ? (rec.copy || rec.rows) : [];
        const map = (window.__lmaps || [])[0];
        const mr = map.getContainer().getBoundingClientRect();
        return ref.map(r => ({ ...r, pts: rows.filter(row => Number.isFinite(row[field]) && Math.abs(row[field] - r.v) <= tol && row.meetsTarget !== false)
            .map(row => map.latLngToContainerPoint([row.latitude, row.longitude]))
            .map(p => ({ x: Math.round(p.x + mr.left), y: Math.round(p.y + mr.top) }))
            .filter(p => p.x > 340 && p.x < innerWidth - 300 && p.y > 80 && p.y < innerHeight - 10).slice(0, 15) }));
    }, [view, field, ref, tol]);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    const shot = decodePng(await page.screenshot());
    const meds = [];
    for (const r of pts) {
        if (!r.pts.length) continue;
        const des = r.pts.map(p => de2000(shot.px(p.x, p.y), drawnAs(r.hex))).sort((a, b) => a - b);
        meds.push(des[Math.floor(des.length / 2)]);
    }
    const worst = meds.length ? Math.max(...meds) : Infinity;
    check(meds.length >= 4 && worst <= 6, `${label}: map cells vs lookup table as drawn, worst median ΔE ${worst.toFixed(2)} over ${meds.length} values with matching cells (<= 6, >= 4 values)`);
}

// 1. Capacity factor (capacity view, default build).
const cfVals = [0.3, 0.45, 0.55, 0.62, 0.68, 0.72, 0.75];
const cfRef = await legendVsLut('#legend-capacity .legend-gradient', 'cf', null, [0, 0.12, 0.28, 0.45, 0.68, 0.8, 1], 'CF');
await mapVsLut('capacity', 'annual_cf', await page.evaluate(async vs => { const m = await import('./js/constants.js'); const f = m.rampScale('cf'); return vs.map(v => ({ v, hex: f(v) })); }, cfVals), 0.004, 'CF');

// 2. LCOE (LCOE view, default target), once the full grid has drawn.
await page.click('header button[data-mode="lcoe"]');
await page.waitForFunction(() => window.__atlas && window.__atlas.matrixReady, null, { timeout: 300000 });
await waitDrawn(page, 'lcoe', () => true, { quietMs: 4000 });
await page.waitForTimeout(1500);
await legendVsLut('#legend-lcoe-bar', 'lcoe', null, [35, 50, 65, 85, 120, 170, 250], 'LCOE');
await mapVsLut('lcoe', 'lcoe', await page.evaluate(async vs => { const m = await import('./js/constants.js'); const f = m.rampScale('lcoe'); return vs.map(v => ({ v, hex: f(v) })); }, [50, 58, 65, 72, 80, 95, 120]), 0.4, 'LCOE');

// 3. Wind share layer (green ramp on 0-1): legend only (the drawn row has windShare).
await page.click('[data-lcoe-layer="wind_share"]');
await page.waitForTimeout(2500);
await legendVsLut('#legend-lcoe-bar', 'green', [0, 1], [0, 0.17, 0.33, 0.5, 0.67, 0.83, 1], 'wind share');
await mapVsLut('lcoe', 'windShare', await page.evaluate(async vs => { const m = await import('./js/constants.js'); const f = m.rampScale('green', [0, 1]); return vs.map(v => ({ v, hex: f(v) })); }, [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8]), 0.01, 'wind share');
await page.click('[data-lcoe-layer="lcoe"]');


// --- Part B: every ramp, including the log and diverging ones ---
async function legendFrac(barSel, ramp, domain, label, { reverse = false } = {}) {
    const bar = await page.$(barSel);
    if (!bar || !(await bar.isVisible())) { check(false, `${label}: legend bar ${barSel} not visible`); return; }
    const box = await bar.boundingBox();
    const png = decodePng(await page.screenshot({ clip: box }));
    const ts = [0.02, 0.17, 0.33, 0.5, 0.67, 0.83, 0.98];
    const ref = await page.evaluate(async ([ramp, domain, ts]) => {
        const m = await import('./js/constants.js'); const f = m.rampScale(ramp, domain || undefined);
        return ts.map(t => f.at(t));
    }, [ramp, domain, ts]);
    let worst = 0;
    ts.forEach((t, i) => { const x = Math.round((reverse ? 1 - t : t) * (png.w - 1)); worst = Math.max(worst, de2000(png.px(x, Math.floor(png.h / 2)), hex(ref[i]))); });
    check(worst <= 3, `${label}: legend bar vs lookup table at 7 positions, max ΔE ${worst.toFixed(2)} (<= 3)`);
}
async function mapOnRamp(mapSel, ramp, domain, alpha, label) {
    const lut = await page.evaluate(async ([ramp, domain]) => {
        const m = await import('./js/constants.js'); const f = m.rampScale(ramp, domain || undefined);
        return Array.from({ length: 256 }, (_, i) => f.at(i / 255));
    }, [ramp, domain]);
    const comp = lut.map(h => hex(h).map((c, i) => Math.round(c * alpha + LAND[i] * (1 - alpha))));
    await page.mouse.move(2, 2); await page.waitForTimeout(300);
    // Grid points where the map itself is on top (no panel, legend or header), in
    // viewport coordinates; then only pixels inside a flat 3x3 patch, so cell
    // borders, coastlines and the no-wind hatch are left out.
    const pts = await page.evaluate(sel => {
        const host = document.querySelector(sel); const r = host.getBoundingClientRect(); const out = [];
        for (let gy = 0; gy < 90; gy++) for (let gx = 0; gx < 90; gx++) {
            const x = Math.round(r.left + (gx + 0.5) * r.width / 90), y = Math.round(r.top + (gy + 0.5) * r.height / 90);
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
            const top = document.elementFromPoint(x, y);
            if (top && host.contains(top) && !top.closest('.leaflet-control-container, .leaflet-popup')) out.push([x, y]);
        }
        return out;
    }, mapSel);
    const png = decodePng(await page.screenshot());
    // Not on any ramp by design: ocean, bare land, no data (solid, or at the layer's
    // opacity on the demand map) and universal-access navy at the layer's opacity.
    const at = (h, a) => hex(h).map((c, i) => Math.round(c * a + LAND[i] * (1 - a)));
    const skip = [hex('#414F6F'), LAND, [0, 0, 0], hex('#192238'), at('#000000', alpha), at('#192238', alpha)];
    const des = [];
    for (const [x, y] of pts) {
        const p = png.px(x, y);
        if (skip.some(q => de2000(p, q) < 4)) continue;
        let flat = true;
        for (let dy = -1; dy <= 1 && flat; dy++) for (let dx = -1; dx <= 1; dx++) if (de2000(png.px(x + dx, y + dy), p) > 2) { flat = false; break; }
        if (!flat) continue;
        let best = 1e9; for (const c of comp) { const d = de2000(p, c); if (d < best) best = d; }
        des.push(best);
    }
    des.sort((a, b) => a - b);
    const p95 = des.length ? des[Math.floor(des.length * 0.95)] : Infinity;
    check(des.length >= 30 && p95 <= 6, `${label}: map pixels on the ramp at ${Math.round(alpha * 100)}%, p95 ΔE ${p95.toFixed(2)} over ${des.length} pixels (<= 6, >= 30 pixels)`);
}
const clickSel = sel => page.evaluate(sel => { const el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length); el?.click(); return !!el; }, sel);
const settle = async (ms = 2500) => { await page.waitForFunction(() => !document.getElementById('map-busy'), null, { timeout: 120000 }).catch(() => {}); await page.waitForTimeout(ms); };

// cf (capacity), lcoe (LCOE view), green (wind share): legend fractions and map pixels
await clickSel('header button[data-mode="capacity"]'); await settle();
await legendFrac('#legend-capacity .legend-gradient', 'cf', null, 'B cf');
await mapOnRamp('#map', 'cf', null, 0.6, 'B cf');
await clickSel('header button[data-mode="lcoe"]'); await settle(3500);
await legendFrac('#legend-lcoe-bar', 'lcoe', null, 'B lcoe');
await mapOnRamp('#map', 'lcoe', null, 0.6, 'B lcoe');
await clickSel('[data-lcoe-layer="wind_share"]'); await settle();
await legendFrac('#legend-lcoe-bar', 'green', [0, 1], 'B green (wind share)');
await clickSel('[data-lcoe-layer="lcoe"]'); await settle();
// delta: pick a reference region by clicking a land cell, then the legend is the LCOE difference
{
    const pt = await page.evaluate(() => { const m = window.__lmaps[0]; const p = m.latLngToContainerPoint([9, 20]); const r = m.getContainer().getBoundingClientRect(); return { x: p.x + r.left, y: p.y + r.top }; });
    await page.mouse.click(pt.x, pt.y); await settle(3500);
    const isDelta = await page.$eval('#legend-lcoe-bar', e => e.classList.contains('legend-gradient-delta'));
    check(isDelta, 'B delta: clicking a region switches the LCOE legend to the difference ramp');
    await legendFrac('#legend-lcoe-bar', 'delta', [-1, 1], 'B delta');
    await mapOnRamp('#map', 'delta', [-1, 1], 0.6, 'B delta');
    await clickSel('#lcoe-clear-ref'); await settle();
}
// green: Potential map, onshore wind, Total (T097: this case tested resource_cf on the wind CF
// display, which is gone; the Display row is Total, × Demand and Per capita only, D-178)
await clickSel('header button[data-mode="potential"]'); await settle(4000);
{
    const displays = await page.$$eval('#potential-display-toggle button', bs => bs.map(b => b.dataset.display).join(','));
    check(displays === 'total,multiple,per_capita', `B potential: Display offers Total, × Demand and Per capita only (${displays})`);
}
// The wind Definition toggle is hidden for solar and shown for wind (T097 audit: .hidden lost to the
// toggle group's display: grid).
{
    const shown = () => page.$eval('#potential-definition-toggle', e => e.offsetParent !== null);
    await clickSel('#potential-tech-toggle [data-tech="solar"]'); await settle(500);
    const solar = await shown();
    await clickSel('#potential-tech-toggle [data-tech="onshore"]'); await settle(500);
    const onshore = await shown();
    check(!solar && onshore, `B potential: wind Definition toggle hidden for solar (${solar ? 'shown' : 'hidden'}) and shown for onshore (${onshore ? 'shown' : 'hidden'})`);
}
await clickSel('#potential-tech-toggle [data-tech="onshore"]'); await settle();
await clickSel('#potential-display-toggle [data-display="total"]'); await settle(3500);
await legendFrac('#legend-potential-bar', 'green', [0, 1], 'B green (potential, onshore total)');
await mapOnRamp('#map', 'green', [0, 1], 0.6, 'B green (potential, onshore total)');
await clickSel('#potential-tech-toggle [data-tech="solar"]'); await settle();
// drought and delta: the Complementarity tab (T093). Its score legend runs right to left (1 = blue).
await clickSel('header button[data-mode="complementarity"]'); await settle(5000);
await clickSel('#comp-source-toggle [data-comp-source="wind"]'); await settle();
await legendFrac('#legend-comp-drought-bar', 'drought', [0, 0.3], 'B drought (complementarity, wind weeks)');
await mapOnRamp('#map', 'drought', [0, 0.3], 0.6, 'B drought (complementarity, wind weeks)');
await clickSel('#comp-view-toggle [data-comp-view="score"]'); await clickSel('#comp-level-toggle [data-comp-level="month"]'); await settle();
await legendFrac('#legend-comp-score-bar', 'delta', [0, 1], 'B delta (complementarity score, reversed)', { reverse: true });
await mapOnRamp('#map', 'delta', [0, 1], 0.6, 'B delta (complementarity score)');
// population and no_access (log): Supply-Demand demand map at 85%
await clickSel('header button[data-mode="population"]'); await settle(4000);
await clickSel('#population-base-toggle [data-base="population"]'); await settle();
await legendFrac('#legend-population .legend-gradient-pop', 'population', [1, 1e6], 'B population (log)');
await mapOnRamp('#map', 'population', [1, 1e6], 0.85, 'B population (log)');
await clickSel('#population-base-toggle [data-base="access"]'); await settle();
await legendFrac('#legend-access-bar', 'no_access', [100, 1e6], 'B no_access (log)');
await mapOnRamp('#map', 'no_access', [100, 1e6], 0.85, 'B no_access (log)');
await clickSel('#population-base-toggle [data-base="uptime"]'); await settle();
await legendFrac('#legend-access-bar', 'green', [0, 100], 'B green (reliability)');
await mapOnRamp('#map', 'green', [0, 100], 0.85, 'B green (reliability)');

await browser.close(); server.close();
lines.forEach(l => console.log(l));
// Part C (T075): categorical and point layers, toggles and the article, in its own
// page (checks/legend_probe_c.mjs; --ab-only skips it).
if (!process.argv.includes('--ab-only')) {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'legend_probe_c.mjs')], { encoding: 'utf8', env: process.env, timeout: 3600000 });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) { failed = true; if (!/FAIL/.test(r.stdout || '')) console.log(`FAIL legend-probe part C exited ${r.status}: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`); }
}
console.log(`${failed ? 'FAIL' : 'PASS'} legend-probe overall (${SITE})`);
process.exit(failed ? 1 : 0);
