// Drive the atlas headlessly (checks/lib.mjs, ?debug) and save exactly what its
// LCOE view drew, for scenarios the oracle does not record:
//   global_t95_2026   app defaults, target 95%            (cross-check of engine.py)
//   global_t80_2035   app defaults, target 80%, year 2035 (cross-check of the cost path)
//   local_t80_2026    Capex Local + WACC Local, target 80% (sensitivity)
//   local_t90_2026    Capex Local + WACC Local, target 90% (sensitivity)
//   local_t90_2035    Capex Local + WACC Local, target 90%, year 2035 (sensitivity)
//   lcgw_t80_2026, lcgw_t90_2026, lcgw_t90_2035   Capex Local + WACC Global (T091: the article's cost mode from
//                     5 Nov 2026, one 7% cost of capital everywhere), the same targets and years
// Rows: the drawn copy taken when the renderer fixed the colours (window.__drawn).
// Usage: node scripts/article/drive_app.mjs [outdir]   (ATLAS_SITE defaults to this repo's deployment/)
// Runs under the machine-wide lock in shared mode, like checks/regress.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, openPage, waitForFirstMap, setRange, waitDrawn, mark, runUnderLock, browserLine } from '../../checks/lib.mjs';

runUnderLock('shared', { waitS: 3600, runS: 1800 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.resolve(process.argv[2] || path.join(HERE, 'out', 'app'));
fs.mkdirSync(OUTDIR, { recursive: true });
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;
const FIELDS = ['location_id', 'solar_gw', 'wind_gw', 'wind_surface', 'batt_gwh', 'annual_cf', 'lcoe', 'meetsTarget',
    'noWindLcoe', 'noWindMeetsTarget', 'windSaving', 'windShare', 'maxConfigLcoe'];

async function dump(page, name) {
    const rows = await page.evaluate((fields) => {
        const v = window.__drawn.views.lcoe;
        return v.copy.map(r => fields.map(f => r[f]));
    }, FIELDS);
    const fmt = v => (v === null || v === undefined) ? '' : (typeof v === 'boolean' ? (v ? 1 : 0) : v);
    const lines = [FIELDS.join(','), ...rows.sort((a, b) => a[0] - b[0]).map(r => r.map(fmt).join(','))];
    fs.writeFileSync(path.join(OUTDIR, `${name}.csv`), lines.join('\n') + '\n');
    console.log(`wrote ${name}.csv (${rows.length} rows)`);
}

async function target(page, t) {
    const m = await setRange(page, 'target-cf-slider', t);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, t / 100), { quietMs: 8000, after: m });
}

async function year(page, y, t) {
    const m = await setRange(page, 'lcoe-time-slider', y);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, t / 100), { quietMs: 8000, after: m });
    const shown = await page.$eval('#lcoe-time-year', el => el.textContent.trim());
    if (shown !== String(y)) throw new Error(`timeline year is ${shown}, not ${y}`);
}

async function source(page, which, mode, t) {
    const m = await mark(page);
    await page.click(`#${which}-source-toggle button[data-mode="${mode}"]`);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, t / 100), { quietMs: 8000, after: m });
}

console.log(browserLine());
const { server, base } = await serve();
const { browser, page, errors } = await openPage();
try {
    await page.goto(`${base}/index.html?debug`);
    await waitForFirstMap(page);
    await page.click('button[data-mode="lcoe"]');
    await page.waitForFunction(() => window.__atlas && window.__atlas.matrixReady, null, { timeout: 300000 });
    const baseYear = await page.$eval('#lcoe-time-year', el => el.textContent.trim());
    console.log(`base year ${baseYear}`);
    await target(page, 95);
    await dump(page, 'global_t95_2026');
    await target(page, 80);
    await year(page, 2035, 80);
    await dump(page, 'global_t80_2035');
    await year(page, Number(baseYear), 80);
    await source(page, 'wacc', 'local', 80);
    await source(page, 'capex', 'local', 80);
    await dump(page, 'local_t80_2026');
    await target(page, 90);
    await dump(page, 'local_t90_2026');
    await year(page, 2035, 90);
    await dump(page, 'local_t90_2035');
    // T091: Capex Local + WACC Global (the article's mode since 5 Nov 2026)
    await source(page, 'wacc', 'global', 90);
    await dump(page, 'lcgw_t90_2035');
    await year(page, Number(baseYear), 90);
    await dump(page, 'lcgw_t90_2026');
    await target(page, 80);
    await dump(page, 'lcgw_t80_2026');
} finally {
    await browser.close();
    server.close();
}
if (errors.length) { console.log(`page errors:\n${errors.join('\n')}`); process.exit(1); }
