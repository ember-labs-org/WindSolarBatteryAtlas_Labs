// t089_model.js – runs in the pinned Chromium (served by run.mjs). Uses model.js's own
// loaders, parameters and lookups and the main app's LCOE worker, as the article does,
// and returns per-cell rows for the T089 sections:
//   - the cheapest build overall (S+W+B) and the cheapest build without wind (S+B: onshore
//     switched off with the tech filter, offshore with includeOffshore=false), 2026, Local costs;
//   - the same with the app's backup on (app.js lcoeParams: diesel 300 $/kW, 35%, 20 yr; gas
//     OCGT 800 $/kW, 35%, 25 yr; local diesel 2025 else 2024 price, local IGU 2024 gas price),
//     exactly the lookups app.js serializeDieselMap / serializeGasMap send.
import * as M from '/__article_tools/model.js';

const WORKER_URL = '/js/workers/lcoe-worker.js';
const TECH_ONSHORE = 4;   // addon.js TECH_ONSHORE

// app.js lcoeParams backup defaults (verified verbatim by run.mjs against app.js).
export const BACKUP_PARAMS = {
    dieselCapex: 300, dieselEfficiency: 0.35, dieselLife: 20, dieselPrice: 1.20, dieselPriceMode: 'local',
    gasCapex: 800, gasEfficiency: 0.35, gasLife: 25, gasPrice: 4.88, gasPriceMode: 'local'
};

function client() {
    const w = new Worker(WORKER_URL, { type: 'module' });
    let seq = 0;
    const pending = new Map();
    w.onmessage = (e) => {
        const { type, requestId, payload } = e.data || {};
        const job = pending.get(requestId);
        if (!job || type === 'PROGRESS') return;
        pending.delete(requestId);
        if (type === 'RESULT') job.resolve(payload); else job.reject(new Error(payload?.message || 'worker error'));
    };
    w.onerror = (e) => { e.preventDefault?.(); pending.forEach(j => j.reject(new Error(e.message))); pending.clear(); };
    return {
        post(type, payload, transfer = []) {
            const requestId = ++seq;
            return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); w.postMessage({ type, requestId, payload }, transfer); });
        },
        terminate() { w.terminate(); }
    };
}

async function csvRows(file) {
    const r = await fetch('/data/' + file);
    if (!r.ok) throw new Error(file);
    const { head, rows } = M.parseCsv(await r.text());
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const optNum = (s) => (s === '' || s == null ? null : (Number.isFinite(Number(s)) ? Number(s) : null));

/** app.js ensureDieselDataLoaded + serializeDieselMap, ensureGasDataLoaded + serializeGasMap. */
async function backupLookups() {
    const diesel = {}, gas = {};
    for (const r of await csvRows('voronoi_diesel_prices.csv')) {
        const id = Number(r.location_id);
        if (!Number.isFinite(id)) continue;
        const p25 = optNum(r.diesel_2025_usd_per_liter_avg), p24 = optNum(r.diesel_2024_usd_per_liter_avg);
        const price = p25 ?? p24;
        const use25 = p25 !== null;
        diesel[id] = { price, rawPrice: Number.isFinite(price) ? price : null, sourceYear: use25 ? 2025 : p24 !== null ? 2024 : null,
            sourceType: (use25 ? r.diesel_2025_source : r.diesel_2024_source) || null, sourceDistanceKm: null,
            sourceIso3: (use25 ? r.diesel_2025_iso3 : r.diesel_2024_iso3) || null, sourceCountry: null, sourceSeriesName: null };
    }
    for (const r of await csvRows('voronoi_gas_prices.csv')) {
        const id = Number(r.location_id);
        if (!Number.isFinite(id)) continue;
        const price = optNum(r.gas_2024_usd_per_mmbtu);
        const avail = String(r.gas_available).trim().toLowerCase() === 'true';
        gas[id] = { available: avail && Number.isFinite(price), price, rawPrice: Number.isFinite(price) ? price : null,
            sourceType: r.gas_2024_source || null, sourceDistanceKm: null, sourceIso3: r.gas_2024_iso3 || null, sourceCountry: null };
    }
    return { dieselByLocation: diesel, gasByLocation: gas };
}

// annual_energy_mwh (T095): the build's own delivered energy after degradation (the full load with backup), so the
// cost per MWh of the full load is lcoe x annual_energy_mwh / (8760 x 1000).
const KEEP = ['location_id', 'lcoe', 'meetsTarget', 'annual_cf', 'annual_energy_mwh', 'solar_gw', 'wind_gw', 'wind_on_gw', 'wind_off_gw', 'batt_gwh',
    'wind_surface', 'noWindLcoe', 'noWindMeetsTarget', 'windSaving', 'noWindSolar', 'noWindBatt',
    'backup_share_cf', 'backup_fuel', 'backup_lcoe_adder', 'gas_available', 'gas_price_usd_per_mmbtu', 'diesel_price_usd_per_liter'];

function rowsOf(reply) {
    const out = {};
    if (reply.columns) {
        const { n, keys, cols } = reply.columns;
        for (const k of KEEP) {
            const j = keys.indexOf(k);
            if (j < 0) continue;
            const c = cols[j];
            out[k] = Array.from({ length: n }, (_, i) => (c.tag && c.tag[i] ? c.dict[c.num[i]] : c.num[i]));
        }
    } else {
        for (const k of KEEP) out[k] = reply.rows.map(r => r[k]);
    }
    for (const k of Object.keys(out)) out[k] = out[k].map(v => (typeof v === 'number' && !Number.isFinite(v) ? null : v));
    return out;
}

export async function run({ targets, backupTargets, years = [], yearTargets = [], yearBackupTargets = [] }) {
    const cells = await M.loadCells();
    const costs = await M.loadLocalCosts();
    const manifest = await (await fetch('/data/configs.json')).json();
    const configs = manifest.configs.map(({ i, summary, solar, wind, batt, surface }) => ({ i, summary, solar, wind, batt, surface }));
    const c = client();
    const ids = Int32Array.from(cells.ids);
    const loaded = await c.post('LOAD_MATRIX', { configs, locationIds: ids.buffer,
        addon: { manifest: M.ADDON_REQUEST.manifest, sets: [...M.ADDON_REQUEST.sets] } }, [ids.buffer]);
    if (JSON.stringify(loaded?.addon) !== JSON.stringify(M.ADDON_REQUEST.sets)) throw new Error('add-on not loaded');
    const look = { ...M.localLookups(costs, M.BASE_YEAR), ...(await backupLookups()) };
    await c.post('SET_LOOKUPS', look);
    const mult = M.costMultipliers(M.BASE_YEAR);
    const out = { cells: { ids: Array.from(cells.ids), lat: Array.from(cells.lat), lon: Array.from(cells.lon), pop: Array.from(cells.pop),
        demand: Array.from(cells.demand), mapCell: Array.from(cells.mapCell), country: cells.country,
        consOnTwh: Array.from(cells.consOnTwh), consFixTwh: Array.from(cells.consFixTwh), consFlTwh: Array.from(cells.consFlTwh),
        techOnTwh: Array.from(cells.techOnTwh), ieaFixTwh: Array.from(cells.ieaFixTwh), ieaFlTwh: Array.from(cells.ieaFlTwh) },
        params: { ...M.LCOE_PARAMS, ...BACKUP_PARAMS }, runs: {} };
    const jobs = [];
    for (const T of targets) for (const backup of [false]) jobs.push({ T, backup });
    for (const T of backupTargets) jobs.push({ T, backup: true });
    for (const { T, backup } of jobs) {
        for (const sb of [false, true]) {
            const params = { ...M.LCOE_PARAMS, ...BACKUP_PARAMS, includeDieselBackup: backup, targetCf: T / 100,
                includeOffshore: !sb, techOff: sb ? TECH_ONSHORE : 0 };
            const reply = await c.post('COMPUTE_BEST_LCOE', { targetCf: T / 100, params, costMultipliers: mult });
            out.runs[`${sb ? 'sb' : 'all'}_${backup ? 'bk' : 'nb'}_${T}`] = rowsOf(reply);
        }
    }
    // T087 (optional): the cheapest build at later cost years, Local costs (model.js localLookups and
    // costMultipliers for that year, as the article's year searches), for the story's 2026-2050 map.
    for (const Y of years) {
        await c.post('SET_LOOKUPS', { ...M.localLookups(costs, Y), ...(await backupLookups()) });
        for (const T of yearTargets) {
            for (const sb of [false, true]) {
                const params = { ...M.LCOE_PARAMS, ...BACKUP_PARAMS, includeDieselBackup: false, targetCf: T / 100,
                    includeOffshore: !sb, techOff: sb ? TECH_ONSHORE : 0 };
                const reply = await c.post('COMPUTE_BEST_LCOE', { targetCf: T / 100, params, costMultipliers: M.costMultipliers(Y) });
                out.runs[`${sb ? 'sb' : 'all'}_y${Y}_${T}`] = rowsOf(reply);
            }
        }
        // T100 (the human, 9 Nov 2026: "the 90% case" to 2050): the cheapest build for T% uptime with the app's diesel or
        // gas backup for the rest, at cost year Y (backup costs and fuel prices as the base year: the app has no paths for them)
        for (const T of yearBackupTargets) {
            for (const sb of [false, true]) {
                const params = { ...M.LCOE_PARAMS, ...BACKUP_PARAMS, includeDieselBackup: true, targetCf: T / 100,
                    includeOffshore: !sb, techOff: sb ? TECH_ONSHORE : 0 };
                const reply = await c.post('COMPUTE_BEST_LCOE', { targetCf: T / 100, params, costMultipliers: M.costMultipliers(Y) });
                out.runs[`${sb ? 'sb' : 'all'}_ybk${Y}_${T}`] = rowsOf(reply);
            }
        }
    }
    if (years.length) await c.post('SET_LOOKUPS', look);
    // Global costs (app Capex Global + WACC Global: no local maps), for reconciling with the
    // solar atlas's planned-capacity figure, which used Global costs.
    await c.post('SET_LOOKUPS', { waccByLocation: null, windWaccByLocation: null, localCapexByLocation: null,
        dieselByLocation: look.dieselByLocation, gasByLocation: look.gasByLocation });
    for (const T of [80, 90]) {
        for (const sb of [false, true]) {
            const params = { ...M.LCOE_PARAMS, ...BACKUP_PARAMS, includeDieselBackup: false, targetCf: T / 100,
                includeOffshore: !sb, techOff: sb ? TECH_ONSHORE : 0 };
            const reply = await c.post('COMPUTE_BEST_LCOE', { targetCf: T / 100, params, costMultipliers: mult });
            out.runs[`${sb ? 'sb' : 'all'}_glob_${T}`] = rowsOf(reply);
        }
    }
    c.terminate();
    return out;
}

/**
 * T091 cost-of-capital lens (the human, 5 Nov 2026): the article runs on Capex Local + WACC Global (one 7% cost of
 * capital everywhere, model.js COST_MODE). This runs the cheapest build at `targets` in the atlas's full Local mode
 * (each region's own cost of capital, model.js localModeLookups), everything else as the article. Control first: the
 * article's own mode (`all_nb_<T>`, `sb_nb_<T>`), which the caller checks against story-cells.json.
 */
export async function runLocalWacc({ targets }) {
    const cells = await M.loadCells();
    const costs = await M.loadLocalCosts();
    const manifest = await (await fetch('/data/configs.json')).json();
    const configs = manifest.configs.map(({ i, summary, solar, wind, batt, surface }) => ({ i, summary, solar, wind, batt, surface }));
    const c = client();
    const ids = Int32Array.from(cells.ids);
    const loaded = await c.post('LOAD_MATRIX', { configs, locationIds: ids.buffer,
        addon: { manifest: M.ADDON_REQUEST.manifest, sets: [...M.ADDON_REQUEST.sets] } }, [ids.buffer]);
    if (JSON.stringify(loaded?.addon) !== JSON.stringify(M.ADDON_REQUEST.sets)) throw new Error('add-on not loaded');
    const backup = await backupLookups();
    const mult = M.costMultipliers(M.BASE_YEAR);
    const out = { cells: { ids: Array.from(cells.ids) }, wacc: M.LCOE_PARAMS.wacc, runs: {} };
    for (const [tag, lookups] of [['nb', { ...M.localLookups(costs, M.BASE_YEAR), ...backup }], ['lw', { ...M.localModeLookups(costs, M.BASE_YEAR), ...backup }]]) {
        await c.post('SET_LOOKUPS', lookups);
        for (const T of targets) {
            for (const sb of [false, true]) {
                const params = { ...M.LCOE_PARAMS, ...BACKUP_PARAMS, includeDieselBackup: false, targetCf: T / 100,
                    includeOffshore: !sb, techOff: sb ? TECH_ONSHORE : 0 };
                const reply = await c.post('COMPUTE_BEST_LCOE', { targetCf: T / 100, params, costMultipliers: mult });
                out.runs[`${sb ? 'sb' : 'all'}_${tag}_${T}`] = rowsOf(reply);
            }
        }
    }
    c.terminate();
    return out;
}
