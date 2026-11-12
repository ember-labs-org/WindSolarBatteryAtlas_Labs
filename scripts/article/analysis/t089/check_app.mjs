// T089: drive the real atlas (?debug) in Local mode at 90% uptime, without and with backup, and
// compare every drawn row (what the tooltip reads, window.__drawn) with run.mjs's dump.
//   node scripts/article/analysis/t089/check_app.mjs [runs.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve, openPage, waitForFirstMap, setRange, waitDrawn, mark, runUnderLock, browserLine } from '../../../../checks/lib.mjs';

runUnderLock('shared', { waitS: 3600, runS: 1800 });
const RUNS = process.argv[2] || path.join(os.homedir(), 'wind-atlas-T089/cells/t089_runs.json');
const runs = JSON.parse(fs.readFileSync(RUNS, 'utf8')).runs;
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;
const FIELDS = ['location_id', 'lcoe', 'meetsTarget', 'solar_gw', 'wind_gw', 'batt_gwh', 'noWindLcoe', 'backup_share_cf', 'backup_fuel', 'backup_lcoe_adder'];

async function drawn(page) {
    return page.evaluate((f) => window.__drawn.views.lcoe.copy.map(r => Object.fromEntries(f.map(k => [k, r[k]]))), FIELDS);
}
function compare(name, rows, ref) {
    const at = new Map(ref.location_id.map((id, i) => [id, i]));
    let n = 0, worst = 0, fieldBad = 0, missing = 0;
    const samples = [];
    for (const r of rows) {
        const i = at.get(r.location_id);
        if (i === undefined) { missing++; continue; }
        n++;
        const a = r.lcoe, b = ref.lcoe[i];
        if (Number.isFinite(a) && Number.isFinite(b)) worst = Math.max(worst, Math.abs(a - b));
        else if ((a == null || !Number.isFinite(a)) !== (b == null)) fieldBad++;
        for (const k of ['solar_gw', 'wind_gw', 'batt_gwh', 'backup_fuel']) if ((r[k] ?? null) !== (ref[k][i] ?? null)) fieldBad++;
        if ([134, 356, 961, 2291].includes(r.location_id)) samples.push({ id: r.location_id, app: r.lcoe, mine: b, fuel: r.backup_fuel, share: r.backup_share_cf });
    }
    console.log(`${name}: ${n} rows compared, ${missing} not in dump, max |lcoe diff| ${worst.toExponential(2)}, field mismatches ${fieldBad}`);
    console.log('  samples', JSON.stringify(samples));
    return worst < 1e-6 && fieldBad === 0;
}

console.log(browserLine());
const { server, base } = await serve();
const { browser, page, errors } = await openPage();
let ok = true;
try {
    await page.goto(`${base}/index.html?debug`);
    await waitForFirstMap(page);
    await page.click('button[data-mode="lcoe"]');
    await page.waitForFunction(() => window.__atlas && window.__atlas.matrixReady, null, { timeout: 300000 });
    console.log('base year', await page.$eval('#lcoe-time-year', el => el.textContent.trim()));
    let m = await setRange(page, 'target-cf-slider', 90);
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.9), { quietMs: 8000, after: m });
    for (const which of ['wacc', 'capex']) {
        m = await mark(page);
        await page.click(`#${which}-source-toggle button[data-mode="local"]`);
        await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.9), { quietMs: 8000, after: m });
    }
    ok = compare('Local 90% no backup vs all_nb_90', await drawn(page), runs.all_nb_90) && ok;
    m = await mark(page);
    await page.evaluate(() => { const el = document.getElementById('diesel-backup-toggle'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitDrawn(page, 'lcoe', i => near(i.targetCf, 0.9), { quietMs: 8000, after: m });
    ok = compare('Local 90% with backup vs all_bk_90', await drawn(page), runs.all_bk_90) && ok;
} finally {
    await browser.close();
    server.close();
}
if (errors.length) { console.log(`page errors:\n${errors.join('\n')}`); process.exit(1); }
console.log(ok ? 'PASS app rows match the T089 dump' : 'FAIL');
process.exit(ok ? 0 : 1);
