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
// Colours follow the Ember Labs design system: land is --el-slate (#626E88, via
// the --map-land CSS variable) over the map container's --el-canvas background.
// Flat land fill with no coastline stroke.
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

// Static-layer renderer (T027). Chrome re-produces every visible 2D canvas on
// every frame it commits, changed or not. With software compositing that is a
// copy of the whole bitmap, and this canvas is 2x the map each way (padding
// 0.5), so it cost ~10-15 ms of main thread per hover frame at 4x throttle
// (T021, T026). A 'bitmaprenderer' canvas only changes when it is handed a new
// bitmap and costs almost nothing per frame. So Leaflet's renderer draws exactly
// as before, into a canvas that is not in the page, and a snapshot of it is
// shown on the visible canvas. Size, padding and zoom transforms are Leaflet's.
//
// Leaflet projects and clips the paths where it always does (moveend), but the
// draw runs in a task of its own: an off-page canvas is rastered at the end of
// the task that drew it (~30-40 ms at 4x after a pan), where a page canvas is
// rastered in the next frame's commit, so the moveend task does not grow (it
// shrinks: ~70 ms instead of ~100 in a 4x pan trace). Until the new bitmap is
// shown, the visible canvas keeps the old one where it was, as during a drag;
// the new position, size and any zoom transform are applied with the new
// bitmap. That needs createImageBitmap(canvas) to resolve in the task that asks
// for it, as Chrome does: a probe checks this once at load, and where it fails
// (or before it has answered) the plain L.canvas renderer is used.
let snapshotInTask = false;
try {
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    if (probe.getContext('bitmaprenderer') && typeof createImageBitmap === 'function') {
        let nextTask = false;
        const mc = new MessageChannel();
        mc.port1.onmessage = () => { nextTask = true; mc.port1.close(); };
        mc.port2.postMessage(0);
        createImageBitmap(probe).then(bm => { snapshotInTask = !nextTask; bm.close(); }, () => {});
    }
} catch (_) { snapshotInTask = false; }

function staticCanvasRenderer(options) {
    if (!snapshotInTask) return L.canvas(options);

    const StaticCanvas = L.Canvas.extend({
        _initContainer() {
            // Non-interactive: no pointer listeners (L.Canvas binds them for hit-testing).
            this._container = document.createElement('canvas');
            this._container['_leaflet_disable_events'] = true;
            this._view = this._container.getContext('bitmaprenderer');
            // One paint canvas. The shown bitmap shares its pixels, so the map holds
            // one full-size buffer; the next redraw copies them first (copy-on-write,
            // in the posted draw task). A second paint canvas would avoid that copy
            // but hold a second buffer for the whole session (T027 audit).
            this._paint = document.createElement('canvas');
            this._ctx = this._paint.getContext('2d');
            this._place = null;     // where the paint canvas's frame goes: { min, size, transform }
            this._resize = null;    // paint canvas size and origin for the next draw
            this._stale = false;    // the visible bitmap is older than the paint canvas
            this._full = false;     // the pending redraw is a full one
            this._queued = false;
            this._shown = 0;
            this._channel = new MessageChannel();
            this._channel.port1.onmessage = () => this._flush();
        },

        // L.Canvas._update. The paint canvas is sized and cleared in _flush, and the
        // visible canvas moves when the new bitmap is shown.
        _update() {
            if (this._map._animatingZoom && this._bounds) { return; }
            L.Renderer.prototype._update.call(this);
            const b = this._bounds, size = b.getSize(), m = L.Browser.retina ? 2 : 1;
            this._place = { min: b.min, size, transform: null };
            this._stale = true;
            // Resizing (clearing) the paint canvas waits for _flush too: the canvas
            // shares its pixels with the shown bitmap, so the first write copies them.
            this._resize = { w: m * size.x, h: m * size.y, m, min: b.min };
            this.fire('update');
        },

        // Renderer._updateTransform; while a new bitmap is pending, the transform
        // is kept for it instead of moving the old one.
        _updateTransform(center, zoom) {
            const scale = this._map.getZoomScale(zoom, this._zoom),
                viewHalf = this._map.getSize().multiplyBy(0.5 + this.options.padding),
                currentCenterPoint = this._map.project(this._center, zoom),
                topLeftOffset = viewHalf.multiplyBy(-scale).add(currentCenterPoint)
                    .subtract(this._map._getNewPixelOrigin(center, zoom));
            if (this._place) { this._place.transform = { offset: topLeftOffset, scale }; }
            if (!this._stale) { this._applyTransform(topLeftOffset, scale); }
        },

        _applyTransform(offset, scale) {
            if (L.Browser.any3d) {
                L.DomUtil.setTransform(this._container, offset, scale);
            } else {
                L.DomUtil.setPosition(this._container, offset);
            }
        },

        // Leaflet's redraw (clear + draw) runs in _flush. A full redraw asked for
        // here stays full even if partial ones are asked for before it runs.
        _redraw() {
            if (!this._redrawBounds) { this._full = true; }
            this._stale = true;
            if (!this._queued) { this._queued = true; this._channel.port2.postMessage(0); }
        },

        _flush() {
            this._queued = false;
            if (!this._map || !this._view) { return; }
            if (this._full) { this._redrawBounds = null; this._full = false; }
            const r = this._resize;
            if (r) {
                this._resize = null;
                const paint = this._paint, ctx = this._ctx;
                if (paint.width === r.w && paint.height === r.h && typeof ctx.reset === 'function') {
                    ctx.reset();    // what resizing does (clear, default state), keeping the canvas
                } else {
                    paint.width = r.w;
                    paint.height = r.h;
                }
                if (r.m === 2) { ctx.scale(2, 2); }
                ctx.translate(-r.min.x, -r.min.y);
                this._redrawBounds = null;
            }
            L.Canvas.prototype._redraw.call(this);
            this._show();
        },

        _clear() {
            if (this._redrawBounds) { return L.Canvas.prototype._clear.call(this); }
            const ctx = this._ctx;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, this._paint.width, this._paint.height);
            ctx.restore();
        },

        _show() {
            const paint = this._paint, place = this._place;
            if (!place) { return; }
            const id = ++this._shown;
            // A hidden map (size 0): drop every bitmap, as resizing a page canvas to 0 does.
            if (!paint.width || !paint.height) { this._place_(place, null); return; }
            createImageBitmap(paint).then(bm => {
                // Superseded by a later snapshot, or the renderer is gone.
                if (id !== this._shown || !this._view) { bm.close(); return; }
                this._place_(place, bm);
            }, () => {
                // No snapshot (e.g. out of memory): show nothing rather than a misplaced frame.
                if (id === this._shown && this._view) { this._place_(place, null); }
            });
        },

        // Moves the visible canvas to `place` and shows `bm` there (null: blank, no bitmap held).
        _place_(place, bm) {
            const c = this._container;
            L.DomUtil.setPosition(c, place.min);
            c.style.width = place.size.x + 'px';
            c.style.height = place.size.y + 'px';
            if (place.transform) { this._applyTransform(place.transform.offset, place.transform.scale); }
            this._view.transferFromImageBitmap(bm);
            this._stale = false;
        },

        _destroyContainer() {
            this._shown++;
            this._channel.port1.close();
            L.Canvas.prototype._destroyContainer.call(this);
            delete this._view;
            delete this._paint;
        }
    });
    return new StaticCanvas(options);
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

    const land = options.land || cssVar('--map-land', '#626E88');

    const layer = L.geoJSON(worldGeoJSON, {
        pane: PANE,
        renderer: staticCanvasRenderer({ pane: PANE, padding: 0.5 }),
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
