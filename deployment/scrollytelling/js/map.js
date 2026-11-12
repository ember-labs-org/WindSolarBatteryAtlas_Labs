// map.js – the article's sticky map: a Leaflet map with the local land basemap
// and one canvas Voronoi layer (voronoi-canvas.js) whose colours each take sets.
import { createVoronoiCanvasLayer } from './voronoi-canvas.js';
import { addLandBasemap } from './basemap.js';

let map = null;
let layer = null;
let world = null;
let rows = [];
let tooltipEl = null;
let current = null;          // { fill, tooltip }
let viewName = 'world';

// Views as bounds, fitted to whatever size the map panel has.
export const VIEWS = {
    world: [[-56, -168], [78, 178]],
    europe: [[34, -12], [71, 40]]
};

export async function initMap(el, tooltip) {
    tooltipEl = tooltip;
    map = L.map(el, {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        touchZoom: false,
        dragging: false,
        keyboard: false,
        zoomSnap: 0.25
    });
    setView('world', { animate: false, force: true });
    const r = await fetch(new URL('../../data/world.geojson', import.meta.url));
    world = r.ok ? await r.json() : null;
    if (world) addLandBasemap(map, world);
    layer = createVoronoiCanvasLayer(map, d3, L, {
        getColor: () => '#4b5563',
        fireMarkerEvent: () => false,
        getRowKey: (row) => row.location_id
    });
    window.addEventListener('resize', () => {
        map.invalidateSize({ animate: false });
        setView(viewName, { animate: false, force: true });
    });
    return map;
}

export function setView(name, { animate = true, force = false } = {}) {
    if (!map) return;
    if (name === viewName && !force) return;
    viewName = name;
    map.fitBounds(VIEWS[name] || VIEWS.world, { animate, duration: 0.8, padding: [8, 8] });
}

/** Cells to draw: [{ location_id, latitude, longitude, i }]. Set once. */
export function setCells(list) {
    rows = list;
}

function showTooltip(e, row) {
    if (!tooltipEl || !current?.tooltip) return;
    const html = current.tooltip(row);
    if (!html) { hideTooltip(); return; }
    tooltipEl.innerHTML = html;
    tooltipEl.hidden = false;
    const box = map.getContainer().getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const w = tooltipEl.offsetWidth, h = tooltipEl.offsetHeight;
    tooltipEl.style.left = `${Math.min(Math.max(8, x + 14), box.width - w - 8)}px`;
    tooltipEl.style.top = `${Math.min(Math.max(8, y - h - 10), box.height - h - 8)}px`;
}

function hideTooltip() {
    if (tooltipEl) tooltipEl.hidden = true;
}

const HIDDEN_CELL = { fillColor: 'rgba(0,0,0,0)', fillOpacity: 0, color: 'none', weight: 0 };

/**
 * Colour the cells. `fill(row)` returns a CSS colour, or null to leave the cell
 * undrawn; `tooltip(row)` returns HTML. `instant` skips the cross-fade.
 */
export function paint({ fill, tooltip }, { instant = false } = {}) {
    if (!layer || !rows.length) return;
    current = { fill, tooltip };
    hideTooltip();
    layer.render(rows, (row) => {
        // Antarctica and Greenland are not in the data or the land outline (T057).
        const c = fill(row);
        return c == null ? HIDDEN_CELL : { fillColor: c, fillOpacity: 0.8, color: 'rgba(255,255,255,0.06)', weight: 0.4 };
    }, world, {
        enableHoverSelect: true,
        useMarkerEvents: false,
        options: {
            onHover: (e, row) => showTooltip(e, row),
            onOut: () => hideTooltip(),
            onClick: () => {}
        }
    }, { instant });
}

export function clear() {
    current = null;
    hideTooltip();
    if (layer) layer.hide();
}

export function getMap() {
    return map;
}
