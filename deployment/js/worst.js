/**
 * Worst-year capacity factor of a build (T068, D-142). The maps show the
 * ten-year (2015–2024) average; tooltips add the weakest calendar year for the
 * build on screen.
 *
 * Data: data/worst/w_<location_id >> 7>.bin, one gzip file per 128 location ids,
 * written by pipeline/scripts/pipeline/tenyear/worst.py (format documented there).
 * A block is fetched the first time a tooltip in it opens; until then the line
 * reads "…" and is filled in place when the block arrives.
 */
import { loadConfigManifest, loadAddonManifest, configKey } from './data.js';

const BLOCK_SHIFT = 7;
const MAGIC = 0x54535257;
const Y0 = 2015;
const blocks = new Map();     // block -> Promise<block | null>
const ready = new Map();      // block -> parsed block (or null when missing)
let manifests = null;         // Promise<{ dense: Map(key -> i), mix: Map, large: Map(solar -> [{ batt, j }]) }>
let manifestsReady = null;

function loadManifests() {
    if (!manifests) {
        manifests = Promise.all([loadConfigManifest(), loadAddonManifest()]).then(([cfg, addon]) => {
            const dense = new Map();
            cfg.configs.forEach(c => dense.set(configKey(c.surface, c.solar, c.wind, c.batt), c.i));
            const mix = new Map();
            const large = new Map();
            for (const s of addon?.sets || []) {
                if (s.id === 'wind_mix') s.configs.forEach(c => mix.set(`${c.solar}|${c.on}|${c.off}|${c.batt}`, c.j));
                if (s.id === 'large') {
                    s.configs.forEach(c => {
                        if (!large.has(c.solar)) large.set(c.solar, []);
                        large.get(c.solar).push({ batt: c.batt, j: c.j });
                    });
                }
            }
            large.forEach(list => list.sort((a, b) => a.batt - b.batt));
            manifestsReady = { dense, mix, large };
            return manifestsReady;
        });
        manifests.catch(() => { manifests = null; });
    }
    return manifests;
}

async function inflate(bytes) {
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;   // already decoded by the server
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseBlock(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== 1) throw new Error('worst-year block: bad header');
    const nLoc = dv.getUint32(8, true);
    const nDense = dv.getUint32(12, true), nMix = dv.getUint32(16, true), nLarge = dv.getUint32(20, true);
    let off = 24;
    const locs = new Map();
    const ids = [];
    for (let k = 0; k < nLoc; k++, off += 4) ids.push(dv.getInt32(off, true));
    let row = 0;
    for (let k = 0; k < nLoc; k++) {
        const flags = buf[off + k];
        locs.set(ids[k], { start: row, flags });
        row += nDense + (flags & 1 ? nMix : 0) + (flags & 2 ? nLarge : 0);
    }
    off += nLoc + ((4 - (nLoc % 4)) % 4);
    const nRows = row;
    if (buf.byteLength !== off + 3 * nRows) throw new Error('worst-year block: bad length');
    return {
        locs, nDense, nMix,
        hi: buf.subarray(off, off + nRows),
        lo: buf.subarray(off + nRows, off + 2 * nRows),
        yr: buf.subarray(off + 2 * nRows, off + 3 * nRows)
    };
}

function loadBlock(b) {
    if (!blocks.has(b)) {
        const p = Promise.all([
            loadManifests(),
            fetch(`data/worst/w_${b}.bin`)
                .then(r => (r.ok ? r.arrayBuffer() : null))
                .then(ab => (ab ? inflate(new Uint8Array(ab)) : null))
        ]).then(([, bytes]) => {
            const parsed = bytes ? parseBlock(bytes) : null;
            ready.set(b, parsed);
            return parsed;
        });
        p.catch(() => { blocks.delete(b); });
        blocks.set(b, p);
    }
    return blocks.get(b);
}

function at(block, loc, row) {
    const r = loc.start + row;
    return { e4: (block.hi[r] << 8) | block.lo[r], year: Y0 + block.yr[r] };
}

/**
 * The worst year of a row's build, { cf, year } (year null when an interpolated
 * build's two neighbours disagree), null where there is none, or undefined while
 * the data are not loaded yet.
 */
function lookup(desc) {
    const block = ready.get(desc.id >> BLOCK_SHIFT);
    if (block === undefined || !manifestsReady) return undefined;
    const loc = block?.locs.get(desc.id);
    if (!loc) return null;
    const m = manifestsReady;
    if (desc.kind === 'dense') {
        const i = m.dense.get(configKey(desc.surface, desc.solar, desc.wind, desc.batt));
        if (i === undefined) return null;
        const v = at(block, loc, i);
        return { cf: v.e4 / 1e4, year: v.year };
    }
    if (desc.kind === 'mix') {
        const j = m.mix.get(`${desc.solar}|${desc.on}|${desc.off}|${desc.batt}`);
        if (j === undefined || !(loc.flags & 1)) return null;
        const v = at(block, loc, block.nDense + j);
        return { cf: v.e4 / 1e4, year: v.year };
    }
    // large: exact grid point, or linear in battery between its two neighbours
    const list = m.large.get(desc.solar);
    if (!list || !(loc.flags & 2)) return null;
    const base = block.nDense + (loc.flags & 1 ? block.nMix : 0);
    let k = list.findIndex(c => c.batt >= desc.batt - 1e-9);
    if (k < 0) return null;
    const hi = at(block, loc, base + list[k].j);
    if (Math.abs(list[k].batt - desc.batt) < 1e-9 || k === 0) return { cf: hi.e4 / 1e4, year: hi.year };
    const lo = at(block, loc, base + list[k - 1].j);
    const f = (desc.batt - list[k - 1].batt) / (list[k].batt - list[k - 1].batt);
    return { cf: (lo.e4 + f * (hi.e4 - lo.e4)) / 1e4, year: lo.year === hi.year ? lo.year : null };
}

function describe(row) {
    if (!row || !Number.isFinite(row.location_id) || row.includeDieselBackup) return null;
    const solar = row.solar_gw, batt = row.batt_gwh;
    if (!Number.isFinite(solar) || !Number.isFinite(batt)) return null;
    if (row.addon === 'large') return { id: row.location_id, kind: 'large', solar, batt };
    if (row.wind_surface === 'both') {
        return { id: row.location_id, kind: 'mix', solar, batt, on: row.wind_on_gw, off: row.wind_off_gw };
    }
    return { id: row.location_id, kind: 'dense', solar, batt, wind: row.wind_gw || 0, surface: row.wind_surface === 'off' ? 'off' : 'on' };
}

function text(v) {
    if (v === undefined) return 'Worst year: …';
    return `Worst year${v.year ? ` (${v.year})` : ''}: ${(v.cf * 100).toFixed(1)}%`;
}

/**
 * A muted tooltip line with the worst calendar year of the row's build, or ''
 * where there is none (firm-backup builds, rows without a build). If the data
 * are not loaded yet the line is filled in when they arrive.
 */
export function worstYearLine(row) {
    const desc = describe(row);
    if (!desc) return '';
    const v = lookup(desc);
    if (v === null) return '';
    if (v === undefined) {
        const b = desc.id >> BLOCK_SHIFT;
        loadBlock(b).then(() => fill(b)).catch(() => fill(b));
    }
    const attr = encodeURIComponent(JSON.stringify(desc));
    return `<div class="text-muted" data-worst="${attr}">${text(v)}</div>`;
}

function fill(b) {
    document.querySelectorAll('[data-worst]').forEach((el) => {
        let desc;
        try { desc = JSON.parse(decodeURIComponent(el.dataset.worst)); } catch (_) { return; }
        if ((desc.id >> BLOCK_SHIFT) !== b) return;
        const v = ready.has(b) ? lookup(desc) : null;
        if (v === undefined) return;
        if (v === null) el.remove();
        else el.textContent = text(v);
    });
}

/** Start loading the block of a location (e.g. on hover), so its tooltip is ready. */
export function prefetchWorstYear(locationId) {
    if (Number.isFinite(locationId)) loadBlock(locationId >> BLOCK_SHIFT).catch(() => {});
}

/** For checks: resolve a row's worst year once its block is loaded. */
export async function worstYearOf(row) {
    const desc = describe(row);
    if (!desc) return null;
    await loadBlock(desc.id >> BLOCK_SHIFT);
    return lookup(desc);
}
