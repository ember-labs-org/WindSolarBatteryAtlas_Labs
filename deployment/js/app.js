import {
    loadPopulationCsv,
    loadGemPlantsCsv,
    loadVoronoiGemCapacityCsv,
    loadElectricityDemandData,
    loadReliabilityCsv,
    loadPvoutPotentialCsv,
    loadVoronoiWaccCsv,
    loadVoronoiLocalCapexCsv,
    loadVoronoiDieselCsv,
    loadVoronoiGasCsv,
    loadVoronoiOverlappingCountriesCsv,
    loadVoronoiWindWaccCsv,
    loadConfigManifest,
    loadSummarySlice,
    loadWindResourceCsv,
    loadWindOffshorePotentialCsv,
    loadWindPotentialDefsCsv,
    loadCfMatrix,
    configKey,
    loadAddonManifest,
    loadAddon,
    loadAddonPair,
    setSliceCacheMax} from './data.js';
import {
    addonPassTarget, addonPassBudget, newTargetState, newBudgetState, addonRowFields,
    denseWindSplit, blendedDegradation3, addonPairColumns,
    techOffMask, denseTechMask, TECH_KEYS, TECH_BITS, TECH_SOLAR, TECH_BATTERY, TECH_ONSHORE, TECH_OFFSHORE
} from './addon.js';
import {
    initMap, updateMap,
    updateLcoeMap, updateCfMap, capitalRecoveryFactor, updatePopulationSimple,
    initSubsetMap, renderSubsetMap, subsetMap, setAccessMetric, updatePotentialMap,
    updateSupplyMap, setDualMapMode, ensureWorldGeoJsonLoaded, setCellCountries, setWindSites,
    potentialCell, potentialTechName,
    WIND_LAYER_COLORS, WIND_NEEDED_COLOR, WIND_LAYER_PENDING_COLOR
} from './map.js';
import { initComplementarity, showComplementarity, complementarityReady, cleanupComplementarity } from './complementarity.js';
import {
    capitalizeWord, formatNumber, coordKey,
    haversineKm, updateToggleUI, capitalRecoveryFactor as crf, levelizedGrowthMultiplier, loadChartJs
} from './utils.js';
import { ALL_FUELS, FUEL_COLORS, FUEL_LABELS, PLANT_MARKER, DATA_COLOURS, NO_DATA_COLOR, RAMPS, rampScale, TX_WACC, TX_LIFE, BASE_LOAD_MW, DIESEL_THERMAL_KWH_PER_LITER, DIESEL_PRICE_FLOOR_USD_PER_LITER, MMBTU_PER_MWH, LCOE_NO_DATA_COLOR, POTENTIAL_MULTIPLE_BUCKETS, POTENTIAL_PER_CAPITA_BUCKETS, FEATURE_WORKER_LCOE } from './constants.js';
import { initTour } from './tour.js';
import { setTechFilterNote, setOffshoreTenderLcoe } from './tooltip.js';

// Debug-only performance HUD. Loaded ONLY when the URL has ?perf (or ?perf=1), so
// normal users never fetch perf-hud.js and never see the overlay. It installs the
// window.__SBA_PERF__ sink that the timing hooks in map.js feed.
try {
    if (new URLSearchParams(location.search).has('perf')) import('./perf-hud.js');
} catch (_) { /* measurement is best-effort; never break the app */ }

const d3 = window.d3;

// Diagnostics: with ?debug in the URL the app publishes a read-only snapshot of
// its state on window.__atlas after every update, for testing and bug reports.
// Off by default; nothing is exposed to normal visitors.
const DEBUG_SNAPSHOT = (() => {
    try { return new URLSearchParams(location.search).has('debug'); } catch (_) { return false; }
})();

// Sparse add-on builds (T058): combined onshore + offshore wind and large solar +
// battery builds, from data/addon.json when it exists. ?addon=0 turns them off:
// the atlas then behaves exactly as it does without the file.
const ADDON_ENABLED = (() => {
    try { return new URLSearchParams(location.search).get('addon') !== '0'; } catch (_) { return true; }
})();
let addonManifest = null;          // addon.json, or null (absent, failed or ?addon=0)
let addonPairs = null;             // Set of 'on|off' combined builds the sliders offer, or null
let addonPairsAll = null;          // every combined build addon.json lists
let addonKnown = false;            // true once the worker (or ?worker=0 load) has said which sets it uses
let addonPairsFailed = false;      // a combined build's rows failed to load (e.g. SHA-256 mismatch)
let addonValidFor = null;          // 'on|off' -> simulated (solar, battery) pairs, like validFor
let addonActive = null;            // the add-on sets the cost search actually uses (once known)

// Background warm-up of the cost views (T094): ?warm=1 forces it on, ?warm=0
// off; otherwise shouldWarmCostView() decides from the connection.
const WARM_FLAG = (() => {
    try { return new URLSearchParams(location.search).get('warm'); } catch (_) { return null; }
})();

// State
// The summary slice on screen, as columns (data.js loadSummarySlice). Row
// objects are made only for the rows something reads: see sliceRow().
let summarySlice = null;
let sliceIndex = null;             // per-slice lookups built by indexSummarySlice()
let currentSolar = 5;
let currentBatt = 8;
// Wind capacity (GW) and which surface it sits on. Wind 0 reproduces the
// original solar + battery atlas exactly.
let currentWind = 0;
let currentSurface = 'on';
// With both wind sliders up (currentSurface 'both', add-on only) the two
// capacities; currentWind is then their sum.
let currentWindPair = null;
let configManifest = null;
let windResourceMap = new Map();   // location_id -> siting result
// Full-grid CF matrix on the main thread: built only when there is no worker
// (the worker loads its own), for the main-thread search.
let cfMatrix = null;
let cfMatrixBuild = null;          // promise of the main-thread build, once started
let cfMatrixProgress = null;       // { done, total } while that build runs
let cfMatrixFailed = false;        // that build failed: the pre-grid search stays
// Until then the main-thread search covers the builds of the slice on screen
// and, on a wind level, of the no-wind slice, loaded for it (preGridMatrix).
let preGridNoWind = null;          // the no-wind slice's columns, or 'failed'
let preGridNoWindLoad = null;      // its load, while it runs
let preGridCache = null;           // { slice, n, m }: the pre-grid matrix for the slice on screen
let currentLocationId = null;
let currentViewMode = 'capacity';
let locationIndex = null;
let lcoeResults = [];
let populationData = [];
let summaryByConfig = new Map();
let summaryStatsByConfig = new Map();
let minBattBySolar = new Map();
let potentialData = [];
let potentialDataLoaded = false;
let potentialLevel = 'level1';
let potentialDisplayMode = 'total';
let potentialLatBounds = { level1: null, level2: null };
let potentialAreaById = new Map();
// Wind on the Potential map (T014, D-069). The Potential view only: the population
// view's potential overlay stays solar. Display is Total, × Demand or Per capita, shared
// with that overlay (T097, D-178: the wind CF display is gone).
let potentialTech = 'solar';            // 'solar' | 'onshore' | 'offshore' | 'all'
// Definition (T083): 'tech' = onshore Technical (5 MW/km², the default) and offshore IEA;
// 'cons' = onshore Conservative (D-150) and offshore World Bank/ESMAP.
let potentialDefinition = 'tech';
// Solar ground-mount is the data file's own 50 MW/km² (DC), with no other density cases
// (T097, D-178; T085's 40 and 60 are gone). Rooftop is the whole building footprint (D-157).
let potentialOffshoreLayer = 'fixed';   // 'fixed' | 'floating' (not costed)
let windOffshorePotential = null;       // location_id -> ESMAP fixed/floating GW (T031) + definitions (T083)
let windOffshorePotentialPromise = null;

let fossilPlants = [];
let fossilCapacity = []; // Keep this as it's used in ensureFossilDataLoaded
let fossilCapacityMap = null; // location_id -> { coal_Announced, ... }
let electricityDemandData = [];
let electricityDemandMap = null; // location_id -> annual_demand_kwh
let potentialPopulationMap = null; // location_id -> population_2020 (for per-capita potential)
let reliabilityData = []; // Array of { location_id, avg_reliability, ... }
let reliabilityMap = null; // location_id -> avg_reliability
let waccDataLoaded = false;
let waccMap = new Map(); // location_id -> wacc (fraction)
let waccMode = 'global'; // 'global' or 'local'
let capexDataLoaded = false;
let localCapexMap = new Map(); // location_id -> regional capex anchors
let windWaccMap = new Map();   // location_id -> { fixed, float } wind cost of capital, each { on, off }
let capexMode = 'global'; // 'global' or 'local'
let localCapexCache = new Map();
let localCapexCacheKey = null;
let dieselDataLoaded = false;
let dieselMap = new Map(); // location_id -> local diesel backup pricing
let dieselPriceMode = 'local'; // 'global' or 'local' — source of diesel assumptions
let gasDataLoaded = false;
let gasMap = new Map(); // location_id -> regional wholesale gas pricing (IGU 2024)
let gasPriceMode = 'local'; // 'global' or 'local' — source of gas assumptions

// State for population view overlay
let populationChartCumulative = true;
let lcoeTargetMode = 'utilization'; // 'utilization' or 'lcoe'
let targetLcoeValue = 90; // $/MWh

// Lazy loading state flags - these datasets are only loaded when their views are accessed
let populationDataLoaded = false;
let fossilDataLoaded = false;
let electricityDataLoaded = false;
let reliabilityThreshold = 90;

function getHeapMb() {
    const used = performance?.memory?.usedJSHeapSize;
    return Number.isFinite(used) ? (used / 1048576) : null;
}

function startPerf(label, meta = {}) {
    return {
        label,
        meta,
        startMs: performance.now(),
        startHeapMb: getHeapMb()
    };
}

function endPerf(marker, extra = {}) {
    if (!marker) return;
    const endHeapMb = getHeapMb();
    const durationMs = performance.now() - marker.startMs;
    const heapDeltaMb = (Number.isFinite(endHeapMb) && Number.isFinite(marker.startHeapMb))
        ? (endHeapMb - marker.startHeapMb)
        : null;
    console.debug(`[perf] ${marker.label}`, {
        durationMs: Number(durationMs.toFixed(2)),
        heapDeltaMb: Number.isFinite(heapDeltaMb) ? Number(heapDeltaMb.toFixed(3)) : null,
        ...marker.meta,
        ...extra
    });
}

// Lazy data loaders - only load when needed
async function ensurePopulationDataLoaded() {
    if (populationDataLoaded) return true;

    try {
        loadingStatus.textContent = 'Loading population data...';
        loading.classList.remove('hidden');

        populationData = await loadPopulationCsv();
        populationDataLoaded = true;

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Population data load failed:', err);
        populationData = [];
        loading.classList.add('hidden');
        return false;
    }
}

async function ensurePotentialDataLoaded() {
    if (potentialDataLoaded) return true;

    try {
        loadingStatus.textContent = 'Loading PVOUT potential data...';
        loading.classList.remove('hidden');

        potentialData = await loadPvoutPotentialCsv();
        potentialAreaById = new Map();
        potentialData.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const area = Number(row.zone_area_km2);
            potentialAreaById.set(row.location_id, Number.isFinite(area) ? area : null);
        });
        potentialDataLoaded = true;

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('PVOUT potential data load failed:', err);
        potentialData = [];
        potentialDataLoaded = false;
        loading.classList.add('hidden');
        return false;
    }
}

async function ensureWindOffshorePotentialLoaded() {
    if (windOffshorePotential) return true;
    if (!windOffshorePotentialPromise) {
        windOffshorePotentialPromise = Promise.all([loadWindOffshorePotentialCsv(), loadWindPotentialDefsCsv()])
            .then(([rows, defs]) => {
                const byId = new Map(rows.map(r => [r.location_id, { ...r }]));
                defs.forEach(d => byId.set(d.location_id, { ...(byId.get(d.location_id) || { location_id: d.location_id }), defs: d }));
                windOffshorePotential = byId;
            })
            .catch(err => { console.error('Offshore wind potential data load failed:', err); })
            .finally(() => { windOffshorePotentialPromise = null; });
    }
    loadingStatus.textContent = 'Loading wind potential...';
    loading.classList.remove('hidden');
    await windOffshorePotentialPromise;
    loading.classList.add('hidden');
    return Boolean(windOffshorePotential);
}

async function ensureFossilDataLoaded() {
    if (fossilDataLoaded) return true;

    try {
        loadingStatus.textContent = 'Loading power plant data...';
        loading.classList.remove('hidden');

        fossilPlants = await loadGemPlantsCsv();
        fossilCapacity = await loadVoronoiGemCapacityCsv();
        fossilCapacityMap = new Map(fossilCapacity.map(row => [row.location_id, row]));

        // Enrich fossil plants with location_id if we have summary data
        if (fossilPlants.length && fossilCapacity.length) {
            const sites = fossilCapacity.map(d => [d.latitude, d.longitude]);
            const delaunay = d3.Delaunay.from(sites);
            fossilPlants.forEach(plant => {
                const idx = delaunay.find(plant.latitude, plant.longitude);
                if (idx !== -1 && fossilCapacity[idx]) {
                    plant.location_id = fossilCapacity[idx].location_id;
                }
            });
            console.log('Enriched fossilPlants with location_ids via spatial join.');
        }

        fossilDataLoaded = true;
        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Fossil data load failed:', err);
        fossilPlants = [];
        fossilCapacity = [];
        fossilCapacityMap = new Map();
        loading.classList.add('hidden');
        return false;
    }
}

async function ensureElectricityDataLoaded() {
    if (electricityDataLoaded) return true;

    try {
        loadingStatus.textContent = 'Loading electricity demand data...';
        loading.classList.remove('hidden');

        electricityDemandData = await loadElectricityDemandData();
        electricityDemandMap = new Map(electricityDemandData.map(row => [row.location_id, row]));
        electricityDataLoaded = true;

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Electricity demand data load failed:', err);
        electricityDemandData = [];
        electricityDemandMap = new Map();
        loading.classList.add('hidden');
        return false;
    }
}

async function ensureReliabilityDataLoaded() {
    if (reliabilityData.length > 0) return true;
    try {
        loadingStatus.textContent = 'Loading reliability data...'; // Assuming showLoading is a helper for this
        loading.classList.remove('hidden'); // Assuming showLoading also handles this
        reliabilityData = await loadReliabilityCsv();
        reliabilityMap = new Map(reliabilityData.map(d => [d.location_id, d]));
        loading.classList.add('hidden'); // Assuming showLoading also handles this
        return true;
    } catch (e) {
        console.error("Failed to load reliability data", e);
        loading.classList.add('hidden'); // Assuming showLoading also handles this
        return false;
    }
}

async function ensureWaccDataLoaded() {
    if (waccDataLoaded) return true;
    try {
        loadingStatus.textContent = 'Loading local WACC data...';
        loading.classList.remove('hidden');

        const data = await loadVoronoiWaccCsv();
        waccMap = new Map();
        data.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const waccPercent = Number(row.wacc_percent);
            if (!Number.isFinite(waccPercent)) return;
            waccMap.set(row.location_id, waccPercent / 100);
        });

        // Wind cost of capital per cell, onshore and offshore, so local WACC
        // mode prices wind on its own terms rather than solar's. It follows the
        // WACC setting, not the capex one (T011). Hatton v3 2025 rates, held
        // flat over the timeline like the solar rate (T025). Offshore carries
        // the fixed-bottom rate, and the floating rate where the cell's site is
        // floating class; windOffFloatingPriced() picks between them.
        try {
            const waccRows = await loadVoronoiWindWaccCsv();
            windWaccMap = new Map();
            const pct = v => (Number.isFinite(v) ? v / 100 : undefined);
            waccRows.forEach(r => {
                if (!Number.isFinite(r.location_id)) return;
                const on = pct(r.wind_on_wacc_percent);
                const fixedOff = pct(r.wind_off_fixed_wacc_percent ?? r.wind_off_wacc_percent);
                const floatOff = isFloatingWindClass(r.wind_off_class) ? pct(r.wind_off_float_wacc_percent) : undefined;
                windWaccMap.set(r.location_id, {
                    fixed: { on, off: fixedOff },
                    float: Number.isFinite(floatOff) ? { on, off: floatOff } : null
                });
            });
        } catch (e) {
            console.warn('Wind WACC not available, falling back to the solar figure plus the premiums:', e);
            windWaccMap = new Map();
        }
        waccDataLoaded = true;

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Local WACC load failed:', err);
        waccMap = new Map();
        windWaccMap = new Map();
        waccDataLoaded = false;
        loading.classList.add('hidden');
        return false;
    }
}

// T067 (T065-V-3): the info text's count of regions without local cost data is
// derived from the data (66 when built), not hard-coded.
function updateMissingCostCellsNote() {
    const el = document.getElementById('missing-cost-cells');
    if (!el || !localCapexMap.size || !sliceLength()) return;
    const missing = matrixLocationIds().filter(id => !localCapexMap.has(id)).length;
    el.textContent = missing.toLocaleString('en-GB');
}

async function ensureLocalCapexDataLoaded() {
    if (capexDataLoaded) return true;
    try {
        loadingStatus.textContent = 'Loading local CAPEX data...';
        loading.classList.remove('hidden');

        const data = await loadVoronoiLocalCapexCsv();
        localCapexMap = new Map();
        data.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const solar2024 = Number(row.solar_2024);
            const solar2035 = Number(row.solar_2035);
            const solar2050 = Number(row.solar_2050);
            const battery2024 = Number(row.battery_2024);
            const battery2035 = Number(row.battery_2035);
            const battery2050 = Number(row.battery_2050);
            if (![solar2024, solar2035, solar2050, battery2024, battery2035, battery2050].every(Number.isFinite)) {
                return;
            }
            // Wind (T024 dataset, T025): capex and O&M ($/kW/yr) for 2024/2035/2050.
            // Offshore is held at a fixed-bottom site and, where the cell's site
            // is floating class, also as floating; windOffFloatingPriced() picks.
            const years = (prefix) => {
                const v = [row[`${prefix}_2024`], row[`${prefix}_2035`], row[`${prefix}_2050`]];
                return v.every(Number.isFinite) ? v : null;
            };
            const floating = isFloatingWindClass(row.wind_off_class);
            localCapexMap.set(row.location_id, {
                region: row.region || null,
                source: row.capex_source || null,
                solar: [solar2024, solar2035, solar2050],
                battery: [battery2024, battery2035, battery2050],
                windOn: years('wind_on'),
                windOnOm: years('wind_on_om'),
                windOffFixed: years('wind_off_fixed'),
                windOffFixedOm: years('wind_off_fixed_om'),
                windOffFloat: floating ? years('wind_off_float') : null,
                windOffFloatOm: floating ? years('wind_off_float_om') : null,
                windOffFixedGen: row.wind_off_tso && !floating ? years('wind_off_fixed_gen') : null
            });
        });

        capexDataLoaded = true;
        resetLocalCapexCache();
        updateMissingCostCellsNote();

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Local CAPEX load failed:', err);
        localCapexMap = new Map();
        capexDataLoaded = false;
        loading.classList.add('hidden');
        return false;
    }
}

// One load at a time, shared by every caller: the background warm-up loads
// silently (T094), and a cost view opened meanwhile waits for the same load.
let dieselLoad = null;
let gasLoad = null;

async function ensureDieselDataLoaded({ silent = false } = {}) {
    if (dieselDataLoaded) return true;
    if (!silent) {
        loadingStatus.textContent = 'Loading diesel backup pricing...';
        loading.classList.remove('hidden');
    }
    if (!dieselLoad) dieselLoad = loadDieselData().finally(() => { dieselLoad = null; });
    const ok = await dieselLoad;
    if (!silent) loading.classList.add('hidden');
    return ok;
}

async function loadDieselData() {
    try {
        const data = await loadVoronoiDieselCsv();
        dieselMap = new Map();
        data.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const diesel2025 = Number(row.diesel_2025_usd_per_liter_avg);
            const diesel2024 = Number(row.diesel_2024_usd_per_liter_avg);
            const price2025 = Number.isFinite(diesel2025) ? diesel2025 : null;
            const price2024 = Number.isFinite(diesel2024) ? diesel2024 : null;
            const price = price2025 ?? price2024;
            const use2025 = price2025 !== null;
            dieselMap.set(row.location_id, {
                price,
                rawPrice: price,
                price2024,
                price2025,
                sourceYear: use2025 ? 2025 : price2024 !== null ? 2024 : null,
                sourceType: use2025 ? row.diesel_2025_source : row.diesel_2024_source,
                sourceDistanceKm: use2025 ? row.diesel_2025_distance_km : row.diesel_2024_distance_km,
                sourceIso3: use2025 ? row.diesel_2025_iso3 : row.diesel_2024_iso3,
                sourceCountry: use2025 ? row.diesel_2025_country : row.diesel_2024_country,
                sourceSeriesName: use2025 ? row.diesel_2025_series_name : row.diesel_2024_series_name,
                selectionMethod: use2025 ? row.diesel_2025_selection_method : row.diesel_2024_selection_method,
                country_iso3: row.country_iso3 || null,
                country_name: row.country_name || null
            });
        });
        dieselDataLoaded = true;
        return true;
    } catch (err) {
        console.error('Diesel price load failed:', err);
        dieselMap = new Map();
        dieselDataLoaded = false;
        return false;
    }
}

async function ensureGasDataLoaded({ silent = false } = {}) {
    if (gasDataLoaded) return true;
    if (!silent) {
        loadingStatus.textContent = 'Loading gas backup pricing...';
        loading.classList.remove('hidden');
    }
    if (!gasLoad) gasLoad = loadGasData().finally(() => { gasLoad = null; });
    const ok = await gasLoad;
    if (!silent) loading.classList.add('hidden');
    return ok;
}

async function loadGasData() {
    try {
        const data = await loadVoronoiGasCsv();
        gasMap = new Map();
        data.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const price = Number.isFinite(row.gas_2024_usd_per_mmbtu) ? row.gas_2024_usd_per_mmbtu : null;
            gasMap.set(row.location_id, {
                available: Boolean(row.gas_available) && Number.isFinite(price),
                price,
                rawPrice: price,
                sourceYear: 2024,
                sourceType: row.gas_2024_source || null,
                sourceDistanceKm: row.gas_2024_distance_km,
                sourceIso3: row.gas_2024_iso3 || null,
                sourceCountry: row.gas_2024_country || null,
                country_iso3: row.country_iso3 || null,
                country_name: row.country_name || null
            });
        });
        gasDataLoaded = true;
        return true;
    } catch (err) {
        console.error('Gas price load failed:', err);
        gasMap = new Map();
        gasDataLoaded = false;
        return false;
    }
}

// Load all population-mode data (called when switching to population view)
async function ensurePopulationModeDataLoaded() {
    const results = await Promise.all([
        ensurePopulationDataLoaded(),
        ensureFossilDataLoaded(),
        ensureElectricityDataLoaded(),
        ensureReliabilityDataLoaded()
    ]);
    return results.every(r => r);
}

// LCOE Display Mode Toggle (Delta vs Transmission Cost)
let lcoeDisplayMode = 'delta';
const lcoeDisplayModeButtons = document.querySelectorAll('#lcoe-display-mode button');
if (lcoeDisplayModeButtons && lcoeDisplayModeButtons.length > 0) {
    lcoeDisplayModeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode === lcoeDisplayMode) return;
            lcoeDisplayMode = mode;
            resetLcoeTimeLegendLock();

            // Update button UI
            lcoeDisplayModeButtons.forEach(b => {
                b.classList.toggle('is-active', b.dataset.mode === mode);
            });

            // Update legend title and scale
            updateLcoeLegendForMode(mode);

            // Trigger map update to re-render with new color scale
            updateUI();
        });
    });
}

// LCOE view map layer (T014): the cost of the cheapest build meeting the target
// (default), or the wind share or saving from wind of the same builds, read from
// the fields the search already returns. Target-CF mode only.
let lcoeMapLayer = 'lcoe';
const lcoeLayerButtons = document.querySelectorAll('#lcoe-layer-toggle button');
const lcoeLayerWrap = document.getElementById('lcoe-layer-wrap');
lcoeLayerButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const layer = btn.dataset.lcoeLayer;
        if (!layer || layer === lcoeMapLayer) return;
        lcoeMapLayer = layer;
        updateToggleUI(lcoeLayerButtons, layer, 'lcoeLayer');
        if (currentViewMode === 'lcoe') updateLcoeView();
    });
});
const TX_CRF = crf(TX_WACC, TX_LIFE);

// Global-mode wind costs (D-066). Kept here, in one place, so the local wind
// dataset (T024) and its app wiring (T025) can align with them. 2025 USD/kW.
// - Onshore: IRENA's global series (SRC-IRENA-RPGC-2025, fig 1.7). Anchor = mean
//   of 2023-2025 (D-057 Q10). 2035 = anchor x Refined 2035 / that same mean
//   (D-058, D-064), which is IRENA's Refined 2035 level. 2050 = 2035 x IRENA's
//   2025-2035 rate of decline extended 15 years (D-057 Q1b, D-064).
// - Offshore: IRENA global weighted average 2025, fig 4.3 (the D-057 Q9
//   fallback), x the DEA fixed-bottom AC data-sheet path 2035/2025 and 2050/2025
//   (SRC-DEA-TC-2026, sheet 21, 30 m / 60 km; 2.78 -> 2.25 -> 1.99 rounded).
// The anchor holds 2023-2025 costs and is labelled 2024 as in the local file
// (D-058 Q1a). Global mode treats it as today's cost, as it does solar's.
const WIND_GLOBAL_COST_INPUTS = {
    onshoreObserved: { 2023: 1216.084, 2024: 1066.656, 2025: 972.84 },
    onshoreRefined2025: 1025.743,
    onshoreRefined2035: 792.491,
    offshoreGlobal2025: 2930.949,
    deaFixedAc: { 2025: 2.780229479, 2035: 2.248224305, 2050: 1.985692992 } // m EUR2020/MW
};
const WIND_GLOBAL_CAPEX = (() => {
    const s = WIND_GLOBAL_COST_INPUTS;
    const observed = Object.values(s.onshoreObserved);
    const onAnchor = observed.reduce((a, b) => a + b, 0) / observed.length;
    const on2035 = s.onshoreRefined2035;
    const on2050 = on2035 * Math.pow(s.onshoreRefined2035 / s.onshoreRefined2025, 15 / 10);
    const off = s.offshoreGlobal2025;
    const dea = s.deaFixedAc;
    return {
        on: { 2024: onAnchor, 2035: on2035, 2050: on2050 },   // 1,085 -> 792 -> 538
        off: { 2024: off, 2035: off * dea[2035] / dea[2025], 2050: off * dea[2050] / dea[2025] } // 2,931 -> 2,370 -> 2,093
    };
})();

// Global-mode wind cost of capital = the WACC input + these premiums (D-066).
// Hatton v3, 2025 forecasts, 174 countries (SRC-HATTON-V3-2026; futures
// hatton.hatton_cost_of_capital_long): Onshore Wind equals Solar PV in every
// country, so onshore +0.00 points; the median of Offshore Wind minus Onshore
// Wind is +0.92 points (range 0.78-1.10; the medians themselves are 11.17% and
// 10.23%). Floating Offshore (median +2.67 over onshore) is not used until
// floating sites are simulated. Treated as real rates, like the WACC (D-054).
const WIND_WACC_PREMIUM_DEFAULT = { on: 0.0, off: 0.0092 };

let lcoeParams = {
    solarCapex: 720,       // $/kW_AC (converted to DC via ILR)
    batteryCapex: 120,     // $/kWh
    solarOpexPct: 0.015,   // 1.5% of capex annually
    batteryOpexPct: 0.02,  // 2% of capex annually (as requested)
    solarDegradationPct: 0.005,      // 0.5%/yr PV energy degradation
    solarLife: 30,
    batteryLife: 20,
    // Wind. Capex defaults to today's anchor in WIND_GLOBAL_CAPEX and falls over
    // time as solar's does. O&M is a share of capex, as for solar.
    windCapex: Math.round(WIND_GLOBAL_CAPEX.on[2024]),     // $/kW onshore (1,085)
    windOffCapex: Math.round(WIND_GLOBAL_CAPEX.off[2024]), // $/kW offshore (2,931)
    // Global WACC mode prices wind at wacc + these premiums (fractions).
    windWaccPremium: WIND_WACC_PREMIUM_DEFAULT.on,
    windOffWaccPremium: WIND_WACC_PREMIUM_DEFAULT.off,
    windOpexPct: 0.025,     // 2.5% of capex annually, onshore
    windOffOpexPct: 0.035,  // 3.5% offshore: marine access and vessels
    windLife: 30,
    windOffLife: 30,
    // Wind output degradation, %/yr as a fraction (D-065): Hamilton et al. 2020
    // (SRC-HAMILTON-2020) find 0.17%/yr for newer US plants; older fleets lose
    // 0.5-0.6%/yr. Offshore takes the onshore figure for lack of offshore evidence.
    windDegradationPct: 0.002,
    windOffDegradationPct: 0.002,
    // Cost views take onshore or offshore wind per location, whichever gives the
    // cheaper build; false ('Include offshore wind' unticked) searches onshore only.
    includeOffshore: true,
    // T074 technology filter: switched-off solar (1), battery (2) and onshore
    // wind (4) bits; offshore is includeOffshore above. 0 = every technology on.
    techOff: 0,
    wacc: 0.07,
    ilr: 1.3,
    targetCf: 0.90,
    includeDieselBackup: false, // master "add backup" flag; each region then picks the cheaper of diesel vs gas
    dieselBackupMode: 'min-solar',
    dieselCapex: 300,
    dieselEfficiency: 0.35,
    dieselLife: 20,
    dieselPrice: 1.20, // $/liter (used when dieselPriceMode === 'global')
    dieselPriceMode: 'local', // 'global' or 'local' — mirrored from module-level dieselPriceMode for the worker payload
    // OCGT gas backup — competes with diesel where a regional wholesale price exists (IGU 2024).
    gasCapex: 800,         // $/kW
    gasEfficiency: 0.35,   // thermal efficiency (conservative; modern OCGT ~38-42%)
    gasLife: 25,           // years
    gasPrice: 4.88,        // $/MMBtu (used when gasPriceMode === 'global'; default = IGU 2024 world avg)
    gasPriceMode: 'local'  // 'global' or 'local' — mirrored from module-level gasPriceMode for the worker payload
};
let lcoeCostMultipliers = { solar: 1, battery: 1, wind: 1, windOff: 1 };
// T067 (T065-04): the cost year is a constant, not the visitor's clock. Both modes
// treat their cost inputs (IRENA 2025 data; the local files' "2024" columns) as
// COST_BASE_YEAR costs and decline from there, so Global and Local share one
// convention and the article (pinned to 2026) and the app agree.
const COST_BASE_YEAR = 2026;
const LOCAL_ANCHOR_YEARS = [COST_BASE_YEAR, 2035, 2050];
let lcoeTimeYear = COST_BASE_YEAR;
let lcoeTimePlaying = false;
let lcoeTimeTimer = null;
let lcoeTimeLockActive = false;
let lcoeTimeLockedColorInfo = null;
let lcoeUpdateTimeout = null;
let lcoeReference = null; // Stores the selected location's LCOE result
const DELTA_PERCENTILE = 0.95;
let legendLock = false;
let lockedColorInfo = null;
let lcoeWorker = null;
let lcoeWorkerFailed = false;     // once set, every search runs on the main thread
let lcoeWorkerRequestSeq = 0;
// The worker loads the full grid itself, once, on first opening a cost view.
let lcoeWorkerMatrix = null;      // promise: true once the worker holds the grid
let lcoeWorkerMatrixReady = false;
// WACC, capex, diesel and gas lookups go to the worker once per change, not
// with every search. Each change gets a new version.
let lcoeLookups = null;           // { version, parts, maps }
let lcoeWorkerLookupVersion = 0;  // version the worker holds (0: none)
const lcoeWorkerPending = new Map();
const lcoeWorkerBestCache = new Map();
const lcoeWorkerCfCache = new Map();
// Each cached answer is ~5,000 rows, so keep only the most recently used.
const LCOE_WORKER_CACHE_MAX = 24;
// One search in the worker at a time; a newer request replaces the one waiting.
let lcoeWorkerJob = null;
let lcoeWorkerNextJob = null;
// Id of the latest LCOE draw request. A worker answer redraws the map only if
// it was requested by this one.
let lcoeDrawRequestId = 0;
let lcoeRenderedYear = null;      // cost year of the last LCOE draw (Timeline Play)
let lcoeShownKind = null;         // which LCOE result is on screen: 'lcoe', 'lcoe_cf', 'pop_lcoe' or null
let lcoePendingMapId = null;      // map container dimmed while its result is pending

// DOM Elements
// DOM Elements
const solarSlider = document.getElementById('solar-slider');
const battSlider = document.getElementById('batt-slider');
const solarVal = document.getElementById('solar-val');
const battVal = document.getElementById('batt-val');
const loading = document.getElementById('loading');
const loadingStatus = document.getElementById('loading-status');
const viewTabs = document.querySelectorAll('.view-tab'); // New: View Mode Tabs
const compControls = document.getElementById('comp-controls');
const potentialControls = document.getElementById('potential-controls');
const populationControls = document.getElementById('population-controls'); // New: Population Controls
const populationSupplyControls = document.getElementById('population-supply-controls');
const populationControlsToggle = document.getElementById('population-controls-toggle');
const populationSupplyToggle = document.getElementById('population-supply-toggle');
const populationSupplyPanel = document.getElementById('population-supply-panel');
const potentialLevelButtons = document.querySelectorAll('#potential-level-toggle button');
const potentialDisplayButtons = document.querySelectorAll('#potential-display-toggle button');
const legendCapacity = document.getElementById('legend-capacity');
const legendCompDrought = document.getElementById('legend-comp-drought');
const legendCompScore = document.getElementById('legend-comp-score');
const legendPotential = document.getElementById('legend-potential');
const legendLcoe = document.getElementById('legend-lcoe');
const legendPopulation = document.getElementById('legend-population');
const legendElectricity = document.getElementById('legend-electricity');
const legendAccess = document.getElementById('legend-access');
const legendSupplyStack = document.getElementById('legend-supply-stack');
const legendSupplyCapacity = document.getElementById('legend-supply-capacity');
const legendSupplyLcoe = document.getElementById('legend-supply-lcoe');
const legendSupplyLcoeTitle = document.getElementById('legend-supply-lcoe-title');
const legendSupplyLcoeMin = document.getElementById('legend-supply-lcoe-min');
const legendSupplyLcoeMid = document.getElementById('legend-supply-lcoe-mid');
const legendSupplyLcoeMax = document.getElementById('legend-supply-lcoe-max');
const legendSupplyLcoeRef = document.getElementById('legend-supply-lcoe-ref');
const legendSupplyLcoeBar = document.getElementById('legend-supply-lcoe-bar');
const legendSupplyLcoeNotes = document.getElementById('legend-supply-lcoe-notes');
const legendSupplyPotential = document.getElementById('legend-supply-potential');
const legendSupplyPotentialTitle = document.getElementById('legend-supply-potential-title');
const legendSupplyPotentialBar = document.getElementById('legend-supply-potential-bar');
const legendSupplyPotentialBuckets = document.getElementById('legend-supply-potential-buckets');
const legendSupplyPotentialMin = document.getElementById('legend-supply-potential-min');
const legendSupplyPotentialMax = document.getElementById('legend-supply-potential-max');
const legendPotentialMin = document.getElementById('legend-potential-min');
const legendPotentialMax = document.getElementById('legend-potential-max');
const legendPotentialTitle = document.getElementById('legend-potential-title');
const legendPotentialBar = document.getElementById('legend-potential-bar');
const legendPotentialBuckets = document.getElementById('legend-potential-buckets');

// Stats
const statAvgCf = document.getElementById('stat-avg-cf');
const statMaxCf = document.getElementById('stat-max-cf');

// LCOE Legend Elements
const legendLcoeTitle = document.getElementById('legend-lcoe-title');
const legendLcoeMin = document.getElementById('legend-lcoe-min');
const legendLcoeMid = document.getElementById('legend-lcoe-mid');
const legendLcoeMax = document.getElementById('legend-lcoe-max');
const legendLcoeRef = document.getElementById('legend-lcoe-ref');
const legendLcoeBar = document.getElementById('legend-lcoe-bar');
const comparisonToggle = document.getElementById('comparison-toggle');
const clearRefBtn = document.getElementById('lcoe-clear-ref');
const legendLcoeNotes = document.getElementById('legend-lcoe-notes');
const legendTxExplainer = document.getElementById('legend-tx-explainer');
// Note: LCOE_NO_DATA_COLOR imported from constants.js

// Settings Modal Elements
const targetCfSlider = document.getElementById('target-cf-slider');
const targetCfVal = document.getElementById('target-cf-val');
const solarCapexInput = document.getElementById('solar-capex');
const batteryCapexInput = document.getElementById('battery-capex');
const solarOpexInput = document.getElementById('solar-opex');
const batteryOpexInput = document.getElementById('battery-opex');
const solarDegradationInput = document.getElementById('solar-degradation');
const solarLifeInput = document.getElementById('solar-life');
const batteryLifeInput = document.getElementById('battery-life');
const waccInput = document.getElementById('wacc');
const ilrInput = document.getElementById('ilr');
const dieselBackupInput = document.getElementById('diesel-backup-toggle');
const includeOffshoreInputs = ['include-offshore-toggle', 'pop-include-offshore-toggle']
    .map(id => document.getElementById(id)).filter(Boolean);

// ---- Technology filter (T074) ---------------------------------------------
// Solar, Battery, Onshore and Offshore chips in both cost panels. The search
// (here, in the worker and in the add-on pass) uses only builds whose
// switched-off technologies are zero; uptimes are never re-simulated. Offshore
// is the 'Include offshore wind' switch, so the chip and the tick box are one
// state. At least one technology stays on.
// Wind layers: wind share and the saving from wind need wind, so they are off
// while both wind chips are. The saving compares the cheapest eligible build
// with the cheapest eligible build without wind (the same filter, wind removed):
// with solar off it is against batteries alone, which never deliver, so the
// target is "met only with wind" wherever it is met.
const lcoeTechButtons = document.querySelectorAll('.lcoe-tech-toggle button[data-lcoe-tech]');
const TECH_NAMES = { solar: 'solar', battery: 'battery', onshore: 'onshore', offshore: 'offshore' };
const TECH_WIND = TECH_ONSHORE | TECH_OFFSHORE;

function techCountOn(offMask) {
    let n = 0;
    for (const k of TECH_KEYS) if (!(offMask & TECH_BITS[k])) n++;
    return n;
}

/** Whether a wind technology is on (the wind layers need one). */
function windTechOn(params = lcoeParams) {
    return (techOffMask(params) & TECH_WIND) !== TECH_WIND;
}

/** "Solar + battery only" while a technology is off; null with all four on. */
function techFilterText(params = lcoeParams) {
    const off = techOffMask(params);
    if (!off) return null;
    const on = TECH_KEYS.filter(k => !(off & TECH_BITS[k])).map(k => TECH_NAMES[k]).join(' + ');
    return `${on.charAt(0).toUpperCase()}${on.slice(1)} only`;
}

/** What the saving from wind is measured against, with the filter on ('' = no such build). */
function noWindComparator(params = lcoeParams) {
    const off = techOffMask(params);
    const parts = [];
    if (!(off & TECH_SOLAR)) parts.push('solar');
    if (!(off & TECH_BATTERY)) parts.push('battery');
    // Batteries alone deliver nothing: no build without wind.
    return parts.includes('solar') ? parts.join(' + ') : '';
}

function setTechOn(tech, on) {
    if (tech === 'offshore') lcoeParams.includeOffshore = on;
    else if (on) lcoeParams.techOff &= ~TECH_BITS[tech];
    else lcoeParams.techOff |= TECH_BITS[tech];
}

/** A filter change: wind layers fall back to LCOE without wind, then redraw. */
function onTechFilterChange() {
    if (!windTechOn() && lcoeMapLayer !== 'lcoe') {
        lcoeMapLayer = 'lcoe';
        updateToggleUI(lcoeLayerButtons, 'lcoe', 'lcoeLayer');
    }
    mainThreadGridBanner();
    syncLcoeControlValues();
    resetLcoeTimeLegendLock();
    queueLcoeUpdate();
}

/** Chips, the offshore tick boxes and the wind-layer buttons from lcoeParams. */
function syncTechControls() {
    const off = techOffMask(lcoeParams);
    const last = techCountOn(off) === 1;
    lcoeTechButtons.forEach(btn => {
        const on = !(off & TECH_BITS[btn.dataset.lcoeTech]);
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.disabled = on && last;
        if (btn.disabled) btn.title = 'One technology must stay on';
        else btn.removeAttribute('title');
    });
    includeOffshoreInputs.forEach(input => { input.disabled = !(off & TECH_OFFSHORE) && last; });
    const wind = windTechOn();
    lcoeLayerButtons.forEach(btn => {
        if (btn.dataset.lcoeLayer === 'lcoe') return;
        btn.disabled = !wind;
        if (wind) btn.removeAttribute('title');
        else btn.title = 'Needs wind';
    });
    setTechFilterNote(off ? { text: techFilterText(), noWind: noWindComparator() } : null);
}

lcoeTechButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const tech = btn.dataset.lcoeTech;
        const off = techOffMask(lcoeParams);
        const on = !(off & TECH_BITS[tech]);
        if (on && techCountOn(off) === 1) return;     // the last one stays on
        setTechOn(tech, !on);
        onTechFilterChange();
    });
});

/**
 * Regions where no eligible build is priced get a row in the "target not met"
 * state, so the map keeps every cell (Voronoi cells come from the rows) and
 * the cell reads as unmet rather than vanishing. Only while a filter is on.
 */
let techGapIds = { slice: null, ids: null };    // matrixLocationIds() of the slice on screen
function fillTechFilterGaps(rows, params) {
    if (!rows || !techOffMask(params)) return rows;
    if (techGapIds.slice !== summarySlice) techGapIds = { slice: summarySlice, ids: matrixLocationIds() };
    const have = new Set();
    for (const r of rows) have.add(r.location_id);
    let added = 0;
    const out = rows.slice();
    for (const id of techGapIds.ids) {
        if (have.has(id)) continue;
        const first = sliceFirstRow(id);
        if (!first) continue;
        out.push({
            location_id: id, latitude: first.latitude, longitude: first.longitude,
            solar_gw: 0, wind_gw: 0, batt_gwh: 0, annual_cf: NaN, cf: NaN, firm_cf: NaN, lcoe: NaN,
            meetsTarget: false, targetLcoeMet: false, noEligibleBuild: true
        });
        added++;
    }
    return added ? out.sort((a, b) => a.location_id - b.location_id) : rows;
}
const dieselBackupModeGroup = document.getElementById('diesel-backup-mode-group');
const dieselCapexInput = document.getElementById('diesel-capex');
const dieselEfficiencyInput = document.getElementById('diesel-efficiency');
const dieselLifeInput = document.getElementById('diesel-life');
const dieselPriceInput = document.getElementById('diesel-price');
const dieselSourceWrapper = document.getElementById('diesel-source-wrapper');
const dieselGlobalInputs = document.getElementById('diesel-global-inputs');
const gasSourceWrapper = document.getElementById('gas-source-wrapper');
const gasGlobalInputs = document.getElementById('gas-global-inputs');
const gasCapexInput = document.getElementById('gas-capex');
const gasEfficiencyInput = document.getElementById('gas-efficiency');
const gasLifeInput = document.getElementById('gas-life');
const gasPriceInput = document.getElementById('gas-price');
const gasSourceButtons = document.querySelectorAll('#gas-source-toggle button');
const capexGlobalInputs = document.getElementById('capex-global-inputs');
const waccGlobalInputs = document.getElementById('wacc-global-inputs');
const targetCfBackupNote = document.getElementById('target-cf-backup-note');
const lcoeTimeSlider = document.getElementById('lcoe-time-slider');
const lcoeTimeYearLabel = document.getElementById('lcoe-time-year');
const lcoeTimePlayBtn = document.getElementById('lcoe-time-play');
const popLcoeTimeSlider = document.getElementById('pop-lcoe-time-slider');
const popLcoeTimeYearLabel = document.getElementById('pop-lcoe-time-year');
// Cost Decline Timeline: each technology's share of today's capex, in both panels.
const lcoeTimeFactorLabels = ['solar', 'battery', 'wind', 'offwind'].map(key =>
    [key, [document.getElementById(`lcoe-time-${key}`), document.getElementById(`pop-lcoe-time-${key}`)]]);
const popLcoeTimePlayBtn = document.getElementById('pop-lcoe-time-play');
const lcoeTargetModeButtons = document.querySelectorAll('#lcoe-target-mode-toggle button');
const waccSourceButtons = document.querySelectorAll('#wacc-source-toggle button');
const popWaccSourceButtons = document.querySelectorAll('#pop-wacc-source-toggle button');
const capexSourceButtons = document.querySelectorAll('#capex-source-toggle button');
const popCapexSourceButtons = document.querySelectorAll('#pop-capex-source-toggle button');
const targetCfContainer = document.getElementById('target-cf-container');
const targetLcoeContainer = document.getElementById('target-lcoe-container');
const popTargetCfContainer = document.getElementById('pop-target-cf-container');
const targetLcoeInput = document.getElementById('target-lcoe-input');

// Population Elements
const populationBaseButtons = document.querySelectorAll('#population-base-toggle button');
const populationOverlayButtons = document.querySelectorAll('#population-overlay-mode button');
const populationDisplayButtons = document.querySelectorAll('#population-display-toggle button');
const supplyPotentialLevelButtons = document.querySelectorAll('#supply-potential-level-toggle button');
const supplyPotentialDisplayButtons = document.querySelectorAll('#supply-potential-display-toggle button');
const populationViewToggle = document.getElementById('population-view-toggle');
const reliabilityThresholdControl = document.getElementById('reliability-threshold-control');
const reliabilityThresholdSlider = document.getElementById('reliability-threshold-slider');
const reliabilityThresholdVal = document.getElementById('reliability-threshold-val');
const legendPopMin = document.getElementById('legend-pop-min');
const legendPopMax = document.getElementById('legend-pop-max');
const populationFuelFilterWrapper = document.getElementById('plant-fuel-filter');
const plantLegend = document.getElementById('plant-legend');
const plantStatusToggle = document.getElementById('plant-status-toggle');
const plantStatusButtons = document.querySelectorAll('#plant-status-buttons button');
const populationViewHelper = document.getElementById('population-view-helper');
const populationChartsCta = document.getElementById('population-charts-cta');
const populationFuelButtons = document.querySelectorAll('[data-fuel]');
const populationChartLayerButtons = document.querySelectorAll('[data-layer]');
const legendLockBtn = document.getElementById('legend-lock-btn');
const legendPopLayerNote = document.getElementById('legend-pop-layer-note');
const populationOverlayConfig = document.getElementById('population-overlay-config');
const populationLcoeWrapper = document.getElementById('population-lcoe-wrapper');
const populationSolarSlider = document.getElementById('population-solar-slider');
const populationSolarVal = document.getElementById('population-solar-val');
const populationBattSlider = document.getElementById('population-batt-slider');
const populationBattVal = document.getElementById('population-batt-val');
const popTargetCfSlider = document.getElementById('pop-target-cf-slider');
const popTargetCfVal = document.getElementById('pop-target-cf-val');
const popSolarCapexInput = document.getElementById('pop-solar-capex');
const popBatteryCapexInput = document.getElementById('pop-battery-capex');
const popSolarOpexInput = document.getElementById('pop-solar-opex');
const popBatteryOpexInput = document.getElementById('pop-battery-opex');
const popSolarDegradationInput = document.getElementById('pop-solar-degradation');
const popSolarLifeInput = document.getElementById('pop-solar-life');
const popBatteryLifeInput = document.getElementById('pop-battery-life');
const popWaccInput = document.getElementById('pop-wacc');
const popIlrInput = document.getElementById('pop-ilr');
const popTargetCfBackupNote = document.getElementById('pop-target-cf-backup-note');
const popDieselBackupInput = document.getElementById('pop-diesel-backup-toggle');
const popDieselBackupModeGroup = document.getElementById('pop-diesel-backup-mode-group');
const popDieselCapexInput = document.getElementById('pop-diesel-capex');
const popDieselEfficiencyInput = document.getElementById('pop-diesel-efficiency');
const popDieselLifeInput = document.getElementById('pop-diesel-life');
const popDieselPriceInput = document.getElementById('pop-diesel-price');
const popDieselSourceWrapper = document.getElementById('pop-diesel-source-wrapper');
const popDieselGlobalInputs = document.getElementById('pop-diesel-global-inputs');
const popCapexGlobalInputs = document.getElementById('pop-capex-global-inputs');
const popWaccGlobalInputs = document.getElementById('pop-wacc-global-inputs');
const dieselSourceButtons = document.querySelectorAll('#diesel-source-toggle button');
const popDieselSourceButtons = document.querySelectorAll('#pop-diesel-source-toggle button');
const popGasSourceWrapper = document.getElementById('pop-gas-source-wrapper');
const popGasGlobalInputs = document.getElementById('pop-gas-global-inputs');
const popGasCapexInput = document.getElementById('pop-gas-capex');
const popGasEfficiencyInput = document.getElementById('pop-gas-efficiency');
const popGasLifeInput = document.getElementById('pop-gas-life');
const popGasPriceInput = document.getElementById('pop-gas-price');
const popGasSourceButtons = document.querySelectorAll('#pop-gas-source-toggle button');
const lcoeControls = document.getElementById('lcoe-controls');
const lcoeTimePanel = document.getElementById('lcoe-time-panel');

// Charts
const mapShell = document.getElementById('map-shell');
const populationChartsContainer = document.getElementById('population-charts');
const populationChartHistogram = document.getElementById('population-chart-histogram');
const populationChartLatCombined = document.getElementById('population-chart-lat-combined');
const closeChartsBtn = document.getElementById('close-charts'); // New
const populationChartHistogramTitle = document.getElementById('population-chart-histogram-title');
const populationChartHistogramLabel = document.getElementById('population-chart-histogram-label');
const chartTitleDemandLatitude = document.getElementById('chart-title-demand-latitude');
const chartTitleSupplyLatitude = document.getElementById('chart-title-supply-latitude');

// Store original parent of LCOE controls for moving back and forth
let lcoeControlsOriginalParent = null;

let populationDisplayMode = 'map';
let populationCharts = {
    histogram: null,
    latCombined: null,
    metric: null
};

// World-map silhouette painted behind the combined latitude chart.
// Loaded once; the plugin re-rasters into an offscreen canvas whenever the chart area resizes.
let _chartWorldGeoJson = null;
const _worldMapBackgroundPlugin = {
    id: 'worldMapBackground',
    _cacheKey: null,
    _cache: null,
    beforeDatasetsDraw(chart) {
        if (!_chartWorldGeoJson || !window.d3) return;
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales || !scales.y) return;
        const yScale = scales.y;
        const top = yScale.getPixelForValue(90);
        const bottom = yScale.getPixelForValue(-90);
        const left = chartArea.left;
        const right = chartArea.right;
        const w = Math.max(1, Math.round(right - left));
        const h = Math.max(1, Math.round(bottom - top));
        const cacheKey = `${w}x${h}`;
        if (this._cacheKey !== cacheKey) {
            const off = document.createElement('canvas');
            off.width = w;
            off.height = h;
            const oc = off.getContext('2d');
            const transform = window.d3.geoTransform({
                point(lambda, phi) {
                    const x = ((lambda + 180) / 360) * w;
                    const y = (1 - (phi + 90) / 180) * h;
                    this.stream.point(x, y);
                }
            });
            const path = window.d3.geoPath(transform, oc);
            oc.fillStyle = DATA_COLOURS.hatchFill;
            oc.beginPath();
            path(_chartWorldGeoJson);
            oc.fill();
            this._cache = off;
            this._cacheKey = cacheKey;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, right - left, bottom - top);
        ctx.clip();
        ctx.drawImage(this._cache, left, top, w, h);
        ctx.restore();
    }
};
// Kick off geojson load once and trigger a redraw of the combined chart when it lands.
ensureWorldGeoJsonLoaded().then(gj => {
    _chartWorldGeoJson = gj;
    if (populationCharts && populationCharts.latCombined) {
        populationCharts.latCombined.update('none');
    }
}).catch(() => {});
let accessMetric = 'reliability';

// Charts container
const standardChartsContainer = document.getElementById('standard-charts-container');
let populationBaseLayer = 'population';
let populationOverlayMode = 'cf';
let populationFuelFilter = new Set(['coal', 'oil_gas', 'bioenergy', 'nuclear']);
let plantStatusFilter = 'announced'; // 'announced' or 'existing'

// Helpers
const sliceLength = () => (summarySlice ? summarySlice.n : 0);

/** Every row of the slice grouped by location, in slice order. Makes every row
 *  object, so only the debug evalConfig uses it. */
function buildLocationIndex() {
    const index = new Map();
    for (let i = 0; i < sliceLength(); i++) {
        const row = sliceRow(i);
        const arr = index.get(row.location_id);
        if (arr) arr.push(row);
        else index.set(row.location_id, [row]);
    }
    return index;
}

function getLocationIndex() {
    if (!locationIndex) locationIndex = buildLocationIndex();
    return locationIndex;
}

function getConfigKey(solarGw, battGwh) {
    return `s${solarGw}_b${battGwh}`;
}

/**
 * Row `i` of the slice on screen, made on first use and then reused, so every
 * consumer (map, tooltips, charts, worker merges) sees the same object, as when
 * the whole slice was rows. Every row is made by one object literal, so they
 * share one hidden class with the same field representations.
 */
function sliceRow(i) {
    const memo = sliceIndex.rows;
    let row = memo.get(i);
    if (row === undefined) {
        row = makeSliceRow(summarySlice, i);
        memo.set(i, row);
    }
    return row;
}

const COMBINED_NOTES = [null,
    'Offshore wind is not available here: no eligible sea',
    'Onshore wind is not available here: no eligible land'];

/** A row of a combined-build slice (combinedSlice): its own surface and both capacities. */
function makeCombinedRow(s, i) {
    const wind = s.wind[i], cf = s.cf[i];
    const code = s.surf[i];
    return {
        location_id: s.id[i], latitude: s.lat[i], longitude: s.lon[i], solar_gw: s.solar[i], wind_gw: wind,
        batt_gwh: s.batt[i], annual_cf: cf, curtailed_share: s.curt[i],
        wind_surface: code === SURF_BOTH ? 'both' : code === SURF_OFF ? 'off' : 'on',
        _solarKw: s.solar[i] * 1_000_000,
        _batteryKwh: s.batt[i] * 1_000_000,
        _windKw: (wind || 0) * 1_000_000,
        _annualEnergyMwh: cf * 8760 * BASE_LOAD_MW,
        wind_on_gw: s.won[i], wind_off_gw: s.woff[i],
        wind_note: COMBINED_NOTES[s.note[i]]
    };
}

function makeSliceRow(s, i) {
    if (s.surf) return makeCombinedRow(s, i);
    const latitude = s.lat[i];
    const longitude = s.lon[i];
    const solar = s.solar[i];
    const wind = s.wind[i];
    const batt = s.batt[i];
    const cf = s.cf[i];
    const curt = s.curt ? s.curt[i] : 0;
    // Rows without a position were never enriched, and are on no config's map.
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return {
            location_id: s.id[i], latitude, longitude, solar_gw: solar, wind_gw: wind, batt_gwh: batt,
            annual_cf: cf, curtailed_share: curt, wind_surface: s.surface
        };
    }
    return {
        location_id: s.id[i], latitude, longitude, solar_gw: solar, wind_gw: wind, batt_gwh: batt,
        annual_cf: cf, curtailed_share: curt, wind_surface: s.surface,
        _solarKw: solar * 1_000_000,
        _batteryKwh: batt * 1_000_000,
        _windKw: (wind || 0) * 1_000_000,
        _annualEnergyMwh: cf * 8760 * BASE_LOAD_MW
    };
}

/** First row of the slice for a location: the reference row LCOE answers are
 *  merged onto and the per-location context of the matrix search. */
function sliceFirstRow(locationId) {
    if (!sliceIndex) return undefined;
    const i = sliceIndex.firstIndexOf(locationId);
    return i < 0 ? undefined : sliceRow(i);
}

/** One { location_id, latitude, longitude } per location (the last row's
 *  position, as a map over all rows would keep), for the sample view. */
function sliceLocationPositions() {
    if (!sliceIndex) return [];
    if (!sliceIndex.positions) {
        const s = summarySlice;
        sliceIndex.positions = sliceIndex.locationIds.map((id) => {
            const i = sliceIndex.lastIndexOf(id);
            return { location_id: s.id[i], latitude: s.lat[i], longitude: s.lon[i] };
        });
    }
    return sliceIndex.positions;
}

/**
 * Per-location first/last row index. Location ids are small non-negative
 * integers, so typed tables do it; any other id goes through a Map.
 */
function locationTables(ids, n) {
    const SMALL = 1 << 16;
    const first = new Int32Array(SMALL).fill(-1);
    const last = new Int32Array(SMALL).fill(-1);
    const firstOther = new Map();
    const lastOther = new Map();
    const order = [];                 // ids by first appearance
    for (let i = 0; i < n; i++) {
        const id = ids[i];
        if (Number.isInteger(id) && id >= 0 && id < SMALL) {
            if (first[id] < 0) { first[id] = i; order.push(id); }
            last[id] = i;
        } else {
            if (!firstOther.has(id)) { firstOther.set(id, i); order.push(id); }
            lastOther.set(id, i);
        }
    }
    const lookup = (table, other) => (id) => {
        if (Number.isInteger(id) && id >= 0 && id < SMALL) return table[id];
        const i = other.get(id);
        return i === undefined ? -1 : i;
    };
    return { order, firstIndexOf: lookup(first, firstOther), lastIndexOf: lookup(last, lastOther) };
}

/**
 * Config buckets of a slice, in one pass: which rows (with a position) belong to
 * each (solar, battery) pair, in slice order, plus each bucket's CF sum, max and
 * count. Integer capacity columns are keyed through a table, anything else
 * through nested Maps; no per-row strings either way.
 */
function configBuckets(s) {
    const n = s.n;
    const { lat, lon, solar, batt, cf } = s;
    const small = (a) => a instanceof Int8Array || a instanceof Uint8Array;
    const table = small(solar) && small(batt) ? new Int32Array(1 << 16).fill(-1) : null;
    const nested = table ? null : new Map();
    const bucketOfRow = new Int32Array(n);
    const pairs = [];                 // [solar, batt] per bucket
    const counts = [];
    const sums = [];
    const maxes = [];
    const finiteCounts = [];
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(lat[i]) || !Number.isFinite(lon[i])) { bucketOfRow[i] = -1; continue; }
        const sv = solar[i];
        const bv = batt[i];
        let b;
        if (table) {
            const code = ((sv & 0xff) << 8) | (bv & 0xff);
            b = table[code];
            if (b < 0) { b = pairs.length; table[code] = b; }
        } else {
            let inner = nested.get(sv);
            if (!inner) { inner = new Map(); nested.set(sv, inner); }
            b = inner.get(bv);
            if (b === undefined) { b = pairs.length; inner.set(bv, b); }
        }
        if (b === pairs.length) {
            pairs.push([sv, bv]);
            counts.push(0); sums.push(0); maxes.push(-Infinity); finiteCounts.push(0);
        }
        bucketOfRow[i] = b;
        counts[b] += 1;
        const v = cf[i];
        if (Number.isFinite(v)) {
            sums[b] += v;
            if (v > maxes[b]) maxes[b] = v;
            finiteCounts[b] += 1;
        }
    }
    // Row indices grouped by bucket, slice order within each.
    const start = new Int32Array(pairs.length + 1);
    for (let b = 0; b < pairs.length; b++) start[b + 1] = start[b] + counts[b];
    const fill = start.slice(0, pairs.length);
    const rowsByBucket = new Int32Array(start[pairs.length]);
    for (let i = 0; i < n; i++) {
        const b = bucketOfRow[i];
        if (b >= 0) rowsByBucket[fill[b]++] = i;
    }
    const byKey = new Map();
    pairs.forEach(([sv, bv], b) => {
        const count = finiteCounts[b];
        byKey.set(getConfigKey(sv, bv), {
            start: start[b],
            end: start[b + 1],
            stats: { avg: count ? sums[b] / count : null, max: count ? maxes[b] : null, count }
        });
    });
    return { pairs, byKey, rowsByBucket };
}

/** Index the slice now on screen (wind level `wind` on `surface`). Replaces the
 *  previous slice's lookups. */
function indexSummarySlice(slice, wind, surface) {
    summarySlice = slice;
    summaryByConfig = new Map();
    summaryStatsByConfig = new Map();
    minBattBySolar = new Map();
    locationIndex = null;

    const loc = locationTables(slice.id, slice.n);
    const buckets = configBuckets(slice);
    sliceIndex = {
        wind,
        surface,
        pair: slice.pair || null,       // { on, off } for a combined build (T058)
        rows: new Map(),
        locationIds: loc.order,
        firstIndexOf: loc.firstIndexOf,
        lastIndexOf: loc.lastIndexOf,
        buckets: buckets.byKey,
        rowsByBucket: buckets.rowsByBucket,
        positions: null
    };

    // Smallest battery size that actually has data for each solar capacity.
    // Below this threshold no config was simulated (too little storage to firm
    // baseload), so the map would render empty.
    buckets.pairs.forEach(([solarGw, battGwh]) => {
        if (!Number.isFinite(solarGw) || !Number.isFinite(battGwh)) return;
        const prevMin = minBattBySolar.get(solarGw);
        if (prevMin === undefined || battGwh < prevMin) minBattBySolar.set(solarGw, battGwh);
    });
}

// ---------------------------------------------------------------------------
// Valid-configuration handling
//
// The grid is ragged in all three axes: with no wind, solar above 10 GW was only
// simulated with 18 GWh or more of storage; with wind, solar runs 0-10 GW. The
// manifest is the single source of truth, so a slider can never land on a
// configuration that was never simulated (which would render an empty map).
// ---------------------------------------------------------------------------

function validSetFor(surface, windGw) {
    if (!configManifest) return null;
    if (surface === 'both') {
        return currentWindPair && addonValidFor ? addonValidFor.get(`${currentWindPair.on}|${currentWindPair.off}`) || null : null;
    }
    return configManifest.validFor.get(`${(windGw || 0) === 0 ? 'on' : surface}|${windGw || 0}`) || null;
}

function nearestIn(list, value) {
    if (!list || !list.length) return value;
    let best = list[0];
    let bestD = Math.abs(list[0] - value);
    for (const v of list) {
        const d = Math.abs(v - value);
        if (d < bestD || (d === bestD && v < best)) { best = v; bestD = d; }
    }
    return best;
}

/** Snap (solar, battery) to the nearest simulated pair for this wind setting. */
function snapToValidConfig(surface, windGw, solarGw, battGwh) {
    const v = validSetFor(surface, windGw);
    if (!v) return { solar: solarGw, batt: battGwh };
    const solar = nearestIn(v.solarList, solarGw);
    const batts = v.battBySolar.get(solar) || v.battList;
    return { solar, batt: nearestIn(batts, battGwh) };
}

// Smallest battery value (MWh per MW baseload) that has simulated data for the
// given solar capacity, at the current wind setting.
function getMinBattForSolar(solarGw) {
    const v = validSetFor(currentSurface, currentWind);
    if (v) {
        const batts = v.battBySolar.get(solarGw);
        if (batts && batts.length) return batts[0];
    }
    const min = minBattBySolar.get(solarGw);
    return Number.isFinite(min) ? min : 0;
}

// Every location in the slice on screen, ascending: the matrix's row order.
// Ids are small integers, so a flag array does the dedupe; a Set takes the rest.
function matrixLocationIds() {
    const seen = new Uint8Array(1 << 16);
    const other = new Set();
    const ids = [];
    const col = summarySlice ? summarySlice.id : [];
    for (let i = 0; i < sliceLength(); i++) {
        const id = col[i];
        if (Number.isInteger(id) && id >= 0 && id < seen.length) {
            if (!seen[id]) { seen[id] = 1; ids.push(id); }
        } else {
            other.add(id);
        }
    }
    other.forEach(id => ids.push(id));
    return ids.sort((a, b) => a - b);
}

/**
 * Take in addon.json: the combined wind builds it simulates (for the sliders) and
 * the (solar, battery) pairs of each, laid out like configManifest.validFor.
 */
function indexAddonManifest(manifest) {
    const mix = manifest.sets.find(s => s.id === 'wind_mix');
    const pairs = new Set();
    const valid = new Map();
    (mix?.configs || []).forEach((c) => {
        const k = `${c.on}|${c.off}`;
        pairs.add(k);
        if (!valid.has(k)) valid.set(k, { solars: new Set(), batts: new Set(), bySolar: new Map() });
        const v = valid.get(k);
        v.solars.add(c.solar);
        v.batts.add(c.batt);
        if (!v.bySolar.has(c.solar)) v.bySolar.set(c.solar, new Set());
        v.bySolar.get(c.solar).add(c.batt);
    });
    valid.forEach((v) => {
        v.solarList = [...v.solars].sort((a, b) => a - b);
        v.battList = [...v.batts].sort((a, b) => a - b);
        v.battBySolar = new Map();
        v.bySolar.forEach((set, solar) => v.battBySolar.set(solar, [...set].sort((a, b) => a - b)));
    });
    addonManifest = manifest;
    addonPairsAll = pairs.size ? pairs : null;
    addonPairs = addonPairsAll;
    addonValidFor = valid;
}

/** What LOAD_MATRIX asks the loader for: the add-on, when there is one. */
function addonRequest() {
    return addonManifest ? { manifest: addonManifest, sets: addonManifest.sets.map(s => s.id) } : null;
}

let fullGridWanted = false;         // a cost view has asked for the full grid

/**
 * The cost views search the full three-axis grid, which only they need, so it
 * loads on first opening one: in the worker when there is one, otherwise here.
 * The background warm-up (T094) may have started the worker's load already.
 */
function ensureFullGridLoading() {
    if (!configManifest || !sliceLength()) return;
    fullGridWanted = true;
    if (lcoeWorkerUsable()) ensureLcoeWorkerReady();
    else buildCfMatrixOnMainThread();
}

/**
 * Without a worker, build the full capacity-factor matrix on the main thread, so
 * the main-thread search covers every wind level. Until it is done that search
 * uses the wind level on screen.
 */
function buildCfMatrixOnMainThread() {
    if (cfMatrixBuild || !configManifest) return cfMatrixBuild;
    // A worker that fails during the background warm-up (T094) leaves this
    // build to the first cost view: it is never started at idle.
    if (!fullGridWanted) return null;
    cfMatrixBuild = (async () => {
        try {
            cfMatrixProgress = { done: 0, total: summarySliceCount() };
            mainThreadGridBanner();
            const ids = matrixLocationIds();
            const m = await loadCfMatrix(configManifest.configs, ids, (done, total) => {
                cfMatrixProgress = { done, total };
                mainThreadGridBanner();
            });
            // The add-on (T058), decoded here too: the fallback searches what the worker does.
            m.addon = null;
            const request = addonRequest();
            if (request) {
                try {
                    m.addon = await loadAddon(request.manifest, ids, request.sets);
                    addonActive = m.addon ? Object.keys(m.addon.sets) : null;
                } catch (err) {
                    console.error('Add-on builds not used:', err?.message || err);
                }
                addonKnown = true;
                applyAddonUi();
            }
            cfMatrix = m;
            cfMatrixProgress = null;
            preGridNoWind = null;
            preGridCache = null;
            if (DEBUG_SNAPSHOT) publishDebugSnapshot(getSummaryStatsForConfig(currentSolar, currentBatt));
            if (currentViewMode === 'lcoe' || currentViewMode === 'population') updateModel();
            // Only now is the full grid really in use, so only now does the spinner go.
            setMapBusy('grid', false);
            setWindLoadingBanner(null);
            console.log(`CF matrix ready: ${cfMatrix.nLoc} locations x ${cfMatrix.nCfg} configs`);
        } catch (err) {
            cfMatrixProgress = null;
            cfMatrixFailed = true;
            mainThreadGridBanner();
            console.warn('Could not build the full configuration matrix; cost views will '
                + 'search only the builds without wind and at the wind level on screen.', err);
        }
    })();
    return cfMatrixBuild;
}

/** The spinner while the main thread builds the grid (no worker), or the banner after that failed. */
function mainThreadGridBanner() {
    if (cfMatrix || (!cfMatrixProgress && !cfMatrixFailed)) return;
    if (cfMatrixFailed) {
        setMapBusy('grid', false);
        setWindLoadingBanner(`Could not load all wind configurations; cost maps ${preGridScope()}.`);
        return;
    }
    setMapBusy('grid', true);
}

/** What the pre-grid search covers, for the banner: see preGridMatrix. */
function preGridScope() {
    // A combined build on screen: preGridMatrix searches the builds without wind only.
    if (sliceIndex?.pair) return 'show solar and batteries only';
    const wind = sliceIndex ? sliceIndex.wind : 0;
    const off = sliceIndex?.surface === 'off';
    if (!wind || (off && lcoeParams.includeOffshore === false)) return 'show solar and batteries only';
    const level = `${wind} MW of ${off ? 'offshore' : 'onshore'} wind per MW of load`;
    if (preGridNoWind === 'failed') return `show only builds with ${level}`;
    return `compare solar and batteries with and without ${level}`;
}

/**
 * The builds the main thread can search before the full grid has loaded, laid
 * out as the full grid is, so the same search code (and so the same rules)
 * runs on both: the slice on screen and, on a wind level, the no-wind slice,
 * which is loaded for this. Null while that load runs; the caller then keeps
 * what is drawn, and the load redraws.
 */
function preGridMatrix() {
    if (!configManifest || !summarySlice || !sliceIndex) return null;
    // A combined build on screen (T058) keeps no slice of its own: until the full
    // grid loads, the search covers the builds without wind.
    const slices = summarySlice.surf ? [] : [summarySlice];
    if (sliceIndex.wind > 0) {
        if (!preGridNoWind) {
            loadPreGridNoWind();
            return null;
        }
        if (preGridNoWind !== 'failed') slices.push(preGridNoWind);
    }
    if (!slices.length) return null;
    if (preGridCache && preGridCache.slice === slices[0] && preGridCache.n === slices.length) return preGridCache.m;
    const m = partialMatrix(slices, matrixLocationIds());
    m.unitCfg = unitConfigIndices(m);
    // A wind level above 1 MW lacks 1 MW of wind alone, whose capacity factor
    // weights degradation; the wind resource file holds the same figure (to 6
    // decimals rather than the slices' 4). Blank there means no viable site,
    // which the slices hold as 0.
    m.unitCf = (li) => {
        const u = matrixUnitCf(m, li);
        if (m.unitCfg.on < 0 || m.unitCfg.off < 0) {
            const r = windResourceMap.get(m.locationIds[li]);
            if (m.unitCfg.on < 0) u.on = r ? (Number.isFinite(r.on_final_cf) ? r.on_final_cf : 0) : NaN;
            if (m.unitCfg.off < 0) u.off = r ? (Number.isFinite(r.off_final_cf) ? r.off_final_cf : 0) : NaN;
        }
        return u;
    };
    preGridCache = { slice: slices[0], n: slices.length, m };
    return m;
}

function loadPreGridNoWind() {
    if (preGridNoWindLoad) return;
    preGridNoWindLoad = loadSummarySlice('on', 0, { offThread: FEATURE_WORKER_LCOE })
        .then((slice) => {
            const { file, n, id, solar, wind, batt, cf } = slice;
            preGridNoWind = { file, n, id, solar, wind, batt, cf };
        }, (err) => {
            console.warn('Could not load the no-wind slice; until the full grid loads, cost maps search '
                + 'only the wind level on screen.', err);
            preGridNoWind = 'failed';
        })
        .finally(() => {
            preGridNoWindLoad = null;
            if (cfMatrix) {
                preGridNoWind = null;
                return;
            }
            mainThreadGridBanner();
            if (currentViewMode === 'lcoe' || currentViewMode === 'population') updateModel();
        });
}

/**
 * The grid restricted to the configs of `slices` (summary slices as columns),
 * in config order, with the layout loadCfMatrix gives the full grid.
 */
function partialMatrix(slices, locationIds) {
    const files = new Set(slices.map(sl => sl.file));
    const cfgs = configManifest.configs.filter(c => files.has(c.summary)).sort((a, b) => a.i - b.i);
    const nLoc = locationIds.length;
    const nCfg = cfgs.length;
    const m = {
        cf: new Float32Array(nLoc * nCfg), nLoc, nCfg,
        solarGw: new Int8Array(nCfg), windGw: new Int8Array(nCfg), battGwh: new Int8Array(nCfg),
        surfaceOff: new Uint8Array(nCfg), locationIds: Int32Array.from(locationIds),
        unitCfg: null, unitCf: null
    };
    const locIndex = new Map();
    locationIds.forEach((id, i) => locIndex.set(id, i));
    cfgs.forEach((c, k) => {
        m.solarGw[k] = c.solar;
        m.windGw[k] = c.wind;
        m.battGwh[k] = c.batt;
        m.surfaceOff[k] = (c.wind > 0 && c.surface === 'off') ? 1 : 0;
    });
    for (const sl of slices) {
        const idxByTriple = new Map();
        cfgs.forEach((c, k) => {
            if (c.summary === sl.file) idxByTriple.set((c.solar << 16) | (c.wind << 8) | c.batt, k);
        });
        for (let r = 0; r < sl.n; r++) {
            const li = locIndex.get(Number(sl.id[r]));
            if (li === undefined) continue;
            const k = idxByTriple.get((sl.solar[r] << 16) | (sl.wind[r] << 8) | sl.batt[r]);
            if (k === undefined) continue;
            m.cf[li * nCfg + k] = sl.cf[r];
        }
    }
    return m;
}

/** Number of summary files the full grid is read from (the banner's total). */
function summarySliceCount() {
    return configManifest ? new Set(configManifest.configs.map(c => c.summary)).size : 0;
}

/**
 * A spinner in the middle of the map while a cost view waits: for the full grid
 * ('grid', loaded once in the background) or for a search whose result is not on
 * screen yet ('lcoe'). The grid can still be loading after leaving the cost
 * views, so that reason only shows on them; updateViewMode re-renders on a switch.
 */
const mapBusyReasons = new Set();

function setMapBusy(reason, on) {
    if (on) mapBusyReasons.add(reason);
    else mapBusyReasons.delete(reason);
    renderMapBusy();
}

function renderMapBusy() {
    const costView = currentViewMode === 'lcoe' || currentViewMode === 'population';
    const show = mapBusyReasons.has('lcoe') || (costView && mapBusyReasons.has('grid'));
    let el = document.getElementById('map-busy');
    if (!show) {
        if (el) el.remove();
        return;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = 'map-busy';
        el.setAttribute('role', 'status');
        el.innerHTML = '<div class="map-busy__spinner"></div><div class="map-busy__label"></div>';
        (mapShell || document.body).appendChild(el);
    }
    el.querySelector('.map-busy__label').textContent =
        currentViewMode === 'population' ? 'Loading costs…' : 'Loading the LCOE map…';
}

/**
 * A small banner under the view tabs when the full grid could not be loaded, so
 * a cost map is never mistaken for the final answer while it is partial.
 */
function setWindLoadingBanner(text) {
    let el = document.getElementById('wind-loading-banner');
    if (!text) {
        if (el) el.remove();
        return;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = 'wind-loading-banner';
        el.className = 'fixed top-16 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 rounded-md '
            + 'bg-black/80 border border-white/10 text-[11px] text-gray-200 shadow-lg pointer-events-none';
        document.body.appendChild(el);
    }
    el.textContent = text;
}

/**
 * Switch to a different wind level or surface: load that summary slice, snap the
 * other two sliders onto it, and rebuild the indices the map reads.
 */
// Wind switches still loading, by request id. The newest one that has not
// failed owns the screen: its slice is drawn when it arrives, and an older one
// that arrives first is dropped. If the owner fails, the newest older one still
// loading takes over; with none left, the controls go back to the slice on screen.
let windConfigRequest = 0;
let windConfigApplied = 0;              // id of the last request whose slice was drawn
const windConfigPending = new Map();    // id -> { wind, surface }

function newestPendingWindRequest(below = Infinity) {
    let best = 0;
    windConfigPending.forEach((_, id) => { if (id < below && id > best) best = id; });
    return best;
}

/** Point the wind controls (and currentWind/currentSurface) at a wind level. */
function showWindControls(wind, surface, pair = null) {
    currentWind = wind;
    currentSurface = surface;
    currentWindPair = surface === 'both' ? pair : null;
    syncCapacitySliders();
}

async function setWindConfig(windGw, surface, pair = null) {
    if (!configManifest) return;
    const nextSurface = (windGw || 0) === 0 ? 'on' : surface;
    const nextPair = nextSurface === 'both' ? pair : null;
    const samePair = (a, b) => (!a && !b) || (a && b && a.on === b.on && a.off === b.off);
    if (windGw === currentWind && nextSurface === currentSurface && samePair(nextPair, currentWindPair)) return;

    const request = ++windConfigRequest;
    windConfigPending.set(request, { wind: windGw, surface: nextSurface, pair: nextPair });
    currentWind = windGw;
    currentSurface = nextSurface;
    currentWindPair = nextPair;
    if (loadingStatus) loadingStatus.textContent = 'Loading wind configuration...';
    if (loading) loading.classList.remove('hidden');
    let slice;
    try {
        if (nextSurface === 'both') {
            try {
                slice = await loadCombinedSlice(nextPair);
            } catch (err) {
                // The combined build's rows could not be used (missing file, SHA-256 mismatch):
                // stop offering combined builds.
                addonPairsFailed = true;
                applyAddonUi();
                throw err;
            }
        } else {
            // Back to one surface: only the slice on screen is kept again.
            if (combinedSliceCache) { setSliceCacheMax(1); combinedSliceCache = null; addonPairLoads.clear(); }
            slice = await loadSummarySlice(nextSurface, windGw, { offThread: FEATURE_WORKER_LCOE });
        }
    } catch (err) {
        console.error('Could not load that wind configuration:', err);
        windConfigPending.delete(request);
        // A later switch is loading or already drawn: it owns the controls.
        if (newestPendingWindRequest() > request || windConfigApplied > request) return;
        const note = document.getElementById('wind-note');
        if (note) note.textContent = 'That wind level is not available in this data set.';
        const older = newestPendingWindRequest(request);
        if (older) {
            // An earlier switch is still loading and now owns the screen.
            const target = windConfigPending.get(older);
            showWindControls(target.wind, target.surface, target.pair);
            return;
        }
        // Put the controls back where the data actually is, so the slider can
        // never claim a wind level the map is not showing.
        showWindControls(sliceIndex.wind, sliceIndex.surface, sliceIndex.pair);
        if (loading) loading.classList.add('hidden');
        return;
    }
    windConfigPending.delete(request);
    // A later switch is loading or already drawn: that one owns the screen.
    if (newestPendingWindRequest() > request || windConfigApplied > request) return;
    windConfigApplied = request;
    currentWind = windGw;
    currentSurface = nextSurface;
    currentWindPair = nextPair;
    try {
        // The location index and every other per-slice lookup now follow this slice.
        indexSummarySlice(slice, windGw, nextSurface);
        preGridCache = null;
        mainThreadGridBanner();
        const snapped = snapToValidConfig(currentSurface, currentWind, currentSolar, currentBatt);
        currentSolar = snapped.solar;
        currentBatt = snapped.batt;
        syncCapacitySliders();
        updateWindNote();
        updateModel();
    } catch (err) {
        console.error('Could not show that wind configuration:', err);
    } finally {
        if (loading) loading.classList.add('hidden');
    }
}

// ---------------------------------------------------------------------------
// Combined onshore + offshore builds on the capacity map (T058, D-124). Regions
// with both land and sea draw the add-on's combined build; regions with only one
// draw that surface's slice (the tooltip says the other is unavailable); regions
// with neither draw the onshore slice, hatched as today. Both slices are kept
// while a combined build is on screen (SLICE_CACHE_MAX 2), plus the one build's
// add-on rows, decoded off-thread.
// ---------------------------------------------------------------------------
let combinedSliceCache = null;           // { key, slice }
const addonPairLoads = new Map();        // 'on|off' -> promise of its columns

function loadAddonPairCached(pair) {
    const key = `${pair.on}|${pair.off}`;
    if (!addonPairLoads.has(key)) {
        // The LCOE worker (or the ?worker=0 matrix) already holds the whole wind_mix
        // set once a cost view has loaded it: take the rows from there rather than
        // fetching and decoding the file a second time.
        let p;
        if (cfMatrix?.addon?.sets?.wind_mix) {
            p = Promise.resolve(addonPairColumns(cfMatrix.addon.sets.wind_mix, cfMatrix.locationIds, pair.on, pair.off));
        } else if (lcoeWorkerUsable() && lcoeWorkerMatrixReady && addonActive?.includes('wind_mix')) {
            p = postLcoeWorkerMessage('ADDON_PAIR', { on: pair.on, off: pair.off }, 30000)
                .catch(() => loadAddonPair(addonManifest, pair.on, pair.off, { offThread: FEATURE_WORKER_LCOE }));
        } else {
            p = loadAddonPair(addonManifest, pair.on, pair.off, { offThread: FEATURE_WORKER_LCOE });
        }
        p.catch(() => addonPairLoads.delete(key));
        // Keep only the latest pair's rows.
        addonPairLoads.forEach((_, k) => { if (k !== key) addonPairLoads.delete(k); });
        addonPairLoads.set(key, p);
    }
    return addonPairLoads.get(key);
}

async function loadCombinedSlice(pair) {
    if (!addonManifest || !pair) throw new Error('combined wind builds need addon.json');
    const key = `${pair.on}|${pair.off}`;
    if (combinedSliceCache?.key === key) return combinedSliceCache.slice;
    setSliceCacheMax(2);
    const offThread = { offThread: FEATURE_WORKER_LCOE };
    const [onSlice, offSlice, rows] = await Promise.all([
        loadSummarySlice('on', pair.on, offThread),
        loadSummarySlice('off', pair.off, offThread),
        loadAddonPairCached(pair)
    ]);
    const slice = combinedSlice(onSlice, offSlice, rows, pair);
    combinedSliceCache = { key, slice };
    // The combined slice holds what it draws: let the two slices and the add-on rows go.
    setSliceCacheMax(0);
    addonPairLoads.clear();
    return slice;
}

const SURF_ON = 0, SURF_OFF = 1, SURF_BOTH = 2;

/**
 * The capacity map's slice for a combined build, laid out as a summary slice
 * (columns, in the onshore slice's location order) with per-row surface codes:
 * the add-on rows where a region has them, else the surface it has.
 */
function combinedSlice(onSlice, offSlice, add, pair) {
    const groups = (sl) => {
        const m = new Map();
        for (let i = 0; i < sl.n; i++) {
            const id = Number(sl.id[i]);
            let g = m.get(id);
            if (!g) { g = []; m.set(id, g); }
            g.push(i);
        }
        return m;
    };
    const onRows = groups(onSlice);
    const offRows = groups(offSlice);
    const addRows = new Map();
    for (let i = 0; i < add.n; i++) {
        const id = add.id[i];
        let g = addRows.get(id);
        if (!g) { g = []; addRows.set(id, g); }
        g.push(i);
    }
    // Which rows each region draws, in the onshore slice's location order.
    const plan = [];
    let n = 0;
    onRows.forEach((idx, id) => {
        const site = windResourceMap.get(id);
        let src = 'on';
        if (addRows.has(id)) src = 'both';
        else if (site && !site.on_viable && site.off_viable && offRows.has(id)) src = 'off';
        const rows = src === 'both' ? addRows.get(id) : src === 'off' ? offRows.get(id) : idx;
        plan.push({ id, src, rows, pos: idx[idx.length - 1], landOnly: src === 'on' && Boolean(site?.on_viable) });
        n += rows.length;
    });
    const out = {
        file: null, n, surface: 'both', pair: { ...pair },
        // The slices' own column types (int32 ids, float32 positions), so the rows hold the same values.
        id: new onSlice.id.constructor(n), lat: new onSlice.lat.constructor(n), lon: new onSlice.lon.constructor(n),
        solar: new Int8Array(n), wind: new Int8Array(n), batt: new Int8Array(n),
        cf: new Float32Array(n), curt: new Float32Array(n),
        surf: new Uint8Array(n), won: new Int8Array(n), woff: new Int8Array(n), note: new Uint8Array(n)
    };
    let k = 0;
    for (const p of plan) {
        const lat = onSlice.lat[p.pos], lon = onSlice.lon[p.pos];
        for (const i of p.rows) {
            out.id[k] = p.id;
            if (p.src === 'both') {
                out.lat[k] = lat; out.lon[k] = lon;
                out.solar[k] = add.solar[i]; out.batt[k] = add.batt[i];
                out.wind[k] = pair.on + pair.off; out.won[k] = pair.on; out.woff[k] = pair.off;
                out.cf[k] = add.cf[i]; out.curt[k] = add.curt[i]; out.surf[k] = SURF_BOTH;
            } else {
                const sl = p.src === 'off' ? offSlice : onSlice;
                out.lat[k] = sl.lat[i]; out.lon[k] = sl.lon[i];
                out.solar[k] = sl.solar[i]; out.batt[k] = sl.batt[i]; out.wind[k] = sl.wind[i];
                out.won[k] = p.src === 'off' ? 0 : sl.wind[i]; out.woff[k] = p.src === 'off' ? sl.wind[i] : 0;
                out.cf[k] = sl.cf[i]; out.curt[k] = sl.curt ? sl.curt[i] : 0;
                out.surf[k] = p.src === 'off' ? SURF_OFF : SURF_ON;
                // 1: land only (no eligible sea), 2: sea only (no eligible land).
                out.note[k] = p.src === 'off' ? 2 : p.landOnly ? 1 : 0;
            }
            k++;
        }
    }
    return out;
}

/** Push currentSolar / currentWind / currentBatt back into every slider. */
function syncCapacitySliders() {
    const pairs = [
        ['solar-slider', 'solar-val', currentSolar],
        ['pop-solar-slider', 'pop-solar-val', currentSolar],
        ['batt-slider', 'batt-val', currentBatt],
        ['pop-batt-slider', 'pop-batt-val', currentBatt],
    ];
    pairs.forEach(([sliderId, valId, value]) => {
        const slider = document.getElementById(sliderId);
        const label = document.getElementById(valId);
        if (slider && slider.value !== String(value)) slider.value = value;
        if (label) label.textContent = value;
    });
    showWindSliders(currentWind, currentSurface);
    const v = validSetFor(currentSurface, currentWind);
    if (v) {
        ['solar-slider', 'pop-solar-slider'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.min = v.solarList[0]; el.max = v.solarList[v.solarList.length - 1]; }
        });
        const batts = v.battBySolar.get(currentSolar) || v.battList;
        ['batt-slider', 'pop-batt-slider'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.min = batts[0]; el.max = batts[batts.length - 1]; }
        });
    }
}

// Constrain the battery sliders so the user cannot select a value below the
// smallest simulated config for the current solar capacity (which would yield
// an empty map). Returns the (possibly raised) battery value.
function applyBattConstraint(solarGw) {
    const minBatt = getMinBattForSolar(solarGw);
    const popBattSlider = document.getElementById('pop-batt-slider');
    const popBattVal = document.getElementById('pop-batt-val');
    [battSlider, popBattSlider].forEach(slider => {
        if (slider) slider.min = minBatt;
    });
    if (currentBatt < minBatt) {
        currentBatt = minBatt;
        if (battVal) battVal.textContent = minBatt;
        if (battSlider) battSlider.value = minBatt;
        if (popBattSlider) popBattSlider.value = minBatt;
        if (popBattVal) popBattVal.textContent = minBatt;
    }
    return currentBatt;
}

function buildConfigBucket(key) {
    const bucket = sliceIndex ? sliceIndex.buckets.get(key) : undefined;
    const rows = [];
    if (bucket) {
        const idx = sliceIndex.rowsByBucket;
        for (let k = bucket.start; k < bucket.end; k++) rows.push(sliceRow(idx[k]));
    }
    summaryByConfig.set(key, rows);
    summaryStatsByConfig.set(key, bucket ? bucket.stats : { avg: null, max: null, count: 0 });
}

function getSummaryForConfig(solarGw, battGwh) {
    const key = getConfigKey(solarGw, battGwh);
    if (!summaryByConfig.has(key)) buildConfigBucket(key);
    return summaryByConfig.get(key) || [];
}

function getSummaryStatsForConfig(solarGw, battGwh) {
    const key = getConfigKey(solarGw, battGwh);
    if (!summaryStatsByConfig.has(key)) buildConfigBucket(key);
    return summaryStatsByConfig.get(key) || null;
}

const ALL_LEGENDS = [
    legendCapacity,
    legendCompDrought,
    legendCompScore,
    legendPotential,
    legendLcoe,
    legendPopulation,
    legendElectricity,
    legendAccess,
    legendSupplyCapacity,
    legendSupplyLcoe,
    legendSupplyPotential
];

function hideAllLegends() {
    ALL_LEGENDS.forEach(legend => {
        if (legend) legend.classList.add('hidden');
    });
    if (legendSupplyStack) legendSupplyStack.classList.add('hidden');
}

function hidePopulationLegends() {
    [legendPopulation, legendElectricity, legendAccess].forEach(legend => {
        if (legend) legend.classList.add('hidden');
    });
}

function hideSupplyLegends() {
    [legendSupplyCapacity, legendSupplyLcoe, legendSupplyPotential].forEach(legend => {
        if (legend) legend.classList.add('hidden');
    });
    if (legendSupplyStack) legendSupplyStack.classList.add('hidden');
}

// Note: capitalizeWord, haversineKm, coordKey, formatNumber, formatCurrency imported from utils.js
// capitalRecoveryFactor is imported from map.js

function clampCf(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function getDieselInfoForRow(row) {
    if (!dieselMap || !dieselMap.size) return null;
    return dieselMap.get(row.location_id) || null;
}

function getGasInfoForRow(row) {
    if (!gasMap || !gasMap.size) return null;
    return gasMap.get(row.location_id) || null;
}

function computeEffectiveDieselPriceUsdPerLiter(dieselInfo, params) {
    const priceMode = params?.dieselPriceMode || dieselPriceMode;
    if (priceMode === 'global') {
        const globalPrice = Number.isFinite(params?.dieselPrice) ? params.dieselPrice : null;
        return {
            rawPrice: globalPrice,
            effectivePrice: globalPrice
        };
    }
    const rawPrice = Number.isFinite(dieselInfo?.rawPrice ?? dieselInfo?.price)
        ? (dieselInfo?.rawPrice ?? dieselInfo?.price)
        : null;
    const effectivePrice = Number.isFinite(rawPrice)
        ? Math.max(rawPrice, DIESEL_PRICE_FLOOR_USD_PER_LITER)
        : null;
    return {
        rawPrice,
        effectivePrice
    };
}

function computeDieselFuelCostPerMwh(dieselPriceUsdPerLiter, params) {
    const efficiency = Number.isFinite(params.dieselEfficiency) && params.dieselEfficiency > 0
        ? params.dieselEfficiency
        : null;
    if (!Number.isFinite(dieselPriceUsdPerLiter) || !efficiency) {
        return Infinity;
    }
    return (dieselPriceUsdPerLiter * 1000) / (efficiency * DIESEL_THERMAL_KWH_PER_LITER);
}

function computeEffectiveGasPriceUsdPerMmbtu(gasInfo, params) {
    const priceMode = params?.gasPriceMode || gasPriceMode;
    if (priceMode === 'global') {
        const globalPrice = Number.isFinite(params?.gasPrice) ? params.gasPrice : null;
        return { rawPrice: globalPrice, effectivePrice: globalPrice };
    }
    const rawPrice = Number.isFinite(gasInfo?.rawPrice ?? gasInfo?.price)
        ? (gasInfo?.rawPrice ?? gasInfo?.price)
        : null;
    return { rawPrice, effectivePrice: rawPrice };
}

function computeGasFuelCostPerMwh(gasPriceUsdPerMmbtu, params) {
    const efficiency = Number.isFinite(params.gasEfficiency) && params.gasEfficiency > 0
        ? params.gasEfficiency
        : null;
    if (!Number.isFinite(gasPriceUsdPerMmbtu) || !efficiency) {
        return Infinity;
    }
    return (gasPriceUsdPerMmbtu * MMBTU_PER_MWH) / efficiency;
}

// Degradation factor on the energy of a solar + wind build (T013). Each source
// loses output at its own rate, so the factor on their combined energy is the
// average of the two factors weighted by each source's share of that energy:
// its capacity times the location's capacity factor for 1 GW of it alone.
// Where those capacity factors are unknown, capacity shares stand in.
// Identical in workers/lcoe-worker.js.
function blendedDegradation(solarKw, windKw, solarCf, windCf, solarMult, windMult) {
    let s = solarKw * solarCf;
    let w = windKw * windCf;
    if (!(s + w > 0)) { s = solarKw; w = windKw; }
    return (s * solarMult + w * windMult) / (s + w);
}

/**
 * Config indices of 1 GW of solar, onshore wind and offshore wind alone, no
 * battery (-1 where the grid lacks one). Their capacity factors at a location
 * are what 1 GW of each source delivers there. Identical in the worker.
 */
function unitConfigIndices(m) {
    const { solarGw, windGw, battGwh, surfaceOff, nCfg } = m;
    const u = { solar: -1, on: -1, off: -1 };
    for (let ci = 0; ci < nCfg; ci++) {
        if (battGwh[ci] !== 0) continue;
        if (solarGw[ci] === 1 && windGw[ci] === 0 && u.solar < 0) u.solar = ci;
        if (solarGw[ci] === 0 && windGw[ci] === 1) {
            if (surfaceOff[ci]) { if (u.off < 0) u.off = ci; } else if (u.on < 0) u.on = ci;
        }
    }
    return u;
}

/** The location's capacity factors for 1 GW of each source alone (NaN if not in the grid). */
function matrixUnitCf(m, li) {
    const u = m.unitCfg;
    const base = li * m.nCfg;
    return {
        solar: u.solar >= 0 ? m.cf[base + u.solar] : NaN,
        on: u.on >= 0 ? m.cf[base + u.on] : NaN,
        off: u.off >= 0 ? m.cf[base + u.off] : NaN
    };
}

// Per-location constants for LCOE. All rows sharing a location_id share these,
// so we compute once per location instead of once per row.
// `unitCf` holds the location's capacity factors for 1 GW of solar, onshore
// wind and offshore wind alone (matrixUnitCf), which weight degradation.
function precomputeLcoePerLocation(sampleRow, params, unitCf) {
    const localWacc = getRowWacc(sampleRow);
    const localCapex = getRowCapex(sampleRow);
    const dieselInfo = getDieselInfoForRow(sampleRow);
    const gasInfo = getGasInfoForRow(sampleRow);
    const resolvedWacc = Number.isFinite(localWacc) ? localWacc : params.wacc;

    const hasLocalSolar = Number.isFinite(localCapex?.solar);
    const hasLocalBattery = Number.isFinite(localCapex?.battery);
    const baseSolarCapex = hasLocalSolar
        ? localCapex.solar
        : params.solarCapex * (lcoeCostMultipliers.solar || 1);
    const baseBatteryCapex = hasLocalBattery
        ? localCapex.battery
        : params.batteryCapex * (lcoeCostMultipliers.battery || 1);
    const ilr = Number.isFinite(params.ilr) && params.ilr > 0 ? params.ilr : 1;
    const solarCapexPerKw = baseSolarCapex / ilr;

    const baseWindOnCapex = Number.isFinite(localCapex?.windOn)
        ? localCapex.windOn
        : params.windCapex * (lcoeCostMultipliers.wind || 1);
    const baseWindOffCapex = Number.isFinite(localCapex?.windOff)
        ? localCapex.windOff
        : params.windOffCapex * (lcoeCostMultipliers.windOff || 1);
    // Local capex mode prices wind O&M per cell in $/kW/yr (T024: IRENA tables
    // A3/A5 by country, DEA trends). The engine takes O&M as a share of capex,
    // so it is converted here; global mode keeps the input shares. Same rule as
    // the worker.
    const windOpexPct = Number.isFinite(localCapex?.windOn) && Number.isFinite(localCapex?.windOnOm)
        ? localCapex.windOnOm / baseWindOnCapex
        : params.windOpexPct;
    const windOffOpexPct = Number.isFinite(localCapex?.windOff) && Number.isFinite(localCapex?.windOffOm)
        ? localCapex.windOffOm / baseWindOffCapex
        : params.windOffOpexPct;
    // Wind cost of capital follows the WACC setting (T011): local mode takes the
    // cell's onshore and offshore figures; global mode, or a cell the wind file
    // lacks, takes the WACC plus the premium inputs. Same rule as the worker.
    const localWindWacc = getRowWindWacc(sampleRow);
    const windOnWacc = Number.isFinite(localWindWacc?.on)
        ? localWindWacc.on
        : resolvedWacc + (params.windWaccPremium || 0);
    const windOffWacc = Number.isFinite(localWindWacc?.off)
        ? localWindWacc.off
        : resolvedWacc + (params.windOffWaccPremium || 0);
    const windOnCrf = capitalRecoveryFactor(windOnWacc, params.windLife);
    const windOffCrf = capitalRecoveryFactor(windOffWacc, params.windOffLife);
    // Turbine output degradation, like PV's, discounted at the wind rate over the wind life.
    const windOnDegradationMult = levelizedGrowthMultiplier(-(params.windDegradationPct || 0), windOnWacc, params.windLife);
    const windOffDegradationMult = levelizedGrowthMultiplier(-(params.windOffDegradationPct || 0), windOffWacc, params.windOffLife);

    const solarCrf = capitalRecoveryFactor(resolvedWacc, params.solarLife);
    const batteryCrf = capitalRecoveryFactor(resolvedWacc, params.batteryLife);
    const solarOpexPct = params.solarOpexPct;
    const batteryOpexPct = params.batteryOpexPct;
    // PV degradation, as a level-equivalent factor on the energy denominator.
    const energyDegradationMult = levelizedGrowthMultiplier(-(params.solarDegradationPct || 0), resolvedWacc, params.solarLife);

    const includeDieselBackup = Boolean(params.includeDieselBackup);
    let dieselPricing = null;
    let dieselFuelCostPerMwh = 0;
    let dieselCapexAnnual = 0;
    let dieselContext = null;
    let gasAvailable = false;
    let gasPricing = null;
    let gasFuelCostPerMwh = Infinity;
    let gasCapexAnnual = 0;
    let gasContext = null;
    if (includeDieselBackup) {
        dieselPricing = computeEffectiveDieselPriceUsdPerLiter({
            rawPrice: dieselInfo?.rawPrice ?? dieselInfo?.price ?? null,
            sourceType: dieselInfo?.sourceType ?? null
        }, params);
        dieselFuelCostPerMwh = computeDieselFuelCostPerMwh(dieselPricing.effectivePrice, params);
        const dieselCapex = BASE_LOAD_MW * 1000 * params.dieselCapex;
        const dieselCrf = capitalRecoveryFactor(resolvedWacc, params.dieselLife);
        dieselCapexAnnual = dieselCapex * dieselCrf;
        dieselContext = {
            sourceYear: dieselInfo?.sourceYear ?? null,
            sourceType: dieselInfo?.sourceType ?? null,
            sourceDistanceKm: dieselInfo?.sourceDistanceKm ?? null,
            sourceIso3: dieselInfo?.sourceIso3 ?? null,
            sourceCountry: dieselInfo?.sourceCountry ?? null,
            sourceSeriesName: dieselInfo?.sourceSeriesName ?? null
        };

        gasAvailable = Boolean(gasInfo?.available);
        if (gasAvailable) {
            gasPricing = computeEffectiveGasPriceUsdPerMmbtu({
                rawPrice: gasInfo?.rawPrice ?? gasInfo?.price ?? null
            }, params);
            gasFuelCostPerMwh = computeGasFuelCostPerMwh(gasPricing.effectivePrice, params);
            const gasCapex = BASE_LOAD_MW * 1000 * params.gasCapex;
            const gasCrf = capitalRecoveryFactor(resolvedWacc, params.gasLife);
            gasCapexAnnual = gasCapex * gasCrf;
            gasContext = {
                priceUsdPerMmbtu: gasPricing.effectivePrice,
                sourceIso3: gasInfo?.sourceIso3 ?? null,
                sourceCountry: gasInfo?.sourceCountry ?? null,
                sourceDistanceKm: gasInfo?.sourceDistanceKm ?? null
            };
        }
    }

    return {
        includeDieselBackup,
        solarCapexPerKw,
        baseWindOnCapex,
        baseWindOffCapex,
        windOnCrf,
        windOffCrf,
        windOpexPct,
        windOffOpexPct,
        baseBatteryCapex,
        solarCrf,
        batteryCrf,
        solarOpexPct,
        batteryOpexPct,
        energyDegradationMult,
        windOnDegradationMult,
        windOffDegradationMult,
        solarUnitCf: unitCf ? unitCf.solar : NaN,
        windOnUnitCf: unitCf ? unitCf.on : NaN,
        windOffUnitCf: unitCf ? unitCf.off : NaN,
        dieselPricing,
        dieselFuelCostPerMwh,
        dieselCapexAnnual,
        dieselContext,
        gasAvailable,
        gasPricing,
        gasFuelCostPerMwh,
        gasCapexAnnual,
        gasContext
    };
}

function computeLcoeMetricsFast(row, pre) {
    const solarKw = Number.isFinite(row._solarKw) ? row._solarKw : row.solar_gw * 1_000_000;
    const batteryKwh = Number.isFinite(row._batteryKwh) ? row._batteryKwh : row.batt_gwh * 1_000_000;
    const solarShareCf = clampCf(row.annual_cf);
    const includeDieselBackup = pre.includeDieselBackup;
    const firmCf = includeDieselBackup ? 1 : solarShareCf;
    // Set below with backup on: the backup's energy over the full load.
    let dieselShareCf = 0;

    const windKw = Number.isFinite(row._windKw) ? row._windKw : (row.wind_gw || 0) * 1_000_000;
    const offshore = row.wind_surface === 'off';
    // A combined onshore + offshore add-on build (T058): never a configs.json row.
    const both = row.wind_surface === 'both';

    const solarCapex = pre.solarCapexPerKw * solarKw;
    const batteryCapex = pre.baseBatteryCapex * batteryKwh;
    let windAnnual, windOpex, windOnKw = 0, windOffKw = 0;
    if (both) {
        windOnKw = Number.isFinite(row._windOnKw) ? row._windOnKw : (row.wind_on_gw || 0) * 1_000_000;
        windOffKw = Number.isFinite(row._windOffKw) ? row._windOffKw : (row.wind_off_gw || 0) * 1_000_000;
        const onCapex = pre.baseWindOnCapex * windOnKw;
        const offCapex = pre.baseWindOffCapex * windOffKw;
        windAnnual = onCapex * pre.windOnCrf + offCapex * pre.windOffCrf;
        windOpex = onCapex * pre.windOpexPct + offCapex * pre.windOffOpexPct;
    } else {
        const windCapex = (offshore ? pre.baseWindOffCapex : pre.baseWindOnCapex) * windKw;
        windAnnual = windCapex * (offshore ? pre.windOffCrf : pre.windOnCrf);
        windOpex = windCapex * (offshore ? pre.windOffOpexPct : pre.windOpexPct);
    }
    const solarAnnual = solarCapex * pre.solarCrf;
    const batteryAnnual = batteryCapex * pre.batteryCrf;
    const solarOpex = solarCapex * pre.solarOpexPct;
    const batteryOpex = batteryCapex * pre.batteryOpexPct;

    let annualCost = solarAnnual + batteryAnnual + windAnnual + solarOpex + batteryOpex + windOpex;
    let annualEnergyMWh = Number.isFinite(row._annualEnergyMwh)
        ? row._annualEnergyMwh
        : solarShareCf * 8760 * BASE_LOAD_MW;
    // Degradation reduces the renewable energy denominator, weighted by each
    // source's share of the energy (blendedDegradation); same as the worker.
    if (both) {
        annualEnergyMWh *= blendedDegradation3(solarKw, windOnKw, windOffKw,
            pre.solarUnitCf, pre.windOnUnitCf, pre.windOffUnitCf,
            pre.energyDegradationMult, pre.windOnDegradationMult, pre.windOffDegradationMult);
    } else if (windKw > 0) {
        annualEnergyMWh *= blendedDegradation(solarKw, windKw,
            pre.solarUnitCf, offshore ? pre.windOffUnitCf : pre.windOnUnitCf,
            pre.energyDegradationMult, offshore ? pre.windOffDegradationMult : pre.windOnDegradationMult);
    } else {
        annualEnergyMWh *= pre.energyDegradationMult;
    }

    let backupFuel = null;
    let backupLcoeAdder = 0;
    let backupEnergyMwh = 0;
    let dieselPriceUsdPerLiter = null;
    let dieselSourceYear = null;
    let dieselSourceType = null;
    let dieselSourceDistanceKm = null;
    let dieselSourceCountryIso3 = null;
    let dieselSourceCountryName = null;
    let dieselSourceSeriesName = null;
    let gasAvailable = false;
    let gasPriceUsdPerMmbtu = null;
    let gasSourceCountryIso3 = null;
    let gasSourceCountryName = null;
    let gasSourceDistanceKm = null;

    const makeResult = (lcoeValue) => ({
        lcoe: lcoeValue,
        annual_cost_usd: annualCost,
        annual_energy_mwh: annualEnergyMWh,
        firm_cf: firmCf,
        solar_share_cf: solarShareCf,
        diesel_share_cf: dieselShareCf,
        backup_share_cf: dieselShareCf,
        backup_fuel: backupFuel,
        backup_lcoe_adder: backupLcoeAdder,
        backup_energy_mwh: backupEnergyMwh,
        diesel_lcoe_adder: backupLcoeAdder,
        diesel_energy_mwh: backupEnergyMwh,
        diesel_price_usd_per_liter: dieselPriceUsdPerLiter,
        diesel_source_year: dieselSourceYear,
        diesel_source_type: dieselSourceType,
        diesel_source_distance_km: dieselSourceDistanceKm,
        diesel_source_country_iso3: dieselSourceCountryIso3,
        diesel_source_country_name: dieselSourceCountryName,
        diesel_source_series_name: dieselSourceSeriesName,
        gas_available: gasAvailable,
        gas_price_usd_per_mmbtu: gasPriceUsdPerMmbtu,
        gas_source_country_iso3: gasSourceCountryIso3,
        gas_source_country_name: gasSourceCountryName,
        gas_source_distance_km: gasSourceDistanceKm,
        includeDieselBackup
    });

    if (includeDieselBackup) {
        // The renewables deliver their degraded energy (annualEnergyMWh so far);
        // the backup serves the rest of the full load, which is the denominator.
        const fullLoadMwh = 8760 * BASE_LOAD_MW;
        backupEnergyMwh = Math.max(0, fullLoadMwh - annualEnergyMWh);
        dieselShareCf = backupEnergyMwh / fullLoadMwh;
        annualEnergyMWh = fullLoadMwh;

        const dc = pre.dieselContext;
        dieselPriceUsdPerLiter = pre.dieselPricing ? pre.dieselPricing.effectivePrice : null;
        if (dc) {
            dieselSourceYear = dc.sourceYear;
            dieselSourceType = dc.sourceType;
            dieselSourceDistanceKm = dc.sourceDistanceKm;
            dieselSourceCountryIso3 = dc.sourceIso3;
            dieselSourceCountryName = dc.sourceCountry;
            dieselSourceSeriesName = dc.sourceSeriesName;
        }
        const dieselTotalAnnual = Number.isFinite(pre.dieselFuelCostPerMwh)
            ? pre.dieselCapexAnnual + backupEnergyMwh * pre.dieselFuelCostPerMwh
            : Infinity;

        gasAvailable = Boolean(pre.gasAvailable);
        let gasTotalAnnual = Infinity;
        if (gasAvailable && Number.isFinite(pre.gasFuelCostPerMwh)) {
            gasTotalAnnual = pre.gasCapexAnnual + backupEnergyMwh * pre.gasFuelCostPerMwh;
            const gc = pre.gasContext;
            if (gc) {
                gasPriceUsdPerMmbtu = gc.priceUsdPerMmbtu;
                gasSourceCountryIso3 = gc.sourceIso3;
                gasSourceCountryName = gc.sourceCountry;
                gasSourceDistanceKm = gc.sourceDistanceKm;
            }
        }

        let backupTotalAnnual;
        if (gasTotalAnnual < dieselTotalAnnual) {
            backupFuel = 'gas';
            backupTotalAnnual = gasTotalAnnual;
        } else {
            backupFuel = 'diesel';
            backupTotalAnnual = dieselTotalAnnual;
        }

        if (!Number.isFinite(backupTotalAnnual)) {
            backupLcoeAdder = Infinity;
            annualCost = Infinity;
            return makeResult(Infinity);
        }
        annualCost += backupTotalAnnual;
        backupLcoeAdder = annualEnergyMWh > 0 ? backupTotalAnnual / annualEnergyMWh : Infinity;
    }

    return makeResult(annualEnergyMWh > 0 ? annualCost / annualEnergyMWh : Infinity);
}

function computeTransmissionMetrics(row, reference, delta) {
    if (!reference || !Number.isFinite(delta)) return null;
    const distanceKm = haversineKm(row.latitude, row.longitude, reference.latitude, reference.longitude);
    const savingsPerMwh = -delta; // positive if row cheaper
    if (!Number.isFinite(distanceKm)) {
        return null;
    }
    const firmCf = Number.isFinite(row.firm_cf) ? row.firm_cf : row.annual_cf;
    if (savingsPerMwh <= 0 || firmCf <= 0) {
        return { distanceKm, savingsPerMwh, breakevenPerGw: 0, breakevenPerGwKm: 0 };
    }
    const annualEnergyMWh = Number.isFinite(row.annual_energy_mwh)
        ? row.annual_energy_mwh
        : firmCf * 8760 * BASE_LOAD_MW;
    const annualPayment = savingsPerMwh * annualEnergyMWh;
    const breakevenPerGw = TX_CRF > 0 ? annualPayment / TX_CRF : 0;
    const breakevenPerGwKm = distanceKm > 0 ? breakevenPerGw / distanceKm : 0;
    return {
        distanceKm,
        savingsPerMwh,
        breakevenPerGw,
        breakevenPerGwKm
    };
}

/** True once the full-grid search is available: in the worker, or here without one. */
function fullGridSearchReady() {
    return lcoeWorkerUsable() ? lcoeWorkerMatrixReady : Boolean(cfMatrix);
}

/** True while LCOE searches go to the worker; false once it is off or has failed. */
function lcoeWorkerUsable() {
    return FEATURE_WORKER_LCOE && !lcoeWorkerFailed && typeof Worker !== 'undefined';
}

/**
 * Give up on the worker for the rest of the session: every later search runs on
 * the main thread, and the cost view is redrawn so it doesn't wait for an answer
 * that will never come.
 */
function markLcoeWorkerFailed(reason) {
    if (lcoeWorkerFailed) return;
    lcoeWorkerFailed = true;
    console.warn('LCOE worker failed, using main-thread fallback.', reason?.message || reason);
    if (lcoeWorker) lcoeWorker.terminate();
    lcoeWorkerPending.forEach((pending) => pending.reject(new Error('LCOE worker failed')));
    lcoeWorkerPending.clear();
    lcoeWorkerNextJob = null;
    setLcoePending(null);
    setMapBusy('grid', false);
    // The worker held the full grid; the main-thread search needs its own.
    buildCfMatrixOnMainThread();
    refreshActiveLcoeView();
}

function getLcoeWorker() {
    if (!lcoeWorkerUsable()) return null;
    if (lcoeWorker) return lcoeWorker;

    lcoeWorker = new Worker(new URL('./workers/lcoe-worker.js', import.meta.url), { type: 'module' });
    lcoeWorker.onmessage = (event) => {
        const { type, requestId, payload } = event.data || {};
        const pending = lcoeWorkerPending.get(requestId);
        if (!pending) return;
        if (type === 'PROGRESS') {
            pending.progress(payload);
            return;
        }
        lcoeWorkerPending.delete(requestId);
        if (type === 'ERROR') {
            pending.reject(new Error(payload?.message || 'LCOE worker error'));
            return;
        }
        pending.resolve(payload || null);
    };
    lcoeWorker.onerror = (event) => {
        markLcoeWorkerFailed(event?.message || 'LCOE worker crashed');
    };

    return lcoeWorker;
}

function serializeWaccMap() {
    if (!waccMap || !waccMap.size || waccMode !== 'local') return null;
    const out = {};
    waccMap.forEach((value, locationId) => {
        if (Number.isFinite(value)) out[locationId] = value;
    });
    return out;
}

function serializeLocalCapexMap() {
    if (!localCapexMap || !localCapexMap.size || capexMode !== 'local') return null;
    const out = {};
    localCapexMap.forEach((entry, locationId) => {
        if (!entry) return;
        const solar = interpolateLocalCapex(lcoeTimeYear, entry.solar);
        const battery = interpolateLocalCapex(lcoeTimeYear, entry.battery);
        if (!Number.isFinite(solar) || !Number.isFinite(battery)) return;
        out[locationId] = { solar, battery, ...localWindCapex(locationId, entry, lcoeTimeYear) };
    });
    return out;
}

/** Local WACC mode only: location_id -> { on, off } wind cost of capital. */
function serializeWindWaccMap() {
    if (!windWaccMap || !windWaccMap.size || waccMode !== 'local') return null;
    const out = {};
    windWaccMap.forEach((entry, locationId) => {
        const rates = localWindWacc(locationId, entry);
        if (!rates) return;
        if (!Number.isFinite(rates.on) && !Number.isFinite(rates.off)) return;
        out[locationId] = {
            on: Number.isFinite(rates.on) ? rates.on : undefined,
            off: Number.isFinite(rates.off) ? rates.off : undefined
        };
    });
    return out;
}

function serializeDieselMap() {
    if (!dieselMap || !dieselMap.size) return null;
    const out = {};
    dieselMap.forEach((entry, locationId) => {
        if (!entry) return;
        out[locationId] = {
            price: entry.price,
            rawPrice: Number.isFinite(entry.rawPrice ?? entry.price) ? (entry.rawPrice ?? entry.price) : null,
            sourceYear: entry.sourceYear ?? null,
            sourceType: entry.sourceType ?? null,
            sourceDistanceKm: entry.sourceDistanceKm ?? null,
            sourceIso3: entry.sourceIso3 ?? null,
            sourceCountry: entry.sourceCountry ?? null,
            sourceSeriesName: entry.sourceSeriesName ?? null
        };
    });
    return out;
}

function serializeGasMap() {
    if (!gasMap || !gasMap.size) return null;
    const out = {};
    gasMap.forEach((entry, locationId) => {
        if (!entry) return;
        out[locationId] = {
            available: Boolean(entry.available),
            price: entry.price,
            rawPrice: Number.isFinite(entry.rawPrice ?? entry.price) ? (entry.rawPrice ?? entry.price) : null,
            sourceType: entry.sourceType ?? null,
            sourceDistanceKm: entry.sourceDistanceKm ?? null,
            sourceIso3: entry.sourceIso3 ?? null,
            sourceCountry: entry.sourceCountry ?? null
        };
    });
    return out;
}

/**
 * Post one message and wait for its answer. `transfer` lists buffers to hand
 * over rather than copy. Progress messages re-arm the timeout, so a long load
 * fails only when it stalls.
 */
function postLcoeWorkerMessage(type, payload, timeoutMs = 12000, { transfer = [], onProgress = null } = {}) {
    const worker = getLcoeWorker();
    if (!worker) {
        return Promise.reject(new Error('LCOE worker unavailable'));
    }

    const requestId = ++lcoeWorkerRequestSeq;
    return new Promise((resolve, reject) => {
        let timer = null;
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                lcoeWorkerPending.delete(requestId);
                reject(new Error(`LCOE worker timeout for ${type}`));
            }, timeoutMs);
        };
        arm();

        lcoeWorkerPending.set(requestId, {
            resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            reject: (err) => {
                clearTimeout(timer);
                reject(err);
            },
            progress: (value) => {
                arm();
                if (onProgress) onProgress(value);
            }
        });

        worker.postMessage({ type, requestId, payload }, transfer);
    });
}

// First summary row per location, which worker answers are merged onto.
const refRowFor = sliceFirstRow;

function cloneWorkerResults(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
        const ref = refRowFor(row.location_id);
        return ref ? { ...ref, ...row } : { ...row };
    });
}

/**
 * The rows of a columnar worker answer (see encodeRows in the worker): the same
 * keys in the same order with the same values as the rows the worker built.
 */
function decodeWorkerColumns({ n, keys, cols }) {
    const nKeys = keys.length;
    // Rows are cloned from a template holding every key, made by JSON.parse so it
    // is a fast-mode object: adding ~50 keys to each row one by one would turn
    // the rows into slow dictionary objects, and every later spread and read of
    // them (the draw, tooltips) would pay for it.
    const template = JSON.parse(JSON.stringify(Object.fromEntries(keys.map(k => [k, 0]))));
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const row = { ...template };
        for (let k = 0; k < nKeys; k++) {
            const c = cols[k];
            let v = c.num[i];
            if (c.tag && c.tag[i]) {
                v = c.dict[v];
            } else if ((v | 0) === v && (v !== 0 || 1 / v > 0)) {
                // Integral values as small integers, as structured clone delivers
                // them (-0 stays a double). A double stored where the slice rows
                // hold a small integer would deprecate the hidden class the merged
                // rows share with them, and the next pass over all 1.4M slice rows
                // would migrate every one (seconds at 4x).
                v |= 0;
            }
            row[keys[k]] = v;
        }
        out[i] = row;
    }
    return out;
}

// Least-recently-used caches of worker answers, at most LCOE_WORKER_CACHE_MAX each.
function cachedWorkerAnswer(cache, key) {
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);
        cache.set(key, hit);
    }
    return hit;
}

function cacheWorkerAnswer(cache, key, rows) {
    cache.delete(key);
    cache.set(key, rows);
    while (cache.size > LCOE_WORKER_CACHE_MAX) cache.delete(cache.keys().next().value);
}

function buildWorkerCacheKey(kind, targetValue, params) {
    return JSON.stringify({
        kind,
        targetValue,
        mode: { waccMode, capexMode, dieselPriceMode, gasPriceMode, year: lcoeTimeYear },
        // The mode can switch before its data has loaded, so the lookups actually
        // sent are part of the key too.
        lookups: currentLcoeLookups().version,
        multipliers: lcoeCostMultipliers,
        params: {
            solarCapex: params.solarCapex,
            batteryCapex: params.batteryCapex,
            solarOpexPct: params.solarOpexPct,
            batteryOpexPct: params.batteryOpexPct,
            solarDegradationPct: params.solarDegradationPct,
            solarLife: params.solarLife,
            batteryLife: params.batteryLife,
            wacc: params.wacc,
            ilr: params.ilr,
            targetCf: params.targetCf,
            includeDieselBackup: params.includeDieselBackup,
            dieselBackupMode: params.dieselBackupMode,
            dieselCapex: params.dieselCapex,
            dieselEfficiency: params.dieselEfficiency,
            dieselLife: params.dieselLife,
            dieselPrice: params.dieselPrice,
            dieselPriceMode: params.dieselPriceMode,
            gasCapex: params.gasCapex,
            gasEfficiency: params.gasEfficiency,
            gasLife: params.gasLife,
            gasPrice: params.gasPrice,
            gasPriceMode: params.gasPriceMode,
            windCapex: params.windCapex,
            windOffCapex: params.windOffCapex,
            windOpexPct: params.windOpexPct,
            windOffOpexPct: params.windOffOpexPct,
            windLife: params.windLife,
            windOffLife: params.windOffLife,
            windDegradationPct: params.windDegradationPct,
            windOffDegradationPct: params.windOffDegradationPct,
            windWaccPremium: params.windWaccPremium,
            windOffWaccPremium: params.windOffWaccPremium,
            includeOffshore: params.includeOffshore,
            techOff: params.techOff || 0
        }
    });
}

// A search waits for the grid to load; past this without any progress from
// the load, or past the search timeout below, the worker is treated as hung
// and the main thread takes over.
const LCOE_WORKER_LOAD_STALL_MS = 60000;

/**
 * Have the worker fetch and decode the full grid, once. Resolves true once the
 * worker holds it, false if the worker cannot be used (it is then marked failed,
 * so searches fall back to the main thread).
 */
function ensureLcoeWorkerReady() {
    if (!lcoeWorkerUsable()) return Promise.resolve(false);
    if (lcoeWorkerMatrix) return lcoeWorkerMatrix;
    lcoeWorkerMatrix = (async () => {
        try {
            const locationIds = Int32Array.from(matrixLocationIds());
            const configs = configManifest.configs.map(({ i, summary, solar, wind, batt, surface }) =>
                ({ i, summary, solar, wind, batt, surface }));
            // Nothing is drawn from part of the grid, so the cost views just wait.
            setMapBusy('grid', true);
            const payload = { configs, locationIds: locationIds.buffer };
            const addon = addonRequest();
            if (addon) payload.addon = addon;
            const loaded = await postLcoeWorkerMessage('LOAD_MATRIX', payload,
                LCOE_WORKER_LOAD_STALL_MS, { transfer: [locationIds.buffer] });
            if (addon) {
                addonActive = loaded?.addon || null;
                addonKnown = true;
                if (loaded?.addonError) console.error(`Add-on builds not used: ${loaded.addonError}`);
                applyAddonUi();
            }
            if (!lcoeWorkerUsable()) return false;
            lcoeWorkerMatrixReady = true;
            setMapBusy('grid', false);
            if (DEBUG_SNAPSHOT) publishDebugSnapshot(getSummaryStatsForConfig(currentSolar, currentBatt));
            return true;
        } catch (err) {
            markLcoeWorkerFailed(err);
            return false;
        }
    })();
    return lcoeWorkerMatrix;
}

/** The lookups the worker should price with now; a new version when any changed. */
function currentLcoeLookups() {
    const capexLocal = capexMode === 'local';
    const parts = [
        waccMode === 'local' ? waccMap : null, waccMap.size,
        capexLocal ? localCapexMap : null, localCapexMap.size,
        waccMode === 'local' ? windWaccMap : null, windWaccMap.size,
        capexLocal ? lcoeTimeYear : null,
        dieselMap, dieselMap.size,
        gasMap, gasMap.size
    ];
    if (!lcoeLookups || parts.some((p, i) => p !== lcoeLookups.parts[i])) {
        lcoeLookups = {
            version: (lcoeLookups?.version || 0) + 1,
            parts,
            maps: {
                waccByLocation: serializeWaccMap(),
                windWaccByLocation: serializeWindWaccMap(),
                localCapexByLocation: serializeLocalCapexMap(),
                dieselByLocation: serializeDieselMap(),
                gasByLocation: serializeGasMap()
            }
        };
    }
    return lcoeLookups;
}

// A full-grid search takes seconds on a slow machine; past this the worker is
// treated as hung and the main thread takes over.
const LCOE_WORKER_SEARCH_TIMEOUT_MS = 60000;

/**
 * Ask the worker for a search. One runs at a time; a request made meanwhile
 * waits and replaces any request already waiting, so a slider sweep never
 * queues up searches whose answers nobody will see.
 */
function requestLcoeWorkerSearch(kind, key, targetValue, params, requestId) {
    const sameJob = job => job && job.key === key && job.kind === kind;
    if (sameJob(lcoeWorkerJob)) {
        lcoeWorkerJob.requestIds.add(requestId);
        lcoeWorkerNextJob = null;
        return;
    }
    if (sameJob(lcoeWorkerNextJob)) {
        lcoeWorkerNextJob.requestIds.add(requestId);
        return;
    }
    // Snapshot everything now: the sliders may move before the job is sent.
    lcoeWorkerNextJob = {
        kind, key,
        requestIds: new Set([requestId]),
        lookups: currentLcoeLookups(),
        payload: {
            [kind === 'best' ? 'targetCf' : 'targetLcoe']: targetValue,
            params: { ...params },
            costMultipliers: { ...lcoeCostMultipliers }
        }
    };
    pumpLcoeWorkerSearch();
}

function pumpLcoeWorkerSearch() {
    if (lcoeWorkerJob || !lcoeWorkerNextJob) return;
    const job = lcoeWorkerNextJob;
    lcoeWorkerJob = job;
    lcoeWorkerNextJob = null;

    (async () => {
        let response = null;
        try {
            if (!(await ensureLcoeWorkerReady())) return;   // failed: already redrawn on the main thread
            if (job.lookups.version !== lcoeWorkerLookupVersion) {
                await postLcoeWorkerMessage('SET_LOOKUPS', job.lookups.maps);
                lcoeWorkerLookupVersion = job.lookups.version;
            }
            const type = job.kind === 'best' ? 'COMPUTE_BEST_LCOE' : 'COMPUTE_CF_AT_TARGET_LCOE';
            response = await postLcoeWorkerMessage(type, job.payload, LCOE_WORKER_SEARCH_TIMEOUT_MS);
        } catch (err) {
            markLcoeWorkerFailed(err);
            return;
        } finally {
            lcoeWorkerJob = null;
        }
        if (response) {
            // Rows are rebuilt once, here, so each draw only merges them.
            const rows = response.columns ? decodeWorkerColumns(response.columns) : (response.rows || []);
            if (job.kind === 'best') {
                cacheWorkerAnswer(lcoeWorkerBestCache, job.key, rows);
            } else {
                rows.forEach(r => finishCfAtTargetRow(r, job.payload.params));
                cacheWorkerAnswer(lcoeWorkerCfCache, job.key, rows);
            }
        }
        pumpLcoeWorkerSearch();
        // Only the latest request redraws; it reads the answer from the cache.
        // The draw runs in its own task, so receiving the answer and drawing it
        // are not one long task, and the check is made again when it runs.
        setTimeout(() => {
            if (job.requestIds.has(lcoeDrawRequestId)) refreshActiveLcoeView();
        }, 0);
    })();
}

const LCOE_TIME_ANCHORS = (() => {
    const baseYear = COST_BASE_YEAR;
    return {
        baseYear,
        solar: [
            { year: baseYear, factor: 1.0 },
            { year: 2035, factor: 0.61 },
            { year: 2050, factor: 0.50 }
        ],
        battery: [
            { year: baseYear, factor: 1.0 },
            { year: 2035, factor: 0.66 },
            { year: 2050, factor: 0.55 }
        ],
        // Wind: the WIND_GLOBAL_CAPEX path as factors on today's capex input.
        wind: windFactors(WIND_GLOBAL_CAPEX.on),
        windOff: windFactors(WIND_GLOBAL_CAPEX.off)
    };
    function windFactors(path) {
        return [
            { year: baseYear, factor: 1.0 },
            { year: 2035, factor: path[2035] / path[2024] },
            { year: 2050, factor: path[2050] / path[2024] }
        ];
    }
})();

function interpolateFactor(year, anchors) {
    if (!anchors?.length) return 1;
    if (year <= anchors[0].year) return anchors[0].factor;
    for (let i = 0; i < anchors.length - 1; i += 1) {
        const a = anchors[i];
        const b = anchors[i + 1];
        if (year <= b.year) {
            const t = (year - a.year) / (b.year - a.year || 1);
            return a.factor + t * (b.factor - a.factor);
        }
    }
    return anchors[anchors.length - 1].factor;
}

function resetLcoeTimeLegendLock() {
    lcoeTimeLockActive = false;
    lcoeTimeLockedColorInfo = null;
}

function applyLcoeTimeYear(year, { lockLegend = true } = {}) {
    const normalizedYear = Math.max(LCOE_TIME_ANCHORS.baseYear, Math.min(2050, year));
    lcoeTimeYear = normalizedYear;
    lcoeCostMultipliers.solar = interpolateFactor(normalizedYear, LCOE_TIME_ANCHORS.solar);
    lcoeCostMultipliers.battery = interpolateFactor(normalizedYear, LCOE_TIME_ANCHORS.battery);
    lcoeCostMultipliers.wind = interpolateFactor(normalizedYear, LCOE_TIME_ANCHORS.wind);
    lcoeCostMultipliers.windOff = interpolateFactor(normalizedYear, LCOE_TIME_ANCHORS.windOff);
    resetLocalCapexCache();

    const factorOf = { solar: 'solar', battery: 'battery', wind: 'wind', offwind: 'windOff' };
    lcoeTimeFactorLabels.forEach(([key, els]) => {
        const text = `${Math.round(lcoeCostMultipliers[factorOf[key]] * 100)}%`;
        els.forEach(el => { if (el) el.textContent = text; });
    });
    if (lcoeTimeYearLabel) lcoeTimeYearLabel.textContent = normalizedYear;
    if (lcoeTimeSlider) lcoeTimeSlider.value = normalizedYear;
    if (popLcoeTimeYearLabel) popLcoeTimeYearLabel.textContent = normalizedYear;
    if (popLcoeTimeSlider) popLcoeTimeSlider.value = normalizedYear;

    if (lockLegend) {
        lcoeTimeLockActive = true;
    }

    queueLcoeUpdate();
}

function stopLcoeTimeAnimation() {
    if (lcoeTimeTimer) {
        clearTimeout(lcoeTimeTimer);
        lcoeTimeTimer = null;
    }
    lcoeTimePlaying = false;
    if (lcoeTimePlayBtn) lcoeTimePlayBtn.textContent = 'Play';
    if (popLcoeTimePlayBtn) popLcoeTimePlayBtn.textContent = 'Play';
}

function toggleLcoeTimeAnimation() {
    if (lcoeTimePlaying) {
        stopLcoeTimeAnimation();
        return;
    }
    lcoeTimePlaying = true;
    if (lcoeTimePlayBtn) lcoeTimePlayBtn.textContent = 'Pause';
    if (popLcoeTimePlayBtn) popLcoeTimePlayBtn.textContent = 'Pause';
    if (lcoeTimeYear >= 2050) {
        applyLcoeTimeYear(LCOE_TIME_ANCHORS.baseYear);
    }
    scheduleLcoeTimeStep(LCOE_TIME_STEP_MS);
}

// Timeline Play shows each year for this long after its map is drawn. The search
// runs in the worker and can take longer than a step, so the next year waits for
// the draw: noteLcoeRendered() restarts this timer when the current year lands.
const LCOE_TIME_STEP_MS = 650;

function scheduleLcoeTimeStep(delay) {
    if (lcoeTimeTimer) clearTimeout(lcoeTimeTimer);
    lcoeTimeTimer = setTimeout(stepLcoeTime, delay);
}

function stepLcoeTime() {
    lcoeTimeTimer = null;
    if (!lcoeTimePlaying) return;
    const showsLcoe = currentViewMode === 'lcoe'
        || (currentViewMode === 'population' && populationOverlayMode === 'lcoe');
    if (showsLcoe && lcoeRenderedYear !== lcoeTimeYear) {
        // Not drawn yet; the draw schedules the step. Look again in case the
        // view changes and no draw comes.
        scheduleLcoeTimeStep(250);
        return;
    }
    if (lcoeTimeYear >= 2050) {
        stopLcoeTimeAnimation();
        return;
    }
    applyLcoeTimeYear(lcoeTimeYear + 1);
    scheduleLcoeTimeStep(showsLcoe ? 250 : LCOE_TIME_STEP_MS);
}

/** Bookkeeping after an LCOE result is drawn for `kind` ('lcoe', 'lcoe_cf' or 'pop_lcoe'). */
function noteLcoeRendered(kind) {
    lcoeShownKind = kind;
    setLcoePending(null);
    const yearChanged = lcoeRenderedYear !== lcoeTimeYear;
    lcoeRenderedYear = lcoeTimeYear;
    if (lcoeTimePlaying && yearChanged) scheduleLcoeTimeStep(LCOE_TIME_STEP_MS);
}

/**
 * While the worker searches for a view whose result is not on screen yet (say
 * the capacity map is still showing on first opening LCOE), dim that map and
 * show the map spinner. A previous result of the same view stays as it is.
 */
function showLcoePendingIfNeeded(kind) {
    if (lcoeShownKind === kind) return;
    setLcoePending(kind === 'pop_lcoe' ? 'map-supply' : 'map');
}

function setLcoePending(mapId) {
    if (lcoePendingMapId && lcoePendingMapId !== mapId) {
        const prev = document.getElementById(lcoePendingMapId);
        if (prev) prev.style.opacity = '';
    }
    lcoePendingMapId = mapId;
    setMapBusy('lcoe', Boolean(mapId));
    if (!mapId) return;
    const mapEl = document.getElementById(mapId);
    if (mapEl) {
        mapEl.style.transition = 'opacity 0.2s';
        mapEl.style.opacity = '0.4';
    }
}

function formatCurrencyLabel(value, decimals = 0) {
    const num = formatNumber(value, decimals);
    return num === '--' ? '--' : `$${num} `;
}

function getRowWacc(row) {
    if (waccMode !== 'local' || !waccMap.size) return null;
    const wacc = waccMap.get(row.location_id);
    return Number.isFinite(wacc) ? wacc : null;
}

/** Local WACC mode only: the cell's { on, off } wind cost of capital, or null. */
function getRowWindWacc(row) {
    if (waccMode !== 'local' || !windWaccMap.size) return null;
    return localWindWacc(row.location_id, windWaccMap.get(row.location_id));
}

function isFloatingWindClass(siteClass) {
    return typeof siteClass === 'string' && siteClass.startsWith('floating');
}

/**
 * Whether a cell's offshore wind is priced as floating (T025). T024 classes a
 * cell's offshore site as floating where the seabed is deeper than 60 m
 * (D-064; 102 cells, 92 of them offshore-viable at the 15% line). Floating capex, O&M and WACC
 * are used together, and only when both cost settings are Local: the global
 * inputs are fixed-bottom figures, so with either setting on Global the site is
 * priced as fixed-bottom on both sides, never floating capex at a fixed-bottom
 * rate or the reverse (T011 audit finding 1). The worker gets the resolved
 * figures, so it needs no rule of its own.
 */
function windOffFloatingPriced(locationId) {
    if (capexMode !== 'local' || waccMode !== 'local') return false;
    return Boolean(localCapexMap.get(locationId)?.windOffFloat)
        && Boolean(windWaccMap.get(locationId)?.float);
}

function localWindWacc(locationId, entry) {
    if (!entry) return null;
    return windOffFloatingPriced(locationId) ? entry.float : entry.fixed;
}

function resetLocalCapexCache() {
    localCapexCache.clear();
    localCapexCacheKey = null;
}

function interpolateLocalCapex(year, values) {
    if (!Array.isArray(values) || values.length < 3) return null;
    // The files' first column ("2024", IRENA 2025 data) is the COST_BASE_YEAR cost (T067).
    const [vBase, v2035, v2050] = values;
    const [y0, y1, y2] = LOCAL_ANCHOR_YEARS;
    if (![vBase, v2035, v2050].every(Number.isFinite)) return null;
    if (year <= y0) return vBase;
    if (year >= y2) return v2050;
    if (year <= y1) {
        return vBase + ((v2035 - vBase) * (year - y0)) / (y1 - y0);
    }
    return v2035 + ((v2050 - v2035) * (year - y1)) / (y2 - y1);
}

/**
 * A cell's local wind capex and O&M ($/kW, $/kW/yr) in `year`, interpolated
 * like solar's. Offshore is floating or fixed-bottom per windOffFloatingPriced().
 * Shared by the main thread and the worker payload, so both price alike.
 */
function localWindCapex(locationId, entry, year) {
    const floating = windOffFloatingPriced(locationId);
    const value = values => {
        const v = interpolateLocalCapex(year, values);
        return Number.isFinite(v) ? v : undefined;
    };
    return {
        windOn: value(entry.windOn),
        windOff: value(floating ? entry.windOffFloat : entry.windOffFixed),
        windOnOm: value(entry.windOnOm),
        windOffOm: value(floating ? entry.windOffFloatOm : entry.windOffFixedOm)
    };
}

/**
 * T082: offshore wind alone at this cell, without the export link, in $/MWh – the figure
 * comparable with tenders where the grid operator builds the link (NL, DE, DK, BE, FR). Local
 * capex mode only; null elsewhere. Same rates, life and degradation as the build's own LCOE,
 * at the cell's ten-year offshore CF.
 */
function offshoreTenderLcoe(locationId) {
    if (capexMode !== 'local') return null;
    const entry = localCapexMap.get(locationId);
    const cf = windResourceMap?.get(locationId)?.off_final_cf;
    if (!entry?.windOffFixedGen || !(cf > 0)) return null;
    const gen = interpolateLocalCapex(lcoeTimeYear, entry.windOffFixedGen);
    const pre = precomputeLcoePerLocation({ location_id: locationId }, lcoeParams, null);
    if (!Number.isFinite(gen) || !(pre.windOffDegradationMult > 0)) return null;
    const om = pre.windOffOpexPct * pre.baseWindOffCapex;   // $/kW/yr (the engine holds O&M as a share of capex)
    return (gen * pre.windOffCrf + om) * 1000 / (cf * 8760 * pre.windOffDegradationMult);
}
setOffshoreTenderLcoe(offshoreTenderLcoe);

function getRowCapex(row) {
    if (capexMode !== 'local' || !localCapexMap.size) return null;
    // Offshore pricing also depends on the WACC setting and its data.
    const cacheKey = `${lcoeTimeYear}|${waccMode}|${windWaccMap.size}`;
    if (localCapexCacheKey !== cacheKey) {
        localCapexCacheKey = cacheKey;
        localCapexCache.clear();
    }
    const locationId = row.location_id;
    if (localCapexCache.has(locationId)) {
        return localCapexCache.get(locationId);
    }
    const entry = localCapexMap.get(locationId);
    if (!entry) {
        localCapexCache.set(locationId, null);
        return null;
    }
    const solar = interpolateLocalCapex(lcoeTimeYear, entry.solar);
    const battery = interpolateLocalCapex(lcoeTimeYear, entry.battery);
    if (!Number.isFinite(solar) || !Number.isFinite(battery)) {
        localCapexCache.set(locationId, null);
        return null;
    }
    const payload = {
        solar, battery, region: entry.region, source: entry.source,
        ...localWindCapex(locationId, entry, lcoeTimeYear)
    };
    localCapexCache.set(locationId, payload);
    return payload;
}



/**
 * Main-thread least-cost search over the full three-axis grid.
 *
 * The legacy search below walks only the summary slice that is currently on
 * screen, which for the cost views would mean "cheapest build at this wind
 * level" rather than "cheapest build". Once the capacity-factor matrix is
 * loaded we search all of it here too, so the first paint already accounts for
 * wind instead of waiting for the worker to answer.
 */
function computeBestLcoeFromMatrix(m, targetCf, params, surfaces = null) {
    // T067 (T065-V-2): CFs are stored as float32, so a build exactly at the target
    // (0.9000 -> 0.89999998) must pass; compare against the float32 target, as the worker does.
    // Rows keep the target as given.
    const tieCf = Math.fround(targetCf);
    if (!m.unitCfg) m.unitCfg = unitConfigIndices(m);
    const { cf, locationIds, solarGw, windGw, battGwh, surfaceOff, nCfg } = m;
    // Onshore only: offshore configs are skipped like unpriced ones, as the worker's dropOffshore does.
    const includeOffshore = params.includeOffshore !== false;
    // T074: configs using a switched-off technology are skipped (none when all are on).
    const offMask = techOffMask(params);
    const techMask = offMask ? denseTechMask(m) : null;
    const results = [];
    const row = {
        location_id: 0, solar_gw: 0, wind_gw: 0, batt_gwh: 0, annual_cf: 0,
        wind_surface: 'on', latitude: 0, longitude: 0,
        _solarKw: 0, _windKw: 0, _batteryKwh: 0, _annualEnergyMwh: 0
    };

    for (let li = 0; li < locationIds.length; li++) {
        const locationId = locationIds[li];
        const firstRow = sliceFirstRow(locationId);
        if (!firstRow) continue;
        const pre = precomputeLcoePerLocation(firstRow, params, m.unitCf ? m.unitCf(li) : matrixUnitCf(m, li));
        row.latitude = firstRow.latitude;
        row.longitude = firstRow.longitude;

        let best = null, bestNoWind = null, high = null, fb = null, fbNoWind = null;
        const base = li * nCfg;
        for (let ci = 0; ci < nCfg; ci++) {
            const annualCf = cf[base + ci];
            if (!(annualCf > 0)) continue;
            if (!includeOffshore && surfaceOff[ci]) continue;
            if (techMask && (techMask[ci] & offMask)) continue;
            row.location_id = locationId;
            row.solar_gw = solarGw[ci];
            row.wind_gw = windGw[ci];
            row.batt_gwh = battGwh[ci];
            row.annual_cf = annualCf;
            row.wind_surface = surfaceOff[ci] ? 'off' : 'on';
            row._solarKw = row.solar_gw * 1_000_000;
            row._windKw = row.wind_gw * 1_000_000;
            row._batteryKwh = row.batt_gwh * 1_000_000;
            row._annualEnergyMwh = annualCf * 8760 * BASE_LOAD_MW;

            const metrics = computeLcoeMetricsFast(row, pre);
            if (!Number.isFinite(metrics.lcoe)) continue;
            const noWind = row.wind_gw === 0;
            if (annualCf >= tieCf) {
                if (!best || metrics.lcoe < best.lcoe) best = { ...row, ...metrics, targetCf };
                if (noWind && (!bestNoWind || metrics.lcoe < bestNoWind.lcoe)) bestNoWind = { ...row, ...metrics };
            }
            if (!fb || annualCf > fb.annual_cf || (annualCf === fb.annual_cf && metrics.lcoe < fb.lcoe)) {
                fb = { ...row, ...metrics, targetCf };
            }
            if (noWind && (!fbNoWind || annualCf > fbNoWind.annual_cf
                || (annualCf === fbNoWind.annual_cf && metrics.lcoe < fbNoWind.lcoe))) {
                fbNoWind = { ...row, ...metrics };
            }
            if (!high || annualCf > high.annual_cf || (annualCf === high.annual_cf && metrics.lcoe < high.lcoe)) {
                high = { annual_cf: annualCf, lcoe: metrics.lcoe, solar_gw: row.solar_gw,
                         wind_gw: row.wind_gw, batt_gwh: row.batt_gwh };
            }
        }

        if (m.addon) {
            const tpl = { location_id: locationId, latitude: firstRow.latitude, longitude: firstRow.longitude };
            const r = addonTargetRowMain(m, li, pre, targetCf, includeOffshore, surfaces, tpl,
                { best, bestNoWind, fb, fbNoWind, high }, offMask);
            if (r) results.push(r);
            continue;
        }
        const chosen = best ? { ...best, meetsTarget: true } : fb ? { ...fb, meetsTarget: false } : null;
        if (!chosen) continue;
        const noWindPick = bestNoWind || fbNoWind || null;
        chosen.maxConfigSolar = high?.solar_gw ?? null;
        chosen.maxConfigWind = high?.wind_gw ?? null;
        chosen.maxConfigBatt = high?.batt_gwh ?? null;
        chosen.maxConfigLcoe = high?.lcoe ?? null;
        chosen.noWindLcoe = noWindPick?.lcoe ?? null;
        chosen.noWindMeetsTarget = Boolean(bestNoWind);
        chosen.windSaving = (Number.isFinite(chosen.lcoe) && Number.isFinite(noWindPick?.lcoe))
            ? noWindPick.lcoe - chosen.lcoe : null;
        const sg = chosen.solar_gw || 0, wg = chosen.wind_gw || 0;
        chosen.windShare = (sg + wg) > 0 ? wg / (sg + wg) : 0;
        chosen.windSurfaces = surfaces || (includeOffshore ? 'both' : 'onshore');
        results.push(chosen);
    }
    return results.sort((a, b) => a.location_id - b.location_id);
}

// An add-on winner's row on the main thread, laid out as the dense rows here are
// ({ ...row, ...metrics }, with the scratch row's keys and position).
function addonEntryMain(tpl, cand, pre) {
    const f = addonRowFields(cand);
    const row = {
        location_id: tpl.location_id, solar_gw: f.solar_gw, wind_gw: f.wind_gw, batt_gwh: f.batt_gwh,
        annual_cf: f.annual_cf, wind_surface: f.wind_surface, latitude: tpl.latitude, longitude: tpl.longitude,
        _solarKw: f._solarKw, _windKw: f._windKw, _batteryKwh: f._batteryKwh, _annualEnergyMwh: f._annualEnergyMwh
    };
    const metrics = computeLcoeMetricsFast({ ...row, _windOnKw: f._windOnKw, _windOffKw: f._windOffKw }, pre);
    return { entry: { ...row, ...metrics }, fields: f };
}

// The add-on keys every result row carries while the add-on is loaded (as the worker's addonTail).
function addonTailMain(chosen, fields) {
    if (fields) {
        chosen.wind_on_gw = fields.wind_on_gw;
        chosen.wind_off_gw = fields.wind_off_gw;
        chosen.addon = fields.addon;
        chosen.interpolated = fields.interpolated;
        chosen.curtailed_share = fields.curtailed_share;
    } else {
        const split = denseWindSplit(chosen.wind_gw, chosen.wind_surface === 'off');
        chosen.wind_on_gw = split.on;
        chosen.wind_off_gw = split.off;
        chosen.addon = null;
        chosen.interpolated = false;
        chosen.curtailed_share = null;
    }
}

/**
 * Target-CF mode with the add-on, one location: the dense bests (objects) carried
 * on by addonPassTarget (addon.js, shared with the worker), then the same row.
 */
function addonTargetRowMain(m, li, pre, targetCf, includeOffshore, surfaces, tpl, d, offMask = 0) {
    const st = newTargetState();
    st.hasBest = Boolean(d.best); st.bestLcoe = d.best ? d.best.lcoe : 0;
    st.hasNw = Boolean(d.bestNoWind); st.nwLcoe = d.bestNoWind ? d.bestNoWind.lcoe : 0;
    st.hasFb = Boolean(d.fb); st.fbCf = d.fb ? d.fb.annual_cf : 0; st.fbLcoe = d.fb ? d.fb.lcoe : 0;
    addonPassTarget(m.addon, li, pre, Math.fround(targetCf), includeOffshore, st, offMask);   // T067: float32 tie
    if (!st.hasFb) return null;
    const meetsTarget = st.hasBest;
    const cand = meetsTarget ? st.best : st.fb;
    let chosen, fields = null;
    if (cand) {
        ({ entry: chosen, fields } = addonEntryMain(tpl, cand, pre));
        chosen.targetCf = targetCf;
        chosen.meetsTarget = meetsTarget;
    } else {
        chosen = { ...(meetsTarget ? d.best : d.fb), meetsTarget };
    }
    let fbOn, fbOff, fbSurface;
    if (st.fb) {
        chosen.maxConfigSolar = st.fb.solar;
        chosen.maxConfigWind = st.fb.on + st.fb.off;
        chosen.maxConfigBatt = st.fb.batt;
        chosen.maxConfigLcoe = st.fb.lcoe;
        fbOn = st.fb.on; fbOff = st.fb.off; fbSurface = 'both';
    } else {
        const h = d.high;
        chosen.maxConfigSolar = h?.solar_gw ?? null;
        chosen.maxConfigWind = h?.wind_gw ?? null;
        chosen.maxConfigBatt = h?.batt_gwh ?? null;
        chosen.maxConfigLcoe = h?.lcoe ?? null;
        const off = d.fb.wind_surface === 'off';
        const split = denseWindSplit(d.fb.wind_gw, off);
        fbOn = split.on; fbOff = split.off; fbSurface = off ? 'off' : 'on';
    }
    const noWindLcoe = st.noWind ? st.nwLcoe : (d.bestNoWind || d.fbNoWind)?.lcoe ?? null;
    chosen.noWindLcoe = noWindLcoe;
    chosen.noWindMeetsTarget = st.hasNw;
    chosen.windSaving = (Number.isFinite(chosen.lcoe) && Number.isFinite(noWindLcoe))
        ? noWindLcoe - chosen.lcoe : null;
    const sg = chosen.solar_gw || 0, wg = chosen.wind_gw || 0;
    chosen.windShare = (sg + wg) > 0 ? wg / (sg + wg) : 0;
    chosen.windSurfaces = surfaces || (includeOffshore ? 'both' : 'onshore');
    addonTailMain(chosen, fields);
    chosen.maxConfigWindOn = fbOn;
    chosen.maxConfigWindOff = fbOff;
    chosen.maxConfigSurface = fbSurface;
    // The no-wind comparator's build (as the worker reports it): whether a slider
    // (configs.json) build without wind meets the target, and the no-wind build behind noWindLcoe.
    const nwDense = d.bestNoWind || d.fbNoWind || null;
    chosen.noWindStdMeets = Boolean(d.bestNoWind);
    chosen.noWindAddon = st.noWind ? 'large' : null;
    chosen.noWindSolar = st.noWind ? st.noWind.solar : (nwDense ? nwDense.solar_gw : null);
    chosen.noWindBatt = st.noWind ? st.noWind.batt : (nwDense ? nwDense.batt_gwh : null);
    chosen.noWindStdLcoe = d.bestNoWind ? d.bestNoWind.lcoe : null;
    return chosen;
}

function computeBestLcoeByLocationLegacy(targetCf, params) {
    if (cfMatrix) return computeBestLcoeFromMatrix(cfMatrix, targetCf, params);
    const m = preGridMatrix();
    return m ? computeBestLcoeFromMatrix(m, targetCf, params, 'slice') : null;
}

/**
 * Target-LCOE mode over the full grid: per location, the build with the highest
 * firm CF at or below the target LCOE (ties: lower LCOE, then config order),
 * else the cheapest build. Same search as the worker's matrix mode.
 */
function computeCfAtTargetLcoeFromMatrix(m, targetLcoe, params, surfaces = null) {
    if (!m.unitCfg) m.unitCfg = unitConfigIndices(m);
    const { cf, locationIds, solarGw, windGw, battGwh, surfaceOff, nCfg } = m;
    const includeOffshore = params.includeOffshore !== false;
    const offMask = techOffMask(params);     // T074, as in computeBestLcoeFromMatrix
    const techMask = offMask ? denseTechMask(m) : null;
    const results = [];
    const row = {
        location_id: 0, solar_gw: 0, wind_gw: 0, batt_gwh: 0, annual_cf: 0,
        wind_surface: 'on', latitude: 0, longitude: 0,
        _solarKw: 0, _windKw: 0, _batteryKwh: 0, _annualEnergyMwh: 0
    };

    for (let li = 0; li < locationIds.length; li++) {
        const locationId = locationIds[li];
        const firstRow = sliceFirstRow(locationId);
        if (!firstRow) continue;
        const pre = precomputeLcoePerLocation(firstRow, params, m.unitCf ? m.unitCf(li) : matrixUnitCf(m, li));
        row.latitude = firstRow.latitude;
        row.longitude = firstRow.longitude;

        let best = null, cheapest = null;
        const base = li * nCfg;
        for (let ci = 0; ci < nCfg; ci++) {
            const annualCf = cf[base + ci];
            if (!(annualCf > 0)) continue;
            if (!includeOffshore && surfaceOff[ci]) continue;
            if (techMask && (techMask[ci] & offMask)) continue;
            row.location_id = locationId;
            row.solar_gw = solarGw[ci];
            row.wind_gw = windGw[ci];
            row.batt_gwh = battGwh[ci];
            row.annual_cf = annualCf;
            row.wind_surface = surfaceOff[ci] ? 'off' : 'on';
            row._solarKw = row.solar_gw * 1_000_000;
            row._windKw = row.wind_gw * 1_000_000;
            row._batteryKwh = row.batt_gwh * 1_000_000;
            row._annualEnergyMwh = annualCf * 8760 * BASE_LOAD_MW;

            const metrics = computeLcoeMetricsFast(row, pre);
            if (!Number.isFinite(metrics.lcoe)) continue;
            if (metrics.lcoe <= targetLcoe) {
                if (!best || metrics.firm_cf > best.firm_cf
                    || (metrics.firm_cf === best.firm_cf && metrics.lcoe < best.lcoe)) {
                    best = { ...row, ...metrics, targetLcoe };
                }
            }
            if (!cheapest || metrics.lcoe < cheapest.lcoe) cheapest = { ...row, ...metrics, targetLcoe };
        }
        if (m.addon) {
            const st = newBudgetState();
            st.hasBest = Boolean(best); st.bestFirm = best ? best.firm_cf : 0; st.bestLcoe = best ? best.lcoe : 0;
            st.hasCheap = Boolean(cheapest); st.cheapLcoe = cheapest ? cheapest.lcoe : 0;
            addonPassBudget(m.addon, li, pre, targetLcoe, includeOffshore, st, offMask);
            if (!st.hasCheap) continue;
            const cand = st.hasBest ? st.best : st.cheap;
            let chosen, fields = null;
            if (cand) {
                const tpl = { location_id: locationId, latitude: firstRow.latitude, longitude: firstRow.longitude };
                ({ entry: chosen, fields } = addonEntryMain(tpl, cand, pre));
                chosen.targetLcoe = targetLcoe;
                chosen.meetsTarget = st.hasBest;
            } else {
                chosen = { ...(st.hasBest ? best : cheapest), meetsTarget: st.hasBest };
            }
            chosen.windSurfaces = surfaces || (includeOffshore ? 'both' : 'onshore');
            addonTailMain(chosen, fields);
            results.push(finishCfAtTargetRow(chosen, params));
            continue;
        }
        const chosen = best ? { ...best, meetsTarget: true }
            : cheapest ? { ...cheapest, meetsTarget: false } : null;
        if (!chosen) continue;
        chosen.windSurfaces = surfaces || (includeOffshore ? 'both' : 'onshore');
        results.push(finishCfAtTargetRow(chosen, params));
    }
    return results.sort((a, b) => a.location_id - b.location_id);
}

/**
 * The matrix search (here and in the worker) only marks whether the target was
 * met. Add what the CF map reads, as the slice search sets it: `cf`, and
 * `meetsTarget` also true when diesel backup covers the gap.
 */
function finishCfAtTargetRow(row, params) {
    const met = row.targetLcoeMet ?? row.meetsTarget;
    row.cf = row.cf ?? (Number.isFinite(row.firm_cf) ? row.firm_cf : row.annual_cf);
    row.targetLcoeMet = Boolean(met);
    row.meetsTarget = Boolean(met) || Boolean(params.includeDieselBackup);
    return row;
}

// Target-LCOE mode on the main thread: the full grid once loaded, else the
// builds preGridMatrix holds. Same search either way.
function computeCfAtTargetLcoeLegacy(targetLcoe, params) {
    if (cfMatrix) return computeCfAtTargetLcoeFromMatrix(cfMatrix, targetLcoe, params);
    const m = preGridMatrix();
    return m ? computeCfAtTargetLcoeFromMatrix(m, targetLcoe, params, 'slice') : null;
}

/**
 * Least-cost build per location for the LCOE view. While the worker is usable
 * the search runs only there: a cache miss sends it and returns null, the caller
 * keeps what is on screen, and the answer redraws the view if it is still the
 * latest request. The main thread searches only when the worker is off or failed.
 */
function computeBestLcoeByLocation(targetCf, params) {
    const requestId = ++lcoeDrawRequestId;
    if (!lcoeWorkerUsable()) {
        return fillTechFilterGaps(computeBestLcoeByLocationLegacy(targetCf, params), params);
    }

    const key = buildWorkerCacheKey('best', targetCf, params);
    const cached = cachedWorkerAnswer(lcoeWorkerBestCache, key);
    if (cached) return fillTechFilterGaps(cloneWorkerResults(cached), params);
    requestLcoeWorkerSearch('best', key, targetCf, params, requestId);
    return null;
}

/** Target-LCOE mode; same rule as computeBestLcoeByLocation. */
function computeCfAtTargetLcoe(targetLcoe, params) {
    const requestId = ++lcoeDrawRequestId;
    if (!lcoeWorkerUsable()) {
        return fillTechFilterGaps(computeCfAtTargetLcoeLegacy(targetLcoe, params), params);
    }

    const key = buildWorkerCacheKey('cf_at_target_lcoe', targetLcoe, params);
    const cached = cachedWorkerAnswer(lcoeWorkerCfCache, key);
    if (cached) return fillTechFilterGaps(cloneWorkerResults(cached), params);
    requestLcoeWorkerSearch('cf', key, targetLcoe, params, requestId);
    return null;
}

// Legend bars are drawn from the same lookup tables as the map (T062): each
// ramp's CSS gradient is set once as a custom property on :root, and the
// legend-gradient-* classes in style.css read them.
function installRampVars() {
    const root = document.documentElement.style;
    root.setProperty('--ramp-cf', rampScale('cf').css());
    root.setProperty('--ramp-lcoe', rampScale('lcoe').css());
    root.setProperty('--ramp-green', rampScale('green').css());
    root.setProperty('--ramp-population', rampScale('population', [1, 1e6]).css());
    root.setProperty('--ramp-no-access', rampScale('no_access', [100, 1e6]).css());
    root.setProperty('--ramp-delta', rampScale('delta', [-1, 1]).css());
    // State swatches in the legends (no data, universal access): registry colours,
    // outlined because both are dark on the dark panel (T075).
    document.querySelectorAll('[data-state-swatch]').forEach(el => {
        if (el.dataset.stateSwatch === 'naHatch') {
            // The map's no-data hatch tile (voronoi-canvas.js getNaPattern) over land.
            el.style.background = `repeating-linear-gradient(45deg, ${DATA_COLOURS.hatchLine} 0 1.5px, ${DATA_COLOURS.hatchFill} 1.5px 4.24px), var(--map-land)`;
            return;
        }
        if (el.dataset.stateSwatch === 'windHatch') {
            // The wind-not-viable hatch (voronoi-canvas.js WIND_HATCH) over a mid cell.
            // The map's spacing (T096: period 8 px, 8/√2 across the diagonal) on the solid
            // tile; the lines a little stronger than the map's 50% so the small key reads.
            el.style.background = `repeating-linear-gradient(45deg, color-mix(in srgb, ${DATA_COLOURS.hatchStroke} 80%, ${DATA_COLOURS.transparent}) 0 1px, color-mix(in srgb, ${DATA_COLOURS.hatchLight} 80%, ${DATA_COLOURS.transparent}) 1px 2px, ${DATA_COLOURS.transparent} 2px 5.66px), ${DATA_COLOURS.outline}`;
            return;
        }
        el.style.background = DATA_COLOURS[el.dataset.stateSwatch];
        if (el.dataset.stateSwatch === 'noData' || el.dataset.stateSwatch === 'universalAccess') el.style.border = `1px solid ${DATA_COLOURS.outline}`;
    });
}
installRampVars();

// Two-word hints on the LCOE legend title (T062 T2): what the colours include
// beyond the slider builds. The explanations are in the info modal.
let lcoeAddonDrawn = false;
// T067 (T065-04): cost legends state the cost year on their reference line
// ("Reference: $64/MWh · 2026 costs"); the title line is full, so it stays as it was.
function legendCostYear(info) {
    return /^LCOE/.test(info.title || 'LCOE') ? ` · ${lcoeTimeYear} costs` : '';
}

function legendHint() {
    const parts = [];
    if (lcoeParams.includeDieselBackup) parts.push('incl. backup');
    if (lcoeAddonDrawn) parts.push('incl. add-ons');
    return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function setLegendGradient(mode) {
    legendLcoeBar.classList.remove('legend-gradient-cost', 'legend-gradient-delta', 'legend-gradient-tx', 'legend-gradient');
    if (mode === 'cf') {
        legendLcoeBar.classList.add('legend-gradient');
    } else if (mode === 'delta') {
        legendLcoeBar.classList.add('legend-gradient-delta');
    } else if (mode === 'tx') {
        legendLcoeBar.classList.add('legend-gradient-tx');
    } else {
        legendLcoeBar.classList.add('legend-gradient-cost');
    }
}

function setSupplyLegendGradient(mode) {
    if (!legendSupplyLcoeBar) return;
    legendSupplyLcoeBar.classList.remove('legend-gradient-cost', 'legend-gradient-delta', 'legend-gradient-tx', 'legend-gradient');
    if (mode === 'cf') {
        legendSupplyLcoeBar.classList.add('legend-gradient');
    } else if (mode === 'delta') {
        legendSupplyLcoeBar.classList.add('legend-gradient-delta');
    } else if (mode === 'tx') {
        legendSupplyLcoeBar.classList.add('legend-gradient-tx');
    } else {
        legendSupplyLcoeBar.classList.add('legend-gradient-cost');
    }
}

function renderSupplyLegendFromInfo(info) {
    if (!legendSupplyLcoeMin || !legendSupplyLcoeMid || !legendSupplyLcoeMax || !legendSupplyLcoeRef) return;
    if (!info) {
        legendSupplyLcoeMin.textContent = '--';
        legendSupplyLcoeMid.textContent = '--';
        legendSupplyLcoeMax.textContent = '--';
        legendSupplyLcoeRef.textContent = 'Reference: --';
        if (legendSupplyLcoeNotes) {
            legendSupplyLcoeNotes.textContent = '';
            legendSupplyLcoeNotes.classList.add('hidden');
        }
        if (legendSupplyLcoeTitle) legendSupplyLcoeTitle.textContent = 'LCOE ($/MWh)';
        setSupplyLegendGradient('cost');
        return;
    }

    if (legendSupplyLcoeTitle) {
        legendSupplyLcoeTitle.textContent = (info.title || 'LCOE ($/MWh)') + legendHint();
    }
    legendSupplyLcoeMin.textContent = info.minLabel || '--';
    legendSupplyLcoeMid.textContent = info.midLabel || '--';
    legendSupplyLcoeMax.textContent = info.maxLabel || '--';
    legendSupplyLcoeRef.textContent = (info.refLabel || 'Reference: --') + legendCostYear(info);
    if (legendSupplyLcoeNotes) {
        legendSupplyLcoeNotes.innerHTML = '';
        const rows = [];
        if (info.underflowLabel) {
            rows.push({
                color: info.underflowColor || rampScale('lcoe').at(0),
                text: info.underflowLabel
            });
        }
        if (info.noDataLabel) {
            rows.push({
                color: LCOE_NO_DATA_COLOR,
                text: info.noDataSuffix === false
                    ? info.noDataLabel
                    : `${info.noDataLabel} (no data / target not met)`
            });
        }
        const filterNote = techFilterText();   // T074
        if (rows.length || filterNote) {
            rows.forEach(row => {
                const wrapper = document.createElement('div');
                wrapper.className = 'flex items-center gap-2';
                const swatch = document.createElement('span');
                swatch.style.backgroundColor = row.color;
                swatch.style.display = 'inline-block';
                swatch.style.width = '12px';
                swatch.style.height = '12px';
                swatch.style.borderRadius = '0';
                if (row.color === NO_DATA_COLOR) swatch.style.border = `1px solid ${DATA_COLOURS.outline}`;
                const label = document.createElement('span');
                label.textContent = row.text;
                wrapper.appendChild(swatch);
                wrapper.appendChild(label);
                legendSupplyLcoeNotes.appendChild(wrapper);
            });
            if (filterNote) legendSupplyLcoeNotes.appendChild(techFilterNoteEl(filterNote));
            legendSupplyLcoeNotes.classList.remove('hidden');
        } else {
            legendSupplyLcoeNotes.classList.add('hidden');
        }
    }
    setSupplyLegendGradient(info.gradient || 'cost');
}

function setInputValue(input, value) {
    if (!input) return;
    // Strip JS float artifacts (e.g. 0.07 * 100 → 7.000000000000001) before display.
    if (typeof value === 'number' && Number.isFinite(value)) {
        input.value = Number(value.toFixed(6)).toString();
        return;
    }
    input.value = value;
}

function setCheckboxValue(input, checked) {
    if (!input) return;
    input.checked = Boolean(checked);
}

function syncLcoeControlValues() {
    const targetCfPct = Math.round((lcoeParams.targetCf || 0) * 100);

    setInputValue(targetCfSlider, targetCfPct);
    if (targetCfVal) targetCfVal.textContent = targetCfPct;
    setInputValue(popTargetCfSlider, targetCfPct);
    if (popTargetCfVal) popTargetCfVal.textContent = targetCfPct;

    setInputValue(solarCapexInput, lcoeParams.solarCapex);
    setInputValue(popSolarCapexInput, lcoeParams.solarCapex);
    setInputValue(batteryCapexInput, lcoeParams.batteryCapex);
    setInputValue(popBatteryCapexInput, lcoeParams.batteryCapex);
    setInputValue(solarOpexInput, (lcoeParams.solarOpexPct || 0) * 100);
    setInputValue(popSolarOpexInput, (lcoeParams.solarOpexPct || 0) * 100);
    setInputValue(batteryOpexInput, (lcoeParams.batteryOpexPct || 0) * 100);
    setInputValue(popBatteryOpexInput, (lcoeParams.batteryOpexPct || 0) * 100);
    setInputValue(solarDegradationInput, (lcoeParams.solarDegradationPct || 0) * 100);
    setInputValue(popSolarDegradationInput, (lcoeParams.solarDegradationPct || 0) * 100);
    setInputValue(solarLifeInput, lcoeParams.solarLife);
    setInputValue(popSolarLifeInput, lcoeParams.solarLife);
    setInputValue(batteryLifeInput, lcoeParams.batteryLife);
    setInputValue(popBatteryLifeInput, lcoeParams.batteryLife);
    setInputValue(waccInput, (lcoeParams.wacc || 0) * 100);
    setInputValue(popWaccInput, (lcoeParams.wacc || 0) * 100);
    setInputValue(ilrInput, lcoeParams.ilr);
    setInputValue(popIlrInput, lcoeParams.ilr);
    // Wind inputs exist in both panels under the same id, with a pop- twin.
    // Writing them from lcoeParams makes WIND_GLOBAL_CAPEX and
    // WIND_WACC_PREMIUM_DEFAULT the one source of their defaults.
    [
        ['wind-capex', lcoeParams.windCapex],
        ['offwind-capex', lcoeParams.windOffCapex],
        ['wind-wacc-premium', (lcoeParams.windWaccPremium || 0) * 100],
        ['offwind-wacc-premium', (lcoeParams.windOffWaccPremium || 0) * 100],
        ['wind-degradation', (lcoeParams.windDegradationPct || 0) * 100],
        ['offwind-degradation', (lcoeParams.windOffDegradationPct || 0) * 100]
    ].forEach(([id, value]) => {
        setInputValue(document.getElementById(id), value);
        setInputValue(document.getElementById(`pop-${id}`), value);
    });

    setCheckboxValue(dieselBackupInput, lcoeParams.includeDieselBackup);
    setCheckboxValue(popDieselBackupInput, lcoeParams.includeDieselBackup);
    includeOffshoreInputs.forEach(input => setCheckboxValue(input, lcoeParams.includeOffshore !== false));
    syncTechControls();
    setInputValue(dieselCapexInput, lcoeParams.dieselCapex);
    setInputValue(popDieselCapexInput, lcoeParams.dieselCapex);
    setInputValue(dieselEfficiencyInput, (lcoeParams.dieselEfficiency || 0) * 100);
    setInputValue(popDieselEfficiencyInput, (lcoeParams.dieselEfficiency || 0) * 100);
    setInputValue(dieselLifeInput, lcoeParams.dieselLife);
    setInputValue(popDieselLifeInput, lcoeParams.dieselLife);
    setInputValue(dieselPriceInput, lcoeParams.dieselPrice);
    setInputValue(popDieselPriceInput, lcoeParams.dieselPrice);
    setInputValue(gasCapexInput, lcoeParams.gasCapex);
    setInputValue(popGasCapexInput, lcoeParams.gasCapex);
    setInputValue(gasEfficiencyInput, (lcoeParams.gasEfficiency || 0) * 100);
    setInputValue(popGasEfficiencyInput, (lcoeParams.gasEfficiency || 0) * 100);
    setInputValue(gasLifeInput, lcoeParams.gasLife);
    setInputValue(popGasLifeInput, lcoeParams.gasLife);
    setInputValue(gasPriceInput, lcoeParams.gasPrice);
    setInputValue(popGasPriceInput, lcoeParams.gasPrice);

    const backupOn = Boolean(lcoeParams.includeDieselBackup);
    if (dieselBackupModeGroup) dieselBackupModeGroup.classList.toggle('hidden', !backupOn);
    if (popDieselBackupModeGroup) popDieselBackupModeGroup.classList.toggle('hidden', !backupOn);
    if (dieselSourceWrapper) dieselSourceWrapper.classList.toggle('hidden', !backupOn);
    if (popDieselSourceWrapper) popDieselSourceWrapper.classList.toggle('hidden', !backupOn);
    if (gasSourceWrapper) gasSourceWrapper.classList.toggle('hidden', !backupOn);
    if (popGasSourceWrapper) popGasSourceWrapper.classList.toggle('hidden', !backupOn);

    const showMainBackupNote = backupOn && lcoeTargetMode === 'utilization';
    if (targetCfContainer) targetCfContainer.classList.toggle('hidden', lcoeTargetMode !== 'utilization');
    if (targetCfBackupNote) targetCfBackupNote.classList.toggle('hidden', !showMainBackupNote);
    if (targetCfSlider) targetCfSlider.disabled = false;

    const showPopBackupNote = backupOn;
    if (popTargetCfContainer) popTargetCfContainer.classList.remove('hidden');
    if (popTargetCfBackupNote) popTargetCfBackupNote.classList.toggle('hidden', !showPopBackupNote);
    if (popTargetCfSlider) popTargetCfSlider.disabled = false;
}

async function setDieselBackupEnabled(enabled) {
    lcoeParams.includeDieselBackup = Boolean(enabled);
    if (lcoeParams.includeDieselBackup) {
        if (dieselPriceMode === 'local') await ensureDieselDataLoaded();
        await ensureGasDataLoaded();
    }
    syncLcoeControlValues();
    resetLcoeTimeLegendLock();

    if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
        updatePopulationView();
    } else {
        queueLcoeUpdate();
    }
}

function updatePopulationOverlayControls(mode) {
    const popCfControls = document.getElementById('population-cf-controls');
    const popLcoeControls = document.getElementById('population-lcoe-controls');
    const popPotentialControls = document.getElementById('population-potential-controls');

    // Show CF controls when CF overlay selected
    if (mode === 'cf') {
        if (popCfControls) popCfControls.classList.remove('hidden');
        if (popLcoeControls) popLcoeControls.classList.add('hidden');
        if (popPotentialControls) popPotentialControls.classList.add('hidden');
    }
    // Show LCOE controls when LCOE overlay selected
    else if (mode === 'lcoe') {
        if (popCfControls) popCfControls.classList.add('hidden');
        if (popLcoeControls) popLcoeControls.classList.remove('hidden');
        if (popPotentialControls) popPotentialControls.classList.add('hidden');
    }
    // Show Potential controls when Potential overlay selected
    else if (mode === 'potential') {
        if (popCfControls) popCfControls.classList.add('hidden');
        if (popLcoeControls) popLcoeControls.classList.add('hidden');
        if (popPotentialControls) popPotentialControls.classList.remove('hidden');
    }
    // Hide all when no overlay
    else {
        if (popCfControls) popCfControls.classList.add('hidden');
        if (popLcoeControls) popLcoeControls.classList.add('hidden');
        if (popPotentialControls) popPotentialControls.classList.add('hidden');
    }

    // Legacy: Handle old overlay config if it exists
    if (populationOverlayConfig) {
        const showCfControls = mode === 'cf';
        populationOverlayConfig.classList.toggle('hidden', !showCfControls);
        if (showCfControls) {
            if (populationSolarSlider) populationSolarSlider.value = currentSolar;
            if (populationSolarVal) populationSolarVal.textContent = currentSolar;
            if (populationBattSlider) populationBattSlider.value = currentBatt;
            if (populationBattVal) populationBattVal.textContent = currentBatt;
        }
    }

    // Show LCOE controls when LCOE overlay selected in population mode
    const showLcoeControls = mode === 'lcoe';
    if (showLcoeControls && populationLcoeWrapper && lcoeControls) {
        // Store original location if not already stored
        if (!lcoeControlsOriginalParent && lcoeControls.parentElement) {
            lcoeControlsOriginalParent = lcoeControls.parentElement;
        }

        // Move LCOE controls to population wrapper
        populationLcoeWrapper.classList.remove('hidden');
        if (lcoeControls.parentElement !== populationLcoeWrapper) {
            populationLcoeWrapper.appendChild(lcoeControls);
        }
        lcoeControls.classList.remove('hidden');
    } else if (populationLcoeWrapper) {
        // Hide the wrapper when not in LCOE overlay mode
        populationLcoeWrapper.classList.add('hidden');
    }

    syncLcoeControlValues();
}

function updatePopulationViewHelperCopy() {
    if (!populationViewHelper || !populationChartsCta) return;
    if (populationDisplayMode === 'charts') {
        populationViewHelper.textContent = 'Charts show demand by latitude, supply by latitude, and demand-weighted supply distributions for the selected layers.';
        populationChartsCta.textContent = 'Show map view';
    } else {
        populationViewHelper.textContent = 'Map mode shows the chosen base layer directly; Charts summarise demand and supply by latitude and distribution.';
        populationChartsCta.textContent = 'Show charts';
    }
}

function showMapContainerOnly() {
    const wasHidden = mapShell?.classList.contains('hidden');
    if (mapShell) mapShell.classList.remove('hidden');
    if (populationChartsContainer) populationChartsContainer.classList.add('hidden');
    if (wasHidden) {
        // Give Leaflet a nudge to recalc sizes after being unhidden
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
}

function showPopulationChartsOnly() {
    if (mapShell) mapShell.classList.add('hidden');
    if (populationChartsContainer) populationChartsContainer.classList.remove('hidden');
    // Hide all legends when showing charts
    hideAllLegends();
    requestAnimationFrame(updatePopulationChartsBounds);
}

function togglePanelCollapse(panelEl, btnEl) {
    if (!panelEl || !btnEl) return;
    const isCollapsed = panelEl.classList.toggle('is-collapsed');
    btnEl.setAttribute('aria-expanded', String(!isCollapsed));
    btnEl.setAttribute('title', isCollapsed ? 'Expand panel' : 'Collapse panel');
    if (currentViewMode === 'population' && populationDisplayMode === 'charts') {
        requestAnimationFrame(updatePopulationChartsBounds);
    }
}

// T084: the Supply panel (top right) ends above the supply map's legend (bottom right) and
// scrolls instead of covering it. Runs whenever the legend's or the panel's size changes and on resize.
const SUPPLY_PANEL_MIN_PX = 160;
function fitSupplyPanelAboveLegend() {
    const panel = populationSupplyPanel;
    if (!panel) return;
    panel.style.maxHeight = '';
    if (!legendSupplyStack || legendSupplyStack.classList.contains('hidden')) return;
    const lr = legendSupplyStack.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    if (!lr.height || !pr.height || pr.right <= lr.left || pr.left >= lr.right) return;
    const room = Math.floor(lr.top - 12 - pr.top);
    if (room < pr.height) panel.style.maxHeight = `${Math.max(SUPPLY_PANEL_MIN_PX, room)}px`;
}
if (typeof ResizeObserver === 'function') {
    // The legend's size and the panel's own (its content grows when a control group opens). Re-fitting
    // the panel to the same cap leaves its size unchanged, so this does not loop.
    const ro = new ResizeObserver(() => fitSupplyPanelAboveLegend());
    if (legendSupplyStack) ro.observe(legendSupplyStack);
    if (populationSupplyPanel) ro.observe(populationSupplyPanel);
}
window.addEventListener('resize', fitSupplyPanelAboveLegend);

function updatePopulationChartsBounds() {
    if (!populationChartsContainer) return;
    const gap = 16;
    let leftPad = 16;
    let rightPad = 16;

    if (populationControls && !populationControls.classList.contains('hidden')) {
        const leftRect = populationControls.getBoundingClientRect();
        leftPad = Math.max(leftPad, leftRect.right + gap);
    }

    if (populationSupplyPanel && !populationSupplyPanel.classList.contains('hidden')) {
        const rightRect = populationSupplyPanel.getBoundingClientRect();
        rightPad = Math.max(rightPad, window.innerWidth - rightRect.left + gap);
    }

    populationChartsContainer.style.setProperty('--charts-left-pad', `${leftPad}px`);
    populationChartsContainer.style.setProperty('--charts-right-pad', `${rightPad}px`);
}

function updatePopulationDisplayToggleUI() {
    updateToggleUI(populationDisplayButtons, populationDisplayMode, 'mode');
}

function updatePopulationOverlayToggleUI() {
    updateToggleUI(populationOverlayButtons, populationOverlayMode, 'overlay');
}

function updatePopulationBaseToggleUI() {
    if (!populationBaseButtons || populationBaseButtons.length === 0) return;
    populationBaseButtons.forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.base === populationBaseLayer);
    });
    // Show/hide plant-specific controls based on base layer
    const showPlantControls = populationBaseLayer === 'plants';
    if (populationFuelFilterWrapper) {
        populationFuelFilterWrapper.classList.toggle('hidden', !showPlantControls);
    }
    if (plantStatusToggle) {
        plantStatusToggle.classList.toggle('hidden', !showPlantControls);
    }
    if (plantLegend) {
        plantLegend.classList.toggle('hidden', !showPlantControls);
    }
    const demandDescription = document.getElementById('population-demand-description');
    if (demandDescription) {
        // Show demand description only when 'Power Demand' (plants) is selected
        demandDescription.classList.toggle('hidden', populationBaseLayer !== 'plants');
    }

    if (reliabilityThresholdControl) {
        const showReliability = populationBaseLayer === 'uptime';
        reliabilityThresholdControl.classList.toggle('hidden', !showReliability);
        if (showReliability) {
            if (reliabilityThresholdSlider) reliabilityThresholdSlider.value = reliabilityThreshold;
            if (reliabilityThresholdVal) reliabilityThresholdVal.textContent = reliabilityThreshold;
        }
    }

    // Update chart titles based on base layer
    const titlePercentile = document.getElementById('chart-title-percentile');
    const titleDemandLatitude = document.getElementById('chart-title-demand-latitude');

    if (populationBaseLayer === 'plants') {
        if (titlePercentile) titlePercentile.textContent = 'Metric by Displaceable Plant Capacity Percentile';
        if (titleDemandLatitude) titleDemandLatitude.textContent = 'Displaceable Capacity by Latitude';
    } else if (populationBaseLayer === 'access') {
        if (titlePercentile) titlePercentile.textContent = 'People Without Access by Supply Metric';
        if (titleDemandLatitude) titleDemandLatitude.textContent = 'People Without Access by Latitude';
    } else if (populationBaseLayer === 'uptime') {
        if (titlePercentile) titlePercentile.textContent = `People Below ${reliabilityThreshold}% Uptime by Supply Metric`;
        if (titleDemandLatitude) titleDemandLatitude.textContent = `People Below ${reliabilityThreshold}% Uptime by Latitude`;
    } else {
        if (titlePercentile) titlePercentile.textContent = 'Metric by Population Percentile';
        if (titleDemandLatitude) titleDemandLatitude.textContent = populationBaseLayer === 'electricity'
            ? 'Electricity Demand by Latitude'
            : 'Population by Latitude';
    }
}

function updateWaccSourceToggleUI() {
    updateToggleUI(waccSourceButtons, waccMode, 'mode');
    updateToggleUI(popWaccSourceButtons, waccMode, 'mode');
    if (waccGlobalInputs) waccGlobalInputs.classList.toggle('hidden', waccMode === 'local');
    if (popWaccGlobalInputs) popWaccGlobalInputs.classList.toggle('hidden', waccMode === 'local');
}

function updateCapexSourceToggleUI() {
    updateToggleUI(capexSourceButtons, capexMode, 'mode');
    updateToggleUI(popCapexSourceButtons, capexMode, 'mode');
    if (capexGlobalInputs) capexGlobalInputs.classList.toggle('hidden', capexMode === 'local');
    if (popCapexGlobalInputs) popCapexGlobalInputs.classList.toggle('hidden', capexMode === 'local');
}

function updateDieselSourceToggleUI() {
    updateToggleUI(dieselSourceButtons, dieselPriceMode, 'mode');
    updateToggleUI(popDieselSourceButtons, dieselPriceMode, 'mode');
    if (dieselGlobalInputs) dieselGlobalInputs.classList.toggle('hidden', dieselPriceMode === 'local');
    if (popDieselGlobalInputs) popDieselGlobalInputs.classList.toggle('hidden', dieselPriceMode === 'local');
}

function updateGasSourceToggleUI() {
    updateToggleUI(gasSourceButtons, gasPriceMode, 'mode');
    updateToggleUI(popGasSourceButtons, gasPriceMode, 'mode');
    if (gasGlobalInputs) gasGlobalInputs.classList.toggle('hidden', gasPriceMode === 'local');
    if (popGasGlobalInputs) popGasGlobalInputs.classList.toggle('hidden', gasPriceMode === 'local');
}

async function setGasPriceMode(mode) {
    const normalized = mode === 'global' ? 'global' : 'local';
    if (gasPriceMode === normalized) return;
    gasPriceMode = normalized;
    lcoeParams.gasPriceMode = normalized;
    updateGasSourceToggleUI();
    resetLcoeTimeLegendLock();
    if (lcoeParams.includeDieselBackup) {
        await ensureGasDataLoaded();
    }
    if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
        updatePopulationView();
    } else {
        queueLcoeUpdate();
    }
}

async function setWaccMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (waccMode === normalized) return;
    waccMode = normalized;
    updateWaccSourceToggleUI();
    resetLcoeTimeLegendLock();
    if (waccMode === 'local') {
        await ensureWaccDataLoaded();
    }
    queueLcoeUpdate();
}

async function setCapexMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (capexMode === normalized) return;
    capexMode = normalized;
    updateCapexSourceToggleUI();
    resetLocalCapexCache();
    resetLcoeTimeLegendLock();
    if (capexMode === 'local') {
        await ensureLocalCapexDataLoaded();
    }
    queueLcoeUpdate();
}

async function setDieselPriceMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (dieselPriceMode === normalized) return;
    dieselPriceMode = normalized;
    lcoeParams.dieselPriceMode = normalized;
    updateDieselSourceToggleUI();
    resetLcoeTimeLegendLock();
    if (dieselPriceMode === 'local' && lcoeParams.includeDieselBackup) {
        await ensureDieselDataLoaded();
    }
    if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
        updatePopulationView();
    } else {
        queueLcoeUpdate();
    }
}

// Fuel chips: pressed state, dot colour from the registry, and the size legend at
// the map's own radii (T075: the chips looked off while on, and the legend's
// Tailwind colours were not the ones drawn).
function updatePopulationFuelToggleUI() {
    if (!populationFuelButtons || populationFuelButtons.length === 0) return;
    populationFuelButtons.forEach(btn => {
        const fuel = btn.dataset.fuel;
        btn.style.setProperty('--fuel', FUEL_COLORS[fuel] || DATA_COLOURS.plantFallback);
        btn.setAttribute('aria-pressed', populationFuelFilter.has(fuel) ? 'true' : 'false');
    });
    const sizeLegend = document.getElementById('plant-size-legend');
    if (sizeLegend && !sizeLegend.childElementCount) {
        sizeLegend.innerHTML = PLANT_MARKER.sizeLegendMw.map(mw => {
            const r = PLANT_MARKER.radius(mw), d = 2 * r + 2;
            const label = mw >= 1000 ? `${mw / 1000} GW` : `${mw} MW`;
            return `<span class="inline-flex flex-col items-center gap-1" data-size-mw="${mw}"><svg width="${d}" height="${d}" aria-hidden="true"><circle cx="${d / 2}" cy="${d / 2}" r="${r}" fill="none" stroke="currentColor" stroke-width="1"/></svg>${label}</span>`;
        }).join('');
    }
}

function updatePlantStatusToggleUI() {
    updateToggleUI(plantStatusButtons, plantStatusFilter, 'status');
}

// Note: Chart toggle functions use different styling (slate colors) - keeping inline for now
// to preserve visual distinction from main toggle buttons
function updateChartLayerToggleUI() {
    if (!populationChartLayerButtons?.length) return;
    populationChartLayerButtons.forEach(btn => {
        const isActive = btn.dataset.layer === populationBaseLayer;
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
}

const potentialTechButtons = document.querySelectorAll('#potential-tech-toggle button');
const potentialDefinitionButtons = document.querySelectorAll('#potential-definition-toggle button');
const potentialOffshoreButtons = document.querySelectorAll('#potential-offshore-toggle button');
// T085: one line per solar option, naming its source (T062 word targets). Ground-mount is fixed at
// 50 MW/km² (T097, D-178); rooftop is always the whole building footprint (D-157).
const POTENTIAL_SOLAR_NOTE = {
    density: 'Ground-mount: 50 MW/km², between whole-park and array-area densities',
    roof: 'Rooftop: whole building footprint at 100 MW/km² (Joshi et al.)',
    level: {
        level1: 'World Bank/ESMAP (2020) Level 1: technical exclusions',
        level2: 'World Bank/ESMAP (2020) Level 2: adds policy exclusions'
    }
};
const potentialWindNoteIds = ['solar', 'wind', 'onshore', 'offshore', 'all'];

const potentialIsWindOnly = () => potentialTech === 'onshore' || potentialTech === 'offshore';
const POTENTIAL_DEFINITION_TEXT = {
    onshore: { cons: 'Conservative', tech: 'Technical' },
    offshore: { cons: 'ESMAP', tech: 'IEA' }
};
// One line per option, naming its source (T062 word targets).
const POTENTIAL_DEFINITION_NOTE = {
    onshore: { cons: 'Scaled to new wind farms, 3 MW/km², land reaching 20%', tech: '5 MW/km², each pixel\'s own capacity factor, land reaching 15%' },
    offshore: { cons: 'World Bank/ESMAP (2021): to 1,000 m deep, 200 km out', tech: 'IEA (2019): to 2,000 m deep, 300 km out' },
    all: { cons: 'Onshore conservative, offshore World Bank/ESMAP', tech: 'Onshore technical, offshore IEA (2019)' }
};

// Controls of the Potential view's wind options: what applies to the chosen
// technology is shown or enabled, the rest is hidden or greyed out.
function syncPotentialTechUI() {
    if (!potentialTechButtons.length) return;
    const windOnly = potentialIsWindOnly();
    updateToggleUI(potentialTechButtons, potentialTech, 'tech');
    updateToggleUI(potentialDefinitionButtons, potentialDefinition, 'definition');
    updateToggleUI(potentialOffshoreButtons, potentialOffshoreLayer, 'offshore');
    // T085: Solar shows its own options in the Definition row; wind keeps the toggle above.
    const solarDef = potentialTech === 'solar';
    document.getElementById('potential-definition-row')?.classList.remove('hidden');
    // A .toggle-group-grid's own display: grid beats Tailwind's .hidden, so hide it inline (T097).
    const defToggle = document.getElementById('potential-definition-toggle');
    if (defToggle) {
        defToggle.classList.toggle('hidden', solarDef);
        defToggle.style.display = solarDef ? 'none' : '';
    }
    document.getElementById('potential-definition-note')?.classList.toggle('hidden', solarDef);
    document.getElementById('potential-solar-definition')?.classList.toggle('hidden', !solarDef);
    const solarNote = document.getElementById('potential-solar-definition-note');
    if (solarNote) solarNote.textContent = `${POTENTIAL_SOLAR_NOTE.density}. ${POTENTIAL_SOLAR_NOTE.roof}.`;
    const solarLevelNote = document.getElementById('potential-level-solar-note');
    if (solarLevelNote) {
        solarLevelNote.classList.toggle('hidden', !solarDef);
        solarLevelNote.textContent = POTENTIAL_SOLAR_NOTE.level[potentialLevel] || '';
    }
    // Offshore names its sources; onshore and All the case (Conservative pairs with ESMAP).
    const defKey = potentialTech === 'offshore' ? 'offshore' : 'onshore';
    potentialDefinitionButtons.forEach(btn => {
        const label = POTENTIAL_DEFINITION_TEXT[defKey][btn.dataset.definition];
        if (label) btn.textContent = label;
    });
    const defNote = document.getElementById('potential-definition-note');
    if (defNote) defNote.textContent = POTENTIAL_DEFINITION_NOTE[potentialTech]?.[potentialDefinition] || '';
    document.getElementById('potential-offshore-row')?.classList.toggle('hidden', potentialTech !== 'offshore');
    const setDisabled = (btn, off) => {
        btn.disabled = off;
        btn.style.opacity = off ? '0.35' : '';
        btn.style.cursor = off ? 'not-allowed' : '';
    };
    potentialLevelButtons.forEach(btn => setDisabled(btn, windOnly));
    const levelNote = document.getElementById('potential-level-wind-note');
    if (levelNote) {
        levelNote.classList.toggle('hidden', potentialTech === 'solar');
        levelNote.textContent = windOnly
            ? 'Solar only'
            : 'Applies to solar only';
    }
    updateToggleUI(potentialDisplayButtons, potentialDisplayMode, 'display');
    const shown = {
        solar: potentialTech === 'solar' || potentialTech === 'all',
        wind: potentialTech !== 'solar',
        onshore: potentialTech === 'onshore' || potentialTech === 'all',
        offshore: potentialTech === 'offshore' || potentialTech === 'all',
        all: potentialTech === 'all'
    };
    potentialWindNoteIds.forEach(id => {
        document.getElementById(`potential-note-${id}`)?.classList.toggle('hidden', !shown[id]);
    });
}

function syncPotentialToggleUI() {
    if (potentialLevelButtons?.length) {
        updateToggleUI(potentialLevelButtons, potentialLevel, 'level');
    }
    if (potentialDisplayButtons?.length) {
        updateToggleUI(potentialDisplayButtons, potentialDisplayMode, 'display');
    }
    syncPotentialTechUI();
    if (supplyPotentialLevelButtons?.length) {
        updateToggleUI(supplyPotentialLevelButtons, potentialLevel, 'level');
    }
    if (supplyPotentialDisplayButtons?.length) {
        updateToggleUI(supplyPotentialDisplayButtons, potentialDisplayMode, 'display');
    }
}

function setPopulationBaseLayer(mode) {
    const validModes = new Set(['population', 'plants', 'electricity', 'access', 'uptime']);
    const normalized = validModes.has(mode) ? mode : 'population';
    populationBaseLayer = normalized;
    if (normalized === 'access') {
        applyAccessMetric('no_access_pop');
    } else if (normalized === 'uptime') {
        applyAccessMetric('reliability');
    }
    updatePopulationBaseToggleUI();
    updateChartLayerToggleUI();
    updatePopulationFuelToggleUI();
    updatePopulationViewHelperCopy();
    if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

function setPopulationDisplayMode(mode) {
    const normalized = mode === 'charts' ? 'charts' : 'map';
    populationDisplayMode = normalized;
    updatePopulationDisplayToggleUI();
    updatePopulationViewHelperCopy();
    setDualMapMode(currentViewMode === 'population' && populationDisplayMode === 'map');
    if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

function updatePopulationLegend(popData, overlayMode = 'none', baseLayer = 'population') {
    if (currentViewMode !== 'population') return;
    const legendElecMin = document.getElementById('legend-elec-min');
    const legendElecMax = document.getElementById('legend-elec-max');
    const legendAccessBar = document.getElementById('legend-access-bar');
    const legendAccessTitle = document.getElementById('legend-access-title');
    const legendAccessMin = document.getElementById('legend-access-min');
    const legendAccessMid = document.getElementById('legend-access-mid');
    const legendAccessMax = document.getElementById('legend-access-max');
    const legendAccessNote = document.getElementById('legend-access-note');

    // Hide all by default
    hidePopulationLegends();

    // Show Energy Access legend if access overlay is active OR if access/uptime is the base layer
    if ((overlayMode === 'access' || baseLayer === 'access' || baseLayer === 'uptime') && legendAccess) {
        legendAccess.classList.remove('hidden');
    }

    if (baseLayer === 'electricity') {
        // Show electricity legend
        if (!legendElectricity) return;
        if (electricityDemandData && electricityDemandData.length > 0) {
            const vals = electricityDemandData.map(d => d.annual_demand_kwh || 0).filter(v => v > 0);
            const maxKwh = Math.max(...vals, 0);
            const maxTwh = maxKwh / 1e9; // Convert to TWh
            if (legendElecMin) legendElecMin.textContent = '0';
            if (legendElecMax) legendElecMax.textContent = maxTwh > 0 ? maxTwh.toFixed(1) + ' TWh' : '--';
        }
        legendElectricity.classList.remove('hidden');
    } else if (baseLayer === 'plants') {
        // No population/electricity legend for plant bubbles view
        return;
    } else if (baseLayer === 'access' || baseLayer === 'uptime') {
        // Energy Access legend is already shown above, don't show population
        // Just update note if present
        const legendAccessToggle = document.getElementById('legend-access-toggle');
        if (legendAccessToggle) {
            // Hide toggle when access/reliability are separate tabs
            legendAccessToggle.classList.add('hidden');
        }
        if (legendAccessBar) {
            if (accessMetric === 'no_access_pop') {
                legendAccessBar.style.background = 'var(--ramp-no-access)';
            } else {
                legendAccessBar.style.background = 'var(--ramp-green)';
            }
        }
        if (legendAccessTitle) {
            legendAccessTitle.textContent = accessMetric === 'no_access_pop'
                ? 'Population Without Access'
                : 'Grid Reliability';
        }
        if (legendAccessMin && legendAccessMid && legendAccessMax) {
            if (accessMetric === 'no_access_pop') {
                legendAccessMin.textContent = 'Low';
                legendAccessMid.textContent = '';
                legendAccessMax.textContent = 'High';
            } else {
                legendAccessMin.textContent = '0%';
                legendAccessMid.textContent = '';
                legendAccessMax.textContent = '100%';
            }
        }
        // No data is black in both modes; navy (universal access) only in the
        // people-without-access mode (T075: one slate swatch stood for both).
        document.getElementById('legend-access-universal')?.classList.toggle('hidden', accessMetric !== 'no_access_pop');
        if (legendPopLayerNote) {
            if (accessMetric === 'no_access_pop') {
                legendPopLayerNote.textContent = 'Colour: population without electricity access (log scale).';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            } else if (accessMetric === 'no_access') {
                legendPopLayerNote.textContent = 'Colour: share of population without access (%).';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            } else {
                legendPopLayerNote.textContent = 'Colour: average grid uptime (reliability) for each cell.';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            }
        }
    } else {
        const legendAccessToggle = document.getElementById('legend-access-toggle');
        if (legendAccessToggle) {
            legendAccessToggle.classList.remove('hidden');
        }
        // Show population legend
        if (!legendPopulation || !legendPopMin || !legendPopMax) return;
        if (!popData || popData.length === 0) {
            return;
        }
        const vals = popData.map(p => p.population_2020 || 0).filter(Number.isFinite);
        const max = Math.max(...vals, 0);
        legendPopMin.textContent = '0';
        legendPopMax.textContent = max ? formatNumber(max, 0) : '--';
        legendPopulation.classList.remove('hidden');
        if (legendPopLayerNote) {
            if (overlayMode === 'cf') {
                legendPopLayerNote.textContent = 'Colour: capacity factor of the build set in the Supply panel.';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            } else if (overlayMode === 'lcoe') {
                legendPopLayerNote.textContent = 'Colour: LCOE for each viable cell.';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            } else if (overlayMode === 'access') {
                legendPopLayerNote.textContent = 'Colour: average grid uptime (reliability) for each cell.';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            } else {
                legendPopLayerNote.textContent = 'Colour: population shading only (no additional metric selected).';
                legendPopLayerNote.classList.remove('text-slate-300');
                legendPopLayerNote.classList.add('text-slate-500');
            }
        }
    }
}

function updateSupplyLegend(overlayMode = 'none', lcoeColorInfo = null, potentialState = null) {
    if (currentViewMode !== 'population' || populationDisplayMode !== 'map') {
        hideSupplyLegends();
        return;
    }
    if (!legendSupplyStack) return;
    if (!overlayMode || overlayMode === 'none') {
        hideSupplyLegends();
        return;
    }

    legendSupplyStack.classList.remove('hidden');
    if (legendSupplyCapacity) legendSupplyCapacity.classList.add('hidden');
    if (legendSupplyLcoe) legendSupplyLcoe.classList.add('hidden');
    if (legendSupplyPotential) legendSupplyPotential.classList.add('hidden');

    if (overlayMode === 'cf') {
        if (legendSupplyCapacity) legendSupplyCapacity.classList.remove('hidden');
    } else if (overlayMode === 'lcoe') {
        if (legendSupplyLcoe) legendSupplyLcoe.classList.remove('hidden');
        renderSupplyLegendFromInfo(lcoeColorInfo);
    } else if (overlayMode === 'potential') {
        if (legendSupplyPotential) legendSupplyPotential.classList.remove('hidden');
        const hasData = potentialState && potentialState.valueCount;
        const isMultiple = potentialState?.isMultiple;
        const isPerCapita = potentialState?.isPerCapita;
        const usesBuckets = Boolean(isMultiple || isPerCapita);
        const buckets = isPerCapita ? POTENTIAL_PER_CAPITA_BUCKETS : POTENTIAL_MULTIPLE_BUCKETS;
        if (legendSupplyPotentialTitle) {
            legendSupplyPotentialTitle.textContent = isMultiple
                ? 'Solar Generation Potential / Electricity Demand Today (x multiple)'
                : isPerCapita
                    ? 'Solar Generation Potential per Capita (MWh / person / year)'
                    : 'Solar Generation Potential (TWh/yr)';
        }
        if (legendSupplyPotentialBar) {
            legendSupplyPotentialBar.classList.toggle('legend-gradient-potential', !usesBuckets);
            legendSupplyPotentialBar.classList.toggle('hidden', usesBuckets);
        }
        if (legendSupplyPotentialBuckets) {
            // T075: the supply map draws no-data cells black in every mode, so the row shows always.
            legendSupplyPotentialBuckets.classList.remove('hidden');
            const noData = `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-sm" style="background:${NO_DATA_COLOR};border:1px solid ${DATA_COLOURS.outline}"></span><span>No data</span></div>`;
            if (!usesBuckets) legendSupplyPotentialBuckets.innerHTML = noData;
            if (usesBuckets) {
                const items = buckets.map(bucket => (
                    `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-sm" style="background:${bucket.color}"></span><span>${bucket.label}</span></div>`
                ));
                legendSupplyPotentialBuckets.innerHTML = `${items.join('')}${noData}`;
            }
        }
        if (legendSupplyPotentialMin) {
            legendSupplyPotentialMin.textContent = hasData && !usesBuckets
                ? formatNumber(potentialState.min, 2)
                : '';
            legendSupplyPotentialMin.classList.toggle('hidden', usesBuckets);
        }
        if (legendSupplyPotentialMax) {
            legendSupplyPotentialMax.textContent = hasData && !usesBuckets
                ? formatNumber(potentialState.max, 2)
                : '';
            legendSupplyPotentialMax.classList.toggle('hidden', usesBuckets);
        }
    } else {
        hideSupplyLegends();
    }
}

function updateLegendLockButton() {
    if (!legendLockBtn) return;
    if (!lcoeReference) {
        legendLockBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        legendLockBtn.textContent = 'Fix legend scales';
    } else {
        legendLockBtn.classList.remove('hidden');
        legendLockBtn.textContent = legendLock ? 'Release legend scales' : 'Fix legend scales';
    }
}

/** The legend line stating the technology filter (T074). */
function techFilterNoteEl(text) {
    const el = document.createElement('div');
    el.className = 'legend-tech-filter';
    el.textContent = text;
    return el;
}

function renderLegendFromInfo(info) {
    if (!info) {
        legendLcoeMin.textContent = '--';
        legendLcoeMid.textContent = '--';
        legendLcoeMax.textContent = '--';
        legendLcoeRef.textContent = 'Reference: --';
        if (legendLcoeNotes) {
            legendLcoeNotes.textContent = '';
            legendLcoeNotes.classList.add('hidden');
        }
        if (legendLcoeTitle) legendLcoeTitle.textContent = 'LCOE ($/MWh)';
        setLegendGradient('cost');
        legendLcoeBar.style.background = '';
        legendTxExplainer?.classList.add('hidden');
        comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        updateLegendLockButton();
        return;
    }

    if (legendLcoeTitle) {
        legendLcoeTitle.textContent = (info.title || 'LCOE ($/MWh)') + legendHint();
    }
    legendLcoeMin.textContent = info.minLabel || '--';
    legendLcoeMid.textContent = info.midLabel || '--';
    legendLcoeMax.textContent = info.maxLabel || '--';
    legendLcoeRef.textContent = (info.refLabel || 'Reference: --') + legendCostYear(info);
    if (legendLcoeNotes) {
        legendLcoeNotes.innerHTML = '';
        const rows = [];
        if (info.underflowLabel) {
            rows.push({
                color: info.underflowColor || rampScale('lcoe').at(0),
                text: info.underflowLabel
            });
        }
        if (info.noDataLabel) {
            rows.push({
                color: LCOE_NO_DATA_COLOR,
                text: info.noDataSuffix === false
                    ? info.noDataLabel
                    : `${info.noDataLabel} (no data / target not met)`
            });
        }
        if (Array.isArray(info.rows)) rows.push(...info.rows);
        const filterNote = techFilterText();   // T074: the active technology filter
        if (rows.length || filterNote) {
            rows.forEach(row => {
                const wrapper = document.createElement('div');
                wrapper.className = 'flex items-center gap-2';
                const swatch = document.createElement('span');
                swatch.style.backgroundColor = row.color;
                swatch.style.display = 'inline-block';
                swatch.style.width = '12px';
                swatch.style.height = '12px';
                swatch.style.borderRadius = '0';
                if (row.color === NO_DATA_COLOR) swatch.style.border = `1px solid ${DATA_COLOURS.outline}`;
                const label = document.createElement('span');
                label.textContent = row.text;
                wrapper.appendChild(swatch);
                wrapper.appendChild(label);
                legendLcoeNotes.appendChild(wrapper);
            });
            if (filterNote) legendLcoeNotes.appendChild(techFilterNoteEl(filterNote));
            legendLcoeNotes.classList.remove('hidden');
        } else {
            legendLcoeNotes.classList.add('hidden');
        }
    }
    setLegendGradient(info.gradient || 'cost');
    legendLcoeBar.style.background = info.gradientCss || '';
    if (legendTxExplainer) {
        if (info.type === 'tx') {
            legendTxExplainer.classList.remove('hidden');
        } else {
            legendTxExplainer.classList.add('hidden');
        }
    }

    if (info.showComparison) {
        comparisonToggle.classList.remove('hidden');
        clearRefBtn.classList.remove('hidden');
        updateLegendLockButton();
    } else {
        comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();
    }
}

function updateLcoeLegendForMode(mode) {
    // Update legend when display mode changes
    // This will be handled by the next updateModel() call
    // which will call prepareLcoeDisplayData() -> updateLcoeLegend()
}

function updateLcoeLegend(points, overrideInfo = null) {
    if (overrideInfo) {
        renderLegendFromInfo(overrideInfo);
        return overrideInfo;
    }

    const valid = points.filter(p => p.meetsTarget && Number.isFinite(p.lcoe));
    if (!valid.length) {
        const info = {
            type: 'lcoe',
            title: 'LCOE ($/MWh)',
            minLabel: '--',
            midLabel: '--',
            maxLabel: '--',
            refLabel: 'Reference: --',
            gradient: 'cost',
            showComparison: false,
            domain: null
        };
        renderLegendFromInfo(info);
        return info;
    }

    if (lcoeReference) {
        if (lcoeDisplayMode === 'transmission') {
            const txValues = points
                .filter(p => p.meetsTarget && p.txMetrics && p.txMetrics.breakevenPerGwKm > 0)
                .map(p => p.txMetrics.breakevenPerGwKm)
                .sort((a, b) => a - b);
            let domain;
            let minLabel = '$0/MW/km';
            let midLabel = '--';
            let maxLabel = '--';
            if (txValues.length) {
                const pick = (q) => txValues[Math.min(txValues.length - 1, Math.max(0, Math.floor(q * txValues.length)))];
                const rawMax = pick(0.95) || txValues[txValues.length - 1];
                const max = Math.max(rawMax, 1);
                const mid = Math.max(pick(0.5), max * 0.5);
                domain = [0, mid, max];
                midLabel = `${formatCurrencyLabel(mid / 1000)} /MW/km`;
                maxLabel = `${formatCurrencyLabel(max / 1000)} /MW/km`;
            } else {
                domain = [0, 1, 1];
            }
            const info = {
                type: 'tx',
                domain,
                title: 'Breakeven Transmission ($/MW/km)',
                minLabel,
                midLabel,
                maxLabel,
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'tx',
                showComparison: true,
                noDataLabel: `> ${maxLabel}`
            };
            renderLegendFromInfo(info);
            return info;
        }

        const withDelta = points.filter(p => p.meetsTarget && Number.isFinite(p.delta));
        let info;
        if (!withDelta.length) {
            info = {
                type: 'delta',
                maxAbs: 1,
                title: 'LCOE Δ ($/MWh)',
                minLabel: '--',
                midLabel: '$0',
                maxLabel: '--',
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'delta',
                showComparison: true,
                noDataLabel: ''
            };
        } else {
            const absVals = withDelta.map(p => Math.abs(p.delta)).sort((a, b) => a - b);
            const pick = (q) => absVals[Math.min(absVals.length - 1, Math.max(0, Math.floor(q * absVals.length)))];
            const maxAbs = Math.max(1, pick(DELTA_PERCENTILE) || absVals[absVals.length - 1] || 1);
            const labelVal = Math.max(1, Math.round(maxAbs));
            info = {
                type: 'delta',
                maxAbs: labelVal,
                title: 'LCOE Δ ($/MWh)',
                minLabel: `-${formatCurrencyLabel(labelVal)}`,
                midLabel: '$0',
                maxLabel: `+${formatCurrencyLabel(labelVal)}`,
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'delta',
                showComparison: true,
                noDataLabel: `Outside target CF`
            };
        }
        renderLegendFromInfo(info);
        return info;
    }

    // Fixed registry scale: the bar runs linearly from the first to the last
    // stop, values beyond either end take the end colour.
    const domain = RAMPS.lcoe.domain;
    const lo = domain[0], hi = domain[domain.length - 1];
    const info = {
        type: 'lcoe',
        domain,
        title: 'LCOE ($/MWh)',
        minLabel: `≤ ${formatCurrencyLabel(lo)}`,
        midLabel: formatCurrencyLabel(Math.round((lo + hi) / 2)),
        maxLabel: `≥ ${formatCurrencyLabel(hi)}`,
        refLabel: 'Reference: --',
        gradient: 'cost',
        showComparison: false,
        noDataLabel: 'No data / target not met',
        noDataSuffix: false
    };
    renderLegendFromInfo(info);
    return info;
}

// Legend for CF mode (Target LCOE)
function updateCfLegend(points) {
    // User requested fixed 0-100% scale
    const info = {
        type: 'cf',
        domain: RAMPS.cf.domain,
        title: 'Capacity Factor (%)',
        minLabel: '0%',
        midLabel: '50%',
        maxLabel: '100%',
        refLabel: lcoeReference ? `Reference: ${(lcoeReference.cf * 100).toFixed(0)}%` : '',
        gradient: 'cf',
        showComparison: Boolean(lcoeReference)
    };

    renderLegendFromInfo(info);
    return info;
}

function queueLcoeUpdate() {
    // Check if we need to update LCOE view
    const isLcoeMode = currentViewMode === 'lcoe';
    const isPopulationWithLcoeOverlay = currentViewMode === 'population' && populationOverlayMode === 'lcoe';

    if (!isLcoeMode && !isPopulationWithLcoeOverlay) return;

    if (lcoeUpdateTimeout) {
        clearTimeout(lcoeUpdateTimeout);
    }
    lcoeUpdateTimeout = setTimeout(() => {
        lcoeUpdateTimeout = null;
        if (currentViewMode === 'lcoe') {
            updateLcoeView();
        } else if (currentViewMode === 'population') {
            updatePopulationView();
        }
    }, 150);
}

// Raw supply/demand components for a potential row (TWh/yr), respecting level + latBounds.
// Returns null when the row is out of bounds or has no finite total.
function getPotentialRowComponents(row, potentialState) {
    if (!row || !potentialState) return null;
    const level = potentialState.level || 'level1';
    const totalKey = level === 'level2' ? 'total_level2_twh_y' : 'total_level1_twh_y';
    const groundKey = level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
    const rawTotal = Number(row[totalKey]);
    const total = Number.isFinite(rawTotal) ? rawTotal : Number(row[groundKey] || 0);
    const latVal = Number(row.latitude);
    const bounds = potentialState.latBounds;
    if (bounds && (!Number.isFinite(latVal) || latVal < bounds.min || latVal > bounds.max)) {
        return null;
    }
    if (!Number.isFinite(total)) return null;
    const demandRow = potentialState.demandMap ? potentialState.demandMap.get(row.location_id) : null;
    const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
    const demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
    return { total, demandTwh };
}

function getPotentialMetricFromRow(row, potentialState) {
    const comp = getPotentialRowComponents(row, potentialState);
    if (!comp) return null;
    if (potentialState.displayMode === 'multiple') {
        if (comp.demandTwh <= 0) return null;
        return comp.total / comp.demandTwh;
    }
    if (potentialState.displayMode === 'per_capita') {
        const pop = potentialState.populationMap ? Number(potentialState.populationMap.get(row.location_id) || 0) : 0;
        if (!(pop > 0)) return null;
        return (comp.total * 1e6) / pop;
    }
    return comp.total;
}

function buildPopulationMetrics(enrichedPop, overlayMode, cfData, lcoeData, potentialState = null) {
    const cfByCoord = new Map(cfData.map(d => [coordKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [coordKey(d.latitude, d.longitude), d]));
    const potentialById = potentialState?.data ? new Map(potentialState.data.map(d => [d.location_id, d])) : null;
    const potentialByCoord = potentialState?.data ? new Map(potentialState.data.map(d => [coordKey(d.latitude, d.longitude), d])) : null;
    return enrichedPop.map((p, idx) => {
        const key = coordKey(p.latitude, p.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);
        const potentialRow = potentialById?.get(p.location_id) || potentialByCoord?.get(key);
        const weight = Math.max(0, p.population_2020 || 0);
        let metricVal;
        if (overlayMode === 'cf') {
            metricVal = cfRow?.annual_cf;
        } else if (overlayMode === 'lcoe') {
            metricVal = lcoeRow?.lcoe;
        } else if (overlayMode === 'potential') {
            metricVal = getPotentialMetricFromRow(potentialRow, potentialState);
        } else {
            metricVal = weight;
        }
        if ((overlayMode === 'cf' || overlayMode === 'lcoe' || overlayMode === 'potential') && !Number.isFinite(metricVal)) {
            return null;
        }
        // Get location_id from cfRow or lcoeRow (they should have it)
        const location_id = cfRow?.location_id ?? lcoeRow?.location_id ?? potentialRow?.location_id ?? p.location_id ?? idx;
        return {
            location_id,
            latitude: p.latitude,
            longitude: p.longitude,
            metric: metricVal,
            weight
        };
    }).filter(m => {
        if (!m) return false;
        if (overlayMode === 'cf' || overlayMode === 'lcoe' || overlayMode === 'potential') {
            return Number.isFinite(m.metric);
        }
        return m.weight > 0;
    });
}

// Note: FUEL_COLORS now imported from constants.js

function buildPlantMetrics(capacityRows, overlayMode, cfData, lcoeData, selectedFuels, statusFilter, potentialState = null) {
    const cfById = new Map(cfData.map(d => [d.location_id, d]));
    const lcoeById = new Map(lcoeData.map(d => [d.location_id, d]));
    const potentialById = potentialState?.data ? new Map(potentialState.data.map(d => [d.location_id, d])) : null;
    // An empty selection means no fuels, as on the map (T075: it used to mean all four).
    const fuelSet = selectedFuels instanceof Set ? selectedFuels : new Set(ALL_FUELS);
    const suffix = statusFilter ? capitalizeWord(statusFilter) : 'Announced';

    return capacityRows.flatMap(row => {
        return Array.from(fuelSet).map(fuel => {
            const col = `${fuel}_${suffix}`;
            const weight = Math.max(0, Number(row[col]) || 0);
            if (!weight) return null;

            let metricVal;
            if (overlayMode === 'cf') {
                metricVal = cfById.get(row.location_id)?.annual_cf;
            } else if (overlayMode === 'lcoe') {
                metricVal = lcoeById.get(row.location_id)?.lcoe;
            } else if (overlayMode === 'potential') {
                const potentialRow = potentialById?.get(row.location_id);
                metricVal = getPotentialMetricFromRow(potentialRow, potentialState);
            } else {
                // If no overlay, metric is just capacity? Or just weight?
                // For Percentile chart with no overlay, usually we sort by capacity?
                // But previous logic set metricVal = weight.
                metricVal = weight;
            }

            if ((overlayMode === 'cf' || overlayMode === 'lcoe' || overlayMode === 'potential') && !Number.isFinite(metricVal)) {
                return null;
            }

            return {
                latitude: Number(row.latitude),
                longitude: Number(row.longitude),
                location_id: row.location_id,
                metric: metricVal,
                weight: weight,
                fuel: fuel
            };
        }).filter(Boolean);
    });
}

function getPeopleWithoutAccess(row) {
    if (!row?.pop_bins) return 0;
    const val = row.pop_bins[0];
    return Number.isFinite(val) ? val : 0;
}

function getPeopleBelowUptime(row, threshold) {
    if (!row?.pop_bins) return 0;
    const limit = Number.isFinite(threshold) ? threshold : 90;
    let sum = 0;
    Object.entries(row.pop_bins).forEach(([midpoint, pop]) => {
        const mid = Number(midpoint);
        const val = Number(pop) || 0;
        if (Number.isFinite(mid) && mid < limit) {
            sum += val;
        }
    });
    return sum;
}

function buildReliabilityMetrics(reliabilityRows, overlayMode, cfData, lcoeData, potentialState = null, mode = 'access') {
    const cfById = new Map(cfData.map(d => [d.location_id, d]));
    const lcoeById = new Map(lcoeData.map(d => [d.location_id, d]));
    const potentialById = potentialState?.data ? new Map(potentialState.data.map(d => [d.location_id, d])) : null;

    return reliabilityRows.map((row, idx) => {
        const weight = mode === 'uptime'
            ? getPeopleBelowUptime(row, reliabilityThreshold)
            : getPeopleWithoutAccess(row);
        if (!weight || weight <= 0) return null;

        let metricVal;
        if (overlayMode === 'cf') {
            metricVal = cfById.get(row.location_id)?.annual_cf;
        } else if (overlayMode === 'lcoe') {
            metricVal = lcoeById.get(row.location_id)?.lcoe;
        } else if (overlayMode === 'potential') {
            const potentialRow = potentialById?.get(row.location_id);
            metricVal = getPotentialMetricFromRow(potentialRow, potentialState);
        } else {
            metricVal = weight;
        }

        if ((overlayMode === 'cf' || overlayMode === 'lcoe' || overlayMode === 'potential') && !Number.isFinite(metricVal)) {
            return null;
        }

        return {
            location_id: row.location_id ?? idx,
            latitude: row.latitude,
            longitude: row.longitude,
            metric: metricVal,
            weight
        };
    }).filter(Boolean);
}
// T099: the LCOE charts show realistic costs. A few far-north cells cost thousands of $/MWh
// (about $5,900 at 80°N by default), so an axis or bins fitted to the maximum squeeze everyone
// into the first bin. Both are set from the demand layer being plotted (people, demand, people
// without access, people below the uptime threshold, plant capacity), weighted by it, so sparse
// Arctic cells that hold almost nobody do not set the range; values beyond are shown, never dropped.
const LCOE_AXIS_CAPS = [300, 400, 500];   // latitude chart: $300/MWh (the human), at most $500
const LCOE_BIN_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000];
const LCOE_MAX_BINS = 25;
const fmtUsd = v => `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

// Weighted quantile q (0-1) of values; weights default to 1. NaN when nothing has weight.
function weightedQuantile(values, weights, q) {
    const idx = [];
    let total = 0;
    for (let i = 0; i < values.length; i++) {
        const w = weights ? weights[i] : 1;
        if (Number.isFinite(values[i]) && w > 0) { idx.push(i); total += w; }
    }
    if (!total) return NaN;
    idx.sort((a, b) => values[a] - values[b]);
    let acc = 0;
    for (const i of idx) {
        acc += weights ? weights[i] : 1;
        if (acc >= q * total) return values[i];
    }
    return values[idx[idx.length - 1]];
}

// Latitude chart: the LCOE axis ends at $300/MWh, or $400 or $500 when more than 5% of the
// demand layer lives in cells dearer than that; cells beyond are drawn at the edge.
function lcoeAxisCap(values, weights) {
    const p95 = weightedQuantile(values, weights, 0.95);
    if (!Number.isFinite(p95)) return LCOE_AXIS_CAPS[0];
    return LCOE_AXIS_CAPS.find(c => c >= p95) ?? LCOE_AXIS_CAPS[LCOE_AXIS_CAPS.length - 1];
}

// Histogram bins over the values drawn (weights: the plotted layer). LCOE: round steps ($10, or
// wider so there are at most LCOE_MAX_BINS) from the cheapest value to the bin holding the weighted
// 99th percentile of the values below the latitude-axis cap for the same weights ($300/400/500),
// never past that cap, plus one "Over $x" bin with the rest. A thin dear tail (high-latitude demand
// in a dear run) would otherwise stretch the bins into a wall of near-100% cumulative bars.
// Other metrics: bucketCount equal bins from the smallest to the largest value.
// Returns { buckets: [{min, max, label}], indexOf(v) }.
function histogramBins(values, overlayMode, bucketCount, options = {}, weights = null) {
    let lo = Infinity, hi = -Infinity;
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (overlayMode === 'lcoe') {
        const cap = lcoeAxisCap(values, weights);
        const below = values.map((v, i) => (v < cap ? (weights ? weights[i] : 1) : 0));
        let end = weightedQuantile(values, below, 0.99);
        if (!Number.isFinite(end)) end = cap;
        const fit = st => Math.max(1, Math.ceil((end - Math.floor(lo / st) * st) / st));
        const step = LCOE_BIN_STEPS.find(st => fit(st) <= LCOE_MAX_BINS) ?? LCOE_BIN_STEPS[LCOE_BIN_STEPS.length - 1];
        const start = Math.max(0, Math.floor(lo / step) * step);
        let n = fit(step);
        if (start + n * step <= end) n += 1;   // the bin holding the end value is a regular one
        while (n > 1 && start + n * step > cap) n -= 1;   // never past the cap
        const top = start + n * step;
        const buckets = Array.from({ length: n }, (_, i) => {
            const min = start + i * step, max = min + step;
            return { min, max, label: `${fmtUsd(min)}–${max.toLocaleString('en-US')}` };
        });
        const over = hi >= top;
        if (over) buckets.push({ min: top, max: Infinity, label: `Over ${fmtUsd(top)}` });
        const indexOf = v => (v >= top ? (over ? n : n - 1) : Math.max(0, Math.floor((v - start) / step)));
        return { buckets, indexOf };
    }
    if (hi === lo) hi = lo + 1;
    const size = (hi - lo) / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_, i) => {
        const min = lo + i * size, max = lo + (i + 1) * size, mid = (min + max) / 2;
        let label;
        if (overlayMode === 'cf') label = `${(mid * 100).toFixed(1)}%`;
        else if (overlayMode === 'potential') label = options.potentialDisplayMode === 'multiple' ? `${mid.toFixed(2)}×` : `${mid.toFixed(1)}`;
        else label = mid.toFixed(1);
        return { min, max, label };
    });
    const indexOf = v => Math.max(0, Math.min(bucketCount - 1, Math.floor((v - lo) / size)));
    return { buckets, indexOf };
}

function buildStackedHistogram(metrics, overlayMode, selectedFuels, bucketCount = 50, options = {}) {
    if (!metrics.length) return { labels: [], datasets: [] };

    // Valid metrics
    const validMetrics = metrics.filter(m => Number.isFinite(m.metric));
    if (!validMetrics.length) return { labels: [], datasets: [] };

    const bins = histogramBins(validMetrics.map(m => m.metric), overlayMode, bucketCount, options, validMetrics.map(m => m.weight || 0));
    const buckets = bins.buckets.map(b => ({ ...b, stacks: {} }));

    // Initialize stacks
    const fuelList = Array.from(selectedFuels || ALL_FUELS);
    buckets.forEach(b => {
        fuelList.forEach(f => b.stacks[f] = 0);
    });

    validMetrics.forEach(m => {
        const b = buckets[bins.indexOf(m.metric)];
        b.stacks[m.fuel] = (b.stacks[m.fuel] || 0) + (m.weight || 0);
    });

    const labels = buckets.map(b => b.label);

    // Datasets
    const datasets = fuelList.map(fuel => ({
        label: FUEL_LABELS[fuel] || capitalizeWord(fuel),
        data: buckets.map(b => b.stacks[fuel] || 0),
        backgroundColor: FUEL_COLORS[fuel] || DATA_COLOURS.plantFallback,
        stack: 'stack0'
    }));

    return { labels, datasets, buckets };
}

function buildWeightedLatitudeHistogram(metrics, bucketCount = 100) {
    const totalWeight = metrics.reduce((sum, m) => sum + (m.weight || 0), 0);
    if (!totalWeight) return { labels: [], data: [] };

    const bucketSize = 180 / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        min: -90 + i * bucketSize,
        max: -90 + (i + 1) * bucketSize,
        weight: 0
    }));

    metrics.forEach(m => {
        if (!Number.isFinite(m.latitude)) return;
        const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((m.latitude + 90) / bucketSize)));
        buckets[idx].weight += m.weight || 0;
    });

    const labels = buckets.map(b => `${((b.min + b.max) / 2).toFixed(1)}°`);
    const data = buckets.map(b => (b.weight / totalWeight) * 100);
    return {
        labels: labels.reverse(),
        data: data.reverse()
    };
}

function buildSupplyMetricRows(overlayMode, cfData, lcoeData, potentialState = null) {
    if (overlayMode === 'cf') {
        return cfData
            .map(row => ({
                location_id: row.location_id,
                latitude: row.latitude,
                longitude: row.longitude,
                metric: row.annual_cf,
                availabilityWeight: Number.isFinite(potentialAreaById.get(row.location_id))
                    ? potentialAreaById.get(row.location_id)
                    : 1
            }))
            .filter(r => Number.isFinite(r.metric));
    }
    if (overlayMode === 'lcoe') {
        return lcoeData
            .map(row => ({
                location_id: row.location_id,
                latitude: row.latitude,
                longitude: row.longitude,
                metric: row.lcoe,
                availabilityWeight: Number.isFinite(potentialAreaById.get(row.location_id))
                    ? potentialAreaById.get(row.location_id)
                    : 1
            }))
            .filter(r => Number.isFinite(r.metric));
    }
    if (overlayMode === 'potential') {
        const rows = potentialState?.data || [];
        const isMultiple = potentialState?.displayMode === 'multiple';
        return rows.map(row => {
            const comp = getPotentialRowComponents(row, potentialState);
            if (!comp) return null;
            // Keep zero-demand cells (metric NaN) so the latitude chart can still count their
            // supply toward Σ TWh per band; finite-metric filters downstream drop them from the
            // map and histogram, so those views are unchanged.
            const metricVal = isMultiple
                ? (comp.demandTwh > 0 ? comp.total / comp.demandTwh : NaN)
                : comp.total;
            const area = Number(row.zone_area_km2);
            const availabilityWeight = Number.isFinite(area) && area > 0 ? area : 1;
            return {
                location_id: row.location_id,
                latitude: row.latitude,
                longitude: row.longitude,
                metric: metricVal,
                // Raw components (TWh/yr) so the latitude chart can sum supply per band
                // and form a single supply÷demand ratio line in "× Demand" mode.
                supplyTwh: comp.total,
                demandTwh: comp.demandTwh,
                availabilityWeight
            };
        }).filter(Boolean);
    }
    return [];
}

function buildHistogramWithAvailability(demandMetrics, supplyMetrics, overlayMode, bucketCount = 50, options = {}) {
    const validDemand = (demandMetrics || []).filter(m => Number.isFinite(m.metric) && (m.weight || 0) > 0);
    const validSupply = (supplyMetrics || []).filter(m => Number.isFinite(m.metric));

    // T099: the bins span the demand values only, the series drawn. They used to span every
    // supply cell too, up to about $5,900/MWh in the far north, which put 99.5% of people
    // (100% of people without access) in the first of 50 bins.
    if (!validDemand.length) {
        return { labels: [], demandShare: [], supplyShare: [], buckets: [] };
    }
    const bins = histogramBins(validDemand.map(m => m.metric), overlayMode, bucketCount, options, validDemand.map(m => m.weight || 0));
    const buckets = bins.buckets.map(b => ({ ...b, demandWeight: 0, supplyWeight: 0 }));

    validDemand.forEach(m => {
        buckets[bins.indexOf(m.metric)].demandWeight += m.weight || 0;
    });
    validSupply.forEach(m => {
        const weight = Number.isFinite(m.availabilityWeight) ? m.availabilityWeight : 1;
        buckets[bins.indexOf(m.metric)].supplyWeight += weight;
    });

    const demandTotal = buckets.reduce((sum, b) => sum + b.demandWeight, 0);
    const supplyTotal = buckets.reduce((sum, b) => sum + b.supplyWeight, 0);

    const labels = buckets.map(b => b.label);

    const demandShare = buckets.map(b => (demandTotal > 0 ? (b.demandWeight / demandTotal) * 100 : 0));
    const supplyShare = buckets.map(b => (supplyTotal > 0 ? (b.supplyWeight / supplyTotal) * 100 : 0));

    return { labels, demandShare, supplyShare, buckets };
}

// Sum raw supply (TWh/yr) and demand (TWh/yr) into latitude bands. Used by the
// Demand & Supply by Latitude chart to plot absolute solar potential (Total mode)
// or a single Σsupply ÷ Σdemand ratio line (× Demand mode).
function buildLatitudeSupplyBands(supplyRows, bucketCount = 36) {
    const bucketSize = 180 / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        mid: -90 + (i + 0.5) * bucketSize,
        supplyTwh: 0,
        demandTwh: 0
    }));
    supplyRows.forEach(m => {
        if (!Number.isFinite(m.latitude)) return;
        const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((m.latitude + 90) / bucketSize)));
        if (Number.isFinite(m.supplyTwh)) buckets[idx].supplyTwh += m.supplyTwh;
        if (Number.isFinite(m.demandTwh)) buckets[idx].demandTwh += m.demandTwh;
    });
    return buckets;
}

function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
        return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
}

function computeLatBandStats(rows, bandSize = 5) {
    const bands = new Map();
    rows.forEach(r => {
        if (!Number.isFinite(r.latitude) || !Number.isFinite(r.metric)) return;
        const idx = Math.floor((r.latitude + 90) / bandSize);
        const bandKey = Math.max(0, Math.min(Math.floor(180 / bandSize) - 1, idx));
        if (!bands.has(bandKey)) bands.set(bandKey, []);
        bands.get(bandKey).push(r.metric);
    });

    const stats = [];
    bands.forEach((values, bandKey) => {
        const sorted = values.slice().sort((a, b) => a - b);
        const min = -90 + bandKey * bandSize;
        const max = min + bandSize;
        const lat = (min + max) / 2;
        stats.push({
            lat,
            p25: quantile(sorted, 0.25),
            p50: quantile(sorted, 0.5),
            p75: quantile(sorted, 0.75)
        });
    });

    return stats.sort((a, b) => a.lat - b.lat);
}

// ==================== ACCESS CHARTS ====================

/**
 * Chart labels for the supply build on show: wind is named only when some cell's
 * build has wind (rows: the CF or LCOE rows the charts read).
 */
function supplyTechLabels(rows) {
    const wind = Array.isArray(rows) && rows.some(r => r && r.wind_gw > 0);
    return wind ? { name: 'Solar and wind', build: 'solar, wind and battery' } : { name: 'Solar', build: 'solar and battery' };
}

function handleHistogramClick(bucket, metrics, overlayMode, baseLayer) {
    if (!bucket) return;
    const { min, max } = bucket;

    // Filter data
    const subset = metrics.filter(m => m.metric >= min && m.metric < max);
    console.warn(`[HistogramClick] Bucket: ${min.toFixed(2)}-${max.toFixed(2)}, Metrics: ${metrics.length}, Subset: ${subset.length}`);

    if (subset.length === 0) return;

    // Show modal
    // Show modal
    const modal = document.getElementById('subset-map-modal');
    const titleEl = document.getElementById('subset-map-title');
    const closeBtn = document.getElementById('close-subset-map');
    const legendRange = document.getElementById('subset-map-legend-range');

    if (modal) modal.classList.remove('hidden');

    // T099: the bin's range goes in the title (the modal has no #subset-map-legend-range element).
    let rangeText;
    if (overlayMode === 'cf') rangeText = `${(min * 100).toFixed(1)}–${(max * 100).toFixed(1)}%`;
    else if (overlayMode === 'lcoe') rangeText = Number.isFinite(max) ? `${fmtUsd(min)}–${max.toLocaleString('en-US')}/MWh` : `over ${fmtUsd(min)}/MWh`;
    else rangeText = Number.isFinite(max) ? `${min.toLocaleString()}–${max.toLocaleString()}` : `over ${min.toLocaleString()}`;
    if (titleEl) {
        let title;
        if (baseLayer === 'plants') {
            title = 'Capacity Subset';
        } else {
            title = overlayMode === 'cf' ? 'Capacity Factor Subset' : 'LCOE Subset';
        }
        titleEl.textContent = `${title}: ${rangeText}`;
    }

    if (legendRange) legendRange.textContent = rangeText;

    // Accessors for Plants
    let getRadius = null;
    let getTooltip = null;

    if (baseLayer === 'plants') {
        getRadius = (d) => {
            // Replicate main map logic:
            // const radius = Math.max(2, Math.min(12, Math.sqrt(baseCapacity) * 0.15));
            const cap = Number.isFinite(d.weight) ? Math.max(d.weight, 0) : 0;
            return Math.max(2, Math.min(12, Math.sqrt(cap) * 0.15));
        };
        getTooltip = (d) => {
            // Rich Tooltip
            return `${d.plant_name || 'Plant'} (${d.fuel || 'Unknown'})\nCapacity: ${(d.weight || 0).toLocaleString()} MW\nStatus: ${d.status || 'Unknown'}`;
        };
    }

    // Init map
    // Use requestAnimationFrame to ensure the modal is visible and layout is updated
    requestAnimationFrame(() => {
        initSubsetMap();

        // Render after slight delay for map invalidation
        setTimeout(() => {
            let dataToRender = metrics;
            let subsetIds = subset.map(d => d.location_id);
            let getValue = d => d.metric;
            let finalGetColor = getColor;

            let onPointHover = null;
            let onPointOut = null;

            if (baseLayer === 'plants') {
                // If plants layer, we want to show INDIVIDUAL plants
                const validLocationIds = new Set(subsetIds);
                // Same fuels and status as the main map (T075: it drew all of them).
                dataToRender = fossilPlants.filter(p => validLocationIds.has(p.location_id)
                    && populationFuelFilter.has(p.fuel_group) && p.status === plantStatusFilter);
                subsetIds = dataToRender.map(d => d.location_id);

                // --- COLORS ---
                // User wants fuel colors (from FUEL_COLORS)
                // getValue must return the entire object so getColor can access fuel_group
                getValue = d => d;
                finalGetColor = d => FUEL_COLORS[d.fuel_group || d.fuel] || DATA_COLOURS.plantFallback;

                // --- POPUP / TOOLTIPS ---
                const plantPopup = L.popup({
                    closeButton: false,
                    autoPan: false,
                    className: 'bg-transparent border-none shadow-none'
                });

                onPointHover = (e, d) => {
                    // Assuming e.target is circle, cx/cy are attributes. Or use e.layerPoint? 
                    // d3 e is MouseEvent. 
                    // But easier: d.latitude, d.longitude
                    const ll = [d.latitude, d.longitude];

                    const baseCapacity = Number.isFinite(d.capacity_mw) ? d.capacity_mw : (d.weight || 0);
                    const cap = Math.round(baseCapacity).toLocaleString();
                    const fuel = FUEL_LABELS[d.fuel_group || d.fuel] || 'Unknown';
                    const status = capitalizeWord(d.status || 'Unknown');
                    const name = d.plant_name || 'Power plant';
                    const country = d.country || 'Unknown';

                    const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs pointer-events-none">
                        <div class="font-semibold">${name}</div>
                        <div>${fuel} • ${cap} MW</div>
                        <div class="text-muted">${status}</div>
                        <div class="text-muted">${country}</div>
                     </div>`;

                    plantPopup.setLatLng(ll).setContent(content).openOn(subsetMap);
                };

                onPointOut = () => {
                    subsetMap.closePopup(plantPopup);
                };

                // --- LEGEND ---
                // Hide range legend, Show Fuel Legend
                if (legendRange) {
                    legendRange.innerHTML = ''; // Clear text
                    // Append fuel swatches
                    // Only the fuels drawn, each from the registry (T075).
                    ALL_FUELS.filter(key => populationFuelFilter.has(key)).forEach(key => {
                        const color = FUEL_COLORS[key];
                        const item = document.createElement('span');
                        item.className = 'inline-flex items-center mr-3';
                        item.dataset.fuelSwatch = key;
                        item.innerHTML = `<span style="background-color:${color};width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:4px;"></span> ${FUEL_LABELS[key]}`;
                        legendRange.appendChild(item);
                    });
                }

            } else {
                // Reset legend if mistakenly set to fuels?
                // The earlier code sets textContent if not plants.
                // So we are safe, provided we didn't clear it above inside the block.
            }

            // T099: start from the world view; a subset that lies partly off it (the "Over $x"
            // bin's far-north cells) or has only a few cells is fitted into view.
            if (subsetMap) {
                subsetMap.setView([20, 0], 2, { animate: false });
                const pts = (baseLayer === 'plants' ? dataToRender : subset)
                    .filter(d => Number.isFinite(d.latitude) && Number.isFinite(d.longitude))
                    .map(d => [d.latitude, d.longitude]);
                if (pts.length) {
                    const bounds = L.latLngBounds(pts);
                    if (pts.length <= 20 || !subsetMap.getBounds().contains(bounds)) {
                        subsetMap.fitBounds(bounds.pad(0.15), { maxZoom: 4, animate: false });
                    }
                }
            }

            renderSubsetMap(
                dataToRender,
                subsetIds,
                getValue,
                finalGetColor,
                baseLayer,
                getRadius,
                getTooltip,
                onPointHover,
                onPointOut
            );
        }, 50);
    });

    // Scales
    let getColor;
    if (overlayMode === 'cf') {
        getColor = rampScale('cf');
    } else if (overlayMode === 'lcoe') {
        const vals = metrics.map(m => m.metric).filter(Number.isFinite);
        const minV = Math.min(...vals);
        const maxV = Math.max(...vals);
        getColor = rampScale('lcoe', [minV, maxV]);
    } else if (baseLayer === 'electricity') {
        const vals = metrics.map(m => m.metric).filter(v => v > 0);
        const maxV = Math.max(...vals);
        getColor = rampScale('population', [Math.max(0.1, maxV / 1e6), maxV]);
    } else {
        // Population: log scale, dense = bright (matches the main population map)
        const pos = metrics.map(m => m.metric).filter(v => Number.isFinite(v) && v > 0);
        const hi = pos.length ? Math.max(...pos) : 1;
        getColor = rampScale('population', [Math.max(pos.length ? Math.min(...pos) : 1, hi / 1e6), Math.max(hi, 10)]);
    }

    if (closeBtn) {
        closeBtn.onclick = () => {
            modal.classList.add('hidden');
        };
    }
}

async function renderPopulationCharts(metrics, { overlayMode, baseLayer, selectedFuels, potentialState = null, supplyRows = [], supplyBuild = 'solar and battery' }) {
    if (!populationChartHistogram || !populationChartLatCombined) return;

    // Chart.js loads on first use. Offline or blocked, the charts stay empty.
    let ChartJS;
    try {
        ChartJS = await loadChartJs();
    } catch (err) {
        console.warn('Population charts unavailable:', err.message);
        return;
    }

    const isCf = overlayMode === 'cf';
    const isLcoe = overlayMode === 'lcoe';
    const isPotential = overlayMode === 'potential';
    const potentialIsMultiple = potentialState?.displayMode === 'multiple';
    const isStacked = baseLayer === 'plants';
    const fuelSet = isStacked
        ? (selectedFuels instanceof Set ? selectedFuels : (selectedFuels ? new Set(selectedFuels) : new Set(ALL_FUELS)))
        : null;
    // Determine weight descriptor based on baseLayer
    let weightDescriptor;
    if (baseLayer === 'plants') {
        weightDescriptor = 'Displaceable Plant capacity';
    } else if (baseLayer === 'electricity') {
        weightDescriptor = 'electricity demand';
    } else if (baseLayer === 'access') {
        weightDescriptor = 'people without access';
    } else if (baseLayer === 'uptime') {
        weightDescriptor = `people below ${reliabilityThreshold}% uptime`;
    } else {
        weightDescriptor = 'population';
    }

    // Prepare Histogram Data
    let histogramData;
    let histogramMainTitle, histogramHelperText;
    let xAxisLabel, yAxisLabel, scatterXAxisLabel;

    if (isCf) {
        xAxisLabel = 'Capacity Factor (%)';
        yAxisLabel = 'Share (%)';
        scatterXAxisLabel = 'Capacity Factor (%)';
        histogramMainTitle = 'Demand Distribution by Capacity Factor';
        histogramHelperText = `Shows share of ${weightDescriptor} across capacity factor bins`;
    } else if (isLcoe) {
        xAxisLabel = `LCOE, ${supplyBuild} ($/MWh)`;
        yAxisLabel = 'Share (%)';
        scatterXAxisLabel = xAxisLabel;
        histogramMainTitle = 'Demand Distribution by LCOE';
        histogramHelperText = `Shows share of ${weightDescriptor} across LCOE bins`;
    } else if (isPotential) {
        xAxisLabel = potentialIsMultiple ? 'Solar Potential / Demand (×)' : 'Solar Potential (TWh/yr)';
        yAxisLabel = 'Share (%)';
        scatterXAxisLabel = xAxisLabel;
        histogramMainTitle = 'Demand Distribution by Solar Potential';
        histogramHelperText = `Shows share of ${weightDescriptor} across solar potential bins`;
    } else {
        xAxisLabel = 'Supply Metric';
        yAxisLabel = 'Share (%)';
        scatterXAxisLabel = 'Supply Metric';
        histogramMainTitle = 'Demand Distribution';
        histogramHelperText = `Shows share of ${weightDescriptor} across supply metric bins`;
    }
    if (isStacked) {
        histogramHelperText = `${histogramHelperText} (stacked by fuel)`;
    }

    // Update main page heading based on baseLayer
    const chartsMainHeading = document.getElementById('charts-main-heading');
    if (chartsMainHeading) {
        if (baseLayer === 'electricity') {
            chartsMainHeading.textContent = 'Electricity Demand Analysis';
        } else if (baseLayer === 'access') {
            chartsMainHeading.textContent = 'Electricity Access Analysis';
        } else if (baseLayer === 'uptime') {
            chartsMainHeading.textContent = 'Grid Reliability Analysis';
        } else if (baseLayer === 'plants') {
            chartsMainHeading.textContent = 'Capacity to Displace Analysis';
        } else {
            chartsMainHeading.textContent = 'Population Analysis';
        }
    }

    // Update chart title elements
    const chartTitlePercentile = document.getElementById('chart-title-percentile');
    if (chartTitlePercentile) {
        const metricLabel = isCf
            ? 'Capacity Factor'
            : isLcoe
                ? 'LCOE'
                : isPotential
                    ? (potentialIsMultiple ? 'Solar Potential / Demand' : 'Solar Potential')
                    : 'Supply Metric';
        chartTitlePercentile.textContent = `Demand Distribution by ${metricLabel}`;
    }

    if (chartTitleDemandLatitude) {
        if (baseLayer === 'electricity') {
            chartTitleDemandLatitude.textContent = 'Electricity Demand by Latitude';
        } else if (baseLayer === 'access') {
            chartTitleDemandLatitude.textContent = 'People Without Access by Latitude';
        } else if (baseLayer === 'uptime') {
            chartTitleDemandLatitude.textContent = `People Below ${reliabilityThreshold}% Uptime by Latitude`;
        } else if (baseLayer === 'plants') {
            chartTitleDemandLatitude.textContent = 'Displaceable Capacity by Latitude';
        } else {
            chartTitleDemandLatitude.textContent = 'Population by Latitude';
        }
    }
    if (chartTitleSupplyLatitude) {
        chartTitleSupplyLatitude.textContent = isCf
            ? 'Capacity Factor by Latitude'
            : isLcoe
                ? 'LCOE by Latitude'
                : isPotential
                    ? (potentialIsMultiple ? 'Solar Potential / Demand by Latitude' : 'Solar Potential by Latitude')
                    : 'Supply Metric by Latitude';
    }

    let histogramTooltip;

    let hist;
    if (isStacked) {
        hist = buildStackedHistogram(metrics, overlayMode, fuelSet, 50, { potentialDisplayMode: potentialState?.displayMode });
        // T099: a thin gap in the card's own background between stacked fuels (Ember chart style),
        // so dark neighbours such as coal and gas, or nuclear on the dark card, stay apart.
        const cardBg = getComputedStyle(populationChartHistogram.closest('.bg-surface') || document.body).backgroundColor;
        hist.datasets.forEach(ds => {
            ds.borderColor = cardBg;
            ds.borderWidth = { top: 1, right: 0, bottom: 0, left: 0 };
            ds.borderSkipped = false;
        });
        const totalWeight = hist.datasets.reduce((sum, ds) => {
            return sum + ds.data.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
        }, 0);

        if (totalWeight > 0) {
            hist.datasets.forEach(ds => {
                ds.data = ds.data.map(v => (Number.isFinite(v) ? (v / totalWeight) * 100 : 0));
            });
        }

        if (typeof populationChartCumulative !== 'undefined' && populationChartCumulative) {
            hist.datasets.forEach(ds => {
                let sum = 0;
                ds.data = ds.data.map(v => {
                    sum += v;
                    return sum;
                });
            });
        }

        histogramData = {
            labels: hist.labels,
            datasets: hist.datasets
        };
        histogramTooltip = (ctx) => {
            const val = ctx.parsed.y;
            const label = ctx.dataset.label || 'Value';
            return `${label}: ${val.toFixed(1)}%`;
        };
    } else {
        hist = buildHistogramWithAvailability(metrics, supplyRows, overlayMode, 50, { potentialDisplayMode: potentialState?.displayMode });
        let demandSeries = hist.demandShare.slice();
        if (typeof populationChartCumulative !== 'undefined' && populationChartCumulative) {
            let sum = 0;
            demandSeries = demandSeries.map(v => {
                sum += v;
                return sum;
            });
        }

        // Each bar is the bin's share of the layer's total (people, demand, people without access,
        // people below the uptime threshold), so the shares add up to 100% and cumulate (T099).
        let demandLabel;
        if (baseLayer === 'electricity') {
            demandLabel = 'Share of electricity demand';
        } else if (baseLayer === 'access') {
            demandLabel = 'Share of people without access';
        } else if (baseLayer === 'uptime') {
            demandLabel = `Share of people below ${reliabilityThreshold}% uptime`;
        } else {
            demandLabel = 'Share of population';
        }
        if (populationChartCumulative) demandLabel = `${demandLabel}, cumulative`;

        histogramData = {
            labels: hist.labels,
            datasets: [
                {
                    type: 'bar',
                    label: demandLabel,
                    data: demandSeries,
                    backgroundColor: DATA_COLOURS.demand,
                    borderColor: DATA_COLOURS.demand,
                    borderWidth: 1
                }
            ]
        };
        histogramTooltip = (ctx) => {
            const val = ctx.parsed.y;
            const label = ctx.dataset.label || 'Value';
            return `${label}: ${val.toFixed(1)}%`;
        };
    }

    // Update Titles
    if (populationChartHistogramTitle) populationChartHistogramTitle.textContent = histogramMainTitle;
    if (populationChartHistogramLabel) populationChartHistogramLabel.textContent = histogramHelperText;

    // Destroy/Create Main Histogram
    // We recreate if type changes or if stacked/unstacked changes structure significantly?
    // ChartJS can update data structure.
    // However, if we switch from 1 dataset to N datasets, update() handles it.

    if (!populationCharts.histogram) {
        populationCharts.histogram = new ChartJS(populationChartHistogram.getContext('2d'), {
            type: 'bar',
            data: histogramData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true },
                    tooltip: { callbacks: { label: histogramTooltip } }
                },
                onClick: (e, elements) => {
                    if (elements && elements.length > 0 && hist.buckets) {
                        const index = elements[0].index;
                        const bucket = hist.buckets[index];
                        handleHistogramClick(bucket, metrics, overlayMode, baseLayer);
                    }
                },
                onHover: (event, chartElement) => {
                    event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
                },
                scales: {
                    x: {
                        title: { display: true, text: xAxisLabel },
                        stacked: isStacked
                    },
                    y: {
                        title: { display: true, text: yAxisLabel },
                        min: 0,
                        // Cumulative shares end at 100% (a float sum just over it made Chart.js pick 120%).
                        max: populationChartCumulative ? 100 : undefined,
                        stacked: isStacked,
                        ticks: {
                            callback: (value) => `${value}%`
                        }
                    }
                }
            }
        });
    } else {
        populationCharts.histogram.data = histogramData;
        populationCharts.histogram.options.plugins.legend.display = true;
        populationCharts.histogram.options.plugins.tooltip.callbacks.label = histogramTooltip;
        populationCharts.histogram.options.onClick = (e, elements) => {
            if (elements && elements.length > 0 && hist.buckets) {
                const index = elements[0].index;
                const bucket = hist.buckets[index];
                handleHistogramClick(bucket, metrics, overlayMode, baseLayer);
            }
        };
        populationCharts.histogram.options.scales.x.title.text = xAxisLabel;
        populationCharts.histogram.options.scales.x.stacked = isStacked;
        populationCharts.histogram.options.scales.y.title.text = yAxisLabel;
        populationCharts.histogram.options.scales.y.ticks.callback = (value) => `${value}%`;
        populationCharts.histogram.options.scales.y.stacked = isStacked;
        populationCharts.histogram.options.scales.y.max = populationChartCumulative ? 100 : undefined;
        populationCharts.histogram.update();
    }

    // Combined Demand + Supply by Latitude (dual x-axis, world map background)
    const normalizeMetric = (val) => {
        if (!Number.isFinite(val)) return val;
        if (isCf) return val * 100;
        return val;
    };
    const supplyScatterRows = supplyRows
        .map(m => ({
            latitude: m.latitude,
            metric: normalizeMetric(m.metric)
        }))
        .filter(m => Number.isFinite(m.latitude) && Number.isFinite(m.metric));
    const metricScatterData = supplyScatterRows.map(m => ({ x: m.metric, y: m.latitude }));

    // Demand profile: latitude band → share (%). 5° bins keep the curve smooth without
    // ocean-band zigzag (1.8° bins flap between 0% and population peaks).
    const DEMAND_BIN_COUNT = 36;
    const popHistogram = buildWeightedLatitudeHistogram(metrics, DEMAND_BIN_COUNT);
    const latPopLabel = baseLayer === 'electricity'
        ? 'Electricity demand share (%)'
        : baseLayer === 'plants'
            ? 'Capacity share (%)'
            : baseLayer === 'access'
                ? 'No-access share (%)'
                : baseLayer === 'uptime'
                    ? `Below ${reliabilityThreshold}% uptime share (%)`
                    : 'Population share (%)';
    const histogramToLineData = (hist) => hist.labels
        .map((label, i) => ({ x: hist.data[i], y: parseFloat(label) }))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
        .sort((a, b) => a.y - b.y);
    // Anchor at ±90° so stepped histogram lines reach the chart's latitude bounds
    // (last bin midpoint is ±87.5°, otherwise leaving a visible gap to the pole).
    const anchorLineToPoles = (data) => {
        if (!data.length) return data;
        const first = data[0];
        const last = data[data.length - 1];
        const out = data.slice();
        if (first.y > -90) out.unshift({ x: first.x, y: -90 });
        if (last.y < 90) out.push({ x: last.x, y: 90 });
        return out;
    };
    const demandLineData = anchorLineToPoles(histogramToLineData(popHistogram));
    const demandPeak = demandLineData.reduce((m, p) => Math.max(m, p.x || 0), 0);
    // Add 30% headroom past the histogram peak so the step doesn't sit on the right axis.
    const demandSuggestedMax = demandPeak > 0 ? demandPeak * 1.3 : 1;

    // Supply line. Potential modes aggregate per latitude band into a single line:
    //   • Total    → Σ solar potential (TWh/yr) across all cells in the band.
    //   • × Demand → Σ supply (TWh/yr) ÷ Σ electricity demand (TWh/yr) in the band.
    // CF/LCOE keep a median-per-band line alongside the per-cell scatter.
    let supplyLineData;
    let supplyLineLabel;
    let supplyAxisLabel;
    let supplyTickCallback;
    if (isPotential) {
        const bands = buildLatitudeSupplyBands(supplyRows, DEMAND_BIN_COUNT);
        if (potentialIsMultiple) {
            supplyLineData = bands
                .filter(b => b.demandTwh > 0)
                .map(b => ({ x: b.supplyTwh / b.demandTwh, y: b.mid }))
                .sort((a, b) => a.y - b.y);
            supplyLineLabel = 'Supply ÷ demand (×)';
            supplyAxisLabel = 'Solar potential ÷ demand (×)';
            supplyTickCallback = (v) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}×`;
        } else {
            supplyLineData = bands
                .map(b => ({ x: b.supplyTwh, y: b.mid }))
                .sort((a, b) => a.y - b.y);
            supplyLineLabel = 'Solar potential (TWh/yr)';
            supplyAxisLabel = 'Solar potential (TWh/yr)';
            supplyTickCallback = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
        }
    } else {
        const stats = computeLatBandStats(supplyScatterRows);
        supplyLineData = stats
            .filter(s => Number.isFinite(s.p50) && Number.isFinite(s.lat))
            .map(s => ({ x: s.p50, y: s.lat }))
            .sort((a, b) => a.y - b.y);
        supplyLineLabel = `Median ${scatterXAxisLabel}`;
        supplyAxisLabel = scatterXAxisLabel;
        supplyTickCallback = undefined;
    }

    // T099: the LCOE axis ends at the cap ($300/MWh, at most $500 when the demand layer itself is
    // dearer; lcoeAxisCap, weighted by the layer's weight in each cell); the cells above it are
    // drawn at the right edge as right-pointing triangles, their tooltips give the real cost, and
    // the axis title counts them, so nothing is hidden.
    let scatterShown = metricScatterData;
    let pinnedScatter = [];
    let lcoeCap = null;
    let supplyAxisTitle = supplyAxisLabel;
    if (isLcoe) {
        const cellWeight = new Map();
        metrics.forEach(m => cellWeight.set(m.location_id, (cellWeight.get(m.location_id) || 0) + (m.weight || 0)));
        lcoeCap = lcoeAxisCap(supplyRows.map(r => r.metric), supplyRows.map(r => cellWeight.get(r.location_id) || 0));
        scatterShown = metricScatterData.filter(p => p.x <= lcoeCap);
        pinnedScatter = metricScatterData.filter(p => p.x > lcoeCap).map(p => ({ x: lcoeCap, y: p.y, value: p.x }));
        supplyLineData = supplyLineData.map(p => (p.x > lcoeCap ? { x: lcoeCap, y: p.y, value: p.x } : p));
        const capText = `${fmtUsd(lcoeCap)}/MWh`;
        supplyTickCallback = (v) => (v >= lcoeCap ? `${fmtUsd(v)}+` : fmtUsd(v));
        if (pinnedScatter.length) {
            const n = pinnedScatter.length;
            supplyAxisTitle = [supplyAxisLabel, `Axis cut at ${capText}: ${n.toLocaleString('en-US')} higher ${n === 1 ? 'cell' : 'cells'} shown as triangles at the edge`];
        }
    }

    // Auto-fit the bottom (supply) axis to always show all data. With parsing:false +
    // normalized:true, Chart.js can't auto-detect the x-max for the line-only dataset and
    // falls back to max:1, clipping high supply values. Compute the peak across every series
    // on xSupply (line + scatter) and force a suggestedMax with headroom, mirroring
    // demandSuggestedMax on the top axis. LCOE: a fixed max at the cap.
    const supplyXValues = supplyLineData
        .map(p => p.x)
        .filter(Number.isFinite);
    if (!isPotential) {
        scatterShown.forEach(p => {
            if (Number.isFinite(p.x)) supplyXValues.push(p.x);
        });
    }
    const supplyPeak = supplyXValues.length ? Math.max(...supplyXValues) : 0;
    const supplySuggestedMax = supplyPeak > 0 ? supplyPeak * 1.05 : undefined;
    const supplyMax = isLcoe ? lcoeCap : undefined;   // a fixed max overrides suggestedMax

    const datasets = [
        {
            type: 'line',
            label: latPopLabel,
            data: demandLineData,
            xAxisID: 'xDemand',
            yAxisID: 'y',
            borderColor: DATA_COLOURS.demand,
            backgroundColor: DATA_COLOURS.demand,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 3,
            stepped: 'middle',
            fill: 'origin',
            spanGaps: false,
            order: 2
        },
        {
            type: 'line',
            label: supplyLineLabel,
            data: supplyLineData,
            xAxisID: 'xSupply',
            yAxisID: 'y',
            borderColor: DATA_COLOURS.supply,
            backgroundColor: DATA_COLOURS.transparent,
            borderWidth: 2.5,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.4,
            fill: false,
            spanGaps: true,
            order: 1
        }
    ];

    if (!isPotential && scatterShown.length) {
        datasets.push({
            type: 'scatter',
            label: scatterXAxisLabel,
            data: scatterShown,
            xAxisID: 'xSupply',
            yAxisID: 'y',
            backgroundColor: DATA_COLOURS.third,
            borderColor: DATA_COLOURS.transparent,
            pointRadius: 1.5,
            pointHoverRadius: 3,
            order: 3
        });
    }
    if (pinnedScatter.length) {
        datasets.push({
            type: 'scatter',
            label: `${scatterXAxisLabel}, beyond the axis`,
            data: pinnedScatter,
            xAxisID: 'xSupply',
            yAxisID: 'y',
            backgroundColor: DATA_COLOURS.third,
            borderColor: DATA_COLOURS.transparent,
            pointStyle: 'triangle',
            rotation: 90,
            pointRadius: 4,
            pointHoverRadius: 5,
            clip: 8,
            order: 3
        });
    }

    const formatX = (val, axisId) => {
        if (!Number.isFinite(val)) return '';
        if (axisId === 'xDemand') return `${val.toFixed(2)}%`;
        if (isCf) return `${val.toFixed(1)}%`;
        if (isLcoe) return fmtUsd(val);
        if (isPotential) {
            if (potentialIsMultiple) return `${val.toFixed(2)}×`;
            return `${val.toLocaleString('en-US', { maximumFractionDigits: 0 })} TWh`;
        }
        return val.toFixed(2);
    };

    const tooltipCallbacks = {
        title: (items) => {
            if (!items || !items.length) return '';
            const lat = items[0].parsed.y;
            return Number.isFinite(lat) ? `Latitude ${lat.toFixed(1)}°` : '';
        },
        label: (ctx) => {
            const ds = ctx.dataset;
            // Points pinned at the LCOE cap carry their real value (T099).
            const xVal = Number.isFinite(ctx.raw?.value) ? ctx.raw.value : ctx.parsed.x;
            const axisId = ds.xAxisID || 'xSupply';
            return `${ds.label}: ${formatX(xVal, axisId)}`;
        }
    };

    const baseOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        normalized: true,
        plugins: {
            legend: { display: false },
            tooltip: {
                mode: 'nearest',
                intersect: false,
                // T099: nearest in both directions, so the edge triangles (cells beyond the LCOE
                // axis) can be hovered; by latitude alone a cell further left always won.
                axis: 'xy',
                callbacks: tooltipCallbacks
            }
        },
        scales: {
            xDemand: {
                position: 'top',
                title: { display: true, text: latPopLabel, color: DATA_COLOURS.chartText },
                grid: { color: DATA_COLOURS.chartGrid, drawOnChartArea: true },
                ticks: { color: DATA_COLOURS.chartTick, callback: (v) => `${Number(v).toFixed(1)}%` },
                min: 0,
                suggestedMax: demandSuggestedMax
            },
            xSupply: {
                position: 'bottom',
                title: { display: true, text: supplyAxisTitle, color: DATA_COLOURS.chartText },
                grid: { color: DATA_COLOURS.chartGrid, drawOnChartArea: false },
                ticks: { color: DATA_COLOURS.chartTick, callback: supplyTickCallback },
                min: 0,
                max: supplyMax,
                suggestedMax: supplySuggestedMax
            },
            y: {
                min: -90,
                max: 90,
                title: { display: true, text: 'Latitude' },
                ticks: {
                    stepSize: 30,
                    callback: (v) => `${v}°`,
                    color: DATA_COLOURS.chartTick
                },
                grid: { color: DATA_COLOURS.chartGrid }
            }
        }
    };

    if (!populationCharts.latCombined) {
        populationCharts.latCombined = new ChartJS(populationChartLatCombined.getContext('2d'), {
            type: 'scatter',
            data: { datasets },
            options: baseOptions,
            plugins: [_worldMapBackgroundPlugin]
        });
    } else {
        populationCharts.latCombined.data.datasets = datasets;
        const opts = populationCharts.latCombined.options;
        opts.scales.xDemand.title.text = latPopLabel;
        opts.scales.xDemand.suggestedMax = demandSuggestedMax;
        opts.scales.xSupply.title.text = supplyAxisTitle;
        opts.scales.xSupply.ticks.callback = supplyTickCallback;
        opts.scales.xSupply.max = supplyMax;
        opts.scales.xSupply.suggestedMax = supplySuggestedMax;
        opts.plugins.tooltip.callbacks = tooltipCallbacks;
        populationCharts.latCombined.update();
    }
}

// Legend of a wind layer of the LCOE view. Fixed scales, so a target-CF move only
// recolours cells whose value changed. Before the full-grid search has run, the
// slice search returns no wind fields; those cells show the Loading colour.
const WIND_SAVING_LEGEND_MAX = 50; // $/MWh (about the 90th percentile at the default 90% target)
function windLayerLegendInfo(layer, points) {
    // T074: under a technology filter nothing may meet the target; that is not Loading.
    const pending = points.some(p => p.meetsTarget) && !points.some(p => p.meetsTarget && p.noWindMeetsTarget !== undefined);
    const rows = [];
    if (pending) rows.push({ color: WIND_LAYER_PENDING_COLOR, text: 'Loading' });
    if (layer === 'wind_saving') rows.push({ color: WIND_NEEDED_COLOR, text: 'Met only with wind' });
    rows.push({ color: LCOE_NO_DATA_COLOR, text: 'Target not met' });
    const base = { type: layer, gradientCss: rampScale('green', layer === 'wind_share' ? [0, 1] : [0, WIND_SAVING_LEGEND_MAX]).css(),
        rows, showComparison: false };
    if (layer === 'wind_share') {
        return { ...base, domain: [0, 1], title: 'Wind share of the cheapest build',
            minLabel: '0%', midLabel: '50%', maxLabel: '100%',
            refLabel: 'Share of solar + wind MW' };
    }
    // T074: against the same filter with wind removed.
    const against = techOffMask(lcoeParams) ? noWindComparator() : 'solar + battery';
    return { ...base, domain: [0, WIND_SAVING_LEGEND_MAX], title: 'Saving from wind ($/MWh)',
        minLabel: '$0', midLabel: formatCurrencyLabel(WIND_SAVING_LEGEND_MAX / 2),
        maxLabel: `≥ ${formatCurrencyLabel(WIND_SAVING_LEGEND_MAX)}`,
        refLabel: against ? `Against ${against} only` : 'No build without wind' };
}

function prepareLcoeDisplayData(layer = 'lcoe') {
    if (!sliceLength()) return;
    const perf = startPerf('lcoe-prepare', { mode: lcoeDisplayMode, targetCf: lcoeParams.targetCf });
    const results = computeBestLcoeByLocation(lcoeParams.targetCf, lcoeParams);
    if (!results) {
        // The worker is searching; what is on screen stays until it answers.
        endPerf(perf, { pending: true });
        return null;
    }
    lcoeResults = results;
    publishDebugSnapshot(getSummaryStatsForConfig(currentSolar, currentBatt));

    // Sync reference to freshest data
    let ref = null;
    if (lcoeReference) {
        ref = lcoeResults.find(r => r.location_id === lcoeReference.location_id) || null;
        // T074: a region with no build under the filter keeps the reference but
        // compares nothing until a filter gives it one.
        if (ref && ref.noEligibleBuild) ref = null;
        else lcoeReference = ref;
    }

    const wantsComparison = Boolean(ref);
    const desiredType = wantsComparison ? (lcoeDisplayMode === 'transmission' ? 'tx' : 'delta') : 'lcoe';
    if (!wantsComparison) {
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();
    } else if (legendLock && lockedColorInfo && lockedColorInfo.type !== desiredType) {
        // Display mode changed (delta <-> transmission), force recalculation
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();
    }

    const resultsWithDelta = lcoeResults.map(r => {
        const delta = ref ? r.lcoe - ref.lcoe : null;
        const txMetrics = ref ? computeTransmissionMetrics(r, ref, delta) : null;
        return { ...r, delta, txMetrics };
    });

    lcoeAddonDrawn = resultsWithDelta.some(r => r.meetsTarget && (r.interpolated || r.solar_gw > 20 || r.batt_gwh > 36));
    let colorInfo;
    if (layer === 'wind_share' || layer === 'wind_saving') {
        // Wind layers have fixed scales and leave the LCOE legend locks alone.
        colorInfo = windLayerLegendInfo(layer, resultsWithDelta);
        renderLegendFromInfo(colorInfo);
    } else if (lcoeTimeLockActive && lcoeTimeLockedColorInfo) {
        const lockedBase = {
            ...lcoeTimeLockedColorInfo,
            domain: lcoeTimeLockedColorInfo.domain ? [...lcoeTimeLockedColorInfo.domain] : null
        };
        colorInfo = updateLcoeLegend(resultsWithDelta, lockedBase);
    } else if (legendLock && lockedColorInfo) {
        colorInfo = updateLcoeLegend(resultsWithDelta, lockedColorInfo);
    } else {
        colorInfo = updateLcoeLegend(resultsWithDelta);
        if (legendLock) {
            lockedColorInfo = colorInfo;
        }
        if (lcoeTimeLockActive) {
            lcoeTimeLockedColorInfo = colorInfo;
        }
    }
    endPerf(perf, { resultRows: resultsWithDelta.length });

    return { resultsWithDelta, ref, colorInfo };
}

function updateLcoeView() {
    if (currentViewMode !== 'lcoe') return;
    if (lcoeLayerWrap) lcoeLayerWrap.classList.toggle('hidden', lcoeTargetMode !== 'utilization');
    if (lcoeTargetMode === 'utilization') {
        // Existing mode: Show LCOE to achieve target CF
        const prepared = prepareLcoeDisplayData(lcoeMapLayer);
        if (prepared === null) showLcoePendingIfNeeded('lcoe');
        if (!prepared) return;
        const { resultsWithDelta, ref, colorInfo } = prepared;

        updateLcoeMap(resultsWithDelta, {
            targetCf: lcoeParams.targetCf,
            colorInfo,
            reference: ref
        });
        noteLcoeRendered('lcoe');
    } else {
        // New mode: Show CF heatmap at target LCOE
        if (!sliceLength()) return;
        const perf = startPerf('lcoe-cf-at-target', { targetLcoe: targetLcoeValue });

        // Calculate which config achieves closest to target LCOE for each location
        const cfResults = computeCfAtTargetLcoe(targetLcoeValue, lcoeParams);
        if (!cfResults) {
            // The worker is searching; what is on screen stays until it answers.
            endPerf(perf, { pending: true });
            showLcoePendingIfNeeded('lcoe_cf');
            return;
        }

        // Prepare with delta (no transmission logic in this mode)
        const found = lcoeReference ? cfResults.find(r => r.location_id === lcoeReference.location_id) || null : null;
        const ref = found && !found.noEligibleBuild ? found : null;   // T074
        const resultsWithDelta = cfResults.map(r => {
            const delta = ref ? r.cf - ref.cf : null;
            return { ...r, delta };
        });

        // Update legend for CF display
        const colorInfo = updateCfLegend(resultsWithDelta);

        updateCfMap(resultsWithDelta, {
            targetLcoe: targetLcoeValue,
            colorInfo,
            reference: ref
        });
        noteLcoeRendered('lcoe_cf');
        endPerf(perf, { resultRows: resultsWithDelta.length });
    }
}

async function updatePopulationView() {
    if (currentViewMode !== 'population') return;
    let overlayMode = populationOverlayMode || 'cf';
    if (overlayMode === 'none') {
        overlayMode = 'cf';
        populationOverlayMode = 'cf';
        updatePopulationOverlayToggleUI();
        updatePopulationOverlayControls('cf');
    }

    // Prepare data for overlay
    let cfData = [];
    let lcoeData = [];
    let lcoeColorInfo = null;
    let potentialState = null;

    if (overlayMode === 'cf') {
        cfData = getSummaryForConfig(currentSolar, currentBatt);
    } else if (overlayMode === 'lcoe') {
        await ensureDieselDataLoaded();
        await ensureGasDataLoaded();
        syncLcoeControlValues();
        const prepared = prepareLcoeDisplayData();
        if (prepared === null) {
            // The worker is searching; keep what is on screen.
            if (currentViewMode === 'population') showLcoePendingIfNeeded('pop_lcoe');
            return;
        }
        if (prepared) {
            lcoeData = prepared.resultsWithDelta;
            lcoeColorInfo = prepared.colorInfo;
        }
    } else if (overlayMode === 'potential') {
        potentialState = await getPotentialOverlayState();
        if (!potentialState) return;
        syncPotentialToggleUI();
    }

    // Display mode: map or charts
    if (populationDisplayMode === 'charts') {
        // Show charts
        showPopulationChartsOnly();

        if (standardChartsContainer) standardChartsContainer.classList.remove('hidden');

        // Build metrics for charts
        let metrics = [];
        if (populationBaseLayer === 'population') {
            metrics = buildPopulationMetrics(populationData, overlayMode, cfData, lcoeData, potentialState);
        } else if (populationBaseLayer === 'plants') {
            metrics = buildPlantMetrics(fossilCapacity, overlayMode, cfData, lcoeData, populationFuelFilter, plantStatusFilter, potentialState);
        } else if (populationBaseLayer === 'electricity') {
            metrics = buildElectricityMetrics(electricityDemandData, overlayMode, cfData, lcoeData, potentialState);
        } else if (populationBaseLayer === 'access') {
            metrics = buildReliabilityMetrics(reliabilityData, overlayMode, cfData, lcoeData, potentialState, 'access');
        } else if (populationBaseLayer === 'uptime') {
            metrics = buildReliabilityMetrics(reliabilityData, overlayMode, cfData, lcoeData, potentialState, 'uptime');
        }

        const supplyRows = buildSupplyMetricRows(overlayMode, cfData, lcoeData, potentialState);

        renderPopulationCharts(metrics, {
            overlayMode,
            baseLayer: populationBaseLayer,
            selectedFuels: populationFuelFilter,
            potentialState,
            supplyRows,
            supplyBuild: supplyTechLabels(overlayMode === 'lcoe' ? lcoeData : cfData).build
        });
    } else {
        // Show map
        showMapContainerOnly();

        updatePopulationSimple(populationData, {
            baseLayer: populationBaseLayer,
            overlayMode: 'none',
            cfData: cfData,
            lcoeData: lcoeData,
            lcoeColorInfo: lcoeColorInfo,
            targetCf: lcoeParams.targetCf,
            fossilPlants: fossilPlants,
            fossilCapacityMap: fossilCapacityMap,
            electricityDemandData: electricityDemandData,
            electricityDemandMap: electricityDemandMap,
            reliabilityData: reliabilityData,
            reliabilityMap: reliabilityMap,
            selectedFuels: Array.from(populationFuelFilter),
            selectedStatus: plantStatusFilter
        });

        updatePopulationLegend(populationData, 'none', populationBaseLayer);
        updateSupplyMap({
            overlayMode: populationOverlayMode,
            cfData,
            lcoeData,
            lcoeColorInfo,
            potentialState
        });
        updateSupplyLegend(populationOverlayMode, lcoeColorInfo, potentialState);
    }
    if (overlayMode === 'lcoe') noteLcoeRendered('pop_lcoe');
    else {
        if (lcoeShownKind === 'pop_lcoe') lcoeShownKind = null;
        setLcoePending(null);
    }
}

// The non-cost views set onshore and offshore wind on separate sliders, in the
// main panel and the supply panel. Each is an index into its surface's simulated
// capacity levels (0, 1, 2, 3, 4, 5, 6, 8 GW), not a linear scale, so the user
// can only pick a level that exists.
const WIND_SLIDERS = [
    { id: 'wind-slider', valId: 'wind-val', surface: 'on' },
    { id: 'pop-wind-slider', valId: 'pop-wind-val', surface: 'on' },
    { id: 'offwind-slider', valId: 'offwind-val', surface: 'off' },
    { id: 'pop-offwind-slider', valId: 'pop-offwind-val', surface: 'off' },
];
let windSliderLevels = { on: [0], off: [0] };

function windLevels(surface) {
    return windSliderLevels[surface] || [0];
}

// Mixed onshore + offshore builds aren't simulated yet (BACKLOG §4), so the two
// wind sliders are mutually exclusive: raising one sets the other to 0. This is
// the only place that rule is applied; everything downstream (currentWind on
// currentSurface, one summary slice) holds one surface because that is all the
// data has. When configs.json carries mixed builds, return both capacities here
// and carry the pair through to the slice loader.
const WIND_MIX_NOTE = 'Combined onshore and offshore builds aren\u2019t simulated yet, so raising one sets the other to 0.';
// With the add-on (T058, addon.json) the combined builds it simulates can be set
// on both sliders at once; a pair outside them lowers the other slider.
const WIND_MIX_NOTE_ADDON = 'Combined builds are simulated for onshore 1\u20134 + offshore 1\u20133 MW (5 at most in total)';
function windSettingFor(onGw, offGw, moved) {
    if (onGw > 0 && offGw > 0) {
        if (!addonPairs) {
            if (moved === 'on') offGw = 0;
            else onGw = 0;
        } else if (!addonPairs.has(`${onGw}|${offGw}`)) {
            // Lower the slider not moved to the largest level that makes a simulated pair, or 0.
            const other = moved === 'on' ? 'off' : 'on';
            const keep = moved === 'on' ? onGw : offGw;
            const was = moved === 'on' ? offGw : onGw;
            const fits = windLevels(other).filter(l => l > 0 && l < was
                && addonPairs.has(moved === 'on' ? `${keep}|${l}` : `${l}|${keep}`));
            const next = fits.length ? fits[fits.length - 1] : 0;
            if (moved === 'on') offGw = next;
            else onGw = next;
        }
    }
    if (onGw > 0 && offGw > 0) return { wind: onGw + offGw, surface: 'both', pair: { on: onGw, off: offGw } };
    return offGw > 0 ? { wind: offGw, surface: 'off' } : { wind: onGw, surface: 'on' };
}

/** Each wind slider steps through its surface's levels in configs.json, by index. */
function applyWindSliderRange() {
    const levels = { on: new Set([0]), off: new Set([0]) };
    configManifest.configs.forEach(c => {
        if (c.wind > 0 && levels[c.surface]) levels[c.surface].add(c.wind);
    });
    windSliderLevels = {
        on: [...levels.on].sort((a, b) => a - b),
        off: [...levels.off].sort((a, b) => a - b)
    };
    WIND_SLIDERS.forEach(({ id, surface }) => {
        const el = document.getElementById(id);
        if (el) el.max = String(windLevels(surface).length - 1);
    });
    applyAddonUi();
}

/**
 * Offer only the add-on sets in use (T058). Combined slider pairs: while addon.json
 * lists them, unless the cost search has loaded without them or a pair failed to
 * load (SHA-256 mismatch). The note on builds beyond the sliders: only once the
 * cost search has loaded the large set. Called again whenever that becomes known.
 */
function applyAddonUi() {
    const mixOk = Boolean(addonPairsAll) && !addonPairsFailed && !(addonKnown && !addonActive?.includes('wind_mix'));
    addonPairs = mixOk ? addonPairsAll : null;
    ['wind-mix-note', 'pop-wind-mix-note'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = addonPairs ? WIND_MIX_NOTE_ADDON : WIND_MIX_NOTE;
    });
    const largeOk = addonKnown && Boolean(addonActive?.includes('large'));
    ['addon-note', 'pop-addon-note'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !largeOk);
    });
    // A combined build on screen that is no longer offered: keep its onshore part.
    if (!addonPairs && currentSurface === 'both' && currentWindPair) {
        const on = currentWindPair.on;
        showWindSliders(on, 'on', null);
        setWindConfig(on, 'on');
    }
}

/** Show a wind setting on all four sliders: its capacity on its surface, 0 on the other
 *  (a combined build, surface 'both', shows each capacity on its own slider). */
function showWindSliders(wind, surface, pair = currentWindPair) {
    WIND_SLIDERS.forEach(({ id, valId, surface: s }) => {
        const gw = surface === 'both' && pair ? pair[s] : (s === surface ? wind : 0);
        const idx = String(Math.max(0, windLevels(s).indexOf(gw)));
        const slider = document.getElementById(id);
        const label = document.getElementById(valId);
        if (slider && slider.value !== idx) slider.value = idx;
        if (label) label.textContent = gw;
    });
}

function handleWindInput(surface, indexValue) {
    const levels = windLevels(surface);
    const idx = Math.max(0, Math.min(levels.length - 1, parseInt(indexValue, 10) || 0));
    const gw = levels[idx];
    const now = s => (currentSurface === 'both' && currentWindPair ? currentWindPair[s] : (currentSurface === s ? currentWind : 0));
    const shown = s => (s === surface ? gw : now(s));
    const next = windSettingFor(shown('on'), shown('off'), surface);
    showWindSliders(next.wind, next.surface, next.pair || null);
    setWindConfig(next.wind, next.surface, next.pair || null);
}

/** The note under the wind sliders carries only the load-error message (T062: the
 *  explanations moved to the info modal); any other update clears it. */
function updateWindNote() {
    ['wind-note', 'pop-wind-note'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
}

function handleSolarInput(value, source) {
    const val = parseInt(value, 10);
    if (!Number.isFinite(val)) return;
    currentSolar = val;
    solarVal.textContent = val;
    if (solarSlider) solarSlider.value = val;

    // Constrain the battery slider to the smallest simulated config for this
    // solar capacity, so the user cannot land on a config that has no data
    // (which would render an empty map).
    applyBattConstraint(val);

    debouncedUpdateModel();
}

function handleBattInput(value, source) {
    let val = parseInt(value, 10);
    if (!Number.isFinite(val)) return;
    // Never allow a battery below the smallest simulated config for the
    // current solar capacity (would render an empty map).
    val = Math.max(val, getMinBattForSolar(currentSolar));
    currentBatt = val;
    battVal.textContent = val;
    if (battSlider) battSlider.value = val;
    const popBattSlider = document.getElementById('pop-batt-slider');
    const popBattVal = document.getElementById('pop-batt-val');
    if (popBattSlider) popBattSlider.value = val;
    if (popBattVal) popBattVal.textContent = val;
    debouncedUpdateModel();
}

function refreshActiveLcoeView() {
    if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
        updatePopulationView();
    } else {
        updateLcoeView();
    }
}

async function handleLocationSelect(locationData) {
    currentLocationId = locationData?.location_id ?? null;
    const isPopulationLcoe = currentViewMode === 'population' && populationOverlayMode === 'lcoe';
    if ((currentViewMode === 'lcoe' || isPopulationLcoe) && locationData) {
        lcoeReference = locationData;
        resetLcoeTimeLegendLock();
        refreshActiveLcoeView();
    }
}

/**
 * Whether to warm the cost views in the background (T094): only on a fast
 * connection, as the warm-up downloads about 58 MB that a visitor who never
 * opens a cost view would not. ?warm=1 / ?warm=0 force it either way.
 */
function shouldWarmCostView() {
    if (WARM_FLAG === '1') return true;
    if (WARM_FLAG === '0') return false;
    try {
        if (matchMedia('(prefers-reduced-data: reduce)').matches) return false;
        const c = navigator.connection;
        // Chrome, Edge, Android: never on Save-Data or anything slower than 4g.
        if (c) return !c.saveData && c.effectiveType === '4g';
        // No Network Information API (Safari, Firefox): desktop only, a fine
        // pointer and a wide screen (the human's decision, D-171).
        return matchMedia('(pointer: fine) and (min-width: 1024px)').matches;
    } catch (_) {
        return false;
    }
}

// A warm-up search draws nothing: no draw request ever has this id.
const WARM_REQUEST_ID = -1;

/** Once the first map is up and the page is idle, warm the cost views. */
function scheduleCostViewWarmUp() {
    if (!lcoeWorkerUsable() || !shouldWarmCostView()) return;
    const idle = typeof requestIdleCallback === 'function'
        ? fn => requestIdleCallback(fn, { timeout: 3000 })
        : fn => setTimeout(fn, 500);
    // Two frames, so the first map's draw has been handed to the screen.
    requestAnimationFrame(() => requestAnimationFrame(() => idle(() => {
        warmCostView().catch(err => console.warn('Cost view warm-up stopped:', err?.message || err));
    })));
}

/**
 * Load in the background what opening the LCOE view waits for: the full grid
 * in the worker, the diesel and gas pricing (silently, with no loading pill),
 * and the default best-LCOE answer, which lands in the worker answer cache.
 * Worker mode only: the main-thread grid build never starts here.
 */
async function warmCostView() {
    if (!lcoeWorkerUsable() || !configManifest || !sliceLength()) return;
    ensureLcoeWorkerReady();
    await Promise.all([ensureDieselDataLoaded({ silent: true }), ensureGasDataLoaded({ silent: true })]);
    // A cost view opened meanwhile has made its own request.
    if (!lcoeWorkerUsable() || currentViewMode === 'lcoe' || currentViewMode === 'population') return;
    const targetCf = lcoeParams.targetCf;
    const key = buildWorkerCacheKey('best', targetCf, lcoeParams);
    if (lcoeWorkerBestCache.has(key)) return;
    requestLcoeWorkerSearch('best', key, targetCf, lcoeParams, WARM_REQUEST_ID);
}

async function init() {
    // Initialize UI state
    updatePlantStatusToggleUI();
    updatePopulationFuelToggleUI();
    try {
        // Start the heavy network loads immediately so they overlap with map
        // initialization (initMap doesn't read summary data; loadSummary
        // touches no DOM). The no-op catches keep an early failure from
        // surfacing as an unhandled rejection while initMap is still in
        // flight; the awaits below still rethrow into the same handlers.
        const summaryLoadPerf = startPerf('summary-load');
        // The manifest tells us which configurations exist; the wind = 0 slice
        // is what the map opens on, so it is the only one on the critical path.
        const manifestPromise = loadConfigManifest();
        manifestPromise.catch(() => {});
        // Decoded in a short-lived worker (data.js), so it overlaps initMap here.
        const summaryPromise = loadSummarySlice('on', 0, { offThread: FEATURE_WORKER_LCOE });
        summaryPromise.catch(() => {});
        const windResourcePromise = loadWindResourceCsv();
        windResourcePromise.catch(() => {});
        const overlapsPromise = loadVoronoiOverlappingCountriesCsv();
        overlapsPromise.catch(() => {});
        const addonManifestPromise = ADDON_ENABLED ? loadAddonManifest() : Promise.resolve(null);
        addonManifestPromise.catch(() => {});

        // Initialize Map
        await initMap(handleLocationSelect);

        // Complementarity controls (its data loads only when the tab opens)
        initComplementarity();

        // Load ONLY essential data upfront - summary data is required for the initial view
        // Population, fossil plants, and electricity data are lazy-loaded when their views are accessed
        loadingStatus.textContent = "Downloading summary data...";
        configManifest = await manifestPromise;
        try {
            const m = await addonManifestPromise;
            if (m) indexAddonManifest(m);
        } catch (err) {
            console.error('addon.json could not be read; the add-on builds are not used.', err);
        }
        applyWindSliderRange();
        const slice = await summaryPromise;
        // Feeds only the per-region note under the wind sliders and the tooltips'
        // wind-surface line; results don't use it.
        try {
            const windRows = await windResourcePromise;
            windResourceMap = new Map(windRows.map(r => [r.location_id, r]));
            setWindSites(windResourceMap);
            if (!windResourceMap.size) console.warn('Wind resource data empty or missing; the wind note shows generic text.');
        } catch (err) {
            console.warn('Wind resource data failed to load; the wind note shows generic text:', err);
        }
        endPerf(summaryLoadPerf, { rows: slice?.n || 0 });
        if (!slice || !Number.isInteger(slice.n)) {
            throw new Error("summary slice did not load: " + typeof slice);
        }
        // Load per-cell country overlaps (small) so every tooltip can show the
        // country (or countries, for border-straddling cells) the hovered cell
        // covers. Best-effort: a failure just omits the country line.
        try {
            const overlapRows = await overlapsPromise;
            setCellCountries(new Map(overlapRows.map(r => [r.location_id, r.country_names])));
        } catch (err) {
            console.warn('Overlapping-countries data unavailable:', err);
        }

        indexSummarySlice(slice, 0, 'on');
        applyBattConstraint(currentSolar);

        // The full grid for the cost views loads when one is first opened
        // (ensureFullGridLoading), so the capacity view never pays for it.

        // NOTE: Population, fossil plants, and electricity data are now LAZY LOADED
        // They will be fetched when the user switches to the Supply-Demand Matching view
        // See: ensurePopulationModeDataLoaded(), ensureFossilDataLoaded(), ensureElectricityDataLoaded()

        loadingStatus.textContent = "Processing...";
        console.log("Loaded summary data. Rows:", slice.n);

        // Initialize UI Events
        initUIEvents();
        updateWaccSourceToggleUI();
        updateCapexSourceToggleUI();
        updateDieselSourceToggleUI();
        updateGasSourceToggleUI();

        // Initial View
        syncCapacitySliders();
        updateWindNote();
        updateViewMode('capacity');
        updateModel();

        // Hide Loading. From here on the same element is a small spinner over
        // the map (style.css, #loading.is-compact), not a full black screen.
        loading.classList.add('hidden');
        loading.classList.add('is-compact');

        // Guided tour: wires the "Take a Tour" button and auto-prompts on first visit
        initTour({ updateViewMode, getCurrentMode: () => currentViewMode });

        scheduleCostViewWarmUp();

    } catch (err) {
        console.error(err);
        loadingStatus.textContent = "Error loading data: " + err.message;
        loadingStatus.classList.add('text-red-500');
    }
}

function initUIEvents() {
    // View Mode Tabs
    viewTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const mode = tab.dataset.mode;
            updateViewMode(mode);
        });
    });

    if (potentialLevelButtons && potentialLevelButtons.length) {
        potentialLevelButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const level = btn.dataset.level;
                if (!level || level === potentialLevel) return;
                potentialLevel = level;
                syncPotentialToggleUI();
                if (currentViewMode === 'potential') {
                    updatePotentialView();
                } else if (currentViewMode === 'population' && populationOverlayMode === 'potential') {
                    updatePopulationView();
                }
            });
        });
    }
    if (potentialDisplayButtons && potentialDisplayButtons.length) {
        potentialDisplayButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.display;
                if (!mode || mode === potentialDisplayMode) return;
                potentialDisplayMode = mode;
                syncPotentialToggleUI();
                if (currentViewMode === 'potential') {
                    updatePotentialView();
                } else if (currentViewMode === 'population' && populationOverlayMode === 'potential') {
                    updatePopulationView();
                }
            });
        });
    }

    const onPotentialWindControl = (buttons, attr, apply) => {
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled || !apply(btn.dataset[attr])) return;
                syncPotentialToggleUI();
                if (currentViewMode === 'potential') updatePotentialView();
            });
        });
    };
    onPotentialWindControl(potentialTechButtons, 'tech', tech => {
        if (!tech || tech === potentialTech) return false;
        potentialTech = tech;
        return true;
    });
    onPotentialWindControl(potentialDefinitionButtons, 'definition', value => {
        if ((value !== 'cons' && value !== 'tech') || value === potentialDefinition) return false;
        potentialDefinition = value;
        return true;
    });
    onPotentialWindControl(potentialOffshoreButtons, 'offshore', layer => {
        if (!layer || layer === potentialOffshoreLayer) return false;
        potentialOffshoreLayer = layer;
        return true;
    });

    if (supplyPotentialLevelButtons && supplyPotentialLevelButtons.length) {
        supplyPotentialLevelButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const level = btn.dataset.level;
                if (!level || level === potentialLevel) return;
                potentialLevel = level;
                syncPotentialToggleUI();
                if (currentViewMode === 'potential') {
                    updatePotentialView();
                } else if (currentViewMode === 'population' && populationOverlayMode === 'potential') {
                    updatePopulationView();
                }
            });
        });
    }

    if (supplyPotentialDisplayButtons && supplyPotentialDisplayButtons.length) {
        supplyPotentialDisplayButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.display;
                if (!mode || mode === potentialDisplayMode) return;
                potentialDisplayMode = mode;
                syncPotentialToggleUI();
                if (currentViewMode === 'potential') {
                    updatePotentialView();
                } else if (currentViewMode === 'population' && populationOverlayMode === 'potential') {
                    updatePopulationView();
                }
            });
        });
    }

    // Sliders
    solarSlider.addEventListener('input', (e) => handleSolarInput(e.target.value, 'main'));
    battSlider.addEventListener('input', (e) => handleBattInput(e.target.value, 'main'));

    WIND_SLIDERS.forEach(({ id, surface }) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', (e) => handleWindInput(surface, e.target.value));
    });

    // Complementarity controls are wired in complementarity.js.

    // Population Controls
    populationBaseButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            setPopulationBaseLayer(btn.dataset.base);
        });
    });

    if (populationControlsToggle && populationControls) {
        populationControlsToggle.addEventListener('click', () => {
            togglePanelCollapse(populationControls, populationControlsToggle);
        });
    }

    if (populationSupplyToggle && populationSupplyPanel) {
        populationSupplyToggle.addEventListener('click', () => {
            togglePanelCollapse(populationSupplyPanel, populationSupplyToggle);
        });
    }

    // Plant Status Toggle (Announced/Existing)
    plantStatusButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const status = btn.dataset.status;
            if (status === plantStatusFilter) return;
            plantStatusFilter = status;
            updatePlantStatusToggleUI();
            if (populationBaseLayer === 'plants' && currentViewMode === 'population') {
                updatePopulationView();
            }
        });
    });

    populationOverlayButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.overlay || 'cf';
            if (mode === populationOverlayMode) return;
            populationOverlayMode = mode;
            updatePopulationOverlayToggleUI();
            updatePopulationOverlayControls(mode);
            if (currentViewMode === 'population') {
                updatePopulationView();
            }
        });
    });

    window.addEventListener('resize', () => {
        if (currentViewMode === 'population' && populationDisplayMode === 'charts') {
            updatePopulationChartsBounds();
        }
    });


    // Fuel Buttons and Legend Items Toggle Logic
    const togglePopulationFuel = (fuel) => {
        if (populationFuelFilter.has(fuel)) {
            populationFuelFilter.delete(fuel);
        } else {
            populationFuelFilter.add(fuel);
        }
        updatePopulationFuelToggleUI();
        if (populationBaseLayer === 'plants') {
            updatePopulationView();
        }
    };

    if (populationFuelButtons) {
        populationFuelButtons.forEach(btn => {
            btn.addEventListener('click', () => togglePopulationFuel(btn.dataset.fuel));
        });
    }


    // Cumulative Toggle
    const cumulativeToggle = document.getElementById('chart-cumulative-toggle');
    if (cumulativeToggle) {
        cumulativeToggle.textContent = `Cumulative: ${populationChartCumulative ? 'ON' : 'OFF'}`;
        cumulativeToggle.classList.toggle('text-emerald-400', populationChartCumulative);
        cumulativeToggle.classList.toggle('bg-emerald-400/10', populationChartCumulative);
        cumulativeToggle.classList.toggle('border-emerald-400/20', populationChartCumulative);
        cumulativeToggle.addEventListener('click', () => {
            populationChartCumulative = !populationChartCumulative;
            cumulativeToggle.textContent = `Cumulative: ${populationChartCumulative ? 'ON' : 'OFF'}`;
            cumulativeToggle.classList.toggle('text-emerald-400', populationChartCumulative);
            cumulativeToggle.classList.toggle('bg-emerald-400/10', populationChartCumulative);
            cumulativeToggle.classList.toggle('border-emerald-400/20', populationChartCumulative);

            // Re-render chart
            updatePopulationView();
        });
    }

    if (reliabilityThresholdSlider) {
        reliabilityThresholdSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (!Number.isFinite(val)) return;
            reliabilityThreshold = Math.max(0, Math.min(100, val));
            if (reliabilityThresholdVal) reliabilityThresholdVal.textContent = reliabilityThreshold;
            if (currentViewMode === 'population' && populationBaseLayer === 'uptime') {
                updatePopulationView();
            }
        });
    }

    // Population CF overlay sliders (sync with main values)
    const popSolarSlider = document.getElementById('pop-solar-slider');
    const popSolarVal = document.getElementById('pop-solar-val');
    const popBattSlider = document.getElementById('pop-batt-slider');
    const popBattVal = document.getElementById('pop-batt-val');

    if (popSolarSlider) {
        popSolarSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (popSolarVal) popSolarVal.textContent = val;
            handleSolarInput(val);
        });
    }

    if (popBattSlider) {
        popBattSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (popBattVal) popBattVal.textContent = val;
            handleBattInput(val);
        });
    }

    if (popTargetCfSlider) {
        popTargetCfSlider.addEventListener('input', (e) => {
            const val = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
            lcoeParams.targetCf = val / 100;
            syncLcoeControlValues();
            resetLcoeTimeLegendLock();
            queueLcoeUpdate();
        });
    }

    // Population LCOE parameter inputs
    const updatePopLcoeParams = () => {
        lcoeParams.solarCapex = parseFloat(popSolarCapexInput?.value) || 720;
        lcoeParams.batteryCapex = parseFloat(popBatteryCapexInput?.value) || 120;
        lcoeParams.solarOpexPct = parseFloat(popSolarOpexInput?.value) / 100 || 0.015;
        lcoeParams.batteryOpexPct = parseFloat(popBatteryOpexInput?.value) / 100 || 0.02;
        lcoeParams.solarDegradationPct = (parseFloat(popSolarDegradationInput?.value) || 0) / 100;
        lcoeParams.solarLife = parseInt(popSolarLifeInput?.value, 10) || 30;
        lcoeParams.batteryLife = parseInt(popBatteryLifeInput?.value, 10) || 20;
        lcoeParams.wacc = parseFloat(popWaccInput?.value) / 100 || 0.07;
        lcoeParams.ilr = parseFloat(popIlrInput?.value) || 1.3;
        lcoeParams.dieselCapex = parseFloat(popDieselCapexInput?.value) || 300;
        lcoeParams.dieselEfficiency = (parseFloat(popDieselEfficiencyInput?.value) || 35) / 100;
        lcoeParams.dieselLife = parseInt(popDieselLifeInput?.value, 10) || 20;
        lcoeParams.gasCapex = parseFloat(popGasCapexInput?.value) || 800;
        lcoeParams.gasEfficiency = (parseFloat(popGasEfficiencyInput?.value) || 35) / 100;
        lcoeParams.gasLife = parseInt(popGasLifeInput?.value, 10) || 25;
        lcoeParams.gasPrice = parseFloat(popGasPriceInput?.value) || 0;
        syncLcoeControlValues();
        resetLcoeTimeLegendLock();

        // Recalculate if we're in population view with LCOE overlay
        if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
            updatePopulationView();
        }
    };

    [popSolarCapexInput, popBatteryCapexInput, popSolarOpexInput, popBatteryOpexInput,
        popSolarDegradationInput,
        popSolarLifeInput, popBatteryLifeInput, popWaccInput, popIlrInput,
        popDieselCapexInput, popDieselEfficiencyInput, popDieselLifeInput,
        popGasCapexInput, popGasEfficiencyInput, popGasLifeInput, popGasPriceInput].forEach(input => {
            if (input) {
                input.addEventListener('change', updatePopLcoeParams);
            }
        });

    if (popGasSourceButtons && popGasSourceButtons.length) {
        popGasSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setGasPriceMode(btn.dataset.mode);
            });
        });
    }

    if (popDieselBackupInput) {
        popDieselBackupInput.addEventListener('change', (e) => {
            setDieselBackupEnabled(e.target.checked);
        });
    }

    populationDisplayButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            setPopulationDisplayMode(btn.dataset.mode);
        });
    });

    if (closeChartsBtn) {
        closeChartsBtn.addEventListener('click', () => {
            setPopulationDisplayMode('map');
        });
    }

    // Settings Modal Inputs
    targetCfSlider.addEventListener('input', (e) => {
        const pct = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
        lcoeParams.targetCf = pct / 100;
        syncLcoeControlValues();
        resetLcoeTimeLegendLock();
        queueLcoeUpdate();
    });

    // Target Mode Toggle
    lcoeTargetModeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.targetMode;
            if (mode === lcoeTargetMode) return;

            lcoeTargetMode = mode;
            resetLcoeTimeLegendLock();

            // Update button styles
            lcoeTargetModeButtons.forEach(b => {
                b.classList.toggle('is-active', b.dataset.targetMode === mode);
            });

            syncLcoeControlValues();
            if (targetLcoeContainer) {
                targetLcoeContainer.classList.toggle('hidden', mode !== 'lcoe');
            }

            // Update view
            if (currentViewMode === 'lcoe') {
                updateLcoeView();
            }
        });
    });

    // Target LCOE Input
    if (targetLcoeInput) {
        targetLcoeInput.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value) || 50;
            targetLcoeValue = Math.max(0, value);
            resetLcoeTimeLegendLock();
            if (currentViewMode === 'lcoe' && lcoeTargetMode === 'lcoe') {
                queueLcoeUpdate();
            }
        });
    }

    if (lcoeTimeSlider) {
        lcoeTimeSlider.min = LCOE_TIME_ANCHORS.baseYear;
        lcoeTimeSlider.max = 2050;
        lcoeTimeSlider.value = LCOE_TIME_ANCHORS.baseYear;
        applyLcoeTimeYear(LCOE_TIME_ANCHORS.baseYear, { lockLegend: false });
        lcoeTimeSlider.addEventListener('input', (e) => {
            const year = parseInt(e.target.value, 10);
            applyLcoeTimeYear(Number.isFinite(year) ? year : LCOE_TIME_ANCHORS.baseYear);
        });
    }

    if (lcoeTimePlayBtn) {
        lcoeTimePlayBtn.addEventListener('click', toggleLcoeTimeAnimation);
    }

    if (popLcoeTimeSlider) {
        popLcoeTimeSlider.min = LCOE_TIME_ANCHORS.baseYear;
        popLcoeTimeSlider.max = 2050;
        popLcoeTimeSlider.value = lcoeTimeYear;
        popLcoeTimeSlider.addEventListener('input', (e) => {
            const year = parseInt(e.target.value, 10);
            applyLcoeTimeYear(Number.isFinite(year) ? year : LCOE_TIME_ANCHORS.baseYear);
        });
    }

    if (popLcoeTimePlayBtn) {
        popLcoeTimePlayBtn.addEventListener('click', toggleLcoeTimeAnimation);
    }

    // T098: "Edit assumptions" disclosures under the cost, WACC and fuel toggles (folded on load).
    document.querySelectorAll('.assump-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const open = btn.getAttribute('aria-expanded') !== 'true';
            const body = document.getElementById(btn.getAttribute('aria-controls'));
            btn.setAttribute('aria-expanded', String(open));
            if (body) body.hidden = !open;
            const label = btn.querySelector('.assump-toggle__label');
            if (label) label.textContent = open ? 'Hide assumptions' : 'Edit assumptions';
        });
    });

    if (waccSourceButtons && waccSourceButtons.length) {
        waccSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                setWaccMode(mode);
            });
        });
    }
    if (popWaccSourceButtons && popWaccSourceButtons.length) {
        popWaccSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                setWaccMode(mode);
            });
        });
    }
    if (capexSourceButtons && capexSourceButtons.length) {
        capexSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                setCapexMode(mode);
            });
        });
    }
    if (popCapexSourceButtons && popCapexSourceButtons.length) {
        popCapexSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                setCapexMode(mode);
            });
        });
    }
    if (dieselSourceButtons && dieselSourceButtons.length) {
        dieselSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setDieselPriceMode(btn.dataset.mode);
            });
        });
    }
    if (popDieselSourceButtons && popDieselSourceButtons.length) {
        popDieselSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setDieselPriceMode(btn.dataset.mode);
            });
        });
    }
    if (gasSourceButtons && gasSourceButtons.length) {
        gasSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setGasPriceMode(btn.dataset.mode);
            });
        });
    }

    [solarCapexInput, batteryCapexInput, solarOpexInput, batteryOpexInput, solarDegradationInput, solarLifeInput, batteryLifeInput, waccInput, ilrInput,
        dieselCapexInput, dieselEfficiencyInput, dieselLifeInput, dieselPriceInput,
        gasCapexInput, gasEfficiencyInput, gasLifeInput, gasPriceInput].forEach(input => {
        if (input) input.addEventListener('change', updateLcoeParams);
    });

    // Wind cost and WACC premium inputs, in both the main and the supply panel.
    ['wind-capex', 'offwind-capex', 'wind-opex', 'offwind-opex', 'wind-life', 'offwind-life',
        'wind-degradation', 'offwind-degradation',
        'wind-wacc-premium', 'offwind-wacc-premium'].forEach(base => {
        [base, `pop-${base}`].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', () => {
                // Mirror into the twin so the two panels never disagree.
                const twin = document.getElementById(id.startsWith('pop-') ? id.slice(4) : `pop-${id}`);
                if (twin) twin.value = el.value;
                updateLcoeParams();
            });
        });
    });

    if (dieselBackupInput) {
        dieselBackupInput.addEventListener('change', (e) => {
            setDieselBackupEnabled(e.target.checked);
        });
    }

    // 'Include offshore wind', in both the LCOE and the supply panel.
    includeOffshoreInputs.forEach(input => {
        input.addEventListener('change', (e) => {
            lcoeParams.includeOffshore = e.target.checked;
            // T074: the Offshore chip is this switch; the wind layers may fall back.
            onTechFilterChange();
        });
    });

    syncLcoeControlValues();

    // LCOE Legend Actions
    if (clearRefBtn) {
        clearRefBtn.addEventListener('click', () => {
            lcoeReference = null;
            lcoeDisplayMode = 'delta'; // Reset to delta mode when clearing reference
            resetLcoeTimeLegendLock();
            updateModel();
        });
    }
}

async function updateViewMode(mode) {
    // The one entry to every view: tab clicks and the tour both come through here.
    currentViewMode = mode;
    // Another view's map goes up now, so no LCOE result is on screen.
    lcoeShownKind = null;
    setLcoePending(null);
    renderMapBusy();
    if (mode === 'lcoe' || mode === 'population') ensureFullGridLoading();
    if (mode !== 'lcoe') {
        stopLcoeTimeAnimation();
        resetLcoeTimeLegendLock();
    }

    setDualMapMode(mode === 'population' && populationDisplayMode === 'map');
    if (mode !== 'population') {
        updateSupplyMap({ overlayMode: 'none' });
    }

    // Update Tabs UI
    viewTabs.forEach(tab => {
        const isActive = tab.dataset.mode === mode;
        if (isActive) {
            tab.classList.remove('text-muted', 'hover:text-white', 'hover:bg-white/5');
            tab.classList.add('bg-primary', 'text-black');
        } else {
            tab.classList.add('text-muted', 'hover:text-white', 'hover:bg-white/5');
            tab.classList.remove('bg-primary', 'text-black');
        }
    });

    // Reset state
    if (mode !== 'complementarity') cleanupComplementarity();
    if (mode !== 'population') {
        populationChartsContainer.classList.add('hidden');
        if (mapShell) mapShell.classList.remove('hidden');
    }

    // Toggle Panels
    const systemConfig = document.getElementById('primary-controls');
    const lcoeControls = document.getElementById('lcoe-controls');
    const populationSupplyPanel = populationSupplyControls;

    if (mode === 'lcoe') {
        // LCOE mode: Hide system config, show LCOE controls
        if (systemConfig) systemConfig.classList.add('hidden');
        if (lcoeControls) lcoeControls.classList.remove('hidden');
        if (lcoeTimePanel) lcoeTimePanel.classList.remove('hidden');
        compControls.classList.add('hidden');
        if (potentialControls) potentialControls.classList.add('hidden');
        populationControls.classList.add('hidden');
        if (populationSupplyPanel) populationSupplyPanel.classList.add('hidden');
        if (populationViewToggle) populationViewToggle.classList.add('hidden');
    } else if (mode === 'complementarity') {
        // Complementarity mode: its own controls only (it does not depend on the build)
        if (systemConfig) systemConfig.classList.add('hidden');
        if (lcoeControls) lcoeControls.classList.add('hidden');
        if (lcoeTimePanel) lcoeTimePanel.classList.add('hidden');
        compControls.classList.remove('hidden');
        if (potentialControls) potentialControls.classList.add('hidden');
        populationControls.classList.add('hidden');
        if (populationSupplyPanel) populationSupplyPanel.classList.add('hidden');
        if (populationViewToggle) populationViewToggle.classList.add('hidden');
    } else if (mode === 'potential') {
        // Potential mode: Hide system config, show potential controls
        if (systemConfig) systemConfig.classList.add('hidden');
        if (lcoeControls) lcoeControls.classList.add('hidden');
        if (lcoeTimePanel) lcoeTimePanel.classList.add('hidden');
        compControls.classList.add('hidden');
        if (potentialControls) potentialControls.classList.remove('hidden');
        populationControls.classList.add('hidden');
        if (populationSupplyPanel) populationSupplyPanel.classList.add('hidden');
        if (populationViewToggle) populationViewToggle.classList.add('hidden');
    } else if (mode === 'population') {
        // Population mode: Hide system config, show population controls
        if (systemConfig) systemConfig.classList.add('hidden');
        if (lcoeControls) lcoeControls.classList.add('hidden');
        if (lcoeTimePanel) lcoeTimePanel.classList.add('hidden');
        compControls.classList.add('hidden');
        if (potentialControls) potentialControls.classList.add('hidden');
        populationControls.classList.remove('hidden');
        if (populationSupplyPanel) populationSupplyPanel.classList.remove('hidden');
        updatePopulationOverlayToggleUI();
        updatePopulationOverlayControls(populationOverlayMode);
        syncPotentialToggleUI();
        if (populationViewToggle) populationViewToggle.classList.remove('hidden');
    } else {
        // Capacity mode: Show system config only
        if (systemConfig) systemConfig.classList.remove('hidden');
        if (lcoeControls) lcoeControls.classList.add('hidden');
        if (lcoeTimePanel) lcoeTimePanel.classList.add('hidden');
        compControls.classList.add('hidden');
        if (potentialControls) potentialControls.classList.add('hidden');
        populationControls.classList.add('hidden');
        if (populationSupplyPanel) populationSupplyPanel.classList.add('hidden');
        if (populationViewToggle) populationViewToggle.classList.add('hidden');
    }

    // Toggle Legends & Map Content
    hideAllLegends();

    if (mode === 'capacity') {
        legendCapacity.classList.remove('hidden');
        updateMap(getSummaryForConfig(currentSolar, currentBatt), currentSolar, currentBatt, capacityDrawOpts());
    } else if (mode === 'complementarity') {
        // complementarity.js shows its own legend and draws the map. On the first visit,
        // while its data loads, the capacity map stands in rather than the last view's.
        if (!complementarityReady()) {
            updateMap(getSummaryForConfig(currentSolar, currentBatt), currentSolar, currentBatt, capacityDrawOpts());
        }
        showComplementarity({ positions: sliceLocationPositions() });
    } else if (mode === 'potential') {
        legendPotential.classList.remove('hidden');
        syncPotentialToggleUI();
        await updatePotentialView();
    } else if (mode === 'lcoe') {
        legendLcoe.classList.remove('hidden');
        await ensureDieselDataLoaded();
        await ensureGasDataLoaded();
        syncLcoeControlValues();
        updateLcoeView();
    } else if (mode === 'population') {
        // LAZY LOAD: Ensure population data is loaded before updating view
        await ensurePopulationModeDataLoaded();
        if (currentViewMode !== mode) return;
        updatePopulationView();
    }
}

// ?debug only: map.js reports every draw here with a snapshot the renderer took
// when it fixed the cells' colours: the row objects drawn and a copy of their
// fields. Digests are computed by checks/ (checks/digest.mjs, injected into the
// page), which also compare the rows with the copy, so a row changed after the
// draw is caught. A draw reported without a snapshot is recorded with copy null.
if (DEBUG_SNAPSHOT) {
    const drawn = { seq: 0, views: {} };
    window.__atlasDrawn = (view, rows, opts, snap) => {
        drawn.seq += 1;
        drawn.views[view] = { rows: snap ? snap.rows : Array.from(rows || []), copy: snap ? snap.copy : null,
            opts: { ...opts }, seq: drawn.seq, at: performance.now() };
    };
    window.__drawn = drawn;
}

function publishDebugSnapshot(stats) {
    if (!DEBUG_SNAPSHOT) return;
    try {
        const lr = lcoeResults || [];
        const shares = lr.map(r => r.windShare || 0).sort((a, b) => a - b);
        const savings = lr.map(r => r.windSaving).filter(Number.isFinite).sort((a, b) => a - b);
        // Evaluate one configuration for one location, exactly as the search does.
        const evalConfig = (locationId, solarGw, windGw, battGwh, surface = 'on') => {
            const rows = getLocationIndex().get(locationId);
            if (!rows || !rows.length) return { error: 'no rows for location' };
            let cf = null;
            let unitCf;
            if (cfMatrix) {
                const li = cfMatrix.locationIds.indexOf(locationId);
                if (!cfMatrix.unitCfg) cfMatrix.unitCfg = unitConfigIndices(cfMatrix);
                if (li >= 0) unitCf = matrixUnitCf(cfMatrix, li);
                const cfg = configManifest.byKey.get(configKey(surface, solarGw, windGw, battGwh));
                if (li >= 0 && cfg) cf = cfMatrix.cf[li * cfMatrix.nCfg + cfg.i];
            } else {
                // The worker holds the grid; the slice on screen has this wind level.
                const s = windGw ? surface : 'on';
                const hit = rows.find(r => r.solar_gw === solarGw && (r.wind_gw || 0) === windGw
                    && r.batt_gwh === battGwh && (r.wind_surface || 'on') === s);
                if (hit) cf = hit.annual_cf;
            }
            const pre = precomputeLcoePerLocation(rows[0], lcoeParams, unitCf);
            const row = {
                location_id: locationId, solar_gw: solarGw, wind_gw: windGw, batt_gwh: battGwh,
                annual_cf: cf, wind_surface: windGw ? surface : 'on',
                _solarKw: solarGw * 1e6, _windKw: windGw * 1e6, _batteryKwh: battGwh * 1e6,
                _annualEnergyMwh: (cf || 0) * 8760 * BASE_LOAD_MW
            };
            const m = cf > 0 ? computeLcoeMetricsFast(row, pre) : null;
            const preWind = Object.fromEntries(Object.entries(pre).filter(([k]) => /wind|Wind/.test(k)));
            return { cf, lcoe: m?.lcoe, annualCost: m?.annual_cost_usd, energy: m?.annual_energy_mwh, preWind };
        };
        window.__atlas = {
            evalConfig,
            solar: currentSolar, wind: currentWind, surface: currentSurface, batt: currentBatt,
            includeOffshore: lcoeParams.includeOffshore !== false,
            windOn: currentWindPair ? currentWindPair.on : null,
            windOff: currentWindPair ? currentWindPair.off : null,
            addon: { enabled: ADDON_ENABLED, manifest: Boolean(addonManifest), active: addonActive, known: addonKnown,
                pairs: Boolean(addonPairs) },
            view: currentViewMode, sliceRows: sliceLength(), matrixReady: fullGridSearchReady(),
            stats,
            lcoe: {
                n: lr.length,
                withWind: lr.filter(r => r.wind_gw > 0).length,
                offshoreChosen: lr.filter(r => r.wind_surface === 'off' && r.wind_gw > 0).length,
                meetsTarget: lr.filter(r => r.meetsTarget).length,
                medianWindShare: shares.length ? shares[shares.length >> 1] : null,
                medianSaving: savings.length ? savings[savings.length >> 1] : null,
                savingOver10: savings.filter(v => v > 10).length,
                example: lr.find(r => r.wind_gw > 0) || lr[0] || null
            }
        };
    } catch (e) { window.__atlas = { error: String(e) }; }
}

/** What a capacity draw is for: the slice's wind level and surface (and, for a combined build, both capacities). */
function capacityDrawOpts() {
    const o = { preFiltered: true, wind: sliceIndex?.wind, surface: sliceIndex?.surface };
    if (sliceIndex?.pair) { o.windOn = sliceIndex.pair.on; o.windOff = sliceIndex.pair.off; }
    return o;
}

function updateUI() {
    // Update stats (use cached aggregates)
    const stats = getSummaryStatsForConfig(currentSolar, currentBatt);
    publishDebugSnapshot(stats);
    if (stats && stats.count) {
        if (statAvgCf) statAvgCf.textContent = `${(stats.avg * 100).toFixed(1)}%`;
        if (statMaxCf) statMaxCf.textContent = `${(stats.max * 100).toFixed(1)}%`;
    } else {
        if (statAvgCf) statAvgCf.textContent = '--%';
        if (statMaxCf) statMaxCf.textContent = '--%';
    }

    // Update map
    if (currentViewMode === 'capacity') {
        const filtered = getSummaryForConfig(currentSolar, currentBatt);
        updateMap(filtered, currentSolar, currentBatt, capacityDrawOpts());
    } else if (currentViewMode === 'lcoe') {
        queueLcoeUpdate();
    } else if (currentViewMode === 'population') {
        updatePopulationView();
    } else if (currentViewMode === 'potential') {
        updatePotentialView();
    }
}

function updateLcoeParams() {
    lcoeParams.solarCapex = parseFloat(solarCapexInput.value) || 0;
    lcoeParams.batteryCapex = parseFloat(batteryCapexInput.value) || 0;
    lcoeParams.solarOpexPct = (parseFloat(solarOpexInput.value) || 0) / 100;
    lcoeParams.batteryOpexPct = (parseFloat(batteryOpexInput.value) || 0) / 100;
    lcoeParams.solarDegradationPct = (parseFloat(solarDegradationInput?.value) || 0) / 100;
    lcoeParams.solarLife = parseInt(solarLifeInput.value, 10) || 1;
    lcoeParams.batteryLife = parseInt(batteryLifeInput.value, 10) || 1;
    lcoeParams.wacc = (parseFloat(waccInput.value) || 0) / 100;
    lcoeParams.ilr = parseFloat(ilrInput?.value) || 1.3;
    lcoeParams.dieselCapex = parseFloat(dieselCapexInput?.value) || 300;
    lcoeParams.dieselEfficiency = (parseFloat(dieselEfficiencyInput?.value) || 35) / 100;
    lcoeParams.dieselLife = parseInt(dieselLifeInput?.value, 10) || 20;
    lcoeParams.dieselPrice = parseFloat(dieselPriceInput?.value) || 0;
    lcoeParams.dieselPriceMode = dieselPriceMode;
    lcoeParams.gasCapex = parseFloat(gasCapexInput?.value) || 800;
    lcoeParams.gasEfficiency = (parseFloat(gasEfficiencyInput?.value) || 35) / 100;
    lcoeParams.gasLife = parseInt(gasLifeInput?.value, 10) || 25;
    lcoeParams.gasPrice = parseFloat(gasPriceInput?.value) || 0;
    lcoeParams.gasPriceMode = gasPriceMode;
    // Wind. Read from whichever panel is on screen; the two are kept in sync.
    const num = (id, fallback) => {
        const el = document.getElementById(id) || document.getElementById(`pop-${id}`);
        const v = parseFloat(el?.value);
        return Number.isFinite(v) ? v : fallback;
    };
    lcoeParams.windCapex = num('wind-capex', Math.round(WIND_GLOBAL_CAPEX.on[2024]));
    lcoeParams.windOffCapex = num('offwind-capex', Math.round(WIND_GLOBAL_CAPEX.off[2024]));
    lcoeParams.windOpexPct = num('wind-opex', 2.5) / 100;
    lcoeParams.windOffOpexPct = num('offwind-opex', 3.5) / 100;
    lcoeParams.windLife = Math.max(1, Math.round(num('wind-life', 30)));
    lcoeParams.windOffLife = Math.max(1, Math.round(num('offwind-life', 30)));
    lcoeParams.windDegradationPct = Math.max(0, num('wind-degradation', 0.2)) / 100;
    lcoeParams.windOffDegradationPct = Math.max(0, num('offwind-degradation', 0.2)) / 100;
    lcoeParams.windWaccPremium = num('wind-wacc-premium', WIND_WACC_PREMIUM_DEFAULT.on * 100) / 100;
    lcoeParams.windOffWaccPremium = num('offwind-wacc-premium', WIND_WACC_PREMIUM_DEFAULT.off * 100) / 100;
    syncLcoeControlValues();
    resetLcoeTimeLegendLock();
    queueLcoeUpdate();
}

// Build (and cache) a location_id -> population map for the per-capita potential
// view. Population is keyed by lat/lon (full float) while potential is keyed by
// location_id + 6-decimal lat/lon, so we join on a 2-decimal coordinate key —
// the same tolerance the population overlays use. (2 decimals matches 4394/4399
// zones with zero key collisions; finer keys lose zones to boundary rounding.)
function ensurePotentialPopulationMap() {
    if (potentialPopulationMap) return potentialPopulationMap;
    const coord2 = (lat, lon) => `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
    const popByCoord = new Map();
    populationData.forEach(p => {
        if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
        popByCoord.set(coord2(p.latitude, p.longitude), p.population_2020);
    });
    const map = new Map();
    potentialData.forEach(row => {
        const pop = popByCoord.get(coord2(row.latitude, row.longitude));
        if (pop !== undefined) map.set(row.location_id, pop);
    });
    potentialPopulationMap = map;
    return map;
}

async function getPotentialOverlayState() {
    const loaded = await ensurePotentialDataLoaded();
    if (!loaded) return null;

    const key = potentialLevel === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
    const dataAreaKey = potentialLevel === 'level2'
        ? 'pvout_level2_data_area_km2'
        : 'pvout_level1_data_area_km2';
    const isMultiple = potentialDisplayMode === 'multiple';
    const isPerCapita = potentialDisplayMode === 'per_capita';
    let demandMap = null;
    let populationMap = null;
    let latBounds = potentialLatBounds[potentialLevel];

    if (isMultiple) {
        const demandLoaded = await ensureElectricityDataLoaded();
        if (!demandLoaded) return null;
        demandMap = electricityDemandMap;
    } else if (isPerCapita) {
        const popLoaded = await ensurePopulationDataLoaded();
        if (!popLoaded) return null;
        populationMap = ensurePotentialPopulationMap();
    }

    if (!latBounds) {
        let minLat = Infinity;
        let maxLat = -Infinity;
        potentialData.forEach(row => {
            const dataArea = Number(row[dataAreaKey] || 0);
            const lat = Number(row.latitude);
            if (!Number.isFinite(lat) || dataArea <= 0) return;
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        });
        if (Number.isFinite(minLat) && Number.isFinite(maxLat)) {
            latBounds = { min: minLat, max: maxLat };
            potentialLatBounds[potentialLevel] = latBounds;
        }
    }

    const values = [];
    potentialData.forEach(row => {
        const lat = Number(row.latitude);
        if (latBounds && (lat < latBounds.min || lat > latBounds.max)) return;
        const total = Number(row[key] || 0);
        if (!Number.isFinite(total)) return;
        values.push(total);
    });

    if (!values.length) {
        return {
            data: [],
            level: potentialLevel,
            displayMode: potentialDisplayMode,
            isMultiple,
            isPerCapita,
            min: null,
            max: null,
            demandMap,
            populationMap,
            latBounds,
            key,
            valueCount: 0
        };
    }

    let minVal = Math.min(...values);
    let maxVal = Math.max(...values);
    if (!isMultiple && minVal === maxVal) {
        maxVal = minVal + 1;
    }

    return {
        data: potentialData,
        level: potentialLevel,
        displayMode: potentialDisplayMode,
        isMultiple,
        isPerCapita,
        min: minVal,
        max: maxVal,
        demandMap,
        populationMap,
        latBounds,
        key,
        valueCount: values.length
    };
}

// State for the Potential view. Solar is getPotentialOverlayState unchanged; wind
// (and All) take the same demand, population and solar latitude bounds and colour
// by potentialCell (map.js), which the map's fill and tooltips also use.
async function getPotentialViewState() {
    const base = await getPotentialOverlayState();
    if (!base || potentialTech === 'solar') return base;
    // Offshore capacity and every definition's numbers (onshore conservative too) are in this load.
    const ok = await ensureWindOffshorePotentialLoaded();
    if (!ok) return null;
    const metric = 'generation';
    const spec = {
        tech: potentialTech, level: base.level, latBounds: base.latBounds, metric,
        definition: potentialDefinition, offshoreLayer: potentialOffshoreLayer,
        windSites: windResourceMap, offshore: windOffshorePotential, multiple: Boolean(base.isMultiple)
    };
    let minVal = Infinity;
    let maxVal = -Infinity;
    let valueCount = 0;
    let noDataCount = 0;
    for (const row of base.data) {
        const cell = potentialCell(row, spec);
        if (cell.noData) { noDataCount += 1; continue; }
        if (!Number.isFinite(cell.value)) continue;
        valueCount += 1;
        if (cell.value < minVal) minVal = cell.value;
        if (cell.value > maxVal) maxVal = cell.value;
    }
    if (valueCount && !base.isMultiple && minVal === maxVal) maxVal = minVal + 1;
    return {
        ...base,
        tech: potentialTech, metric, definition: potentialDefinition, offshoreLayer: potentialOffshoreLayer,
        windSites: windResourceMap, offshore: windOffshorePotential,
        min: valueCount ? minVal : null, max: valueCount ? maxVal : null, valueCount, noDataCount
    };
}

async function updatePotentialView() {
    if (currentViewMode !== 'potential') return;
    const state = await getPotentialViewState();
    if (!state) return;
    if (currentViewMode !== 'potential') return;

    const { data, isMultiple, isPerCapita, min, max, demandMap, populationMap, latBounds, level, displayMode, valueCount } = state;
    const tech = state.tech || 'solar';
    syncPotentialToggleUI();
    if (legendPotentialBar) legendPotentialBar.style.background = '';

    if (!valueCount) {
        if (legendPotentialMin) legendPotentialMin.textContent = '--';
        if (legendPotentialMax) legendPotentialMax.textContent = '--';
        updatePotentialMap([], { level: potentialLevel });
        return;
    }

    // "× Demand" and "per capita" both colour by discrete buckets; "Total" uses the
    // continuous green gradient with numeric min/max.
    const usesBuckets = isMultiple || isPerCapita;
    const buckets = isPerCapita ? POTENTIAL_PER_CAPITA_BUCKETS : POTENTIAL_MULTIPLE_BUCKETS;
    const name = tech === 'solar' ? 'Solar' : potentialTechName(tech, potentialOffshoreLayer);
    if (legendPotentialTitle) {
        legendPotentialTitle.textContent = tech === 'solar'
            ? (isMultiple
                ? 'Solar Generation Potential / Electricity Demand Today (x multiple)'
                : isPerCapita
                    ? 'Solar Generation Potential per Capita (MWh / person / year)'
                    : 'Solar Generation Potential (TWh/yr)')
            : isMultiple
                ? `${name} potential / demand today (×)`
                : isPerCapita
                    ? `${name} potential per capita (MWh/person/yr)`
                    : `${name} potential (TWh/yr)`;
    }
    if (legendPotentialBar) {
        legendPotentialBar.classList.toggle('legend-gradient-potential', !usesBuckets);
        legendPotentialBar.classList.toggle('hidden', usesBuckets);
    }
    const swatch = (color, label) => `<div class=\"flex items-center gap-2\"><span class=\"w-3 h-3 rounded-sm\" style=\"background:${color}\"></span><span>${label}</span></div>`;
    // Wind cells without an estimate are black (no data); say why (solar's "Total" keeps no row).
    // T075: solar's black cells (outside the solar data's latitude bounds) had no row.
    const windNoDataLabel = tech === 'solar' ? (state.latBounds ? 'No data' : '')
        : !state.noDataCount ? ''
        : tech === 'offshore' ? 'No estimate (no sea, or no viable offshore site)'
            : 'No data';
    if (legendPotentialBuckets) {
        const showRows = usesBuckets || Boolean(windNoDataLabel);
        legendPotentialBuckets.classList.toggle('hidden', !showRows);
        if (usesBuckets) {
            const noData = swatch(NO_DATA_COLOR, windNoDataLabel ? 'No data or no estimate' : 'No data');
            const items = buckets.map(bucket => swatch(bucket.color, bucket.label));
            legendPotentialBuckets.innerHTML = `${items.join('')}${noData}`;
        } else if (showRows) {
            legendPotentialBuckets.innerHTML = swatch(NO_DATA_COLOR, windNoDataLabel);
        }
    }

    if (legendPotentialMin) {
        legendPotentialMin.textContent = usesBuckets ? '' : formatNumber(min, 2);
        legendPotentialMin.classList.toggle('hidden', usesBuckets);
    }
    // Offshore sea is assigned to the nearest cell, not by country (D-139 pointer to the modal).
    document.getElementById('legend-potential-country')?.classList.toggle('hidden', !(tech === 'offshore' || tech === 'all'));
    if (legendPotentialMax) {
        legendPotentialMax.textContent = usesBuckets ? '' : formatNumber(max, 2);
        legendPotentialMax.classList.toggle('hidden', usesBuckets);
    }

    updatePotentialMap(data, {
        level,
        min,
        max,
        displayMode,
        demandMap,
        populationMap,
        latBounds,
        tech,
        metric: state.metric || 'generation',
        definition: potentialDefinition,
        offshoreLayer: potentialOffshoreLayer,
        windSites: windResourceMap,
        offshore: windOffshorePotential
    });
}

function updateModel() {
    if (updateModel._queued) return;
    updateModel._queued = true;
    const run = () => {
        updateModel._queued = false;
        updateUI();
    };
    // requestAnimationFrame never fires while the tab is hidden, so a change made
    // just before switching away would otherwise be dropped. Fall back to a timer
    // in that case, and keep rAF when the page is visible so painting stays smooth.
    if (typeof document !== 'undefined' && document.hidden) {
        setTimeout(run, 0);
    } else {
        requestAnimationFrame(run);
    }
}

// Trailing-debounced updateModel for slider 'input' spam. The cheap DOM echo
// (number next to the slider) still runs immediately in handleSolarInput /
// handleBattInput; this only delays the heavy updateUI pass.
let _debouncedUpdateModelTimer = null;
function debouncedUpdateModel() {
    if (_debouncedUpdateModelTimer) clearTimeout(_debouncedUpdateModelTimer);
    _debouncedUpdateModelTimer = setTimeout(() => {
        _debouncedUpdateModelTimer = null;
        updateModel();
    }, 175);
}

// Start
init();

function buildElectricityMetrics(demandData, overlayMode, cfData, lcoeData, potentialState = null) {
    // Similar to population metrics but uses demandData (annual_demand_kwh) as weight
    const metrics = [];

    // Coordinate-based lookups (like map.js uses)
    const roundedKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cfByCoord = new Map();
    if (cfData) cfData.forEach(d => cfByCoord.set(roundedKey(d.latitude, d.longitude), d));
    const lcoeByCoord = new Map();
    if (lcoeData) lcoeData.forEach(d => lcoeByCoord.set(roundedKey(d.latitude, d.longitude), d));
    const potentialById = potentialState?.data ? new Map(potentialState.data.map(d => [d.location_id, d])) : null;
    const potentialByCoord = potentialState?.data ? new Map(potentialState.data.map(d => [roundedKey(d.latitude, d.longitude), d])) : null;

    demandData.forEach(d => {
        if (!d.annual_demand_kwh || d.annual_demand_kwh <= 0) return;

        const key = roundedKey(d.latitude, d.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);
        const potentialRow = potentialById?.get(d.location_id) || potentialByCoord?.get(key);

        let metricVal = null;
        let meetsTarget = false;

        if (overlayMode === 'cf' && cfRow) {
            metricVal = cfRow.annual_cf;
            meetsTarget = true;
        } else if (overlayMode === 'lcoe' && lcoeRow) {
            metricVal = lcoeRow.lcoe;
            meetsTarget = true;
        } else if (overlayMode === 'potential') {
            metricVal = getPotentialMetricFromRow(potentialRow, potentialState);
            meetsTarget = Number.isFinite(metricVal);
        } else if (overlayMode === 'none') {
            // When no overlay, use demand itself as the "metric" for charting distribution
            // Convert to TWh for display consistency
            metricVal = d.annual_demand_kwh / 1e9; // TWh
            meetsTarget = true;
        }

        if (metricVal !== null) {
            metrics.push({
                location_id: d.location_id,
                latitude: d.latitude,
                longitude: d.longitude,
                pop: d.annual_demand_kwh, // Original kWh for weighting
                weight: d.annual_demand_kwh / 1e9, // TWh for histogram weighting
                metric: metricVal,
                meetsTarget
            });
        }
    });

    return metrics;
}

function applyAccessMetric(metric) {
    accessMetric = metric;
    setAccessMetric(metric);
}

// Access Toggle Logic
document.addEventListener('DOMContentLoaded', () => {
    const btnRel = document.getElementById('btn-access-rel');
    const btnNone = document.getElementById('btn-access-none');
    const legendBar = document.getElementById('legend-access-bar');
    const legendTitle = document.getElementById('legend-access-title');
    const legendMin = document.getElementById('legend-access-min');
    const legendMid = document.getElementById('legend-access-mid');
    const legendMax = document.getElementById('legend-access-max');
    const legendNote = document.getElementById('legend-access-note');

    if (btnRel && btnNone) {
        btnRel.addEventListener('click', () => {
            applyAccessMetric('reliability');

            // Update UI
            btnRel.classList.add('is-active');
            btnNone.classList.remove('is-active');

            // Gradient: green ramp, more reliable = lighter
            if (legendBar) {
                legendBar.style.background = 'var(--ramp-green)';
            }
            if (legendTitle) legendTitle.textContent = 'Grid Reliability';
            if (legendMin) legendMin.textContent = '0%';
            if (legendMid) legendMid.textContent = '';
            if (legendMax) legendMax.textContent = '100%';
            document.getElementById('legend-access-universal')?.classList.add('hidden');

            // Force update
            if (currentViewMode === 'population') {
                updatePopulationView();
            }
        });

        btnNone.addEventListener('click', () => {
            applyAccessMetric('no_access_pop');

            // Update UI
            btnNone.classList.add('is-active');
            btnRel.classList.remove('is-active');

            // Gradient: orange ramp (log), more people without access = brighter
            if (legendBar) {
                legendBar.style.background = 'var(--ramp-no-access)';
            }
            if (legendTitle) legendTitle.textContent = 'Population Without Access';
            if (legendMin) legendMin.textContent = 'Low';
            if (legendMid) legendMid.textContent = '';
            if (legendMax) legendMax.textContent = 'High';
            document.getElementById('legend-access-universal')?.classList.remove('hidden');

            // Force update
            if (currentViewMode === 'population') {
                updatePopulationView();
            }
        });
    }
});
