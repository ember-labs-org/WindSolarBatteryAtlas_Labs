import { capitalizeWord, formatNumber, formatCurrency, coordKey, roundedKey, capitalRecoveryFactor as crf } from './utils.js';
import {
    FUEL_COLORS,
    FUEL_LABELS,
    PLANT_MARKER,
    ALL_FUELS,
    LCOE_NO_DATA_COLOR,
    POTENTIAL_MULTIPLE_BUCKETS,
    POTENTIAL_PER_CAPITA_BUCKETS,
    RAMPS,
    DATA_COLOURS,
    NO_DATA_COLOR,
    rampScale,
    FEATURE_VORONOI_REUSE,
    FEATURE_VORONOI_GEOM_CACHE,
    FEATURE_VORONOI_CANVAS
} from './constants.js';
import { worstYearLine } from './worst.js';
import { createSharedPopup, buildTooltipHtml, buildCfTooltip, buildLcoeTooltip, buildPlantTooltip, formatFirmCfText, buildDieselBackupLines, buildCountryLine, formatWindPart, formatMaxConfig, costWindSurfaceLine, formatBattery, windSplitOf, addonBuildLine, getTechFilterNote, noBuildTooltip } from './tooltip.js';
import { createVoronoiCanvasLayer } from './voronoi-canvas.js';
import { addLandBasemap } from './basemap.js';

// Map a value to a bucket color (shared by the "× Demand" and "per capita"
// potential display modes, which both use discrete colour buckets).
function bucketColor(buckets, val) {
    const value = Number.isFinite(val) ? val : 0;
    for (const bucket of buckets) {
        if (bucket.max === null || value < bucket.max) return bucket.color;
    }
    return buckets[buckets.length - 1].color;
}

// Per-cell country overlap list (location_id -> ordered string[]), populated from
// app.js once the overlapping-countries CSV loads. Lets every map tooltip show the
// country (or countries, for border-straddling cells) the hovered cell covers.
let cellCountriesLookup = new Map();
export function setCellCountries(lookup) {
    cellCountriesLookup = lookup instanceof Map ? lookup : new Map();
}
// Per-cell wind siting (location_id -> { on_viable, off_viable, ... }), from
// app.js once the wind resource file loads, so cost-view tooltips can say why a
// surface was chosen. Empty until then; the text then omits viability.
let windSitesLookup = new Map();
export function setWindSites(lookup) {
    windSitesLookup = lookup instanceof Map ? lookup : new Map();
}
const windSitesFor = d => (d ? windSitesLookup.get(d.location_id) : null) || null;

// Wind-not-viable hatch (T033): true where the build drawn for this row could
// use wind but the cell has no viable site for it (on_viable/off_viable in the
// wind resource file). Capacity rows are one slice: wind > 0 on one surface. Cost
// rows say what their search covered: both surfaces, onshore only, or the slice
// on screen. Without the wind resource file nothing is hatched.
function windNotViable(row) {
    const s = windSitesFor(row);
    if (!s) return false;
    if (row.windSurfaces === 'both') return !s.on_viable && !s.off_viable;
    if (row.windSurfaces === 'onshore') return !s.on_viable;
    // A combined onshore + offshore build (T058) only exists where both sites do.
    if (row.wind_surface === 'both') return !s.on_viable && !s.off_viable;
    return row.wind_gw > 0 && !(row.wind_surface === 'off' ? s.off_viable : s.on_viable);
}

// Legend rows explaining the hatch (elements with class `legend-wind-hatch` in the
// capacity and LCOE legends) show only while the main map has a hatched cell.
function showWindHatchLegend(on) {
    document.querySelectorAll('.legend-wind-hatch').forEach(el => el.classList.toggle('hidden', !on));
}

// SVG (?canvas=0) twin of the canvas wind hatch: a pattern with the same lines,
// in layer coordinates (L.svg's user space), and one hatch path over each hatched
// cell at that cell's fill opacity. `items` are { key, path, opacity } in draw
// order; the group sits last in `parent`, so it is drawn over the cells.
function drawSvgWindHatch(svg, parent, items, mapRef) {
    const id = `wind-hatch-${mapRef?._leaflet_id || 'main'}`;
    let hatchGroup = parent.select('g.voronoi-hatch');
    if (!items.length) { hatchGroup.remove(); return; }
    let defs = svg.select('defs');
    if (defs.empty()) defs = svg.insert('defs', ':first-child');
    if (defs.select(`#${id}`).empty()) {
        const { period: P, width, shift, alpha, stroke, light } = createVoronoiCanvasLayer.WIND_HATCH;
        const lines = createVoronoiCanvasLayer.windHatchLines;
        const pattern = defs.append('pattern')
            .attr('id', id)
            .attr('patternUnits', 'userSpaceOnUse')
            .attr('width', P)
            .attr('height', P);
        for (const [offset, colour] of [[0, stroke], [shift, light]]) {
            pattern.append('path')
                .attr('d', lines(offset))
                .attr('fill', 'none')
                .attr('stroke', colour)
                .attr('stroke-opacity', alpha)
                .attr('stroke-width', width);
        }
    }
    if (hatchGroup.empty()) hatchGroup = parent.append('g').attr('class', 'voronoi-hatch').style('pointer-events', 'none');
    else hatchGroup.raise();
    hatchGroup.selectAll('path')
        .data(items, d => d.key)
        .join('path')
        .attr('d', d => d.path)
        .attr('fill', `url(#${id})`)
        .attr('fill-opacity', d => d.opacity)
        .attr('stroke', 'none')
        .order();
}

function buildCountryLineFor(d) {
    if (!d) return '';
    let names = Array.isArray(d.country_names) ? d.country_names : null;
    if (!names && Number.isFinite(d.location_id)) {
        names = cellCountriesLookup.get(d.location_id);
    }
    return buildCountryLine(names);
}
// Insert the country line as the last child of an existing tooltip HTML string.
function appendCountryLine(html, d) {
    if (!html) return html;
    const line = buildCountryLineFor(d);
    if (!line) return html;
    const idx = html.lastIndexOf('</div>');
    return idx === -1 ? html + line : html.slice(0, idx) + line + html.slice(idx);
}

let map;
let markersLayer;
let overlayLayer;
let voronoiLayer;
let markerRenderer;
let selectedMarker = null;
let currentMode = 'capacity';
let activeLayerMode = null;
let lastDataIsFiltered = false;
let lastCapacityOptions = {};       // updateMap options (preFiltered, wind, surface) for redraws
let populationOverlay = false;
let populationData = null;
let populationScale = null;
const ALL_FOSSIL_FUELS = ALL_FUELS;
const FOSSIL_COLORS = FUEL_COLORS;

let supplyMap;
let supplyMarkersLayer;
let supplyOverlayLayer;
let supplyVoronoiLayer;
let supplyMarkerRenderer;
let supplyPopup = null;
let dualMapEnabled = false;
let syncingMaps = false;
let lastSupplyState = null;
let demandVoronoiIndex = new Map();
let supplyVoronoiIndex = new Map();
let demandDataByCoord = new Map();
let supplyDataByCoord = new Map();
let activeDemandHoverKey = null;
let activeSupplyHoverKey = null;

const capacityMarkers = new Map();
let capacityMarkersActive = false;
let capacityPopup = null;

let samplePopup = null;
let lastSampleVoronoiKey = null;
let sampleHoverId = null;   // location_id under the pointer, so a new frame refreshes its popup

let currentAccessMetric = 'reliability'; // 'reliability', 'no_access', or 'no_access_pop'

export function setAccessMetric(metric) {
    currentAccessMetric = metric;
}

const POTENTIAL_LEVEL_LABELS = {
    level1: 'Technical constraints',
    level2: 'Policy constraints'
};

function getPotentialLevelLabel(level) {
    return POTENTIAL_LEVEL_LABELS[level] || POTENTIAL_LEVEL_LABELS.level1;
}

// Solar tooltip basis: siting level and the densities of the chosen case (T085, set on the rows by app.js).
function solarPotentialBasis(level, d) {
    const mw = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : '--');
    return `${getPotentialLevelLabel(level)} • ${mw(d.assumed_mw_per_km2)} MW/km² ground, ${mw(d.rooftop_mw_per_km2)} MW/km² rooftop`;
}

// Colour scale for capacity factor (0 to 1), from the registry (T062).
const colorScale = rampScale('cf');

function getColor(cf) {
    return colorScale(cf);
}

function startMapPerf(label, meta = {}) {
    const startHeap = performance?.memory?.usedJSHeapSize;
    return { label, meta, startMs: performance.now(), startHeap };
}

function endMapPerf(marker, extra = {}) {
    if (!marker) return;
    const endHeap = performance?.memory?.usedJSHeapSize;
    const heapDeltaMb = Number.isFinite(marker.startHeap) && Number.isFinite(endHeap)
        ? (endHeap - marker.startHeap) / 1048576
        : null;
    const payload = {
        durationMs: Number((performance.now() - marker.startMs).toFixed(2)),
        heapDeltaMb: Number.isFinite(heapDeltaMb) ? Number(heapDeltaMb.toFixed(3)) : null,
        ...marker.meta,
        ...extra
    };
    console.debug(`[perf] ${marker.label}`, payload);
    // Debug-only: forward to the on-screen perf HUD when it's installed (?perf in
    // the URL). No-op otherwise — window.__SBA_PERF__ only exists once perf-hud.js
    // has been imported, which only happens on the ?perf path.
    if (typeof window !== 'undefined' && window.__SBA_PERF__) {
        window.__SBA_PERF__(marker.label, payload);
    }
}

// Population and demand are very uneven, so a log scale (Labs b7bc31d): each
// tenfold step gets its own shade, dense = bright. Range kept to six orders of magnitude.
export function buildLogRampScale(values, name = 'population') {
    const positive = values.filter(v => Number.isFinite(v) && v > 0);
    const max = positive.length ? Math.max(...positive) : 1;
    const min = positive.length ? Math.min(...positive) : 1;
    const floor = Math.max(min, max / 1e6, 1e-9);
    return rampScale(name, [floor, Math.max(max, floor * 10)]);
}

function buildPopulationScale(values) {
    return buildLogRampScale(values);
}

// LCOE: the registry's fixed domain ($35 to $250; clamped at both ends), so a
// colour means the same cost in every view and year.
function buildLcoeScale() {
    return rampScale('lcoe');
}

function buildTxScale(domain) {
    const d = Array.isArray(domain) && domain.length === 3 && domain.every(v => Number.isFinite(v)) ? domain : [0, 100, 500];
    // Five green steps: the three breakpoints and the midpoints between them.
    return rampScale('green', [d[0], (d[0] + d[1]) / 2, d[1], (d[1] + d[2]) / 2, d[2]]);
}

function buildDeltaScale(maxAbs) {
    const span = Math.max(1, maxAbs || 1);
    return rampScale('delta', [-span, span]);
}

// Wind layers of the LCOE view (T014): the wind share of the cheapest build and
// the saving from wind, both from fields the cost search already returns
// (windShare, windSaving, noWindMeetsTarget). Sequential from deep blue (no wind) to light
// Green ramp (registry), distinct from the Loading and no-data colours.
export const WIND_LAYER_COLORS = RAMPS.green.stops;
// Saving layer: the target is met only with wind (no solar + battery build meets it).
export const WIND_NEEDED_COLOR = DATA_COLOURS.windNeeded;
// Wind layers before the full-grid search has run (the slice search has no wind fields).
export const WIND_LAYER_PENDING_COLOR = DATA_COLOURS.pending;
const isWindLayer = colorInfo => colorInfo && (colorInfo.type === 'wind_share' || colorInfo.type === 'wind_saving');

function buildLcoeColorScaleFromInfo(colorInfo) {
    if (!colorInfo) {
        return buildLcoeScale();
    }
    if (isWindLayer(colorInfo)) {
        return rampScale('green', colorInfo.domain || [0, 1]);
    }
    if (colorInfo.type === 'delta') {
        return buildDeltaScale(colorInfo.maxAbs || 1);
    }
    if (colorInfo.type === 'tx') {
        return buildTxScale(colorInfo.domain);
    }
    if (colorInfo.type === 'cf') return colorScale;
    return buildLcoeScale();
}

function getLcoeColor(row, colorInfo, colorScale) {
    if (!row || !colorInfo || !colorScale) return NO_DATA_COLOR;
    if (!row.meetsTarget) return NO_DATA_COLOR;
    if (colorInfo.type === 'wind_share') {
        return Number.isFinite(row.windShare) ? colorScale(row.windShare) : WIND_LAYER_PENDING_COLOR;
    }
    if (colorInfo.type === 'wind_saving') {
        if (row.noWindMeetsTarget === undefined) return WIND_LAYER_PENDING_COLOR;
        if (!row.noWindMeetsTarget) return WIND_NEEDED_COLOR;
        return Number.isFinite(row.windSaving) ? colorScale(Math.max(0, row.windSaving)) : WIND_LAYER_PENDING_COLOR;
    }
    if (colorInfo.type === 'delta') {
        return Number.isFinite(row.lcoe) && Number.isFinite(row.delta) ? colorScale(row.delta) : NO_DATA_COLOR;
    }
    if (colorInfo.type === 'tx') {
        const val = row.txMetrics ? row.txMetrics.breakevenPerGwKm : 0;
        return Number.isFinite(row.lcoe) && val > 0 ? colorScale(val) : NO_DATA_COLOR;
    }
    return Number.isFinite(row.lcoe) ? colorScale(row.lcoe) : NO_DATA_COLOR;
}

let worldGeoJSON = null;
let worldGeoJsonPromise = null;

function refreshCurrentMap() {
    if (!map) return;
    if (currentMode === 'capacity' && lastData && lastSolar !== null && lastBatt !== null) {
        updateMap(lastData, lastSolar, lastBatt, lastCapacityOptions);
    } else if (currentMode === 'lcoe' && lastLcoeData) {
        updateLcoeMap(lastLcoeData, lastLcoeOptions || {});
    } else if (currentMode === 'lcoe_cf' && lastCfData) {
        updateCfMap(lastCfData, lastCfOptions || {});
    } else if (currentMode === 'potential' && lastPotentialArgs) {
        updatePotentialMap(...lastPotentialArgs);
    } else if (currentMode === 'complementarity' && lastSampleFrame) {
        updateMapWithSampleFrame(lastSampleFrame);
    }
    if (lastSupplyState && supplyMap) {
        updateSupplyMap(lastSupplyState);
    }
}

export function ensureWorldGeoJsonLoaded() {
    if (worldGeoJSON) return Promise.resolve(worldGeoJSON);
    if (worldGeoJsonPromise) return worldGeoJsonPromise;
    // Local file only: it is Natural Earth 50m land without Antarctica and
    // Greenland (T057), so a fallback to the full Natural Earth file would
    // bring their land back.
    const sources = ['data/world.geojson'];
    worldGeoJsonPromise = (async () => {
        for (const source of sources) {
            try {
                const response = await fetch(source);
                if (!response.ok) continue;
                worldGeoJSON = await response.json();
                break;
            } catch (_) {
                // Try next source.
            }
        }
        if (!worldGeoJSON) {
            console.error('Could not load world GeoJSON data.');
        }
        return worldGeoJSON;
    })();
    return worldGeoJsonPromise;
}
let voronoiClipVersionByMap = new Map();
// Geometry cache: with viewport (zoom|pixelOrigin|size) and the ordered point
// set unchanged, a Delaunay/renderCell rebuild reproduces byte-identical cell
// paths — so renderVoronoi can skip it and only refresh fills.
const voronoiGeomCacheByMap = new Map(); // versionKey -> { geomKey, cellsData }
// Latest render callbacks/options per map; cell listeners are bound once and
// read this at event time, so reused elements never fire stale closures.
const voronoiHandlersByMap = new Map();

// Full wipe + cache drop, used where the old code relied on the pre-render
// clearVoronoi() to leave a blank map (empty-data early returns, the
// single-point branch) now that the same-mode pre-render clear is selective.
function clearVoronoiAndGeomCache() {
    clearVoronoi();
    const versionKey = map?._leaflet_id || 'main';
    voronoiClipVersionByMap.delete(versionKey);
    voronoiGeomCacheByMap.delete(versionKey);
}
let capacityCoordMap = null;
let capacityCoordMapSource = null;
let capacityCoordMapPopSource = null;

function getCapacityCoordMap(capacityMap, popData = null) {
    if (!capacityMap) return null;
    if (capacityCoordMapSource === capacityMap && capacityCoordMapPopSource === popData && capacityCoordMap) {
        return capacityCoordMap;
    }
    const coordMap = new Map();
    const capacityPoints = [];
    const capacityRows = [];
    capacityMap.forEach(row => {
        if (!row) return;
        const lat = Number(row.latitude);
        const lon = Number(row.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        coordMap.set(roundedKey(lat, lon), row);
        capacityPoints.push([lon, lat]);
        capacityRows.push(row);
    });

    if (popData && popData.length && capacityPoints.length) {
        if (typeof d3 !== 'undefined' && d3.Delaunay) {
            const delaunay = d3.Delaunay.from(capacityPoints);
            popData.forEach(p => {
                if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
                const key = roundedKey(p.latitude, p.longitude);
                if (coordMap.has(key)) return;
                const idx = delaunay.find(p.longitude, p.latitude);
                const row = capacityRows[idx];
                if (row) coordMap.set(key, row);
            });
        } else {
            // Fallback: brute-force nearest neighbor if Delaunay isn't available
            popData.forEach(p => {
                if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
                const key = roundedKey(p.latitude, p.longitude);
                if (coordMap.has(key)) return;
                let bestIdx = -1;
                let bestDist = Infinity;
                for (let i = 0; i < capacityPoints.length; i++) {
                    const [lon, lat] = capacityPoints[i];
                    const dLat = lat - p.latitude;
                    const dLon = lon - p.longitude;
                    const dist = dLat * dLat + dLon * dLon;
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = i;
                    }
                }
                if (bestIdx >= 0) coordMap.set(key, capacityRows[bestIdx]);
            });
        }
    }
    capacityCoordMapSource = capacityMap;
    capacityCoordMapPopSource = popData;
    capacityCoordMap = coordMap;
    return coordMap;
}

function applyHoverRim(element) {
    if (!element) return;
    const sel = d3.select(element);
    if (sel.attr("data-hover-prev-stroke") === null) {
        const prevStroke = sel.attr("stroke");
        const prevStrokeWidth = sel.attr("stroke-width");
        const prevStrokeOpacity = sel.attr("stroke-opacity");
        sel.attr("data-hover-prev-stroke", prevStroke == null ? '' : prevStroke);
        sel.attr("data-hover-prev-stroke-width", prevStrokeWidth == null ? '' : prevStrokeWidth);
        sel.attr("data-hover-prev-stroke-opacity", prevStrokeOpacity == null ? '' : prevStrokeOpacity);
    }
    sel.attr("stroke", "#ffffff")
        .attr("stroke-width", 1.2)
        .attr("stroke-opacity", 1)
        .classed("voronoi-hover", true);
}

function clearHoverRim(element) {
    if (!element) return;
    const sel = d3.select(element);
    const prevStroke = sel.attr("data-hover-prev-stroke");
    if (prevStroke !== null) {
        sel.attr("stroke", prevStroke === '' ? null : prevStroke);
    }
    const prevStrokeWidth = sel.attr("data-hover-prev-stroke-width");
    if (prevStrokeWidth !== null) {
        sel.attr("stroke-width", prevStrokeWidth === '' ? null : prevStrokeWidth);
    }
    const prevStrokeOpacity = sel.attr("data-hover-prev-stroke-opacity");
    if (prevStrokeOpacity !== null) {
        sel.attr("stroke-opacity", prevStrokeOpacity === '' ? null : prevStrokeOpacity);
    }
    sel.attr("data-hover-prev-stroke", null)
        .attr("data-hover-prev-stroke-width", null)
        .attr("data-hover-prev-stroke-opacity", null)
        .classed("voronoi-hover", false);
}

function getRowKey(row) {
    if (!row || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) return null;
    return roundedKey(row.latitude, row.longitude);
}

function ensureSupplyPopup() {
    if (supplyPopup) return supplyPopup;
    if (!supplyMap) return null;
    supplyPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });
    return supplyPopup;
}

function buildLcoeConfigLine(data) {
    return `<div>CF ${formatFirmCfText(data)} | Solar ${data.solar_gw} MW_DC${formatWindPart(data.wind_gw, data.wind_surface, windSplitOf(data))} | Battery ${formatBattery(data.batt_gwh)} MWh</div>`
        + worstYearLine(data)
        + addonBuildLine(data)
        + costWindSurfaceLine(data, windSitesFor(data));
}

function buildSupplyTooltipHtml(d, overlayMode, potentialState = null) {
    if (!d) return '';
    if (overlayMode === 'cf') {
        return buildCfTooltip(d.annual_cf, d.solar_gw, d.batt_gwh, d.wind_gw, d.wind_surface, [], windSplitOf(d), d);
    }
    if (overlayMode === 'lcoe') {
        return buildLcoeTooltip(d, formatCurrency, formatNumber, windSitesFor(d));
    }
    if (overlayMode === 'potential' && potentialState) {
        const level = potentialState.level || 'level1';
        const isMultiple = potentialState.displayMode === 'multiple';
        const isPerCapita = potentialState.displayMode === 'per_capita';
        const totalKey = level === 'level2' ? 'total_level2_twh_y' : 'total_level1_twh_y';
        const groundKey = level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
        const rawTotal = Number(d[totalKey]);
        const ground = Number(d[groundKey] || 0);
        const rooftop = Number(d.rooftop_twh_y || 0);
        const total = Number.isFinite(rawTotal) ? rawTotal : ground + rooftop;
        const latVal = Number(d.latitude);
        const bounds = potentialState.latBounds;
        const noData = bounds ? (!Number.isFinite(latVal) || latVal < bounds.min || latVal > bounds.max) : false;
        let ratio = null;
        let demandTwh = null;
        let noDemand = false;
        let perCapita = null;
        let population = null;
        let noPopulation = false;
        if (isMultiple) {
            const demandRow = potentialState.demandMap ? potentialState.demandMap.get(d.location_id) : null;
            const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
            demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
            ratio = demandTwh > 0 ? total / demandTwh : null;
            noDemand = demandTwh <= 0;
        } else if (isPerCapita) {
            population = potentialState.populationMap ? Number(potentialState.populationMap.get(d.location_id) || 0) : 0;
            perCapita = population > 0 ? (total * 1e6) / population : null;
            noPopulation = !(population > 0);
        }
        let mainLine = '';
        let demandLine = '';
        if (noData) {
            mainLine = 'No data available';
        } else if (isMultiple && noDemand) {
            mainLine = 'No demand data available';
        } else if (isPerCapita && noPopulation) {
            mainLine = 'No population data available';
        } else if (isMultiple) {
            mainLine = `Solar Potential / Demand: ${ratio !== null ? `${formatNumber(ratio, 2)}×` : '--'}`;
            demandLine = `<div class="text-muted">Demand: ${demandTwh ? `${formatNumber(demandTwh, 2)} TWh/yr` : '0 TWh/yr'}</div>`;
        } else if (isPerCapita) {
            mainLine = `Solar Potential per Capita: ${perCapita !== null ? `${formatNumber(perCapita, 0)} MWh/person/yr` : '--'}`;
            demandLine = `<div class="text-muted">Population: ${population ? formatNumber(population, 0) : '0'}</div>`;
        } else {
            mainLine = `Solar Generation Potential: ${formatNumber(total, 2)} TWh/yr`;
        }
        const showBreakdown = !noData && (rooftop > 0 || ground > 0);
        const breakdownLine = showBreakdown
            ? `<div class="text-muted">Ground-mount: ${formatNumber(ground, 2)} TWh/yr • Rooftop: ${formatNumber(rooftop, 2)} TWh/yr</div>`
            : '';
        return `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
            <div class="font-semibold">${mainLine}</div>
            ${demandLine}
            ${breakdownLine}
            <div class="text-muted">${solarPotentialBasis(level, d)}</div>
        </div>`;
    }
    return '';
}

function syncHoverToSupply(row) {
    if (!dualMapEnabled || !supplyMap || !lastSupplyState || lastSupplyState.overlayMode === 'none') return;
    const key = getRowKey(row);
    if (!key) return;
    const supplyRow = supplyDataByCoord.get(key);
    if (!supplyRow) return;

    const supplyCanvas = getCanvasLayer(supplyMap);
    if (supplyCanvas) {
        supplyCanvas.highlightKey(key); // canvas: highlight the supply cell by key
    } else {
        if (activeSupplyHoverKey && activeSupplyHoverKey !== key) {
            const prevEl = supplyVoronoiIndex.get(activeSupplyHoverKey);
            if (prevEl) clearHoverRim(prevEl);
        }
        const el = supplyVoronoiIndex.get(key);
        if (el) applyHoverRim(el);
    }
    activeSupplyHoverKey = key;

    const popup = ensureSupplyPopup();
    const html = buildSupplyTooltipHtml(supplyRow, lastSupplyState.overlayMode, lastSupplyState.potentialState);
    if (popup && html) {
        popup.setLatLng([supplyRow.latitude, supplyRow.longitude]).setContent(appendCountryLine(html, supplyRow)).openOn(supplyMap);
    }
}

function syncOutToSupply(row) {
    if (!dualMapEnabled || !supplyMap) return;
    const key = getRowKey(row);
    const supplyCanvas = getCanvasLayer(supplyMap);
    if (supplyCanvas) {
        supplyCanvas.clearHighlight();
    } else if (key && supplyVoronoiIndex.has(key)) {
        clearHoverRim(supplyVoronoiIndex.get(key));
    }
    if (activeSupplyHoverKey === key) activeSupplyHoverKey = null;
    if (supplyPopup) {
        supplyMap.closePopup(supplyPopup);
    }
}

function syncHoverToDemand(row) {
    if (!dualMapEnabled || !map) return;
    const key = getRowKey(row);
    if (!key) return;
    const demandRow = demandDataByCoord.get(key);
    if (!demandRow) return;

    const demandCanvas = getCanvasLayer(map);
    if (demandCanvas) {
        demandCanvas.highlightKey(key); // canvas: highlight the demand cell by key
    } else {
        if (activeDemandHoverKey && activeDemandHoverKey !== key) {
            const prevEl = demandVoronoiIndex.get(activeDemandHoverKey);
            if (prevEl) clearHoverRim(prevEl);
        }
        const el = demandVoronoiIndex.get(key);
        if (el) applyHoverRim(el);
    }
    activeDemandHoverKey = key;
    fireMarkerEvent(demandRow, 'mouseover');
}

function syncOutToDemand(row) {
    if (!dualMapEnabled || !map) return;
    const key = getRowKey(row);
    const demandCanvas = getCanvasLayer(map);
    if (demandCanvas) {
        demandCanvas.clearHighlight();
    } else if (key && demandVoronoiIndex.has(key)) {
        clearHoverRim(demandVoronoiIndex.get(key));
    }
    if (activeDemandHoverKey === key) activeDemandHoverKey = null;
    const demandRow = demandDataByCoord.get(key);
    if (demandRow) {
        fireMarkerEvent(demandRow, 'mouseout');
    }
}

// Hover/click/popup target for one cell's row (row.__hitMarker, fired through
// fireMarkerEvent). On the SVG path (?canvas=0) it is an invisible L.circleMarker,
// as before. On the canvas path it is a bare event target: the canvas layer's own
// hit-test (nearest cell, plus `radius` around the site — see voronoi-canvas.js)
// fires it, so ~5k markers no longer sit on the map for Leaflet to redraw.
class HitTarget {
    constructor() { this._handlers = {}; }
    on(type, fn) { (this._handlers[type] || (this._handlers[type] = [])).push(fn); return this; }
    fire(type) {
        const fns = this._handlers[type];
        if (fns) { const ev = { type, target: this, sourceTarget: this }; for (const fn of fns) fn.call(this, ev); }
        return this;
    }
}
function createHitTarget(latlng, radius) {
    if (resolveVoronoiCanvas()) return new HitTarget();
    return L.circleMarker(latlng, {
        radius,
        fillColor: '#fff',
        color: '#fff',
        weight: 0,
        opacity: 0,
        fillOpacity: 0,
        pane: 'markers',
        renderer: markerRenderer
    });
}
// Hit-target radius (px) of each view's cells; the canvas hit-test uses it in place
// of the circle markers.
const HIT_RADIUS = 4.5;
const POTENTIAL_HIT_RADIUS = 6;

function fireMarkerEvent(row, eventName) {
    const marker = row && row.__hitMarker;
    if (marker && typeof marker.fire === 'function') {
        marker.fire(eventName);
        return true;
    }
    return false;
}

function clearVoronoi() {
    // Hide the canvas Voronoi too (when active) so mode switches don't leave stale
    // cells; render() re-shows it for the next voronoi mode.
    getCanvasLayer(map)?.hide();
    if (!voronoiLayer) return;
    d3.select(voronoiLayer._container).selectAll("*").remove();
}

// Same-mode updates keep <defs> (the cached world clip-path) and the
// voronoi cell group alive so renderVoronoi can reuse both instead of
// re-projecting the world coastline and rebuilding ~5k SVG paths on every
// slider tick. Anything else (sample groups, dual-render leftovers) is
// removed, matching the full wipe for non-voronoi content.
function clearVoronoiForSameMode() {
    if (!voronoiLayer) return;
    const container = voronoiLayer._container;
    if (!container) return;
    Array.from(container.children).forEach(child => {
        const isDefs = child.tagName && child.tagName.toLowerCase() === 'defs';
        const isVoronoiGroup = child.classList && child.classList.contains('voronoi-group');
        if (!isDefs && !isVoronoiGroup) child.remove();
    });
}

function resetLayersForMode(mode, { preserveVoronoi = false } = {}) {
    const modeChanged = activeLayerMode !== mode;
    if (modeChanged) {
        if (markersLayer) markersLayer.clearLayers();
        if (overlayLayer) overlayLayer.clearLayers();
        if (!preserveVoronoi) clearVoronoi();
        activeLayerMode = mode;
        capacityMarkersActive = false;
        selectedMarker = null;
    } else {
        if (overlayLayer) overlayLayer.clearLayers();
        if (!preserveVoronoi) {
            if (FEATURE_VORONOI_GEOM_CACHE) {
                clearVoronoiForSameMode();
            } else {
                clearVoronoi();
            }
        }
    }
    return modeChanged;
}

export async function initMap(onLocationSelect) {
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false
    }).setView([20, 0], 2); // World view

    // T099: the renderer's canvas goes in the 'markers' pane (z 600, created below before any
    // marker is added). A canvas renderer ignores its layers' `pane` option, so the plant dots were
    // drawn in the overlay pane (z 400), under the Voronoi cell canvas (z 405), whose cell borders
    // then crossed the dots as light seams.
    markerRenderer = L.canvas({ padding: 0.5, pane: 'markers' });

    // Land basemap, drawn locally from Natural Earth (see basemap.js).
    ensureWorldGeoJsonLoaded().then(geo => addLandBasemap(map, geo));

    // Zoom disabled

    map.createPane('markers');
    map.getPane('markers').style.zIndex = 600;

    markersLayer = L.layerGroup().addTo(map);
    overlayLayer = L.layerGroup().addTo(map);
    voronoiLayer = L.svg().addTo(map);

    // Re-render Voronoi on move — RAF-coalesced, and skip redraws when the
    // viewport hasn't actually changed (tile-loaded moveend, programmatic
    // nudges, sync echoes all fire moveend without any real view change).
    // The canvas layer re-pins and redraws itself on moveend from cached
    // geometry, so on that path a pan is one draw, not a full re-render.
    let moveendPending = false;
    let lastMoveZoom = null;
    let lastMoveCenter = null;
    map.on('moveend', () => {
        if (moveendPending) return;
        moveendPending = true;
        requestAnimationFrame(() => {
            moveendPending = false;
            const zoom = map.getZoom();
            const center = map.getCenter();
            const viewportChanged = lastMoveZoom !== zoom
                || !lastMoveCenter
                || !lastMoveCenter.equals(center);
            if (!viewportChanged) return;
            lastMoveZoom = zoom;
            lastMoveCenter = center;

            // The canvas layer follows the view itself; only the SVG path re-renders.
            if (!getCanvasLayer(map)?.isActive()) {
                if (currentMode === 'capacity' && lastData && lastSolar !== null && lastBatt !== null) {
                    updateMap(lastData, lastSolar, lastBatt, lastCapacityOptions);
                } else if (currentMode === 'lcoe' && lastLcoeData) {
                    updateLcoeMap(lastLcoeData, lastLcoeOptions || {});
                } else if (currentMode === 'lcoe_cf' && lastCfData) {
                    updateCfMap(lastCfData, lastCfOptions || {});
                } else if (currentMode === 'potential' && lastPotentialArgs) {
                    updatePotentialMap(...lastPotentialArgs);
                } else if (currentMode === 'complementarity' && lastSampleFrame) {
                    updateMapWithSampleFrame(lastSampleFrame);
                }
            }
            if (dualMapEnabled && supplyMap && !syncingMaps) {
                syncMapViews(map, supplyMap);
            }
        });
    });

    // Store callback
    map.onLocationSelect = onLocationSelect;

    initSupplyMap();

    ensureWorldGeoJsonLoaded().then(() => {
        refreshCurrentMap();
    });
}

function initSupplyMap() {
    const container = document.getElementById('map-supply');
    if (!container) return;

    supplyMap = L.map('map-supply', {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false
    }).setView([20, 0], 2);

    supplyMarkerRenderer = L.canvas({ padding: 0.5 });

    ensureWorldGeoJsonLoaded().then(geo => addLandBasemap(supplyMap, geo));

    supplyMarkersLayer = L.layerGroup().addTo(supplyMap);
    supplyOverlayLayer = L.layerGroup().addTo(supplyMap);
    supplyVoronoiLayer = L.svg().addTo(supplyMap);

    supplyMap.on('moveend', () => {
        if (dualMapEnabled && map && !syncingMaps) {
            syncMapViews(supplyMap, map);
        }
        // The canvas layer follows the view itself (see initMap).
        if (dualMapEnabled && lastSupplyState && !getCanvasLayer(supplyMap)?.isActive()) {
            updateSupplyMap(lastSupplyState);
        }
    });
}

function syncMapViews(sourceMap, targetMap) {
    if (!sourceMap || !targetMap) return;
    syncingMaps = true;
    targetMap.setView(sourceMap.getCenter(), sourceMap.getZoom(), { animate: false });
    setTimeout(() => {
        syncingMaps = false;
    }, 0);
}

export function setDualMapMode(enabled) {
    dualMapEnabled = !!enabled;
    if (document.body) {
        document.body.classList.toggle('split-maps', dualMapEnabled);
    }
    if (!supplyMap || !map) return;
    const syncView = () => {
        if (dualMapEnabled) {
            supplyMap.setView(map.getCenter(), map.getZoom(), { animate: false });
        }
    };

    const invalidate = () => {
        map.invalidateSize();
        supplyMap.invalidateSize();
        if (dualMapEnabled && lastSupplyState) {
            updateSupplyMap(lastSupplyState);
        }
    };

    syncView();
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            invalidate();
            syncView();
        });
    });
}

let lastData = null;
let lastSolar = null;
let lastBatt = null;
let lastLcoeData = null;
let lastLcoeOptions = null;
let lastCfData = null; // Data for Target Mode (CF Map)
let lastCfOptions = null; // Options for Target Mode (CF Map)
let lastPotentialArgs = null; // [rows, options] of the last Potential map, for SVG redraws on move
let lastSampleFrame = null;
let lastPopulationData = null;

// ?debug only (app.js sets window.__atlasDrawn; checks/ read it): each view reports
// the rows the renderer drew. The renderer takes a snapshot when it fixes their
// colours (the row objects, and a copy of their fields) and reports it when the
// frame lands. Without the hook nothing is copied.
function drawHooks(view, opts) {
    const hook = window.__atlasDrawn;
    if (typeof hook !== 'function') return {};
    const o = { ...opts };
    return {
        snapshot: rows => ({ rows: Array.from(rows), copy: Array.from(rows, r => ({ ...r })) }),
        onDrawn: (rows, snap) => hook(view, rows, o, snap)
    };
}

export function updateMap(data, solarGw, battGwh, options = {}) {
    currentMode = 'capacity';
    const capOpts = { solarGw, battGwh, wind: options.wind ?? null, surface: options.surface ?? null };
    if (options.windOn != null) { capOpts.windOn = options.windOn; capOpts.windOff = options.windOff; }
    const hooks = drawHooks('capacity', capOpts);
    lastData = data;
    lastDataIsFiltered = options.preFiltered === true;
    lastCapacityOptions = options;
    lastSolar = solarGw;
    lastBatt = battGwh;
    lastLcoeData = null;
    lastLcoeOptions = null;

    selectedMarker = null;

    resetLayersForMode('capacity');

    const filtered = lastDataIsFiltered ? data : data.filter(d => d.solar_gw === solarGw && d.batt_gwh === battGwh);

    if (!filtered || filtered.length === 0) {
        // The same-mode pre-render clear is selective; replicate the old
        // "wiped to blank" outcome when there is nothing to render.
        if (FEATURE_VORONOI_GEOM_CACHE) clearVoronoiAndGeomCache();
        hooks.onDrawn?.([], { rows: [], copy: [] });
        return;
    }

    if (!capacityPopup) {
        capacityPopup = L.popup({
            closeButton: false,
            autoPan: false,
            className: 'bg-transparent border-none shadow-none'
        });
    }

    const onCanvas = resolveVoronoiCanvas();
    if (!capacityMarkersActive && capacityMarkers.size && !onCanvas) {
        capacityMarkers.forEach(({ hit }) => {
            hit.addTo(markersLayer);
        });
        capacityMarkersActive = true;
    }

    const activeIds = new Set();
    filtered.forEach(d => {
        const id = d.location_id ?? d._coordKey ?? coordKey(d.latitude, d.longitude);
        activeIds.add(id);

        let entry = capacityMarkers.get(id);

        if (!entry) {
            const hit = createHitTarget([d.latitude, d.longitude], HIT_RADIUS);

            hit.__data = d;
            d.__hitMarker = hit;

            hit.on('mouseover', () => {
                const row = hit.__data;
                if (!row) return;
                // Combined-build view (T058): a region with one kind of site says which is missing.
                const note = row.wind_note ? `<div class="text-muted">${row.wind_note}</div>` : '';
                const content = buildCfTooltip(row.annual_cf, lastSolar, lastBatt, row.wind_gw, row.wind_surface,
                    [note, buildCountryLineFor(row)], windSplitOf(row), row);
                capacityPopup.setLatLng([row.latitude, row.longitude]).setContent(content).openOn(map);
            });

            hit.on('mouseout', () => {
                map.closePopup(capacityPopup);
            });

            hit.on('click', () => {
                const row = hit.__data;
                if (!row) return;
                if (map.onLocationSelect) {
                    map.onLocationSelect(row, 'capacity');
                }
            });

            entry = { hit };
            capacityMarkers.set(id, entry);
            if (activeLayerMode === 'capacity' && !onCanvas) {
                hit.addTo(markersLayer);
            }
        } else {
            entry.hit.__data = d;
            d.__hitMarker = entry.hit;
        }
    });

    capacityMarkersActive = true;

    if (capacityMarkers.size !== activeIds.size && !onCanvas) {
        capacityMarkers.forEach((entry, id) => {
            const isActive = activeIds.has(id);
            if (!isActive) {
                entry.hit.setStyle({ opacity: 0, fillOpacity: 0, weight: 0 });
            } else {
                entry.hit.setStyle({ opacity: 0, fillOpacity: 0, weight: 0 });
            }
        });
    }

    renderVoronoi(filtered, (row) => getColor(row.annual_cf), { hitRadius: HIT_RADIUS, hatch: windNotViable, ...hooks });
}

export function updatePopulationPolygons(popData, geojson, { overlayMode = 'none', cfData = [], lcoeData = [], lcoeDomain = null } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;
    resetLayersForMode('population');
    markersLayer.clearLayers();

    if (!popData || popData.length === 0 || !geojson) {
        return;
    }

    const cfByCoord = new Map(cfData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeScale = overlayMode === 'lcoe' && lcoeDomain ? buildLcoeScale(lcoeDomain) : null;
    const popIndexByCoord = new Map(popData.map(p => [roundedKey(p.latitude, p.longitude), p]));
    populationScale = buildPopulationScale(popData.map(p => p.population_2020 || 0));

    // Base layer: population grayscale
    const layer = L.geoJSON(geojson, {
        style: (feature) => {
            const props = feature.properties || {};
            const propLat = Number(props.latitude);
            const propLon = Number(props.longitude);
            const centroid = feature.geometry ? L.geoJSON(feature.geometry).getBounds().getCenter() : null;
            const lat = Number.isFinite(propLat) ? propLat : (centroid ? centroid.lat : null);
            const lon = Number.isFinite(propLon) ? propLon : (centroid ? centroid.lng : null);
            const key = (lat !== null && lon !== null) ? roundedKey(lat, lon) : null;
            const popRow = key ? popIndexByCoord.get(key) : null;
            const popVal = popRow?.population_2020 || 0;
            const color = populationScale(popVal);
            return {
                color: color,
                weight: 0.3,
                fillColor: color,
                fillOpacity: 0.85
            };
        },
        onEachFeature: (feature, lyr) => {
            const props = feature.properties || {};
            const propLat = Number(props.latitude);
            const propLon = Number(props.longitude);
            const centroid = feature.geometry ? L.geoJSON(feature.geometry).getBounds().getCenter() : null;
            const lat = Number.isFinite(propLat) ? propLat : (centroid ? centroid.lat : null);
            const lon = Number.isFinite(propLon) ? propLon : (centroid ? centroid.lng : null);
            const key = (lat !== null && lon !== null) ? roundedKey(lat, lon) : null;
            const popRow = key ? popIndexByCoord.get(key) : null;
            const popVal = popRow?.population_2020 || 0;
            const cf = key ? cfByCoord.get(key) : null;
            const cfVal = cf ? cf.annual_cf : null;
            lyr.on('mouseover', (e) => {
                const lcoeLine = overlayMode === 'lcoe' && popRow && Number.isFinite(popRow.lcoe)
                    ? `<div>LCOE: ${formatCurrency(popRow.lcoe, 0)}/MWh</div>` : '';
                const cfLine = cfVal != null ? `<div>Capacity factor: ${(cfVal * 100).toFixed(1)}%</div>` : '';
                const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">Population: ${formatNumber(popVal, 0)}</div>
                    ${lcoeLine}
                    ${cfLine}
                    ${buildCountryLineFor(popRow)}
                 </div>`;
                const sharedPopup = L.popup({
                    closeButton: false,
                    autoPan: false,
                    className: 'bg-transparent border-none shadow-none'
                });
                sharedPopup.setLatLng(e.latlng).setContent(content).openOn(map);
            });
            lyr.on('mouseout', () => map.closePopup());
            lyr.on('click', () => {
                if (popRow) {
                    const clickLat = Number.isFinite(lyr.getBounds()?.getCenter()?.lat) ? lyr.getBounds().getCenter().lat : (lat ?? popRow.latitude);
                    const clickLon = Number.isFinite(lyr.getBounds()?.getCenter()?.lng) ? lyr.getBounds().getCenter().lng : (lon ?? popRow.longitude);
                    if (map.onLocationSelect) {
                        map.onLocationSelect({ ...popRow, latitude: clickLat, longitude: clickLon, population_2020: popVal }, 'population');
                    }
                }
            });
        }
    });

    layer.addTo(markersLayer);

    // Overlay layer for CF or LCOE with transparency
    if (overlayMode === 'cf' || overlayMode === 'lcoe') {
        const overlayGeo = L.geoJSON(geojson, {
            style: (feature) => {
                const props = feature.properties || {};
                const lat = Number(props.latitude);
                const lon = Number(props.longitude);
                const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
                const cfRow = key ? cfByCoord.get(key) : null;
                const lcoeRow = key ? lcoeByCoord.get(key) : null;
                let color = DATA_COLOURS.transparent;
                if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
                    color = getColor(cfRow.annual_cf);
                } else if (overlayMode === 'lcoe' && lcoeScale && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
                    color = lcoeScale(lcoeRow.lcoe);
                }
                return {
                    color: color,
                    weight: 0.5,
                    fillColor: color,
                    fillOpacity: 0.35
                };
            },
            interactive: false
        });
        overlayGeo.addTo(overlayLayer);
    }
}

// Re-export capitalRecoveryFactor from utils for backward compatibility
export { crf as capitalRecoveryFactor };

export function updatePopulationSimple(popData, { baseLayer = 'population', overlayMode = 'none', cfData = [], lcoeData = [], lcoeColorInfo = null, targetCf = null, comparisonMetric = 'lcoe', fossilPlants = [], fossilCapacityMap = null, electricityDemandData = [], electricityDemandMap = null, reliabilityData = [], reliabilityMap = null, selectedFuels = [], selectedStatus = 'announced' } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;
    resetLayersForMode('population');
    markersLayer.clearLayers();

    if (!popData || popData.length === 0) return;

    demandDataByCoord = new Map(popData.map(p => [roundedKey(p.latitude, p.longitude), p]));

    // Build LCOE Map if needed for overlay
    let lcoeMap = null;
    if (overlayMode === 'lcoe' && lcoeData) {
        lcoeMap = new Map(lcoeData.map(d => [d.location_id, d]));
    }

    // Build CF Map if needed
    let cfMap = null;
    if (overlayMode === 'cf' && cfData) {
        cfMap = new Map(cfData.map(d => [d.location_id, d]));
    }

    // Create maps from function parameters for lookup
    const capacityMap = fossilCapacityMap instanceof Map ? fossilCapacityMap : null;
    const capacityCoordMap = capacityMap ? getCapacityCoordMap(capacityMap, popData) : null;
    const statusSuffix = selectedStatus === 'existing' ? 'Existing' : 'Announced';

    const formatCapacityLines = (cap) => {
        if (!cap || !selectedFuelSet.size) {
            return baseLayer === 'plants' ? '<div class="mt-1 text-muted">No installed capacity for the selected fuels.</div>' : '';
        }
        const lines = [];
        selectedFuelSet.forEach(fuel => {
            const value = Number(cap[`${fuel}_${statusSuffix}`] || 0);
            if (value > 0) {
                lines.push(`<div>${capitalizeWord(fuel)}: ${formatNumber(value, 0)} MW</div>`);
            }
        });
        if (!lines.length) {
            return baseLayer === 'plants' ? '<div class="mt-1 text-muted">No installed capacity for the selected fuels.</div>' : '';
        }
        return `<div class="mt-1 text-muted">Installed capacity<br>${lines.join('')}</div>`;
    };

    const selectedFuelSet = new Set((selectedFuels && selectedFuels.length ? selectedFuels : []).map(f => f.toLowerCase()));
    const popValues = popData.map(p => p.population_2020 || 0);
    const popScale = buildPopulationScale(popValues);

    // Electricity scale (linear scale, black to white like population)
    let demandScale = null;
    if (baseLayer === 'electricity' && electricityDemandData && electricityDemandData.length > 0) {
        const demands = electricityDemandData.map(d => d.annual_demand_kwh || 0).filter(v => v > 0);
        if (demands.length > 0) {
            // Same log scale and colours as population (dense = bright)
            demandScale = buildLogRampScale(demands);
        }
    }

    const cfByCoord = new Map(cfData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeScale = overlayMode === 'lcoe' && lcoeColorInfo ? buildLcoeColorScaleFromInfo(lcoeColorInfo) : null;

    // Build coordinate-based lookup for electricity demand (since popData doesn't have location_id)
    const demandByCoord = new Map();
    if (electricityDemandData && electricityDemandData.length > 0) {
        electricityDemandData.forEach(d => {
            const key = roundedKey(d.latitude, d.longitude);
            demandByCoord.set(key, d);
        });
    }

    // Build coordinate-based lookup for reliability data
    // NOTE: Using 2 decimals because the source voronoi_grid_reliability.csv has 2-decimal precision
    const reliabilityByCoord = new Map();
    if (reliabilityData && reliabilityData.length > 0) {
        reliabilityData.forEach(d => {
            const key = roundedKey(d.latitude, d.longitude, 2);
            reliabilityByCoord.set(key, d);
        });
    }

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    popData.forEach(d => {
        const key = roundedKey(d.latitude, d.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);
        const capacity = capacityCoordMap ? capacityCoordMap.get(key) : null;
        const capacityLines = formatCapacityLines(capacity);

        // Overlay data for the tooltip
        let overlayData = null;
        if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
            overlayData = cfRow;
        } else if (overlayMode === 'lcoe' && lcoeScale && lcoeColorInfo && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
            overlayData = lcoeRow;
        }

        const demandRow = demandByCoord.get(key);
        const demandVal = demandRow ? (demandRow.annual_demand_kwh || 0) : 0;
        const demandTwh = demandVal / 1e9; // Convert kWh to TWh

        const populationLine = baseLayer === 'population'
            ? `<div class="mt-1 text-muted">Population: ${formatNumber(d.population_2020 || 0, 0)}</div>`
            : baseLayer === 'electricity'
                ? `<div class="mt-1 text-muted">Annual Demand: ${demandTwh.toFixed(2)} TWh</div>`
                : '';

        const shouldShowHitMarker = true; // Always allow hover for tooltip
        if (shouldShowHitMarker) {
            const marker = createHitTarget([d.latitude, d.longitude], HIT_RADIUS);

            marker.on('mouseover', () => {
                let content;
                if (overlayMode === 'lcoe' && overlayData) {
                    const valueLine = overlayData.meetsTarget || overlayData.includeDieselBackup
                        ? `LCOE: ${Number.isFinite(overlayData.lcoe) ? formatCurrency(overlayData.lcoe) : '--'}/MWh`
                        : `LCOE: ${Number.isFinite(overlayData.maxConfigLcoe) ? `>${formatCurrency(overlayData.maxConfigLcoe)}` : '--'}/MWh`;
                    let infoLines = '';
                    if (overlayData.meetsTarget) {
                        if (lcoeColorInfo?.type === 'tx' && overlayData.txMetrics) {
                            const deltaLine = Number.isFinite(overlayData.delta)
                                ? `<div>Cost delta vs reference: ${overlayData.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(overlayData.delta), 2)}/MWh</div>`
                                : '';
                            const breakevenGw = `${formatCurrency(overlayData.txMetrics.breakevenPerGw / 1000)}/MW`;
                            const breakevenGwKm = `${formatCurrency(overlayData.txMetrics.breakevenPerGwKm / 1000)}/MW/km`;

                            const distanceLine = Number.isFinite(overlayData.txMetrics.distanceKm)
                                ? `<div>Approx. straight-line distance: ${formatNumber(overlayData.txMetrics.distanceKm, 0)} km</div>`
                                : `<div>Approx. straight-line distance: --</div>`;

                            // Cleaned up info lines: Removed redundant savings line, ensures prompt TX cost display
                            infoLines = `${deltaLine}\n<div>Breakeven transmission: ${breakevenGw} (${breakevenGwKm})</div>\n${distanceLine}`;
                        } else if (lcoeColorInfo?.type === 'delta' && Number.isFinite(overlayData.delta)) {
                            infoLines = `<div>Cost delta vs reference: ${overlayData.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(overlayData.delta), 2)}/MWh</div>`;
                        }
                    } else {
                        infoLines = overlayData.includeDieselBackup
                            ? `<div class="text-amber-300">Target not met – showing the highest-share firm build</div>`
                            : `<div class="text-amber-300">Target not met</div>`;
                        if (!overlayData.includeDieselBackup) {
                            infoLines += `<div>Highest-CF build: ${formatMaxConfig(overlayData)}</div>`;
                        }
                    }
                    const dieselLines = buildDieselBackupLines(overlayData, formatCurrency).join('');
                    content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">${valueLine}</div>
                    <div>${buildLcoeConfigLine(overlayData)}</div>
                    ${dieselLines}
                    ${infoLines}
                    ${populationLine}
                    ${capacityLines}
                 </div>`;
                } else if (overlayMode === 'cf' && overlayData) {
                    content = buildCfTooltip(overlayData.annual_cf, overlayData.solar_gw, overlayData.batt_gwh,
                        overlayData.wind_gw, overlayData.wind_surface, [populationLine, capacityLines], windSplitOf(overlayData), overlayData);
                } else if (baseLayer === 'uptime') {
                    const relKey = roundedKey(d.latitude, d.longitude, 2);
                    const relData = reliabilityByCoord.get(relKey);
                    const hasData = relData && relData.hrea_covered;
                    let metricLine = '';
                    if (hasData) {
                        const val = relData.avg_reliability_access_only !== undefined ? relData.avg_reliability_access_only : relData.avg_reliability;
                        metricLine = `<div class="font-semibold text-white">Grid Reliability: ${val.toFixed(1)}%</div>
                                      <div class="text-[10px] text-muted">Share of time the local grid is operational</div>`;
                    } else {
                        metricLine = `<div class="font-semibold text-muted">Grid Reliability: No data available</div>`;
                    }
                    content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    ${metricLine}
                    ${populationLine}
                 </div>`;
                } else if (overlayMode === 'access' || baseLayer === 'access') {
                    // Access mode - show reliability (use 2 decimals for lookup)
                    const relKey = roundedKey(d.latitude, d.longitude, 2);
                    const relData = reliabilityByCoord.get(relKey);

            const hasData = relData && relData.hrea_covered;
            const hreaCovered = relData ? (relData.hrea_covered ? 'Yes' : 'No') : '--';

            let metricLine = '';
            if (hasData) {
                const relVal = (relData.avg_reliability_access_only || 0).toFixed(1) + '%';
                const noAccessVal = ((relData.pct_no_access || 0) * 100).toFixed(1) + '%';

                // Highlight the active metric
                if (currentAccessMetric === 'no_access_pop') {
                    const popNoAccess = (relData.total_pop_reliability || 0) * (relData.pct_no_access || 0);
                    metricLine = `<div class="font-semibold">Without Access: ${(popNoAccess / 1e6).toFixed(2)} million</div>
                                   <div class="text-muted text-[10px]">Percentage: ${noAccessVal}</div>`;
                } else if (currentAccessMetric === 'no_access') {
                    metricLine = `<div class="font-semibold">No Access: ${noAccessVal}</div>
                                           <div class="text-muted text-[10px]">Grid Reliability (connected): ${relVal}</div>`;
                } else {
                    metricLine = `<div class="font-semibold">Grid Reliability: ${relVal}</div>
                                           <div class="text-muted text-[10px]">No Access: ${noAccessVal}</div>`;
                        }
                    } else {
                        metricLine = `<div class="font-semibold">Average Grid Uptime: No Data</div>`;
                    }

                    content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    ${metricLine}
                    <div class="text-muted">HREA Data Available: ${hreaCovered}</div>
                    ${populationLine}
                    ${capacityLines}
                 </div>`;
                } else {
                    const baseInfo = populationLine || '<div class="mt-1 text-muted">Installed capacity summary:</div>';
                    content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    ${baseInfo}
                    ${capacityLines}
                 </div>`;
                }
                sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(appendCountryLine(content, d)).openOn(map);
            });

            marker.on('mouseout', () => {
                map.closePopup(sharedPopup);
            });

            marker.on('click', () => {
                if (map.onLocationSelect) {
                    map.onLocationSelect({ ...d, ...overlayData, population_2020: d.population_2020 }, overlayMode === 'lcoe' ? 'lcoe' : overlayMode === 'cf' ? 'capacity' : 'population');
                }
            });

            d.__hitMarker = marker;
            if (!(marker instanceof HitTarget)) marker.addTo(markersLayer);
        }
    });

    // Larger plants first, so small ones stay visible on top (T075).
    const filteredPlants = baseLayer === 'plants' && Array.isArray(fossilPlants)
        ? fossilPlants.filter(plant => selectedFuelSet.has(plant.fuel_group) && plant.status === selectedStatus)
            .sort((a, b) => (b.capacity_mw || 0) - (a.capacity_mw || 0))
        : [];
    if (typeof window !== 'undefined') window.__plantsDrawn = filteredPlants.length;

    if (filteredPlants.length) {
        const plantPopup = L.popup({
            closeButton: false,
            autoPan: false,
            className: 'bg-transparent border-none shadow-none'
        });
        filteredPlants.forEach(plant => {
            if (!Number.isFinite(plant.latitude) || !Number.isFinite(plant.longitude)) return;
            // Fill from the registry, the same entry the fuel chips show (T075).
            const color = FOSSIL_COLORS[plant.fuel_group] || DATA_COLOURS.plantFallback;
            const baseCapacity = Number.isFinite(plant.capacity_mw) ? Math.max(plant.capacity_mw, 0) : 0;
            const radius = PLANT_MARKER.radius(baseCapacity);
            const marker = L.circleMarker([plant.latitude, plant.longitude], {
                radius,
                fillColor: color,
                color: PLANT_MARKER.stroke,
                weight: PLANT_MARKER.strokeWeight,
                opacity: 1,
                fillOpacity: PLANT_MARKER.fillOpacity,
                pane: 'markers',
                renderer: markerRenderer
            });
            marker.on('mouseover', () => {
                const cap = formatNumber(baseCapacity, 0);
                const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">${plant.plant_name || 'Power plant'}</div>
                    <div>${FUEL_LABELS[plant.fuel_group] || plant.fuel_group} • ${cap} MW</div>
                    <div class="text-muted">${capitalizeWord(plant.status)}</div>
                    <div class="text-muted">${plant.country || 'Unknown'}</div>
                 </div>`;
                plantPopup.setLatLng([plant.latitude, plant.longitude]).setContent(content).openOn(map);
            });
            marker.on('mouseout', () => map.closePopup(plantPopup));
            marker.addTo(overlayLayer);
        });
    }

    // Hoist per-cell scales out of the fill closures — one allocation per render
    // instead of one per Voronoi cell.
    // Access share and reliability: green ramp, more = lighter. People without
    // access: orange ramp on a log scale, more = brighter.
    const reliabilityColorScale = rampScale('green', [0, 100]);
    const noAccessPopScale = rampScale('no_access', [100, 1000000]);

    // Define base layer fill function (demand layer)
    const baseFill = (d) => {
        if (baseLayer === 'uptime') {
            // Grid reliability: green ramp
            const relKey = roundedKey(d.latitude, d.longitude, 2);
            const rel = reliabilityByCoord.get(relKey);

            if (!rel || !rel.hrea_covered) return NO_DATA_COLOR; // No data

            const gridUptime = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
            return reliabilityColorScale(gridUptime);
        }
        if (baseLayer === 'access') {
            // Use coordinate-based lookup with 2 decimals to match source data
            const relKey = roundedKey(d.latitude, d.longitude, 2);
            const rel = reliabilityByCoord.get(relKey);

            if (currentAccessMetric === 'no_access_pop') {
                // Not covered by HREA is no data (black), as in the other modes, not
                // "universal access" (T075: uncovered cells were drawn navy).
                if (!rel || !rel.hrea_covered) return NO_DATA_COLOR;
                const popNoAccess = (rel.total_pop_reliability || 0) * (rel.pct_no_access || 0);
                if (popNoAccess <= 0) return DATA_COLOURS.universalAccess; // navy: universal access
                return noAccessPopScale(Math.max(1, popNoAccess));
            }

            if (!rel) return NO_DATA_COLOR; // No data
            if (!rel.hrea_covered) return NO_DATA_COLOR;

            // Determine value based on metric
            let val = 0;
            if (currentAccessMetric === 'no_access') {
                // High no access (1.0) -> Bad (Red). Low no access (0.0) -> Good (Green).
                // Scale expects 0->Red, 100->Green.
                // Map: 1 - pct (0..1) -> 0..1 * 100 -> 0..100.
                const pct = rel.pct_no_access || 0;
                if (pct <= 0) return DATA_COLOURS.transparent; // Hide if everyone has access
                val = (1 - pct) * 100;
            } else {
                // Reliability: 0->Red (Low), 100->Green (High)
                // Use access_only metric if available, else standard
                val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
            }

            // Scale 0-100 -> color (Red low -> Grey high)
            return reliabilityColorScale(val);
        } else if (baseLayer === 'electricity') {
            const key = roundedKey(d.latitude, d.longitude);
            const demandRow = demandByCoord.get(key);
            const val = demandRow ? (demandRow.annual_demand_kwh || 0) : 0;
            if (val > 0 && demandScale) {
                return demandScale(val);
            }
            return NO_DATA_COLOR; // slate-800 for no data
        } else if (baseLayer === 'population') {
            const popVal = d.population_2020 || 0;
            return popScale(popVal);
        } else if (baseLayer === 'plants') {
            return DATA_COLOURS.transparent;
        }
        return DATA_COLOURS.transparent;
    };

    // Define overlay fill function (supply layer)
    const overlayFill = overlayMode !== 'none' ? (d) => {
        const key = roundedKey(d.latitude, d.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);

        if (overlayMode === 'access') {
            const relKey = roundedKey(d.latitude, d.longitude, 2);
            const rel = reliabilityByCoord.get(relKey);
            if (!rel) return NO_DATA_COLOR;
            if (!rel.hrea_covered) return NO_DATA_COLOR; // No Data

            // Determine value based on metric
            let val = 0;
            if (currentAccessMetric === 'no_access_pop') {
                const popNoAccess = (rel.total_pop_reliability || 0) * (rel.pct_no_access || 0);
                if (popNoAccess <= 0) return DATA_COLOURS.universalAccess;
                return noAccessPopScale(Math.max(1, popNoAccess));
            } else if (currentAccessMetric === 'no_access') {
                const pct = rel.pct_no_access || 0;
                if (pct <= 0) return DATA_COLOURS.transparent; // Hide if everyone has access
                val = (1 - pct) * 100;
            } else {
                val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
            }

            // Scale 0-100 -> color (Red low -> Grey high)
            return reliabilityColorScale(val);
        } else if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
            return getColor(cfRow.annual_cf);
        } else if (overlayMode === 'lcoe' && lcoeScale && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
            return getLcoeColor(lcoeRow, lcoeColorInfo, lcoeScale);
        }
        return null; // null means no overlay color for this cell
    } : null;

    // Use dual-layer rendering to show both demand and supply with transparency
    renderVoronoiDual(popData, baseFill, overlayFill, { hitRadius: HIT_RADIUS });
}

export function updateSupplyMap({ overlayMode = 'none', cfData = [], lcoeData = [], lcoeColorInfo = null, potentialState = null } = {}) {
    if (!supplyMap || !supplyVoronoiLayer) return;
    lastSupplyState = { overlayMode, cfData, lcoeData, lcoeColorInfo, potentialState };

    if (supplyMarkersLayer) supplyMarkersLayer.clearLayers();
    if (supplyOverlayLayer) supplyOverlayLayer.clearLayers();
    d3.select(supplyVoronoiLayer._container).selectAll("*").remove();

    if (overlayMode === 'none') {
        supplyDataByCoord = new Map();
        supplyVoronoiIndex = new Map();
        activeSupplyHoverKey = null;
        if (supplyPopup) {
            supplyMap.closePopup(supplyPopup);
        }
        return;
    }

    const data = overlayMode === 'cf'
        ? cfData
        : overlayMode === 'lcoe'
            ? lcoeData
            : overlayMode === 'potential'
                ? (potentialState?.data || [])
                : [];
    if (!data || data.length === 0) return;

    supplyDataByCoord = new Map(data.map(d => [roundedKey(d.latitude, d.longitude), d]));

    const potentialKey = potentialState?.level === 'level2' ? 'total_level2_twh_y' : 'total_level1_twh_y';
    const potentialFallbackKey = potentialState?.level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
    const potentialIsMultiple = potentialState?.displayMode === 'multiple';
    const potentialIsPerCapita = potentialState?.displayMode === 'per_capita';
    const potentialNoDataColor = NO_DATA_COLOR;
    const potentialScale = overlayMode === 'potential' && potentialState && potentialState.valueCount
        ? (potentialIsMultiple
            ? (val) => bucketColor(POTENTIAL_MULTIPLE_BUCKETS, val)
            : potentialIsPerCapita
                ? (val) => bucketColor(POTENTIAL_PER_CAPITA_BUCKETS, val)
                : rampScale('green', [potentialState.min, potentialState.max]))
        : null;

    const colorScale = overlayMode === 'lcoe' && lcoeColorInfo
        ? buildLcoeColorScaleFromInfo(lcoeColorInfo)
        : null;

    const getFill = (row) => {
        if (overlayMode === 'cf') {
            return getColor(row.annual_cf);
        }
        if (overlayMode === 'lcoe' && lcoeColorInfo && colorScale) {
            return getLcoeColor(row, lcoeColorInfo, colorScale);
        }
        if (overlayMode === 'potential' && potentialState && potentialScale) {
            const rawTotal = Number(row[potentialKey]);
            const totalVal = Number.isFinite(rawTotal) ? rawTotal : Number(row[potentialFallbackKey] || 0);
            const latVal = Number(row.latitude);
            const bounds = potentialState.latBounds;
            if (bounds && (!Number.isFinite(latVal) || latVal < bounds.min || latVal > bounds.max)) {
                return potentialNoDataColor;
            }
            let value = totalVal;
            if (potentialIsMultiple) {
                const demandRow = potentialState.demandMap ? potentialState.demandMap.get(row.location_id) : null;
                const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
                const demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
                if (demandTwh <= 0) return potentialNoDataColor;
                value = totalVal / demandTwh;
            } else if (potentialIsPerCapita) {
                const pop = potentialState.populationMap ? Number(potentialState.populationMap.get(row.location_id) || 0) : 0;
                if (!(pop > 0)) return potentialNoDataColor;
                value = (totalVal * 1e6) / pop;
            }
            return potentialScale(value || 0);
        }
        return DATA_COLOURS.transparent;
    };

    ensureSupplyPopup();

    let lastSupplyHoverRow = null;

    const onHover = (e, d) => {
        const content = buildSupplyTooltipHtml(d, overlayMode, potentialState);
        if (content && supplyPopup) {
            supplyPopup.setLatLng([d.latitude, d.longitude]).setContent(appendCountryLine(content, d)).openOn(supplyMap);
        }
        lastSupplyHoverRow = d;
        syncHoverToDemand(d);
    };

    const onOut = () => {
        if (supplyPopup) {
            supplyMap.closePopup(supplyPopup);
        }
        if (lastSupplyHoverRow) {
            syncOutToDemand(lastSupplyHoverRow);
            lastSupplyHoverRow = null;
        }
    };

    renderVoronoi(
        data,
        (row) => getFill(row),
        {
            enableHoverSelect: true,
            useMarkerEvents: false,
            onHover,
            onOut,
            hatch: overlayMode === 'cf' || overlayMode === 'lcoe' ? windNotViable : null,
            context: { map: supplyMap, voronoiLayer: supplyVoronoiLayer }
        }
    );
}

function renderVoronoiDual(data, baseFill, overlayFill, options = {}) {
    // Canvas dual path: draw base+overlay on the primary canvas layer. The cross-map
    // hover sync is preserved by wrapping onHover/onOut to also call sync*ToSupply
    // (the canvas layer itself draws the rim + fires marker events). demandVoronoiIndex
    // is left cleared — on canvas, highlightKey(key) replaces the DOM-element lookup.
    if (resolveVoronoiCanvas()) {
        d3.select(voronoiLayer._container).selectAll("*").remove();
        demandVoronoiIndex = new Map();
        if (data.length <= 1 || (typeof baseFill !== 'function' && typeof overlayFill !== 'function')) {
            getCanvasLayer(map)?.hide();
            return;
        }
        ensureVoronoiCanvas(map).renderDual(data, baseFill, overlayFill, worldGeoJSON, {
            enableHoverSelect: true,
            useMarkerEvents: true,
            hitRadius: options.hitRadius || 0,
            options: {
                onHover: (e, d) => { syncHoverToSupply(d); if (options.onHover) options.onHover(e, d); },
                onOut: (e, d) => { syncOutToSupply(d); if (options.onOut) options.onOut(e, d); },
                onClick: (d) => { if (options.onClick) options.onClick(null, d); },
            },
        });
        return;
    }

    // Dual render uses SVG; hide the canvas Voronoi so it doesn't overlay these cells.
    getCanvasLayer(map)?.hide();
    const svg = d3.select(voronoiLayer._container);
    svg.selectAll("*").remove();

    if (data.length <= 1) return;

    demandVoronoiIndex = new Map();

    const hasBase = typeof baseFill === 'function';
    const hasOverlay = typeof overlayFill === 'function';
    if (!hasBase && !hasOverlay) return;

    let path = null;
    const clipId = map._leaflet_id ? `clip-land-${map._leaflet_id}` : 'clip-land-main';
    if (worldGeoJSON) {
        const transform = d3.geoTransform({
            point: function (x, y) {
                const point = map.latLngToLayerPoint(new L.LatLng(y, x));
                this.stream.point(point.x, point.y);
            },
        });
        path = d3.geoPath().projection(transform);

        svg.select("defs").remove();
        const defs = svg.append("defs");
        defs
            .append("clipPath")
            .attr("id", clipId)
            .append("path")
            .datum(worldGeoJSON)
            .attr("d", path);
    }

    const clip = worldGeoJSON ? `url(#${clipId})` : null;
    const size = map.getSize();
    const buffer = Math.max(size.x, size.y);
    const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
    const delaunay = d3.Delaunay.from(layerPointsOf(map, data));
    const voronoi = delaunay.voronoi(bounds);

    // When both layers are present, use lower opacity so overlap is visible
    const baseOpacity = hasOverlay ? 0.5 : 0.85;
    const overlayOpacity = hasBase ? 0.5 : 0.35;

    const handleOver = function (e, d) {
        applyHoverRim(this);
        fireMarkerEvent(d, 'mouseover');
        syncHoverToSupply(d);
        if (options.onHover) options.onHover(e, d);
    };

    const handleOut = function (e, d) {
        clearHoverRim(this);
        fireMarkerEvent(d, 'mouseout');
        syncOutToSupply(d);
        if (options.onOut) options.onOut(e, d);
    };

    const handleClick = function (e, d) {
        fireMarkerEvent(d, 'click');
        if (options.onClick) options.onClick(e, d);
    };

    if (hasBase) {
        const base = svg.append("g").attr("clip-path", clip);
        base
            .selectAll("path")
            .data(data)
            .enter()
            .append("path")
            .attr("d", (_, i) => voronoi.renderCell(i))
            .attr("fill", d => baseFill ? baseFill(d) : NO_DATA_COLOR)
            .attr("fill-opacity", baseOpacity)
            .attr("stroke", "rgba(255,255,255,0.08)")
            .attr("stroke-width", 0.5)
            .attr("class", "transition-color voronoi-cell leaflet-interactive")
            .style("pointer-events", hasOverlay ? "none" : "all")
            .each(function (d) {
                if (hasOverlay) return;
                const key = getRowKey(d);
                if (key) demandVoronoiIndex.set(key, this);
            })
            .on("mouseover", function (e, d) {
                if (hasOverlay) return;
                handleOver.call(this, e, d);
            })
            .on("mouseout", function (e, d) {
                if (hasOverlay) return;
                handleOut.call(this, e, d);
            })
            .on("click", function (e, d) {
                if (hasOverlay) return;
                handleClick.call(this, e, d);
            });
    }

    if (hasOverlay) {
        svg
            .append("g")
            .attr("clip-path", clip)
            .selectAll("path")
            .data(data)
            .enter()
            .append("path")
            .attr("d", (_, i) => voronoi.renderCell(i))
            .attr("fill", d => overlayFill(d) || DATA_COLOURS.transparent)
            .attr("fill-opacity", overlayOpacity)
            .attr("stroke", "none")
            .attr("class", "transition-color voronoi-cell leaflet-interactive")
            .style("pointer-events", "all")
            .each(function (d) {
                const key = getRowKey(d);
                if (key) demandVoronoiIndex.set(key, this);
            })
            .on("mouseover", function (e, d) {
                handleOver.call(this, e, d);
            })
            .on("mouseout", function (e, d) {
                handleOut.call(this, e, d);
            })
            .on("click", function (e, d) {
                handleClick.call(this, e, d);
            });
    }
}

export function updatePopulationGeo(popData, geojson, { overlayMode = 'none', cfData = [], lcoeData = [], lcoeDomain = null } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;
    resetLayersForMode('population');
    markersLayer.clearLayers();

    if (!popData || popData.length === 0 || !geojson) return;

    const popByCoord = new Map(popData.map(p => [roundedKey(p.latitude, p.longitude), p.population_2020 || 0]));
    const scale = buildPopulationScale(popData.map(p => p.population_2020 || 0));
    const cfByCoord = new Map(cfData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeScale = overlayMode === 'lcoe' && lcoeDomain ? buildLcoeScale(lcoeDomain) : null;

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    const layer = L.geoJSON(geojson, {
        style: (feature) => {
            const props = feature.properties || {};
            const lat = Number(props.latitude);
            const lon = Number(props.longitude);
            const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
            const popVal = key ? popByCoord.get(key) || 0 : 0;
            const color = scale(popVal);
            return {
                color: color,
                weight: 0.3,
                fillColor: color,
                fillOpacity: 0.85
            };
        },
        onEachFeature: (feature, lyr) => {
            const props = feature.properties || {};
            const lat = Number(props.latitude);
            const lon = Number(props.longitude);
            const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
            const popVal = key ? popByCoord.get(key) || 0 : 0;
            lyr.on('mouseover', (e) => {
                const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">Population: ${formatNumber(popVal, 0)}</div>
                    ${buildCountryLineFor(props)}
                 </div>`;
                sharedPopup.setLatLng(e.latlng).setContent(content).openOn(map);
            });
            lyr.on('mouseout', () => map.closePopup());
            lyr.on('click', () => {
                const center = lyr.getBounds().getCenter();
                const clickLat = Number.isFinite(center?.lat) ? center.lat : lat;
                const clickLon = Number.isFinite(center?.lng) ? center.lng : lon;
                if (map.onLocationSelect) {
                    map.onLocationSelect({ latitude: clickLat, longitude: clickLon, population_2020: popVal }, 'population');
                }
            });
        }
    });

    layer.addTo(markersLayer);

    // Overlay layer on top of population
    if (overlayMode === 'cf' || overlayMode === 'lcoe') {
        const overlay = L.geoJSON(geojson, {
            style: (feature) => {
                const props = feature.properties || {};
                const lat = Number(props.latitude);
                const lon = Number(props.longitude);
                const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
                const cfRow = key ? cfByCoord.get(key) : null;
                const lcoeRow = key ? lcoeByCoord.get(key) : null;
                let color = DATA_COLOURS.transparent;
                let hasData = false;
                if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
                    color = getColor(cfRow.annual_cf);
                    hasData = true;
                } else if (overlayMode === 'lcoe' && lcoeScale && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
                    color = lcoeScale(lcoeRow.lcoe);
                    hasData = true;
                }
                return {
                    color: hasData ? color : DATA_COLOURS.transparent,
                    weight: 0,
                    fillColor: hasData ? color : DATA_COLOURS.transparent,
                    fillOpacity: hasData ? 0.35 : 0
                };
            },
            interactive: false
        });
        overlay.addTo(overlayLayer);
    }
}

// Wind on the Potential map (T014, D-069; team/evidence/wind-potential.md §6, §8; T083).
// Generation potential (TWh/yr) = capacity (GW) × capacity factor × 8,760 h / 1,000.
// Two definitions (spec.definition):
//  'tech'  onshore Technical: pixel by pixel, each pixel's own net CF before calibration,
//          5 MW/km² on pixels at >= 15%; offshore on the IEA (2019) definition.
//  'cons'  onshore Conservative (T078, D-150); offshore on the World Bank/ESMAP definition.
// Every definition's numbers come per cell from voronoi_wind_potential_defs.csv
// (t083/potential_defs.py), fixed-bottom and floating each from its own sea; a cell with
// capacity but no estimate there has no estimate here.
const TWH_PER_GW_CF = 8.76;
export const WIND_CF_DOMAIN = [RAMPS.resource_cf.domain[0], RAMPS.resource_cf.domain[RAMPS.resource_cf.domain.length - 1]];
const POTENTIAL_TECH_NAMES = {
    solar: 'Solar',
    onshore: 'Onshore wind',
    offshore: 'Offshore wind (fixed-bottom)',
    floating: 'Floating offshore wind (not costed)',
    all: 'Solar + wind'
};
/** Display name of what the Potential map shows: 'floating' for the offshore floating layer. */
export function potentialTechName(tech, offshoreLayer = 'fixed') {
    if (tech === 'offshore' && offshoreLayer === 'floating') return POTENTIAL_TECH_NAMES.floating;
    return POTENTIAL_TECH_NAMES[tech] || POTENTIAL_TECH_NAMES.solar;
}

/**
 * One cell of the Potential map. spec: { tech ('solar'|'onshore'|'offshore'|'all'),
 * level, latBounds, metric ('generation'|'wind_cf'), definition ('tech'|'cons'),
 * offshoreLayer ('fixed'|'floating'), windSites (location_id -> wind resource row),
 * offshore (location_id -> ESMAP row with .defs, the definitions row) }. Returns { value, noData, reason, parts, gw, cf, onEligible }:
 * value is TWh/yr (the capacity factor, 0–1, for 'wind_cf'); parts are TWh/yr per
 * technology (null = unknown); gw is the wind capacity counted.
 */
export function potentialCell(row, spec) {
    const tech = spec.tech || 'solar';
    const out = { value: null, noData: false, reason: null, parts: { solar: null, onshore: null, offshore: null }, gw: { onshore: null, offshore: null }, cf: null };
    const wantsSolar = tech === 'solar' || tech === 'all';
    if (wantsSolar) {
        const level = spec.level || 'level1';
        const raw = Number(row[level === 'level2' ? 'total_level2_twh_y' : 'total_level1_twh_y']);
        const total = Number.isFinite(raw) ? raw : Number(row[level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y'] || 0);
        const lat = Number(row.latitude);
        const b = spec.latBounds;
        const outside = b ? (!Number.isFinite(lat) || lat < b.min || lat > b.max) : false;
        out.parts.solar = outside ? null : total;
        if (tech === 'solar') {
            out.value = total;
            out.noData = outside;
            if (outside) out.reason = 'no_solar_data';
            return out;
        }
    }
    const s = spec.windSites ? spec.windSites.get(row.location_id) : null;
    const wantsOnshore = tech === 'onshore' || tech === 'all';
    const wantsOffshore = tech === 'offshore' || tech === 'all';
    const floating = tech === 'offshore' && spec.offshoreLayer === 'floating';
    const cons = spec.definition === 'cons';
    const o = spec.offshore ? spec.offshore.get(row.location_id) : null;
    const defs = o ? o.defs : null;
    const cfOf = (gw, twh) => (gw > 0 && twh > 0 ? twh / (gw * TWH_PER_GW_CF) : null);
    if (wantsOnshore && s) {
        out.onEligible = Boolean(s.on_viable);
        const key = cons ? 'on_cons' : 'on_tech';
        const gw = s.on_viable && defs ? (defs[`${key}_gw`] || 0) : 0;
        const twh = defs ? defs[`${key}_twh`] : null;
        out.gw.onshore = gw;
        out.cf = cfOf(gw, twh);
        out.parts.onshore = gw > 0 ? (Number.isFinite(twh) ? twh : null) : 0;
    }
    if (wantsOffshore) {
        const key = `${floating ? 'fl' : 'fix'}_${cons ? 'esmap' : 'iea'}`;
        const esmapGw = o ? ((floating ? o.floating_gw : o.fixed_gw) || 0) : null;
        // ESMAP capacity in a cell with none of its class's sea eligible: shown, but no estimate.
        let gw = defs ? defs[`${key}_gw`] : (cons ? esmapGw : (o ? 0 : null));
        if (gw === null && cons) gw = esmapGw;
        const twh = defs ? defs[`${key}_twh`] : null;
        out.gw.offshore = gw;
        out.seaGw = cons ? esmapGw : gw;
        const cf = cfOf(gw, twh);
        if (tech === 'offshore') out.cf = cf;
        out.parts.offshore = gw === null ? null : gw > 0 ? (Number.isFinite(twh) && twh > 0 ? twh : null) : 0;
    }
    if (spec.metric === 'wind_cf' && (tech === 'onshore' || tech === 'offshore')) {
        out.value = out.cf;
        out.noData = !(out.cf > 0);
        if (out.noData) out.reason = s ? 'not_viable' : 'no_wind_data';
        return out;
    }
    if (tech === 'all') {
        const known = [out.parts.solar, out.parts.onshore, out.parts.offshore].filter(Number.isFinite);
        out.value = known.reduce((a, v) => a + v, 0);
        out.noData = !known.length;
        if (out.noData) out.reason = 'no_data';
        return out;
    }
    // Offshore x demand (D-146): a cell with no sea has no offshore estimate, not "< 1x".
    if (tech === 'offshore' && spec.multiple && out.seaGw === 0) {
        out.value = null;
        out.noData = true;
        out.reason = 'no_sea';
        return out;
    }
    const part = tech === 'onshore' ? out.parts.onshore : out.parts.offshore;
    out.value = part;
    out.noData = !Number.isFinite(part);
    if (out.noData) {
        out.reason = !s && tech === 'onshore' ? 'no_wind_data'
            : tech === 'offshore' && out.gw.offshore > 0 ? 'no_offshore_cf' : 'no_data';
    }
    return out;
}

const fmtGw = gw => `${formatNumber(gw, gw >= 100 ? 0 : 1)} GW`;
const fmtTwh = twh => `${formatNumber(twh, 2)} TWh/yr`;

// Breakdown line(s) under the headline of a wind Potential tooltip.
function windPotentialDetail(cell, spec) {
    const lines = [];
    const tech = spec.tech;
    const cfText = cf => (cf > 0 ? `${(cf * 100).toFixed(1)}% capacity factor` : '');
    if (tech === 'onshore') {
        const gw = cell.gw.onshore;
        if (gw > 0) lines.push(`${fmtGw(gw)} at ${spec.definition === 'cons' ? 3 : 5} MW/km² • ${cfText(cell.cf)}`);
        // Since D-123 a region with eligible land has wind even when none of it reaches 15%,
        // the line potential is counted from; only then is there land but no potential.
        else if (cell.onEligible) lines.push('No land reaches 15% capacity factor here, so no potential is counted');
        else lines.push('No eligible land for onshore wind');
    } else if (tech === 'offshore') {
        const gw = cell.gw.offshore;
        const kind = spec.offshoreLayer === 'floating' ? 'floating' : 'fixed-bottom';
        if (gw > 0) {
            lines.push(`${fmtGw(gw)} ${kind}${cell.cf ? ` • ${cfText(cell.cf)}` : ''}`);
            if (!cell.cf) lines.push('No eligible sea for offshore wind in the atlas, so no generation estimate');
        } else {
            lines.push(`No ${kind} potential in this cell`);
        }
    } else if (tech === 'all') {
        const part = (v, label) => `${label} ${Number.isFinite(v) ? fmtTwh(v) : 'n/a'}`;
        lines.push(`${part(cell.parts.solar, 'Solar')} • ${part(cell.parts.onshore, 'Onshore')} • ${part(cell.parts.offshore, 'Offshore')}`);
    }
    return lines.map(l => `<div class="text-muted">${l}</div>`).join('');
}

const POTENTIAL_NO_DATA_TEXT = {
    no_solar_data: 'No data available',
    no_wind_data: 'No wind data for this cell',
    not_viable: 'No eligible land or sea for wind',
    no_offshore_cf: 'No generation estimate',
    no_sea: 'No estimate: no sea in this cell',
    no_data: 'No data available'
};

export function updatePotentialMap(potentialData, options = {}) {
    const { level = 'level1', min = null, max = null, displayMode = 'total', demandMap = null, populationMap = null, latBounds = null,
        tech = 'solar', metric = 'generation', definition = 'tech', offshoreLayer = 'fixed', windSites = null, offshore = null } = options;
    lastPotentialArgs = [potentialData, options];
    currentMode = 'potential';
    selectedMarker = null;

    resetLayersForMode('potential');
    markersLayer.clearLayers();

    if (!potentialData || potentialData.length === 0) {
        if (FEATURE_VORONOI_GEOM_CACHE) clearVoronoiAndGeomCache();
        return;
    }

    const isSolar = tech === 'solar';
    const isWindCf = metric === 'wind_cf' && (tech === 'onshore' || tech === 'offshore');
    const spec = { tech, level, latBounds, metric: isWindCf ? 'wind_cf' : 'generation', definition, offshoreLayer,
        windSites: windSites || windSitesLookup, offshore, multiple: !isWindCf && displayMode === 'multiple' };
    const techName = potentialTechName(tech, offshoreLayer);
    const groundKey = level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
    const isMultiple = !isWindCf && displayMode === 'multiple';
    const isPerCapita = !isWindCf && displayMode === 'per_capita';
    const scaleOf = () => {
        const values = potentialData.map(d => potentialCell(d, spec).value).filter(v => Number.isFinite(v));
        return [values.length ? Math.min(...values) : 0, values.length ? Math.max(...values) : 1];
    };
    const [fallbackMin, fallbackMax] = Number.isFinite(min) && Number.isFinite(max) ? [min, max] : scaleOf();
    const scaleMin = Number.isFinite(min) ? min : fallbackMin;
    const scaleMax = Number.isFinite(max) ? max : fallbackMax;
    const noDataColor = NO_DATA_COLOR;

    const colorScale = isWindCf
        ? rampScale('resource_cf')
        : isMultiple
            ? (val) => bucketColor(POTENTIAL_MULTIPLE_BUCKETS, val)
            : isPerCapita
                ? (val) => bucketColor(POTENTIAL_PER_CAPITA_BUCKETS, val)
                : rampScale('green', [scaleMin, scaleMax]);

    // Per-capita = annual generation potential (MWh) ÷ zone population.
    const perCapitaOf = (totalTwh, locationId) => {
        const pop = populationMap ? Number(populationMap.get(locationId) || 0) : 0;
        return pop > 0 ? { value: (totalTwh * 1e6) / pop, population: pop } : { value: null, population: pop };
    };
    const demandTwhOf = (locationId) => {
        const demandRow = demandMap ? demandMap.get(locationId) : null;
        const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
        return demandKwh > 0 ? demandKwh / 1e9 : 0;
    };

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    potentialData.forEach(d => {
        const cell = potentialCell(d, spec);
        const total = cell.value;
        const ground = Number(d[groundKey] || 0);
        const rooftop = Number(d.rooftop_twh_y || 0);
        let ratio = null;
        let demandTwh = null;
        let perCapita = null;
        let population = null;
        const noData = cell.noData;
        let noDemand = false;
        let noPopulation = false;
        if (isMultiple) {
            demandTwh = demandTwhOf(d.location_id);
            ratio = demandTwh > 0 ? total / demandTwh : null;
            noDemand = demandTwh <= 0;
        } else if (isPerCapita) {
            const pc = perCapitaOf(total, d.location_id);
            perCapita = pc.value;
            population = pc.population;
            noPopulation = pc.value === null;
        }
        const marker = createHitTarget([d.latitude, d.longitude], POTENTIAL_HIT_RADIUS);

        marker.on('mouseover', () => {
            let mainLine = '';
            let demandLine = '';
            const label = isSolar ? 'Solar' : techName;
            if (noData) {
                mainLine = isSolar ? 'No data available' : (POTENTIAL_NO_DATA_TEXT[cell.reason] || 'No data available');
            } else if (isWindCf) {
                mainLine = `${techName} capacity factor: ${(total * 100).toFixed(1)}%`;
            } else if (isMultiple && noDemand) {
                mainLine = 'No demand data available';
            } else if (isPerCapita && noPopulation) {
                mainLine = 'No population data available';
            } else if (isMultiple) {
                mainLine = `${label} ${isSolar ? 'Potential' : 'potential'} / Demand: ${ratio !== null ? `${formatNumber(ratio, 2)}×` : '--'}`;
                demandLine = `<div class="text-muted">Demand: ${demandTwh ? `${formatNumber(demandTwh, 2)} TWh/yr` : '0 TWh/yr'}</div>`;
            } else if (isPerCapita) {
                mainLine = `${label} ${isSolar ? 'Potential per Capita' : 'potential per capita'}: ${perCapita !== null ? `${formatNumber(perCapita, 0)} MWh/person/yr` : '--'}`;
                demandLine = `<div class="text-muted">Population: ${population ? formatNumber(population, 0) : '0'}</div>`;
            } else {
                mainLine = `${label} ${isSolar ? 'Generation Potential' : 'generation potential'}: ${formatNumber(total, 2)} TWh/yr`;
            }
            let detail;
            let basis;
            if (isSolar) {
                const showBreakdown = !noData && (rooftop > 0 || ground > 0);
                detail = showBreakdown
                    ? `<div class="text-muted">Ground-mount: ${formatNumber(ground, 2)} TWh/yr • Rooftop: ${formatNumber(rooftop, 2)} TWh/yr</div>`
                    : '';
                basis = solarPotentialBasis(level, d);
            } else {
                detail = windPotentialDetail(cell, spec);
                const cons = definition === 'cons';
                basis = tech === 'onshore'
                    ? (cons ? 'Conservative • capacity factors scaled to new wind farms, land reaching 20%'
                        : 'Technical • each pixel\'s own capacity factor, land reaching 15% before calibration')
                    : tech === 'offshore'
                        ? (cons ? 'World Bank Group/ESMAP (2021, CC BY 4.0) capacity • to 1,000 m deep, 200 km out'
                            : 'IEA (2019) definition • to 2,000 m deep, 300 km out, 4.5 MW/km²')
                        : `Solar ${getPotentialLevelLabel(level).toLowerCase()} • onshore ${cons ? 'conservative' : 'technical'} • offshore fixed-bottom, ${cons ? 'ESMAP' : 'IEA'}`;
            }
            const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">${mainLine}</div>
                ${demandLine}
                ${detail}
                <div class="text-muted">${basis}</div>
                ${buildCountryLineFor(d)}
            </div>`;
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => {
            map.closePopup(sharedPopup);
        });

        marker.on('click', () => {
            const panelData = {
                ...d,
                potential_twh: total,
                potential_ratio: ratio,
                demand_twh: demandTwh,
                potential_level: level,
                potential_display: isWindCf ? 'wind_cf' : displayMode,
                potential_per_capita: perCapita,
                population,
                potential_no_data: noData,
                potential_no_demand: noDemand,
                potential_no_population: noPopulation,
                potential_tech: tech
            };
            if (map.onLocationSelect) {
                map.onLocationSelect(panelData, 'potential');
            }
        });

        d.__hitMarker = marker;
        if (!(marker instanceof HitTarget)) marker.addTo(markersLayer);
    });

    renderVoronoi(potentialData, (row) => {
        const cell = potentialCell(row, spec);
        if (cell.noData) return noDataColor;
        let value = cell.value;
        if (isMultiple) {
            const demandTwh = demandTwhOf(row.location_id);
            if (demandTwh <= 0) return noDataColor;
            value = cell.value / demandTwh;
        } else if (isPerCapita) {
            const pc = perCapitaOf(cell.value, row.location_id);
            if (pc.value === null) return noDataColor;
            value = pc.value;
        }
        return colorScale(value || 0);
    }, { hitRadius: POTENTIAL_HIT_RADIUS });
}

// The value a wind layer colours a cell by, as a tooltip line ('' on the LCOE layer).
function windLayerLine(d, colorInfo) {
    if (colorInfo?.type === 'wind_share' && Number.isFinite(d.windShare)) {
        return `<div class="text-wind">Wind share: ${(d.windShare * 100).toFixed(0)}% of solar + wind capacity</div>`;
    }
    if (colorInfo?.type === 'wind_saving' && d.noWindMeetsTarget !== undefined) {
        if (d.noWindMeetsTarget) {
            return `<div class="text-wind">Saving from wind: ${formatCurrency(Math.max(0, d.windSaving || 0), 1)}/MWh</div>`;
        }
        // T074: the comparator is the same technology filter with wind removed.
        const nw = getTechFilterNote()?.noWind;
        if (nw === undefined || nw === 'solar + battery') {
            return '<div class="text-wind">Solar and batteries alone miss the target here; wind is needed</div>';
        }
        return nw
            ? `<div class="text-wind">Solar alone misses the target here; wind is needed</div>`
            : '<div class="text-wind">No build without wind here; wind is needed</div>';
    }
    return '';
}

export function updateLcoeMap(bestData, options = {}) {
    currentMode = 'lcoe';
    const hooks = drawHooks('lcoe', options);
    lastLcoeData = bestData;
    lastLcoeOptions = options;
    selectedMarker = null;
    resetLayersForMode('lcoe');
    markersLayer.clearLayers();

    if (!bestData || bestData.length === 0) {
        if (FEATURE_VORONOI_GEOM_CACHE) clearVoronoiAndGeomCache();
        hooks.onDrawn?.([], { rows: [], copy: [] });
        return;
    }

    const targetCf = options.targetCf || null;
    const colorInfo = options.colorInfo || { type: 'lcoe', domain: null };
    const reference = options.reference || null;

    const colorScale = buildLcoeColorScaleFromInfo(colorInfo);

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    bestData.forEach(d => {
        // Hit marker
        const marker = createHitTarget([d.latitude, d.longitude], HIT_RADIUS);

        marker.on('mouseover', () => {
            if (d.noEligibleBuild) {     // T074: nothing eligible under the technology filter
                sharedPopup.setLatLng([d.latitude, d.longitude])
                    .setContent(noBuildTooltip('LCOE: --/MWh', [buildCountryLineFor(d)])).openOn(map);
                return;
            }
            let infoLines = '';
            if (d.meetsTarget) {
                if (reference) {
                    const deltaLine = Number.isFinite(d.delta)
                        ? `<div>Cost delta vs reference: ${d.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(d.delta), 2)}/MWh</div>`
                        : '';
                    const txMetrics = d.txMetrics;
                    const breakevenGw = txMetrics ? `${formatCurrency(txMetrics.breakevenPerGw / 1000)}/MW` : '--';
                    const breakevenGwKm = txMetrics ? `${formatCurrency(txMetrics.breakevenPerGwKm / 1000)}/MW/km` : '--';

                    const distanceLine = txMetrics && Number.isFinite(txMetrics.distanceKm)
                        ? `<div>Approx. straight-line distance: ${formatNumber(txMetrics.distanceKm, 0)} km</div>`
                        : `<div>Approx. straight-line distance: --</div>`;

                    // Cleaned up info lines: Removed redundant savings line, ensures prompt TX cost display
                    infoLines = `${deltaLine}
<div>Breakeven transmission: ${breakevenGw} (${breakevenGwKm})</div>
${distanceLine}`;
                } else if (Number.isFinite(d.delta)) {
                    infoLines = `<div>Cost delta vs reference: ${d.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(d.delta), 2)}/MWh</div>`;
                }
            } else {
                if (d.includeDieselBackup) {
                    infoLines = `<div class="text-amber-300">Target not met – showing the highest-share firm build</div>`;
                } else {
                    const maxText = Number.isFinite(d.maxConfigLcoe) ? `>${formatCurrency(d.maxConfigLcoe)}/MWh` : '--';
                    infoLines = `<div class="text-amber-300">Target not met</div>
                        <div>Highest-CF build: ${formatMaxConfig(d)}, at ${maxText}</div>`;
                }
            }
            const valueLine = d.meetsTarget || d.includeDieselBackup
                ? `LCOE: ${Number.isFinite(d.lcoe) ? formatCurrency(d.lcoe) : '--'}/MWh`
                : `LCOE: ${Number.isFinite(d.maxConfigLcoe) ? `>${formatCurrency(d.maxConfigLcoe)}` : '--'}/MWh`;
            const dieselLines = buildDieselBackupLines(d, formatCurrency).join('');
            const layerLine = d.meetsTarget ? windLayerLine(d, colorInfo) : '';
            const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">${valueLine}</div>
                ${layerLine}
                <div>${buildLcoeConfigLine(d)}</div>
                ${dieselLines}
                ${infoLines}
                ${buildCountryLineFor(d)}
             </div>`;
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => {
            map.closePopup(sharedPopup);
        });

        marker.on('click', () => {
            if (map.onLocationSelect) {
                map.onLocationSelect({ ...d, targetCf }, 'lcoe');
            }
        });

        d.__hitMarker = marker;
        if (!(marker instanceof HitTarget)) marker.addTo(markersLayer);
    });

    renderVoronoi(
        bestData,
        (row) => getLcoeColor(row, colorInfo, colorScale),
        { hitRadius: HIT_RADIUS, hatch: windNotViable, ...hooks }
    );
}

// Similar to updateLcoeMap but for CF display (Target LCOE mode)
export function updateCfMap(cfData, options = {}) {
    currentMode = 'lcoe_cf'; // Use distinct mode for Target Mode (CF Map)
    const hooks = drawHooks('lcoe_cf', options);
    lastCfData = cfData;
    lastCfOptions = options;
    selectedMarker = null;
    resetLayersForMode('lcoe_cf');
    markersLayer.clearLayers();

    if (!cfData || cfData.length === 0) {
        if (FEATURE_VORONOI_GEOM_CACHE) clearVoronoiAndGeomCache();
        hooks.onDrawn?.([], { rows: [], copy: [] });
        return;
    }

    const targetLcoe = options.targetLcoe || null;
    const colorInfo = options.colorInfo || { type: 'cf', domain: [0, 0.5, 1] };
    const reference = options.reference || null;

    const colorScale = buildLcoeColorScaleFromInfo(colorInfo);

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    cfData.forEach(d => {
        // Use d.meetsTarget if present, otherwise default to true (legacy safe)
        const meetsTarget = d.meetsTarget !== false;

        // Hit marker
        const marker = createHitTarget([d.latitude, d.longitude], HIT_RADIUS);

        marker.on('mouseover', () => {
            if (d.noEligibleBuild) {     // T074, as in updateLcoeMap
                sharedPopup.setLatLng([d.latitude, d.longitude])
                    .setContent(noBuildTooltip('CF: --', [buildCountryLineFor(d)])).openOn(map);
                return;
            }
            let infoLines = '';
            const targetLcoeMet = d.targetLcoeMet !== false;
            if (targetLcoeMet) {
                if (reference && Number.isFinite(d.delta)) {
                    const deltaSign = d.delta >= 0 ? '+' : '';
                    infoLines = `<div>CF delta vs reference: ${deltaSign}${(d.delta * 100).toFixed(1)}%</div>`;
                }
            } else {
                infoLines = `<div class="text-amber-300">Target LCOE not met.</div>
                    <div>Lowest LCOE config:</div>`;
            }

            const dieselLines = buildDieselBackupLines(d, formatCurrency).join('');
            const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">CF: ${meetsTarget ? formatFirmCfText(d) : '--'}</div>
                <div>Solar ${d.solar_gw} MW_DC${formatWindPart(d.wind_gw, d.wind_surface, windSplitOf(d))} | Battery ${formatBattery(d.batt_gwh)} MWh</div>
                ${worstYearLine(d)}
                ${addonBuildLine(d)}
                ${costWindSurfaceLine(d, windSitesFor(d))}
                <div>LCOE: ${formatCurrency(d.lcoe)}/MWh</div>
                ${dieselLines}
                ${infoLines}
                ${buildCountryLineFor(d)}
             </div>`;
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => {
            map.closePopup(sharedPopup);
        });

        marker.on('click', () => {
            if (map.onLocationSelect) {
                map.onLocationSelect({ ...d, targetLcoe, meetsTarget }, 'lcoe');
            }
        });

        d.__hitMarker = marker;
        if (!(marker instanceof HitTarget)) marker.addTo(markersLayer);
    });

    renderVoronoi(
        cfData,
        (row) => {
            const meetsTarget = row.meetsTarget !== false;
            return getLcoeColor({ ...row, lcoe: row.cf, meetsTarget }, colorInfo, colorScale);
        },
        { hitRadius: HIT_RADIUS, hatch: windNotViable, ...hooks }
    );
}

// ---- Canvas Voronoi (flag-gated) ------------------------------------------
// FEATURE_VORONOI_CANVAS routes the primary map's Voronoi through a single
// <canvas> (voronoi-canvas.js) instead of ~5,000 SVG paths. ?canvas=1 / ?canvas=0
// override the flag per page for A/B testing. The layer is created lazily.
// One canvas layer per Leaflet map (primary, supply, ...) — keyed by the map so
// the dual/supply views can each have their own canvas without colliding.
const canvasLayerByMap = new Map();
let _voronoiCanvasOverride; // undefined until first resolved
function resolveVoronoiCanvas() {
    if (_voronoiCanvasOverride === undefined) {
        _voronoiCanvasOverride = null;
        try {
            const q = new URLSearchParams(location.search);
            if (q.has('canvas')) _voronoiCanvasOverride = q.get('canvas') !== '0';
        } catch (_) { /* no URL access */ }
    }
    return _voronoiCanvasOverride !== null ? _voronoiCanvasOverride : FEATURE_VORONOI_CANVAS;
}
function ensureVoronoiCanvas(targetMap = map) {
    let layer = canvasLayerByMap.get(targetMap);
    if (!layer) {
        layer = createVoronoiCanvasLayer(targetMap, d3, L, { getColor, fireMarkerEvent, getRowKey });
        canvasLayerByMap.set(targetMap, layer);
    }
    return layer;
}
function getCanvasLayer(targetMap = map) {
    return canvasLayerByMap.get(targetMap) || null;
}
// Layer points of the rows' sites; only the SVG paths need them (the canvas layer
// projects its own).
function layerPointsOf(targetMap, rows) {
    return rows.map(d => {
        const point = targetMap.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });
}

// The hatched cells of an SVG cell selection, with each one's fill opacity.
function svgHatchItems(cells, hatch) {
    const items = [];
    if (typeof hatch !== 'function') return items;
    cells.each(function (cell) {
        if (hatch(cell.row)) items.push({ key: cell.key, path: cell.path, opacity: this.getAttribute('fill-opacity') });
    });
    return items;
}

function renderVoronoi(data, fillAccessor, options = {}) {
    const { enableHoverSelect = true, useMarkerEvents = true, context = null, hitRadius = 0 } = options;
    const perf = startMapPerf('render-voronoi', {
        mode: currentMode,
        points: data?.length || 0,
        reuse: FEATURE_VORONOI_REUSE
    });
    const hasClickHandler = typeof options.onClick === 'function';
    const allowPointerEvents = enableHoverSelect || hasClickHandler;
    const mapRef = context?.map || map;
    const voronoiLayerRef = context?.voronoiLayer || voronoiLayer;
    if (mapRef === map) showWindHatchLegend(typeof options.hatch === 'function' && data.some(options.hatch));

    // Canvas fast path: route this map (primary OR the supply map via context) to
    // its own canvas layer. Clear any SVG cells first so the two never double-draw.
    if (resolveVoronoiCanvas()) {
        d3.select(voronoiLayerRef._container).selectAll('*').remove();
        // A large scene may reach the canvas a few frames later (chunked); onDrawn
        // fires when it does, and the timing ends there too. A render replaced
        // before it reaches the canvas reports nothing.
        let returned = false;
        ensureVoronoiCanvas(mapRef).render(data, fillAccessor, worldGeoJSON, {
            options, enableHoverSelect, useMarkerEvents, hitRadius
        }, { snapshot: options.snapshot, hatch: options.hatch, onDrawn: (rows, snap) => {
            endMapPerf(perf, { rendered: data?.length || 0, canvas: true, chunked: returned });
            options.onDrawn?.(rows, snap);
        } });
        returned = true;
        return;
    }
    // The SVG cells below are drawn in this call.
    options.onDrawn?.(data, options.onDrawn && options.snapshot ? options.snapshot(data) : undefined);

    const svg = d3.select(voronoiLayerRef._container);
    if (!FEATURE_VORONOI_REUSE) {
        svg.selectAll('*').remove();
    }

    const versionKey = mapRef?._leaflet_id || 'main';
    // Refresh the handler ref first so bound-once listeners always dispatch
    // to this render's callbacks (no per-render listener rebinds needed).
    voronoiHandlersByMap.set(versionKey, { options, enableHoverSelect, useMarkerEvents });

    if (mapRef === supplyMap) {
        supplyVoronoiIndex = new Map();
    }

    // If only one point, just a circle
    if (data.length === 1) {
        // ... (simplified for now, or just skip)
        if (FEATURE_VORONOI_GEOM_CACHE) {
            // The same-mode pre-render wipe is selective now; replicate the
            // old "wiped, nothing rendered" outcome for this branch.
            svg.selectAll('*').remove();
            voronoiGeomCacheByMap.delete(versionKey);
            voronoiClipVersionByMap.delete(versionKey);
        }
        endMapPerf(perf, { rendered: 0, skipped: true });
        return;
    }

    const clipId = mapRef?._leaflet_id ? `clip-land-${mapRef._leaflet_id}` : 'clip-land-main';
    if (worldGeoJSON) {
        const transform = d3.geoTransform({
            point: function (x, y) {
                const point = mapRef.latLngToLayerPoint(new L.LatLng(y, x));
                this.stream.point(point.x, point.y);
            },
        });
        const path = d3.geoPath().projection(transform);
        const size = mapRef.getSize();
        const center = mapRef.getCenter();
        const clipVersion = `${size.x}x${size.y}|${mapRef.getZoom()}|${center.lat.toFixed(3)},${center.lng.toFixed(3)}`;
        const shouldRefreshClip = !FEATURE_VORONOI_REUSE
            || voronoiClipVersionByMap.get(versionKey) !== clipVersion
            || svg.select(`#${clipId}`).empty();
        if (shouldRefreshClip) {
            let defs = svg.select('defs');
            if (defs.empty()) {
                defs = svg.append('defs');
            }
            let clipPath = defs.select(`#${clipId}`);
            if (clipPath.empty()) {
                clipPath = defs.append('clipPath').attr('id', clipId);
                clipPath.append('path');
            }
            clipPath.select('path')
                .datum(worldGeoJSON)
                .attr('d', path);
            voronoiClipVersionByMap.set(versionKey, clipVersion);
        }
    }

    let g = FEATURE_VORONOI_REUSE ? svg.select('g.voronoi-group') : d3.select(null);
    if (g.empty()) {
        g = svg.append('g');
    }
    g.attr('class', 'voronoi-group')
        .attr('clip-path', worldGeoJSON ? `url(#${clipId})` : null);
    g.style("pointer-events", allowPointerEvents ? "all" : "none");

    const size = mapRef.getSize();
    const origin = mapRef.getPixelOrigin();
    const rowKeyOf = (row) => Number.isFinite(row.location_id)
        ? `id:${row.location_id}`
        : `coord:${row.latitude.toFixed(4)},${row.longitude.toFixed(4)}`;
    // Layer points are a pure function of (zoom, pixelOrigin); with those and
    // the size (which fixes the voronoi bounds) unchanged, and the same rows
    // in the same order, a rebuild would reproduce byte-identical cell paths,
    // so the cached geometry can be reused and only fills refreshed.
    const geomKey = `${mapRef.getZoom()}|${origin.x},${origin.y}|${size.x}x${size.y}|${data.map(rowKeyOf).join(';')}`;
    const geomCache = voronoiGeomCacheByMap.get(versionKey);
    const geomCacheHit = FEATURE_VORONOI_GEOM_CACHE
        && FEATURE_VORONOI_REUSE
        && !!geomCache
        && geomCache.geomKey === geomKey
        && g.selectAll('path.voronoi-cell').size() === data.length;

    let cellsData;
    if (geomCacheHit) {
        // Same geometry, same elements: swap the rows behind the join so
        // event handlers see current data, then recolor below.
        cellsData = geomCache.cellsData;
        for (let i = 0; i < data.length; i += 1) {
            cellsData[i].row = data[i];
        }
    } else {
        const delaunay = d3.Delaunay.from(layerPointsOf(mapRef, data));
        // Add buffer to cover the whole map view
        const buffer = Math.max(size.x, size.y);
        const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
        const voronoi = delaunay.voronoi(bounds);
        cellsData = data.map((row, i) => ({
            key: rowKeyOf(row),
            row,
            path: voronoi.renderCell(i)
        }));
        if (FEATURE_VORONOI_GEOM_CACHE) {
            voronoiGeomCacheByMap.set(versionKey, { geomKey, cellsData });
        }
    }

    const applyCellStyle = function (cell) {
        const d = cell.row;
        const el = d3.select(this);
        const style = fillAccessor ? fillAccessor(d) : null;
        if (style && typeof style === 'object') {
            el.attr("fill", style.fillColor || style.color)
                .attr("fill-opacity", Number.isFinite(style.fillOpacity) ? style.fillOpacity : 0.6)
                .attr("stroke", style.color || "rgba(255,255,255,0.08)")
                .attr("stroke-width", Number.isFinite(style.weight) ? style.weight : 0.5);
        } else {
            const fill = style || getColor(d.annual_cf);
            // No data and target not met are drawn solid (T062), so they stay apart
            // from the darkest ramp steps, which are drawn at 0.6 over the land.
            el.attr("fill", fill)
                .attr("fill-opacity", fill === NO_DATA_COLOR ? 1 : 0.6)
                .attr("stroke", "rgba(255,255,255,0.08)")
                .attr("stroke-width", 0.5);
        }
        // Reused elements can carry hover bookkeeping from a hover that was
        // active when this render fired; drop it so a later mouseout can't
        // restore a stroke saved under the previous style. Matches the old
        // destroy-and-recreate semantics (hover rim drops on re-render).
        if (this.hasAttribute('data-hover-prev-stroke')) {
            el.attr('data-hover-prev-stroke', null)
                .attr('data-hover-prev-stroke-width', null)
                .attr('data-hover-prev-stroke-opacity', null)
                .classed('voronoi-hover', false);
        }
        if (mapRef === supplyMap) {
            const key = getRowKey(d);
            if (key) supplyVoronoiIndex.set(key, this);
        }
    };

    let paths = g.selectAll('path.voronoi-cell');
    paths = FEATURE_VORONOI_REUSE
        ? paths.data(cellsData, d => d.key)
        : paths.data(cellsData);

    if (geomCacheHit) {
        // Fast path: geometry and elements are unchanged — skip exit/enter,
        // 'd' attribute writes, and listener binds; only refresh styles.
        paths.each(applyCellStyle)
            .style("pointer-events", allowPointerEvents ? "all" : "none");
        drawSvgWindHatch(svg, g, svgHatchItems(paths, options.hatch), mapRef);
        endMapPerf(perf, { rendered: cellsData.length, geomCacheHit: true });
        return;
    }

    paths.exit().remove();

    const enterPaths = paths.enter()
        .append('path')
        .attr('class', 'transition-color voronoi-cell leaflet-interactive');

    // Listeners are bound once, on enter only; they read voronoiHandlersByMap
    // at event time so reused elements always dispatch to the latest
    // callbacks (set at the top of every renderVoronoi call).
    enterPaths
        .on("click", (e, cell) => {
            const h = voronoiHandlersByMap.get(versionKey) || {};
            const d = cell.row || cell;
            if (h.useMarkerEvents) {
                fireMarkerEvent(d, 'click');
            }
            if (h.options && h.options.onClick) {
                h.options.onClick(d);
            }
        })
        .on("mouseover", function (e, cell) {
            const h = voronoiHandlersByMap.get(versionKey) || {};
            const d = cell.row || cell;
            if (!h.enableHoverSelect) return;
            applyHoverRim(this);
            if (h.useMarkerEvents) {
                fireMarkerEvent(d, 'mouseover');
            }
            if (h.options && h.options.onHover) {
                h.options.onHover(e, d);
            }
        })
        .on("mouseout", function (e, cell) {
            const h = voronoiHandlersByMap.get(versionKey) || {};
            const d = cell.row || cell;
            if (!h.enableHoverSelect) return;
            clearHoverRim(this);
            if (h.useMarkerEvents) {
                fireMarkerEvent(d, 'mouseout');
            }
            if (h.options && h.options.onOut) {
                h.options.onOut(e, d);
            }
        });

    enterPaths.merge(paths)
        .attr('d', d => d.path)
        .attr('data-loc-id', d => d.row.location_id)
        .each(applyCellStyle)
        .style("pointer-events", allowPointerEvents ? "all" : "none")
        .order();
    drawSvgWindHatch(svg, g, svgHatchItems(g.selectAll('path.voronoi-cell'), options.hatch), mapRef);

    endMapPerf(perf, { rendered: cellsData.length, geomCacheHit: false });
}

// ========== FRAME MAP (Complementarity tab) ==========

// A frame from complementarity.js: { locations, tooltip }. Each location row has
// location_id, latitude, longitude and either color or isNA; tooltip(row) returns
// the popup HTML for that row.
export function updateMapWithSampleFrame(frameData) {
    currentMode = 'complementarity';
    lastSampleFrame = frameData;
    if (!frameData || !frameData.locations) {
        console.warn('No frame data provided');
        return;
    }

    const { locations } = frameData;
    if (locations.length === 0) {
        return;
    }
    const modeChanged = resetLayersForMode('complementarity', { preserveVoronoi: true });
    if (modeChanged) {
        lastSampleVoronoiKey = null;
        sampleHoverId = null;
    }

    if (!samplePopup) {
        samplePopup = L.popup({
            closeButton: false,
            autoPan: false,
            className: 'bg-transparent border-none shadow-none'
        });
    }

    const viewKey = `${map.getZoom()}|${map.getCenter().lat.toFixed(4)},${map.getCenter().lng.toFixed(4)}|${map.getSize().x}x${map.getSize().y}`;
    const locationsKey = `${locations.length}|${locations[0]?.location_id ?? ''}|${locations[locations.length - 1]?.location_id ?? ''}`;
    const voronoiKey = `${viewKey}|${locationsKey}`;

    if (lastSampleVoronoiKey === voronoiKey && updateSampleVoronoiColors(locations)) {
        // Colours updated without rebuilding geometry.
    } else {
        renderSampleVoronoi(locations);
        lastSampleVoronoiKey = voronoiKey;
    }
    refreshSamplePopup(locations);
}

// Popup HTML for a sample cell, from the frame's own tooltip function.
function sampleTooltipHtml(d) {
    const tooltip = lastSampleFrame?.tooltip;
    return appendCountryLine(typeof tooltip === 'function' ? tooltip(d) : '', d);
}

function showSamplePopup(d) {
    if (!samplePopup || !d) return;
    sampleHoverId = d.location_id;
    samplePopup.setLatLng([d.latitude, d.longitude]).setContent(sampleTooltipHtml(d)).openOn(map);
}

function hideSamplePopup() {
    sampleHoverId = null;
    if (samplePopup) map.closePopup(samplePopup);
}

// A new frame (another toggle) under a still pointer: show the new figures in the open popup.
function refreshSamplePopup(locations) {
    if (sampleHoverId == null || !samplePopup || !map.hasLayer(samplePopup)) return;
    const d = locations.find(r => r.location_id === sampleHoverId);
    if (d) samplePopup.setContent(sampleTooltipHtml(d));
}

// Canvas fill for a sample cell: NA hatch for no-data, else the frame's colour.
function sampleCanvasFill(d) {
    if (d.isNA) return createVoronoiCanvasLayer.NA_FILL;
    return d.color;
}

// SVG fill for a sample cell: the na-hatch pattern for no-data, else the frame's colour.
function sampleSvgFill(d) {
    return d.isNA ? 'url(#na-hatch)' : d.color;
}

function renderSampleVoronoi(locations) {
    // Canvas path: NA hatch for no-data cells, samplePopup on hover.
    if (resolveVoronoiCanvas()) {
        d3.select(voronoiLayer._container).selectAll("*").remove();
        if (locations.length <= 1) { getCanvasLayer(map)?.hide(); return; }
        ensureVoronoiCanvas(map).render(locations, sampleCanvasFill, worldGeoJSON, {
            enableHoverSelect: true,
            useMarkerEvents: false,
            options: {
                onHover: (e, d) => showSamplePopup(d),
                onOut: hideSamplePopup,
            },
        });
        return;
    }

    // Samples render on SVG; hide the canvas Voronoi so its (stale, higher-z-index)
    // cells don't sit on top of the sample cells.
    getCanvasLayer(map)?.hide();
    const svg = d3.select(voronoiLayer._container);
    svg.selectAll("*").remove();

    if (locations.length === 1) {
        return;
    }

    if (worldGeoJSON) {
        const transform = d3.geoTransform({
            point: function (x, y) {
                const point = map.latLngToLayerPoint(new L.LatLng(y, x));
                this.stream.point(point.x, point.y);
            },
        });
        const path = d3.geoPath().projection(transform);

        const defs = svg.append("defs");
        defs
            .append("clipPath")
            .attr("id", "clip-land")
            .append("path")
            .datum(worldGeoJSON)
            .attr("d", path);
    }

    // Pattern for "no data" (NA) cells – a faint diagonal hatch, visually distinct from
    // any solid fill. Recreated on every full render (svg was cleared above) and
    // referenced via fill="url(#na-hatch)" so it survives fast colour-only updates too.
    const naDefs = svg.append("defs");
    const naPattern = naDefs.append("pattern")
        .attr("id", "na-hatch")
        .attr("patternUnits", "userSpaceOnUse")
        .attr("width", 6)
        .attr("height", 6)
        .attr("patternTransform", "rotate(45)");
    naPattern.append("rect")
        .attr("width", 6)
        .attr("height", 6)
        .attr("fill", DATA_COLOURS.hatchFill);
    naPattern.append("line")
        .attr("x1", 0).attr("y1", 0)
        .attr("x2", 0).attr("y2", 6)
        .attr("stroke", DATA_COLOURS.hatchLine)
        .attr("stroke-width", 1.5);

    const g = svg.append("g")
        .attr("class", "sample-voronoi")
        .attr("clip-path", worldGeoJSON ? "url(#clip-land)" : null);

    const delaunay = d3.Delaunay.from(layerPointsOf(map, locations));
    const size = map.getSize();
    const buffer = Math.max(size.x, size.y);
    const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
    const voronoi = delaunay.voronoi(bounds);

    g.selectAll("path")
        .data(locations, d => d.location_id)
        .enter()
        .append("path")
        .attr("d", (_, i) => voronoi.renderCell(i))
        .each(function (d) {
            // Stamp the applied fill on the node so updateSampleVoronoiColors can skip
            // unchanged cells later. Enter selection → every node is fresh, so this
            // always paints. Mirrors d3 .attr() null-handling.
            const v = sampleSvgFill(d);
            if (v == null) this.removeAttribute("fill"); else this.setAttribute("fill", v);
            this.__lastFill = v;
        })
        .attr("fill-opacity", 0.6)
        .attr("stroke", "rgba(255,255,255,0.08)")
        .attr("stroke-width", 0.5)
        .attr("class", "transition-color voronoi-cell leaflet-interactive")
        .style("transition", "fill 0.9s ease")
        .style("pointer-events", "all")
        .on("mouseover", function (e, d) {
            applyHoverRim(this);
            showSamplePopup(d);
        })
        .on("mouseout", function () {
            clearHoverRim(this);
            hideSamplePopup();
        });
}

function updateSampleVoronoiColors(locations) {
    if (resolveVoronoiCanvas()) {
        const layer = getCanvasLayer(map);
        // Fast recolor on canvas. Returns false if the layer isn't rendered yet →
        // caller falls back to a full render.
        return layer ? layer.recolor(locations, sampleCanvasFill) : false;
    }
    const svg = d3.select(voronoiLayer._container);
    const group = svg.select(".sample-voronoi");
    if (group.empty()) return false;
    group.selectAll("path")
        .data(locations, d => d.location_id)
        .each(function (d) {
            // Skip cells whose colour didn't change; a changed value writes and cross-fades.
            // __lastFill lives on the node (reset when renderSampleVoronoi recreates it).
            const v = sampleSvgFill(d);
            if (this.__lastFill !== v) {
                if (v == null) this.removeAttribute("fill"); else this.setAttribute("fill", v);
                this.__lastFill = v;
                this.setAttribute("fill-opacity", 0.6);
            }
        });
    return true;
}

// ========== SUBSET MAP FUNCTIONS ==========

export let subsetMap;
let subsetVoronoiLayer;

export async function initSubsetMap() {
    if (subsetMap) {
        setTimeout(() => subsetMap.invalidateSize(), 100);
        return;
    }

    const container = document.getElementById('subset-map');
    if (!container) return;

    subsetMap = L.map('subset-map', {
        zoomControl: false,
        attributionControl: false,
        zoomAnimation: false,  // Disable zoom animation to prevent SVG scale mismatch
        fadeAnimation: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false
    }).setView([20, 0], 2);

    ensureWorldGeoJsonLoaded().then(geo => addLandBasemap(subsetMap, geo));

    subsetMap.createPane('voronoi');
    subsetMap.getPane('voronoi').style.zIndex = 400;

    subsetVoronoiLayer = L.svg({ pane: 'voronoi' }).addTo(subsetMap);
}

export function renderSubsetMap(allData, subsetIds, getValue, getColor, layerType = 'population', getRadius = null, getTooltip = null, onPointHover = null, onPointOut = null) {
    if (!subsetMap || !subsetVoronoiLayer) return;

    // Clear existing
    const svg = d3.select(subsetVoronoiLayer._container);
    svg.selectAll("*").remove();

    if (!allData || allData.length === 0) return;

    // Common setup
    const size = subsetMap.getSize();
    const subsetSet = new Set(subsetIds);

    // Canvas path: render only the subset cells (non-subset → null fill → not drawn,
    // not hoverable). The layer follows the subset map's own view changes.
    if (resolveVoronoiCanvas()) {
        d3.select(subsetVoronoiLayer._container).selectAll('*').remove();
        const fillAcc = (d) => subsetSet.has(d.location_id)
            ? { fillColor: getColor(getValue(d)), fillOpacity: 0.9 }
            : { fillColor: null };
        const layer = ensureVoronoiCanvas(subsetMap);
        layer.render(allData, fillAcc, worldGeoJSON, {
            enableHoverSelect: !!(onPointHover || onPointOut),
            useMarkerEvents: false,
            options: {
                onHover: (e, d) => { if (onPointHover) onPointHover(e, d); },
                onOut: (e, d) => { if (onPointOut) onPointOut(e, d); },
            },
        });
        // No view-change handler: the canvas layer re-pins and redraws itself (and
        // a blanket off('moveend') would also unbind it and the basemap renderer).
        return;
    }

    const draw = () => {
        try {
            // Clear ALL SVG contents to prevent stale elements on zoom/pan
            svg.selectAll("*").remove();

            const size = subsetMap.getSize(); // update size in draw
            if (size.x === 0 || size.y === 0) {
                console.warn('[SubsetMap] Skipping draw - size is zero');
                return;
            }

            // Check if we have data to render
            if (!allData || allData.length === 0) {
                console.warn('[SubsetMap] Skipping draw - no data');
                return;
            }

            // Render Voronoi (Clipped)

            // 1. Setup Clip Path
            const transform = d3.geoTransform({
                point: function (x, y) {
                    const point = subsetMap.latLngToLayerPoint(new L.LatLng(y, x));
                    this.stream.point(point.x, point.y);
                },
            });
            const path = d3.geoPath().projection(transform);

            if (worldGeoJSON) {
                const defs = svg.append("defs");
                defs.append("clipPath")
                    .attr("id", "clip-land-subset")
                    .append("path")
                    .datum(worldGeoJSON)
                    .attr("d", path);
            }

            const buffer = Math.max(size.x, size.y);
            const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];

            const points = allData.map(d => {
                const p = subsetMap.latLngToLayerPoint([d.latitude, d.longitude]);
                return [p.x, p.y];
            });

            const delaunay = d3.Delaunay.from(points);
            const voronoi = delaunay.voronoi(bounds);

            // Pre-filter data indices for the subset
            const pathsData = [];
            allData.forEach((d, i) => {
                if (subsetSet.has(d.location_id)) {
                    pathsData.push({ d, i });
                }
            });

            // 2. Render paths with clip-path
            const paths = svg.append("g")
                .attr("clip-path", worldGeoJSON ? "url(#clip-land-subset)" : null)
                .selectAll("path")
                .data(pathsData)
                .enter()
                .append("path")
                .attr("d", p => voronoi.renderCell(p.i))
                .attr("fill", p => getColor(getValue(p.d)))
                .attr("fill-opacity", 0.9)
                .attr("stroke", "rgba(255,255,255,0.08)")
                .attr("stroke-width", 0.5)
                .attr("class", "transition-color voronoi-cell leaflet-interactive")
                .style("pointer-events", "all");

            if (onPointHover || onPointOut) {
                paths
                    .on("mouseover", function (e, p) {
                        applyHoverRim(this);
                        if (onPointHover) onPointHover(e, p.d);
                    })
                    .on("mouseout", function (e, p) {
                        clearHoverRim(this);
                        if (onPointOut) onPointOut(e, p.d);
                    });
            } else {
                paths.append("title")
                    .text(p => {
                        const val = getValue(p.d);
                        return getTooltip ? getTooltip(p.d) : `Value: ${formatNumber(val, 2)}`;
                    });
            }
        } catch (e) {
            console.error('[SubsetMap] Error in draw:', e);
        }
    };

    draw();

    // update on move/resize/zoom - need all these for proper SVG sync
    subsetMap.off('moveend');
    subsetMap.off('resize');
    subsetMap.off('zoomend');
    subsetMap.off('viewreset');
    subsetMap.off('zoom');

    subsetMap.on('moveend', draw);
    subsetMap.on('resize', draw);
    subsetMap.on('zoomend', draw);
    subsetMap.on('viewreset', draw);
    subsetMap.on('zoom', draw);
}
