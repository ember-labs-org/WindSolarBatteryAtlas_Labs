// Complementarity tab (T093, replaces the Sample Days check): the data loads only
// when the tab opens, every view and toggle draws, and what is drawn equals an
// oracle written here from the file (not imported from complementarity.js): each
// region's value and colour (the registry's rampScale, imported in Node), NA exactly
// where the file has no row. Score view (T096): legend and tooltip give the
// correlation r = 1 - 2 * score with its meaning. Also: the week drought shares equal T088's article file
// for three regions, the tooltip prints the file's figures, legends follow the view,
// no request leaves the origin, no sideways scroll at 1440 and 390 px, no page errors.
// Run on the canvas map and on the SVG fallback (?canvas=0). Screenshots go to
// CHECK_SHOTS (a directory) when it is set.
// Runs under the machine-wide lock, shared, like smoke.mjs (D-018).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve, openPage, waitForFirstMap, runUnderLock, resolveBrowser, browserLine, SITE, ROOT } from './lib.mjs';

runUnderLock('shared', { waitS: 3600, runS: 900 });
if (resolveBrowser().mismatch) console.log(`WARN ${browserLine()}`);

const results = [];
const check = (ok, name, detail = '') => results.push({ ok: !!ok, name, detail });
const SHOTS = process.env.CHECK_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const readCsv = (file) => {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#'));
    const cols = lines[0].split(',');
    return new Map(lines.slice(1).map((l) => {
        const v = l.split(',').map(Number);
        return [v[0], Object.fromEntries(cols.map((c, j) => [c, v[j]]))];
    }));
};
const DATA = readCsv(path.join(SITE, 'data/complementarity.csv'));
const { rampScale } = await import(pathToFileURL(path.join(SITE, 'js/constants.js')).href);
const drought = rampScale('drought', [0, 0.3]);
const delta = rampScale('delta', [0, 1]);
const expectColour = (key, v) => (key.startsWith('c_') ? delta(1 - v) : drought(v));

// The tab's weekly shares are T088's (the article's) for the same regions.
const T088 = path.join(SITE, 'scrollytelling/data/t088_regions.csv');
if (fs.existsSync(T088)) {
    const t = readCsv(T088);
    const ids = [...t.keys()].filter(id => DATA.has(id));
    const pick = [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]];
    let worst = 0;
    let whole = 0;
    for (const id of ids) {
        const a = DATA.get(id), b = t.get(id);
        const d = Math.max(Math.abs(a.wk_solar - b.w7_t50_ps), Math.abs(a.wk_wind - b.w7_t50_pw), Math.abs(a.wk_both - b.w7_t50_pboth));
        whole = Math.max(whole, d);
        if (pick.includes(id)) worst = Math.max(worst, d);
    }
    check(worst <= 1.5e-4, `week drought shares equal T088's article file for regions ${pick.join(', ')}`, `max diff ${worst.toFixed(5)}`);
    check(whole <= 1.5e-4 && t.size === ids.length, `... and for all ${ids.length} of T088's ${t.size} regions (rounding only)`, `max diff ${whole.toFixed(5)}`);
}
const allIn01 = [...DATA.values()].every(r => Object.entries(r).every(([k, v]) => k === 'location_id' || (v >= 0 && v <= 1)));
check(allIn01, `every value in the file lies in 0-1 (${DATA.size} regions)`);

const visible = (page, sel) => page.$eval(sel, el => !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none'
    && el.getBoundingClientRect().width > 0).catch(() => false);
const text = (page, sel) => page.$eval(sel, el => el.textContent.trim());
const waitState = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout });

// Every drawn row against the file: value, colour, NA.
async function compareDrawn(page, key) {
    const rows = await page.evaluate(() => window.__complementarity.rows.map(r => [r.location_id, r.isNA ? null : r.value, r.color]));
    let worst = 0, colourWrong = 0, naWrong = 0, na = 0, inFile = 0;
    for (const [id, v, colour] of rows) {
        const row = DATA.get(id);
        if (!row) { na++; if (v !== null) naWrong++; continue; }
        inFile++;
        if (v === null) { naWrong++; continue; }
        worst = Math.max(worst, Math.abs(v - row[key]));
        if (colour !== expectColour(key, row[key])) colourWrong++;
    }
    return { n: rows.length, worst, colourWrong, naWrong, na, inFile };
}

async function run(base, variant) {
    const { browser, page, errors } = await openPage({ throttle: 1 });
    const local = new URL(base).origin;
    const csvRequests = [];
    const offOrigin = [];
    let opened = false;
    page.on('request', (r) => {
        const u = r.url();
        if (u.includes('complementarity.csv')) csvRequests.push(u);
        if (opened && !u.startsWith(local) && !u.startsWith('data:') && !u.startsWith('blob:')) offOrigin.push(u);
    });
    const tag = variant === 'canvas' ? '' : `[${variant}] `;
    const query = { canvas: '', svg: '&canvas=0' }[variant];
    try {
        await page.goto(`${base}/index.html?debug${query}`);
        await waitForFirstMap(page, 120000);
        // The first-visit tour nudge appears 400 ms after start-up and covers the panel's top.
        await page.waitForSelector('.tour-nudge__close', { timeout: 5000 }).catch(() => {});
        await page.evaluate(() => document.querySelector('.tour-nudge__close')?.click());
        await page.waitForTimeout(1000);
        check(csvRequests.length === 0, `${tag}data not requested before the tab opens`, csvRequests.join(', '));
        const tab = 'button[data-mode="complementarity"]';
        check(await text(page, tab) === 'Complementarity' && await visible(page, tab), `${tag}tab reads "Complementarity"`);
        check(await page.$('button[data-mode="samples"]') === null, `${tag}no Sample Days tab left`);

        opened = true;
        await page.click(tab);
        await waitState(page, () => window.__complementarity && window.__complementarity.rows.length > 0, null, 30000);
        check(csvRequests.length === 1, `${tag}data requested once on opening`, `${csvRequests.length} requests`);
        check(await visible(page, '#comp-controls') && !(await visible(page, '#primary-controls')), `${tag}its own controls replace the build panel`);
        check(await visible(page, '#legend-comp-drought') && !(await visible(page, '#legend-comp-score')) && !(await visible(page, '#legend-capacity')),
            `${tag}drought legend only`);

        // Droughts: every source x period.
        for (const period of ['wk', 'mo']) {
            await page.click(`#comp-period-toggle [data-comp-period="${period}"]`);
            for (const source of ['solar', 'wind', 'both']) {
                await page.click(`#comp-source-toggle [data-comp-source="${source}"]`);
                const key = `${period}_${source}`;
                await waitState(page, k => window.__complementarity.key === k, key);
                const r = await compareDrawn(page, key);
                check(r.worst <= 1e-12 && r.colourWrong === 0 && r.naWrong === 0 && r.inFile >= 4300,
                    `${tag}droughts ${key}: every region's value and colour equal the file, NA exactly where it has no row`,
                    `${r.n} drawn, ${r.na} NA, ${r.inFile} of the file's ${DATA.size} regions on the map, worst ${r.worst}, colours wrong ${r.colourWrong}, NA wrong ${r.naWrong}`);
                const title = await text(page, '#legend-comp-drought-title');
                const want = `${{ solar: 'Solar', wind: 'Wind', both: 'Solar and wind at once' }[source]}: share of ${period === 'wk' ? 'weeks' : 'months'} in drought`;
                check(title === want, `${tag}legend title for ${key}`, title);
                if (SHOTS && variant === 'canvas' && period === 'wk') await page.waitForTimeout(1500);
                if (SHOTS && variant === 'canvas' && period === 'wk') await page.screenshot({ path: path.join(SHOTS, `droughts-${key}-1440.png`) });
            }
        }
        // Mixing: in most regions both at once is rarer than either alone, and rarer than if they were unrelated.
        const rows = [...DATA.values()];
        const rarer = rows.filter(r => r.wk_both <= Math.min(r.wk_solar, r.wk_wind)).length;
        check(rarer === rows.length, `${tag}both-at-once never exceeds either source alone (${rarer} of ${rows.length})`);

        // Tooltip for a region in the middle of the file.
        const id = [...DATA.keys()][Math.floor(DATA.size / 3)];
        const pt = await page.evaluate((locId) => {
            const row = window.__complementarity.rows.find(r => r.location_id === locId);
            return { html: window.__complementarity.tooltip(row) };
        }, id);
        const r0 = DATA.get(id);
        const pct = v => `${(v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0)}%`;
        const tip = pt.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const wantTip = [`Solar: ${pct(r0.mo_solar)}`, `Wind (onshore): ${pct(r0.mo_wind)}`, `Both at once: ${pct(r0.mo_both)}`, `if unrelated: ${pct(r0.mo_solar * r0.mo_wind)}`];
        check(wantTip.every(w => tip.includes(w)), `${tag}drought tooltip prints the file's figures (region ${id}, month)`, tip.slice(0, 220));

        // Complementarity: every level.
        await page.click('#comp-view-toggle [data-comp-view="score"]');
        check(await visible(page, '#comp-level-row') && !(await visible(page, '#comp-drought-rows')), `${tag}score view shows its level toggle, hides the drought toggles`);
        check(await visible(page, '#legend-comp-score') && !(await visible(page, '#legend-comp-drought')), `${tag}score legend only`);
        for (const level of ['day', 'week', 'month']) {
            await page.click(`#comp-level-toggle [data-comp-level="${level}"]`);
            const key = `c_${level}`;
            await waitState(page, k => window.__complementarity.key === k, key);
            const r = await compareDrawn(page, key);
            check(r.worst <= 1e-12 && r.colourWrong === 0 && r.naWrong === 0 && r.inFile >= 4300,
                `${tag}complementarity ${level}: every region's value and colour equal the file`,
                `${r.n} drawn, ${r.na} NA, ${r.inFile} of the file's ${DATA.size} regions on the map, worst ${r.worst}, colours wrong ${r.colourWrong}, NA wrong ${r.naWrong}`);
            if (SHOTS && variant === 'canvas') { await page.waitForTimeout(1500); await page.screenshot({ path: path.join(SHOTS, `score-${level}-1440.png`) }); }
        }
        const scoreTip = await page.evaluate((locId) => {
            const row = window.__complementarity.rows.find(r => r.location_id === locId);
            return window.__complementarity.tooltip(row);
        }, id);
        // T096: the tooltip states the correlation r = 1 - 2 * score (two decimals,
        // a real minus sign) for day, week and month, each with its plain meaning.
        const fmtR = (v) => { const t = v.toFixed(2); return Number(t) === 0 ? '0.00' : (v > 0 ? `+${t}` : `\u2212${t.slice(1)}`); };
        const tipText = scoreTip.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const wantR = [['Daily', 'day'], ['Weekly', 'week'], ['Monthly', 'month']].map(([n, k]) => `${n}: ${fmtR(1 - 2 * r0[`c_${k}`])} (`);
        check(wantR.every(w => tipText.includes(w)) && !/-\d/.test(tipText) && /correlated/.test(tipText),
            `${tag}score tooltip prints r for day, week and month with its meaning`, `${wantR.join(' | ')} :: ${tipText.slice(0, 260)}`);
        // Every region's tooltip, all three levels: the band text follows the PRINTED
        // (two-decimal) r, with boundaries -0.50 / -0.20 to the band below and
        // +0.20 / +0.50 to the band above, so one printed value reads one way.
        const band = (printed) => {
            const v = Number(printed.replace('\u2212', '-'));
            if (v <= -0.5) return 'highly anti-correlated: complementary';
            if (v <= -0.2) return 'anti-correlated: partly complementary';
            if (v < 0.2) return 'hardly correlated: neutral';
            if (v < 0.5) return 'correlated: little complementarity';
            return 'highly correlated: not complementary';
        };
        const allTips = await page.evaluate(() => window.__complementarity.rows.filter(r => !r.isNA).map(r => [r.location_id, window.__complementarity.tooltip(r)]));
        let badMeaning = 0, checked = 0, firstBad = '';
        const seenBands = new Set();
        const byPrinted = new Map();
        for (const [locId, html] of allTips) {
            const t = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
            const row = DATA.get(locId);
            for (const [n, k] of [['Daily', 'day'], ['Weekly', 'week'], ['Monthly', 'month']]) {
                const printed = fmtR(1 - 2 * row[`c_${k}`]);
                const want = `${n}: ${printed} (${band(printed)})`;
                checked++;
                seenBands.add(band(printed));
                const m = t.match(new RegExp(`${n}: (\\S+) \\(([^)]*)\\)`));
                const got = m ? m[2] : null;
                if (m) { if (!byPrinted.has(m[1])) byPrinted.set(m[1], new Set()); byPrinted.get(m[1]).add(got); }
                if (!t.includes(want)) { badMeaning++; if (!firstBad) firstBad = `${locId} ${k}: want "${want}" in "${t.slice(0, 200)}"`; }
            }
        }
        const twoWays = [...byPrinted].filter(([, set]) => set.size > 1).map(([v]) => v);
        check(badMeaning === 0 && checked === allTips.length * 3 && seenBands.size === 5,
            `${tag}score tooltip band text follows the printed r at day, week and month (${allTips.length} regions, all five bands seen)`,
            `${badMeaning} wrong of ${checked}; bands seen ${[...seenBands].join(' | ')} ${firstBad}`);
        check(twoWays.length === 0, `${tag}no printed r reads two ways`, twoWays.slice(0, 5).join(', '));
        // The page's own bands at and next to the boundaries (synthetic rows): a value
        // that prints as -0.20 reads like -0.20, whichever side it came from.
        const edgeRs = [-0.5, -0.4952, -0.2, -0.2020, -0.1972, 0.1972, 0.2, 0.4952, 0.5];
        const edgeTips = await page.evaluate((rs) => rs.map(r => window.__complementarity.tooltip({ kind: 'score', row: { c_day: (1 - r) / 2, c_week: (1 - r) / 2, c_month: (1 - r) / 2 } })), edgeRs);
        const edgeBad = edgeRs.map((r, i) => {
            const t = edgeTips[i].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
            const want = `Daily: ${fmtR(r)} (${band(fmtR(r))})`;
            return t.includes(want) ? null : `${r}: want "${want}"`;
        }).filter(Boolean);
        check(edgeBad.length === 0, `${tag}bands at and next to \u00b10.20 and \u00b10.50 follow the printed value`, edgeBad.join(' | '));
        const ticks = await page.$$eval('#legend-comp-score-ticks span', els => els.map(e => e.textContent.trim()));
        const meaning = await page.$$eval('#legend-comp-score-meaning > span', els => els.map(e => e.textContent.trim()));
        check(ticks.join(' ') === '+1 0 \u22121' && meaning[0] === '(highly correlated: not complementary)' && meaning[1] === '(highly anti-correlated: complementary)',
            `${tag}score legend runs +1 to \u22121 with the meaning in brackets`, `${ticks.join(' ')} / ${meaning.join(' / ')}`);
        const unsplit = await page.$$eval('#legend-comp-score-meaning .comp-nowrap', els => els.map(e => e.getClientRects().length));
        check(unsplit.length === 1 && unsplit[0] === 1, `${tag}"anti-correlated" stays on one line in the legend`, unsplit.join(','));
        const title = await text(page, '#legend-comp-score-title');
        check(title === 'Correlation of monthly solar and wind output', `${tag}score legend title names the correlation and the level`, title);
        // The legend bar runs 0 (left, amber) to 1 (right, blue): its end pixels are the ramp's ends.
        const bar = await page.$eval('#legend-comp-score-bar', el => el.style.background);
        check(/^linear-gradient\(to left/.test(bar), `${tag}score legend bar runs right to left on the blue-amber ramp (blue = 1)`);

        // Phone width: no sideways scroll, panel reachable.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(800);
        const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth]);
        check(sw[0] <= sw[2] && sw[1] <= sw[2], `${tag}no sideways scroll at 390 px`, sw.join(' / '));
        const lg = await page.$eval('#legend-comp-score', el => {
            const r = el.getBoundingClientRect();
            const spill = [...el.querySelectorAll('div, span')].some(s => s.scrollWidth > s.clientWidth + 1 || s.getBoundingClientRect().right > r.right);
            return { w: el.scrollWidth, cw: el.clientWidth, left: r.left, right: r.right, spill };
        });
        check(lg.w <= lg.cw && !lg.spill && lg.left >= 0 && lg.right <= 390, `${tag}score legend fits at 390 px`, JSON.stringify(lg));
        if (SHOTS && variant === 'canvas') await page.screenshot({ path: path.join(SHOTS, 'score-month-390.png') });
        await page.click('#comp-view-toggle [data-comp-view="droughts"]');
        check(await visible(page, '#legend-comp-drought'), `${tag}view toggle works at 390 px`);
        await page.waitForTimeout(1500);
        if (SHOTS && variant === 'canvas') await page.screenshot({ path: path.join(SHOTS, 'droughts-390.png') });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(800);
        const sw2 = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth]);
        check(sw2[0] <= sw2[2] && sw2[1] <= sw2[2], `${tag}no sideways scroll at 1440 px`, sw2.join(' / '));

        // Leave the tab: controls and legends go; come back without a new fetch.
        await page.click('button[data-mode="capacity"]');
        await page.waitForTimeout(500);
        check(!(await visible(page, '#comp-controls')) && !(await visible(page, '#legend-comp-drought')) && !(await visible(page, '#legend-comp-score'))
            && await visible(page, '#legend-capacity'), `${tag}leaving the tab hides its controls and legends`);
        await page.click(tab);
        await waitState(page, () => !document.getElementById('legend-comp-drought').classList.contains('hidden'), null);
        check(csvRequests.length === 1, `${tag}reopening the tab does not refetch`);
        check(offOrigin.length === 0, `${tag}no request leaves the origin once the tab is used`, offOrigin.slice(0, 3).join(', '));
    } catch (e) {
        const at = (e.stack || '').split('\n').filter(l => l.includes('complementarity.mjs')).map(l => l.replace(/.*complementarity.mjs:/, 'line ')).join(' <- ');
        check(false, `${tag}run`, `${e.message.split('\n')[0]} ${at.trim()}`);
    } finally {
        check(errors.length === 0, `${tag}no page errors`, errors.slice(0, 2).join(' | '));
        await browser.close();
    }
}

const { server, base } = await serve();
try {
    await run(base, 'canvas');
    await run(base, 'svg');
} finally {
    server.close();
}
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} complementarity ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`${failed ? 'FAIL' : 'PASS'} complementarity: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
