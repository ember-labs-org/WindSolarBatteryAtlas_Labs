// T094 probe: the background warm-up of the cost view and the fallbacks.
//   node checks/warm_probe.mjs [--only name,name] [--wait 12]
// For each scenario, a fresh browser opens the page on a local server (no
// shaping, CPU x1), stays on the Capacity view for --wait seconds after the
// first map and records every request the server sees and every moment a
// loading pill (#loading shown, or #map-busy) is up. Scenarios that open LCOE
// then check that the drawn map equals the add-on oracle's lcoe_t90.
//   warm      ?warm=1: grid, add-on, diesel and gas fetched before the click; no pill
//   warm0     ?warm=0: none of the grid files before the click
//   policy-*  no flag, navigator.connection replaced: warms only on 4g without Save-Data;
//             without the API, only with a fine pointer and a wide screen (D-171)
//   worker0   ?worker=0&warm=1: no main-thread grid build at idle; fallback = oracle
//   blocked   ?warm=1, every lcoe-worker.js request 404s: no grid file before the click (no
//             idle main-thread build; the pricing CSVs, 1.4 MB, may already have been fetched,
//             as they load alongside the worker's start); fallback = oracle
//   noloader  ?warm=1, lcoe-worker.js?load 404s: the worker decodes itself; = oracle
// Runs under the bench lock (shared, like regress).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openPage, waitForFirstMap, mark, timeToResult, hashRows, runUnderLock, writeJson, SITE } from './lib.mjs';

runUnderLock('shared', { waitS: 3600, runS: 2700 });

const HERE = path.dirname(new URL(import.meta.url).pathname);
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const WAIT_S = Number(arg('wait', 12));
const ONLY = arg('only', null)?.split(',');
const addonOracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'addon_oracle.json.gz'))));
const T90 = hashRows(addonOracle.keys.lcoe_t90.digest);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.geojson': 'application/json', '.wasm': 'application/wasm', '.csv': 'text/csv', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg' };

function server(fault) {
    const log = [];
    const srv = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const e = { path: url.pathname + url.search, t: Date.now(), status: 200 };
        log.push(e);
        const file = path.join(SITE, decodeURIComponent(url.pathname));
        if (fault && fault(url)) { e.status = 404; res.writeHead(404); return res.end(); }
        fs.stat(file, (err, st) => {
            if (err || !st.isFile() || !file.startsWith(SITE)) { e.status = 404; res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
            fs.createReadStream(file).pipe(res);
        });
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, log, base: `http://127.0.0.1:${srv.address().port}` })));
}

const conn = c => `(() => { const c = ${JSON.stringify(c)};
    Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => (c ? { ...c, addEventListener() {} } : undefined) }); })()`;
const noConn = `(() => { delete Navigator.prototype.connection; })()`;
const workerUrl = url => url.pathname.endsWith('/js/workers/lcoe-worker.js');

const SCENARIOS = [
    { name: 'warm', query: '&warm=1', open: true, expectWarm: true },
    { name: 'warm0', query: '&warm=0', open: false, expectWarm: false },
    { name: 'policy-4g', init: conn({ effectiveType: '4g', saveData: false }), expectWarm: true },
    { name: 'policy-4g-savedata', init: conn({ effectiveType: '4g', saveData: true }), expectWarm: false },
    { name: 'policy-3g', init: conn({ effectiveType: '3g', saveData: false }), expectWarm: false },
    { name: 'policy-2g', init: conn({ effectiveType: '2g', saveData: false }), expectWarm: false },
    { name: 'policy-slow-2g', init: conn({ effectiveType: 'slow-2g', saveData: false }), expectWarm: false },
    { name: 'policy-noapi-desktop', init: noConn, expectWarm: true },
    { name: 'policy-noapi-narrow', init: noConn, viewport: { width: 800, height: 900 }, expectWarm: false },
    { name: 'worker0', query: '&worker=0&warm=1', open: true, expectWarm: false },
    { name: 'blocked', query: '&warm=1', fault: workerUrl, open: true, expectWarm: false, pricingOk: true },
    { name: 'noloader', query: '&warm=1', fault: url => workerUrl(url) && url.searchParams.has('load'), open: true, expectWarm: true }
].filter(s => !ONLY || ONLY.includes(s.name));

// What only the full-grid load fetches (the Capacity view reads summary_w0 alone).
const GRID = /summary_wo?[1-9]\d*\.parquet|addon_wind_mix\.parquet|addon_large\.parquet/;
const PRICING = /voronoi_(diesel|gas)_prices\.csv/;

const lines = [];
const out = { site: SITE, oracle: T90, scenarios: {} };
for (const sc of SCENARIOS) {
    const { srv, log, base } = await server(sc.fault);
    const { browser, page, errors } = await openPage({ throttle: 1 });
    const r = { load: os.loadavg().map(v => v.toFixed(2)).join(' ') };
    try {
        if (sc.viewport) await page.setViewportSize(sc.viewport);
        if (sc.init) await page.addInitScript(sc.init);
        // Every moment after the first map that a loading pill is up, with the view.
        await page.addInitScript(() => {
            window.__pill = [];
            const look = () => {
                if (!window.__firstMapSeen) return;
                const l = document.getElementById('loading');
                const shown = l && !l.classList.contains('hidden');
                const busy = document.getElementById('map-busy');
                if (shown || busy) window.__pill.push({ t: Math.round(performance.now()), loading: Boolean(shown), busy: Boolean(busy),
                    text: shown ? document.getElementById('loading-status')?.textContent : busy?.textContent,
                    view: document.querySelector('button[data-mode].bg-primary')?.dataset.mode });
            };
            new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        });
        await page.goto(`${base}/index.html?debug${sc.query || ''}`);
        await waitForFirstMap(page);
        const tFirst = Date.now();
        await page.evaluate(() => { window.__firstMapSeen = true; });
        r.policyInputs = await page.evaluate(() => ({ connection: navigator.connection ? { effectiveType: navigator.connection.effectiveType, saveData: navigator.connection.saveData } : null,
            finePointer: matchMedia('(pointer: fine)').matches, wide: matchMedia('(min-width: 1024px)').matches }));
        await page.waitForTimeout(WAIT_S * 1000);
        const before = log.filter(e => e.t >= 0).map(e => ({ ...e, ms: e.t - tFirst }));
        r.requestsBeforeClick = before.map(e => `${e.ms}ms ${e.status} ${e.path}`);
        r.gridBeforeClick = before.filter(e => GRID.test(e.path)).map(e => e.path);
        r.pricingBeforeClick = before.filter(e => PRICING.test(e.path)).map(e => e.path);
        r.pillsInCapacity = await page.evaluate(() => window.__pill.filter(p => p.view === 'capacity'));
        const warmed = r.gridBeforeClick.length > 0 || (!sc.pricingOk && r.pricingBeforeClick.length > 0);
        const fullWarm = r.gridBeforeClick.length === 16 && r.pricingBeforeClick.length === 2;
        if (sc.expectWarm) lines.push(`${fullWarm ? 'PASS' : 'FAIL'} ${sc.name}: warmed before the click (${r.gridBeforeClick.length} grid files of 16, ${r.pricingBeforeClick.length} pricing files of 2)`);
        else lines.push(`${!warmed ? 'PASS' : 'FAIL'} ${sc.name}: ${sc.pricingOk ? 'no grid file' : 'nothing warmed'} before the click (${r.gridBeforeClick.length} grid files, ${r.pricingBeforeClick.length} pricing files)`);
        lines.push(`${r.pillsInCapacity.length ? 'FAIL' : 'PASS'} ${sc.name}: no loading pill in the Capacity view after the first map${r.pillsInCapacity.length ? ` (${JSON.stringify(r.pillsInCapacity.slice(0, 3))})` : ''}`);
        if (sc.open) {
            const m = await mark(page);
            await page.click('button[data-mode="lcoe"]');
            const res = await timeToResult(page, 'lcoe', T90, m, { quietMs: 2000, timeout: 240000 });
            r.openMs = res.ms;
            lines.push(`${res.ms != null ? 'PASS' : 'FAIL'} ${sc.name}: LCOE map = add-on oracle lcoe_t90 ${res.ms != null ? `${res.ms} ms after the click` : 'never (timed out)'}`);
        }
    } catch (e) {
        errors.push(`probe aborted: ${e.message.split('\n')[0]}`);
    } finally {
        await browser.close();
        srv.close();
    }
    r.errors = errors;
    if (errors.length) lines.push(`FAIL ${sc.name}: ${errors.length} page errors, first: ${errors[0]}`);
    lines.push(`INFO ${sc.name}: policy inputs ${JSON.stringify(r.policyInputs)}; load ${r.load}`);
    out.scenarios[sc.name] = r;
    for (const l of lines.splice(0)) { console.log(l); (out.lines ||= []).push(l); }
}
const file = path.join(HERE, 'out', `warm-probe-${path.basename(path.dirname(SITE))}.json`);
writeJson(file, out);
console.log(`INFO written ${file}`);
process.exit(out.lines.some(l => l.startsWith('FAIL')) ? 1 : 0);
