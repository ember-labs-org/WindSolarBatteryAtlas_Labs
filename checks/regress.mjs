// C3: results must not change. Drives the atlas at 1x CPU, reads digests of
// exactly what each map view drew (the app's draw records in window.__drawn,
// ?debug only, digested by checks/digest.mjs) and compares them
// element by element with checks/oracle.json. It also compares hashes of a fixed
// pseudo-random sample of further slices (wind on- and offshore) with
// checks/oracle_sample.json. `--record` rewrites oracle.json and `--record-sample`
// oracle_sample.json; only the lead does that, on the base commit, with a line in
// team/DECISIONS.md. Runs under the machine-wide lock, shared (D-018).
import fs from 'node:fs';
import path from 'node:path';
import { serve, openPage, waitForFirstMap, setRange, waitDrawn, writeJson, mark, hashRows,
    runUnderLock, resolveBrowser, browserLine, SITE, SITE_TAG } from './lib.mjs';

runUnderLock('shared', { waitS: 3600, runS: 1800 });

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ORACLE = path.join(HERE, 'oracle.json');
const SAMPLE = path.join(HERE, 'oracle_sample.json');
const record = process.argv.includes('--record');
const recordSample = process.argv.includes('--record-sample');
// `--record-key <key>` re-records one key of oracle.json and leaves the others as they are.
const rk = process.argv.indexOf('--record-key');
const recordKey = rk > 0 ? process.argv[rk + 1] : null;
const tStart = Date.now();
const step = m => process.env.REGRESS_VERBOSE && console.log(`step ${m}`);
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;
// T058: C3 judges today's results, so the sparse add-on is off (?addon=0) unless
// `--addon on` is given (then only keys the add-on cannot touch are meaningful;
// cost keys with the add-on are judged by checks/addon.mjs).
const ADDON = (() => { const i = process.argv.indexOf('--addon'); return i > 0 ? process.argv[i + 1] : 'off'; })();
const FLAGS = ADDON === 'on' ? '' : '&addon=0';

// A digest that can't be taken (no snapshot, or rows changed after the draw) is
// kept as its error and reported as that key's FAIL.
const digestErrors = {};
async function digestOf(page, view, key) {
    const r = await page.evaluate(v => { try { return { d: window.__check.digest(v) }; } catch (e) { return { err: e.message }; } }, view);
    if (r.err) { digestErrors[key] = r.err; return null; }
    return r.d;
}

async function capacity(page, out, key, solar, batt) {
    await setRange(page, 'solar-slider', solar);
    await setRange(page, 'batt-slider', batt);
    await waitDrawn(page, 'capacity', i => i.solarGw === solar && i.battGwh === batt && i.wind === 0);
    out[key] = await digestOf(page, 'capacity', key);
    step(key);
}

async function lcoeAt(page, out, key, target) {
    await page.waitForFunction(() => window.__atlas && window.__atlas.matrixReady, null, { timeout: 300000 });
    await setRange(page, 'target-cf-slider', target);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, target / 100), { quietMs: 8000 });
    out[key] = await digestOf(page, 'lcoe', key);
    step(key);
}

/** Click a cost-source toggle ('capex' or 'wacc') to a mode and wait for the LCOE redraw at target 80%. */
/** Firm backup on (least-cost diesel or gas, local fuel prices) at target 80%, then off again (T058, D-128). */
async function backupAt80(page, out, key) {
    let m = await mark(page);
    await page.click('#diesel-backup-toggle');
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
    if (!(await page.$eval('#diesel-backup-toggle', el => el.checked))) throw new Error('firm backup toggle did not switch on');
    out[key] = await digestOf(page, 'lcoe', key);
    step(key);
    m = await mark(page);
    await page.click('#diesel-backup-toggle');
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
}

async function sourceMode(page, which, mode) {
    const m = await mark(page);
    await page.click(`#${which}-source-toggle button[data-mode="${mode}"]`);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
}

/** Local-cost keys (T038), both calendar-independent. lcoe_t80_localwacc: Capex Global, WACC Local at the
 *  default year; global capex anchors at the base year and local WACC is flat. lcoe_t80_local_y2035: both
 *  Local with the timeline pinned to 2035, where local interpolation and the global anchors both land on
 *  their 2035 values (true for any calendar year up to 2035; the slider clamps below the base year).
 *  Each helper leaves the page as it found it (toggles Global, timeline at the base year). */
async function localWacc(page, out, suffix = '') {
    const key = `lcoe_t80_localwacc${suffix}`;
    await sourceMode(page, 'wacc', 'local');
    out[key] = await digestOf(page, 'lcoe', key);
    step(key);
    await sourceMode(page, 'wacc', 'global');
}

async function localBothAt2035(page, out, suffix = '') {
    const key = `lcoe_t80_local_y2035${suffix}`;
    await sourceMode(page, 'wacc', 'local');
    await sourceMode(page, 'capex', 'local');
    const m = await setRange(page, 'lcoe-time-slider', 2035);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
    const shown = await page.$eval('#lcoe-time-year', el => el.textContent.trim());
    if (shown !== '2035') throw new Error(`timeline year is ${shown}, not 2035`);
    out[key] = await digestOf(page, 'lcoe', key);
    step(key);
    const m2 = await setRange(page, 'lcoe-time-slider', 2026);   // clamps to the base year, as on load
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m2 });
    await sourceMode(page, 'capex', 'global');
    await sourceMode(page, 'wacc', 'global');
}

/** Pick the sample: one slice per wind level and surface, plus six without wind,
 *  drawn with a fixed seed from the simulated configurations. Only used to record. */
function pickSample() {
    const { configs } = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'configs.json'), 'utf8'));
    let seed = 20261023;
    const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const covered = new Set(['on|0|5|8', 'on|0|1|0', 'on|0|8|8', 'on|0|10|16', 'on|0|20|36', 'on|2|5|8']);
    const groups = new Map();
    for (const c of configs) {
        const k = `${c.surface}|${c.wind}`;
        if (!covered.has(`${k}|${c.solar}|${c.batt}`)) (groups.get(k) || groups.set(k, []).get(k)).push(c);
    }
    const pick = list => list.splice(Math.floor(rand() * list.length), 1)[0];
    const chosen = [];
    for (const list of groups.values()) chosen.push(pick(list));
    for (let i = 0; i < 6; i++) chosen.push(pick(groups.get('on|0')));
    // Grouped by wind setting, so the run loads each slice once.
    chosen.sort((a, b) => a.wind - b.wind || a.surface.localeCompare(b.surface) || a.solar - b.solar || a.batt - b.batt);
    return chosen.map(c => ({ key: `s${c.solar}_b${c.batt}_${c.wind ? `${c.surface === 'off' ? 'wo' : 'w'}${c.wind}` : 'w0'}`,
        surface: c.surface, wind: c.wind, solar: c.solar, batt: c.batt }));
}

/** Draw each sampled slice in the capacity view; returns the hash of what was drawn. */
async function drawSample(page, list) {
    const { configs } = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'configs.json'), 'utf8'));
    const state = () => page.evaluate(() => ({ wind: window.__atlas?.wind, surface: window.__atlas?.surface }));
    // The wind level and surface of the slice actually drawn (updateMap opts), not
    // the controls, which change as soon as a switch is requested.
    const slice = (i, c) => i.wind === c.wind && (!c.wind || i.surface === c.surface);
    const got = {};
    for (const c of list) {
        // Change wind first (it loads a slice and snaps solar and battery), let that
        // settle, then set solar and battery and wait for their draw.
        // Onshore and offshore have their own sliders (T022), each an index into
        // its surface's wind levels. Wind 0 is set on the slider now in use.
        const st = await state();
        if (st.wind !== c.wind || (c.wind && st.surface !== c.surface)) {
            const surface = c.wind ? c.surface : st.surface;
            const levels = [0, ...new Set(configs.filter(x => x.surface === surface && x.wind > 0).map(x => x.wind))].sort((x, y) => x - y);
            // T058: with the add-on both wind sliders can be up together; clear the other one first.
            const other = surface === 'off' ? 'wind-slider' : 'offwind-slider';
            if (await page.$eval(`#${other}`, el => el.value !== '0')) {
                const m0 = await setRange(page, other, 0);
                await waitDrawn(page, 'capacity', i => i.surface !== 'both', { quietMs: 1500, after: m0 });
            }
            const m = await setRange(page, surface === 'off' ? 'offwind-slider' : 'wind-slider', levels.indexOf(c.wind));
            await waitDrawn(page, 'capacity', i => slice(i, c), { quietMs: 1500, after: m });
        }
        const m = await setRange(page, 'solar-slider', c.solar);
        await setRange(page, 'batt-slider', c.batt);
        const info = await waitDrawn(page, 'capacity', (i, s) => i.solarGw === c.solar && i.battGwh === c.batt
            && slice(i, c) && s.wind === c.wind && (!c.wind || s.surface === c.surface), { quietMs: 3000, after: m });
        // Re-digest with the check that the drawn rows haven't changed since the draw.
        const d = await digestOf(page, 'capacity', c.key);
        got[c.key] = d ? hashRows(d) : `error (${digestErrors[c.key]})`;
        if (d && got[c.key] !== info.hash) got[c.key] = `${got[c.key]} (drawn as ${info.hash})`;
        step(`${c.key} ${info.hash}`);
    }
    return got;
}

const binfo = resolveBrowser();     // throws, loudly, if the full Chromium build is missing
if (binfo.mismatch) console.log(`WARN ${browserLine()}`);
if (!recordSample && !fs.existsSync(SAMPLE)) { console.log(`FAIL C3 ${SAMPLE} is missing`); process.exit(1); }
const sample = recordSample ? pickSample() : JSON.parse(fs.readFileSync(SAMPLE, 'utf8')).slices;
const { server, base } = await serve();
const out = {};
let sampleGot = {};
const errors = [];
let fatal = null;
let noWorker = null;
try {
    if (recordSample) throw null;   // only the sample is recorded; skip to it below
    // Main path: capacity slices, then the cost views.
    let { browser, page, errors: e1 } = await openPage({ throttle: 1 });
    try {
        await page.goto(`${base}/index.html?debug${FLAGS}`);
        await waitForFirstMap(page);
        await waitDrawn(page, 'capacity', i => i.solarGw === 5 && i.battGwh === 8 && i.wind === 0);
        out.cap_s5_b8 = await digestOf(page, 'capacity', 'cap_s5_b8');
        await capacity(page, out, 'cap_s1_b0', 1, 0);
        await capacity(page, out, 'cap_s8_b8', 8, 8);
        await capacity(page, out, 'cap_s10_b16', 10, 16);
        await capacity(page, out, 'cap_s20_b36', 20, 36);
        await setRange(page, 'solar-slider', 5);
        await setRange(page, 'batt-slider', 8);
        // Wait for a draw of the 2 GW onshore slice itself: the controls (window.__atlas)
        // switch to 2 GW before the slice has loaded, while the 0 GW map is still drawn.
        let m = await setRange(page, 'wind-slider', 2);      // index 2 of the wind levels = 2 GW onshore
        await waitDrawn(page, 'capacity', i => i.solarGw === 5 && i.battGwh === 8 && i.wind === 2 && i.surface === 'on', { after: m });
        out.cap_s5_b8_w2on = await digestOf(page, 'capacity', 'cap_s5_b8_w2on');
        m = await setRange(page, 'wind-slider', 0);
        await waitDrawn(page, 'capacity', i => i.wind === 0, { quietMs: 1500, after: m });

        await page.click('button[data-mode="lcoe"]');
        await lcoeAt(page, out, 'lcoe_t90', 90);
        await lcoeAt(page, out, 'lcoe_t99', 99);     // T058 (D-128)
        await lcoeAt(page, out, 'lcoe_t80', 80);
        // Onshore-only LCOE (T022): 'Include offshore wind' unticked at target 80%,
        // then ticked again so the target-LCOE case below searches both surfaces.
        m = await mark(page);
        await page.click('#include-offshore-toggle');
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
        out.lcoe_t80_onshore = await digestOf(page, 'lcoe', 'lcoe_t80_onshore');
        m = await mark(page);
        await page.click('#include-offshore-toggle');
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
        await backupAt80(page, out, 'lcoe_t80_backup');     // T058 (D-128)
        // Local WACC with global capex (T038), then back to Global so later keys are unaffected.
        await localWacc(page, out);
        // Target-LCOE mode: the first entry can draw a transient slice-only answer,
        // so the oracle is the settled answer after leaving and re-entering (D-023).
        m = await mark(page);
        await page.click('button[data-target-mode="lcoe"]');
        await waitDrawn(page, 'lcoe_cf', () => true, { quietMs: 4000, after: m });
        m = await mark(page);
        await page.click('button[data-target-mode="utilization"]');
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 4000, after: m });
        m = await mark(page);
        await page.click('button[data-target-mode="lcoe"]');
        await waitDrawn(page, 'lcoe_cf', () => true, { quietMs: 8000, after: m });
        out.lcoe_cf_default = await digestOf(page, 'lcoe_cf', 'lcoe_cf_default');
        // Both Local at 2035 (T038), last because it moves the timeline: back to the utilisation target first.
        m = await mark(page);
        await page.click('button[data-target-mode="utilization"]');
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
        await localBothAt2035(page, out);
    } finally { errors.push(...e1); await browser.close(); }

    // Fallback path (C3b): with the worker off, the main thread must reach the
    // same full-grid answer. Recorded nowhere: compared with lcoe_t80.
    if (!record && !recordKey) {
        ({ browser, page, errors: e1 } = await openPage({ throttle: 1 }));
        try {
            await page.goto(`${base}/index.html?debug&worker=0${FLAGS}`);
            await waitForFirstMap(page);
            await page.click('button[data-mode="lcoe"]');
            await page.waitForFunction(() => window.__atlas && window.__atlas.matrixReady, null, { timeout: 120000 })
                .catch(() => { noWorker = 'full grid never loaded with ?worker=0 (fallback searches only the wind level on screen)'; });
            if (!noWorker) {
                await setRange(page, 'target-cf-slider', 80);
                await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000 });
                out.lcoe_t80_noworker = await digestOf(page, 'lcoe', 'lcoe_t80_noworker');
                // Onshore only on the fallback, compared with lcoe_t80_onshore (T022).
                const m = await mark(page);
                await page.click('#include-offshore-toggle');
                await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
                out.lcoe_t80_onshore_noworker = await digestOf(page, 'lcoe', 'lcoe_t80_onshore_noworker');
                // Offshore back on, then the local-cost keys on the fallback (T038).
                const m2 = await mark(page);
                await page.click('#include-offshore-toggle');
                await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m2 });
                await backupAt80(page, out, 'lcoe_t80_backup_noworker');     // T058
                await localWacc(page, out, '_noworker');
                await localBothAt2035(page, out, '_noworker');
                await setRange(page, 'target-cf-slider', 99);              // T058
                await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.99), { quietMs: 8000 });
                out.lcoe_t99_noworker = await digestOf(page, 'lcoe', 'lcoe_t99_noworker');
            }
        } catch (e) { noWorker = e.message.split('\n')[0]; }
        finally { errors.push(...e1); await browser.close(); }
    }
} catch (e) {
    if (e) fatal = e.message.split('\n')[0];
}
// Sampled slices (hash only), in a fresh page so the main run's state can't leak in.
if (!fatal && !record && !recordKey) {
    const { browser, page, errors: e1 } = await openPage({ throttle: 1 });
    try {
        await page.goto(`${base}/index.html?debug${FLAGS}`);
        await waitForFirstMap(page);
        await waitDrawn(page, 'capacity', i => i.solarGw === 5 && i.battGwh === 8, { quietMs: 3000 });
        sampleGot = await drawSample(page, sample);
    } catch (e) { fatal = `sample run: ${e.message.split('\n')[0]}`; }
    finally { errors.push(...e1); await browser.close(); }
}
server.close();
const runtimeS = Math.round((Date.now() - tStart) / 1000);

if (errors.length) console.log(`WARN C3 ${errors.length} page errors, first: ${errors[0]}`);
if (fatal) {
    console.log(`FAIL C3 regression run did not complete: ${fatal}`);
    process.exit(1);
}
if (recordSample) {
    writeJson(SAMPLE, { note: 'Hashes (rows:FNV-1a) of the capacity-view digest for a fixed pseudo-random sample of slices; recorded on the base commit by regress.mjs --record-sample',
        recordedFrom: SITE, browser: binfo.version, slices: sample.map(c => ({ ...c, hash: sampleGot[c.key] })) });
    console.log(`RECORDED sample oracle (${sample.length} slices, ${runtimeS} s): ${sample.map(c => `${c.key}=${sampleGot[c.key]}`).join(' ')}`);
    process.exit(0);
}
if (recordKey) {
    const o = JSON.parse(fs.readFileSync(ORACLE, 'utf8'));
    if (!out[recordKey]) { console.log(`FAIL no digest for ${recordKey}${digestErrors[recordKey] ? `: ${digestErrors[recordKey]}` : ''}`); process.exit(1); }
    o[recordKey] = out[recordKey];
    writeJson(ORACLE, o);
    console.log(`RECORDED oracle key ${recordKey} = ${hashRows(out[recordKey])}`);
    process.exit(0);
}
if (record) {
    if (Object.keys(digestErrors).length) { console.log(`FAIL not recorded: ${JSON.stringify(digestErrors)}`); process.exit(1); }
    writeJson(ORACLE, out);
    console.log(`RECORDED oracle: ${Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' ')}`);
    process.exit(0);
}
const oracle = JSON.parse(fs.readFileSync(ORACLE, 'utf8'));
let failed = false;
for (const key of Object.keys(oracle)) {
    const want = oracle[key], got = out[key] || [];
    if (digestErrors[key]) { failed = true; console.log(`FAIL C3 ${key}: ${digestErrors[key]}`); continue; }
    let first = -1;
    for (let i = 0; i < Math.max(want.length, got.length); i++) if (want[i] !== got[i]) { first = i; break; }
    if (first < 0) { console.log(`PASS C3 ${key}: ${got.length} rows identical`); continue; }
    failed = true;
    const diff = want.filter((r, i) => r !== got[i]).length;
    console.log(`FAIL C3 ${key}: ${diff} of ${want.length} rows differ (got ${got.length}); first: oracle ${want[first] ?? '-'} vs now ${got[first] ?? '-'}. ` +
        'Find the change that altered results; never re-record the oracle to make this pass.');
}
if (!oracle.lcoe_t80_onshore) {
    failed = true;
    console.log(`FAIL C3 lcoe_t80_onshore: not in the oracle yet; drawn ${out.lcoe_t80_onshore ? hashRows(out.lcoe_t80_onshore) : digestErrors.lcoe_t80_onshore || 'nothing'}. ` +
        'Record it with --record-key lcoe_t80_onshore (D-061: 4998:260fc07c).');
}
{
    const want = oracle.lcoe_t80_onshore, got = out.lcoe_t80_onshore_noworker;
    const same = want && got && got.length === want.length && got.every((r, i) => r === want[i]);
    if (same) console.log(`PASS C3b ?worker=0 onshore-only fallback draws the same ${got.length} rows as lcoe_t80_onshore`);
    else {
        failed = true;
        const diff = want && got ? want.filter((r, i) => r !== got[i]).length : null;
        console.log(`FAIL C3b ?worker=0 onshore-only fallback: ${!want ? 'no lcoe_t80_onshore in the oracle'
            : noWorker || digestErrors.lcoe_t80_onshore_noworker || `${diff ?? want.length} of ${want.length} rows differ from lcoe_t80_onshore`}. ` +
            'With offshore excluded, the main-thread fallback must search the full grid like the worker.');
    }
}
for (const key of ['lcoe_t80_localwacc', 'lcoe_t80_local_y2035', 'lcoe_t80_backup', 'lcoe_t99']) {
    const want = oracle[key], got = out[`${key}_noworker`];
    const same = want && got && got.length === want.length && got.every((r, i) => r === want[i]);
    if (same) console.log(`PASS C3b ?worker=0 fallback draws the same ${got.length} rows as ${key}`);
    else {
        failed = true;
        const diff = want && got ? want.filter((r, i) => r !== got[i]).length : null;
        console.log(`FAIL C3b ?worker=0 fallback ${key}: ${!want ? `no ${key} in the oracle (record it with --record-key ${key})`
            : noWorker || digestErrors[`${key}_noworker`] || `${diff ?? want.length} of ${want.length} rows differ from ${key}`}. ` +
            'With local costs, backup or a 99% target the main-thread fallback must give the same answer as the worker.');
    }
}
{
    const want = oracle.lcoe_t80, got = out.lcoe_t80_noworker;
    const same = got && got.length === want.length && got.every((r, i) => r === want[i]);
    if (same) console.log(`PASS C3b ?worker=0 fallback draws the same ${got.length} rows as lcoe_t80`);
    else {
        failed = true;
        const diff = got ? want.filter((r, i) => r !== got[i]).length : want.length;
        console.log(`FAIL C3b ?worker=0 fallback: ${noWorker || digestErrors.lcoe_t80_noworker || `${diff} of ${want.length} rows differ from lcoe_t80`}. ` +
            'The main-thread fallback must load the full grid and search it like the worker.');
    }
}
{
    const bad = sample.filter(c => sampleGot[c.key] !== c.hash);
    for (const c of bad) console.log(`FAIL C3 sample ${c.key} (${c.surface === 'off' ? 'offshore' : 'onshore'} wind ${c.wind} GW, solar ${c.solar}, battery ${c.batt}): ` +
        `drawn ${sampleGot[c.key] ?? 'nothing'} vs oracle ${c.hash} (rows:hash). Find the change that altered results.`);
    if (!bad.length) console.log(`PASS C3 sample: ${sample.length} more slices identical (${sample.filter(c => c.wind && c.surface === 'off').length} offshore, ${sample.filter(c => c.wind && c.surface === 'on').length} onshore wind, ${sample.filter(c => !c.wind).length} without wind)`);
    failed ||= bad.length > 0;
}
console.log(`INFO regress ran in ${runtimeS} s on ${SITE}; ${browserLine()}`);
writeJson(path.join(HERE, 'out', `regress-${SITE_TAG}.json`), { failed, site: SITE, browser: { exe: binfo.exe, version: binfo.version, mismatch: binfo.mismatch },
    runtimeS, counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])), sample: sampleGot });
process.exit(failed ? 1 : 0);
