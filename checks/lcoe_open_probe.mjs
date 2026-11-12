// T094 probe: time from clicking the LCOE tab to the full-grid answer (= the
// add-on oracle's lcoe_t90) on a shaped network, and log every request the
// server sees. Not part of run_all; a measurement for T094 and later tasks.
//
//   node checks/lcoe_open_probe.mjs [--runs 3] [--mbps 50] [--rtt 40] [--throttle 1]
//        [--scenario immediate:&warm=0,delay10:&warm=1] [--out <file.json>]
//
// The server (not Chrome's network emulation, which may not reach nested
// workers) adds one round trip before each response and shares one bandwidth
// budget across all connections, like a single bottleneck link. It sends no
// cache headers and every run uses a fresh browser, so every run is a cold open.
// A scenario is <name>:<query>; a name starting with "delay<N>" opens LCOE N s
// after the first map, any other name straight after it. Runs under the bench
// lock, exclusively; the load average is printed with each run.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openPage, waitForFirstMap, mark, timeToResult, hashRows, runUnderLock, writeJson, SITE } from './lib.mjs';

runUnderLock('exclusive', { waitS: 3600, runS: 3600 });

const HERE = path.dirname(new URL(import.meta.url).pathname);
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const RUNS = Number(arg('runs', 3));
const MBPS = Number(arg('mbps', 50));
const RTT = Number(arg('rtt', 40));
const THROTTLE = Number(arg('throttle', 1));
const SCENARIOS = arg('scenario', 'immediate:&warm=0,delay10:&warm=1').split(',').map((s) => {
    const i = s.indexOf(':');
    const name = i < 0 ? s : s.slice(0, i);
    return { name, query: i < 0 ? '' : s.slice(i + 1), delayS: Number((name.match(/^delay(\d+)/) || [])[1] || 0) };
});
const OUT = arg('out', path.join(HERE, 'out', `lcoe-open-probe-${path.basename(path.dirname(SITE))}.json`));

const addonOracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'addon_oracle.json.gz'))));
const T90 = hashRows(addonOracle.keys.lcoe_t90.digest);

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.geojson': 'application/json', '.wasm': 'application/wasm',
    '.parquet': 'application/octet-stream', '.csv': 'text/csv', '.jpg': 'image/jpeg', '.png': 'image/png',
    '.svg': 'image/svg+xml'
};
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

/** A static server for SITE with one shared bandwidth budget and a fixed round trip. */
function shapedServer() {
    const bytesPerMs = MBPS > 0 ? MBPS * 1e6 / 8 / 1000 : Infinity;
    let busyUntil = 0;
    const log = [];
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const entry = { path: url.pathname + url.search, t: Date.now(), bytes: 0, status: 0, doneT: null };
        log.push(entry);
        const file = path.join(SITE, decodeURIComponent(url.pathname));
        let st = null;
        try { st = file.startsWith(SITE) ? fs.statSync(file) : null; } catch (_) { /* 404 below */ }
        await sleep(RTT);
        if (!st || !st.isFile()) { entry.status = 404; res.writeHead(404); res.end(); entry.doneT = Date.now(); return; }
        entry.status = 200;
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
        const fh = await fs.promises.open(file, 'r');
        try {
            const buf = Buffer.alloc(16384);
            for (let pos = 0; pos < st.size;) {
                const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
                if (!bytesRead) break;
                pos += bytesRead;
                if (Number.isFinite(bytesPerMs)) {
                    const start = Math.max(Date.now(), busyUntil);
                    busyUntil = start + bytesRead / bytesPerMs;
                    await sleep(busyUntil - Date.now());
                }
                entry.bytes += bytesRead;
                if (!res.write(Buffer.from(buf.subarray(0, bytesRead)))) await new Promise(r => res.once('drain', r));
                if (res.destroyed) break;
            }
        } finally {
            await fh.close();
            res.end();
            entry.doneT = Date.now();
        }
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
        resolve({ server, log, base: `http://127.0.0.1:${server.address().port}` })));
}

const median = a => { const s = [...a].filter(v => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const results = { site: SITE, mbps: MBPS, rttMs: RTT, throttle: THROTTLE, oracle: T90, runs: [] };
console.log(`INFO site ${SITE}; ${MBPS} Mbps, ${RTT} ms round trip, CPU x${THROTTLE}; result = add-on oracle lcoe_t90 ${T90}`);

for (let run = 1; run <= RUNS; run++) {
    for (const sc of SCENARIOS) {
        const { server, log, base } = await shapedServer();
        const { browser, page, errors } = await openPage({ throttle: THROTTLE });
        const r = { scenario: sc.name, query: sc.query, run, loadBefore: os.loadavg().map(v => v.toFixed(2)).join(' ') };
        try {
            const t0 = Date.now();
            await page.goto(`${base}/index.html?debug${sc.query}`);
            await waitForFirstMap(page);
            const tFirst = Date.now();
            r.firstMapMs = tFirst - t0;
            r.connection = await page.evaluate(() => {
                const c = navigator.connection;
                return c ? { effectiveType: c.effectiveType, saveData: c.saveData, downlink: c.downlink, rtt: c.rtt } : null;
            });
            if (sc.delayS) await page.waitForTimeout(sc.delayS * 1000);
            const m = await mark(page);
            const tClick = Date.now();
            await page.click('button[data-mode="lcoe"]');
            const res = await timeToResult(page, 'lcoe', T90, m, { quietMs: 1500, timeout: 180000 });
            r.openMs = res.ms;
            r.requests = log.map(e => ({ path: e.path, status: e.status, bytes: e.bytes,
                startMs: e.t - tFirst, endMs: e.doneT == null ? null : e.doneT - tFirst, beforeClick: e.t < tClick }));
            r.bytesBeforeClick = r.requests.filter(q => q.beforeClick).reduce((s, q) => s + q.bytes, 0);
            r.bytesTotal = r.requests.reduce((s, q) => s + q.bytes, 0);
        } catch (e) {
            errors.push(`probe aborted: ${e.message.split('\n')[0]}`);
        } finally {
            await browser.close();
            server.close();
        }
        r.errors = errors;
        r.loadAfter = os.loadavg().map(v => v.toFixed(2)).join(' ');
        results.runs.push(r);
        console.log(`RUN ${sc.name} #${run} (${sc.query || 'no flags'}): LCOE drawn ${r.openMs ?? 'never'} ms after the click; first map ${r.firstMapMs} ms; `
            + `${((r.bytesBeforeClick || 0) / 1e6).toFixed(1)} MB fetched before the click, ${((r.bytesTotal || 0) / 1e6).toFixed(1)} MB in all; `
            + `connection ${JSON.stringify(r.connection)}; load ${r.loadBefore} -> ${r.loadAfter}${errors.length ? `; ERRORS ${errors.join(' | ')}` : ''}`);
    }
}
for (const sc of SCENARIOS) {
    const v = results.runs.filter(r => r.scenario === sc.name).map(r => r.openMs);
    results[sc.name] = { median: median(v), all: v };
    console.log(`SUMMARY ${sc.name} (${sc.query || 'no flags'}): median ${median(v)} ms over ${v.length} runs [${v.join(', ')}]`);
}
writeJson(OUT, results);
console.log(`INFO written ${OUT}`);
