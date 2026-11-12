// Complementarity tab (T093): how solar and wind droughts line up, and how far the
// two sources move in opposite directions, per region, over ten years of weather.
//
// Data: data/complementarity.csv, built by pipeline/scripts/pipeline/t093/build.py
// from T088's daily series (2015-2024 daily mean capacity factor, solar and onshore
// wind; regions with an onshore profile averaging at least 2%). Fetched when the
// tab first opens.
//
// Two views:
//   Droughts         share of 7-day (week) or 30-day (month) windows in which the
//                    source makes less than half its own ten-year average (T088's
//                    definition); Solar, Wind, or Both at once.
//   Complementarity  (1 - r) / 2, r the Pearson correlation of the raw solar and
//                    wind capacity factors at day, week or calendar-month level:
//                    1 = opposite, 0.5 = unrelated, 0 = they rise and fall together.
//                    The legend and tooltip state r itself (T096): r = 1 - 2 * score.

import { updateMapWithSampleFrame } from './map.js';
import { rampScale } from './constants.js';

const DATA_URL = new URL('../data/complementarity.csv', import.meta.url).href;
const NA_COLOR = 'url(#na-hatch)';
const DROUGHT_MAX = 0.3;   // legend and colour top: 30% of windows and above take the last step
const DEBUG = (() => {
    try { return new URLSearchParams(location.search).has('debug'); } catch (_) { return false; }
})();

const droughtColor = rampScale('drought', [0, DROUGHT_MAX]);
// The diverging ramp runs blue (low) to amber (high); complementary should read blue,
// so a region is coloured by 1 - score and the legend bar is drawn right to left.
const deltaColor = rampScale('delta', [0, 1]);
const scoreColor = v => deltaColor(1 - v);

const SOURCE_LABELS = { solar: 'Solar', wind: 'Wind', both: 'Solar and wind at once' };
const PERIOD_LABELS = { wk: 'weeks', mo: 'months' };
const LEVEL_ADJECTIVES = { day: 'daily', week: 'weekly', month: 'monthly' };

let data = null;          // Map location_id -> row of numbers
let dataLoad = null;
let view = 'droughts';    // 'droughts' | 'score'
let source = 'solar';     // 'solar' | 'wind' | 'both'
let period = 'wk';        // 'wk' | 'mo'
let level = 'day';        // 'day' | 'week' | 'month'
let positions = [];
let active = false;
let initialised = false;

const controls = document.getElementById('comp-controls');
const status = document.getElementById('comp-status');
const viewButtons = document.querySelectorAll('#comp-view-toggle button');
const sourceButtons = document.querySelectorAll('#comp-source-toggle button');
const periodButtons = document.querySelectorAll('#comp-period-toggle button');
const levelButtons = document.querySelectorAll('#comp-level-toggle button');
const droughtRows = document.getElementById('comp-drought-rows');
const levelRow = document.getElementById('comp-level-row');
const noteDroughts = document.getElementById('comp-note-droughts');
const noteScore = document.getElementById('comp-note-score');
const legendDrought = document.getElementById('legend-comp-drought');
const legendDroughtTitle = document.getElementById('legend-comp-drought-title');
const legendDroughtBar = document.getElementById('legend-comp-drought-bar');
const legendScore = document.getElementById('legend-comp-score');
const legendScoreTitle = document.getElementById('legend-comp-score-title');
const legendScoreBar = document.getElementById('legend-comp-score-bar');

const pct = v => `${(v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0)}%`;

// The correlation r from the file's score, (1 - r) / 2, and how it reads. The
// meaning is taken from the printed (two-decimal) value, so one printed value
// always reads the same: -0.20 and -0.50 belong to the bands below them, +0.20
// and +0.50 to the bands above.
const correlation = score => 1 - 2 * score;
const roundR = r => Number(r.toFixed(2));
function formatR(r) {
    const s = r.toFixed(2);
    if (Number(s) === 0) return '0.00';
    return r > 0 ? `+${s}` : `−${s.slice(1)}`;   // proper minus sign
}
const nowrap = text => `<span class="comp-nowrap">${text}</span>`;
function meaningOfR(r) {
    const v = roundR(r);
    if (v <= -0.5) return `highly ${nowrap('anti-correlated')}: complementary`;
    if (v <= -0.2) return `${nowrap('anti-correlated')}: partly complementary`;
    if (v < 0.2) return 'hardly correlated: neutral';
    if (v < 0.5) return 'correlated: little complementarity';
    return 'highly correlated: not complementary';
}

function loadData() {
    if (dataLoad) return dataLoad;
    dataLoad = fetch(DATA_URL)
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.text();
        })
        .then((text) => {
            const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
            const cols = lines[0].trim().split(',');
            const rows = new Map();
            for (let i = 1; i < lines.length; i++) {
                const v = lines[i].trim().split(',').map(Number);
                const row = {};
                cols.forEach((c, j) => { row[c] = v[j]; });
                rows.set(row.location_id, row);
            }
            data = rows;
            return rows;
        });
    // A failed load can be retried by reopening the tab.
    dataLoad.catch(() => { dataLoad = null; });
    return dataLoad;
}

const tipBox = body => `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">${body}</div>`;
const tipLine = text => `<div class="text-[11px] text-muted">${text}</div>`;

function tooltipFor(d) {
    if (d.isNA) {
        return tipBox(`<div class="font-semibold">No wind profile</div>`
            + tipLine('This region has no onshore wind profile averaging at least 2%, so droughts and complementarity are not worked out.'));
    }
    const r = d.row;
    if (d.kind === 'droughts') {
        const p = period;
        const unit = PERIOD_LABELS[p];
        const independent = r[`${p}_solar`] * r[`${p}_wind`];
        return tipBox(`<div class="font-semibold">Droughts, share of ${unit} (2015–2024)</div>`
            + `<div class="text-[10px] text-muted mb-1">${p === 'wk' ? '7' : '30'}-day output below half its ten-year average</div>`
            + tipLine(`Solar: ${pct(r[`${p}_solar`])}`)
            + tipLine(`Wind (onshore): ${pct(r[`${p}_wind`])}`)
            + tipLine(`Both at once: ${pct(r[`${p}_both`])}`)
            + tipLine(`Both at once if unrelated: ${pct(independent)}`));
    }
    const lines = ['day', 'week', 'month'].map((k) => {
        const rk = correlation(r[`c_${k}`]);
        const name = LEVEL_ADJECTIVES[k][0].toUpperCase() + LEVEL_ADJECTIVES[k].slice(1);
        const text = `${name}: ${formatR(rk)} (${meaningOfR(rk)})`;
        return tipLine(k === level ? `<b>${text}</b>` : text);
    });
    return tipBox(`<div class="font-semibold">Correlation of solar and wind output</div>`
        + `<div class="text-[10px] text-muted mb-1">From +1 (rise and fall together) to −1 (one high when the other is low), 2015–2024</div>`
        + lines.join(''));
}

function render() {
    if (!active || !data) return;
    const key = view === 'droughts' ? `${period}_${source}` : `c_${level}`;
    const colour = view === 'droughts' ? droughtColor : scoreColor;
    const locations = [];
    for (const p of positions) {
        if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
        const base = { location_id: p.location_id, latitude: p.latitude, longitude: p.longitude, kind: view };
        const row = data.get(p.location_id);
        if (!row) locations.push({ ...base, isNA: true, color: NA_COLOR, value: null });
        else locations.push({ ...base, color: colour(row[key]), value: row[key], row });
    }
    updateMapWithSampleFrame({ locations, tooltip: tooltipFor });
    if (DEBUG) window.__complementarity = { view, source, period, level, key, rows: locations, tooltip: tooltipFor };
}

function setToggle(buttons, attr, value) {
    buttons.forEach((btn) => {
        const on = btn.dataset[attr] === value;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function syncUi() {
    setToggle(viewButtons, 'compView', view);
    setToggle(sourceButtons, 'compSource', source);
    setToggle(periodButtons, 'compPeriod', period);
    setToggle(levelButtons, 'compLevel', level);
    droughtRows.classList.toggle('hidden', view !== 'droughts');
    levelRow.classList.toggle('hidden', view !== 'score');
    noteDroughts.classList.toggle('hidden', view !== 'droughts');
    noteScore.classList.toggle('hidden', view !== 'score');
    legendDroughtTitle.textContent = `${SOURCE_LABELS[source]}: share of ${PERIOD_LABELS[period]} in drought`;
    legendScoreTitle.textContent = `Correlation of ${LEVEL_ADJECTIVES[level]} solar and wind output`;
    showLegend();
}

// Legends appear with the first frame, not while the file loads (the capacity map
// stands in meanwhile and must not carry them).
function showLegend() {
    const on = active && data !== null;
    legendDrought.classList.toggle('hidden', !on || view !== 'droughts');
    legendScore.classList.toggle('hidden', !on || view !== 'score');
}

function setStatus(message) {
    status.textContent = message || '';
    status.classList.toggle('hidden', !message);
}

export function initComplementarity() {
    if (initialised) return;
    initialised = true;
    legendDroughtBar.style.background = droughtColor.css();
    legendScoreBar.style.background = deltaColor.css().replace('to right', 'to left');
    const bind = (buttons, attr, set) => buttons.forEach(btn => btn.addEventListener('click', () => {
        set(btn.dataset[attr]);
        syncUi();
        render();
    }));
    bind(viewButtons, 'compView', (v) => { view = v; });
    bind(sourceButtons, 'compSource', (v) => { source = v; });
    bind(periodButtons, 'compPeriod', (v) => { period = v; });
    bind(levelButtons, 'compLevel', (v) => { level = v; });
    syncUi();
}

/** Open the tab. `state.positions`: the region positions of the current slice. */
export async function showComplementarity(state) {
    active = true;
    if (state?.positions?.length) positions = state.positions;
    controls.classList.remove('hidden');
    syncUi();
    if (!data) {
        setStatus('Loading ten years of droughts…');
        try {
            await loadData();
        } catch (err) {
            console.error('Complementarity data failed to load:', err);
            if (active) setStatus('The drought data could not be loaded.');
            return;
        }
        if (!active) return;
        setStatus('');
    }
    showLegend();
    render();
}

/** True once the data is in memory, so opening the tab draws at once. */
export function complementarityReady() {
    return data !== null;
}

export function cleanupComplementarity() {
    active = false;
    showLegend();
}
