// T058: evaluate the app's own LCOE functions (deployment/js/workers/lcoe-worker.js)
// on rows read from stdin (JSON). Each row carries its own scenario: params
// (model.js LCOE_PARAMS, optionally with backup on), a timeline year, and local
// WACC / wind WACC / local capex / diesel / gas lookups, or none.
// Single-surface rows use the worker's computeLcoeMetrics. Rows with both wind
// surfaces use comboLcoe below: the specification the add-on module must meet
// (the worker's own expressions with the wind terms summed and a three-source
// degradation blend). Used by check_cost.py.
// Usage: node check_cost_vs_js.mjs <repo> < rows.json
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const repo = process.argv[2];
const src = readFileSync(`${repo}/deployment/js/workers/lcoe-worker.js`, 'utf8');
// Only the pure cost functions: everything from the top of the file up to the
// matrix search (which needs import.meta and a Worker).
const body = src.slice(src.indexOf('const BASE_LOAD_MW'), src.indexOf('function sortByLocationId'));
const api = new Function(`${body}; return { precomputeLcoePerLocation, computeLcoeMetrics };`)();
const model = await import(pathToFileURL(`${repo}/scripts/article/tools/model.js`).href);

const BACKUP = { includeDieselBackup: true, dieselCapex: 300, dieselEfficiency: 0.35, dieselLife: 20,
    dieselPrice: 1.20, dieselPriceMode: 'local', gasCapex: 800, gasEfficiency: 0.35, gasLife: 25,
    gasPrice: 4.88, gasPriceMode: 'local' };

function comboLcoe(row, pre) {
    const solarKw = row.solar_gw * 1_000_000, batteryKwh = row.batt_gwh * 1_000_000;
    const onKw = row.wind_on_gw * 1_000_000, offKw = row.wind_off_gw * 1_000_000;
    const cf = Math.max(0, Math.min(1, Number.isFinite(row.annual_cf) ? row.annual_cf : 0));
    const solarCapex = pre.solarCapexPerKw * solarKw;
    const batteryCapex = pre.batteryCapexBase * batteryKwh;
    const onCapex = pre.windOnCapexBase * onKw, offCapex = pre.windOffCapexBase * offKw;
    let annualCost = solarCapex * pre.solarCrf + batteryCapex * pre.batteryCrf
        + (onCapex * pre.windOnCrf + offCapex * pre.windOffCrf)
        + solarCapex * pre.solarOpexPct + batteryCapex * pre.batteryOpexPct
        + (onCapex * pre.windOpexPct + offCapex * pre.windOffOpexPct);
    let energy = cf * 8760 * 1000;
    let s = solarKw * pre.solarUnitCf, a = onKw * pre.windOnUnitCf, o = offKw * pre.windOffUnitCf;
    if (!(s + a + o > 0)) { s = solarKw; a = onKw; o = offKw; }
    energy *= (s * pre.energyDegradationMult + a * pre.windOnDegradationMult + o * pre.windOffDegradationMult) / (s + a + o);
    if (pre.includeDieselBackup) {
        // the renewables deliver their degraded energy; the backup serves the rest of the full load
        const full = 8760 * 1000;
        const backup = Math.max(0, full - energy);
        energy = full;
        const d = Number.isFinite(pre.dieselFuelCostPerMwh) ? pre.dieselCapexAnnual + backup * pre.dieselFuelCostPerMwh : Infinity;
        const g = pre.gasAvailable && Number.isFinite(pre.gasFuelCostPerMwh) ? pre.gasCapexAnnual + backup * pre.gasFuelCostPerMwh : Infinity;
        const b = g < d ? g : d;
        if (!Number.isFinite(b)) return Infinity;
        annualCost += b;
    }
    if (!Number.isFinite(energy) || energy <= 0) return Infinity;
    return annualCost / energy;
}

const rows = JSON.parse(readFileSync(0, 'utf8'));
const out = rows.map((r) => {
    const params = { ...model.LCOE_PARAMS, ...(r.backup ? BACKUP : {}), ...(r.paramsOverride || {}) };
    const mult = model.costMultipliers(r.year);
    const pre = api.precomputeLcoePerLocation(params, mult, r.localWacc ?? null, r.localCapex ?? null,
        r.diesel ?? null, r.gas ?? null, r.windWacc ?? null, { solar: r.ucf_s, on: r.ucf_on, off: r.ucf_off });
    if (r.wind_on_gw > 0 && r.wind_off_gw > 0) return comboLcoe(r, pre);
    const surface = r.wind_off_gw > 0 ? 'off' : 'on';
    const row = { solar_gw: r.solar_gw, wind_gw: r.wind_on_gw + r.wind_off_gw, batt_gwh: r.batt_gwh,
        annual_cf: r.annual_cf, wind_surface: surface };
    return api.computeLcoeMetrics(row, pre).lcoe;
});
process.stdout.write(JSON.stringify({ params: model.LCOE_PARAMS, mult2035: model.costMultipliers(2035),
    out: out.map(v => (Number.isFinite(v) ? v : null)) }));
