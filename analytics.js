/* Ember Labs event tracking for the Wind + Solar + Battery Atlas.
 *
 * Adapted from the Solar + Battery Atlas tracking, with the same event names so the two
 * atlases can be compared, plus the wind atlas's new controls (setting_changed).
 *
 * Uses Umami (cookieless, no personal data). The Umami script is loaded in index.html;
 * this file only watches the page for clicks and changes and reports the ones listed
 * below. It does not touch the app's own code, so syncs from the Ember Futures repo
 * stay clean. If Umami is blocked or not loaded, nothing happens and the tool works as
 * normal.
 *
 * Every event carries tool: 'wind-solar-battery-atlas' (one Umami website for all Labs tools).
 *
 * Note for updates: if this Labs copy is refreshed from the Ember Futures repo, keep this file
 * and the two <script> lines in the <head> of index.html (or add them to the source repo).
 *
 * Events
 *   view_changed               {view}               main tabs: capacity, complementarity, potential, lcoe, population
 *   tour_started               {}
 *   info_opened                {}
 *   slider_set                 {control, value}     on release, not while dragging; value is the
 *                                                    number the slider's label shows (e.g. GW)
 *   assumption_edited          {field}              cost and finance inputs (field name only)
 *   option_toggled             {option, on}         diesel backup, day/night
 *   sample_week_selected       {week}
 *   animation_played           {control}            Play pressed: sample weeks or LCOE over time
 *   animation_paused           {control}            Pause pressed on the same buttons
 *   target_type_changed        {target}             utilization or LCOE target
 *   cost_mode_changed          {mode, section}      global or local assumptions
 *   base_layer_changed         {layer}              supply-demand base layer
 *   overlay_changed            {overlay}            supply-demand overlay
 *   population_display_changed {display}            map or charts
 *   potential_level_changed    {level}
 *   potential_display_changed  {display}
 *   plant_filter_changed       {filter, value}      fuel or status buttons
 *   lcoe_comparison_changed    {mode}               LCOE delta or transmission cost
 *   access_view_changed        {view}               reliability or no access
 *   cumulative_toggled         {}
 *   map_location_clicked       {view}               a click (not a drag) on the map
 *   setting_changed            {setting, value}     wind-atlas controls: potential technology
 *                                                    (tech), wind LCOE layer and technology, offshore,
 *                                                    and the Complementarity tab's level, period,
 *                                                    source, view and drought definition
 */
(function () {
    'use strict';

    var TOOL = 'wind-solar-battery-atlas';
    var currentView = 'capacity';

    function track(name, data) {
        try {
            if (!window.umami || typeof window.umami.track !== 'function') return;
            var payload = { tool: TOOL };
            if (data) {
                Object.keys(data).forEach(function (k) {
                    var v = data[k];
                    if (v !== undefined && v !== null && v !== '') payload[k] = v;
                });
            }
            window.umami.track(name, payload);
        } catch (e) {
            /* never let tracking break the tool */
        }
    }
    window.labsTrack = track;

    // Only count what a visitor actually did: the tour and the app can switch tabs and
    // settings with script-made clicks, which browsers mark untrusted.
    // (__labsTrackUntrusted exists only so automated tests can simulate clicks.)
    function byVisitor(e) { return e.isTrusted !== false || window.__labsTrackUntrusted === true; }

    function sectionOf(el) {
        var s = el.parentElement && el.parentElement.closest('[id]');
        return s ? s.id : undefined;
    }
    function controlName(id) {
        return id.replace(/-(slider|input|toggle)$/, '');
    }

    var VIEWS = { capacity: 1, complementarity: 1, potential: 1, lcoe: 1, population: 1 };
    // Wind-atlas settings recorded as setting_changed {setting, value}: data attribute -> setting name.
    var SETTINGS = { tech: 'potential_tech', lcoeLayer: 'lcoe_layer', lcoeTech: 'lcoe_tech',
                     offshore: 'offshore', compLevel: 'complementarity_level',
                     compPeriod: 'complementarity_period', compSource: 'complementarity_source',
                     compView: 'complementarity_view', definition: 'drought_definition' };
    var PLAYS = { 'sample-play': 1, 'lcoe-time-play': 1, 'pop-lcoe-time-play': 1 };

    // Clicks on buttons (capture phase, so the app's own handlers can't hide them).
    document.addEventListener('click', function (e) {
        if (!byVisitor(e)) return;
        var b = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!b) return;
        var d = b.dataset || {};

        if (d.mode) {
            if (VIEWS[d.mode]) {
                currentView = d.mode;
                track('view_changed', { view: d.mode });
            } else if (d.mode === 'global' || d.mode === 'local') {
                track('cost_mode_changed', { mode: d.mode, section: sectionOf(b) });
            } else if (d.mode === 'map' || d.mode === 'charts') {
                track('population_display_changed', { display: d.mode });
            } else if (d.mode === 'delta' || d.mode === 'transmission') {
                track('lcoe_comparison_changed', { mode: d.mode });
            }
            return;
        }
        if (d.targetMode) return track('target_type_changed', { target: d.targetMode });
        if (d.level) return track('potential_level_changed', { level: d.level });
        if (d.display) return track('potential_display_changed', { display: d.display });
        if (d.base) return track('base_layer_changed', { layer: d.base });
        if (d.overlay) return track('overlay_changed', { overlay: d.overlay });
        if (d.fuel) return track('plant_filter_changed', { filter: 'fuel', value: d.fuel });
        if (d.status) return track('plant_filter_changed', { filter: 'status', value: d.status });
        for (var key in SETTINGS) {
            if (d[key] !== undefined) return track('setting_changed', { setting: SETTINGS[key], value: d[key] });
        }

        switch (b.id) {
            case 'tour-start': return track('tour_started');
            case 'info-toggle': return track('info_opened');
            case 'btn-access-rel': return track('access_view_changed', { view: 'reliability' });
            case 'btn-access-none': return track('access_view_changed', { view: 'no_access' });
            case 'chart-cumulative-toggle': return track('cumulative_toggled');
        }
        // The same button reads "Play" or "Pause". This runs before the app updates the
        // label, so the current label says which one was pressed.
        if (PLAYS[b.id]) {
            var pausing = /pause/i.test(b.textContent || '');
            track(pausing ? 'animation_paused' : 'animation_played', { control: b.id });
        }
    }, true);

    // Changes: sliders fire 'change' once on release, inputs once when edited.
    document.addEventListener('change', function (e) {
        if (!byVisitor(e)) return;
        var t = e.target;
        if (!t || !t.id) return;
        if (t.type === 'range') {
            if (t.id === 'time-scrubber') return; // scrubbing through a week is not a setting
            // Some sliders store a position, not a value: the wind sliders step through
            // 0, 1, 2, 3, 4, 5, 6 and 8 GW by position. Where a slider has a matching label
            // (e.g. wind-slider -> wind-val), record the number it shows instead.
            var slider = t;
            setTimeout(function () {
                var label = document.getElementById(slider.id.replace(/-slider$/, '-val'));
                var shown = label ? parseFloat((label.textContent || '').replace(/[^0-9.\-]/g, '')) : NaN;
                track('slider_set', { control: controlName(slider.id), value: isFinite(shown) ? shown : Number(slider.value) });
            }, 0);
        } else if (t.type === 'number') {
            track('assumption_edited', { field: t.id });
        } else if (t.type === 'checkbox') {
            track('option_toggled', { option: controlName(t.id), on: t.checked });
        } else if (t.tagName === 'SELECT' && t.id === 'sample-week-select') {
            track('sample_week_selected', { week: t.value });
        }
    }, true);

    // Map clicks: count a click on a location, not the end of a drag or a click on a
    // map control. At most one event every 2 seconds.
    var down = null, lastMapClick = 0;
    document.addEventListener('pointerdown', function (e) {
        if (!byVisitor(e)) return;
        var onMap = e.target && e.target.closest && e.target.closest('#map, #map-supply');
        down = onMap && !e.target.closest('.leaflet-control') ? { x: e.clientX, y: e.clientY } : null;
    }, true);
    document.addEventListener('pointerup', function (e) {
        if (!byVisitor(e)) return;
        if (!down) return;
        var moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
        down = null;
        var now = Date.now();
        if (moved < 6 && now - lastMapClick > 2000) {
            lastMapClick = now;
            track('map_location_clicked', { view: currentView });
        }
    }, true);
})();
