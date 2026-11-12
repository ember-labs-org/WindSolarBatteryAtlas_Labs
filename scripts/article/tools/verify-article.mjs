// Verifies "Harnessing the Winds" (T041, T047). Run from the repo root:
//
//   node scripts/article/tools/verify-article.mjs [--shots <dir>] [--table <file.md>]
//
// The page shows a committed summary (deployment/scrollytelling/data/
// article-summary.json) and runs no model. This check runs the model itself:
// 1. Static: the model's copied app defaults (model.js) still appear verbatim in
//    the main app (app.js, map.js); no em dash in the article's files.
// 2. Live model (pinned Chromium, checks/lib.mjs): runs the main app's LCOE
//    worker at its defaults with the base year pinned to 2026 (model.js), and
//    fails if any value differs from the committed analysis (scripts/article/out)
//    beyond its rounding, or if the summary rebuilt from this run differs from
//    the committed file in any value or map cell. A self-test plants a changed
//    value and a changed cell in a copy of the summary and requires both caught.
// 3. Page: loads the article and fails on any page error or failed request; on
//    any request for a summary_*.parquet slice, the LCOE worker or the parquet
//    decoder, or any Worker started; on any value the page holds that differs from
//    the live model; on any number in the HTML that does not read as its value,
//    or left unbound; and on any map cell whose colour or tooltip differs from
//    the same map state drawn from the live model's own results. It then reads
//    every text node outside the bound spans and fails on any digit not on a
//    short allowlist of structural values, and on any number word (a third,
//    two-thirds, halves...) not in a phrase checked against the values. A
//    self-test plants five text faults, and a second page load serves a summary
//    with one changed value and one changed cell: each must be caught.
// 4. --table writes every number the page shows, with its source row.
// 6. index.html, the article v3 (T087; classic.html is the previous article, checked above): the same page checks (errors, values,
//    bound numbers, every map cell, typed numbers and number words with the self-test, planted drift),
//    plus: no request to another host; every chart and map state drawn; segments enter on their own state;
//    every chart and map state is there; each scrolly step sets its map state at 1440 and 390 px.
//    --shots writes a screenshot of every take at 1440 and 390 px wide.
// Serves ATLAS_SITE (default: this worktree's deployment/).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { ROOT, TOOLS, SITE, summaryFile, serveArticle, analysisValues, runLiveModel, serializeSummary } from './summary-lib.mjs';
import { HEADLINE, WEAK_WIND, chosen as chosenHeadline, slotProblems, WEAK_ALLOW, ARTICLE } from './headline.mjs';

const { openPage, browserLine } = await import(path.join(ROOT, 'checks/lib.mjs'));

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const shotsDir = opt('--shots');
const tableFile = opt('--table');
const failures = [];
const fail = (m) => { failures.push(m); console.log(`FAIL ${m}`); };
const pass = (m) => console.log(`PASS ${m}`);
const short = (x, n = 600) => { const t = typeof x === 'string' ? x : JSON.stringify(x); return t.length > n ? `${t.slice(0, n)}…` : t; };

// ---------------------------------------------------------------------------
// 1. Static checks
// ---------------------------------------------------------------------------
const model = await import(path.join(TOOLS, 'model.js'));
const appJs = fs.readFileSync(path.join(SITE, 'js/app.js'), 'utf8');
const mapJs = fs.readFileSync(path.join(SITE, 'js/map.js'), 'utf8');
const P = model.LCOE_PARAMS;
const W = model.WIND_GLOBAL_COST_INPUTS;
const expectInApp = [
    ...['solarCapex', 'batteryCapex', 'solarOpexPct', 'batteryOpexPct', 'solarDegradationPct', 'solarLife',
        'batteryLife', 'windOpexPct', 'windOffOpexPct', 'windLife', 'windOffLife', 'windDegradationPct',
        'windOffDegradationPct', 'includeOffshore', 'wacc', 'ilr', 'includeDieselBackup'].map(k => `${k}: ${P[k]}`),
    `WIND_WACC_PREMIUM_DEFAULT = { on: ${P.windWaccPremium.toFixed(1)}, off: ${P.windOffWaccPremium} }`,
    `onshoreObserved: { 2023: ${W.onshoreObserved[2023]}, 2024: ${W.onshoreObserved[2024]}, 2025: ${W.onshoreObserved[2025]} }`,
    `onshoreRefined2025: ${W.onshoreRefined2025}`, `onshoreRefined2035: ${W.onshoreRefined2035}`,
    `offshoreGlobal2025: ${W.offshoreGlobal2025}`,
    `deaFixedAc: { 2025: ${W.deaFixedAc[2025]}, 2035: ${W.deaFixedAc[2035]}, 2050: ${W.deaFixedAc[2050]} }`,
    'const on2050 = on2035 * Math.pow(s.onshoreRefined2035 / s.onshoreRefined2025, 15 / 10);',
    'windCapex: Math.round(WIND_GLOBAL_CAPEX.on[2024])', 'windOffCapex: Math.round(WIND_GLOBAL_CAPEX.off[2024])',
    '{ year: 2035, factor: 0.61 }', '{ year: 2050, factor: 0.50 }', '{ year: 2035, factor: 0.66 }', '{ year: 2050, factor: 0.55 }',
    'const WIND_SAVING_LEGEND_MAX = 50;',
    // Local costs (T077): model.js localLookups mirrors these.
    'const COST_BASE_YEAR = 2026;', 'const LOCAL_ANCHOR_YEARS = [COST_BASE_YEAR, 2035, 2050];',
    'waccMap.set(row.location_id, waccPercent / 100);',
    'const fixedOff = pct(r.wind_off_fixed_wacc_percent ?? r.wind_off_wacc_percent);',
    "if (capexMode !== 'local' || waccMode !== 'local') return false;"
];
const missingApp = expectInApp.filter(s => !appJs.includes(s));
if (missingApp.length) fail(`app defaults copied in model.js/layers.js not found in app.js: ${missingApp.join(' | ')}`);
else pass(`${expectInApp.length} copied app defaults appear verbatim in app.js`);
const expectInMap = ['WIND_LAYER_COLORS = RAMPS.green.stops', 'WIND_LAYER_PENDING_COLOR = DATA_COLOURS.pending'];
const missingMap = expectInMap.filter(s => !mapJs.includes(s));
if (missingMap.length) fail(`wind layer colours not found in js/map.js: ${missingMap.join(' | ')}`);
else pass('wind layer colours match js/map.js');

const articleDir = path.join(SITE, 'scrollytelling');
// The article's own files (basemap.js and voronoi-canvas.js are the atlas's, unchanged).
// T087 swap: index.html is the article v3 (built by story-build.py); classic.html is the previous article, still checked
const STORY = path.join(articleDir, 'index.html');
const hasStory = fs.existsSync(STORY);
const textFiles = ['classic.html', 'css/article.css', ...['article', 'charts', 'map', 'layers', 'format', 'summary'].map(f => `js/${f}.js`),
    ...(hasStory ? ['index.html', 'css/story.css', ...['story', 'story-map', 'story-charts'].map(f => `js/${f}.js`)] : [])];
// The headline claim and the weak-wind paragraph are the option chosen in headline.mjs (T063).
const HL = chosenHeadline();
{
    const p = slotProblems(fs.readFileSync(ARTICLE, 'utf8'), HL);
    if (p.length) fail(`headline slots: ${p.join('; ')} (run scripts/article/tools/headline.mjs --apply)`);
    else pass(`the headline slots are option ${HEADLINE}, weak wind ${WEAK_WIND} (headline.mjs)`);
}
// index.html, the article v3 (T087), is built from the approved text by story-build.py: it must be exactly what the builder gives
// now (the draft's words, each paragraph read back against the draft, numbers from the committed summary), and
// never use the word "clean" (the human, T087).
if (hasStory) {
    const r = spawnSync('python3', ['-I', path.join(TOOLS, 'story-build.py'), '--check'], { encoding: 'utf8' });
    if (r.status !== 0) fail(`scrollytelling/index.html is not what story-build.py gives from the draft: ${(r.stdout + r.stderr).trim().slice(0, 1500)}`);
    else pass(`index.html (v3): ${r.stdout.trim()}`);
    // T090 (audit): the committed T090 values are what analyse_t090.py gives from the runs now
    {
        const a = spawnSync('python3', [path.join(ROOT, 'scripts/article/analysis/t090/analyse_t090.py'), '--check'], { encoding: 'utf8' });
        if (a.status === 3) console.log(`WARN ${a.stdout.trim()}`);
        else if (a.status !== 0) fail(`T090 values: ${(a.stdout + a.stderr).trim().slice(0, 800)}`);
        else pass(a.stdout.trim());
    }
    // T100: the committed T100 values are what derive_t100.py gives from the committed story cells now
    {
        const a = spawnSync('python3', [path.join(ROOT, 'scripts/article/analysis/t100/derive_t100.py'), '--check'], { encoding: 'utf8' });
        if (a.status !== 0) fail(`T100 values: ${(a.stdout + a.stderr).trim().slice(0, 800)}`);
        else pass(a.stdout.trim());
        // the uptime ladder: re-derived from the runs (WARN and skip without the runs file, as analyse_t090.py)
        const l = spawnSync('python3', [path.join(ROOT, 'scripts/article/analysis/t100/derive_ladder.py'), '--check'], { encoding: 'utf8' });
        if (l.status === 3) console.log(`WARN ${l.stdout.trim()}`);
        else if (l.status !== 0) fail(`T100 ladder: ${(l.stdout + l.stderr).trim().slice(0, 800)}`);
        else pass(l.stdout.trim());
    }
    const CLEAN_OK = 'existing clean resources on the grid';   // T100: the human's draft (9 Nov 2026); any other "clean" fails
    const clean = fs.readFileSync(STORY, 'utf8').replaceAll(CLEAN_OK, '').match(/.{0,40}\bclean.{0,20}/gi);
    if (clean) fail(`index.html (v3) uses the word "clean": ${clean.join(' | ')}`);
    else pass('index.html (v3): the word "clean" appears nowhere');
}
// The level factors note 3 states (T063) are the ones in the shipped wind data (D-134, D-135).
{
    const csv = fs.readFileSync(path.join(SITE, 'data/voronoi_wind_resource.csv'), 'utf8').trim().split('\n');
    const head = csv[0].split(',');
    const col = (name) => { const i = head.indexOf(name); return new Set(csv.slice(1).map(l => l.split(',')[i]).filter(x => x !== '').map(Number)); };
    const on = [...col('on_level_factor')].sort(), off = [...col('off_level_factor')].sort();
    const best = [...col('best_area_km2')], share = [...col('share_of_land')];
    const html = fs.readFileSync(ARTICLE, 'utf8');
    const ok = JSON.stringify(on) === '[0.879,1]' && JSON.stringify(off) === '[0.777]' && JSON.stringify(best) === '[500]' && JSON.stringify(share) === '[0.2]'
        && html.includes('×0.879 onshore in Europe') && html.includes('×0.777') && html.includes('windiest fifth') && html.includes('at least 500 km²');
    if (ok) pass('note 3 states the data\'s siting rule: windiest fifth (share 0.2), 500 km² floor, level factors 0.879 (onshore, Europe) and 0.777 (offshore)');
    else fail(`note 3 and the wind data disagree: on factors ${on}, off ${off}, floor ${best}, share ${share}`);
}
const emDash = textFiles.filter(f => fs.readFileSync(path.join(articleDir, f), 'utf8').includes('—'));
if (emDash.length) fail(`em dash in ${emDash.join(', ')}`);
else pass('no em dash in the article files');

// ---------------------------------------------------------------------------
// 2. The live model, and the committed summary against it
// ---------------------------------------------------------------------------
// Tolerance: the analysis rounds shares and cuts to 4 dp, $ to 2 dp, TWh and GW
// to whole numbers and people to 0.1 million (analyse.py r()).
function tolerance(key) {
    if (/\.(twh|gw)$/.test(key) || key === 'n.demandTwh') return 0.5;
    if (key.startsWith('t4.people.')) return 0.05;
    if (key === 'n.peopleBn') return 0.0005;
    if (key === 'nv.India.speed') return 0.005;
    if (key === 'nv.India.cf') return 0.0005;
    if (/\.(sbBoth|windBoth|saving|medWind|medWindOn|medSaving)\./.test(key)) return 0.005;
    if (key === 'n.cells' || key === 'nv.India.cells') return 0;
    return 0.00005;
}
// Values the model cannot compute come from the committed extracts.
// T087: s1-s7 and s6c from team/reports/T089-tables (the atlas's worker via scripts/article/analysis/t089, re-run on the
// release data: identical), dunkel from pipeline/scripts/pipeline/t088/results (needs the hourly profiles)
// t091: the charts-only article's common cost-of-capital values (team/reports/T091-tables/t091_values.json; re-derived by
// scripts/article/analysis/t091/analyse_wacc_lens.py --check in section 7 below)
const EMBEDDED = /^(ext|t3|t3m|glob|s[1245678]|s6c|s4bk|s8bk|ladder|t100|t102|dunkel|t091)\.|^t2\.(solar|demand)\./;   // s4bk, s8bk: T100; t102: T102 (both derive_t100.py --check)

/** Every difference between two summaries: values by key, then each column cell by cell. */
function summaryDiff(a, b) {
    const out = [];
    const walk = (x, y, where) => {
        if (Array.isArray(x) || Array.isArray(y)) {
            if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) { out.push(`${where}: length ${x?.length} vs ${y?.length}`); return; }
            for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) out.push(`${where}[${i}]: ${JSON.stringify(x[i])} vs ${JSON.stringify(y[i])}`);
        } else if (x && y && typeof x === 'object' && typeof y === 'object') {
            for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], where ? `${where}.${k}` : k);
        } else if (x !== y) out.push(`${where}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    };
    walk(a, b, '');
    return out;
}

console.log(browserLine());
const ANALYSIS = await analysisValues();
const requestLog = [];
const { server, base } = await serveArticle({ log: requestLog });
const { browser, page, errors } = await openPage();
const live = await runLiveModel(page, base, ANALYSIS, { dumps: true });
if (errors.length) fail(`errors while running the model: ${errors.join(' | ')}`);
console.log(`live model: ${live.totalMs} ms; searches ${JSON.stringify(live.timings)}`);

// The add-on builds (T058, D-127): asked for explicitly, addon.json pinned, both sets loaded.
{
    const problems = model.addonPayloadProblems({ addon: live.addon?.payload });
    const diskSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(SITE, 'data', model.ADDON_REQUEST.manifest))).digest('hex');
    if (diskSha !== model.ADDON_JSON_SHA256) problems.push(`${model.ADDON_REQUEST.manifest} SHA-256 ${diskSha} is not the one pinned in model.js (${model.ADDON_JSON_SHA256})`);
    if (live.addon?.sha256 !== model.ADDON_JSON_SHA256) problems.push(`the model ran on addon.json ${live.addon?.sha256}`);
    if (JSON.stringify(live.addon?.active) !== JSON.stringify(model.ADDON_REQUEST.sets)) problems.push(`the worker loaded add-on sets ${JSON.stringify(live.addon?.active)}`);
    if (problems.length) fail(`add-on: ${problems.join('; ')}`);
    else pass(`the model ran with the add-on (${model.ADDON_REQUEST.sets.join(', ')}), addon.json SHA-256 ${diskSha.slice(0, 12)}… as pinned`);
    // Self-test: a payload without the add-on, or with one set, must be caught.
    const st = [model.addonPayloadProblems({}), model.addonPayloadProblems({ addon: { manifest: 'addon.json', sets: ['wind_mix'] } })];
    if (st.every(p => p.length)) pass('add-on self-test: a payload without the add-on, or with one set, is caught');
    else fail('add-on self-test: a payload without the add-on was not caught');
}

const drift = [];
const computedKeys = Object.keys(live.modelValues);
for (const k of computedKeys) {
    if (!(k in ANALYSIS)) continue;
    const a = ANALYSIS[k].v, m = live.modelValues[k];
    if (Math.abs(m - a) > tolerance(k) + 1e-9) drift.push({ key: k, analysis: a, model: m });
}
const inBoth = computedKeys.filter(k => k in ANALYSIS);
if (drift.length) fail(`the live model differs from the committed analysis: ${short(drift, 2000)}`);
else pass(`${inBoth.length} values from the live model match the committed analysis within its rounding`);
const notComputed = Object.keys(ANALYSIS).filter(k => !(k in live.modelValues));
const unexpected = notComputed.filter(k => !EMBEDDED.test(k));
if (unexpected.length) fail(`analysis values the model no longer computes (they would ship unchecked): ${unexpected.join(' ')}`);
else pass(`${notComputed.length} embedded values (Ember, IRENA, the Global-cost analysis, solar potential) come from the committed extracts`);

// T086: the land-cover sensitivity's 'as today' rows are the model's own onshore potential (same cells, same cases).
{
    const pairs = [['ext.t086.cons.today.twh', 't2.cons.on.twh'], ['ext.t086.tech.today.twh', 't2.tech.on.twh']];
    const bad = pairs.filter(([e, m]) => !(Math.abs(ANALYSIS[e]?.v - live.modelValues[m]) <= 1e-4 * Math.abs(live.modelValues[m])));
    if (bad.length) fail(`T086 sensitivity base differs from the model's onshore potential: ${JSON.stringify(bad.map(([e, m]) => [e, ANALYSIS[e]?.v, m, live.modelValues[m]]))} (rerun t086/potential_lc.py)`);
    else pass('T086 land-cover sensitivity: its base equals the model\'s onshore potential, conservative and technical (within 0.01%)');
}
const committedFile = summaryFile(SITE);
const committedText = fs.existsSync(committedFile) ? fs.readFileSync(committedFile, 'utf8') : null;
const freshText = serializeSummary(live.summary);
if (committedText === null) fail(`${committedFile} is missing: run scripts/article/tools/build-summary.mjs`);
else if (committedText !== freshText) {
    let d;
    try { d = summaryDiff(JSON.parse(committedText), live.summary); } catch (e) { d = [`committed file does not parse: ${e.message}`]; }
    fail(`the committed summary differs from the live model (${d.length} differences; re-run scripts/article/tools/build-summary.mjs and re-read the prose): ${short(d.slice(0, 20))}`);
} else pass(`the committed summary is what the live model gives now (${committedText.length.toLocaleString('en-GB')} bytes, ${Object.keys(live.summary.values).length} values, ${live.summary.n} cells)`);
{
    // Self-test: a changed value and a changed map cell must both show.
    const planted = JSON.parse(freshText);
    planted.values['t1.cheaper.demand.90'] += 0.01;
    const i = planted.results.t90.lcoe.findIndex(x => x != null);
    planted.results.t90.lcoe[i] += 1;
    const d = summaryDiff(planted, live.summary);
    const caught = d.some(x => x.startsWith('values.t1.cheaper.demand.90')) && d.some(x => x.startsWith(`results.t90.lcoe[${i}]`)) && d.length === 2;
    if (caught) pass('summary self-test: a changed value and a changed map cell are both caught');
    else fail(`summary self-test: differences found ${short(d)}`);
}

// ---------------------------------------------------------------------------
// 3. The page
// ---------------------------------------------------------------------------
const FORBIDDEN = /summary_[^/]*\.parquet|lcoe-worker|parquet_wasm|apache-arrow/;
await page.addInitScript(() => {
    window.__workersStarted = 0;
    const W0 = window.Worker;
    if (W0) window.Worker = class extends W0 { constructor(...a) { window.__workersStarted++; super(...a); } };
});
async function openArticle(p, file = 'classic.html') {
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.goto(`${base}/scrollytelling/${file}`);
    await p.waitForFunction(() => window.__article?.ready, null, { timeout: 60000 });
}

const warnings = [];
page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
const failedRequests = [];
page.on('response', r => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });
const pageRequests = [];
page.on('request', r => pageRequests.push(r.url()));
errors.length = 0;
requestLog.length = 0;
const t0 = Date.now();
await openArticle(page);
const loadMs = Date.now() - t0;
await page.waitForLoadState('networkidle');
const st = await page.evaluate(() => {
    const a = window.__article;
    const spans = [...document.querySelectorAll('[data-n]')].map(el => ({ key: el.dataset.n, f: el.dataset.f, text: el.textContent.trim() }));
    return { textMismatch: a.textMismatch, errors: a.errors, values: a.values(), spans, workers: window.__workersStarted };
});
console.log(`page: ready ${loadMs} ms after navigation; ${requestLog.length} requests, ${requestLog.reduce((s, x) => s + x.bytes, 0).toLocaleString('en-GB')} bytes from the site`);
if (errors.length || st.errors.length) fail(`page errors: ${[...errors, ...st.errors].join(' | ')}`);
else pass('no page errors');
if (failedRequests.length) fail(`failed requests: ${failedRequests.join(' | ')}`);
else pass('no failed requests');
const forbidden = [...requestLog.map(x => x.path), ...pageRequests].filter(u => FORBIDDEN.test(u));
if (forbidden.length || st.workers) fail(`the page loads the live model: ${st.workers} workers started; requests ${forbidden.join(' | ')}`);
else pass(`the page starts no worker and requests no summary_*.parquet, worker or parquet decoder (${requestLog.map(x => x.path).join(', ')})`);

// The page's values against the live model (not just the file).
{
    const off = [];
    for (const [k, v] of Object.entries(live.summary.values)) if (st.values[k] !== v) off.push({ key: k, page: st.values[k], model: v });
    for (const k of Object.keys(st.values)) if (!(k in live.summary.values)) off.push({ key: k, page: st.values[k], model: null });
    for (const k of computedKeys) {
        const m = live.modelValues[k], v = st.values[k];
        if (!(Math.abs(v - m) <= 1e-9 * Math.max(1, Math.abs(m)))) off.push({ key: k, page: v, modelUnrounded: m });
    }
    if (off.length) fail(`values on the page differ from the live model: ${short(off, 2000)}`);
    else pass(`all ${Object.keys(st.values).length} values the page holds equal the live model's (${computedKeys.length} computed, the rest embedded or derived)`);
}
if (st.textMismatch.length) fail(`HTML numbers that do not read as the model values: ${JSON.stringify(st.textMismatch)}`);
else pass(`${st.spans.length} numbers in the HTML read exactly as the model values`);

// Every map cell: colour and tooltip from the summary against the live model's own results.
async function compareMaps(p) {
    const pageDumps = await p.evaluate(() => window.__article.dumpLayers());
    const bad = [];
    for (const ref of live.dumps) {
        const got = pageDumps.find(d => d.name === ref.name && d.year === ref.year);
        let fills = 0, tips = 0, example = null;
        for (let i = 0; i < ref.fill.length; i++) {
            if (got?.fill[i] !== ref.fill[i]) { fills++; example ||= { i, page: got?.fill[i], model: ref.fill[i] }; }
            if (got?.tooltip[i] !== ref.tooltip[i]) { tips++; example ||= { i, page: got?.tooltip[i], model: ref.tooltip[i] }; }
        }
        if (fills || tips) bad.push({ state: ref.name + (ref.year ? ` ${ref.year}` : ''), fills, tooltips: tips, example });
    }
    return { bad, cells: live.dumps[0].fill.length, states: live.dumps.map(d => d.name + (d.year ? ` ${d.year}` : '')) };
}
{
    const m = await compareMaps(page);
    if (m.bad.length) fail(`map cells that differ from the live model: ${short(m.bad, 1500)}`);
    else pass(`every map cell's colour and tooltip equals the live model's (${m.cells} cells × ${m.states.length} states: ${m.states.join(', ')})`);
}
console.log(`page reference: model ${live.totalMs} ms in the check vs page ready ${loadMs} ms`);
if (warnings.length) console.log(`console warnings: ${warnings.slice(0, 5).join(' | ')}`);

// ---------------------------------------------------------------------------
// Numbers typed as plain text. Digits outside [data-n] must be structural
// (targets, build sizes, years, latitudes) or a listed citation; number words
// must sit in a phrase checked against the page's values.
// ---------------------------------------------------------------------------
const TARGETS = model.TARGETS;
const YEARS = model.YEARS;
const SCAN = {
    skip: '[data-n], svg, script, style, .take-number, sup, #model-status, .chart-key, .chart-controls, .map-controls, .map-legend, .morph-head__legend, .opening__legend',   // map legends are drawn from layers.js (story.html has its map inside #article, T087)
      // chart keys and controls are drawn from the summary, like the svg   // the status line counts the checked values
    // Structural numbers, allowed only in their context: never a bare NN%.
    allowDigits: [
        // Whole fixed strings first, before the generic year contexts eat part of them
        String.raw`\b80% or 90% of the time\b`,   // T100 (D-179): the opening's uptime levels, before the uptime targets below eat its start
        String.raw`Population of the World, v4 \(2020\)`, String.raw`World Bank, 2025\)`,
        String.raw`Revolution · 2026$`, String.raw`^ ?Costs in 2026 2035 2050 ?$`,   // citation, colophon, map year buttons
        String.raw`\b(?:50|80|90|95|99)% (?:uptime|of the time)\b`,          // uptime targets
        String.raw`\bbetween 70% and 90%`,
        // T090: the thresholds of buildable wind per region (section 7, finding 6), and "1 in N" weeks (finding 3)
        String.raw`\b(?:at least|less than) (?:1|10) GW\b`, String.raw`\b1 in(?= ¤)`,
        String.raw`(?:\bunder|\b[Bb]elow|\bup to|\btier,) \$1[03]0(?:/MWh)?(?: or less)?`,   // section 6's tiers ($130: the human's, D-161)
        // Latitude bands of absolute latitude (T077, model.js ABS_BANDS)
        String.raw`\b[Nn]orth of (?:30|55)°(?!N)`, String.raw`\b[Bb]etween (?:0|15)° and (?:15|30)°`,
        String.raw`\b(?:can|to|both) reach 90%`, String.raw`\breach(?:es)? 90% (?:uptime|only with wind)`,
        String.raw`\b(?:flat )?1 GW load\b`, String.raw`\bfrom 50% to 99%`,
        String.raw`November–February,? 2024\b`, String.raw`\bits 2024 output\b`, String.raw`^Cost of onshore wind power, 20\d\d$`,   // take 3 and take 5 maps (T077 round 2)
        String.raw`\b(?:up to |even )?20 GW of solar\b`,
        String.raw`\bup to 8 GW of onshore\b`, String.raw`\b(?:up to )?36 GWh of batteries\b`,
        String.raw`\b[35] MW per km²`, String.raw`\bat 100 m\b`,
        String.raw`\b[Nn]orth of (?:45|50|55|65)°N\b`,
        String.raw`\bup to 200 GW of solar\b`, String.raw`\b4,608 GWh of batteries\b`,   // the add-on's large builds (T058)
        String.raw`\bmore than \$15/MWh`,                    // the headline's saving threshold (T058, hw.lower15)
        // Years and dates
        String.raw`\b(?:in|by|to|from|between|and|around|of|October|November) (?:19|20)\d\d\b`,
        String.raw`\((?:19|20)\d\d\)`, String.raw`\b(?:19|20)\d\d–(?:19|20)\d\d\b`,
        String.raw`\b20\d\d (?:local )?(?:costs|prices|weather|average)\b`, String.raw`\bpinned to 2026\b`,
        String.raw`\b(?:Chen et al\.|Atlas) \(?(?:19|20)\d\d\)?`, String.raw`\bweather year \(2024\)`,
        // Not computed, checked by hand or below
        // Note 3: the siting rule and level factors (D-134, D-135), checked against the wind data above
        String.raw`\blasting 30 years and batteries 20\b`, String.raw`\b25-year wind life\b`, String.raw`\buse 79% of the world's electricity and for 49% of its people\b`,   // T071 audit engine, 25-year life: 0.794 and 0.490 (D-148)
        String.raw`\bcapped at 1\.10\b`, String.raw`\bAbove about 60°N\b`,   // solar calibration limits (T066, D-148)
        String.raw`\bnever below 1\.5 times onshore\b`,   // D-146 offshore floor (build_wind_costs.py)
        String.raw`\babout 420 PWh a year\b`, String.raw`\bOutlook 2019\b`, String.raw`\bIEA \(2019\)`,   // note 2 lifetimes (model.js), note on the IEA potential (IEA 2019)
        String.raw`\bat least 500 km²`, String.raw`×0\.879 onshore in Europe`, String.raw`×0\.777 offshore`,
        String.raw`\breaches 15% before this scaling`, String.raw`Renewable Energy Statistics 2026`,
        ...WEAK_ALLOW.digits,
        String.raw`more than 20 times (?:over|its electricity demand)`,   // chart 2 title, key finding 2, take 2: checked below against t2.multLow
        // Note on wind potential (T078, D-150): the conservative case's rules and published estimates, by hand
        String.raw`\breaches 15% before calibration`, String.raw`\b3–4 MW per km²`, String.raw`\bthe atlas's 2 km grid`,
        String.raw`\breaches a 20% capacity factor`, String.raw`\b20% cut-off on the scaled capacity factor`,
        String.raw`\bDenholm et al\. 2009\b`, String.raw`\babout 560 PWh a year \(Eurek et al\. 2017, NREL\)`,
        String.raw`\b71 TW of capacity, about 20 TW of it fixed-bottom \(World Bank/ESMAP 2021\)`,
        String.raw`\b613 PWh \(Korfiati et al\. 2016\) to 12,957 PWh \(Chinese Academy of Sciences, 2026\)`,
        // T083: the two offshore definitions' published limits (World Bank/ESMAP 2021; IEA 2019, Annex B), by hand
        String.raw`\bat least 10 km from shore`, String.raw`\bfixed-bottom to\s+50 m deep and floating to 1,000 m, within 200 km of shore`,
        String.raw`\bshallow water to 60 m and deep water to 2,000 m, within 300 km of shore`, String.raw`\b8 rotor diameters apart`,
        String.raw`\bthe same 20% cut-off`, String.raw`\bon land that reaches 15%`, String.raw`\beach 2 km pixel`,
        String.raw`\babout 30% more than the atlas's figures`,   // t083/results/esmap_reconcile_phaseA.txt: 84.3/64.3 fixed, 205.9/158.4 floating (1.31, 1.30); recheck after T081
        // story.html, the article v2 (T087): thresholds and targets of the analysis, not data
        String.raw`\b(?:under|for) \$100/MWh(?: or less)?`, String.raw`\bat or under \$60, \$80 and \$100/MWh`,
        String.raw`\bnorth of 40°(?!N)`, String.raw`\bAbove 60°N\b`, String.raw`\bchasing 99% with`, String.raw`\ba 90% (?:system|build)\b`,
        String.raw`\bfrom 90% to\b`, String.raw`\bAt 90%,`, String.raw`\b90% and\b`,
        String.raw`\bunder 3% of weeks in drought`,   // checked below against dunkel.eu.mixWeeks
        String.raw`\bAt 90% – nine hours in ten`, String.raw`\b99% costs\b`, String.raw`\bin under 3% of weeks\b`, String.raw`\bBy 2050\b`, String.raw`\b90%, 95% and\b`,   // the map segments' cards and chart panels
        String.raw`Energy Economics 64`,
        // T100 (D-179): the uptime levels of the opening question and the latitude thresholds of section 5 (model.js ABS_BANDS edges)
        String.raw`\b[Aa]t (?:30|45)° or more\b`,
        String.raw`\bgetting to 100% uptime\b`,
        // T100 round 7 (the human's draft, 9 Nov 2026): uptime targets and latitude thresholds in its wording
        String.raw`\bmeet 80% of demand\b`, String.raw`\bWe use 90%, with gas\b`, String.raw`\(IRENA, 2025\)`, String.raw`\bfor 2026–2030\b`, String.raw`\bsouth of 40°S\b`, String.raw`\(see section 5\)`, String.raw`\bmeets 95% of demand\b`, String.raw`\b(?:covering 99%|cover 95%) of demand\b`, String.raw`\bcover 95%`, String.raw`\bcan supply 80% of demand\b`, String.raw`\bsupplies 95%`, String.raw`\bAt our 90% benchmark\b`, String.raw`\bcan take that to 80% and beyond, and in much of the world to 90% or 95%`, String.raw`\bmeets 90% of demand\b`, String.raw`\bmeets 95%`, String.raw`\bwith wind, 99% costs\b`,
        String.raw`\bpay for 95%`, String.raw`\bmeeting (?:90|99)% of demand\b`, String.raw`\bthe renewable build at 90%`, String.raw`\babove 55°N\b`,
        String.raw`\bMore than (?:30|45)° (?:from the equator|away)\b`, String.raw`\bIn 2050\b`, String.raw`\bfor under \$60/MWh\b`, String.raw`\bAbove 55°N\b`, String.raw`\bmore than 30° from the equator\b`, String.raw`\bthe band within 30° of the equator\b`, String.raw`\bbeyond 45°`,
        String.raw`\bwith wind, it stays around \$100/MWh\b`,   // the latitude chart's title (checked below)
        String.raw`\bheading above \$100/MWh`,   // the Hormuz paragraph: rests on the cited IEA reports (2026), not on atlas data
        String.raw`\bconstant 2026 dollars\b`, String.raw`\bthe finance box in point 1\b`, String.raw`\bSection 7 follows\b`,   // the notes (T100: real rate; the box)
        String.raw`\bGlobal Electricity Review 2026: wind and solar 17\.3% of world electricity\b`,   // the source line (the text binds ext.windSolarShare2025)
        String.raw`\bQ2 2026\b`, String.raw`\bMid-Year Update 2026\b`, String.raw`\bin 2024: export markets`, String.raw`\b[Aa]t 25% uptime\b`,   // T100: the ladder's first rung   // T100 round 2: section 4's title (power every hour, with backup)
        // T085: solar density evidence and cases, by hand (LBNL slide 13: 0.24 and 0.35 MWdc/acre = 59.3 and 86.5 MWdc/km²;
        // whole-park range from the human's decision D-156; the 40 and 60 cases are app.js SOLAR_DENSITY_CASES)
        String.raw`\babout 26–44 MW per km²`, String.raw`\bmedians of 59 MW per km² with tracking and 87 fixed-tilt`,
        String.raw`\bBolinger and Bolinger 2022\b`, String.raw`\bLevel [12]\b`,
        String.raw`\b100 MW per km² of building footprint`, String.raw`\b(?:40|60) MW per km²`, String.raw`\bbuilt in 2019\b`,
        // T084 (D-154 E): the Global Wind Atlas validation and biases, by hand from Peña-Sánchez et al. (2026), Nature
        // Communications 17, 539 (abstract: 5.6% mean CF error; results: 0.377 uncorrected vs IEA 0.306, +23.1%; GWA4 10 m
        // wind-speed errors, Supplementary 1.12) and Gruber et al. (2022), Energy 238, 121520 (GWA3, USA/Brazil/New Zealand)
        String.raw`\b[Vv]ersion 4\b`, String.raw`\bmean capacity-factor error of 5\.6%`, String.raw`\b23% above IEA statistics`,
        String.raw`\bwind speeds at 10 m\b`, String.raw`\b(?:Peña-Sánchez et al\. 2026|Gruber et al\. 2022)\b`,
        String.raw`Nature Communications 17, 539`, String.raw`\bEnergy 238, 121520`,
        // T086 (D-154 light D): the land-cover sensitivity's definitions and source (Buchhorn et al. 2020, CGLS-LC100)
        String.raw`\btree cover of 50% or more`, String.raw`\bGlobal Land Cover 2019\b`,
        String.raw`\bLand Cover 100 m, epoch 2019, Zenodo, doi:10\.5281/zenodo\.3939050`,
        // Names and citations
        String.raw`\bERA5\b`, String.raw`Scientific Data 12, 1912`, String.raw`Scientific Data 9, 202`,
        String.raw`\b176 countries`, String.raw`Global Wind Atlas 4\b`, String.raw`\bGPW v4\b`, 
        String.raw`\b1 km × 1 km\b`, String.raw`\bJoule 4\b`
    ],
    numberWords: String.raw`\b(?:(?:one|two|three|four)-(?:thirds?|quarters?|fifths?|sixths?|tenths?)|half|halves|halve|third|thirds|quarter|quarters|fifth|fifths|sixth|sixths|tenth|tenths|twice|double|doubles|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|hundred|thousand|dozen)\b`,
    // Phrases whose words carry a number, each in its sentence context and tied
    // to its own value; any other use of a number word fails as unchecked.
    checked: [
        // The headline option's phrases (headline.mjs, T063), then the rest of the article's.
        ...HL.checked,
        { re: String.raw`about three-quarters more than the cost with`, ratio: ['t4.sbBoth.n50p.90', 't4.windBoth.n50p.90'], lo: 1.65, hi: 1.85 },
        { re: String.raw`MWh – less than three-fifths of that`, ratio: ['t4.medWind.n50p.90', 't4.sbBoth.n50p.90'], lo: 0.5, hi: 0.6 },
        { re: String.raw`falls to about a sixth between 70% and 90%`, keys: [70, 75, 80, 85, 90].map(t => `t1.cut.demand.${t}`), lo: 0.14, hi: 0.19 },
        { re: String.raw`cost of high uptime by more than a quarter north of 45°N`, keys: ['t4.cut.n45p.80'], lo: 0.25, hi: 0.33 },
        { re: String.raw`gets about half as expensive by 2050 at every latitude`, keys: ['lb.halfMin', 'lb.halfMax'], lo: 0.4, hi: 0.6 },
        { re: String.raw`the cost of 99% uptime halves by 2050`, keys: ['lb.halfMin', 'lb.halfMax'], lo: 0.4, hi: 0.6 },
        { re: String.raw`North of 30°, adding wind keeps high uptime cheaper all the way to 2050`, keys: ['lb.cutMinN30'], lo: 0.02, hi: 1 },
        { re: String.raw`North of 30°, solar, batteries and wind together cost less`, keys: ['lb.cutMinN30'], lo: 0.02, hi: 1 },
        { re: String.raw`the median gain shrinks to nothing by 2050`, keys: ['lb.cut.a15_30.90.2050'], lo: 0, hi: 0.005 },
        { re: String.raw`Between 0° and 15°, wind changes almost nothing`, keys: ['lb.cut.a0_15.90.2026'], lo: 0, hi: 0.02 },
        { re: String.raw`lowers onshore wind potential by about a quarter`, keys: ['t2.lc.fallCons', 't2.lc.fallTech'], lo: 0.22, hi: 0.3 },   // T086
        { re: String.raw`about half the IEA's technical potential`, sums: [['t2.offFixed.twh', 't2.offFloat.twh']], lo: 189000, hi: 231000 },   // IEA (2019): about 420,000 TWh a year; 45% to 55%
        { re: String.raw`90% uptime with wind halves by 2050`, ratio: ['t5.windBoth.demand.2050', 't5.windBoth.demand.2026'], lo: 0.45, hi: 0.55 },
        { re: String.raw`electricity more than 20 times over`, keys: ['t2.multLow'], lo: 20, hi: 1e9 },
        { re: String.raw`potential is more than 20 times its electricity demand`, keys: ['t2.multLow'], lo: 20, hi: 1e9 },
        { re: String.raw`within reach for everyone there`, keys: ['t4.withWind.n50p.90'], lo: 0.9995, hi: 1 },
        { re: String.raw`almost everyone there`, keys: ['t4.withWind.n50p.90'], lo: 0.99, hi: 1 },
        { re: String.raw`for most demand to 2050`, sums: YEARS.map(y => [`t5.cheaper.demand.${y}`, `t5.only.demand.${y}`]), lo: 0.5, hi: 1 },
        { re: String.raw`for most of the world's electricity demand`, sums: [['t1.cheaper.demand.90', 't1.only.demand.90']], lo: 0.5, hi: 1 },
        // story.html, the article v2 (T087)
        { re: String.raw`cheaper for three-quarters of the world's electricity demand`, keys: ['hw.lower.demand.90'], lo: 0.70, hi: 0.80 },
        { re: String.raw`for regions that use three-quarters of the world's electricity`, keys: ['hw.lower.demand.90'], lo: 0.70, hi: 0.80 },   // T100, section 1
        { re: String.raw`cheaper still for the vast majority of the world`, keys: ['hw.lower.demand.90'], lo: 0.70, hi: 1 },   // the standfirst, the human's wording: by demand 75% (by people 41.5%)
        // T100 round 7 (the human's draft, 9 Nov 2026)
        { re: String.raw`by nearly a fifth, from`, ratio: ['t1.windBoth.demand.90', 't1.sbBoth.demand.90'], lo: 0.8, hi: 0.835 },
        // the section 1 title (the human, 9 Nov): the same ratio as the paragraph below it
        { re: String.raw`firm renewables by nearly a fifth$`, ratio: ['t1.windBoth.demand.90', 't1.sbBoth.demand.90'], lo: 0.8, hi: 0.835 },
        { re: String.raw`With wind, three-quarters of the world's electricity demand can have 90% uptime`, keys: ['s1.under100.sbw.demand.90'], lo: 0.72, hi: 0.79 },
        { re: String.raw`Without it, only half`, keys: ['s1.under100.sb.demand.90'], lo: 0.45, hi: 0.53 },
        { re: String.raw`by two-fifths, from`, ratio: ['s2.n45p.sbw_demand.90', 's2.n45p.sb_demand.90'], lo: 0.57, hi: 0.63 },
        { re: String.raw`Near the equator, solar and batteries reach 90% uptime for under \$60/MWh`, keys: ['s2.a0_15.sb_demand.90'], lo: 0, hi: 59.999 },
        { re: String.raw`the cost stays under \$100/MWh at every latitude`, keys: ['a0_15', 'a15_30', 'a30_45', 'a45_55', 'a55p'].map(b => `s2.${b}.sbw_demand.90`), lo: 0, hi: 99.999 },
        { re: String.raw`at the same cost of capital, firm power in Africa is cheaper than in Europe`, ratio: ['t091.cost.africa.common.people.90', 't091.cost.europe.common.people.90'], lo: 0.3, hi: 0.95 },   // T103: Rini's finance comment
        { re: String.raw`for three in four people more than 30° from the equator`, keys: ['s5.lower.people.a30p.90'], lo: 0.72, hi: 0.78 },
        { re: String.raw`for almost everyone beyond 45°`, keys: ['s5.lower.people.a45p.90'], lo: 0.95, hi: 1 },
        { re: String.raw`with wind, it stays around \$100/MWh`, keys: ['s2.a45_55.sbw_demand.90', 's2.a55p.sbw_demand.90'], lo: 90, hi: 115 },   // the latitude chart's title: the high-latitude bands with wind ($99; 5° bins reach ~$109)
        { re: String.raw`lowers the cost for three in four people`, keys: ['s5.lower.people.a30p.90'], lo: 0.72, hi: 0.78 },
        { re: String.raw`it lowers it for almost everyone`, keys: ['s5.lower.people.a45p.90'], lo: 0.95, hi: 1 },
        { re: String.raw`more than three-quarters of the world's people live where firm solar and wind power costs under \$100/MWh`, keys: ['s5.c100under100.people'], lo: 0.7501, hi: 0.8 },
        { re: String.raw`roughly four times a year`, keys: ['dunkel.world.solarPerYear'], lo: 3.5, hi: 4.5 },
        { re: String.raw`(?:Wind had one )?roughly eight times a year`, keys: ['dunkel.world.windPerYear'], lo: 7.5, hi: 8.5 },   // the text and (T101) the scrolly's drought card
        // the close (the human): today's costs take wind and solar to 80% and beyond, in much of the world to 90% or 95% – under
        // $100/MWh with wind for 93%, 76% and 54% of demand (s1.under100.sbw.demand.*); 'much of the world' = at least half
        { re: String.raw`can take that to 80% and beyond, and in much of the world to 90% or 95%`, keys: ['s1.under100.sbw.demand.80', 's1.under100.sbw.demand.90', 's1.under100.sbw.demand.95'], lo: 0.5, hi: 1 },
        { re: String.raw`the same money supplies 95%`, ratio: ['ladder.bk.sbw.95', 'ladder.bk.sb.80'], lo: 0.97, hi: 1.03 },   // section 4 (the backup curve)
        { re: String.raw`^~\$20/MWh`, keys: ['t100.hl.saving90'], lo: 17.5, hi: 22.5 },   // highlight 1: the human's "~" (about)
        { re: String.raw`regions using two-thirds of the world's electricity`, keys: ['s8bk.lower.demand.2050'], lo: 0.62, hi: 0.70 },
        { re: String.raw`with wind, covering 99% of demand costs about what solar and batteries pay to cover 95%`, ratio: ['ladder.sbw.99', 'ladder.sb.95'], lo: 0.95, hi: 1.05 },
        { re: String.raw`about once every four years`, keys: ['dunkel.world.bothYears'], lo: 3.75, hi: 4.5 },   // T102: 'four years', as highlight 3's ~4
        { re: String.raw`^Once every ~\d+ years`, keys: ['dunkel.world.bothYears'], lo: 3.75, hi: 4.5 },
        { re: String.raw`North America is starker still: \d+% of its solar lulls fall in those months, against one in twenty`, keys: ['dunkel.na.windInWinter'], lo: 0.04, hi: 0.06 },
        { re: String.raw`wind cuts it by a third, from`, ratio: ['t102.south40.sbw.demand.90', 't102.south40.sb.demand.90'], lo: 0.63, hi: 0.70 },
        { re: String.raw`only one in eight of its wind lulls does`, keys: ['dunkel.eu.windInWinter'], lo: 0.11, hi: 0.14 },
        { re: String.raw`against six with either alone`, keys: ['dunkel.de.gap7.solar', 'dunkel.de.gap7.wind'], lo: 5.5, hi: 6.5 },
        { re: String.raw`five-sixths of the pipeline`, keys: ['s6.local.sbw.bk90.under100.share'], lo: 0.8, hi: 0.87 },
        { re: String.raw`against under two-thirds`, ratio: ['s6.local.sb.bk90.under100.gw', 's6.planned.gw'], lo: 0.5, hi: 0.6666 },
        { re: String.raw`for regions using three-quarters of the world's electricity`, keys: ['s8.lower.demand.2050'], lo: 0.70, hi: 0.80 },
        { re: String.raw`the cost of meeting 99% of demand halves by 2050`, keys: ['lb.halfMin', 'lb.halfMax'], lo: 0.4, hi: 0.6 },
        { re: String.raw`for under \$100/MWh for four in five people`, keys: ['ext.hts.people80under100'], lo: 0.75, hi: 0.85 },
        { re: String.raw`solar in Germany fell below half its average in one week in five`, keys: ['dunkel.de.solarWeeks'], lo: 0.18, hi: 0.23 },
        { re: String.raw`and wind in one week in six`, keys: ['dunkel.de.windWeeks'], lo: 0.15, hi: 0.185 },
        { re: String.raw`Both at once happened in about one week in a hundred`, keys: ['dunkel.de.bothWeeks'], lo: 0.008, hi: 0.0125 },
        { re: String.raw`a third as often as if they were independent`, keys: ['dunkel.de.ratio'], lo: 0.28, hi: 0.37 },
        { re: String.raw`Across Europe the ratio is about a third`, keys: ['dunkel.eu.ratio'], lo: 0.28, hi: 0.37 },
        { re: String.raw`coincide about a third as often as chance would predict`, keys: ['dunkel.eu.ratio'], lo: 0.28, hi: 0.37 },
        { re: String.raw`across North America less than half`, keys: ['dunkel.na.ratio'], lo: 0, hi: 0.4999 },
        { re: String.raw`Almost all of Europe's solar lulls`, keys: ['dunkel.eu.solarInWinter'], lo: 0.9, hi: 1 },
        { re: String.raw`only one in eight wind droughts does`, keys: ['dunkel.eu.windInWinter'], lo: 0.11, hi: 0.14 },
        { re: String.raw`A mix of the two spends under 3% of weeks in drought in Europe`, keys: ['dunkel.eu.mixWeeks'], lo: 0, hi: 0.02999 },
        { re: String.raw`a gap of about five days of average demand`, keys: ['dunkel.de.gap7.mix50'], lo: 4.5, hi: 5.5 },
        { re: String.raw`against six for either source alone`, keys: ['dunkel.de.gap7.solar', 'dunkel.de.gap7.wind'], lo: 5.5, hi: 6.5 },
        // T095: the backup also serves what the renewables lose to ageing, so its share rose from 9% to 13-14% (demand):
        // "less than a tenth" became "less than a seventh", "nine-tenths of the load" "nearly nine-tenths"
        { re: String.raw`less than a seventh of the energy`, keys: ['s4.share.sbw.demand', 's4.share.sb.demand'], lo: 0, hi: 1 / 7 },
        { re: String.raw`carry nearly nine-tenths of the load either way`, keys: ['s4.share.sbw.demand', 's4.share.sb.demand'], lo: 0.1, hi: 0.15 },
        { re: String.raw`nine-tenths of the pipeline`, keys: ['s6.local.sbw.under100.90.share'], lo: 0.875, hi: 0.925 },   // T091: four-fifths before the article moved to one 7% cost of capital
        { re: String.raw`for 90% uptime for most of the world's demand`, sums: YEARS.map(y => [`t5.cheaper.demand.${y}`, `t5.only.demand.${y}`]), lo: 0.5, hi: 1 },
        { re: String.raw`wind stays in the cheapest build for most of the world's demand`, sums: YEARS.map(y => [`t5.cheaper.demand.${y}`, `t5.only.demand.${y}`]), lo: 0.5, hi: 1 },
        // the map segments' cards (team/reports/T087-cards.md)
        { re: String.raw`In Germany, solar did in one week in five`, keys: ['dunkel.de.solarWeeks'], lo: 0.18, hi: 0.23 },
        { re: String.raw`wind in one in six`, keys: ['dunkel.de.windWeeks'], lo: 0.15, hi: 0.185 },
        { re: String.raw`– about a third as often\.`, keys: ['dunkel.de.ratio'], lo: 0.28, hi: 0.37 },
        { re: String.raw`An equal mix of the two spends under 3% of weeks in drought in Europe`, keys: ['dunkel.eu.mixWeeks'], lo: 0, hi: 0.02999 },
        { re: String.raw`four-fifths of all planned coal and gas`, keys: ['s6.local.sbw.under100.90.share'], lo: 0.75, hi: 0.85 },
        { re: String.raw`cost of power 99% of the time halves by 2050`, keys: ['lb.halfMin', 'lb.halfMax'], lo: 0.4, hi: 0.6 },
        // design v3 cards and key findings
        { re: String.raw`lowers the cost for places that use three-quarters of the world's electricity`, keys: ['hw.lower.demand.90'], lo: 0.70, hi: 0.80 },
        { re: String.raw`In Germany, one week in five`, keys: ['dunkel.de.solarWeeks'], lo: 0.18, hi: 0.23 },
        { re: String.raw`In Germany, one week in six`, keys: ['dunkel.de.windWeeks'], lo: 0.15, hi: 0.185 },
        { re: String.raw`in Germany about one week in a hundred`, keys: ['dunkel.de.bothWeeks'], lo: 0.008, hi: 0.0125 },
        { re: String.raw`a third of what chance would predict`, keys: ['dunkel.de.ratio'], lo: 0.28, hi: 0.37 },
        { re: String.raw`an equal mix of sun and wind is in drought in under 3% of weeks`, keys: ['dunkel.eu.mixWeeks'], lo: 0, hi: 0.02999 },
        { re: String.raw`A gas plant that runs about an eighth of the time`, keys: ['s4.share.sbw.demand'], lo: 0.11, hi: 0.14 },   // T095: "a tenth" before
        { re: String.raw`^Half$`, keys: ['lb.halfMin', 'lb.halfMax'], lo: 0.4, hi: 0.6 },
        { re: String.raw`By 2050 the cost halves, at every latitude`, keys: ['lb.halfMin', 'lb.halfMax'], lo: 0.4, hi: 0.6 },
        { re: String.raw`under half as often as chance`, keys: ['dunkel.world.ratio'], lo: 0, hi: 0.4999 },
        { re: String.raw`stays in the cheapest mix for most of the world's demand`, sums: YEARS.map(y => [`t5.cheaper.demand.${y}`, `t5.only.demand.${y}`]), lo: 0.5, hi: 1 },
        // T091 (section 5 at one 7% cost of capital): "about the same as across the land itself" (people against land), and
        // demand-weighted "higher"
        { re: String.raw`about the same as across the land itself`, ratio: ['s5.med.sbw.people.90', 's5.med.sbw.area.90'], lo: 0.95, hi: 1.05 }
    ],
    // Number words that are not data: arithmetic or plain English.
    allowWords: [
        String.raw`a third in those months`,                  // an even spread over four of twelve months
        String.raw`the four months from November to February`,
        String.raw`Two cautions`, String.raw`The conservative case changes three things`, String.raw`Offshore follows two published definitions`, String.raw`one weather year`, String.raw`one simulated wind site`,   // T083: 'two' = ESMAP and IEA, named in the sentence
        String.raw`rather than a good one`, String.raw`The onshore site is a good one`,
        String.raw`(?:every|each) doubling`,                  // the learning-rate definition
        String.raw`opposite halves of the year`, String.raw`for ten energy technologies`,
        String.raw`windiest fifth of (?:its|the region's) eligible land`, String.raw`nine European countries`, String.raw`those four months`, String.raw`more than a\s+third`, String.raw`an even spread is a third`,   // the even-spread threshold, a definition (T077)
        String.raw`windiest fifth of a region's eligible sea`, String.raw`\bten(?: weather years|-year record| years)\b`,   // the ten weather years, 2015–2024 (D-142)
        String.raw`a median of about a fifth above the region's median land`,   // note 3: per region, on_final_cf / (on_cf_p50 x level factor), median 1.24 (T063 audit S1; by hand)   // the siting rule (note 3, map hint)
        ...WEAK_ALLOW.words,
        // story.html, the article v2 (T087): plain English and definitions
        String.raw`Two harvests`, String.raw`the first one`, String.raw`not one\b`, String.raw`by ten times or more`, String.raw`the ten countries with the most`,
        String.raw`below half its (?:long-run )?average`, String.raw`the dark half of the year`, String.raw`those nine-tenths`, String.raw`\bseven (?:consecutive )?days\b`,
        String.raw`\bseven-day\b`, String.raw`the two shares`,
        String.raw`nine hours in ten`, String.raw`If the two failed independently`, String.raw`ten times over`,
        String.raw`\bone (?:week )?in (?=\d)`, String.raw`"one week in N"`,   // T090: drought weeks as one week in N (the N bound)   // the cards' definition of 90% uptime
        // T091: "one cost of capital" means a single rate for every region (its value is bound where it is given)
        String.raw`\bone (?:¤ )?cost of capital\b`,
        // T100: the closing section's title (the sun harvest and the wind harvest)
        String.raw`\btwo harvests\b`, String.raw`\b[Tt]he two (?:grow|complement)\b`,
        String.raw`^One of the most widely reported energy stories today\b`,   // T100: the standfirst, the human's words
        // T100 round 7: plain English in the human's draft (9 Nov 2026), not data
        String.raw`\ba farm with one crop is exposed to one kind of bad season\b`, String.raw`\bSeven findings stand out\b`,
        String.raw`\ba bad season for one is rarely\b`, String.raw`\bTwo objections remain\b`, String.raw`\bFor two centuries\b`,
String.raw`\bFor two centuries we have gathered energy\b`, String.raw`\bthe rare weeks when all three come up short\b`, String.raw`\bEven two harvests\b`, String.raw`\ba system with two harvests\b`,
        // structural: 90% leaves a tenth of the load to backup, 95% a twentieth
        String.raw`\bleaving a fifth to gas or diesel generators\b`, String.raw`\bleaving just a twentieth\b`, String.raw`\bSo wind brings two benefits\b`, String.raw`\bleaving the backup roughly half as much to cover\b`,   // structural: 90% leaves a tenth unmet, 95% a twentieth
        String.raw`\bthe two rarely fail together\b`, String.raw`\bthe one that matters\b`, String.raw`\ba distant one\b`, String.raw`\bnot the one built\b`,
        String.raw`\bthe one whose sources\b`, String.raw`\bin any one place\b`,
    ]
};

function scanText(cfg) {
    const values = window.__article.values();   // the summary's values, as the page shows them
    const faults = [];
    const norm = t => t.replace(/\s+/g, ' ');
    const roots = [document.querySelector('#article'), document.querySelector('#visual .map-caption')].filter(Boolean);   // charts.html has no map (T091)
    // Digits outside the bound spans, read block by block so each number keeps
    // its sentence context; a bound span reads as ' ¤ '.
    const allow = cfg.allowDigits.map(r => new RegExp(r, 'g'));
    const BLOCK = 'p, li, h1, h2, h3, .kicker, .map-caption-title, .map-caption-sub, .map-controls, .legend-title';
    const blockText = (el) => {
        let out = '';
        const walk = (node) => {
            for (const c of node.childNodes) {
                if (c.nodeType === 3) out += c.textContent;
                else if (c.nodeType === 1) { if (c.matches(cfg.skip)) out += ' ¤ '; else walk(c); }
            }
        };
        walk(el);
        return norm(out);
    };
    const digitFaults = (text, where) => {
        let t = text;
        for (const re of allow) t = t.replace(re, ' ');
        const m = t.match(/[^\s]*\d[^\s]*/g);
        if (m) faults.push({ kind: 'typed number', found: m.join(' '), in: where.slice(0, 160) });
    };
    for (const root of roots) {
        const leaves = [...root.querySelectorAll(BLOCK)].filter(b => !b.querySelector(BLOCK) && !b.closest(cfg.skip));
        leaves.forEach(b => { const t = blockText(b); digitFaults(t, t); });
        // Any text outside those blocks, node by node.
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.parentElement.closest(cfg.skip) || n.parentElement.closest(BLOCK)) continue;
            const t = norm(n.textContent);
            if (t.trim()) digitFaults(t, t);
        }
    }
    const meta = document.querySelector('meta[name="description"]').content + ' ' + document.title;
    {
        digitFaults(norm(meta), `title or meta description: ${norm(meta)}`);
    }
    // Number words, block by block (a phrase may span bound spans).
    const blocks = [...document.querySelectorAll('#article p, #article li, #article h1, #article h2, #article h3')]
        .filter(b => !b.querySelector('p, li')).map(b => norm(b.textContent));
    blocks.push(norm(meta));
    const range = (c) => {
        let vals;
        if (c.ratio) vals = [values[c.ratio[0]] / values[c.ratio[1]]];
        else if (c.sums) vals = c.sums.map(ks => ks.reduce((a, k) => a + values[k], 0));
        else vals = c.keys.map(k => values[k]);
        return { ok: vals.every(v => Number.isFinite(v) && v >= c.lo && v <= c.hi), vals };
    };
    const used = new Set();
    for (const text of blocks) {
        const covered = [];
        for (const c of cfg.checked) {
            for (const m of text.matchAll(new RegExp(c.re, 'g'))) {
                covered.push([m.index, m.index + m[0].length]);
                used.add(c.re);
                const r = range(c);
                if (!r.ok) faults.push({ kind: 'number word does not match the values', found: m[0], values: r.vals, expected: [c.lo, c.hi] });
            }
        }
        for (const a of cfg.allowWords) for (const m of text.matchAll(new RegExp(a, 'g'))) covered.push([m.index, m.index + m[0].length]);
        for (const m of text.matchAll(new RegExp(cfg.numberWords, 'gi'))) {
            if (!covered.some(([s, e]) => m.index >= s && m.index < e)) faults.push({ kind: 'unchecked number word', found: m[0], in: text.slice(Math.max(0, m.index - 50), m.index + 50) });
        }
    }
    return { faults, checkedPhrases: [...used].length };
}

const scan0 = await page.evaluate(scanText, SCAN);
if (scan0.faults.length) fail(`numbers outside the bound spans: ${JSON.stringify(scan0.faults)}`);
else pass(`no typed numbers outside the bound spans; ${scan0.checkedPhrases} number-word phrases checked against the values`);

// Self-test: plant one fault of each kind and require the scan to catch it.
const SELF_TEST = {
    index: { span: 't2.coverTech.n45p', ctx: '45°N', value: 't4.windBoth.n50p.90', bad: 150, phrase: 'less than three-fifths of the cost' },
    story: { span: 's2.a55p.sb_demand.90', ctx: '55°N', value: 's6.local.sbw.bk90.under100.share', bad: 0.5, phrase: 'five-sixths of the pipeline' }   // T100 round 7
};
async function scanSelfTest(label = '', T = SELF_TEST.index) {
    const planted = await page.evaluate(([cfg, T]) => {
        const p1 = document.querySelector('#take-1 p');
        const p2 = document.querySelector('#take-2 p');
        const a = document.createTextNode(' (70%)');
        const b = document.createTextNode(' A fifth of people agree.');
        p1.appendChild(a);
        p2.appendChild(b);
        // g2: a checked word in the wrong context ("two-thirds of people"; the value is 46%)
        p2.appendChild(document.createTextNode(' Wind is cheaper for two-thirds of people.'));
        // g3: a bound span replaced by the same kind of number typed as text
        const span = document.querySelector(`#take-2 [data-n="${T.span}"]`);
        window.__plantSpan = span;
        if (span) span.replaceWith(document.createTextNode('80%'));
        const keep = window.__article.v[T.value];
        window.__article.v[T.value] = T.bad;     // the checked phrase no longer holds
        return { keep };
    }, [SCAN, T]);
    const scan1 = await page.evaluate(scanText, SCAN);
    await page.evaluate(([keep, T]) => {
        document.querySelector('#take-1 p').lastChild.remove();
        document.querySelector('#take-2 p').lastChild.remove();
        document.querySelector('#take-2 p').lastChild.remove();
        if (window.__plantSpan) {
            const p = [...document.querySelectorAll('#take-2 p')].find(x => [...x.childNodes].some(n => n.nodeType === 3 && n.textContent === '80%'));
            const t = [...p.childNodes].find(n => n.nodeType === 3 && n.textContent === '80%');
            t.replaceWith(window.__plantSpan);
        }
        window.__article.v[T.value] = keep;
    }, [planted.keep, T]);
    const caught = {
        typed: scan1.faults.some(f => f.kind === 'typed number' && f.found.includes('70%')),
        word: scan1.faults.some(f => f.kind === 'unchecked number word' && /fifth/i.test(f.found)),
        value: scan1.faults.some(f => f.kind === 'number word does not match the values' && f.found.includes(T.phrase)),
        g2WrongContext: scan1.faults.some(f => f.kind === 'unchecked number word' && f.found === 'two-thirds' && /people/.test(f.in)),
        g3TypedForSpan: scan1.faults.some(f => f.kind === 'typed number' && /80%/.test(f.found) && f.in.includes(T.ctx))
    };
    const scan2 = await page.evaluate(scanText, SCAN);
    if (Object.values(caught).every(Boolean) && !scan2.faults.length) pass(`${label}self-test: all ${Object.keys(caught).length} planted faults caught (typed "(70%)", "A fifth", a wrong value behind "${T.phrase}", "two-thirds of people", a bound number replaced by typed "80%"); none left after removal`);
    else fail(`${label}self-test: caught ${JSON.stringify(caught)}, faults after removal ${scan2.faults.length}`);
}
await scanSelfTest();

// Each displayed number: where it comes from.
const derivedSrc = {
    't2.total.pwh': 't2.on5.twh + t2.offFixed.twh',
    't2.mult': '(t2.on5.twh + t2.offFixed.twh) / ext.demand2025',
    't2.multLow': '(t2.on3p50.twh + t2.offFixedP50.twh) / ext.demand2025',
    't2.cons.total.pwh': 't2.cons.on.twh + t2.cons.offFixed.twh (T078 conservative case)',
    't2.multCons': '(t2.cons.on.twh + t2.cons.offFixed.twh) / ext.demand2025 (T078 conservative case; offshore World Bank/ESMAP, T083)',
    't2.tech.total.pwh': 't2.tech.on.twh + t2.iea.offFixed.twh (T083 technical case)',
    't2.multTech': '(t2.tech.on.twh + t2.iea.offFixed.twh) / ext.demand2025 (T083 technical case)',
    't2.lc.fallCons': '1 - ext.t086.cons.both.twh / ext.t086.cons.today.twh (T086)', 't2.lc.fallTech': '1 - ext.t086.tech.both.twh / ext.t086.tech.today.twh (T086)',
    't2.lc.multCons': 'ext.t086.cons.both.twh / ext.demand2025 (T086)', 't2.lc.multTech': 'ext.t086.tech.both.twh / ext.demand2025 (T086)',
    't2.iea.total.pwh': 't2.iea.offFixed.twh + t2.iea.offFloat.twh (T083, IEA 2019 definition)',
    'ext.lcoeFall.onshore_wind': '1 - ext.lcoe.onshore_wind.2025 / ext.lcoe.onshore_wind.2010',
    'ext.lcoeFall.offshore_wind': '1 - ext.lcoe.offshore_wind.2025 / ext.lcoe.offshore_wind.2010',
    't5.cutMin': 'min of t5.cut.demand.<year>', 't5.cutMax': 'max of t5.cut.demand.<year>',
    't5.cheaperMin': 'min of t5.cheaper.demand.<year>', 't5.cheaperMax': 'max of t5.cheaper.demand.<year>'
};
const rows = [];
const seen = new Set();
for (const s of st.spans) {
    const id = `${s.key}|${s.text}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let src, how;
    if (ANALYSIS[s.key]) { src = ANALYSIS[s.key].src; how = s.key in live.modelValues ? 'live model = summary = analysis' : 'embedded'; }
    else if (derivedSrc[s.key]) { src = derivedSrc[s.key]; how = 'derived in the summary'; }
    else if (/^(cap|p)\./.test(s.key)) { src = 'app.js defaults (model.js), pinned to 2026'; how = 'model constant'; }
    else if (s.key in live.modelValues) { src = 'model.js, Local costs (no committed analysis row; checked page = live model)'; how = 'live model = summary'; }
    else if (/^(t3m|lb|lcap)\./.test(s.key)) { src = 'derived in the summary (summary-encode.js derivedValues, T077)'; how = 'derived in the summary'; }
    else { src = '?'; how = 'UNBOUND'; fail(`number ${s.key} has no source`); }
    rows.push({ ...s, src, how, value: ANALYSIS[s.key]?.v ?? null, summary: st.values[s.key] ?? null });
}
if (tableFile) {
    const md = ['| Key | Shown | Analysis value | Summary value | How | Source row |', '|---|---|---|---|---|---|',
        ...rows.map(r => `| \`${r.key}\` | ${r.text} | ${r.value ?? ''} | ${r.summary != null ? Number(r.summary.toPrecision(8)) : ''} | ${r.how} | ${r.src} |`)].join('\n');
    fs.writeFileSync(tableFile, md + '\n');
    console.log(`wrote ${rows.length} rows to ${tableFile}`);
}

// ---------------------------------------------------------------------------
// 4. Screenshots of each take, desktop and phone
// ---------------------------------------------------------------------------
async function shoot(width, height, tag) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(600);
    const targets = [['hero', '.hero', 'windcf'], ['highlights', '.highlights', 'windcf'], ['intro', '#intro', 'windcf'], ['take-1', '#chart-1', 'saving'],
        ['take-2', '#chart-2', 'potential'], ['take-3', '#chart-3', 'winter'], ['take-4', '#chart-4', 'saving-europe'],
        ['take-5', '#chart-5', 'windcost'], ['take-5b', '#chart-5b', 'windcost'], ['conclusion', '#conclusion', 'windcost']];
    for (const [name, sel, mapState] of targets) {
        await page.evaluate((s) => {
            const el = document.querySelector(s);
            const phone = window.matchMedia('(max-width: 900px)').matches;
            const visualH = phone ? document.getElementById('visual').getBoundingClientRect().height : 0;
            const r = el.getBoundingClientRect();
            const y = window.scrollY + r.top - (s === '.hero' ? 0 : (phone ? visualH + 12 : Math.max(24, (window.innerHeight - r.height) / 2)));
            // (sections taller than the viewport are shot from their top)
            window.scrollTo(0, Math.max(0, y));
        }, sel);
        await page.waitForTimeout(300);
        const got = await page.evaluate(() => window.__article.mapState);
        if (got !== mapState) fail(`${tag} ${name}: map state ${got}, expected ${mapState}`);
        await page.waitForTimeout(1500);   // fly-to and colour cross-fade
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${tag} ${name}: page scrolls sideways by ${overflow} px`);
        if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${tag}-${name}.png`) });
    }
    pass(`${tag}: every take sets its map state${shotsDir ? `; screenshots in ${shotsDir}` : ''}`);
}
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
await shoot(1440, 900, 'desktop-1440');
await shoot(390, 844, 'phone-390');
if (errors.length) fail(`page errors after scrolling: ${errors.join(' | ')}`);

// ---------------------------------------------------------------------------
// 5. Planted drift on the page: serve a summary with one changed value (the 65%
//    behind "two-thirds") and one changed map cell; the check must catch both.
// ---------------------------------------------------------------------------
{
    const planted = JSON.parse(freshText);
    planted.values['t1.cheaper.demand.90'] = 0.6;
    const r = planted.results.t90;
    const i = r.flags.findIndex((f, k) => (f & 7) === 7 && r.lcoe[k] != null);
    r.lcoe[i] += 5;
    await page.route(/article-summary\.json$/, rt => rt.fulfill({ body: JSON.stringify(planted), contentType: 'application/json' }));
    errors.length = 0;
    await openArticle(page);
    const tm = await page.evaluate(() => window.__article.textMismatch);
    const vals = await page.evaluate(() => window.__article.values());
    const m = await compareMaps(page);
    await page.unroute(/article-summary\.json$/);
    const caught = {
        text: tm.some(x => x.key === 't1.cheaper.demand.90' && x.expected === '60%'),
        value: vals['t1.cheaper.demand.90'] !== live.summary.values['t1.cheaper.demand.90'],
        cell: m.bad.some(b => b.state === 'saving' && b.tooltips === 1 && b.example?.i === i)
    };
    if (Object.values(caught).every(Boolean)) pass(`planted page drift: a changed value (${Math.round(live.summary.values['t1.cheaper.demand.90'] * 100)}% → 60%) and a changed map cell are both caught`);
    else fail(`planted page drift: caught ${JSON.stringify(caught)}`);
}

// ---------------------------------------------------------------------------
// 6. story.html (T087): the scrollytelling version of the same article
// ---------------------------------------------------------------------------
if (hasStory) await checkStory();
async function checkStory() {
    const tag = 'index.html (v3): ';
    // Every sentence of index.html's article, read from the page as rendered (bound numbers as shown).
    const blocksOf = () => [...document.querySelectorAll('#article p, #article li, #article h1, #article h2, #article h3, #article .kicker, #article figcaption')]
        .filter(b => !b.querySelector('p, li')).map(b => b.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    errors.length = 0;
    await openArticle(page);
    const indexBlocks = await page.evaluate(blocksOf);
    const indexCharts = await page.evaluate(() => [...document.querySelectorAll('[data-chart]')].map(e => e.dataset.chart));
    const indexStates = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-map]')].map(e => e.dataset.map))]);
    const ext = [];
    const onReq = r => { if (!r.url().startsWith(base)) ext.push(r.url()); };
    const failed = [];
    const onResp = r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); };
    page.on('request', onReq);
    page.on('response', onResp);
    errors.length = 0;
    requestLog.length = 0;
    const t0 = Date.now();
    await openArticle(page, 'index.html');
    const loadMs = Date.now() - t0;
    await page.waitForLoadState('networkidle');
    const sst = await page.evaluate(() => {
        const a = window.__article;
        const spans = [...document.querySelectorAll('[data-n]')].map(el => ({ key: el.dataset.n, f: el.dataset.f, text: el.textContent.trim() }));
        return { textMismatch: a.textMismatch, errors: a.errors, values: a.values(), spans, workers: window.__workersStarted, steps: a.steps };
    });
    console.log(`${tag}ready ${loadMs} ms after navigation; ${requestLog.length} requests, ${requestLog.reduce((s, x) => s + x.bytes, 0).toLocaleString('en-GB')} bytes from the site`);
    if (errors.length || sst.errors.length) fail(`${tag}page errors: ${[...errors, ...sst.errors].join(' | ')}`);
    else pass(`${tag}no page errors`);
    if (failed.length) fail(`${tag}failed requests: ${failed.join(' | ')}`);
    else pass(`${tag}no failed requests`);
    if (ext.length) fail(`${tag}requests to other hosts: ${[...new Set(ext)].join(' | ')}`);
    else pass(`${tag}every request goes to the site itself (${requestLog.length} requests, none to another host)`);
    const forbidden = requestLog.map(x => x.path).filter(u => FORBIDDEN.test(u));
    if (forbidden.length || sst.workers) fail(`${tag}the page loads the live model: ${sst.workers} workers; ${forbidden.join(' | ')}`);
    else pass(`${tag}starts no worker and requests no parquet slice, worker or decoder`);
    {
        const off = [];
        for (const [k, v] of Object.entries(live.summary.values)) if (sst.values[k] !== v) off.push({ key: k, page: sst.values[k], model: v });
        if (off.length) fail(`${tag}values differ from the live model: ${short(off, 1500)}`);
        else pass(`${tag}all ${Object.keys(sst.values).length} values equal the live model's`);
    }
    if (sst.textMismatch.length) fail(`${tag}HTML numbers that do not read as the model values: ${JSON.stringify(sst.textMismatch)}`);
    else pass(`${tag}${sst.spans.length} numbers in the HTML read exactly as the model values`);
    const unbound = sst.spans.filter(x => !(x.key in live.summary.values));
    if (unbound.length) fail(`${tag}bound spans with no model value: ${unbound.map(x => x.key).join(', ')}`);
    {
        const m = await compareMaps(page);
        if (m.bad.length) fail(`${tag}map cells that differ from the live model: ${short(m.bad, 1500)}`);
        else pass(`${tag}every map cell's colour and tooltip equals the live model's (${m.cells} cells × ${m.states.length} states)`);
    }
    // Every chart of index.html and of the article v2 is on the page and drawn; every map state the segments use
    // is one the page can draw (layers.js or story-layers.js); every bound number has a summary value (above).
    {
        const got = await page.evaluate(() => [...document.querySelectorAll('[data-chart]')].map(e => ({ id: e.dataset.chart, drawn: !!e.querySelector('svg') })));
        // T091 round 8 on the scrolly (the human, 7 Nov 2026: the scrolly takes the charts version's framing and charts):
        // the classic article's charts are no longer all on it; it carries charts.html's round-8 charts (article-charts.js)
        const want = ['t3', 'drought', 'bkcurve', 'pophist', 'latpeople', 'planhist', 'bandsave'];   // T101: the charts article's charts (map-wacc: a static map in the finance box)
        void indexCharts;
        const lost = want.filter(c => !got.some(g => g.id === c && g.drawn));
        const states = [...new Set((sst.steps || []).map(x => x.state))];
        const bad = await page.evaluate((st) => st.filter(n => !window.__article.canDraw(n)), states);
        // The planned-capacity dots (GEM by region) total what T089 reports: all, and undercut without and with wind at the
        // 80% / $100 test (Harnessing the Sun's)
        const pt = await page.evaluate(() => window.__article.plannedTotals || null);
        if (pt) {
            const v = live.summary.values;
            const off = [['all', 's6.planned.gw'], ['sb', 's6.local.sb.under100.80.gw'], ['sbw', 's6.local.sbw.under100.80.gw']].filter(([k, key]) => Math.abs(pt[k] - v[key]) > 0.5);
            if (off.length) fail(`${tag}planned coal and gas dots do not total T089's figures: ${JSON.stringify({ page: pt, off })}`);
            else pass(`${tag}planned coal and gas dots total ${Math.round(pt.all)} GW, ${Math.round(pt.sb)} GW undercut without wind and ${Math.round(pt.sbw)} GW with, as T089`);
        }
        // the round-8 charts read the same data as on charts.html: the planned histogram totals the summary's coal and gas,
        // the people histogram's median is the text's s4.total.sbw.people, the latitude bands hold all the people
        {
            const r8 = await page.evaluate(() => ({ hs: window.__article.plannedHist || {}, h: window.__article.peopleHist, lat: window.__article.latPeople }));
            const vv = live.summary.values, ph = r8.hs.planhist;
            const share = r8.lat ? r8.lat.reduce((t, b) => t + b.share, 0) : 0;
            if (!ph || Math.abs(ph.coal - vv['s6.planned.coal.gw']) > 0.5 || Math.abs(ph.gas - vv['s6.planned.gas.gw']) > 0.5
                || !r8.h || Math.abs(r8.h.median - vv['s4.total.sbw.people']) > 1 || Math.abs(share - 1) > 1e-6) fail(`${tag}round-8 charts off the summary: ${JSON.stringify(r8).slice(0, 600)}`);
            else pass(`${tag}round-8 charts on the summary: planned coal ${Math.round(ph.coal)} GW and gas ${Math.round(ph.gas)} GW; people median $${Math.round(r8.h.median)}/MWh, ${Math.round(r8.h.below100 * 100)}% of people below $100/MWh`);
        }
        if (lost.length || bad.length || !states.length) fail(`${tag}charts not drawn: ${lost.join(', ') || 'none'}; map states the page cannot draw: ${bad.join(', ') || 'none'}`);
        else pass(`${tag}every chart is on the page and drawn (${want.join(', ')}); map segments use ${states.join(', ')}, each drawable`);
    }
    const scan = await page.evaluate(scanText, SCAN);
    if (scan.faults.length) fail(`${tag}numbers outside the bound spans: ${JSON.stringify(scan.faults)}`);
    else pass(`${tag}no typed numbers outside the bound spans; ${scan.checkedPhrases} number-word phrases checked against the values`);
    await scanSelfTest(tag, SELF_TEST.story);
    // Each scrolly step sets its map state, desktop and phone; no sideways scroll.
    for (const [w, h, label] of [[1440, 900, 'desktop-1440'], [390, 844, 'phone-390']]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(600);
        const bad = [];
        for (let k = 0; k < sst.steps.length; k++) {
            await page.evaluate((k) => window.scrollTo(0, window.__article.yForStep(k)), k);
            await page.waitForTimeout(900);
            const got = await page.evaluate(() => window.__article.mapState);
            if (got !== sst.steps[k].state) bad.push(`step ${k}: ${got}, expected ${sst.steps[k].state}`);
            if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `story-${label}-step${k}.png`) });
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (bad.length || overflow > 0) fail(`${tag}${label}: ${bad.join('; ')}${overflow > 0 ? ` page scrolls sideways by ${overflow} px` : ''}`);
        else pass(`${tag}${label}: each of the ${sst.steps.length} scrolly steps sets its map state; no sideways scroll`);
    }
    // Entering a segment: as soon as its stage is in view (before card 1) it shows its first step, map and legend
    // together; scrolling back up into it, its last step (the human, T087).
    {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(600);
        const segs = await page.evaluate(() => [...document.querySelectorAll('.seg')].length);
        const bad = [];
        const want = (k, end) => { const ss = sst.steps.filter(x => x.seg === k); return (end ? ss[ss.length - 1] : ss[0]).state; };
        const legendOk = (st, got) => st.startsWith('chart:') || st.startsWith('dots:') || got.legend === got.map;
        for (let k = 0; k < segs; k++) {
            for (const end of [false, true]) {
                await page.evaluate(([k, end]) => {
                    const r = document.querySelectorAll('.seg')[k].getBoundingClientRect();
                    // first: the segment's top 120 px above the viewport's foot (coming down); last: its foot 120 px below the
                    // viewport's top, reached from further down (coming up)
                    if (end) { window.scrollTo(0, window.scrollY + r.bottom + 400); }
                    else { window.scrollTo(0, window.scrollY + r.top - window.innerHeight - 400); }
                }, [k, end]);
                await page.waitForTimeout(700);
                await page.evaluate(([k, end]) => {
                    const r = document.querySelectorAll('.seg')[k].getBoundingClientRect();
                    window.scrollTo(0, end ? window.scrollY + r.bottom - 120 : window.scrollY + r.top - window.innerHeight + 120);
                }, [k, end]);
                await page.waitForTimeout(1300);
                const got = await page.evaluate(() => ({ map: window.__article.mapState, legend: window.__article.legendState }));
                const w = want(k, end);
                if (got.map !== w || !legendOk(w, got)) bad.push(`segment ${k + 1} ${end ? 'from below' : 'from above'}: map ${got.map}, legend ${got.legend}, expected ${w}`);
            }
        }
        if (bad.length) fail(`${tag}entering segments: ${bad.join('; ')}`);
        else pass(`${tag}every one of ${segs} segments shows its first step as its stage comes into view from above, and its last from below; map and legend agree`);
    }
    if (errors.length) fail(`${tag}page errors after scrolling: ${errors.join(' | ')}`);
    // Planted drift, as for index.html.
    {
        const planted = JSON.parse(freshText);
        planted.values['s6.local.sb.under100.80.share'] = 0.6;   // T100 round 7: a percentage the human's text shows (85%)
        const r = planted.results.t90;
        const i = r.flags.findIndex((f, k) => (f & 7) === 7 && r.lcoe[k] != null);
        r.lcoe[i] += 5;
        await page.route(/article-summary\.json$/, rt => rt.fulfill({ body: JSON.stringify(planted), contentType: 'application/json' }));
        await openArticle(page, 'index.html');
        const tm = await page.evaluate(() => window.__article.textMismatch);
        const m = await compareMaps(page);
        await page.unroute(/article-summary\.json$/);
        const caught = { text: tm.some(x => x.key === 's6.local.sb.under100.80.share' && x.expected === '60%'), cell: m.bad.some(b => b.state === 'saving' && b.tooltips === 1 && b.example?.i === i) };
        if (Object.values(caught).every(Boolean)) pass(`${tag}planted page drift: a changed value and a changed map cell are both caught`);
        else fail(`${tag}planted page drift: caught ${JSON.stringify(caught)}`);
    }
    page.off('request', onReq);
    page.off('response', onResp);
}

// ---------------------------------------------------------------------------
// 7. charts.html (T091): the charts-only version of the same article (no maps, no scroll motion)
// ---------------------------------------------------------------------------
const CHARTS_PAGE = path.join(articleDir, 'charts.html');
if (fs.existsSync(CHARTS_PAGE)) await checkChartsPage();
async function checkChartsPage() {
    const tag = 'charts.html (T091): ';
    {
        // the cost-of-capital lens values the page binds are what analyse_wacc_lens.py gives from the committed data
        const a = spawnSync('python3', [path.join(ROOT, 'scripts/article/analysis/t091/analyse_wacc_lens.py'), '--check'], { encoding: 'utf8' });
        if (a.status !== 0) fail(`${tag}${(a.stdout + a.stderr).trim().slice(0, 800)}`);
        else pass(`${tag}${a.stdout.trim()}`);
    }
    {
        const r = spawnSync('python3', ['-I', path.join(TOOLS, 'charts-build.py'), '--check'], { encoding: 'utf8' });
        if (r.status !== 0) fail(`${tag}not what charts-build.py gives from the draft: ${(r.stdout + r.stderr).trim().slice(0, 1500)}`);
        else pass(`${tag}${r.stdout.trim()}`);
        const html = fs.readFileSync(CHARTS_PAGE, 'utf8');
        const clean = html.replaceAll('existing clean resources on the grid', '').match(/.{0,40}\bclean.{0,20}/gi);   // T100: the human's phrase only
        if (clean) fail(`${tag}uses the word "clean": ${clean.join(' | ')}`);
        else pass(`${tag}the word "clean" appears nowhere`);
        const motion = html.match(/data-(?:motion|reveal|steps|pin|state|dots)="|class="seg\b|gsap|ScrollTrigger|id="map"/g);
        if (motion) fail(`${tag}scrollytelling left on the page: ${[...new Set(motion)].join(', ')}`);
        else pass(`${tag}no scrolly map stage or segment, no scroll-driven motion and no GSAP`);
    }
    const ext = [];
    const failed = [];
    const onReq = r => { if (!r.url().startsWith(base)) ext.push(r.url()); };
    const onResp = r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); };
    page.on('request', onReq);
    page.on('response', onResp);
    errors.length = 0;
    requestLog.length = 0;
    await openArticle(page, 'charts.html');
    await page.waitForLoadState('networkidle');
    const st = await page.evaluate(() => {
        const a = window.__article;
        const spans = [...document.querySelectorAll('[data-n]')].map(el => ({ key: el.dataset.n, f: el.dataset.f, text: el.textContent.trim() }));
        const charts = [...document.querySelectorAll('[data-chart]')].map(e => ({ id: e.dataset.chart, drawn: !!e.querySelector('svg') }));
        return { textMismatch: a.textMismatch, errors: a.errors, values: a.values(), spans, charts, keys: a.chartKeyList(), workers: window.__workersStarted };
    });
    if (errors.length || st.errors.length) fail(`${tag}page errors: ${[...errors, ...st.errors].join(' | ')}`);
    else pass(`${tag}no page errors`);
    if (failed.length) fail(`${tag}failed requests: ${failed.join(' | ')}`);
    else pass(`${tag}no failed requests`);
    if (ext.length) fail(`${tag}requests to other hosts: ${[...new Set(ext)].join(' | ')}`);
    else pass(`${tag}every request goes to the site itself (${requestLog.length} requests, none to another host)`);
    const forbidden = requestLog.map(x => x.path).filter(u => FORBIDDEN.test(u));
    if (forbidden.length || st.workers) fail(`${tag}the page loads the live model: ${st.workers} workers; ${forbidden.join(' | ')}`);
    else pass(`${tag}starts no worker and requests no parquet slice, worker or decoder`);
    {
        const off = [];
        for (const [k, v] of Object.entries(live.summary.values)) if (st.values[k] !== v) off.push({ key: k, page: st.values[k], model: v });
        if (off.length) fail(`${tag}values differ from the live model: ${short(off, 1500)}`);
        else pass(`${tag}all ${Object.keys(st.values).length} values equal the live model's`);
    }
    if (st.textMismatch.length) fail(`${tag}HTML numbers that do not read as the model values: ${JSON.stringify(st.textMismatch)}`);
    else pass(`${tag}${st.spans.length} numbers in the HTML read exactly as the model values`);
    const unbound = st.spans.filter(x => !(x.key in live.summary.values));
    if (unbound.length) fail(`${tag}bound spans with no model value: ${unbound.map(x => x.key).join(', ')}`);
    {
        // Every chart is drawn, and every value a chart reads is a value of the live model (recorded by charts-page.js)
        const want = ['t3', 'drought', 'bkcurve', 'pophist', 'latpeople', 'planhist', 'bandsave'];   // T100: the human's draft (bands90, the ladder, latsave and multcountries are not on the page)   // planhist: T091 round 6, in place of tiers; pophist and latpeople in place of shift, weights and the cartogram (the human, 6 Nov 2026)
        const lost = want.filter(c => !st.charts.some(g => g.id === c && g.drawn));
        const keys = Object.values(st.keys).flat();
        const missing = keys.filter(k => !Number.isFinite(live.summary.values[k]));
        if (lost.length || missing.length || !keys.length) fail(`${tag}charts not drawn: ${lost.join(', ') || 'none'}; chart values with no model value: ${missing.join(', ') || 'none'}`);
        else pass(`${tag}all ${want.length} charts drawn; the ${keys.length} values they read are all live model values`);
    }
    {
        // The static maps (T091 round 2): every map figure drawn, every panel with regions (or circles) on it; the planned
        // coal and gas circles total T089/T090's figures, all and per tier
        {
            // the section 6 histogram (T091 round 6): its planned coal and gas, region by region from story-planned.json, add
            // up to the summary's (charts-page.js also records an error if not); every planned GW has a cost
            const hs = await page.evaluate(() => window.__article.plannedHist || {});
            const vv = live.summary.values;
            // T100: its marker (the share below $100/MWh) is the text's s6.local.sbw.bk90.under100.gw (derive_t100.py)
            const bad = ['planhist'].filter(id => { const h = hs[id]; return !h || Math.abs(h.coal - vv['s6.planned.coal.gw']) > 0.5 || Math.abs(h.gas - vv['s6.planned.gas.gw']) > 0.5 || !(h.below100 > 0 && h.below100 <= 1)
                || Math.abs(h.below100 * vv['s6.planned.gw'] - vv['s6.local.sbw.bk90.under100.gw']) > 0.05; });   // the same GW (story-cells' planned column is rounded to 1 MW, so the shares differ by ~2e-6)
            if (bad.length) fail(`${tag}planned histograms off the summary: ${bad.join(', ')} ${JSON.stringify(hs)}`);
            else pass(`${tag}planned histogram: coal ${Math.round(hs.planhist.coal)} GW and gas ${Math.round(hs.planhist.gas)} GW, as the summary; ${(hs.planhist.below100 * 100).toFixed(1)}% below $100/MWh, as the text's ${Math.round(vv['s6.local.sbw.bk90.under100.gw'])} GW`);
        }
        {
            // T100: section 4's cost-split chart and section 8's band chart (the 90% case, every hour with backup), drawn from
            // the summary (derive_t100.py, re-derived above): every bar's total and every backup label that fits equal the
            // summary values, and each bar's parts add up to its total
            const vv = live.summary.values;
            const got = await page.evaluate(() => {
                const q = (id, sel) => { const n = document.querySelector(`[data-chart="${id}"]`); return n ? [...n.querySelectorAll(sel)].map(t => t.textContent) : null; };
                return { totals: q('backupbands', '.sb-total'), backups: q('backupbands', '.sb-backup'), bandsave: q('bandsave', 'svg .gb-row text') };
            });
            const usd = x => `$${Math.round(x).toLocaleString('en-GB')}`;
            const BANDS = ['a55p', 'a45_55', 'a30_45', 'a15_30', 'a0_15'];
            const bars = ['world', ...BANDS].flatMap(id => ['sb', 'sbw'].map(b => ['renew', 'backup', 'total'].map(p => vv[`s4bk.${id}.${b}.${p}`])));
            const wantT = bars.map(([, , t]) => (t > 200 ? `${usd(t)} →` : usd(t)));
            const adds = bars.every(([r, b, t]) => Math.abs(r + b - t) < 1e-9);
            const backupsOk = (got.backups || []).length > 0 && got.backups.every(x => bars.some(([, b]) => usd(b) === x));
            const wantS = BANDS.flatMap(id => [2026, 2050].map(Y => usd(vv[`s8bk.band.${id}.saving.${Y}`])));
            const okS = JSON.stringify((got.bandsave || []).filter(t => /^\$/.test(t))) === JSON.stringify(wantS);
            // the uptime ladder: its points are the summary's ladder.*; its 90%, 95%, 99% and every-hour points are T089's s4.curve
            const lad = await page.evaluate(() => window.__article.ladder || null);
            const TS = [25, 30, 40, 50, 60, 70, 80, 90, 95, 99];
            const ladOk = !lad ? false : ['sb', 'sbw'].every(b => JSON.stringify(lad[b].line) === JSON.stringify(TS.map(t => vv[`ladder.${b}.${t}`])) && lad[b].every === vv[`ladder.${b}.100`]
                && [90, 95, 99, 100].every(t => Math.abs(vv[`ladder.${b}.${t}`] - vv[`s4.curve.${b}.demand.${t}`]) <= 0.01));
            if (!lad) pass(`${tag}uptime ladder: not on the page (not in the human's draft of 9 Nov 2026); its values stay re-derived by derive_ladder --check`);
            else if (!ladOk) fail(`${tag}uptime ladder off the summary or off T089's s4.curve: ${JSON.stringify(lad).slice(0, 400)}`);
            else pass(`${tag}uptime ladder: every point as the summary; the top three targets and every hour equal T089's s4.curve (${usd(vv['s4.curve.sb.demand.100'])} and ${usd(vv['s4.curve.sbw.demand.100'])} every hour)`);
            // the backup curve (section 4): its points are the summary's ladder.bk.*, its 90% point the cost split's world total
            const bk = await page.evaluate(() => window.__article.bkcurve || null);
            const BT = [60, 70, 80, 90, 95, 99];
            const bkOk = !!bk && ['sb', 'sbw'].every(b => JSON.stringify(bk[b]) === JSON.stringify(BT.map(t => vv[`ladder.bk.${b}.${t}`]))
                && Math.abs(vv[`ladder.bk.${b}.90`] - vv[`s4bk.world.${b}.total`]) <= 0.01)
                // the guide: with wind 95% costs about what solar and batteries pay for 80% (within 3%)
                && JSON.stringify(bk.guide) === JSON.stringify([vv['ladder.bk.sb.80'], vv['ladder.bk.sbw.95']]) && Math.abs(vv['ladder.bk.sbw.95'] / vv['ladder.bk.sb.80'] - 1) <= 0.03;
            if (!bkOk) fail(`${tag}backup curve off the summary: ${JSON.stringify(bk).slice(0, 400)}`);
            else pass(`${tag}backup curve: every point as the summary; the 90% point = the cost split's world total (${usd(vv['ladder.bk.sb.90'])} and ${usd(vv['ladder.bk.sbw.90'])})`);
            if (got.totals === null) {
                if (!okS) fail(`${tag}band chart off the summary: ${JSON.stringify({ got: got.bandsave, wantS })}`);
                else pass(`${tag}cost split: not on the page (replaced by the backup curve; values re-derived by derive_t100 --check); band chart: ${wantS.length} bars on the 90% case`);
            }
            else if (JSON.stringify(got.totals) !== JSON.stringify(wantT) || !adds || !backupsOk || !okS) fail(`${tag}T100 charts off the summary: ${JSON.stringify({ got, wantT, wantS, adds }).slice(0, 900)}`);
            else pass(`${tag}cost-split chart: ${wantT.length} bar totals and ${got.backups.length} backup labels as the summary, parts adding up; band chart: ${wantS.length} bars on the 90% case`);
        }
        {
            // the section 5 charts (the human, 6 Nov 2026): the people histogram's people-weighted median equals the text's
            // s4.total.sbw.people (charts-page.js also records an error if not); the latitude bands hold all the people
            const pp = await page.evaluate(() => ({ h: window.__article.peopleHist, lat: window.__article.latPeople }));
            const vv = live.summary.values;
            const share = pp.lat ? pp.lat.reduce((t, b) => t + b.share, 0) : 0;
            if (!pp.h || Math.abs(pp.h.median - vv['s4.total.sbw.people']) > 1 || !(pp.h.below100 > 0 && pp.h.below100 <= 1) || Math.abs(share - 1) > 1e-6) fail(`${tag}section 5 charts off the summary: ${JSON.stringify({ h: pp.h, share })}`);
            else pass(`${tag}people histogram: median $${Math.round(pp.h.median)}/MWh as the text, ${Math.round(pp.h.below100 * 100)}% of people below $100/MWh; latitude bands hold all the people`);
        }
        const m = await page.evaluate(() => ({ maps: window.__article.maps, pt: window.__article.plannedTotals }));
        const wantMaps = ['map-cost90', 'map-wacc', 'map-saving', 'map-drought', 'map-backup', 'map-planned', 'map-potential', 'map-saving99'];
        const empty = wantMaps.filter(id => !m.maps[id] || !m.maps[id].panels.length || m.maps[id].panels.some(p => !(p.coloured > 0 || p.points > 0)));
        const v = live.summary.values;
        const off = m.pt ? [['all', 's6.planned.gw'], ['sb', 's6.local.sb.under100.80.gw'], ['sbw', 's6.local.sbw.under100.80.gw'], ['sbw130', 's6.local.sbw.under130.80.gw']]
            .filter(([k, key]) => Math.abs(m.pt[k] - v[key]) > 0.5) : ['no planned totals'];
        if (empty.length || off.length) fail(`${tag}maps not drawn or empty: ${empty.join(', ') || 'none'}; planned circles off the summary: ${JSON.stringify(off)}`);
        else pass(`${tag}all ${wantMaps.length} maps drawn (${wantMaps.reduce((s, id) => s + m.maps[id].panels.length, 0)} panels, each with regions or circles); planned circles total ${Math.round(m.pt.all)} GW, tiers ${Math.round(m.pt.sb)} / ${Math.round(m.pt.sbw)} / ${Math.round(m.pt.sbw130)} GW, as the summary`);
    }
    const scan = await page.evaluate(scanText, SCAN);
    if (scan.faults.length) fail(`${tag}numbers outside the bound spans: ${JSON.stringify(scan.faults)}`);
    else pass(`${tag}no typed numbers outside the bound spans; ${scan.checkedPhrases} number-word phrases checked against the values`);
    await scanSelfTest(tag, SELF_TEST.story);
    for (const [w, h, label] of [[1440, 900, 'desktop-1440'], [390, 844, 'phone-390']]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(600);
        const r = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            wide: [...document.querySelectorAll('figure.chart svg')].filter(s => s.getBoundingClientRect().right > window.innerWidth + 0.5).length,
            errors: window.__article.errors.length
        }));
        if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `charts-${label}.png`), fullPage: true });
        if (r.overflow > 0 || r.wide || r.errors) fail(`${tag}${label}: page scrolls sideways by ${r.overflow} px; ${r.wide} charts wider than the screen; ${r.errors} errors after redraw`);
        else pass(`${tag}${label}: no sideways scroll, every chart inside the screen`);
    }
    // Planted drift: a changed value is caught in the text
    {
        const planted = JSON.parse(freshText);
        planted.values['s6.local.sb.under100.80.share'] = 0.6;   // T100 round 7: a percentage the human's text shows (85%)
        await page.route(/article-summary\.json$/, rt => rt.fulfill({ body: JSON.stringify(planted), contentType: 'application/json' }));
        await openArticle(page, 'charts.html');
        const tm = await page.evaluate(() => window.__article.textMismatch);
        await page.unroute(/article-summary\.json$/);
        if (tm.some(x => x.key === 's6.local.sb.under100.80.share' && x.expected === '60%')) pass(`${tag}planted page drift: a changed value is caught`);
        else fail(`${tag}planted page drift not caught: ${JSON.stringify(tm)}`);
    }
    page.off('request', onReq);
    page.off('response', onResp);
}

await browser.close();
server.close();
console.log(failures.length ? `ARTICLE CHECK FAILED (${failures.length})` : 'ARTICLE CHECK PASSED');
process.exit(failures.length ? 1 : 0);
