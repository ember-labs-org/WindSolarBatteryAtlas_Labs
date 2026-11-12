// basemap.js — land basemap drawn from local Natural Earth geometry.
//
// Replaces the CARTO raster tiles (basemaps.cartocdn.com/dark_nolabels). CARTO
// now requires an API key on that endpoint and watermarks unauthenticated
// requests, and has said the raster basemaps are being retired — so a key would
// only be a stopgap. We already fetch data/world.geojson (Natural Earth 50m
// land) to clip the Voronoi cells, so the geometry costs us nothing extra, and
// dropping the tiles removes the last third-party runtime dependency from the
// map. Natural Earth is public domain: no attribution required.
//
// Colours are sampled from the dark_nolabels tiles this replaces, so the look
// is unchanged: land #262626 over ocean #090909. Dark Matter draws a flat land
// fill with no distinct coastline stroke (the intermediate greys along coasts
// are just antialiasing), so we do the same.
//
// Canvas, not SVG: the SVG renderer is the known interaction bottleneck (see
// DEPLOYMENT.md). Unlike voronoi-canvas.js — which projects screen-space cells
// by hand and needed careful pan/drag alignment fixes — this is plain GeoJSON,
// so Leaflet's own renderer handles reprojection and stays aligned for free.

const PANE = 'basemap';
const PANE_Z = '200'; // the slot Leaflet's tilePane used to occupy

function cssVar(name, fallback) {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    } catch (_) {
        return fallback;
    }
}

// Idempotent: safe to call again if the GeoJSON promise resolves more than once.
const attached = new WeakMap();

export function addLandBasemap(map, worldGeoJSON, options = {}) {
    if (!map || !worldGeoJSON) return null;
    if (attached.has(map)) return attached.get(map);

    if (!map.getPane(PANE)) {
        const pane = map.createPane(PANE);
        pane.style.zIndex = PANE_Z;
        pane.style.pointerEvents = 'none';
    }

    const land = options.land || cssVar('--map-land', '#262626');

    const layer = L.geoJSON(worldGeoJSON, {
        pane: PANE,
        renderer: L.canvas({ pane: PANE, padding: 0.5 }),
        interactive: false,
        // Hairline stroke in the fill colour so sub-pixel islands survive at
        // world zoom instead of vanishing between polygon edges.
        style: () => ({
            fill: true,
            fillColor: land,
            fillOpacity: 1,
            color: land,
            weight: 0.5,
            opacity: 1
        })
    }).addTo(map);

    attached.set(map, layer);
    return layer;
}
