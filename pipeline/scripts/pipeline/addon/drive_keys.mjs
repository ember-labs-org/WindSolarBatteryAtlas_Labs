// T058: drive every cost key of the atlas (the regress.mjs flows plus lcoe_t99 and
// lcoe_t80_backup) with the add-on off (?addon=0), and record per key:
//   * the drawn digest (checks/digest.mjs, via checks/lib.mjs openPage)
//   * what the page sent the LCOE worker for it: the SET_LOOKUPS maps in force and
//     the COMPUTE_* payload (params, costMultipliers, target) – captured by wrapping
//     Worker.prototype.postMessage in an init script, so the app is not changed.
// Output (T058-interface.md §5): <out>/params_dump.json and <out>/digests_addon0.json.
// --record-oracle also writes lcoe_t99 and lcoe_t80_backup into checks/oracle.json
// (D-128: recorded on the merged base, add-on off).
//
//   ATLAS_SITE=<repo>/deployment CHROMIUM_PATH=... PLAYWRIGHT_MODULE=... \
//     node drive_keys.mjs --out <dir> [--record-oracle] [--flags '&addon=0']
import fs from 'node:fs';
import path from 'node:path';
import { serve, openPage, waitForFirstMap, setRange, waitDrawn, writeJson, mark, hashRows, SITE, ROOT }
    from '../../../../checks/lib.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out');
if (!OUT) throw new Error('--out <dir> required');
const FLAGS = arg('--flags', '&addon=0');
const RECORD = process.argv.includes('--record-oracle');
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;
fs.mkdirSync(OUT, { recursive: true });

const CAPTURE = () => {
    window.__t058msgs = { lookups: null, n: 0, log: [] };
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
        try {
            const t = msg && msg.type;
            if (t === 'SET_LOOKUPS') {
                window.__t058msgs.lookups = JSON.parse(JSON.stringify(msg.payload));
                window.__t058msgs.lookupsN = ++window.__t058msgs.n;
            } else if (t === 'COMPUTE_BEST_LCOE' || t === 'COMPUTE_CF_AT_TARGET_LCOE') {
                window.__t058msgs.log.push({ n: ++window.__t058msgs.n, type: t, requestId: msg.requestId,
                    payload: JSON.parse(JSON.stringify(msg.payload)), lookups: window.__t058msgs.lookups });
                if (window.__t058msgs.log.length > 50) window.__t058msgs.log.shift();
            }
        } catch (_) { /* capture only */ }
        return orig.call(this, msg, ...rest);
    };
};

const dump = { site: SITE, url_flags: `?debug${FLAGS}`, keys: {} };
const digests = {};
const lookupsSeen = new Map();   // json -> id, to store each distinct lookup set once
dump.lookups = {};

async function grab(page, view, key, type) {
    const d = await page.evaluate(v => { try { return { d: window.__check.digest(v) }; } catch (e) { return { err: e.message }; } }, view);
    if (d.err) throw new Error(`${key}: ${d.err}`);
    const m = await page.evaluate(t => {
        const log = window.__t058msgs.log.filter(x => x.type === t);
        return log[log.length - 1] || null;
    }, type);
    if (!m) throw new Error(`${key}: no ${type} message captured`);
    const lj = JSON.stringify(m.lookups);
    if (!lookupsSeen.has(lj)) { const id = `L${lookupsSeen.size}`; lookupsSeen.set(lj, id); dump.lookups[id] = m.lookups; }
    dump.keys[key] = { view, type, payload: m.payload, lookups: lookupsSeen.get(lj) };
    digests[key] = d.d;
    console.log(`  ${key}: ${d.d.length} rows ${hashRows(d.d)}; ${type} target ${m.payload.targetCf ?? m.payload.targetLcoe}; lookups ${lookupsSeen.get(lj)}`);
}

async function lcoeAt(page, key, target) {
    await page.waitForFunction(() => window.__atlas && window.__atlas.matrixReady, null, { timeout: 300000 });
    await setRange(page, 'target-cf-slider', target);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, target / 100), { quietMs: 8000 });
    await grab(page, 'lcoe', key, 'COMPUTE_BEST_LCOE');
}
async function sourceMode(page, which, mode) {
    const m = await mark(page);
    await page.click(`#${which}-source-toggle button[data-mode="${mode}"]`);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
}

const { server, base } = await serve();
const { browser, page, errors } = await openPage({ throttle: 1 });
await page.addInitScript(CAPTURE);
try {
    await page.goto(`${base}/index.html?debug${FLAGS}`);
    await waitForFirstMap(page);
    await page.click('button[data-mode="lcoe"]');
    await lcoeAt(page, 'lcoe_t90', 90);
    await lcoeAt(page, 'lcoe_t99', 99);
    await lcoeAt(page, 'lcoe_t80', 80);
    let m = await mark(page);
    await page.click('#include-offshore-toggle');
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
    await grab(page, 'lcoe', 'lcoe_t80_onshore', 'COMPUTE_BEST_LCOE');
    m = await mark(page);
    await page.click('#include-offshore-toggle');
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
    // backup on (default local fuel prices), Global capex and WACC
    m = await mark(page);
    await page.click('#diesel-backup-toggle');
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
    if (!(await page.$eval('#diesel-backup-toggle', el => el.checked))) throw new Error('backup toggle not on');
    await grab(page, 'lcoe', 'lcoe_t80_backup', 'COMPUTE_BEST_LCOE');
    m = await mark(page);
    await page.click('#diesel-backup-toggle');
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
    // local WACC, then back to Global
    await sourceMode(page, 'wacc', 'local');
    await grab(page, 'lcoe', 'lcoe_t80_localwacc', 'COMPUTE_BEST_LCOE');
    await sourceMode(page, 'wacc', 'global');
    // target-LCOE mode, settled answer after leaving and re-entering (D-023)
    m = await mark(page);
    await page.click('button[data-target-mode="lcoe"]');
    await waitDrawn(page, 'lcoe_cf', () => true, { quietMs: 4000, after: m });
    m = await mark(page);
    await page.click('button[data-target-mode="utilization"]');
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 4000, after: m });
    m = await mark(page);
    await page.click('button[data-target-mode="lcoe"]');
    await waitDrawn(page, 'lcoe_cf', () => true, { quietMs: 8000, after: m });
    await grab(page, 'lcoe_cf', 'lcoe_cf_default', 'COMPUTE_CF_AT_TARGET_LCOE');
    // Budget mode at $400/MWh (T058 audit): a budget where large solar + battery builds win.
    m = await mark(page);
    await page.fill('#target-lcoe-input', '400');
    await page.dispatchEvent('#target-lcoe-input', 'input');
    await waitDrawn(page, 'lcoe_cf', () => true, { quietMs: 8000, after: m });
    await grab(page, 'lcoe_cf', 'lcoe_cf_400', 'COMPUTE_CF_AT_TARGET_LCOE');
    if (dump.keys.lcoe_cf_400.payload.targetLcoe !== 400) throw new Error('lcoe_cf_400: worker was not asked for $400');
    m = await mark(page);
    await page.fill('#target-lcoe-input', '90');
    await page.dispatchEvent('#target-lcoe-input', 'input');
    await waitDrawn(page, 'lcoe_cf', () => true, { quietMs: 8000, after: m });
    m = await mark(page);
    await page.click('button[data-target-mode="utilization"]');
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
    // both Local at 2035
    await sourceMode(page, 'wacc', 'local');
    await sourceMode(page, 'capex', 'local');
    m = await setRange(page, 'lcoe-time-slider', 2035);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
    await grab(page, 'lcoe', 'lcoe_t80_local_y2035', 'COMPUTE_BEST_LCOE');
} finally {
    await browser.close();
    server.close();
}
if (errors.length) console.log(`WARN ${errors.length} page errors, first: ${errors[0]}`);
writeJson(path.join(OUT, 'params_dump.json'), dump);
writeJson(path.join(OUT, 'digests_addon0.json'), digests);

// Keys already in checks/oracle.json must match (proves the drive reproduces regress.mjs's flows).
const ORACLE = path.join(ROOT, 'checks', 'oracle.json');
const oracle = JSON.parse(fs.readFileSync(ORACLE, 'utf8'));
for (const k of Object.keys(digests)) {
    if (!oracle[k]) { console.log(`  ${k}: not in oracle.json`); continue; }
    const same = JSON.stringify(oracle[k]) === JSON.stringify(digests[k]);
    const diff = oracle[k].filter((r, i) => r !== digests[k][i]).length;
    console.log(`  ${k}: ${same ? 'identical to oracle.json' : `${diff} rows differ from oracle.json`}`);
}
if (RECORD) {
    for (const k of ['lcoe_t99', 'lcoe_t80_backup']) oracle[k] = digests[k];
    writeJson(ORACLE, oracle);
    console.log(`RECORDED lcoe_t99=${hashRows(digests.lcoe_t99)} lcoe_t80_backup=${hashRows(digests.lcoe_t80_backup)} into checks/oracle.json`);
}
