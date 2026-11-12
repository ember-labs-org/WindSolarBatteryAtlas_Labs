// Initialize WASM
let wasmModule = null;
const DIESEL_DATA_VERSION = '2026-04-22-retail';
const GAS_DATA_VERSION = '2026-06-09-igu2024';

// `source`, if given, is the module's bytes, fetched by whoever started this
// thread (see decodeSliceInLoader); otherwise it is fetched here.
function initWasm(source = null) {
    if (!wasmModule) {
        wasmModule = (async () => {
            console.log("Initializing Parquet-Wasm...");
            const wasm = await import('./parquet_wasm.js');
            await wasm.default(source ? { module_or_path: source } : undefined);
            console.log("Parquet-Wasm initialized.");
            return wasm;
        })();
        wasmModule.catch(() => { wasmModule = null; });
    }
    return wasmModule;
}

// ---------------------------------------------------------------------------
// Configuration manifest and summary slices
//
// The atlas now has three capacity axes (solar, wind, battery) and two wind
// surfaces (onshore, offshore): 3,216 configurations in all. Loading every one
// as row objects, the way the two-axis version did, would mean ~16 million
// objects on the boot thread. So the summary is split into one Parquet file per
// wind level, and row objects are built only for the slice the user is actually
// looking at. Every existing code path that expects rows keeps working, at the
// same cost as before.
// ---------------------------------------------------------------------------

let CONFIG_MANIFEST = null;

export async function loadConfigManifest() {
    if (CONFIG_MANIFEST) return CONFIG_MANIFEST;
    const response = await fetch('data/configs.json');
    if (!response.ok) throw new Error('configs.json not found');
    const manifest = await response.json();

    const bySlice = new Map();
    const byKey = new Map();
    manifest.configs.forEach((c) => {
        if (!bySlice.has(c.summary)) bySlice.set(c.summary, []);
        bySlice.get(c.summary).push(c);
        byKey.set(configKey(c.surface, c.solar, c.wind, c.batt), c);
    });

    const windLevels = [...new Set(manifest.configs.map(c => c.wind))].sort((a, b) => a - b);
    const surfaces = [...new Set(manifest.configs.map(c => c.surface))];

    // Which combinations were actually simulated, so a slider can never land on
    // a configuration that does not exist.
    const validFor = new Map();
    manifest.configs.forEach((c) => {
        const k = `${c.wind === 0 ? 'on' : c.surface}|${c.wind}`;
        if (!validFor.has(k)) validFor.set(k, { solars: new Set(), batts: new Set(), bySolar: new Map() });
        const v = validFor.get(k);
        v.solars.add(c.solar);
        v.batts.add(c.batt);
        if (!v.bySolar.has(c.solar)) v.bySolar.set(c.solar, new Set());
        v.bySolar.get(c.solar).add(c.batt);
    });
    validFor.forEach((v) => {
        v.solarList = [...v.solars].sort((a, b) => a - b);
        v.battList = [...v.batts].sort((a, b) => a - b);
        v.battBySolar = new Map();
        v.bySolar.forEach((set, solar) => v.battBySolar.set(solar, [...set].sort((a, b) => a - b)));
    });

    CONFIG_MANIFEST = { ...manifest, bySlice, byKey, windLevels, surfaces, validFor };
    return CONFIG_MANIFEST;
}

export function configKey(surface, solar, wind, batt) {
    // With no wind the surface is meaningless, so collapse it. This keeps the
    // wind = 0 slice identical to the original solar + battery atlas.
    const s = wind === 0 ? 'on' : surface;
    return `${s}|${solar}|${wind}|${batt}`;
}

export function summaryFileFor(surface, wind) {
    if (wind === 0) return 'summary_w0.parquet';
    return `summary_${surface === 'on' ? 'w' : 'wo'}${wind}.parquet`;
}

// Only the slice on screen is kept, as columns (about 33 MB for the largest).
// Row objects are made by app.js for the rows something actually reads, not for
// all 1.4 million rows of a slice.
const SLICE_CACHE = new Map();
// Two while the capacity map shows a combined onshore + offshore build (T058),
// which draws regions with one kind of wind site from that surface's slice.
let SLICE_CACHE_MAX = 1;
export function setSliceCacheMax(n) {
    SLICE_CACHE_MAX = n;
    while (SLICE_CACHE.size > SLICE_CACHE_MAX) SLICE_CACHE.delete(SLICE_CACHE.keys().next().value);
}
const SLICE_LOADS = new Map();      // file -> in-flight load, so one decode serves all callers

// Data files sit beside js/. Paths are relative to the page; in the LCOE worker
// there is no page, so they resolve from this module's URL instead.
const DATA_BASE = typeof document === 'undefined' ? new URL('../data/', import.meta.url).href : 'data/';

/** A data file's bytes, or null when the server has no such file. */
function fetchDataFile(file) {
    return fetch(`${DATA_BASE}${file}`).then(r => (r.ok ? r.arrayBuffer() : null));
}

// The full-grid load (T094) keeps this many files downloading ahead of the one
// it is decoding, so the network and the decode overlap. Files are still taken,
// decoded and filled one at a time in the same order, so results are unchanged.
const FETCH_AHEAD = 3;

/**
 * Fetch `files` in order, keeping up to `ahead` of them fetched or in flight
 * that nobody has taken yet; taking one starts the next. take(file) returns
 * that file's bytes (or null if missing); a file not in the list is fetched
 * then and there.
 */
export function fetchAhead(files, ahead = FETCH_AHEAD) {
    const waiting = new Map();
    let next = 0;
    const fill = () => {
        while (next < files.length && waiting.size < ahead) {
            const file = files[next++];
            if (waiting.has(file)) continue;
            const p = fetchDataFile(file);
            p.catch(() => {});   // a failure surfaces when the file is taken
            waiting.set(file, p);
        }
    };
    fill();
    return {
        take(file) {
            const p = waiting.get(file) || fetchDataFile(file);
            waiting.delete(file);
            fill();
            return p;
        }
    };
}

/** Read one slice's columns as typed arrays; no per-row objects. `columns`
 *  limits the decode to those columns (the others come back null). `bytes`, if
 *  given, is the file's fetch already under way (fetchAhead). */
async function readSliceColumns(file, columns = null, wasmSource = null, bytes = null) {
    const bufferPromise = (bytes || fetchDataFile(file)).then(buffer => {
        if (!buffer) throw new Error(`summary slice not found: ${file}`);
        return buffer;
    });
    bufferPromise.catch(() => {});
    const wasm = await initWasm(wasmSource);
    const buffer = await bufferPromise;
    const wasmTable = wasm.readParquet(new Uint8Array(buffer), columns ? { columns } : null);
    const { tableFromIPC } = await import('./apache-arrow.js');
    const t = tableFromIPC(wasmTable.intoIPCStream());
    const col = name => t.getChild(name)?.toArray() ?? null;
    return {
        n: t.numRows,
        id: col('location_id'),
        lat: col('latitude'),
        lon: col('longitude'),
        solar: col('solar_gw'),
        wind: col('wind_gw'),
        batt: col('batt_gwh'),
        cf: col('annual_cf'),
        curt: col('curtailed_share'),
    };
}

export const SLICE_KEYS = ['id', 'lat', 'lon', 'solar', 'wind', 'batt', 'cf', 'curt'];

/**
 * One whole slice as columns that each own their buffer, so they can be
 * transferred between threads. Ids are plain numbers (a 64-bit id column comes
 * back as a Float64Array of Number(id), the value rows always carried).
 */
export async function decodeSummarySlice(file, wasmSource = null) {
    const c = await readSliceColumns(file, null, wasmSource);
    const out = { n: c.n };
    const owned = new Set();
    for (const key of SLICE_KEYS) {
        let a = c[key];
        if (a && key === 'id' && (a instanceof BigInt64Array || a instanceof BigUint64Array)) {
            a = Float64Array.from(a, Number);
        } else if (a && (a.byteOffset !== 0 || a.byteLength !== a.buffer.byteLength || owned.has(a.buffer))) {
            a = a.slice();
        }
        if (a) owned.add(a.buffer);
        out[key] = a;
    }
    return out;
}

// Decode in a short-lived loader worker (the LCOE worker module started with
// ?load): parquet-wasm memory never shrinks, so the thread that decodes keeps
// ~140 MB for good, and the decode itself is a long task. The worker is closed
// once the columns are handed over. Without nested workers, or if the loader
// cannot start, the slice is decoded here. The page fetches the wasm bytes for
// the loader, so index.html's preload of them is used rather than wasted.
const WASM_URL = new URL('./parquet_wasm_bg.wasm', import.meta.url).href;
// A loader that has said nothing by then (normally 1-2 s) is given up and the
// slice decoded here instead. Long enough for a slow fetch of the ~4 MB slice.
const SLICE_LOADER_TIMEOUT_MS = 60000;
function decodeSliceInLoader(file) {
    let loader = null;
    try {
        loader = new Worker(new URL('./workers/lcoe-worker.js?load', import.meta.url), { type: 'module' });
    } catch (_) { /* no module workers: decode here */ }
    if (!loader) return decodeSummarySlice(file);
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = () => {
            if (settled) return false;
            settled = true;
            clearTimeout(timer);
            loader.terminate();
            return true;
        };
        const timer = setTimeout(() => {
            if (settle()) decodeSummarySlice(file).then(resolve, reject);
        }, SLICE_LOADER_TIMEOUT_MS);
        loader.onmessage = (event) => {
            if (!settle()) return;
            const { type, payload } = event.data || {};
            if (type === 'RESULT') resolve(payload);
            else reject(new Error(payload?.message || `slice loader failed: ${file}`));
        };
        loader.onerror = (event) => {
            event.preventDefault();
            // The loader only ever answers once, so an error means it never did.
            if (settle()) decodeSummarySlice(file).then(resolve, reject);
        };
        fetch(WASM_URL)
            .then(r => (r.ok ? r.arrayBuffer() : null))
            .catch(() => null)
            .then((wasm) => loader.postMessage({ type: 'LOAD_SLICE', file, wasm }, wasm ? [wasm] : []));
    });
}

/**
 * Load one summary slice as columns: { file, n, surface, id, lat, lon, solar,
 * wind, batt, cf, curt }, where `surface` is the wind surface its rows carry.
 * `offThread: false` decodes on this thread (the ?worker=0 fallback).
 */
export async function loadSummarySlice(surface, wind, { offThread = true } = {}) {
    const file = summaryFileFor(surface, wind);
    if (SLICE_CACHE.has(file)) return SLICE_CACHE.get(file);
    if (SLICE_LOADS.has(file)) return SLICE_LOADS.get(file);
    const load = (async () => {
        try {
            const useLoader = offThread && typeof document !== 'undefined' && typeof Worker !== 'undefined';
            const cols = await (useLoader ? decodeSliceInLoader(file) : decodeSummarySlice(file));
            const slice = { file, surface: wind === 0 ? 'on' : surface, ...cols };
            SLICE_CACHE.set(file, slice);
            while (SLICE_CACHE.size > SLICE_CACHE_MAX) {
                SLICE_CACHE.delete(SLICE_CACHE.keys().next().value);
            }
            return slice;
        } catch (e) {
            console.error(`Error loading ${file}:`, e);
            throw e;
        } finally {
            SLICE_LOADS.delete(file);
        }
    })();
    SLICE_LOADS.set(file, load);
    return load;
}

const MATRIX_COLUMNS = ['location_id', 'solar_gw', 'wind_gw', 'batt_gwh', 'annual_cf'];

/**
 * Flat capacity-factor matrix over every configuration, indexed
 * [locationIndex * nConfigs + config.i], with each config's capacities. The LCOE
 * worker builds it for itself; the main thread builds it only when there is no
 * worker. `configs` is the manifest's config list; `locationIds` (ascending)
 * fixes the row order. `fetcher` (gridFetcher) fetches the slices ahead; by
 * default they are fetched three ahead on their own.
 */
export async function loadCfMatrix(configs, locationIds, onProgress, fetcher = null) {
    const locIndex = new Map();
    locationIds.forEach((id, i) => locIndex.set(id, i));
    const nLoc = locationIds.length;
    const nCfg = configs.length;
    const cf = new Float32Array(nLoc * nCfg);
    const solarGw = new Int8Array(nCfg);
    const windGw = new Int8Array(nCfg);
    const battGwh = new Int8Array(nCfg);
    const surfaceOff = new Uint8Array(nCfg);
    const bySlice = new Map();
    configs.forEach((c) => {
        solarGw[c.i] = c.solar;
        windGw[c.i] = c.wind;
        battGwh[c.i] = c.batt;
        surfaceOff[c.i] = (c.wind > 0 && c.surface === 'off') ? 1 : 0;
        if (!bySlice.has(c.summary)) bySlice.set(c.summary, []);
        bySlice.get(c.summary).push(c);
    });

    const slices = [...bySlice.keys()];
    fetcher = fetcher || fetchAhead(slices);
    for (let si = 0; si < slices.length; si++) {
        const file = slices[si];
        const cfgs = bySlice.get(file);
        // Columns straight into the matrix: no row objects for the slices that
        // are not on screen. Cuts the build from about a minute to seconds and
        // keeps memory flat.
        const c = await readSliceColumns(file, MATRIX_COLUMNS, null, fetcher.take(file));
        const idxByTriple = new Map();
        cfgs.forEach(cfg => idxByTriple.set((cfg.solar << 16) | (cfg.wind << 8) | cfg.batt, cfg.i));
        for (let r = 0; r < c.n; r++) {
            const li = locIndex.get(Number(c.id[r]));
            if (li === undefined) continue;
            const ci = idxByTriple.get((c.solar[r] << 16) | (c.wind[r] << 8) | c.batt[r]);
            if (ci === undefined) continue;
            cf[li * nCfg + ci] = c.cf[r];
        }
        if (onProgress) onProgress(si + 1, slices.length, file);
        // Let the UI (or the worker's message queue) breathe between slices.
        await new Promise(res => setTimeout(res, 0));
    }
    return {
        cf, nLoc, nCfg, solarGw, windGw, battGwh, surfaceOff,
        locationIds: Int32Array.from(locationIds)
    };
}

// ---------------------------------------------------------------------------
// Sparse add-on builds (T058): addon.json and its two parquet files. The
// manifest is optional: without it (or with ?addon=0) nothing here runs and the
// atlas is exactly as before. Each file is checked against the SHA-256 in the
// manifest before it is used; a mismatch throws and the add-on is not used.
// ---------------------------------------------------------------------------

const ADDON_COLUMNS = ['location_id', 'cfg', 'annual_cf', 'curtailed_share'];

/** addon.json, or null where there is none (a 404 is the normal case without the add-on). */
export async function loadAddonManifest(file = 'addon.json') {
    let response;
    try {
        response = await fetch(`${DATA_BASE}${file}`);
    } catch (_) {
        return null;
    }
    if (!response.ok) return null;
    const manifest = await response.json();
    if (manifest?.version !== 1 || !Array.isArray(manifest.sets)) {
        throw new Error(`${file}: unsupported add-on manifest`);
    }
    return manifest;
}

async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** One add-on file's columns, after its SHA-256 has been checked against the
 *  manifest. `bytes`, if given, is the file's fetch already under way. */
async function readAddonColumns(set, wasmSource = null, bytes = null) {
    const buffer = await (bytes || fetchDataFile(set.file));
    if (!buffer) throw new Error(`add-on file not found: ${set.file}`);
    const sha = await sha256Hex(buffer);
    if (sha !== set.sha256) {
        throw new Error(`add-on file ${set.file}: SHA-256 ${sha} does not match addon.json (${set.sha256}); the add-on is not used`);
    }
    const wasm = await initWasm(wasmSource);
    const wasmTable = wasm.readParquet(new Uint8Array(buffer), { columns: ADDON_COLUMNS });
    const { tableFromIPC } = await import('./apache-arrow.js');
    const t = tableFromIPC(wasmTable.intoIPCStream());
    const col = name => t.getChild(name)?.toArray() ?? null;
    const cols = {};
    for (const name of ADDON_COLUMNS) cols[name] = col(name);
    if (!cols.location_id || !cols.cfg || !cols.annual_cf) throw new Error(`add-on file ${set.file}: missing columns`);
    return cols;
}

/** The add-on sets loadAddon reads, in the order it reads them. */
function addonSetsToLoad(manifest, setIds = null) {
    return manifest.sets.filter(set => (!setIds || setIds.includes(set.id))
        && (set.id === 'wind_mix' || set.id === 'large'));
}

/**
 * One fetchAhead over everything the full-grid load reads, in the order it reads
 * it: the summary slices, then the add-on files (`addon` is LOAD_MATRIX's
 * { manifest, sets }), so the add-on downloads while the last slices decode.
 */
export function gridFetcher(configs, addon = null) {
    const files = [...new Set(configs.map(c => c.summary))];
    if (addon?.manifest && typeof addon.manifest === 'object') {
        files.push(...addonSetsToLoad(addon.manifest, addon.sets || null).map(set => set.file));
    }
    return fetchAhead(files);
}

/**
 * The add-on as CSRs over `locationIds` (the matrix's location order), one per
 * set: { sets: { wind_mix: {...}, large: {...} } } (addon.js). `manifest` is
 * addon.json (parsed, or its file name); `setIds` limits the sets loaded.
 * `fetcher` (gridFetcher), if given, supplies files already being fetched.
 */
export async function loadAddon(manifest, locationIds, setIds = null, wasmSource = null, fetcher = null) {
    const { buildAddonCsr, addonConfigArrays } = await import('./addon.js');
    if (typeof manifest === 'string') manifest = await loadAddonManifest(manifest);
    if (!manifest) return null;
    const ids = Array.from(locationIds, Number);
    const sets = {};
    for (const set of addonSetsToLoad(manifest, setIds)) {
        const cols = await readAddonColumns(set, wasmSource, fetcher ? fetcher.take(set.file) : null);
        const csr = buildAddonCsr(set, cols, ids);
        const cfg = addonConfigArrays(set);
        sets[set.id] = { id: set.id, ...csr, ...cfg, guard: set.guard ?? null, start: set.start ?? null };
    }
    return { sets };
}

/**
 * The rows of one combined wind build (onshore `on` + offshore `off`) from the
 * wind_mix file, as columns { n, id, solar, batt, cf, curt } in file order (by
 * config, then location): what the capacity map draws with both sliders up.
 */
export async function decodeAddonPair(manifest, on, off, wasmSource = null) {
    const set = manifest.sets.find(s => s.id === 'wind_mix');
    if (!set) throw new Error('addon.json has no wind_mix set');
    const want = new Map();
    set.configs.forEach(c => { if (c.on === on && c.off === off) want.set(c.j, c); });
    if (!want.size) throw new Error(`no combined build onshore ${on} + offshore ${off}`);
    const cols = await readAddonColumns(set, wasmSource);
    const n = cols.cfg.length;
    let count = 0;
    for (let r = 0; r < n; r++) if (want.has(cols.cfg[r])) count++;
    const out = {
        n: count, on, off,
        id: new Float64Array(count), solar: new Float64Array(count), batt: new Float64Array(count),
        cf: new Float32Array(count), curt: new Float32Array(count)
    };
    let k = 0;
    for (let r = 0; r < n; r++) {
        const c = want.get(cols.cfg[r]);
        if (!c) continue;
        out.id[k] = Number(cols.location_id[r]);
        out.solar[k] = c.solar;
        out.batt[k] = c.batt;
        out.cf[k] = cols.annual_cf[r];
        out.curt[k] = cols.curtailed_share ? cols.curtailed_share[r] : 0;
        k++;
    }
    return out;
}

export const ADDON_PAIR_KEYS = ['id', 'solar', 'batt', 'cf', 'curt'];

/** decodeAddonPair in a short-lived loader worker (as summary slices are), or here. */
export function loadAddonPair(manifest, on, off, { offThread = true } = {}) {
    const useLoader = offThread && typeof document !== 'undefined' && typeof Worker !== 'undefined';
    if (!useLoader) return decodeAddonPair(manifest, on, off);
    let loader = null;
    try {
        loader = new Worker(new URL('./workers/lcoe-worker.js?load', import.meta.url), { type: 'module' });
    } catch (_) { /* no module workers: decode here */ }
    if (!loader) return decodeAddonPair(manifest, on, off);
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = () => {
            if (settled) return false;
            settled = true;
            loader.terminate();
            return true;
        };
        loader.onmessage = (event) => {
            if (!settle()) return;
            const { type, payload } = event.data || {};
            if (type === 'RESULT') resolve(payload);
            else reject(new Error(payload?.message || 'add-on loader failed'));
        };
        loader.onerror = (event) => {
            event.preventDefault();
            if (settle()) decodeAddonPair(manifest, on, off).then(resolve, reject);
        };
        fetch(WASM_URL)
            .then(r => (r.ok ? r.arrayBuffer() : null))
            .catch(() => null)
            .then((wasm) => loader.postMessage({ type: 'LOAD_ADDON_PAIR', manifest, on, off, wasm }, wasm ? [wasm] : []));
    });
}

/** Per-cell wind resource: siting result, viability and the delivered capacity factor. */
export async function loadWindResourceCsv() {
    const response = await fetch('data/voronoi_wind_resource.csv');
    if (!response.ok) return [];
    const rows = parseCsv(await response.text());
    return rows.map((d) => ({
        location_id: +d.location_id,
        latitude: +d.latitude,
        longitude: +d.longitude,
        on_viable: +d.on_viable === 1,
        off_viable: +d.off_viable === 1,
        on_final_cf: parseOptionalNumber(d.on_final_cf),
        off_final_cf: parseOptionalNumber(d.off_final_cf),
        on_cf_p50: parseOptionalNumber(d.on_cf_p50),
        on_cf_p90: parseOptionalNumber(d.on_cf_p90),
        off_cf_p90: parseOptionalNumber(d.off_cf_p90),
        centre_cf: parseOptionalNumber(d.centre_cf),
        on_room_gw: parseOptionalNumber(d.on_room_gw),
        on_viable_area_km2: parseOptionalNumber(d.on_viable_area_km2),
        off_room_gw: parseOptionalNumber(d.off_room_gw),
        on_site_lat: parseOptionalNumber(d.on_site_lat),
        on_site_lon: parseOptionalNumber(d.on_site_lon),
        off_site_lat: parseOptionalNumber(d.off_site_lat),
        off_site_lon: parseOptionalNumber(d.off_site_lon),
        on_site_iec_class: parseOptionalNumber(d.on_site_iec_class),
        on_k: parseOptionalNumber(d.on_k),
        off_k: parseOptionalNumber(d.off_k),
    }));
}

/**
 * Offshore wind technical potential per cell: World Bank/ESMAP polygons
 * intersected with the atlas's cells (T031, scripts/wind_potential/). Same row
 * order as voronoi_pvout_potential.csv. GW and km², fixed-bottom (0–50 m) and
 * floating (50–1,000 m). Loaded only when the Potential map shows wind.
 */
export async function loadWindOffshorePotentialCsv() {
    const response = await fetch('data/voronoi_wind_potential_offshore.csv');
    if (!response.ok) {
        throw new Error('Offshore wind potential CSV not found at data/voronoi_wind_potential_offshore.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(d => ({
        location_id: Number(d.location_id),
        fixed_gw: Number(d.fixed_gw) || 0,
        fixed_area_km2: Number(d.fixed_area_km2) || 0,
        floating_gw: Number(d.floating_gw) || 0,
        floating_area_km2: Number(d.floating_area_km2) || 0
    }));
}

/**
 * Wind potential by definition per cell (T083, pipeline/scripts/pipeline/wind/t083/potential_defs.py):
 * onshore conservative (T078), offshore on the World Bank/ESMAP and IEA definitions, fixed-bottom
 * and floating, GW and TWh/yr. An empty TWh means capacity without an estimate (null).
 */
export async function loadWindPotentialDefsCsv() {
    const response = await fetch('data/voronoi_wind_potential_defs.csv');
    if (!response.ok) {
        throw new Error('Wind potential definitions CSV not found at data/voronoi_wind_potential_defs.csv');
    }
    const rows = parseCsv(await response.text());
    const cols = ['on_cons_gw', 'on_cons_twh', 'on_tech_gw', 'on_tech_twh', 'fix_esmap_gw', 'fix_esmap_twh', 'fl_esmap_gw', 'fl_esmap_twh',
        'fix_iea_gw', 'fix_iea_twh', 'fl_iea_gw', 'fl_iea_twh'];
    return rows.map(d => {
        const out = { location_id: Number(d.location_id) };
        for (const c of cols) out[c] = parseOptionalNumber(d[c]);
        return out;
    });
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        const next = text[i + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                value += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === ',' && !inQuotes) {
            row.push(value);
            value = '';
            continue;
        }

        if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && next === '\n') {
                i += 1;
            }
            row.push(value);
            if (row.some(cell => cell !== '')) {
                rows.push(row);
            }
            row = [];
            value = '';
            continue;
        }

        value += char;
    }

    if (value !== '' || row.length) {
        row.push(value);
        if (row.some(cell => cell !== '')) {
            rows.push(row);
        }
    }

    const [header, ...dataRows] = rows;
    if (!header) return [];

    return dataRows.map(parts => {
        const out = {};
        header.forEach((col, idx) => {
            out[col] = parts[idx] ?? '';
        });
        return out;
    });
}

function parseOptionalNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

export async function loadPopulationCsv() {
    const response = await fetch('data/voronoi_population_2020.csv');
    if (!response.ok) {
        throw new Error('Population CSV not found at data/voronoi_population_2020.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        population_2020: Number(row.population_2020)
    }));
}

export async function loadGemPlantsCsv() {
    const response = await fetch('data/gem_plants.csv');
    if (!response.ok) {
        throw new Error('GEM plants CSV not found at data/gem_plants.csv');
    }
    const rows = parseCsv(await response.text());
    return rows
        .map(row => ({
            plant_name: row.plant_name || '',
            country: row.country || '',
            fuel_group: (row.fuel_group || '').toLowerCase(),
            capacity_mw: Number(row.capacity_mw),
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
            status: (row.status || 'existing').toLowerCase()
        }))
        .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}

export async function loadVoronoiGemCapacityCsv() {
    const response = await fetch('data/voronoi_gem_capacity.csv');
    if (!response.ok) {
        throw new Error('Voronoi fossil capacity CSV not found at data/voronoi_gem_capacity.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        coal_Announced: Number(row.coal_Announced) || 0,
        coal_Existing: Number(row.coal_Existing) || 0,
        oil_gas_Announced: Number(row.oil_gas_Announced) || 0,
        oil_gas_Existing: Number(row.oil_gas_Existing) || 0,
        bioenergy_Announced: Number(row.bioenergy_Announced) || 0,
        bioenergy_Existing: Number(row.bioenergy_Existing) || 0,
        nuclear_Announced: Number(row.nuclear_Announced) || 0,
        nuclear_Existing: Number(row.nuclear_Existing) || 0
    }));
}

export async function loadVoronoiWaccCsv() {
    const response = await fetch('data/voronoi_wacc.csv');
    if (!response.ok) {
        throw new Error('Voronoi WACC CSV not found at data/voronoi_wacc.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        country_iso3: row.country_iso3 || null,
        country_name: row.country_name || null,
        wacc_iso3: row.wacc_iso3 || null,
        wacc_country: row.wacc_country || null,
        wacc_percent: Number(row.wacc_percent),
        wacc_year: row.wacc_year ? Number(row.wacc_year) : null,
        source: row.source || null,
        distance_km: Number(row.distance_km)
    }));
}

export async function loadVoronoiLocalCapexCsv() {
    const response = await fetch('data/voronoi_local_capex.csv');
    if (!response.ok) {
        throw new Error('Voronoi local capex CSV not found at data/voronoi_local_capex.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        country_iso3: row.country_iso3 || null,
        country_name: row.country_name || null,
        region: row.region || null,
        region_method: row.region_method || null,
        capex_source: row.capex_source || null,
        solar_2024: Number(row.solar_2024),
        solar_2035: Number(row.solar_2035),
        solar_2050: Number(row.solar_2050),
        battery_2024: Number(row.battery_2024),
        battery_2035: Number(row.battery_2035),
        battery_2050: Number(row.battery_2050),
        wind_on_2024: parseOptionalNumber(row.wind_on_2024),
        wind_on_2035: parseOptionalNumber(row.wind_on_2035),
        wind_on_2050: parseOptionalNumber(row.wind_on_2050),
        wind_off_2024: parseOptionalNumber(row.wind_off_2024),
        wind_off_2035: parseOptionalNumber(row.wind_off_2035),
        wind_off_2050: parseOptionalNumber(row.wind_off_2050),
        // T024's offshore site class and the fixed-bottom and floating costs at
        // the cell's site; wind O&M in $/kW/yr (T025 reads these in local mode).
        wind_off_class: row.wind_off_class || null,
        wind_off_fixed_2024: parseOptionalNumber(row.wind_off_fixed_2024),
        wind_off_fixed_2035: parseOptionalNumber(row.wind_off_fixed_2035),
        wind_off_fixed_2050: parseOptionalNumber(row.wind_off_fixed_2050),
        wind_off_float_2024: parseOptionalNumber(row.wind_off_float_2024),
        wind_off_float_2035: parseOptionalNumber(row.wind_off_float_2035),
        wind_off_float_2050: parseOptionalNumber(row.wind_off_float_2050),
        wind_on_om_2024: parseOptionalNumber(row.wind_on_om_2024),
        wind_on_om_2035: parseOptionalNumber(row.wind_on_om_2035),
        wind_on_om_2050: parseOptionalNumber(row.wind_on_om_2050),
        wind_off_fixed_om_2024: parseOptionalNumber(row.wind_off_fixed_om_2024),
        wind_off_fixed_om_2035: parseOptionalNumber(row.wind_off_fixed_om_2035),
        wind_off_fixed_om_2050: parseOptionalNumber(row.wind_off_fixed_om_2050),
        wind_off_float_om_2024: parseOptionalNumber(row.wind_off_float_om_2024),
        wind_off_float_om_2035: parseOptionalNumber(row.wind_off_float_om_2035),
        wind_off_float_om_2050: parseOptionalNumber(row.wind_off_float_om_2050),
        // T082: generator-only fixed-bottom capex, and 1 where the grid operator owns the export link
        wind_off_fixed_gen_2024: parseOptionalNumber(row.wind_off_fixed_gen_2024),
        wind_off_fixed_gen_2035: parseOptionalNumber(row.wind_off_fixed_gen_2035),
        wind_off_fixed_gen_2050: parseOptionalNumber(row.wind_off_fixed_gen_2050),
        wind_off_tso: Number(row.wind_off_tso) === 1
    }));
}

/**
 * Wind cost of capital per cell. Onshore and offshore are carried separately.
 * Values are Hatton et al. v3 (2025, real rates) by country; the offshore figure
 * is for the cell's site class (fixed or floating). Built by
 * scripts/wind_costs/build_wind_costs.py, with the source of each row in the
 * file's wind_wacc_source column.
 */
export async function loadVoronoiWindWaccCsv() {
    const response = await fetch('data/voronoi_wacc_wind.csv');
    if (!response.ok) return [];
    return parseCsv(await response.text()).map(row => ({
        location_id: Number(row.location_id),
        wind_on_wacc_percent: parseOptionalNumber(row.wind_on_wacc_percent),
        wind_off_wacc_percent: parseOptionalNumber(row.wind_off_wacc_percent),
        wind_wacc_source: row.wind_wacc_source || null,
        wind_off_class: row.wind_off_class || null,
        wind_off_fixed_wacc_percent: parseOptionalNumber(row.wind_off_fixed_wacc_percent),
        wind_off_float_wacc_percent: parseOptionalNumber(row.wind_off_float_wacc_percent)
    }));
}

export async function loadVoronoiOverlappingCountriesCsv() {
    const response = await fetch('data/voronoi_overlapping_countries.csv');
    if (!response.ok) {
        throw new Error('Voronoi overlapping-countries CSV not found at data/voronoi_overlapping_countries.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        country_names: row.country_names ? row.country_names.split('|') : []
    }));
}

export async function loadVoronoiDieselCsv() {
    const response = await fetch(`data/voronoi_diesel_prices.csv?v=${DIESEL_DATA_VERSION}`);
    if (!response.ok) {
        throw new Error('Voronoi diesel CSV not found at data/voronoi_diesel_prices.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        country_iso3: row.country_iso3 || null,
        country_name: row.country_name || null,
        diesel_2024_iso3: row.diesel_2024_iso3 || null,
        diesel_2024_country: row.diesel_2024_country || null,
        diesel_2024_usd_per_liter_avg: parseOptionalNumber(row.diesel_2024_usd_per_liter_avg),
        diesel_2024_months_observed: parseOptionalNumber(row.diesel_2024_months_observed),
        diesel_2024_series_name: row.diesel_2024_series_name || null,
        diesel_2024_selection_method: row.diesel_2024_selection_method || null,
        diesel_2025_usd_per_liter_avg: parseOptionalNumber(row.diesel_2025_usd_per_liter_avg),
        diesel_2025_iso3: row.diesel_2025_iso3 || null,
        diesel_2025_country: row.diesel_2025_country || null,
        diesel_2025_months_observed: parseOptionalNumber(row.diesel_2025_months_observed),
        diesel_2025_series_name: row.diesel_2025_series_name || null,
        diesel_2025_selection_method: row.diesel_2025_selection_method || null,
        diesel_2024_source: row.diesel_2024_source || null,
        diesel_2025_source: row.diesel_2025_source || null,
        diesel_2024_distance_km: parseOptionalNumber(row.diesel_2024_distance_km),
        diesel_2025_distance_km: parseOptionalNumber(row.diesel_2025_distance_km)
    }));
}

export async function loadVoronoiGasCsv() {
    const response = await fetch(`data/voronoi_gas_prices.csv?v=${GAS_DATA_VERSION}`);
    if (!response.ok) {
        throw new Error('Voronoi gas CSV not found at data/voronoi_gas_prices.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        country_iso3: row.country_iso3 || null,
        country_name: row.country_name || null,
        gas_2024_iso3: row.gas_2024_iso3 || null,
        gas_2024_country: row.gas_2024_country || null,
        gas_2024_usd_per_mmbtu: parseOptionalNumber(row.gas_2024_usd_per_mmbtu),
        gas_2024_source: row.gas_2024_source || null,
        gas_2024_distance_km: parseOptionalNumber(row.gas_2024_distance_km),
        gas_available: String(row.gas_available).trim().toLowerCase() === 'true'
    }));
}

export async function loadPvoutPotentialCsv() {
    const response = await fetch('data/voronoi_pvout_potential.csv');
    if (!response.ok) {
        throw new Error('PVOUT potential CSV not found at data/voronoi_pvout_potential.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        zone_area_km2: Number(row.zone_area_km2),
        pvout_level1_area_km2: Number(row.pvout_level1_area_km2),
        pvout_level1_data_area_km2: Number(row.pvout_level1_data_area_km2),
        pvout_level1_mean: Number(row.pvout_level1_mean),
        pvout_level1_twh_per_mw_km2: Number(row.pvout_level1_twh_per_mw_km2),
        pvout_level1_twh_y: Number(row.pvout_level1_twh_y),
        pvout_level2_area_km2: Number(row.pvout_level2_area_km2),
        pvout_level2_data_area_km2: Number(row.pvout_level2_data_area_km2),
        pvout_level2_mean: Number(row.pvout_level2_mean),
        pvout_level2_twh_per_mw_km2: Number(row.pvout_level2_twh_per_mw_km2),
        pvout_level2_twh_y: Number(row.pvout_level2_twh_y),
        assumed_mw_per_km2: Number(row.assumed_mw_per_km2),
        rooftop_area_km2: Number(row.rooftop_area_km2 || 0),
        rooftop_mw_per_km2: Number(row.rooftop_mw_per_km2 || 0),
        rooftop_twh_y: Number(row.rooftop_twh_y || 0),
        total_level1_twh_y: Number(row.total_level1_twh_y ?? row.pvout_level1_twh_y),
        total_level2_twh_y: Number(row.total_level2_twh_y ?? row.pvout_level2_twh_y)
    }));
}

export async function loadElectricityDemandData() {
    try {
        const response = await fetch('data/voronoi_electricity_demand.csv');
        const text = await response.text();
        return d3.csvParse(text, (d) => ({
            location_id: +d.location_id,
            latitude: +d.latitude,
            longitude: +d.longitude,
            annual_demand_kwh: +d.annual_demand_kwh
        }));
    } catch (e) {
        console.error("Error loading electricity demand data:", e);
        return [];
    }
}

export async function loadReliabilityCsv() {
    try {
        const response = await fetch('data/voronoi_grid_reliability.csv');
        const text = await response.text();
        return d3.csvParse(text, (d) => {
            // Columns: location_id,latitude,longitude,hrea_covered,pop_rel_0...pop_rel_95_100,pop_rel_100
            const row = {
                location_id: +d.location_id,
                latitude: +d.latitude,
                longitude: +d.longitude,
                hrea_covered: d.hrea_covered === 'True'
            };

            // Helper to sum population for weighted average calculation later
            let totalPop = 0;
            let weightedSum = 0;

            // Bin 0 (no access)
            const pop0 = +d.pop_rel_0 || 0;
            totalPop += pop0;
            // contributes 0 to weighted sum

            // Preserve bin-level data for detailed charts
            row.pop_bins = { 0: pop0 };

            // Bins 0-5 through 90-95 (i = 0, 5, 10, ..., 90)
            let connectedPop = 0;
            for (let i = 0; i < 95; i += 5) {
                const col = `pop_rel_${i}_${i + 5}`;
                const val = +d[col] || 0;
                const midpoint = (i + i + 5) / 2; // midpoint of the bin
                totalPop += val;
                connectedPop += val;
                weightedSum += val * midpoint;
                row.pop_bins[midpoint] = val;
            }

            // Bin 95-<100 (midpoint 97.5)
            const pop95_100 = +d.pop_rel_95_100 || 0;
            totalPop += pop95_100;
            connectedPop += pop95_100;
            weightedSum += pop95_100 * 97.5;
            row.pop_bins[97.5] = pop95_100;

            // Bin 100 (exactly 100% reliable)
            const pop100 = +d.pop_rel_100 || 0;
            totalPop += pop100;
            connectedPop += pop100;
            weightedSum += pop100 * 100;
            row.pop_bins[100] = pop100;

            // Original metric: includes pop0 as 0 reliability
            row.avg_reliability = totalPop > 0 ? weightedSum / totalPop : 0;

            // New metrics:
            // 1. Reliability for those with access
            row.avg_reliability_access_only = connectedPop > 0 ? weightedSum / connectedPop : 0;

            // 2. Percentage of population with NO access
            row.pct_no_access = totalPop > 0 ? pop0 / totalPop : 0;

            row.total_pop_reliability = totalPop;

            return row;
        });
    } catch (e) {
        console.error("Error loading reliability data:", e);
        return [];
    }
}
