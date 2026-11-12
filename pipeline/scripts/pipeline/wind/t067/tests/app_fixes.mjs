// T067 tests for fixes 4-6 (app). Run from the repo root: node pipeline/scripts/pipeline/wind/t067/tests/app_fixes.mjs
// 4: cost year is a constant 2026, both modes anchor at it, the legend states it.
// 5: worker and main thread compare against Math.fround(target); a float32 0.9 build meets 90%.
// 6: the "cells missing from the local cost files" count equals the data (summary ids not in local capex).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const app = fs.readFileSync('deployment/js/app.js', 'utf8');
const worker = fs.readFileSync('deployment/js/workers/lcoe-worker.js', 'utf8');
const html = fs.readFileSync('deployment/index.html', 'utf8');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };

// 4
ok(!/getFullYear\(\)/.test(app), 'app.js never reads the visitor clock for the cost year');
ok(/const COST_BASE_YEAR = 2026;/.test(app), 'COST_BASE_YEAR = 2026');
ok(/const baseYear = COST_BASE_YEAR;/.test(app) && /let lcoeTimeYear = COST_BASE_YEAR;/.test(app), 'Global anchors and default year use it');
const src = app.match(/function interpolateLocalCapex\(year, values\) \{[\s\S]*?\n\}/)[0];
const interp = new Function('LOCAL_ANCHOR_YEARS', `${src}; return interpolateLocalCapex;`)([2026, 2035, 2050]);
ok(interp(2026, [690, 380, 300]) === 690, 'Local 2026 = the file value (no 2024->2026 decline)');
ok(Math.abs(interp(2035, [690, 380, 300]) - 380) < 1e-9 && Math.abs(interp(2030, [690, 380, 300]) - (690 - 310 * 4 / 9)) < 1e-9,
   'Local declines linearly 2026 -> 2035 like Global');
// Global factor path for solar: 1.0 in 2026, 0.61 in 2035 -> same shape
ok(/function legendCostYear\(info\)/.test(app) && (app.match(/\+ legendCostYear\(info\)/g) || []).length === 2,
   'both LCOE legends state the cost year on the reference line ("· 2026 costs")');

// 5
ok(/const tieCf = Math\.fround\(targetCf\);/.test(worker) && /annualCf >= tieCf/.test(worker)
   && /addonPassTarget\(STATE\.addon, li, pre, Math\.fround\(targetCf\)/.test(worker), 'worker compares against Math.fround(target), add-on too');
ok(/const tieCf = Math\.fround\(targetCf\);/.test(app) && /annualCf >= tieCf/.test(app)
   && /addonPassTarget\(m\.addon, li, pre, Math\.fround\(targetCf\)/.test(app), 'main thread the same');
ok(!/annualCf >= targetCf/.test(app + worker), 'no raw-target comparison left in app.js or the worker');
const cf = new Float32Array([0.9, 0.95, 0.8, 0.99]);
ok(cf[0] < 0.9 && cf[0] >= Math.fround(0.9), 'float32 0.9 is below the double 0.9 but meets Math.fround(0.9)');
ok([0.9, 0.95, 0.8, 0.99].every((t, i) => cf[i] >= Math.fround(t)), 'every exact-target float32 CF meets its target');

// 6
const py = `
import duckdb, csv
ids = {r[0] for r in duckdb.sql("select distinct location_id from 'deployment/data/summary_w0.parquet'").fetchall()}
cap = {int(r['location_id']) for r in csv.DictReader(open('deployment/data/voronoi_local_capex.csv'))}
print(len(ids - cap))`;
const missing = Number(execFileSync('python3', ['-I', '-c', py]).toString().trim());
const shown = Number(html.match(/<span id="missing-cost-cells">(\d+)<\/span>/)?.[1]);
ok(missing === 66 && shown === missing, `info text count ${shown} = data ${missing}`);
ok(/function updateMissingCostCellsNote\(\)/.test(app), 'count re-derived from the loaded data at run time');
console.log(fails ? `FAIL ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
