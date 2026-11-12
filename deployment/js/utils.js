/**
 * Shared utility functions
 */

import { CHART_JS_URL, CHART_JS_SRI, DATA_COLOURS } from './constants.js';

export function capitalizeWord(str = '') {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export function formatNumber(value, decimals = 0) {
    if (!Number.isFinite(value)) return '--';
    return value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

export function formatCurrency(value, decimals = 0) {
    const num = formatNumber(value, decimals);
    return num === '--' ? '--' : `$${num}`;
}

export function coordKey(lat, lon) {
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

export function roundedKey(lat, lon, decimals = 4) {
    return `${lat.toFixed(decimals)},${lon.toFixed(decimals)}`;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => deg * Math.PI / 180;
    const R = 6371; // Earth radius in km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Capital Recovery Factor for annuity calculations
 */
export function capitalRecoveryFactor(rate, years) {
    if (years <= 0) return 0;
    if (rate === 0) return 1 / years;
    const pow = Math.pow(1 + rate, years);
    return (rate * pow) / (pow - 1);
}

/**
 * Level-equivalent annual multiplier for a cost/energy stream that grows at
 * `growth` per year over `years`, discounted at `rate`. Equals
 *   Σ_{t=1..N} (1+growth)^(t-1)/(1+rate)^t  ×  CRF(rate, N)
 * and returns 1 when growth === 0, so passing 0 reproduces the prior flat-stream
 * behaviour exactly. Use growth = +escalation for OPEX, growth = -degradation for
 * an energy denominator.
 */
export function levelizedGrowthMultiplier(growth, rate, years) {
    if (!(years > 0)) return 0;
    const crf = capitalRecoveryFactor(rate, years);
    const ratio = (1 + growth) / (1 + rate);
    let pv;
    if (Math.abs(ratio - 1) < 1e-12) {
        pv = years / (1 + rate);
    } else {
        pv = (1 / (1 + growth)) * ratio * (1 - Math.pow(ratio, years)) / (1 - ratio);
    }
    return pv * crf;
}

/**
 * Generic toggle button UI updater
 * @param {NodeList} buttons - Button elements to update
 * @param {string} activeValue - The value to compare against
 * @param {string} dataAttr - The dataset attribute name (e.g., 'mode', 'overlay', 'base')
 */
export function updateToggleUI(buttons, activeValue, dataAttr = 'mode') {
    if (!buttons?.length) return;
    buttons.forEach(btn => {
        const isActive = btn.dataset[dataAttr] === activeValue;
        btn.classList.toggle('is-active', isActive);
    });
}

// Chart.js is fetched on first use (the population charts and the Sample Weeks
// chart). Cap its backing-store resolution at 2x: pixel-identical on dpr<=2
// screens, and beyond visual acuity (but far cheaper to paint) on 3x panels.
let chartJsPromise = null;
function applyChartDefaults() {
    window.Chart.defaults.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    // Poppins for canvas-rendered chart text (Chart.js doesn't inherit CSS fonts),
    // with Labs' muted ticks and divider grid.
    window.Chart.defaults.font.family = 'Poppins, system-ui, sans-serif';
    window.Chart.defaults.color = DATA_COLOURS.chartTick;
    window.Chart.defaults.borderColor = DATA_COLOURS.chartGrid;
}

/**
 * Resolves with window.Chart once it is loaded; rejects if the script cannot be
 * fetched (offline, blocked, integrity mismatch). Callers must catch the rejection
 * and say the chart is unavailable. A failed load is not remembered, so the next
 * call tries again.
 */
export function loadChartJs() {
    if (window.Chart) {
        applyChartDefaults();
        return Promise.resolve(window.Chart);
    }
    if (!chartJsPromise) {
        chartJsPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = CHART_JS_URL;
            script.integrity = CHART_JS_SRI;
            script.crossOrigin = 'anonymous';
            script.onload = () => { applyChartDefaults(); resolve(window.Chart); };
            script.onerror = () => {
                script.remove();
                chartJsPromise = null;
                reject(new Error('Failed to load Chart.js'));
            };
            document.head.appendChild(script);
        });
    }
    return chartJsPromise;
}
