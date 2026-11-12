// T059 scratch: hover the onshore (and offshore) Potential tooltip at given regions.
// ATLAS_SITE=<deployment> node hover_potential.mjs [canvas0]   (uses the worktree's checks/lib.mjs)
import fs from 'node:fs';
import path from 'node:path';
const W = process.env.WT;
const { serve, openPage, waitForFirstMap, SITE } = await import(path.join(W, 'checks/lib.mjs'));
const canvas0 = process.argv.includes('canvas0');
const CAPTURE_MAPS = () => {
    let leaflet;
    Object.defineProperty(window, 'L', { configurable: true, get: () => leaflet,
        set: (v) => { leaflet = v; try { v.Map.addInitHook(function () { (window.__lmaps ||= []).push(this); }); } catch (_) {} } });
};
const csv = fs.readFileSync(path.join(SITE, 'data/voronoi_wind_resource.csv'), 'utf8').trim().split('\n');
const h = csv[0].split(','); const col = n => h.indexOf(n);
const byId = new Map(csv.slice(1).map(l => l.split(',')).map(v => [+v[col('location_id')], { lat: +v[col('latitude')], lon: +v[col('longitude')] }]));
const ids = (process.env.IDS || '2338,1007,1195').split(',').map(Number);
const { server, base } = await serve();
const { browser, page, errors } = await openPage();
await page.addInitScript(CAPTURE_MAPS);
const out = {};
const hover = async (p) => {
    await page.evaluate(([a, b]) => { window.__lmaps[0].setView([a, b], 6, { animate: false }); }, [p.lat, p.lon]);
    await page.waitForTimeout(2500);
    const pt = await page.evaluate(([lat, lon]) => { const m = window.__lmaps[0]; const q = m.latLngToContainerPoint([lat, lon]); const b = m.getContainer().getBoundingClientRect(); return { x: b.left + q.x, y: b.top + q.y }; }, [p.lat, p.lon]);
    await page.mouse.move(pt.x - 3, pt.y - 3); await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(700);
    const t = await page.$eval('.leaflet-popup-content', el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(no popup)');
    await page.mouse.move(5, 5); await page.waitForTimeout(300);
    return t;
};
try {
    await page.goto(`${base}/index.html?debug${canvas0 ? '&canvas=0' : ''}`);
    await waitForFirstMap(page);
    await page.click('button[data-mode="potential"]'); await page.waitForTimeout(4000);
    for (const tech of ['onshore', 'offshore']) {
        await page.click(`#potential-tech-toggle button[data-tech="${tech}"]`); await page.waitForTimeout(4000);
        for (const id of ids) out[`${tech}_${id}`] = await hover(byId.get(id));
    }
} finally {
    out.errors = errors; await browser.close(); server.close();
}
console.log(JSON.stringify(out, null, 1));
