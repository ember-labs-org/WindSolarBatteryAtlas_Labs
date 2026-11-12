// Shared helpers for the atlas checks: a static server for deployment/, a
// headless Chromium with the CDN scripts served from checks/vendor/, and a
// long-task recorder. Used by smoke.mjs, regress.mjs and bench.mjs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installDigest } from './digest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
// ATLAS_SITE lets the lead grade a worker's worktree with the lead's own checks.
export const SITE = path.resolve(process.env.ATLAS_SITE || path.join(ROOT, 'deployment'));
const VENDOR = path.join(HERE, 'vendor');

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.geojson': 'application/json', '.wasm': 'application/wasm',
    '.parquet': 'application/octet-stream', '.csv': 'text/csv', '.jpg': 'image/jpeg', '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

export function serve() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const file = path.join(SITE, decodeURIComponent(url.pathname));
        if (!file.startsWith(SITE)) { res.writeHead(403); return res.end(); }
        fs.stat(file, (err, st) => {
            if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
            fs.createReadStream(file).pipe(res);
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

function playwright() {
    const candidates = [process.env.PLAYWRIGHT_MODULE, '/opt/node-tools/node_modules/playwright/index.mjs', 'playwright'].filter(Boolean);
    return (async () => {
        for (const c of candidates) { try { return await import(c); } catch (_) { /* try next */ } }
        throw new Error('playwright not found: set PLAYWRIGHT_MODULE to its index.mjs');
    })();
}

// ---------------------------------------------------------------------------
// Browser: the full Chromium build, pinned in team/ACCEPTANCE.md. Never the
// Playwright headless shell, whose renderers carry no --user-data-dir, so C9
// (renderer RSS) could not be measured. No silent fallback: if the full build
// is missing, the checks stop and say so.
// ---------------------------------------------------------------------------
const BROWSERS_DIR = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

/** The pinned build from the "Browser (pinned)" line of team/ACCEPTANCE.md. */
export function pinnedBrowser() {
    const file = path.join(ROOT, 'team', 'ACCEPTANCE.md');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const m = text.match(/Browser \(pinned\):\*\*\s*`([^`]+)`[^`\n]*`([^`]+)`/);
    return m ? { build: m[1], version: m[2] } : null;
}

let browserCache = null;
/** Resolve the Chromium to launch: CHROMIUM_PATH, else the pinned (or newest)
 *  /opt/pw-browsers/chromium-<n>/chrome-linux*\/chrome. Throws if none exists. */
export function resolveBrowser() {
    if (browserCache) return browserCache;
    const pinned = pinnedBrowser();
    let exe = process.env.CHROMIUM_PATH;
    if (exe) {
        if (!fs.existsSync(exe)) throw new Error(`CHROMIUM_PATH=${exe} does not exist`);
    } else {
        const found = [];
        for (const d of fs.existsSync(BROWSERS_DIR) ? fs.readdirSync(BROWSERS_DIR) : []) {
            const n = d.match(/^chromium-(\d+)$/);
            if (!n) continue;
            for (const sub of fs.readdirSync(path.join(BROWSERS_DIR, d))) {
                const p = path.join(BROWSERS_DIR, d, sub, 'chrome');
                if (/^chrome-linux/.test(sub) && fs.existsSync(p)) found.push({ build: d, rev: Number(n[1]), exe: p });
            }
        }
        if (!found.length) {
            throw new Error(`no full Chromium build found under ${BROWSERS_DIR}/chromium-*/chrome-linux*/chrome; ` +
                'install it (npx playwright install chromium) or set CHROMIUM_PATH. The headless shell is not accepted: C9 cannot be measured with it');
        }
        found.sort((a, b) => b.rev - a.rev);
        exe = (found.find(f => pinned && f.build === pinned.build) || found[0]).exe;
    }
    // Resolve symlinks first, so a link to the shell under a neutral name is caught.
    try { exe = fs.realpathSync(exe); } catch (_) { /* existence is checked above */ }
    if (/headless[_-]shell/.test(exe)) throw new Error(`${exe} is the headless shell; C9 needs the full Chromium build`);
    let version = null;
    try { version = (execSync(`"${exe}" --version`, { encoding: 'utf8', timeout: 30000 }).match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] || null; } catch (_) { /* reported below */ }
    if (!version) throw new Error(`could not read the version of ${exe}`);
    const build = (exe.match(/(chromium-\d+)/) || [])[1] || null;
    const mismatch = !pinned ? 'no "Browser (pinned)" line in team/ACCEPTANCE.md'
        : version !== pinned.version ? `browser ${build || exe} ${version} is not the pinned ${pinned.build} ${pinned.version}; perf thresholds and baselines were measured on the pinned build`
        : null;
    browserCache = { exe, build, version, pinned, mismatch };
    return browserCache;
}

/** One line describing the browser in use, for logs and output files. */
export function browserLine() {
    const b = resolveBrowser();
    return `browser ${b.exe} (${b.build || 'custom'}, ${b.version})${b.mismatch ? ` MISMATCH: ${b.mismatch}` : ', matches the pinned build'}`;
}


// ---------------------------------------------------------------------------
// Machine-wide lock (D-018). The bench takes it exclusively; regress and smoke
// share it, so they can run alongside each other but never alongside a bench.
// The script re-runs itself under `flock -o -w`, so waiting is bounded, and under
// `timeout`, so a hung run can't hold the lock for ever. With -o the lock is held
// by flock itself, not by the browser, so a killed run never leaves it orphaned.
// ---------------------------------------------------------------------------
export const LOCK = process.env.ATLAS_LOCK || '/tmp/atlas-bench.lock';
export function runUnderLock(mode, { waitS = 3600, runS = 2700 } = {}) {
    if (process.env.ATLAS_LOCK_HELD) return;
    waitS = Number(process.env.ATLAS_LOCK_WAIT_S) || waitS;
    if (spawnSync('flock', ['--version']).status !== 0) {
        console.log(`WARN flock not available: running without the machine-wide bench lock`);
        return;
    }
    const flag = mode === 'exclusive' ? '-x' : '-s';
    const busy = spawnSync('flock', [flag, '-n', '-E', '75', LOCK, 'true']).status === 75;
    if (busy) console.error(`waiting up to ${waitS} s for the ${mode} lock on ${LOCK} (another bench${mode === 'exclusive' ? ' or regression run' : ''} is running)`);
    const res = spawnSync('flock', [flag, '-o', '-w', String(waitS), '-E', '75', LOCK,
        'timeout', '-k', '30', String(runS), process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, ATLAS_LOCK_HELD: mode } });
    const script = path.basename(process.argv[1]);
    if (res.status === 75) console.log(`FAIL ${script} could not get the ${mode} lock on ${LOCK} within ${waitS} s`);
    else if (res.status === 124 || res.status === 137) console.log(`FAIL ${script} ran over ${runS} s and was stopped`);
    process.exit(res.status ?? 1);
}

export async function openPage({ throttle = 1 } = {}) {
    const { chromium } = await playwright();
    const b = resolveBrowser();
    const browser = await chromium.launch({
        executablePath: b.exe,
        args: ['--enable-precise-memory-info', '--js-flags=--expose-gc', `--atlas-check-tag=${process.pid}`]
    });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource/.test(t)) return;   // aborted font requests
        errors.push(`console.error: ${t}`);
    });
    // CDN scripts come from checks/vendor; everything else off-origin (fonts) is dropped.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => {
        const u = route.request().url();
        if (u.includes('leaflet.js')) return route.fulfill({ path: path.join(VENDOR, 'leaflet.js'), contentType: 'text/javascript' });
        if (u.includes('leaflet.css')) return route.fulfill({ path: path.join(VENDOR, 'leaflet.css'), contentType: 'text/css' });
        if (u.includes('d3js.org')) return route.fulfill({ path: path.join(VENDOR, 'd3.v7.min.js'), contentType: 'text/javascript' });
        return route.abort();
    });
    await page.addInitScript(() => {
        window.__lt = [];
        try {
            const take = l => { for (const e of l) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); };
            const obs = new PerformanceObserver(l => take(l.getEntries()));
            obs.observe({ type: 'longtask', buffered: true });
            window.__ltFlush = () => take(obs.takeRecords());
        } catch (_) { /* no long-task API: longTasks() returns null and the checks fail */ }
        // Log every draw the app reports (?debug), as [view, seq, time]. The app's
        // __drawn keeps only the latest draw per view; the log lets a result check
        // tell a draw after the last move from a stale one before it.
        window.__drawLog = [];
        let hook;
        Object.defineProperty(window, '__atlasDrawn', {
            configurable: true,
            get: () => hook,
            set: f => {
                hook = typeof f !== 'function' ? f : (view, ...rest) => {
                    f(view, ...rest);
                    const log = window.__drawLog;
                    log.push([view, window.__drawn ? window.__drawn.seq : 0, performance.now()]);
                    if (log.length > 2000) log.splice(0, 1000);
                };
            }
        });
    });
    // Digests of what was drawn are computed by checks/digest.mjs, not by the app.
    await page.addInitScript(installDigest);
    if (throttle > 1) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    }
    return { browser, page, errors, browserInfo: { ...b, launched: browser.version() } };
}

export async function waitForFirstMap(page, timeout = 300000) {
    await page.waitForFunction(() => {
        const l = document.getElementById('loading');
        if (!l) return true;
        const cs = getComputedStyle(l);
        return l.classList.contains('hidden') || cs.display === 'none' || cs.opacity === '0';
    }, null, { timeout });
}

export const now = page => page.evaluate(() => performance.now());

/** Long tasks between page times `from` and `to`. Null if the long-task observer
 *  never started, so a check reads "not measured" instead of passing at 0. */
export const longTasks = (page, from, to = Infinity) => page.evaluate(([f, t]) => {
    if (typeof window.__ltFlush !== 'function') return null;
    window.__ltFlush();
    const a = window.__lt.filter(x => x[0] >= f && x[0] < t);
    return { n: a.length, max: Math.max(0, ...a.map(x => x[1])), total: a.reduce((s, x) => s + x[1], 0) };
}, [from, to]);

// ---------------------------------------------------------------------------
// Freezes from a Chrome trace (T019, D-038). The long-task observer above ends
// before Chrome rasterises a canvas at the end of the task (FinalizeFrame), so a
// step that freezes the page for 1 s can read as 170 ms there. The trace's outer
// `RunTask` (category disabled-by-default-devtools.timeline) wraps the whole
// task: script, microtasks and that end-of-task raster. Only that category and
// user timing are recorded, and only top-level tasks and the sync marks are kept,
// so the trace stays small. Page times come from performance.mark sync marks,
// which also identify the page's renderer main thread.
// ---------------------------------------------------------------------------
const TRACE_CATEGORIES = ['disabled-by-default-devtools.timeline', 'blink.user_timing'];
const TOP_LEVEL = new Set(['RunTask', 'ThreadControllerImpl::RunTask']);
const SYNC = 'atlas-trace-sync-';
export const LONG_TASK_MS = 50;

/** Start tracing the whole browser. Returns { sync(page), stop() }: sync() drops a
 *  mark into the page (call it after navigating and again at the end); stop()
 *  ends tracing and returns the page's main-thread tasks in page time, or
 *  { error } if the trace can't be tied to the page. */
export async function startTrace(browser) {
    const cdp = await browser.newBrowserCDPSession();
    const tasks = [];          // [pid, tid, ts µs, dur µs] of top-level tasks, every thread
    const open = new Map();    // pid:tid -> stack of B events, should the build emit B/E pairs
    const marks = [];          // { name, pid, tid, ts } of the sync marks
    let events = 0;
    cdp.on('Tracing.dataCollected', ({ value }) => {
        events += value.length;
        for (const e of value) {
            if (TOP_LEVEL.has(e.name)) {
                if (e.ph === 'X') tasks.push([e.pid, e.tid, e.ts, e.dur || 0]);
                else if (e.ph === 'B') { const k = `${e.pid}:${e.tid}`; (open.get(k) || open.set(k, []).get(k)).push(e.ts); }
                else if (e.ph === 'E') { const s = open.get(`${e.pid}:${e.tid}`)?.pop(); if (s != null) tasks.push([e.pid, e.tid, s, e.ts - s]); }
            } else if (e.cat === 'blink.user_timing' && typeof e.name === 'string' && e.name.startsWith(SYNC)) {
                marks.push({ name: e.name, pid: e.pid, tid: e.tid, ts: e.ts });
            }
        }
    });
    const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents',
        traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: 400 * 1024, includedCategories: TRACE_CATEGORIES } });
    const synced = [];         // { name, startTime } as the page saw them
    let k = 0;
    return {
        async sync(page) {
            const name = `${SYNC}${++k}`;
            synced.push({ name, startTime: await page.evaluate(n => performance.mark(n).startTime, name) });
        },
        async stop() {
            await cdp.send('Tracing.end');
            const done = await complete;
            await cdp.detach().catch(() => {});
            const lost = done && done.dataLossOccurred;
            // Each sync mark gives the offset between trace time and page time; they
            // must all be in the trace (else the buffer filled) and agree (else the
            // page navigated in between and page times no longer line up).
            const found = synced.map(s => ({ ...s, ev: marks.find(m => m.name === s.name) }));
            const missing = found.filter(s => !s.ev).map(s => s.name);
            if (!found.length) return { error: 'no sync mark was taken', events };
            if (missing.length || lost) return { error: `trace incomplete (${lost ? 'data loss reported' : `missing ${missing.join(', ')}`}; ${events} events)`, events };
            const { pid, tid } = found[0].ev;
            if (found.some(s => s.ev.pid !== pid || s.ev.tid !== tid)) return { error: 'sync marks came from different renderer threads (the page changed process)', events };
            const offs = found.map(s => s.ev.ts / 1000 - s.startTime);
            const spread = Math.max(...offs) - Math.min(...offs);
            if (spread > 1) return { error: `sync marks disagree by ${spread.toFixed(1)} ms (page reloaded?)`, events };
            const origin = offs[0];
            // Outermost tasks only: a nested run loop, or ThreadControllerImpl::RunTask
            // inside RunTask, is part of the enclosing task.
            const mine = tasks.filter(t => t[0] === pid && t[1] === tid)
                .map(t => [t[2] / 1000 - origin, t[3] / 1000]).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
            const top = [];
            for (const t of mine) {
                const p = top[top.length - 1];
                if (p && t[0] + t[1] <= p[0] + p[1] + 1e-3) continue;
                top.push(t);
            }
            if (!top.length) return { error: `no top-level tasks on the page's main thread in the trace (${events} events)`, events };
            return { pid, tid, events, tasks: top };
        }
    };
}

/** Freezes in page times [from, to) from a stopped trace: each top-level task on
 *  the page's main thread, clipped to the window, counts if the clipped part is
 *  over 50 ms, as a long task would. Same shape as longTasks(); null without a trace. */
export function traceFreezes(trace, from, to = Infinity) {
    if (!trace || !trace.tasks) return null;
    const a = [];
    for (const [s, d] of trace.tasks) {
        const ms = Math.min(s + d, to) - Math.max(s, from);
        if (ms > LONG_TASK_MS) a.push(Math.round(ms));
    }
    return { n: a.length, max: Math.max(0, ...a), total: a.reduce((x, y) => x + y, 0) };
}

/** Memory of each renderer process of this browser, keyed by pid: RSS and PSS in
 *  MB (PSS from /proc/<pid>/smaps_rollup; null if unreadable). Renderers are matched
 *  by the browser's --user-data-dir, found via the tag passed at launch. Workers and
 *  wasm memory live in the page's renderer, so its figures include them. Null if no
 *  renderer of this browser is found. C9 reads only the page's renderer: the
 *  others are idle (the spare renderer, the first about:blank one) and were
 *  210-310 MB of the old all-renderer sum (T001 audit 3, T017). */
export function rendererMemory() {
    try {
        const rows = execSync('ps -eo pid,rss,args', { encoding: 'utf8' }).split('\n').slice(1);
        const mine = rows.find(l => l.includes(`--atlas-check-tag=${process.pid}`) && !l.includes('--type='));
        const dir = mine && (mine.match(/--user-data-dir=(\S+)/) || [])[1];
        if (!dir) return null;
        const out = {};
        for (const l of rows) {
            if (!l.includes('--type=renderer') || !l.includes(`--user-data-dir=${dir}`)) continue;
            const [pid, rss] = l.trim().split(/\s+/).map(Number);
            let pssMb = null;
            try { pssMb = Math.round(Number(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m)[1]) / 1024); } catch (_) { /* not readable */ }
            out[pid] = { rssMb: Math.round(rss / 1024), pssMb };
        }
        return Object.keys(out).length ? out : null;
    } catch (_) { return null; }
}

/** A point in page time and draw sequence, taken just before a user action. */
export const mark = page => page.evaluate(() => ({ t: performance.now(), seq: window.__drawn ? window.__drawn.seq : 0 }));

/** Set a range input as a user would. Returns the mark taken just before the
 *  events fire, so a draw made synchronously by the handler counts as after it. */
export async function setRange(page, id, value) {
    return page.$eval(`#${id}`, (el, v) => {
        const m = { t: performance.now(), seq: window.__drawn ? window.__drawn.seq : 0 };
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return m;
    }, value);
}

/**
 * Move a range input through `values` as a user would: at fixed wall-clock times
 * `gapMs` apart, without waiting for the page in between. If the main thread is
 * busy, the input events queue up, as a real user's would. Returns the mark for
 * timeToResult: the page time at which the user made the last move (not when the
 * page got round to handling it), and the draw seq just before that move was handled.
 */
export async function sweep(page, id, values, gapMs) {
    const origin = await page.evaluate(() => performance.timeOrigin);
    const t0 = Date.now() + 50;
    const pending = [];
    for (let k = 0; k < values.length; k++) {
        const wait = t0 + k * gapMs - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        pending.push(setRange(page, id, values[k]));
    }
    const lastAt = Math.max(t0 + (values.length - 1) * gapMs, Date.now() - 1);   // the last move, epoch ms
    const marks = await Promise.all(pending);
    const final = await page.evaluate(i => document.getElementById(i).value, id);
    if (Number(final) !== Number(values[values.length - 1])) throw new Error(`sweep of #${id} ended on ${final}, not ${values[values.length - 1]}`);
    return { t: lastAt - origin, seq: marks[marks.length - 1].seq, handledLagMs: Math.round(marks[marks.length - 1].t - (lastAt - origin)) };
}

// FNV-1a over the joined digest; the same function runs in the page and in node.
export const HASH_SRC = `(rows) => { let h = 0x811c9dc5; const s = rows.join('\\n');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return rows.length + ':' + h.toString(16); }`;
export const hashRows = eval(HASH_SRC);

// Output files are per site, so runs that grade different worktrees don't
// overwrite each other's results.
export const SITE_TAG = `${path.basename(path.dirname(SITE)).replace(/[^\w.-]+/g, '_')}-${hashRows([SITE]).split(':')[1].slice(0, 6)}`;

/** The latest draw of `view` with its hash (recomputed only when a new draw has
 *  happened since the last poll, which keeps polling cheap during benchmarks),
 *  the app state, the page time, and the logged draws of `view` after `afterSeq`. */
function drawnState(page, view, afterSeq = Infinity) {
    return page.evaluate(([v, src, after]) => {
        const d = window.__drawn;
        const a = window.__atlas || {};
        const out = { now: performance.now(), seq: d ? d.seq : 0, info: null,
            state: { wind: a.wind, surface: a.surface, solar: a.solar, batt: a.batt },
            log: (window.__drawLog || []).filter(e => e[0] === v && e[1] > after).map(e => [e[1], e[2]]) };
        const info = d && window.__check.info(v);
        if (!info) return out;
        window.__hashCache = window.__hashCache || {};
        const c = window.__hashCache[v];
        let hash = c && c.seq === info.seq ? c.hash : null;
        if (!hash) { hash = (0, eval)(src)(window.__check.digest(v, false)); window.__hashCache[v] = { seq: info.seq, hash }; }
        out.info = { ...info, hash };
        return out;
    }, [view, HASH_SRC, afterSeq]);
}

/** After a timeToResult window, confirm the result is still what `view` shows: a
 *  stale answer arriving more than quietMs after the right one would otherwise
 *  pass (T001 audit 3, finding 1). On failure, nulls `res.ms` and records why. */
export async function confirmFinal(page, view, hash, res) {
    if (!res || res.ms == null) return res;
    const info = (await drawnState(page, view)).info;
    if (!info || info.hash !== hash) {
        res.replacedLate = { seq: info && info.seq, hash: info && info.hash };
        res.ms = null;
    }
    return res;
}

/** Hash of the digest of what is drawn in `view` (see drawnState). */
export const drawnHash = async (page, view) => (await drawnState(page, view)).info;

/** Wait until the drawn state of `view` satisfies `ok(info, state)`, was drawn after
 *  `after` (a mark, if given) and no new draw of that view has happened for
 *  `quietMs`. Returns the final info (with hash). */
export async function waitDrawn(page, view, ok = () => true, { quietMs = 6000, timeout = 180000, poll = 250, after = null } = {}) {
    const t0 = Date.now();
    let lastSeq = null, since = Date.now(), s = null;
    while (Date.now() - t0 < timeout) {
        s = await drawnState(page, view);
        const info = s.info;
        if (info && info.seq !== lastSeq) { lastSeq = info.seq; since = Date.now(); }
        if (info && (!after || info.seq > after.seq) && ok(info, s.state) && Date.now() - since >= quietMs) return info;
        await new Promise(r => setTimeout(r, poll));
    }
    const info = s && s.info;
    throw new Error(`timed out after ${timeout} ms waiting for the ${view} view to settle (last: ${JSON.stringify(info && { ...info, hash: undefined })}, state ${JSON.stringify(s && s.state)})`);
}

/**
 * Time from the user action at `mk` until `view` shows the result whose digest
 * hashes to `hash`, counting only a result that is final: drawn after the action
 * and not replaced by any other draw of that view for `quietMs`. A draw that
 * matches but is followed by a different one (a stale answer arriving late, or a
 * sweep passing through the final value) does not count. If the final value is
 * drawn several times in a row, the clock stops at the first of that last run.
 * Returns { ms, draws, superseded } (ms null on timeout); times are page times.
 */
export async function timeToResult(page, view, hash, mk, { quietMs = 2000, timeout = 120000, poll = 100 } = {}) {
    const t0 = Date.now();
    const seen = new Map();          // seq -> hash, for every draw a poll caught
    let s = null;
    while (Date.now() - t0 < timeout) {
        s = await drawnState(page, view, mk.seq);
        const info = s.info;
        if (info) seen.set(info.seq, info.hash);
        if (info && info.seq > mk.seq && info.hash === hash && s.now - info.at >= quietMs) {
            // Walk back over the logged draws while each one is known to match; a
            // draw no poll saw is treated as different, so the clock never stops early.
            const log = s.log.length ? s.log : [[info.seq, info.at]];
            let i = log.length - 1;
            while (i > 0 && seen.get(log[i - 1][0]) === hash) i--;
            const ms = Math.round(log[i][1] - mk.t);
            // A negative time means the page's time origin changed (a reload): not a result.
            if (ms < 0) return { ms: null, draws: log.length, superseded: i, note: 'negative time (page reloaded?)' };
            return { ms, draws: log.length, superseded: i, seq: info.seq };
        }
        await new Promise(r => setTimeout(r, poll));
    }
    return { ms: null, draws: s ? s.log.length : 0, superseded: null, last: s && s.info && { seq: s.info.seq, hash: s.info.hash } };
}

/** For actions with no oracle answer (pan, hover): wait at least `minMs` after
 *  `mk`, and until no view has drawn for `quietMs`, so a redraw the action caused,
 *  however late, falls inside the window. Returns the number of draws after `since`. */
export async function settleDraws(page, mk, { minMs = 1000, quietMs = 2000, timeout = 120000, poll = 100, since = mk } = {}) {
    const t0 = Date.now();
    while (true) {
        const s = await page.evaluate(after => {
            const log = (window.__drawLog || []).filter(e => e[1] > after);
            return { now: performance.now(), n: log.length, lastAt: log.length ? log[log.length - 1][2] : null };
        }, since.seq);
        const quiet = s.lastAt == null || s.now - s.lastAt >= quietMs;
        if ((s.now - mk.t >= minMs && quiet) || Date.now() - t0 > timeout) return { draws: s.n, settled: quiet };
        await new Promise(r => setTimeout(r, poll));
    }
}

export function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
}
