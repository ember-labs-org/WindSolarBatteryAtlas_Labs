// T058 before/after: bytes fetched and memory per view, for one site.
// Serves <site> itself and counts the bytes of every response (page, workers and
// loader workers alike). Steps: first map (capacity view), cost view (LCOE at the
// default 90% target, full grid ready), combined wind capacity view (onshore 2 +
// offshore 1; only where the site offers it), Sample Days. After each step:
// bytes fetched in that step (by file), main-thread JS heap (performance.memory,
// after gc), each live dedicated worker's JS heap (CDP Runtime.getHeapUsage via
// auto-attach) and the page renderer's RSS (ps; includes workers and wasm memory).
//
//   CHROMIUM_PATH=... PLAYWRIGHT_MODULE=... node measure_views.mjs <site> <label> <out.json>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { openPage, waitForFirstMap, waitDrawn, setRange, mark } from '../../../../checks/lib.mjs';

const [SITE, LABEL, OUT] = process.argv.slice(2);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.csv': 'text/csv', '.parquet': 'application/octet-stream',
    '.geojson': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
let served = [];
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = path.join(SITE, decodeURIComponent(url.pathname));
    if (!file.startsWith(SITE)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
        served.push([url.pathname, st.size]);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size,
            'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const { browser, page, errors } = await openPage({ throttle: 1 });
const cdp = await page.context().newCDPSession(page);
const workers = new Map();     // sessionId -> url
let msgId = 1;
const pending = new Map();
cdp.on('Target.attachedToTarget', e => {
    if (e.targetInfo.type === 'worker') workers.set(e.sessionId, e.targetInfo.url);
    cdp.send('Target.sendMessageToTarget', { sessionId: e.sessionId, message: JSON.stringify({ id: msgId++, method: 'Runtime.runIfWaitingForDebugger' }) }).catch(() => {});
});
cdp.on('Target.detachedFromTarget', e => workers.delete(e.sessionId));
cdp.on('Target.receivedMessageFromTarget', e => {
    const m = JSON.parse(e.message);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || null); pending.delete(m.id); }
});
await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });

// JS heap plus ArrayBuffer backing stores (typed arrays: the CF matrix, the add-on arrays).
const mb = r => r ? { usedMb: +(r.usedSize / 1e6).toFixed(1), backingMb: r.backingStorageSize != null ? +(r.backingStorageSize / 1e6).toFixed(1) : null,
    embedderMb: r.embedderHeapUsedSize != null ? +(r.embedderHeapUsedSize / 1e6).toFixed(1) : null } : { usedMb: null };
function footprint(pid) {
    try { const t = execSync(`footprint -p ${pid} 2>/dev/null`, { encoding: 'utf8' }); const m = t.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
        return m ? Math.round(Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]]) : null; } catch (_) { return null; }
}
async function workerHeaps() {
    const out = [];
    for (const [sessionId, url] of workers) {
        const id = msgId++;
        const p = new Promise(r => { pending.set(id, r); setTimeout(() => r(null), 3000); });
        await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.getHeapUsage' }) }).catch(() => {});
        const r = await p;
        out.push({ url: url.replace(base, ''), ...mb(r) });
    }
    return out;
}
function rendererRss() {
    const rows = execSync('ps -eo pid,rss,args', { encoding: 'utf8' }).split('\n').slice(1);
    const mine = rows.find(l => l.includes(`--atlas-check-tag=${process.pid}`) && !l.includes('--type='));
    const dir = mine && (mine.match(/--user-data-dir=(\S+)/) || [])[1];
    let best = 0, pid = null;
    for (const l of rows) {
        if (!l.includes('--type=renderer') || !dir || !l.includes(`--user-data-dir=${dir}`)) continue;
        const [p, rss] = l.trim().split(/\s+/).map(Number);
        if (rss > best) { best = rss; pid = p; }       // the page's renderer is the big one
    }
    return { rssMb: Math.round(best / 1024), footprintMb: pid ? footprint(pid) : null };
}
const result = { label: LABEL, site: SITE, steps: [] };
async function snapshot(step) {
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.gc && window.gc());
    const heap = mb(await cdp.send('Runtime.getHeapUsage').catch(() => null));
    const bytes = served.reduce((a, [, b]) => a + b, 0);
    const byFile = {};
    for (const [p, b] of served) byFile[p] = (byFile[p] || 0) + b;
    const s = { step, bytesMb: +(bytes / 1e6).toFixed(2), files: byFile, main: heap, workers: await workerHeaps(), renderer: rendererRss() };
    result.steps.push(s);
    console.log(`${LABEL} ${step}: ${s.bytesMb} MB fetched; main ${JSON.stringify(heap)}; workers ${JSON.stringify(s.workers.map(w => [path.basename(w.url), w]))}; renderer ${JSON.stringify(s.renderer)}`);
    served = [];
}
try {
    await page.goto(`${base}/index.html?debug`);
    await waitForFirstMap(page);
    await waitDrawn(page, 'capacity', () => true, { quietMs: 3000 });
    await snapshot('first map (capacity)');
    let m = await mark(page);
    await page.click('button[data-mode="lcoe"]');
    await page.waitForFunction(() => window.__atlas && window.__atlas.matrixReady, null, { timeout: 300000 });
    await waitDrawn(page, 'lcoe', () => true, { quietMs: 6000, after: m });
    await snapshot('cost view (LCOE, full grid)');
    m = await mark(page);
    await page.click('button[data-mode="capacity"]');
    await waitDrawn(page, 'capacity', () => true, { quietMs: 3000, after: m });
    served = [];
    const offMax = await page.$eval('#offwind-slider', el => Number(el.max));
    m = await setRange(page, 'wind-slider', 2);
    await waitDrawn(page, 'capacity', () => true, { quietMs: 3000, after: m });
    m = await setRange(page, 'offwind-slider', 1);
    await waitDrawn(page, 'capacity', () => true, { quietMs: 4000, after: m });
    const both = await page.evaluate(() => [document.getElementById('wind-val')?.textContent, document.getElementById('offwind-val')?.textContent]);
    await snapshot(`capacity, onshore ${both[0]} + offshore ${both[1]} (offshore levels ${offMax})`);
    m = await mark(page);
    await page.click('button[data-mode="samples"]');
    await page.waitForTimeout(8000);
    await snapshot('Sample Days');
} finally {
    await browser.close();
    server.close();
}
result.errors = errors;
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
