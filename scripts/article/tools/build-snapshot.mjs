// The committed analysis values for "Harnessing the Winds": every number the
// article shows, read from the analysis outputs (scripts/article/out, T040,
// audited) and the committed external extracts (./data), each with the row it
// comes from. Used by build-summary.mjs (for the values the model cannot
// compute: Ember monthly data, IRENA learning rates, Ember world demand, the
// Local-cost sensitivity) and by verify-article.mjs (the model's values must
// match these within the analysis's rounding). Run from the repo root to list
// them:
//
//   node scripts/article/tools/build-snapshot.mjs [--out <file.json>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, 'scripts/article/out');
const INPUTS = path.join(ROOT, 'scripts/article/inputs');
const LOCAL_DATA = path.resolve(HERE, 'data');

// Minimal RFC 4180 reader (quoted fields may hold commas).
export function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
            } else field += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
        } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const head = rows.shift();
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const read = (dir, file) => parseCsv(fs.readFileSync(path.join(dir, file), 'utf8'));
const num = (s) => (s === '' || s == null ? null : Number(s));

const values = {};
function put(key, v, src) {
    if (key in values) throw new Error(`duplicate key ${key}`);
    if (v === null || v === undefined || Number.isNaN(v)) throw new Error(`no value for ${key} (${src})`);
    values[key] = { v, src };
}

export const TARGETS = [50, 60, 70, 75, 80, 85, 90, 95];
export const WEIGHTS = ['cells', 'people', 'demand'];
export const YEARS = [2026, 2030, 2035, 2040, 2050];
export const BANDS = {
    s90_45: '90°S to 45°S', s45_30: '45°S to 30°S', s30_15: '30°S to 15°S', s15_0: '15°S to 0°',
    n0_15: '0° to 15°N', n15_30: '15°N to 30°N', n30_45: '30°N to 45°N', n45_55: '45°N to 55°N',
    n55_65: '55°N to 65°N', n65_90: '65°N to 90°N', n45p: '45°N and north', n50p: '50°N and north',
    n55p: '55°N and north', world: 'World'
};
export const COUNTRIES = {
    UK: 'United Kingdom', DE: 'Germany', US: 'United States of America', ES: 'Spain',
    PL: 'Poland', NL: 'Netherlands', SE: 'Sweden'
};

export function build() {
    for (const k of Object.keys(values)) delete values[k];
    // ---- Take 1: take1_by_target.csv -------------------------------------
    const t1 = read(OUT, 'take1_by_target.csv');
    const cols = {
        cheaper: 'share_wind_cheaper', only: 'share_wind_only', noGain: 'share_no_gain', sbReach: 'share_met_solar_battery_only',
        sbStd: 'share_met_solar_battery_only_standard',
        sbBoth: 'median_lcoe_solar_battery_only_both_reach', windBoth: 'median_lcoe_with_wind_both_reach',
        cut: 'median_cut_both_reach', saving: 'median_saving_usd_mwh_where_cheaper',
        savingPct: 'median_saving_pct_where_cheaper'
    };
    // Onshore only: the page searches it at 80% and 90% (take 1 text, take 4).
    for (const [surf, prefix, targets] of [['onshore+offshore', 't1', TARGETS], ['onshore only', 't1on', [80, 90]]]) {
        for (const T of targets) {
            for (const W of WEIGHTS) {
                const r = t1.find(x => x.surfaces === surf && x.weight === W && Number(x.target_cf) === T);
                if (!r) throw new Error(`take1 row ${surf} ${W} ${T}`);
                for (const [k, c] of Object.entries(cols)) {
                    put(`${prefix}.${k}.${W}.${T}`, num(r[c]), `take1_by_target.csv surfaces=${surf} weight=${W} target_cf=${T} ${c}`);
                }
            }
        }
    }
    // T058 headline candidates (model.js headlineValues), people and demand at 80, 90 and 99%.
    const hwCols = { lower: 'share_wind_cheaper', lower15: 'share_wind_cheaper_by_15', windOnly: 'share_wind_only',
        lowerStd: 'share_wind_cheaper_than_standard', lower15Std: 'share_wind_cheaper_than_standard_by_15',
        medSaving: 'median_saving_usd_mwh_where_cheaper' };
    for (const T of [80, 90, 99]) {
        for (const W of ['people', 'demand']) {
            const r = t1.find(x => x.surfaces === 'onshore+offshore' && x.weight === W && Number(x.target_cf) === T);
            if (!r) throw new Error(`take1 row ${W} ${T}`);
            for (const [k, c] of Object.entries(hwCols)) put(`hw.${k}.${W}.${T}`, num(r[c]), `take1_by_target.csv surfaces=onshore+offshore weight=${W} target_cf=${T} ${c}`);
        }
    }
    for (const W of WEIGHTS) {
        const r = t1.find(x => x.surfaces === 'onshore+offshore' && x.weight === W && x.target_cf === '90');
        // Key names kept from before T059: weak wind (T063, W1: the windiest fifth of eligible land
        // and sea below WEAK_WIND_CF, model.js / analyse.py).
        put(`t1.noViable.${W}`, num(r.share_wind_weak), `take1_by_target.csv weight=${W} share_wind_weak`);
    }
    const nv = read(OUT, 'take1_weak_wind.csv');
    const nvIndia = nv.find(r => r.country === 'India');
    put('nv.India.cells', num(nvIndia.cells), 'take1_weak_wind.csv India cells');
    put('nv.India.speed', num(nvIndia.median_on_site_speed_100m), 'take1_weak_wind.csv India median_on_site_speed_100m');
    put('nv.India.cf', num(nvIndia.median_on_cf_p50), 'take1_weak_wind.csv India median_on_cf_p50');

    // ---- Take 2: take2_potential.csv, take2_by_lat.csv ---------------------
    const t2 = read(OUT, 'take2_potential.csv');
    const item = (name) => {
        const r = t2.find(x => x.item === name);
        if (!r) throw new Error(`take2 item ${name}`);
        return r;
    };
    const P = {
        on5: item('Onshore wind, 5 MW/km2 (default)'),
        on3p50: item('Onshore wind, 3 MW/km2, median-site CF'),
        offFixed: item('Offshore wind, fixed-bottom (ESMAP)'),
        offFixedP50: item('Offshore wind, fixed-bottom, median-site CF'),
        offFloat: item('Offshore wind, floating (ESMAP, not costed)'),
        solar: item('Solar PV, technical (Global Solar Atlas level 1)'),
        demand: item('Atlas electricity demand (Chen et al. 2022)')
    };
    for (const [k, r] of Object.entries(P)) {
        if (r.gw !== '') put(`t2.${k}.gw`, num(r.gw), `take2_potential.csv "${r.item}" gw`);
        put(`t2.${k}.twh`, num(r.twh_per_year), `take2_potential.csv "${r.item}" twh_per_year`);
    }
    const t2l = read(OUT, 'take2_by_lat.csv');
    for (const [id, band] of Object.entries({ world: 'World', n45p: '45°N and north', s15_0: '15°S to 0°', n0_15: '0° to 15°N' })) {
        const r = t2l.find(x => x.band === band);
        put(`t2.cover.${id}`, num(r.share_people_local_wind_covers_demand), `take2_by_lat.csv band=${band} share_people_local_wind_covers_demand`);
        put(`t2.coverLow.${id}`, num(r.share_people_local_wind_covers_demand_low), `take2_by_lat.csv band=${band} share_people_local_wind_covers_demand_low`);
    }

    // ---- External figures (futures, transcribed by T040) -------------------
    const ext = read(INPUTS, 'external_figures.csv');
    const extV = (where) => {
        const r = ext.find(where);
        if (!r) throw new Error('external figure missing');
        return r;
    };
    const d25 = extV(r => r.item === 'electricity_demand' && r.period === '2025');
    put('ext.demand2025', num(d25.value), 'external_figures.csv SRC-EMBER-YEARLY-2026 electricity_demand World 2025');
    // T100: wind and solar's share of world generation in 2025, as Ember published it (the close: 'less than a fifth')
    put('ext.windSolarShare2025', num(extV(r => r.item === 'wind_solar_share_of_generation' && r.period === '2025').value), 'external_figures.csv SRC-EMBER-GER-2026 Global Electricity Review 2026: wind and solar 17.3% of world generation, 2025');
    // T086 (D-154 light D): onshore potential without dense forest (tree cover >= 50%) and cropland, Copernicus
    // CGLS-LC100 2019, a sensitivity on the map cells; 'today' must equal the model's own onshore cases (verify-article).
    {
        const dir = path.join(ROOT, 'pipeline/scripts/pipeline/wind/t086/results');
        const lc = read(dir, 'world.csv');
        for (const c of ['cons', 'tech']) for (const [variant, k] of [['a', 'today'], ['d', 'both']]) {
            const r = lc.find(x => x.case === c && x.variant === variant);
            if (!r) throw new Error(`t086 world.csv: no row ${c}/${variant}`);
            put(`ext.t086.${c}.${k}.twh`, num(r.twh), `pipeline/scripts/pipeline/wind/t086/results/world.csv case=${c} variant=${variant} (${r.label}) twh`);
        }
    }
    for (const [tech, regions] of [['onshore_wind', ['Global', 'Europe', 'United States', 'India', 'Brazil', 'China']], ['solar_pv', ['Global']]]) {
        for (const region of regions) {
            const r = extV(x => x.item === 'learning_rate_tic' && x.technology === tech && x.region === region);
            put(`ext.lr.${tech}.${region}`, num(r.value), `external_figures.csv SRC-IRENA-RPGC-2025 fig B1.1 learning_rate_tic ${tech} ${region}`);
        }
    }
    for (const tech of ['onshore_wind', 'offshore_wind', 'solar_pv']) {
        for (const yr of ['2010', '2025']) {
            const r = extV(x => x.item === 'lcoe_global_weighted_average' && x.technology === tech && x.period === yr);
            put(`ext.lcoe.${tech}.${yr}`, num(r.value), `external_figures.csv SRC-IRENA-RPGC-2025 fig S2 ${tech} ${yr}`);
        }
    }
    for (const tech of ['onshore_wind', 'solar_pv']) {
        for (const per of ['2010-2025', '2026-2035']) {
            const r = extV(x => x.item === 'tic_cumulative_reduction' && x.technology === tech && x.period === per);
            put(`ext.tic.${tech}.${per}`, num(r.value), `external_figures.csv SRC-IRENA-RPGC-2025 fig S4 ${tech} ${per}`);
        }
    }

    // ---- Take 3: Ember monthly extracts (committed beside the page) --------
    const de = read(LOCAL_DATA, 'ember_monthly_germany_2023_2025.csv');
    for (const r of de) {
        put(`t3.de.solar.${r.month}`, num(r.solar_share), `tools/data/ember_monthly_germany_2023_2025.csv month=${r.month} solar_share`);
        put(`t3.de.wind.${r.month}`, num(r.wind_share), `tools/data/ember_monthly_germany_2023_2025.csv month=${r.month} wind_share`);
    }
    // Nine European countries, take 3's small multiples (ember_monthly.sql query 4, T077),
    // with each source's November–February share computed from the same months.
    const eu9 = read(LOCAL_DATA, 'ember_monthly_europe9_2023_2025.csv');
    const e9 = { Germany: 'DE', 'United Kingdom': 'UK', France: 'FR', Spain: 'ES', Italy: 'IT', Poland: 'PL', Netherlands: 'NL', Sweden: 'SE', Denmark: 'DK' };
    for (const r of eu9) {
        const id = e9[r.area];
        put(`t3m.${id}.solar.${r.month}`, num(r.solar_share), `tools/data/ember_monthly_europe9_2023_2025.csv ${r.area} month=${r.month} solar_share`);
        put(`t3m.${id}.wind.${r.month}`, num(r.wind_share), `tools/data/ember_monthly_europe9_2023_2025.csv ${r.area} month=${r.month} wind_share`);
    }
    for (const [area, id] of Object.entries(e9)) {
        const nf = (col) => eu9.filter(r => r.area === area && [11, 12, 1, 2].includes(Number(r.month))).reduce((s, r) => s + num(r[col]), 0);
        put(`t3m.${id}.solarNF`, nf('solar_share'), `tools/data/ember_monthly_europe9_2023_2025.csv ${area} sum of solar_share, months 11, 12, 1, 2`);
        put(`t3m.${id}.windNF`, nf('wind_share'), `tools/data/ember_monthly_europe9_2023_2025.csv ${area} sum of wind_share, months 11, 12, 1, 2`);
    }
    const comp = read(LOCAL_DATA, 'ember_monthly_complement_2023_2025.csv');
    const cc = { Germany: 'DE', 'United Kingdom': 'UK', France: 'FR', Poland: 'PL', Japan: 'JP', 'United States of America': 'US', China: 'CN', India: 'IN' };
    for (const r of comp) {
        const id = cc[r.area];
        put(`t3.${id}.corr`, num(r.corr_monthly), `tools/data/ember_monthly_complement_2023_2025.csv ${r.area} corr_monthly`);
        put(`t3.${id}.solarNF`, num(r.solar_nov_feb_pct) / 100, `tools/data/ember_monthly_complement_2023_2025.csv ${r.area} solar_nov_feb_pct`);
        put(`t3.${id}.windNF`, num(r.wind_nov_feb_pct) / 100, `tools/data/ember_monthly_complement_2023_2025.csv ${r.area} wind_nov_feb_pct`);
    }
    // Counts by Ember region (ember_monthly.sql query 3).
    const counts = read(LOCAL_DATA, 'ember_monthly_counts_by_region_2023_2025.csv');
    const all = counts.find(r => r.ember_region === '(all)'), eu = counts.find(r => r.ember_region === 'Europe');
    put('t3.nBoth', num(all.with_both_series), 'tools/data/ember_monthly_counts_by_region_2023_2025.csv (all) with_both_series');
    put('t3.nNeg', num(all.negative), 'tools/data/ember_monthly_counts_by_region_2023_2025.csv (all) negative');
    put('t3.nEurope', num(eu.with_both_series), 'tools/data/ember_monthly_counts_by_region_2023_2025.csv Europe with_both_series');

    // ---- Take 4: take4_by_lat.csv (people), take4_countries.csv ------------
    const t4 = read(OUT, 'take4_by_lat.csv');
    const c4 = {
        sbReach: 'share_people_met_solar_battery_only', withWind: 'share_people_met_with_wind',
        sbBoth: 'median_lcoe_solar_battery_only_both_reach', windBoth: 'median_lcoe_with_wind_both_reach',
        cut: 'median_cut_both_reach', medWind: 'median_lcoe_with_wind', medWindOn: 'median_lcoe_with_onshore_wind_only'
    };
    for (const T of [80, 90]) {
        for (const [id, band] of Object.entries(BANDS)) {
            const r = t4.find(x => x.band === band && Number(x.target_cf) === T);
            if (!r) throw new Error(`take4 ${band} ${T}`);
            for (const [k, c] of Object.entries(c4)) {
                const v = num(r[c]);
                if (v === null) continue; // not compared (blank in the analysis)
                put(`t4.${k}.${id}.${T}`, v, `take4_by_lat.csv band=${band} target_cf=${T} ${c}`);
            }
            if (T === 80) put(`t4.people.${id}`, num(r.people_m), `take4_by_lat.csv band=${band} people_m`);
            put(`t4.sbStd.${id}.${T}`, num(r.share_people_met_solar_battery_only_standard), `take4_by_lat.csv band=${band} target_cf=${T} share_people_met_solar_battery_only_standard`);
            if (id === 'n50p') {
                // T058: where the no-wind build is a large add-on build (regions, not people)
                put(`t4.lgWins.${id}.${T}`, num(r.regions_nowind_large), `take4_by_lat.csv band=${band} target_cf=${T} regions_nowind_large`);
                put(`t4.lgRegions.${id}.${T}`, num(r.cells), `take4_by_lat.csv band=${band} target_cf=${T} cells`);
                put(`t4.lgSolar.${id}.${T}`, num(r.median_solar_nowind_large), `take4_by_lat.csv band=${band} target_cf=${T} median_solar_nowind_large`);
                put(`t4.lgBatt.${id}.${T}`, num(r.median_batt_nowind_large), `take4_by_lat.csv band=${band} target_cf=${T} median_batt_nowind_large`);
            }
        }
    }
    const t4c = read(OUT, 'take4_countries.csv');
    for (const [id, name] of Object.entries(COUNTRIES)) {
        const r = t4c.find(x => x.country === name);
        put(`t4c.${id}.medWind.90`, num(r.t90_median_lcoe_with_wind), `take4_countries.csv ${name} t90_median_lcoe_with_wind`);
        put(`t4c.${id}.sbReach.90`, num(r.t90_share_people_met_solar_battery_only), `take4_countries.csv ${name} t90_share_people_met_solar_battery_only`);
        put(`t4c.${id}.sbReach.80`, num(r.t80_share_people_met_solar_battery_only), `take4_countries.csv ${name} t80_share_people_met_solar_battery_only`);
        const cut = num(r.t80_median_cut_both_reach);
        if (cut !== null) put(`t4c.${id}.cut.80`, cut, `take4_countries.csv ${name} t80_median_cut_both_reach`);
    }

    // ---- Take 5: take5_by_year.csv (90%) -----------------------------------
    const t5 = read(OUT, 'take5_by_year.csv');
    for (const Y of YEARS) {
        const row = (scope, weight) => t5.find(x => Number(x.year) === Y && x.target_cf === '90' && x.scope === scope && x.weight === weight);
        const d = row('world', 'demand'), p = row('world', 'people');
        const src = (scope, w, c) => `take5_by_year.csv year=${Y} target_cf=90 scope=${scope} weight=${w} ${c}`;
        put(`t5.sbBoth.demand.${Y}`, num(d.median_lcoe_solar_battery_only_both_reach), src('world', 'demand', 'median_lcoe_solar_battery_only_both_reach'));
        put(`t5.windBoth.demand.${Y}`, num(d.median_lcoe_with_wind_both_reach), src('world', 'demand', 'median_lcoe_with_wind_both_reach'));
        put(`t5.cut.demand.${Y}`, num(d.median_cut_both_reach), src('world', 'demand', 'median_cut_both_reach'));
        put(`t5.cheaper.demand.${Y}`, num(d.share_wind_cheaper), src('world', 'demand', 'share_wind_cheaper'));
        put(`t5.only.demand.${Y}`, num(d.share_wind_only), src('world', 'demand', 'share_wind_only'));
        put(`t5.sbReach.demand.${Y}`, num(d.share_met_solar_battery_only), src('world', 'demand', 'share_met_solar_battery_only'));
        put(`t5.cheaper.people.${Y}`, num(p.share_wind_cheaper), src('world', 'people', 'share_wind_cheaper'));
        put(`t5.only.people.${Y}`, num(p.share_wind_only), src('world', 'people', 'share_wind_only'));
        for (const w of ['people', 'demand']) {
            const n = row('45N and north', w);
            put(`t5.hasWind.n45p.${w}.${Y}`, num(n.share_cheapest_build_has_wind), src('45N and north', w, 'share_cheapest_build_has_wind'));
        }
    }

    // ---- Local-cost sensitivity: local_sensitivity.csv (the app's own draws)
    const ls = read(OUT, 'local_sensitivity.csv');
    const lrow = (T, scope, w) => ls.find(x => x.scenario === 'local capex + local WACC' && Number(x.target_cf) === T && x.scope === scope && x.weight === w);
    const lsrc = (T, scope, w, c) => `local_sensitivity.csv scenario=local capex + local WACC target_cf=${T} scope=${scope} weight=${w} ${c}`;
    for (const w of ['demand', 'people']) {
        const r = lrow(90, 'World', w);
        put(`loc.cheaper.${w}.90`, num(r.share_wind_cheaper), lsrc(90, 'World', w, 'share_wind_cheaper'));
        put(`loc.only.${w}.90`, num(r.share_wind_only), lsrc(90, 'World', w, 'share_wind_only'));
        put(`loc.cut.${w}.90`, num(r.median_cut_both_reach), lsrc(90, 'World', w, 'median_cut_both_reach'));
    }
    put('loc.medWind.world.people.90', num(lrow(90, 'World', 'people').median_lcoe_with_wind), lsrc(90, 'World', 'people', 'median_lcoe_with_wind'));
    put('loc.medWind.n50p.people.90', num(lrow(90, '50°N and north', 'people').median_lcoe_with_wind), lsrc(90, '50°N and north', 'people', 'median_lcoe_with_wind'));
    put('loc.cut.n45p.people.80', num(lrow(80, '45°N and north', 'people').median_cut_both_reach), lsrc(80, '45°N and north', 'people', 'median_cut_both_reach'));

    // ---- T077: the article runs on Local costs (capex and WACC Local, as the atlas's
    // Local mode). The model's cost-dependent keys (t1, t1on, t4, t4c, t5, hw) are now
    // Local values. The committed analysis of those keys is on the atlas's Global
    // defaults: it moves to glob.<key>, embedded for the methods note, and the
    // oracle for the model's Local values is local_sensitivity.csv, the real app
    // driven in Local mode (drive_app.mjs), under the model's own key names.
    const COST_DEPENDENT = /^(t1|t1on|t4|t4c|t5|hw)\./;
    for (const k of Object.keys(values)) {
        if (!COST_DEPENDENT.test(k) || k.startsWith('t1.noViable.')) continue;
        values[`glob.${k}`] = { v: values[k].v, src: `Global costs: ${values[k].src}` };
        delete values[k];
    }
    for (const k of Object.keys(values)) if (k.startsWith('loc.')) delete values[k];
    // T091: the article's cost mode, Capex Local + WACC Global (model.js COST_MODE); its oracle rows, recorded from the app
    const COST_SCENARIO = 'local capex + global WACC';
    if (!fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'model.js'), 'utf8').includes(`export const COST_SCENARIO = '${COST_SCENARIO}';`)) {
        throw new Error(`model.js COST_SCENARIO is not '${COST_SCENARIO}': the summary would mix cost modes`);
    }
    const lsAt = (Y, T, scope, w) => ls.find(x => x.scenario === COST_SCENARIO && Number(x.year) === Y && Number(x.target_cf) === T && x.scope === scope && x.weight === w);
    const both = { windBoth: 'median_lcoe_with_wind_both_reach', sbBoth: 'median_lcoe_solar_battery_only_both_reach', cut: 'median_cut_both_reach' };
    const oracle = (key, Y, T, scope, w, col) => {
        const r = lsAt(Y, T, scope, w);
        if (!r) throw new Error(`local_sensitivity ${Y} ${T} ${scope} ${w}`);
        put(key, num(r[col]), `local_sensitivity.csv scenario=${COST_SCENARIO} year=${Y} target_cf=${T} scope=${scope} weight=${w} ${col}`);
    };
    for (const T of [80, 90]) {
        for (const w of ['people', 'demand']) {
            oracle(`t1.cheaper.${w}.${T}`, 2026, T, 'World', w, 'share_wind_cheaper');
            oracle(`t1.only.${w}.${T}`, 2026, T, 'World', w, 'share_wind_only');
            oracle(`t1.sbReach.${w}.${T}`, 2026, T, 'World', w, 'share_met_solar_battery_only');
            oracle(`hw.lower.${w}.${T}`, 2026, T, 'World', w, 'share_wind_cheaper');
            for (const [k, c] of Object.entries(both)) oracle(`t1.${k}.${w}.${T}`, 2026, T, 'World', w, c);
        }
        oracle(`t4.medWind.world.${T}`, 2026, T, 'World', 'people', 'median_lcoe_with_wind');
        for (const [id, scope] of [['n45p', '45°N and north'], ['n50p', '50°N and north'], ['n30_45', '30°N to 45°N'], ['n45_55', '45°N to 55°N'], ['n55_65', '55°N to 65°N']]) {
            oracle(`t4.medWind.${id}.${T}`, 2026, T, scope, 'people', 'median_lcoe_with_wind');
            oracle(`t4.sbReach.${id}.${T}`, 2026, T, scope, 'people', 'share_met_solar_battery_only');
            oracle(`t4.withWind.${id}.${T}`, 2026, T, scope, 'people', 'share_met_with_wind');
            for (const [k, c] of Object.entries(both)) oracle(`t4.${k}.${id}.${T}`, 2026, T, scope, 'people', c);
        }
    }
    for (const w of ['people', 'demand']) {
        oracle(`t5.cheaper.${w}.2035`, 2035, 90, 'World', w, 'share_wind_cheaper');
        oracle(`t5.only.${w}.2035`, 2035, 90, 'World', w, 'share_wind_only');
    }
    oracle('t5.sbReach.demand.2035', 2035, 90, 'World', 'demand', 'share_met_solar_battery_only');
    for (const [k, c] of Object.entries(both)) oracle(`t5.${k}.demand.2035`, 2035, 90, 'World', 'demand', c);

    // ---- T089 (sections 1, 2, 4-7 of the article v2, T087): the atlas's own worker on the release data -------
    // scripts/article/analysis/t089/run.mjs + analyse_t089.py write t089_values.json (re-run by T087 on the
    // merged release data: identical to the committed copy). Embedded as committed, with its key as the source row.
    {
        const t089 = JSON.parse(fs.readFileSync(path.join(ROOT, 'team/reports/T089-tables/t089_values.json'), 'utf8'));
        for (const [k, v] of Object.entries(t089)) {
            if (!/^s[124567]\./.test(k) || typeof v !== 'number') continue;
            put(k, v, `team/reports/T089-tables/t089_values.json ${k}`);
        }
        // Planned coal and gas, the ten countries with the most (chart, section 6)
        const sc = read(path.join(ROOT, 'team/reports/T089-tables'), 's6_countries.csv');
        sc.slice(0, 10).forEach((r, k) => {
            for (const c of ['planned_gw', 'sb_under100_90', 'sbw_under100_90']) put(`s6c.${k}.${c}`, num(r[c]), `team/reports/T089-tables/s6_countries.csv row ${k + 1} (${r.country}) ${c}`);
        });
        for (const c of ['planned_gw', 'sb_under100_80', 'sbw_under100_80']) put(`s6c.china.${c}`, num(sc.find(r => r.country === 'China')[c]), `team/reports/T089-tables/s6_countries.csv China ${c}`);
        put('s6c.china.sb_under100_90', num(sc.find(r => r.country === 'China').sb_under100_90), 'team/reports/T089-tables/s6_countries.csv China sb_under100_90');
        put('s6c.china.sbw_under100_90', num(sc.find(r => r.country === 'China').sbw_under100_90), 'team/reports/T089-tables/s6_countries.csv China sbw_under100_90');
        // The same quantity from two routes must agree (T089 recon): the S+B and S+W+B medians at 90% (demand)
        for (const [a, b] of [['s1.cost.sb.demand.90', 't1.sbBoth.demand.90'], ['s1.cost.sbw.demand.90', 't1.windBoth.demand.90'], ['s7.cons.1x.people', 't2.coverCons.world']]) {
            if (values[b] && Math.abs(values[a].v - values[b].v) > 0.01 * Math.max(1, Math.abs(values[b].v))) throw new Error(`T089 ${a} ${values[a].v} differs from ${b} ${values[b].v}`);
        }
    }
    // ---- T088 (section 3): week-long solar and wind droughts, 2015-2024, demand-weighted -------------------
    // pipeline/scripts/pipeline/t088/results/aggregates.csv (needs the hourly profiles, so read, not recomputed).
    {
        const ag = read(path.join(ROOT, 'pipeline/scripts/pipeline/t088/results'), 'aggregates.csv');
        const G = { world: 'World', eu: 'Europe', na: 'North America (USA+CAN)', ca: 'Canada', usn: 'Northern US (>=40N)', de: 'Germany' };
        const C = {
            solarWeeks: 'w7_t50_mean_ps', windWeeks: 'w7_t50_mean_pw', bothIfIndependent: 'w7_t50_mean_pexp', bothWeeks: 'w7_t50_mean_pboth',
            mixWeeks: 'w7_t50_mean_pmix50', ratio: 'w7_t50_pooled_ratio', solarInWinter: 'median_w7_t50_solar_share_in_winter',
            windInWinter: 'median_w7_t50_wind_share_in_winter', 'gap7.solar': 'median_def7_solar', 'gap7.wind': 'median_def7_wind', 'gap7.mix50': 'median_def7_mix50'
        };
        for (const [id, group] of Object.entries(G)) {
            const r = ag.find(x => x.group === group && x.weight === 'demand');
            if (!r) throw new Error(`t088 aggregates.csv: no ${group}/demand`);
            for (const [k, c] of Object.entries(C)) {
                if (r[c] == null || r[c] === '') throw new Error(`t088 aggregates.csv: no ${c}`);
                put(`dunkel.${id}.${k}`, num(r[c]), `pipeline/scripts/pipeline/t088/results/aggregates.csv group=${group} weight=demand ${c}`);
            }
        }
        // "17% for either alone": solar and wind weeks in drought in Europe round to the same whole per cent
        const s = values['dunkel.eu.solarWeeks'].v, w = values['dunkel.eu.windWeeks'].v;
        if (Math.round(s * 100) !== Math.round(w * 100)) throw new Error(`T088 Europe solar ${s} and wind ${w} drought weeks no longer round alike`);
        put('dunkel.eu.eitherWeeks', (s + w) / 2, 'aggregates.csv Europe demand: mean of w7_t50_mean_ps and w7_t50_mean_pw (both round to the same per cent)');
        // T090 (finding 3): the world's drought weeks as "one week in N" (N = 1 / share), demand-weighted
        for (const k of ['solar', 'wind', 'both']) put(`dunkel.world.${k}Every`, 1 / values[`dunkel.world.${k}Weeks`].v, `1 / dunkel.world.${k}Weeks (aggregates.csv World demand)`);
    }
    // ---- T090 (key findings 2, 4, 6 and 7; sections 2, 4, 7 and 8): scripts/article/analysis/t090/analyse_t090.py on
    // run_story.mjs's runs (the atlas's own worker, Local costs) and the atlas's potential file. Embedded as committed.
    {
        const t090 = JSON.parse(fs.readFileSync(path.join(ROOT, 'team/reports/T090-tables/t090_values.json'), 'utf8'));
        for (const [k, v] of Object.entries(t090)) if (typeof v === 'number') put(k, v, `team/reports/T090-tables/t090_values.json ${k}`);
        // the third tier of section 6 ($130/MWh at the 80% test; D-161), from build_story_cells.py on the same cells as the map
        const t6 = JSON.parse(fs.readFileSync(path.join(ROOT, 'team/reports/T090-tables/t090_s6.json'), 'utf8'));
        for (const [k, v] of Object.entries(t6)) put(k, v, `team/reports/T090-tables/t090_s6.json ${k} (build_story_cells.py)`);
        // the backup split adds up to the bound backup cost (the same region, the same median)
        const a = values['s4.adder.sbw.demand'].v, f = values['s4.adder.fixed.sbw.demand'].v, x = values['s4.adder.var.sbw.demand'].v;
        if (Math.abs(f + x - a) > 1e-6) throw new Error(`T090 backup split ${f} + ${x} is not s4.adder.sbw.demand ${a}`);
        // T095: the card names the backup cost and its fixed part and calls the rest the gas (the two parts as shown no
        // longer round to the total: $8 + $11 against $18); the fixed part as shown must leave a rest
        if (!(Math.round(f) < Math.round(a))) throw new Error(`T090 backup split: the fixed part $${Math.round(f)} leaves no rest of $${Math.round(a)}`);
    }
    // ---- T091 (the charts-only article's cost maps): the cost of 90% uptime with one common cost of capital, and the
    // cost of capital itself, Africa against Europe (scripts/article/analysis/t091/analyse_wacc_lens.py on the atlas's own
    // worker run with WACC Global; verify-article re-derives them with --check). Embedded as committed.
    {
        const t091 = JSON.parse(fs.readFileSync(path.join(ROOT, 'team/reports/T091-tables/t091_values.json'), 'utf8'));
        for (const [k, v] of Object.entries(t091)) put(k, v, `team/reports/T091-tables/t091_values.json ${k}`);
    }
    // ---- T100 (the human, 9 Nov 2026, D-179): planned coal and gas matched by power every hour of the year with backup,
    // droughts near the equator and the saving from wind by latitude (scripts/article/analysis/t100/derive_t100.py from the
    // committed story cells; verify-article re-derives them with --check), and droughts "N times less often" with wind
    {
        const t100 = JSON.parse(fs.readFileSync(path.join(ROOT, 'team/reports/T100-tables/t100_values.json'), 'utf8'));
        for (const [k, v] of Object.entries(t100)) put(k, v, `team/reports/T100-tables/t100_values.json ${k} (derive_t100.py)`);
        // the uptime ladder (derive_ladder.py on run_story.mjs's runs; its 90/95/99/every-hour steps are T089's s4.curve)
        const lad = JSON.parse(fs.readFileSync(path.join(ROOT, 'team/reports/T100-tables/t100_ladder.json'), 'utf8'));
        for (const [k, v] of Object.entries(lad)) put(k, v, `team/reports/T100-tables/t100_ladder.json ${k} (derive_ladder.py)`);
        // T100 round 7 (the human's draft, 9 Nov 2026): differences and rates the draft states, from committed values only
        const V = k => values[k].v;
        const WEEKS_PER_YEAR = 365.25 / 7;
        put('t100.hl.saving90', V('t1.sbBoth.demand.90') - V('t1.windBoth.demand.90'), 't1.sbBoth.demand.90 - t1.windBoth.demand.90 (highlight 1: "Around $20/MWh")');
        put('t100.africa.financeExtra', V('t091.cost.africa.local.people.90') - V('t091.cost.africa.common.people.90'), 't091 Africa: own cost of capital minus 7% (the finance box: "That extra $50")');
        put('t100.s4.totalSaving', V('s4.total.sb.demand') - V('s4.total.sbw.demand'), 's4.total.sb.demand - s4.total.sbw.demand (section 4: "about $20/MWh")');
        put('t100.china.extra90', V('s6c.china.sbw_under100_90') - V('s6c.china.sb_under100_90'), 's6c China at 90%: with minus without wind (section 5: "another 91 GW")');
        put('dunkel.world.solarPerYear', V('dunkel.world.solarWeeks') * WEEKS_PER_YEAR, 'dunkel.world.solarWeeks x 365.25/7 (drought weeks a year)');
        put('dunkel.world.windPerYear', V('dunkel.world.windWeeks') * WEEKS_PER_YEAR, 'dunkel.world.windWeeks x 365.25/7');
        put('dunkel.world.bothYears', 1 / (V('dunkel.world.bothWeeks') * WEEKS_PER_YEAR), '1 / (dunkel.world.bothWeeks x 365.25/7): years between weeks of both at once');
        put('dunkel.a0_15.solarYears', V('dunkel.a0_15.solarEvery') / WEEKS_PER_YEAR, 'dunkel.a0_15.solarEvery / (365.25/7): years between solar drought weeks within 15 degrees of the equator');
        put('dunkel.world.solarOverBoth', values['dunkel.world.solarWeeks'].v / values['dunkel.world.bothWeeks'].v,
            'dunkel.world.solarWeeks / dunkel.world.bothWeeks (aggregates.csv World demand): how many times less often solar and wind are in drought together than solar alone');
    }
    {
        const r = ext.find(x => x.source_id === 'SRC-EMBER-HTS-2025');
        put('ext.hts.people80under100', num(r.value), 'external_figures.csv SRC-EMBER-HTS-2025 Harnessing the Sun: people with 80% uptime under $100/MWh (as published, "four in five")');
    }

    // ---- Counts and totals: summary.json ------------------------------------
    const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
    put('n.cells', summary.n_cells_engine, 'summary.json n_cells_engine');
    put('n.peopleBn', summary.population_total_bn, 'summary.json population_total_bn');
    put('n.demandTwh', summary.demand_total_twh, 'summary.json demand_total_twh');
    return values;
}

function main() {
    const v = build();
    const i = process.argv.indexOf('--out');
    if (i > 0) {
        const file = path.resolve(process.argv[i + 1]);
        fs.writeFileSync(file, JSON.stringify(v, null, 1) + '\n');
        console.log(`wrote ${file}: ${Object.keys(v).length} values`);
    } else {
        for (const [k, o] of Object.entries(v)) console.log(`${k}\t${o.v}\t${o.src}`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
