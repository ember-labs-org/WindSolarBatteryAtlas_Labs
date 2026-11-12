// T058: the sparse add-on builds in the app, against the independent oracle
// (pipeline/scripts/pipeline/addon/oracle.py -> checks/addon_oracle.json.gz).
//
// Cost keys (lcoe_t90, lcoe_t99, lcoe_t80, lcoe_t80_onshore, lcoe_t80_backup,
// lcoe_t80_localwacc, lcoe_cf_default, lcoe_t80_local_y2035), driven as
// drive_keys.mjs / regress.mjs drive them, on the worker and on ?worker=0:
//   A. the drawn digest (checks/digest.mjs) equals the oracle's for every row;
//      a row may differ only where the oracle marks a near tie (listed);
//   B. raw LCOE, no-wind LCOE, max-config LCOE and battery equal the oracle's to
//      1e-9 relative;
//   C. only the allowed changes against the add-on-off result (checks/oracle.json,
//      else the oracle's base_digest): (i) an add-on winner strictly better,
//      (ii) no-wind fields only where the best no-wind build is a large build,
//      (iii) max-config only where it is a combined build with a higher CF (or the
//      same CF, cheaper), (iv) the fallback winner only through (iii);
//   D. the add-on is exercised: winners and change counts > 0 where allowed
//      (no combined winner with offshore excluded), equal to the oracle's counts;
//   E. interpolation errs high: every interpolated winner's battery >= the
//      oracle's bisected minimum (b_true) - 1e-6;
//   F. ?worker=0 draws the same digest as the worker for every key.
// UI (worker page): both wind sliders at a combined build (capacity rows by
// region kind), a pair outside the simulated set snaps, labels and the panel note.
//
// The oracle must be for the site's data: every SHA-256 in its meta is compared
// with the site's files first. Runs under the machine-wide lock, shared (D-018).
//   ATLAS_SITE=<worktree>/deployment node checks/addon.mjs [--skip-noworker] [--skip-ui] [--keys k1,k2]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { serve, openPage, waitForFirstMap, setRange, waitDrawn, mark, hashRows, writeJson,
    runUnderLock, resolveBrowser, browserLine, SITE, SITE_TAG } from './lib.mjs';

runUnderLock('shared', { waitS: 3600, runS: 3600 });

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ORACLE_FILE = process.env.ADDON_ORACLE || path.join(HERE, 'addon_oracle.json.gz');
const BASE_FILE = process.env.ADDON_BASE_ORACLE || path.join(HERE, 'oracle.json');
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = arg('--keys') ? new Set(arg('--keys').split(',')) : null;
const SKIP_NOWORKER = process.argv.includes('--skip-noworker');
const SKIP_UI = process.argv.includes('--skip-ui');
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;
const tStart = Date.now();

const results = [];
const check = (ok, name, detail = '') => { results.push({ ok: !!ok, name, detail }); };
const uptimeMixWinners = {};

if (resolveBrowser().mismatch) console.log(`WARN ${browserLine()}`);
if (!fs.existsSync(ORACLE_FILE)) { console.log(`FAIL addon oracle ${ORACLE_FILE} is missing`); process.exit(1); }
const oracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(ORACLE_FILE)));
const base = fs.existsSync(BASE_FILE) ? JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')) : {};

// ---------------------------------------------------------------------------
// The oracle is for this site's data.
// ---------------------------------------------------------------------------
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
{
    const dataDir = path.join(SITE, 'data');
    const want = { 'addon.json': oracle.meta.addon_json_sha256, ...oracle.meta.addon_files, ...oracle.meta.data_sha256 };
    const bad = Object.entries(want).filter(([f, h]) => !fs.existsSync(path.join(dataDir, f)) || sha(path.join(dataDir, f)) !== h);
    check(!bad.length, 'the oracle was computed from this site\'s data files (SHA-256 of addon.json, both add-on files, every slice and configs.json)',
        bad.length ? `differ: ${bad.map(([f]) => f).join(', ')}` : `${Object.keys(want).length} files`);
    const mf = path.join(dataDir, 'addon.json');
    const manifest = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : null;
    const files = manifest ? manifest.sets.filter(s => sha(path.join(dataDir, s.file)) !== s.sha256).map(s => s.file) : ['addon.json missing'];
    check(!files.length, 'addon.json lists the SHA-256 of each add-on file', files.join(', '));
    // Different slices or configs: nothing below would mean anything. A different add-on
    // file or manifest is run anyway, to show what the app does with it (it must not pass).
    if (bad.some(([f]) => !/^addon/.test(f))) { report(); process.exit(1); }
}

// ---------------------------------------------------------------------------
// Driving the keys (the flows of drive_keys.mjs).
// ---------------------------------------------------------------------------
const KEYS = Object.keys(oracle.keys).filter(k => !ONLY || ONLY.has(k));
const RAW_FIELDS = ['location_id', 'solar_gw', 'wind_gw', 'wind_surface', 'wind_on_gw', 'wind_off_gw', 'batt_gwh', 'annual_cf', 'cf',
    'lcoe', 'meetsTarget', 'targetLcoeMet', 'noWindLcoe', 'noWindMeetsTarget', 'windSaving', 'maxConfigLcoe', 'maxConfigSolar',
    'maxConfigWind', 'maxConfigWindOn', 'maxConfigWindOff', 'maxConfigSurface', 'maxConfigBatt', 'addon', 'interpolated'];

async function grab(page, view, key, out) {
    const r = await page.evaluate(([v, fields]) => {
        try {
            const d = window.__check.digest(v);
            const rows = window.__drawn.views[v].copy.map(x => Object.fromEntries(fields.map(f => [f, x[f] === undefined ? null : x[f]])));
            return { d, rows };
        } catch (e) { return { err: e.message }; }
    }, [view, RAW_FIELDS]);
    if (r.err) throw new Error(`${key}: ${r.err}`);
    out[key] = r;
    console.log(`  ${key}: ${r.d.length} rows ${hashRows(r.d)}`);
}

async function driveKeys(page, out, want) {
    const need = k => want.has(k);
    const lcoeAt = async (key, target) => {
        await setRange(page, 'target-cf-slider', target);
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, target / 100), { quietMs: 8000 });
        if (need(key)) await grab(page, 'lcoe', key, out);
    };
    const toggle = async (sel) => {
        const m = await mark(page);
        await page.click(sel);
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
    };
    const sourceMode = (which, mode) => toggle(`#${which}-source-toggle button[data-mode="${mode}"]`);
    await page.click('button[data-mode="lcoe"]');
    await page.waitForFunction(() => window.__atlas && window.__atlas.matrixReady, null, { timeout: 300000 });
    await lcoeAt('lcoe_t90', 90);
    await lcoeAt('lcoe_t99', 99);
    await lcoeAt('lcoe_t80', 80);
    if (need('lcoe_t80_onshore')) {
        await toggle('#include-offshore-toggle');
        await grab(page, 'lcoe', 'lcoe_t80_onshore', out);
        await toggle('#include-offshore-toggle');
    }
    if (need('lcoe_t80_backup')) {
        await toggle('#diesel-backup-toggle');
        if (!(await page.$eval('#diesel-backup-toggle', el => el.checked))) throw new Error('backup toggle not on');
        await grab(page, 'lcoe', 'lcoe_t80_backup', out);
        await toggle('#diesel-backup-toggle');
    }
    if (need('lcoe_t80_localwacc')) {
        await sourceMode('wacc', 'local');
        await grab(page, 'lcoe', 'lcoe_t80_localwacc', out);
        await sourceMode('wacc', 'global');
    }
    if (need('lcoe_cf_default') || need('lcoe_cf_400')) {
        // Settled answer after leaving and re-entering (D-023).
        let m = await mark(page);
        await page.click('button[data-target-mode="lcoe"]');
        await waitDrawn(page, 'lcoe_cf', () => true, { quietMs: 4000, after: m });
        m = await mark(page);
        await page.click('button[data-target-mode="utilization"]');
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 4000, after: m });
        m = await mark(page);
        await page.click('button[data-target-mode="lcoe"]');
        await waitDrawn(page, 'lcoe_cf', () => true, { quietMs: 8000, after: m });
        await grab(page, 'lcoe_cf', 'lcoe_cf_default', out);
        if (need('lcoe_cf_400')) {
            // A budget where large solar + battery builds win (T058 audit), then back to $90.
            m = await mark(page);
            await page.fill('#target-lcoe-input', '400');
            await page.dispatchEvent('#target-lcoe-input', 'input');
            await waitDrawn(page, 'lcoe_cf', i => i.targetLcoe === 400, { quietMs: 8000, after: m });
            await grab(page, 'lcoe_cf', 'lcoe_cf_400', out);
            m = await mark(page);
            await page.fill('#target-lcoe-input', '90');
            await page.dispatchEvent('#target-lcoe-input', 'input');
            await waitDrawn(page, 'lcoe_cf', i => i.targetLcoe === 90, { quietMs: 8000, after: m });
        }
        m = await mark(page);
        await page.click('button[data-target-mode="utilization"]');
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
    }
    if (need('lcoe_t80_local_y2035')) {
        await sourceMode('wacc', 'local');
        await sourceMode('capex', 'local');
        const m = await setRange(page, 'lcoe-time-slider', 2035);
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m });
        await grab(page, 'lcoe', 'lcoe_t80_local_y2035', out);
        const m2 = await setRange(page, 'lcoe-time-slider', 2026);
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.8), { quietMs: 8000, after: m2 });
        await sourceMode('capex', 'global');
        await sourceMode('wacc', 'global');
    }
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------
const rel = (a, b) => (a === b ? 0 : (Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300) : Infinity));
const sameNum = (a, b, tol = 1e-9) => (a == null && b == null) || (a != null && b != null && rel(a, b) <= tol);
// Digest fields: id|solar|wind|surface|batt|lcoe|meets|cf|windSaving|maxConfigLcoe|noWindLcoe (lcoe view)
//                id|solar|wind|surface|batt|cf|lcoe|meets|targetLcoeMet (lcoe_cf view)
function parse(view, s) {
    const p = s.split('|');
    const interp = p[p.length - 1] === 'i';
    const build = p.slice(1, 5).join('|');
    if (view === 'lcoe_cf') return { id: Number(p[0]), build, cf: Number(p[5]), lcoe: Number(p[6]), meets: p[7], met: p[8], interp };
    return { id: Number(p[0]), build, lcoe: Number(p[5]), meets: p[6] === '1', cf: Number(p[7]), saving: p[8], maxLcoe: p[9], noWind: p[10], interp };
}

function compareKey(key, got, tag) {
    const o = oracle.keys[key];
    const view = o.view;
    const oRows = new Map(o.rows.map(r => [r.location_id, r]));
    // A. digest
    const want = o.digest;
    const d = got.d;
    const wantSet = new Set(want), gotSet = new Set(d);
    const missing = want.filter(x => !gotSet.has(x));
    const extra = d.filter(x => !wantSet.has(x));
    const tieOk = [], bad = [];
    for (const x of extra) {
        const id = Number(x.split('|')[0]);
        (oRows.get(id)?.near_tie ? tieOk : bad).push(x);
    }
    check(d.length === want.length && !bad.length, `${tag}${key}: drawn digest equals the oracle's (${want.length} rows)`,
        bad.length ? `${bad.length} rows differ; first: app ${bad[0]} vs oracle ${missing.find(m => m.split('|')[0] === bad[0].split('|')[0]) ?? '-'}`
            : `${hashRows(d)}${tieOk.length ? `; near ties accepted: ${tieOk.join(' ; ')}` : '; no near ties differ'}`);
    if (tag) return;   // B-E on the worker run only (F compares the digests)
    // B. raw numbers
    let worst = 0, worstAt = null, n = 0;
    for (const r of got.rows) {
        const w = oRows.get(r.location_id);
        if (!w || w.near_tie) continue;
        const fields = view === 'lcoe_cf' ? ['lcoe', 'batt_gwh', 'annual_cf'] : ['lcoe', 'batt_gwh', 'annual_cf', 'noWindLcoe', 'maxConfigLcoe', 'windSaving'];
        for (const f of fields) {
            n++;
            const e = f === 'windSaving' ? (r[f] == null && w[f] == null ? 0 : Math.abs((r[f] ?? NaN) - (w[f] ?? NaN)) / Math.max(1, Math.abs(w.noWindLcoe ?? 1)))
                : (r[f] == null && w[f] == null ? 0 : rel(r[f], w[f]));
            if (!(e <= worst)) { worst = e; worstAt = `${r.location_id}.${f}: app ${r[f]} vs oracle ${w[f]}`; }
        }
        for (const f of ['addon', 'interpolated', 'wind_on_gw', 'wind_off_gw', ...(view === 'lcoe' ? ['noWindMeetsTarget', 'maxConfigSurface', 'maxConfigWindOn', 'maxConfigWindOff'] : [])]) {
            n++;
            if (r[f] !== w[f]) { worst = Infinity; worstAt = `${r.location_id}.${f}: app ${r[f]} vs oracle ${w[f]}`; }
        }
    }
    check(worst <= 1e-9, `${key}: raw LCOE, no-wind and max-config LCOE, battery and add-on fields equal the oracle's (1e-9 relative)`,
        `${n} values; worst ${worst === 0 ? 0 : worst.toExponential(2)}${worstAt ? ` at ${worstAt}` : ''}`);
    // C. allowed changes against the add-on-off result
    const baseDigest = base[key] || o.base_digest;
    if (base[key]) {
        check(JSON.stringify(base[key]) === JSON.stringify(o.base_digest), `${key}: the oracle's add-on-off digest equals checks/oracle.json`);
    }
    const baseRows = new Map(baseDigest.map(s => { const p = parse(view, s); return [p.id, p]; }));
    const app = new Map(got.rows.map(r => [r.location_id, r]));
    const viol = [];
    const counts = { winner: 0, nowind_only: 0, maxconfig_only: 0, fallback: 0, changed: 0 };
    for (const s of d) {
        const n1 = parse(view, s);
        const b = baseRows.get(n1.id);
        const r = app.get(n1.id);
        if (!b) { viol.push(`${n1.id}: not in the add-on-off result`); continue; }
        const changedBuild = n1.build !== b.build || n1.interp !== b.interp;
        if (view === 'lcoe_cf') {
            const same = changedBuild || n1.cf !== b.cf || n1.lcoe !== b.lcoe || n1.meets !== b.meets || n1.met !== b.met;
            if (!same) continue;
            counts.changed++;
            const better = r.addon && (r.targetLcoeMet
                ? (!(b.met === '1') || n1.cf > b.cf || (n1.cf === b.cf && n1.lcoe <= b.lcoe))
                : (!(b.met === '1') && n1.lcoe <= b.lcoe));
            if (!better) viol.push(`${n1.id}: ${s} vs add-on off ${baseDigest.find(x => Number(x.split('|')[0]) === n1.id)}`);
            else counts.winner++;
            continue;
        }
        const winnerChanged = changedBuild || n1.lcoe !== b.lcoe || n1.meets !== b.meets || n1.cf !== b.cf;
        const noWindChanged = n1.noWind !== b.noWind;
        const maxChanged = n1.maxLcoe !== b.maxLcoe;
        const savingChanged = n1.saving !== b.saving;
        if (!winnerChanged && !noWindChanged && !maxChanged && !savingChanged) continue;
        counts.changed++;
        const why = [];
        if (winnerChanged) {
            // (i) an add-on winner meeting T, strictly cheaper than the dense one (or the dense one missed T);
            // (iv) the fallback winner, only through (iii): a combined build with a higher CF, or the same CF and cheaper.
            const okI = r.addon && n1.meets && (!b.meets || n1.lcoe <= b.lcoe);
            const okIV = !n1.meets && !b.meets && r.addon === 'wind_mix' && r.maxConfigSurface === 'both'
                && (n1.cf > b.cf || (n1.cf === b.cf && n1.lcoe <= b.lcoe));
            if (okI) counts.winner++;
            else if (okIV) counts.fallback++;
            else why.push('winner');
        }
        if (noWindChanged && !(r.noWindMeetsTarget && oRows.get(n1.id)?.change?.includes('nowind'))) why.push('noWind');
        if (maxChanged) {
            const okIII = r.maxConfigSurface === 'both';
            if (!okIII) why.push('maxConfig');
        }
        if (savingChanged && !winnerChanged && !noWindChanged) why.push('windSaving');
        if (!winnerChanged && noWindChanged && !maxChanged) counts.nowind_only++;
        if (!winnerChanged && maxChanged && !noWindChanged) counts.maxconfig_only++;
        if (why.length) viol.push(`${n1.id} (${why.join(', ')}): ${s} vs add-on off ${baseDigest.find(x => Number(x.split('|')[0]) === n1.id)}`);
    }
    check(!viol.length, `${key}: only the allowed changes against the add-on-off result`,
        viol.length ? `${viol.length} violations; first: ${viol.slice(0, 3).join(' ; ')}` : JSON.stringify(counts));
    // D. exercised
    const appCounts = {
        wind_mix_winners: got.rows.filter(r => r.addon === 'wind_mix').length,
        large_winners: got.rows.filter(r => r.addon === 'large').length,
        large_interpolated: got.rows.filter(r => r.addon === 'large' && r.interpolated).length
    };
    const oc = o.counts;
    const sameCounts = ['wind_mix_winners', 'large_winners', 'large_interpolated'].every(k => appCounts[k] === oc[k]);
    let exercised;
    if (key === 'lcoe_t80_onshore') exercised = appCounts.wind_mix_winners === 0 && appCounts.large_winners > 0 && counts.nowind_only > 0;
    else if (view === 'lcoe_cf') exercised = appCounts.wind_mix_winners > 0 && appCounts.large_interpolated === 0
        && (key !== 'lcoe_cf_400' || appCounts.large_winners > 0);
    // A combined winner is required across the uptime keys, not at each one (T081: none at 80%).
    else {
        exercised = appCounts.large_winners > 0 && appCounts.large_interpolated > 0
            && counts.nowind_only > 0 && counts.maxconfig_only > 0;
        uptimeMixWinners[tag] = (uptimeMixWinners[tag] || 0) + appCounts.wind_mix_winners;
    }
    check(exercised && sameCounts, `${key}: the add-on is exercised${key === 'lcoe_t80_onshore' ? ' (no combined winner with offshore excluded)' : ''}; counts equal the oracle's`,
        `app ${JSON.stringify({ ...appCounts, nowind_only: counts.nowind_only, maxconfig_only: counts.maxconfig_only, fallback: counts.fallback })}; oracle ${JSON.stringify(oc)}`);
    // E. interpolation errs high
    const interp = got.rows.filter(r => r.interpolated);
    const below = interp.filter(r => { const w = oRows.get(r.location_id); return !(w && Number.isFinite(w.b_true) && r.batt_gwh >= w.b_true - 1e-6); });
    if (interp.length) {
        check(!below.length, `${key}: every interpolated battery is at or above the bisected minimum (b_true - 1e-6)`,
            below.length ? `${below.length} below or unchecked; first ${below[0].location_id}: ${below[0].batt_gwh} vs ${oRows.get(below[0].location_id)?.b_true}`
                : `${interp.length} interpolated winners; smallest margin ${Math.min(...interp.map(r => r.batt_gwh - oRows.get(r.location_id).b_true)).toExponential(2)} GWh`);
    }
}

function report() {
    let failed = 0;
    for (const r of results) {
        if (!r.ok) failed++;
        console.log(`${r.ok ? 'PASS' : 'FAIL'} addon ${r.name}${r.detail ? ` – ${r.detail}` : ''}`);
    }
    console.log(`INFO addon ran in ${Math.round((Date.now() - tStart) / 1000)} s on ${SITE}; ${browserLine()}`);
    return failed;
}

/**
 * Once the cost search has said which add-on sets it loaded, the UI offers only
 * those (T058 audit): the wind sliders pair up only with the wind_mix set (else raising
 * one sets the other to 0). Since T062 the large-build note is static text in the info
 * panel, so the large set is judged by what the worker reports loaded (the draws are
 * judged against the oracle elsewhere).
 */
async function uiMatchesLoaded(page) {
    const st = await page.evaluate(() => ({ a: window.__atlas?.addon }));
    const active = st.a?.active || [];
    let m = await mark(page);
    await page.click('button[data-mode="capacity"]');
    await waitDrawn(page, 'capacity', () => true, { after: m, quietMs: 1500 });
    m = await setRange(page, 'wind-slider', 2);
    await waitDrawn(page, 'capacity', i => i.wind === 2 && i.surface === 'on', { after: m, quietMs: 1500 });
    m = await setRange(page, 'offwind-slider', 1);
    const i2 = await waitDrawn(page, 'capacity', i => i.surface !== 'on' || i.wind !== 2, { after: m, quietMs: 2000 });
    const sliders = await page.evaluate(() => ['wind-val', 'offwind-val'].map(id => document.getElementById(id).textContent).join('+'));
    const combined = i2.surface === 'both';
    const ok = st.a?.known === true && combined === active.includes('wind_mix')
        && (combined ? sliders === '2+1' : sliders === '0+1');
    check(ok, 'the UI offers only the add-on sets the worker loaded',
        `loaded ${JSON.stringify(active)}; large set ${active.includes('large') ? 'loaded' : 'not loaded'}; onshore 2 then offshore 1 -> ${sliders} (${combined ? 'combined' : 'sliders exclusive'})`);
    m = await setRange(page, 'offwind-slider', 0);
    await waitDrawn(page, 'capacity', i => i.surface === 'on', { after: m, quietMs: 1500 });
    m = await setRange(page, 'wind-slider', 0);
    await waitDrawn(page, 'capacity', i => i.wind === 0, { after: m, quietMs: 1500 });
}

// ---------------------------------------------------------------------------
// UI: both wind sliders, labels, panel note (worker page, add-on on).
// ---------------------------------------------------------------------------
const WIND_MIX_NOTE = 'Combined builds are simulated for onshore 1–4 + offshore 1–3 MW (5 at most in total)';
const PANEL_NOTE = 'Builds beyond the sliders (solar above 20 MW, battery above 36 MWh per MW of load) are searched only where the sliders cannot reach 99.9%. Their battery is interpolated between simulated sizes and always rounded up, and their ten-year weather record repeats – the battery starts the record with what it held at its end – while every slider build starts with an empty battery. Seasonal battery storage at this scale is a thought experiment, not a proposal. In \'cost within a budget\' mode they are used only at simulated sizes, so the two modes can differ slightly for the same region.';
const SEA_ONLY_NOTE = 'Onshore wind is not available here: no eligible land';
const LAND_ONLY_NOTE = 'Offshore wind is not available here: no eligible sea';

// Capture the Leaflet maps so a region can be hovered by its position (lesson drive-the-leaflet-map).
const CAPTURE_MAPS = () => {
    let leaflet;
    Object.defineProperty(window, 'L', {
        configurable: true,
        get: () => leaflet,
        set: (v) => {
            leaflet = v;
            try { v.Map.addInitHook(function () { (window.__lmaps ||= []).push(this); }); } catch (_) { /* not Leaflet yet */ }
        }
    });
};

// location_id -> { on, off } eligible sites, from the CSV the app reads.
function viability() {
    const [head, ...lines] = fs.readFileSync(path.join(SITE, 'data/voronoi_wind_resource.csv'), 'utf8').trim().split(/\r?\n/);
    const cols = head.split(',');
    const [ci, cOn, cOff] = ['location_id', 'on_viable', 'off_viable'].map(c => cols.indexOf(c));
    const out = new Map();
    for (const l of lines) { const p = l.split(','); out.set(Number(p[ci]), { on: Number(p[cOn]) === 1, off: Number(p[cOff]) === 1 }); }
    return out;
}

// The rows of one build from the slices and the add-on file, decoded in a blank page
// with the site's own parquet and Arrow libraries (not the app's code).
async function decodeExpected(browser, url, { solar, batt, on, off }) {
    const page = await browser.newPage();
    try {
        await page.goto(`${url}/data/configs.json`);
        return await page.evaluate(async ([sv, bv, a, o]) => {
            const pq = await import('/js/parquet_wasm.js');
            await pq.default({ module_or_path: await (await fetch('/js/parquet_wasm_bg.wasm')).arrayBuffer() });
            const { tableFromIPC } = await import('/js/apache-arrow.js');
            const read = async f => tableFromIPC(pq.readParquet(new Uint8Array(await (await fetch(`/data/${f}`)).arrayBuffer())).intoIPCStream());
            const slice = async (f) => {
                const t = await read(f);
                const [id, s, b, cf] = ['location_id', 'solar_gw', 'batt_gwh', 'annual_cf'].map(c => t.getChild(c).toArray());
                const m = {};
                for (let i = 0; i < t.numRows; i++) if (s[i] === sv && b[i] === bv) m[Number(id[i])] = cf[i];
                return m;
            };
            const manifest = await (await fetch('/data/addon.json')).json();
            const set = manifest.sets.find(x => x.id === 'wind_mix');
            const j = set.configs.find(c => c.on === a && c.off === o && c.solar === sv && c.batt === bv).j;
            const t = await read(set.file);
            const [id, cfg, cf] = ['location_id', 'cfg', 'annual_cf'].map(c => t.getChild(c).toArray());
            const mix = {};
            for (let i = 0; i < t.numRows; i++) if (cfg[i] === j) mix[id[i]] = cf[i];
            return { on: await slice(`summary_w${a}.parquet`), off: await slice(`summary_wo${o}.parquet`), mix };
        }, [solar, batt, on, off]);
    } finally {
        await page.close();
    }
}

async function hoverText(page, id, view) {
    return page.evaluate(async ([locId, v]) => {
        const row = window.__drawn.views[v].copy.find(r => r.location_id === locId);
        const m = window.__lmaps[0];
        m.setView([row.latitude, row.longitude], 6, { animate: false });
        await new Promise(r => setTimeout(r, 600));
        const p = m.latLngToContainerPoint([row.latitude, row.longitude]);
        const box = m.getContainer().getBoundingClientRect();
        return { x: box.left + p.x, y: box.top + p.y };
    }, [id, view]).then(async (pt) => {
        await page.mouse.move(pt.x - 3, pt.y - 3);
        await page.mouse.move(pt.x, pt.y);
        await page.waitForTimeout(500);
        return page.$eval('.leaflet-popup-content', el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
    });
}

async function uiChecks(page, browser, url) {
    // T062 (A-T062-16, D-138) moved the combined-build and beyond-the-sliders notes from the
    // control panels into the info panel's "Notes on the controls"; they are checked there.
    const dom = await page.evaluate(() => {
        const sec = [...document.querySelectorAll('#info-panel details')].find(d => /Notes on the controls/.test(d.querySelector('summary')?.textContent || ''));
        const items = sec ? [...sec.querySelectorAll('li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()) : [];
        return {
            solarMax: document.getElementById('solar-slider').max, battMax: document.getElementById('batt-slider').max,
            sliders: items.find(t => t.startsWith('Wind sliders:')) || '', beyond: items.find(t => t.startsWith('Builds beyond the sliders')) || '',
            panelIds: ['wind-mix-note', 'pop-wind-mix-note', 'addon-note', 'pop-addon-note'].filter(id => document.getElementById(id))
        };
    });
    check(dom.solarMax === '20' && dom.battMax === '36', 'the sliders keep solar up to 20 MW and battery up to 36 MWh', JSON.stringify({ solar: dom.solarMax, batt: dom.battMax }));
    check(dom.sliders.includes(WIND_MIX_NOTE), 'the combined-build note reads the contract text (info panel, Notes on the controls: Wind sliders)', dom.sliders.slice(0, 120));
    check(dom.beyond === PANEL_NOTE && !dom.panelIds.length, 'the note on builds beyond the sliders reads the contract text word for word (info panel, Notes on the controls), and the control panels no longer carry either note',
        `${dom.beyond.slice(0, 80)}; panel ids left: ${dom.panelIds.join(', ') || 'none'}`);

    // Both wind sliders: onshore 2 + offshore 1 at solar 5, battery 8.
    let m = await setRange(page, 'wind-slider', 2);
    await waitDrawn(page, 'capacity', i => i.wind === 2 && i.surface === 'on', { after: m, quietMs: 1500 });
    m = await setRange(page, 'offwind-slider', 1);
    const info = await waitDrawn(page, 'capacity', i => i.surface === 'both' && i.windOn === 2 && i.windOff === 1 && i.solarGw === 5 && i.battGwh === 8, { after: m, quietMs: 2000 });
    const sliders = await page.evaluate(() => ['wind-val', 'offwind-val'].map(id => document.getElementById(id).textContent));
    check(sliders.join('+') === '2+1', 'both wind sliders stay up at a simulated pair (onshore 2 + offshore 1)', `${sliders.join(' + ')}; drawn ${JSON.stringify({ wind: info.wind, surface: info.surface, windOn: info.windOn, windOff: info.windOff })}`);
    const drawn = await page.evaluate(() => ({ d: window.__check.digest('capacity'),
        rows: window.__drawn.views.capacity.copy.map(r => [r.location_id, r.wind_surface, r.wind_gw, r.wind_note || null]) }));
    const exp = await decodeExpected(browser, url, { solar: 5, batt: 8, on: 2, off: 1 });
    const viab = viability();
    const kind = new Map();
    const want = [];
    for (const idStr of Object.keys(exp.on)) {
        const id = Number(idStr);
        const v = viab.get(id) || { on: false, off: false };
        let k, cf;
        if (exp.mix[id] !== undefined) { k = 'both'; cf = exp.mix[id]; }
        else if (v.on) { k = 'land'; cf = exp.on[id]; }
        else if (v.off && exp.off[id] !== undefined) { k = 'sea'; cf = exp.off[id]; }
        else { k = 'none'; cf = exp.on[id]; }
        kind.set(id, k);
        want.push(`${id}|${cf.toFixed(4)}`);
    }
    want.sort();
    const diff = want.filter((r, i) => r !== drawn.d[i]);
    const counts = { both: 0, land: 0, sea: 0, none: 0 };
    kind.forEach(k => counts[k]++);
    check(want.length === drawn.d.length && !diff.length && Object.values(counts).every(c => c > 0),
        'capacity map at onshore 2 + offshore 1: combined build where a region has both sites, summary_w2 where only land, summary_wo1 where only sea, summary_w2 (hatched) where neither',
        `${drawn.d.length} rows, ${diff.length} differ${diff.length ? ` (first ${diff[0]})` : ''}; regions ${JSON.stringify(counts)}`);
    const wrong = drawn.rows.filter(([id, surf, wind, note]) => {
        const k = kind.get(id);
        if (k === 'both') return surf !== 'both' || wind !== 3 || note !== null;
        if (k === 'land') return surf !== 'on' || note !== LAND_ONLY_NOTE;
        if (k === 'sea') return surf !== 'off' || note !== SEA_ONLY_NOTE;
        return surf !== 'on' || wind !== 2 || note !== null || viab.get(id)?.on || viab.get(id)?.off;
    });
    check(!wrong.length, 'each region\'s row says what it draws: both surfaces, or the one it has with the tooltip line on the missing one; no-site regions stay hatched (onshore, no site)',
        wrong.length ? `${wrong.length} wrong; first ${JSON.stringify(wrong[0])}` : `${drawn.rows.length} rows`);
    const landId = [...kind].find(([, k]) => k === 'land')[0];
    const seaId = [...kind].find(([, k]) => k === 'sea')[0];
    const bothId = [...kind].find(([, k]) => k === 'both')[0];
    const tipLand = await hoverText(page, landId, 'capacity');
    const tipSea = await hoverText(page, seaId, 'capacity');
    const tipBoth = await hoverText(page, bothId, 'capacity');
    check(tipLand.includes(LAND_ONLY_NOTE) && tipSea.includes(SEA_ONLY_NOTE) && /2 MW onshore wind \+ 1 MW offshore wind/.test(tipBoth),
        'capacity tooltips: land-only and sea-only regions name the missing surface; a combined build names both', `${tipLand.slice(0, 120)} | ${tipSea.slice(0, 120)} | ${tipBoth.slice(0, 120)}`);
    await page.mouse.move(5, 5);
    // A pair outside the simulated set snaps: onshore to 5 with offshore 1 -> offshore 0.
    m = await setRange(page, 'wind-slider', 5);
    const i2 = await waitDrawn(page, 'capacity', i => i.surface !== 'both', { after: m, quietMs: 2000 });
    const s2 = await page.evaluate(() => ['wind-val', 'offwind-val'].map(id => document.getElementById(id).textContent));
    // Onshore 1 + offshore 3, then onshore to 3: (3, 3) is not simulated -> offshore lowered to 2.
    m = await setRange(page, 'wind-slider', 1);
    await waitDrawn(page, 'capacity', i => i.wind === 1 && i.surface === 'on', { after: m, quietMs: 1500 });
    m = await setRange(page, 'offwind-slider', 3);
    await waitDrawn(page, 'capacity', i => i.surface === 'both' && i.windOn === 1 && i.windOff === 3, { after: m, quietMs: 1500 });
    m = await setRange(page, 'wind-slider', 3);
    const i3 = await waitDrawn(page, 'capacity', i => i.windOn === 3, { after: m, quietMs: 2000 });
    const s3 = await page.evaluate(() => ['wind-val', 'offwind-val'].map(id => document.getElementById(id).textContent));
    check(s2.join('+') === '5+0' && i2.wind === 5 && i2.surface === 'on' && s3.join('+') === '3+2' && i3.windOff === 2,
        'a pair outside the simulated set lowers the other slider to the largest level that makes a pair, or 0',
        `onshore 5 with offshore 1 -> ${s2.join(' + ')} (drawn ${i2.wind} ${i2.surface}); onshore 3 with offshore 3 -> ${s3.join(' + ')}`);
    m = await setRange(page, 'offwind-slider', 0);
    await waitDrawn(page, 'capacity', i => i.surface === 'on' && i.wind === 3, { after: m, quietMs: 1500 });
    m = await setRange(page, 'wind-slider', 0);
    await waitDrawn(page, 'capacity', i => i.wind === 0, { after: m, quietMs: 1500 });
    // Cost tooltips: a large interpolated winner and a combined winner (target 99%).
    await page.click('button[data-mode="lcoe"]');
    await page.waitForFunction(() => window.__atlas && window.__atlas.matrixReady, null, { timeout: 300000 });
    const largeNow = await page.evaluate(() => Boolean(window.__atlas?.addon?.active?.includes('large')));
    check(largeNow, 'the cost search reports the large set loaded (the note on it is static in the info panel since T062)');
    await setRange(page, 'target-cf-slider', 99);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.99), { quietMs: 8000 });
    const picks = await page.evaluate(() => {
        const rows = window.__drawn.views.lcoe.copy;
        const pick = f => { const r = rows.find(f); return r ? { id: r.location_id, solar: r.solar_gw, batt: r.batt_gwh, on: r.wind_on_gw, off: r.wind_off_gw } : null; };
        return { interp: pick(r => r.addon === 'large' && r.interpolated && Math.abs(r.latitude) < 60),
            sim: pick(r => r.addon === 'large' && !r.interpolated && Math.abs(r.latitude) < 60),
            mix: pick(r => r.addon === 'wind_mix' && Math.abs(r.latitude) < 60) };
    });
    const tipI = picks.interp ? await hoverText(page, picks.interp.id, 'lcoe') : '';
    const tipM = picks.mix ? await hoverText(page, picks.mix.id, 'lcoe') : '';
    const tipS = picks.sim ? await hoverText(page, picks.sim.id, 'lcoe') : '';
    const bI = picks.interp ? Math.ceil(picks.interp.batt).toLocaleString('en-US') : '';
    check(picks.interp && tipI.includes(`Solar ${picks.interp.solar} MW + battery ${bI} MWh – beyond the slider range, interpolated`),
        'a large interpolated winner\'s tooltip: "Solar S MW + battery B MWh – beyond the slider range, interpolated"', tipI.slice(0, 220));
    check(!picks.sim || tipS.includes('beyond the slider range, simulated'), 'a large simulated winner\'s tooltip says "simulated"', picks.sim ? tipS.slice(0, 200) : 'none at 99% outside |lat| 60');
    check(picks.mix && tipM.includes(`Solar ${picks.mix.solar} + onshore ${picks.mix.on} + offshore ${picks.mix.off} MW + battery ${picks.mix.batt} MWh`),
        'a combined winner\'s tooltip: "Solar S + onshore a + offshore b MW + battery B MWh"', tipM.slice(0, 220));
    await page.mouse.move(5, 5);
    // The combined view again, now that the LCOE worker holds the add-on: its rows come
    // from the worker (no second fetch of the file) and must draw the same map.
    const fetched = [];
    const onReq = r => { if (/addon_wind_mix/.test(r.url())) fetched.push(r.url()); };
    page.on('request', onReq);
    m = await mark(page);
    await page.click('button[data-mode="capacity"]');
    await waitDrawn(page, 'capacity', () => true, { after: m, quietMs: 1500 });
    await setRange(page, 'target-cf-slider', 90);
    m = await setRange(page, 'wind-slider', 2);
    await waitDrawn(page, 'capacity', i => i.wind === 2 && i.surface === 'on', { after: m, quietMs: 1500 });
    m = await setRange(page, 'offwind-slider', 1);
    await waitDrawn(page, 'capacity', i => i.surface === 'both' && i.windOn === 2 && i.windOff === 1 && i.solarGw === 5 && i.battGwh === 8, { after: m, quietMs: 2000 });
    const again = await page.evaluate(() => window.__check.digest('capacity'));
    page.off('request', onReq);
    check(JSON.stringify(again) === JSON.stringify(drawn.d) && !fetched.length,
        'with the cost view loaded, the combined capacity map takes its rows from the LCOE worker (no second fetch) and draws the same rows',
        `${again.length} rows, ${again.filter((r, i) => r !== drawn.d[i]).length} differ; addon_wind_mix.parquet requests ${fetched.length}`);
    m = await setRange(page, 'offwind-slider', 0);
    await waitDrawn(page, 'capacity', i => i.surface === 'on', { after: m, quietMs: 1500 });
    m = await setRange(page, 'wind-slider', 0);
    await waitDrawn(page, 'capacity', i => i.wind === 0, { after: m, quietMs: 1500 });
}

const { server, base: url } = await serve();
const worker = {}, noWorker = {};
let fatal = null;
try {
    const { browser, page, errors } = await openPage({ throttle: 1 });
    await page.addInitScript(CAPTURE_MAPS);
    try {
        if (!SKIP_UI) {
            await page.goto(`${url}/index.html?debug`);
            await waitForFirstMap(page);
            await uiChecks(page, browser, url);
        }
        await page.goto(`${url}/index.html?debug`);
        await waitForFirstMap(page);
        await driveKeys(page, worker, new Set(KEYS));
        const status = await page.evaluate(() => window.__atlas?.addon ?? null);
        check(status && status.active && status.active.includes('wind_mix') && status.active.includes('large'),
            'the worker reports both add-on sets loaded (SHA-256 checked)', JSON.stringify(status));
        await uiMatchesLoaded(page);
    } finally {
        check(!errors.length, 'no page errors (worker run)', errors.length ? `${errors.length}, first: ${errors[0]}` : '');
        await browser.close();
    }
    if (!SKIP_NOWORKER) {
        const { browser: b2, page: p2, errors: e2 } = await openPage({ throttle: 1 });
        try {
            await p2.goto(`${url}/index.html?debug&worker=0`);
            await waitForFirstMap(p2);
            await driveKeys(p2, noWorker, new Set(KEYS));
        } finally {
            check(!e2.length, 'no page errors (?worker=0 run)', e2.length ? `${e2.length}, first: ${e2[0]}` : '');
            await b2.close();
        }
    }
} catch (e) {
    fatal = e.message.split('\n')[0];
} finally {
    server.close();
}
if (fatal) check(false, 'the run completed', fatal);
for (const key of KEYS) {
    if (worker[key]) compareKey(key, worker[key], '');
    else check(false, `${key}: drawn on the worker page`);
    if (SKIP_NOWORKER) continue;
    if (noWorker[key]) {
        compareKey(key, noWorker[key], '?worker=0 ');
        const same = worker[key] && JSON.stringify(worker[key].d) === JSON.stringify(noWorker[key].d);
        check(same, `${key}: ?worker=0 draws the same digest as the worker`, noWorker[key] ? hashRows(noWorker[key].d) : '');
    } else check(false, `${key}: drawn with ?worker=0`);
}
for (const [tag, n] of Object.entries(uptimeMixWinners))
    check(n > 0, `${tag}uptime keys: at least one combined onshore + offshore winner`, `${n} in all`);
const failed = report();
writeJson(path.join(HERE, 'out', `addon-${SITE_TAG}.json`), { failed, site: SITE, results,
    hashes: Object.fromEntries(Object.entries(worker).map(([k, v]) => [k, hashRows(v.d)])) });
console.log(`${failed ? 'FAIL' : 'PASS'} addon ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
