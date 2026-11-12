// C2, C4–C13: interaction benchmark at 4x CPU throttle (THROTTLE env to change).
// Each interaction window ends only once the correct final result is drawn
// (matched against checks/oracle.json), so work cannot hide by finishing late.
// Freezes (C4–C8, C13) are whole main-thread tasks from a Chrome trace, including
// the canvas raster at the end of a task, which the long-task observer misses
// (T019, D-038); the observer's figures are printed as INFO for comparison.
// Prints one PASS/FAIL line per check and writes checks/out/bench-<site>.json
// (plus a timestamped copy). Runs under the machine-wide lock, exclusively (D-018).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { serve, openPage, waitForFirstMap, now, longTasks, startTrace, traceFreezes, rendererMemory, writeJson, mark,
    hashRows, timeToResult, confirmFinal, waitDrawn, settleDraws, sweep, runUnderLock, resolveBrowser, browserLine, SITE, SITE_TAG } from './lib.mjs';

runUnderLock('exclusive', { waitS: 3600, runS: 2700 });

const HERE = path.dirname(new URL(import.meta.url).pathname);
const THROTTLE = Number(process.env.THROTTLE || 4);
const oracle = JSON.parse(fs.readFileSync(path.join(HERE, 'oracle.json'), 'utf8'));
const H = Object.fromEntries(Object.entries(oracle).map(([k, v]) => [k, hashRows(v)]));
// The bench opens the page with the add-on on (the production default), but
// oracle.json is add-on-off (regress adds &addon=0), so the cost keys come from
// the add-on oracle's digests (T092, T094).
const addonOracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'addon_oracle.json.gz'))));
for (const k of ['lcoe_t90', 'lcoe_t80']) H[k] = hashRows(addonOracle.keys[k].digest);
// BENCH_QUERY adds page flags, e.g. BENCH_QUERY='&warm=0' (T094).
const QUERY = process.env.BENCH_QUERY || '';
// Thresholds from team/ACCEPTANCE.md (signed off; change only with a DECISIONS.md entry).
const T = {
    lcoeSlider: { max: 300, total: 3000 },
    capacitySlider: { max: 500, total: 4000 },
    pan: { max: 250, total: 3000 },
    hover: { max: 60, total: 1000 },
    firstMapMs: 20000, loadFreezeMax: 2000,
    rssMb: 614,            // 50% of the median page-renderer RSS at end over 4 base runs (1,198/1,215/1,242/1,271 MB; c770a65, T017, D-060)
    gridReadyMs: 120000,
    lcoeResultMs: 3000, capacityResultMs: 1500,   // C11, C12 (D-014)
    viewSwitchMax: 500                            // C13 (D-014)
};
const SETTLE = 2000;   // long tasks are read until this long after the result appears
// Sweeps end on a value they have not visited before, so no earlier draw can
// equal the final answer; timeToResult also ignores any draw that is replaced.
// Moves go out at fixed times (150 / 120 ms apart) whether or not the page keeps
// up, and the C11/C12 clock starts when the last move is made.
const LCOE_SWEEP = [85, 75, 70, 65, 75, 80];
const SOLAR_SWEEP = [6, 7, 9, 10, 9, 7, 8];

const lines = [];
const check = (id, ok, msg) => lines.push(`${ok ? 'PASS' : 'FAIL'} ${id} ${msg}`);
const binfo = resolveBrowser();     // throws, loudly, if the full Chromium build is missing
const { server, base } = await serve();
const { browser, page, errors, browserInfo } = await openPage({ throttle: THROTTLE });
// A tracer that fails to start leaves the freeze checks "not measured" (FAIL), not a crash.
let tracer;
try { tracer = await startTrace(browser); }
catch (e) { tracer = { stop: async () => ({ error: `tracing failed to start: ${e.message.split('\n')[0]}` }) }; }
// Page-time windows [from, to] for the freeze checks, read from the trace at the
// end, and the long-task observer's view of the same windows.
const win = {}, obs = {};
const closeWindow = async (k, from, to) => {
    to = to ?? await now(page);
    win[k] = [from, to];
    obs[k] = await longTasks(page, from, to);
};
let siteCommit = null;
try { siteCommit = execSync('git rev-parse --short HEAD', { cwd: SITE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { /* not a git checkout */ }
const r = { throttle: THROTTLE, query: QUERY, startedAt: new Date().toISOString(), site: SITE, siteCommit,
    browser: { exe: binfo.exe, build: binfo.build, version: binfo.version, launched: browserInfo.launched, pinned: binfo.pinned, mismatch: binfo.mismatch } };
check('browser', !binfo.mismatch, browserLine());
// C9 reads the page's own renderer, identified after the run by the trace's sync
// marks (made on the page's main thread); peaks are kept per renderer until then.
const rssPeak = {};
const sampleRss = () => {
    const m = rendererMemory() || {};
    for (const [pid, v] of Object.entries(m)) rssPeak[pid] = Math.max(rssPeak[pid] || 0, v.rssMb);
    return m;
};
const rssTimer = setInterval(sampleRss, 2000);
try {
    const t0 = Date.now();
    await page.goto(`${base}/index.html?debug${QUERY}`);
    await waitForFirstMap(page);
    r.firstMap = Date.now() - t0;
    await tracer.sync(page);
    await page.waitForTimeout(10000);
    await closeWindow('load', 0);

    // Open the cost view straight away, so a background build can't hide its cost.
    let m = await mark(page);
    await page.click('button[data-mode="lcoe"]');
    r.gridReady = await timeToResult(page, 'lcoe', H.lcoe_t90, m, { quietMs: SETTLE, timeout: 300000 });
    await closeWindow('viewSwitch', m.t);
    await page.waitForTimeout(SETTLE);
    r.gridReadyMs = (await confirmFinal(page, 'lcoe', H.lcoe_t90, r.gridReady)).ms;

    m = await mark(page);
    let last = await sweep(page, 'target-cf-slider', LCOE_SWEEP, 150);
    r.lcoeInputLagMs = last.handledLagMs;
    r.lcoeResult = await timeToResult(page, 'lcoe', H.lcoe_t80, last, { quietMs: SETTLE, timeout: 120000 });
    await closeWindow('lcoeSlider', m.t);
    await page.waitForTimeout(SETTLE);
    r.lcoeResultMs = (await confirmFinal(page, 'lcoe', H.lcoe_t80, r.lcoeResult)).ms;

    m = await mark(page);
    await page.click('button[data-mode="capacity"]');
    await waitDrawn(page, 'capacity', i => i.solarGw === 5 && i.battGwh === 8, { quietMs: SETTLE, after: m });
    m = await mark(page);
    last = await sweep(page, 'solar-slider', SOLAR_SWEEP, 120);
    r.capacityInputLagMs = last.handledLagMs;
    r.capacityResult = await timeToResult(page, 'capacity', H.cap_s8_b8, last, { quietMs: SETTLE, timeout: 60000 });
    await closeWindow('capacitySlider', m.t);
    await page.waitForTimeout(SETTLE);
    r.capacityResultMs = (await confirmFinal(page, 'capacity', H.cap_s8_b8, r.capacityResult)).ms;

    // Pan and hover have no oracle answer: each window runs until a fixed time after
    // the last input and until no view has redrawn for SETTLE ms.
    const box = await page.locator('#map').boundingBox();
    m = await mark(page);
    for (let i = 0; i < 4; i++) {
        await page.mouse.move(box.x + 600, box.y + 400);
        await page.mouse.down();
        await page.mouse.move(box.x + 450, box.y + 350, { steps: 8 });
        await page.mouse.up();
        if (i < 3) await page.waitForTimeout(400);
    }
    r.panDraws = await settleDraws(page, await mark(page), { minMs: 3400, quietMs: SETTLE, since: m });
    await closeWindow('pan', m.t);

    m = await mark(page);
    for (let i = 0; i < 30; i++) { await page.mouse.move(box.x + 200 + i * 25, box.y + 300 + (i % 5) * 20); await page.waitForTimeout(30); }
    r.hoverDraws = await settleDraws(page, await mark(page), { minMs: 1000, quietMs: SETTLE, since: m });
    await closeWindow('hover', m.t);

    // End-of-run recheck: the last LCOE result must still be the one on record.
    if (r.lcoeResultMs != null) r.lcoeResultMs = (await confirmFinal(page, 'lcoe', H.lcoe_t80, r.lcoeResult)).ms;
    await closeWindow('whole', 0);
    await tracer.sync(page);
    r.renderersAtEnd = sampleRss();
    r.heapMainMb = await page.evaluate(() => { try { window.gc && window.gc(); } catch (_) {} return Math.round(performance.memory.usedJSHeapSize / 1e6); });
    // CDP throttles only the page's main thread; Chromium refuses it on worker
    // targets ("only supported for pages"). Measure and report the gap, after
    // everything else so it can't touch the windows above.
    r.workerThrottle = await page.evaluate(() => new Promise(resolve => {
        const loop = 'let x = 0; for (let i = 0; i < 5e7; i++) x += i % 7;';
        const w = new Worker(URL.createObjectURL(new Blob([`const t = performance.now(); ${loop} postMessage(performance.now() - t);`], { type: 'text/javascript' })));
        w.onmessage = e => {
            w.terminate();
            const t = performance.now(); (0, eval)(loop);
            resolve({ workerMs: Math.round(e.data), mainMs: Math.round(performance.now() - t) });
        };
        w.onerror = () => resolve(null);
    })).catch(() => null);
} catch (e) {
    errors.push(`bench aborted: ${e.message.split('\n')[0]}`);
} finally {
    clearInterval(rssTimer);
    try { r.trace = await tracer.stop(); } catch (e) { r.trace = { error: `tracing failed: ${e.message.split('\n')[0]}` }; }
    await browser.close();
    server.close();
}
r.errors = errors;
for (const k of Object.keys(win)) r[k] = traceFreezes(r.trace, ...win[k]);
r.windows = win;
r.longTaskObserver = obs;
const trace = r.trace || {};
r.trace = { error: trace.error, pid: trace.pid, tid: trace.tid, events: trace.events, tasks: trace.tasks && trace.tasks.length,
    // Every freeze of the run, [page time, ms], for a later look.
    freezes: trace.tasks && trace.tasks.filter(t => t[1] > 50).map(t => [Math.round(t[0]), Math.round(t[1])]) };
{
    // C9: the page's renderer only. Idle renderers of the same browser (the spare one,
    // the first about:blank one) are reported but not counted (T001 audit 3, T017).
    const all = r.renderersAtEnd || null;
    const mine = all && trace.pid != null ? all[trace.pid] : null;
    r.rssMb = mine ? mine.rssMb : null;
    r.pssMb = mine ? mine.pssMb : null;
    r.rssPeakMb = mine ? Math.max(rssPeak[trace.pid] || 0, mine.rssMb) : null;
    r.rssAllRenderersMb = all ? Object.values(all).reduce((x, v) => x + v.rssMb, 0) : null;
    r.rssNote = mine ? null : r.renderersAtEnd === undefined ? 'the bench stopped before the end-of-run reading'
        : !all ? 'no renderer of this browser found'
        : trace.pid == null ? `the page's renderer is not known (trace: ${trace.error || 'no pid'})`
        : `the page's renderer ${trace.pid} (from the trace) is not among this browser's renderers ${Object.keys(all).join(', ')}`;
}
const notMeasured = k => `not measured (${r.trace.error ? `trace: ${r.trace.error}` : `the bench stopped before the ${k} window`})`;
const obsInfo = (id, k) => {
    const v = obs[k];
    lines.push(`INFO ${id} long-task observer (ends before end-of-task canvas raster; not graded): ${v ? `longest ${v.max} ms, total ${v.total} ms, ${v.n} long tasks` : 'not measured'}`);
};

const lt = (id, k) => {
    const v = r[k];
    if (!v) check(id, false, `${k}: ${notMeasured(k)}`);
    else check(id, v.max <= T[k].max && v.total <= T[k].total, `${k}: longest freeze ${v.max} ms (<= ${T[k].max}), total ${v.total} ms (<= ${T[k].total}), ${v.n} main-thread tasks over 50 ms incl. canvas raster`);
    obsInfo(id, k);
};
const ms = v => (v == null ? 'never (timed out)' : `${v} ms`);
const stale = (x, lag) => (x && x.replacedLate ? '; the result was later replaced by a different draw (stale answer arrived late)' : '')
    + (x && x.note ? `; ${x.note}` : '')
    + (x && x.superseded ? `; ${x.superseded} earlier draw(s) after the last move were replaced` : '')
    + (lag > 50 ? `; the page handled the last move ${lag} ms after it was made` : '');
check('C2', errors.length === 0, errors.length ? `${errors.length} page errors, first: ${errors[0]}` : 'no page errors');
lt('C4', 'lcoeSlider');
lt('C5', 'capacitySlider');
lt('C6', 'pan');
lt('C7', 'hover');
check('C8', r.firstMap != null && r.firstMap <= T.firstMapMs && r.load != null && r.load.max <= T.loadFreezeMax,
    `first map ${ms(r.firstMap)} (<= ${T.firstMapMs}), longest freeze until 10 s after it ${r.load ? `${r.load.max} ms` : notMeasured('load')} (<= ${T.loadFreezeMax})`);
obsInfo('C8', 'load');
check('C9', r.rssMb != null && r.rssMb <= T.rssMb, r.rssMb == null
    ? `page renderer RSS not measured (${r.rssNote}; ${r.browser.exe})`
    : `page renderer RSS at end ${r.rssMb} MB (<= ${T.rssMb}); peak ${r.rssPeakMb} MB; PSS ${r.pssMb ?? '?'} MB; main-thread heap ${r.heapMainMb} MB`);
// Idle renderers end at 73-141 MB (spare and first about:blank renderer, every
// run so far). One well above that may hold memory moved out of the page's process.
const IDLE_RENDERER_MAX_MB = 200;
const bigOthers = Object.entries(r.renderersAtEnd || {}).filter(([p, v]) => Number(p) !== trace.pid && v.rssMb > IDLE_RENDERER_MAX_MB);
if (bigOthers.length) lines.push(`WARN C9 renderer(s) other than the page's end above idle size (${IDLE_RENDERER_MAX_MB} MB): ${bigOthers.map(([p, v]) => `${p}=${v.rssMb} MB`).join(', ')}; C9 counts only the page's renderer, so check where that memory went`);
if (r.renderersAtEnd) lines.push(`INFO C9 renderers at end (RSS MB by pid; page ${trace.pid ?? '?'}): ${Object.entries(r.renderersAtEnd).map(([p, v]) => `${p}=${v.rssMb}`).join(', ')}; all renderers ${r.rssAllRenderersMb} MB (the pre-T017 C9 figure)`);
check('C10', r.gridReadyMs != null && r.gridReadyMs <= T.gridReadyMs, `full-grid LCOE map (= oracle lcoe_t90) drawn ${ms(r.gridReadyMs)} after opening LCOE (<= ${T.gridReadyMs})${stale(r.gridReady)}`);
check('C11', r.lcoeResultMs != null && r.lcoeResultMs <= T.lcoeResultMs, `LCOE result for 80% (= oracle) drawn ${ms(r.lcoeResultMs)} after the last move (<= ${T.lcoeResultMs})${stale(r.lcoeResult, r.lcoeInputLagMs)}`);
check('C12', r.capacityResultMs != null && r.capacityResultMs <= T.capacityResultMs, `capacity result for 8/8 (= oracle) drawn ${ms(r.capacityResultMs)} after the last move (<= ${T.capacityResultMs})${stale(r.capacityResult, r.capacityInputLagMs)}`);
check('C13', r.viewSwitch != null && r.viewSwitch.max <= T.viewSwitchMax, `opening LCOE: longest freeze ${r.viewSwitch ? `${r.viewSwitch.max} ms` : notMeasured('viewSwitch')} until the full-grid map + 2 s (<= ${T.viewSwitchMax})`);
obsInfo('C13', 'viewSwitch');
lines.push(`INFO whole run (trace): longest main-thread task ${r.whole?.max} ms, ${r.whole?.n} tasks over 50 ms, ${r.whole?.total} ms blocked; long-task observer: longest ${obs.whole?.max} ms, ${obs.whole?.total} ms blocked`);
lines.push(r.trace.error ? `INFO trace: ${r.trace.error}` : `INFO trace: renderer main thread ${r.trace.pid}:${r.trace.tid}, ${r.trace.tasks} top-level tasks, ${r.trace.events} trace events`);
lines.push(r.workerThrottle
    ? `INFO CPU throttle applies to the main thread only: the same loop took ${r.workerThrottle.mainMs} ms on the main thread and ${r.workerThrottle.workerMs} ms in a worker, so worker time in C10, C11 and C13 is about ${(r.workerThrottle.mainMs / Math.max(1, r.workerThrottle.workerMs)).toFixed(1)}x faster than on the emulated device`
    : 'INFO could not measure worker throttling');
// Guard against silently lost trace events: whole tasks can only be at least as
// long as what the observer saw (true in every audited run).
if (r.whole && obs.whole && r.whole.total < obs.whole.total) lines.push(`WARN trace blocked time ${r.whole.total} ms is below the observer's ${obs.whole.total} ms; trace events may be missing`);
lines.push(`INFO site ${SITE} at ${siteCommit || 'unknown commit'}; pan redraws ${r.panDraws?.draws}, hover redraws ${r.hoverDraws?.draws}`);
r.lines = lines;

const stamp = r.startedAt.replace(/[:.]/g, '-');
writeJson(path.join(HERE, 'out', `bench-${SITE_TAG}-${stamp}.json`), r);
writeJson(path.join(HERE, 'out', `bench-${SITE_TAG}.json`), r);
for (const l of lines) console.log(l);
process.exit(lines.some(l => l.startsWith('FAIL')) ? 1 : 0);
