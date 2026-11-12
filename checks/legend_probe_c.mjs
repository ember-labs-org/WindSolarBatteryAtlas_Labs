// T075 legend probe, part C: categorical colours, point layers and toggles, in every
// view and sub-mode of the atlas and every map state of the article.
//
// For each state, from what is on screen (screenshot pixels and computed styles):
//   C1 legend = drawing. Every flat map pixel (inside a 3x3 patch within ΔE 2, so cell
//      borders, coastlines and hatches drop out) that is not bare land or ocean must be
//      explained by the visible legend: a colour sampled from a legend bar or a swatch,
//      composited at the opacity the layer is drawn at over land or ocean (or over
//      another legend colour, for overlapping dots). p95 ΔE <= 6, and at most 1% of
//      pixels further than 10 from every legend colour ("unexplained colours").
//   C2 categories distinct. Legend swatches pairwise >= 10 ΔE2000 at the drawn opacity
//      over land in normal vision and simulated protanopia, deuteranopia, tritanopia.
//   C3 toggles truthful. Single-select toggle groups show exactly one active button.
//      Capacity to Displace: each fuel chip's pressed look (Labs yellow) matches
//      aria-pressed; the markers drawn (read from the Leaflet layers) are exactly the
//      pressed fuels in the chosen status, each in its chip's dot colour; with all
//      chips off nothing is drawn.
//   C4 size legend. Size-encoded dots have a size legend whose circles have the radii
//      the map uses (PLANT_MARKER.radius).
// usage: node checks/legend_probe_c.mjs [--only app|article] [--shots DIR]
import fs from 'node:fs';
import path from 'node:path';
import { serve, openPage, waitForFirstMap, setRange, SITE } from './lib.mjs';
import { decodePng, de2000, hex, cssRgb, over, deAll } from './colour_lib.mjs';

const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : null; })();
const shotsDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const lines = []; let failed = false;
const check = (ok, msg) => { lines.push(`${ok ? 'PASS' : 'FAIL'} legend-probe-C ${msg}`); failed ||= !ok; };
const info = msg => lines.push(`INFO legend-probe-C ${msg}`);

const { server, base } = await serve();
const { browser, page } = await openPage();
await page.addInitScript(() => {
    let L; Object.defineProperty(window, 'L', { configurable: true, get: () => L, set: v => { L = v; if (v && v.Map && !v.__hooked) { v.__hooked = true; v.Map.addInitHook(function () { (window.__lmaps ||= []).push(this); }); } } });
});

const clickSel = sel => page.evaluate(sel => { const el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length); el?.click(); return !!el; }, sel);
const settle = async (ms = 2500) => { await page.waitForFunction(() => !document.getElementById('map-busy'), null, { timeout: 120000 }).catch(() => {}); await page.waitForTimeout(ms); };

// --- legend colours on screen -------------------------------------------------
// Bars: elements with a gradient background, wider than 40 px and at most 14 px tall,
// sampled at 64 points along the middle row of a screenshot. Swatches: small elements
// (<= 16 px) with a solid background, read from the computed style; fuel-chip dots
// only when the chip is pressed. Hatch swatches (gradient, small) are left out.
async function legendColours(roots) {
    const found = await page.evaluate(roots => {
        const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && el.checkVisibility({ opacityProperty: true }); };
        const bars = [], swatches = [];
        for (const sel of roots) for (const root of document.querySelectorAll(sel)) {
            if (!vis(root)) continue;
            for (const el of root.querySelectorAll('*')) {
                if (!vis(el)) continue;
                const cs = getComputedStyle(el), r = el.getBoundingClientRect();
                const grad = /gradient/.test(cs.backgroundImage);
                if (grad && r.width > 40 && r.height <= 14) bars.push({ x: r.left, y: r.top, w: r.width, h: r.height, id: el.id || el.className });
                else if (!grad && r.width <= 16 && r.height <= 16 && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) {
                    const chip = el.closest('.fuel-chip');
                    if (chip && chip.getAttribute('aria-pressed') !== 'true') continue;
                    const label = (el.parentElement?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
                    swatches.push({ bg: cs.backgroundColor, label });
                }
            }
        }
        return { bars, swatches };
    }, roots);
    const cols = [];
    for (const b of found.bars) {
        const png = decodePng(await page.screenshot({ clip: { x: b.x, y: b.y, width: b.w, height: b.h } }));
        for (let i = 0; i < 64; i++) cols.push({ rgb: png.px(Math.round(1 + i * (png.w - 3) / 63), Math.floor(png.h / 2)), src: 'bar' });
    }
    const swatches = found.swatches.map(s => ({ rgb: cssRgb(s.bg).rgb, src: 'swatch', label: s.label }));
    return { cols: cols.concat(swatches), swatches, nBars: found.bars.length };
}

// --- flat map pixels ----------------------------------------------------------
async function mapPixels(mapSel) {
    await page.mouse.move(2, 2); await page.waitForTimeout(400);
    const pts = await page.evaluate(sel => {
        const host = document.querySelector(sel); if (!host) return [];
        const r = host.getBoundingClientRect(); const out = [];
        for (let gy = 0; gy < 90; gy++) for (let gx = 0; gx < 90; gx++) {
            const x = Math.round(r.left + (gx + 0.5) * r.width / 90), y = Math.round(r.top + (gy + 0.5) * r.height / 90);
            if (x < 1 || y < 1 || x >= innerWidth - 1 || y >= innerHeight - 1) continue;
            const top = document.elementFromPoint(x, y);
            if (top && host.contains(top) && !top.closest('.leaflet-control-container, .leaflet-popup, .map-caption, .map-legend, .map-tooltip')) out.push([x, y]);
        }
        return out;
    }, mapSel);
    const png = decodePng(await page.screenshot());
    const flat = [];
    for (const [x, y] of pts) {
        const p = png.px(x, y); let ok = true;
        for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (de2000(png.px(x + dx, y + dy), p) > 2) { ok = false; break; }
        if (ok) flat.push(p);
    }
    return { flat, png };
}

// Point layers: the pixel at the centre of every marker of radius >= 3 that no later
// (higher) marker covers, inside the visible map.
async function markerCentres() {
    const pts = await page.evaluate(() => {
        const map = window.__lmaps[0]; const r = map.getContainer().getBoundingClientRect();
        const ms = []; map.eachLayer(l => { if (l instanceof L.CircleMarker && l.options.pane === 'markers' && l.options.fillOpacity > 0) ms.push(l); });
        const pos = ms.map(m => { const p = map.latLngToContainerPoint(m.getLatLng()); return { x: p.x + r.left, y: p.y + r.top, r: m.getRadius() }; });
        const out = [];
        for (let i = 0; i < pos.length; i++) {
            const a = pos[i]; if (a.r < 2) continue;
            if (a.x < 360 || a.y < 90 || a.x > innerWidth - 300 || a.y > innerHeight - 20) continue;
            let covered = false;
            for (let j = i + 1; j < pos.length && !covered; j++) { const b = pos[j]; if (Math.hypot(a.x - b.x, a.y - b.y) < b.r + 1.5) covered = true; }
            if (covered) continue;
            const top = document.elementFromPoint(Math.round(a.x), Math.round(a.y));
            if (top && top.closest('#map') && !top.closest('.leaflet-control-container, .leaflet-popup')) out.push([Math.round(a.x), Math.round(a.y)]);
            if (out.length >= 400) break;
        }
        return out;
    });
    const png = decodePng(await page.screenshot());
    return pts.map(([x, y]) => png.px(x, y));
}

// C1 + C2 for one state.
async function legendExplainsMap(label, { mapSel = '#map', roots = ['#legend-stack'], alpha = 0.6, land = '#626E88', ocean = '#414F6F', points = false, categorical = null }) {
    const leg = await legendColours(roots);
    let { flat } = await mapPixels(mapSel);
    if (points) flat = flat.concat(await markerCentres());
    const L = hex(land), O = hex(ocean);
    const bare = [L, O, over([255, 255, 255], 0.08, L), over([255, 255, 255], 0.08, O), over([255, 255, 255], 0.06, L)];
    const cand = [];
    for (const c of leg.cols) {
        cand.push(c.rgb);
        for (const a of [].concat(alpha)) { cand.push(over(c.rgb, a, L), over(c.rgb, a, O)); }
    }
    if (points) for (const c of leg.swatches) for (const d of leg.swatches) for (const a of [].concat(alpha)) cand.push(over(c.rgb, a, over(d.rgb, a, L)), over(c.rgb, a, over(d.rgb, a, O)));
    const des = [], miss = new Map();
    for (const p of flat) {
        if (bare.some(q => de2000(p, q) < 4)) continue;
        let best = 1e9; for (const c of cand) { const d = de2000(p, c); if (d < best) best = d; if (best < 1) break; }
        des.push(best);
        if (best > 10) { const k = p.map(v => (v >> 4) << 4).join(','); miss.set(k, (miss.get(k) || 0) + 1); }
    }
    des.sort((a, b) => a - b);
    const p95 = des.length ? des[Math.floor(des.length * 0.95)] : Infinity;
    const unexplained = des.filter(d => d > 10).length;
    const share = des.length ? unexplained / des.length : 1;
    const minPx = points ? 1 : 30;
    const top = [...miss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `rgb(${k})×${n}`).join(' ');
    // points: a dot's centre can sit on a neighbour's anti-aliased rim; allow 2 such pixels
    check(leg.cols.length > 0 && des.length >= minPx && p95 <= 6 && (share <= 0.01 || (points && unexplained <= 2)),
        `${label}: legend explains the map (${leg.nBars} bar(s), ${leg.swatches.length} swatch(es)); p95 ΔE ${p95.toFixed(2)} over ${des.length} pixels, unexplained (> 10) ${(share * 100).toFixed(1)}%${top ? ' e.g. ' + top : ''} (p95 <= 6, <= 1%, >= ${minPx} px)`);
    if (categorical) {
        // 'ordered' (buckets of one ramp, T062's rule): neighbours >= 6, others >= 10.
        const ordered = categorical === 'ordered';
        const sw = leg.swatches;
        let worst = Infinity, pair = '', worstAdj = Infinity, pairAdj = '';
        for (let i = 0; i < sw.length; i++) for (let j = i + 1; j < sw.length; j++) {
            const a = [].concat(alpha)[0];
            const v = deAll(over(sw[i].rgb, a, L), over(sw[j].rgb, a, L));
            if (ordered && j === i + 1) { if (v < worstAdj) { worstAdj = v; pairAdj = `${sw[i].label} / ${sw[j].label}`; } }
            else if (v < worst) { worst = v; pair = `${sw[i].label} / ${sw[j].label}`; }
        }
        const pct = Math.round([].concat(alpha)[0] * 100);
        if (ordered) check(sw.length >= 2 && worstAdj >= 6 && worst >= 10, `${label}: ${sw.length} ordered legend buckets, neighbours >= 6 (min ${worstAdj.toFixed(1)}, ${pairAdj}) and others >= 10 (min ${worst.toFixed(1)}, ${pair}) at ${pct}% in every vision`);
        else check(sw.length >= 2 && worst >= 10, `${label}: ${sw.length} legend categories pairwise >= 10 at ${pct}% in every vision (min ${worst.toFixed(1)}, ${pair})`);
    }
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${label.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')}.png`) });
}

// C3: single-select toggle groups show one active button. The LCOE technology chips
// (T074) are multi-select, so at least one active is the rule there.
async function togglesSingle(label) {
    const bad = await page.evaluate(() => [...document.querySelectorAll('.toggle-group')]
        .filter(g => g.getClientRects().length && g.checkVisibility())
        .filter(g => !g.classList.contains('lcoe-tech-toggle') || !g.querySelector('.toggle-btn.is-active'))
        .map(g => ({ id: g.id || g.className, n: g.querySelectorAll('.toggle-btn.is-active').length, b: g.querySelectorAll('.toggle-btn').length }))
        .filter(g => g.b > 1 && g.n !== 1));
    check(!bad.length, `${label}: every visible single-select toggle shows one active button${bad.length ? ' (' + bad.map(b => `${b.id}: ${b.n} active`).join('; ') + ')' : ''}`);
}

// C3 for the fuel chips: look = aria-pressed = what is drawn.
async function plantState() {
    return page.evaluate(() => {
        const chips = [...document.querySelectorAll('#plant-fuel-filter [data-fuel]')].map(b => {
            const cs = getComputedStyle(b), dot = b.querySelector('.fuel-dot');
            return { fuel: b.dataset.fuel, pressed: b.getAttribute('aria-pressed') === 'true', bg: cs.backgroundColor, dot: dot ? getComputedStyle(dot).backgroundColor : null, ring: dot ? getComputedStyle(dot).borderTopColor : null, fuelVar: cs.getPropertyValue('--fuel').trim() };
        });
        const map = window.__lmaps[0];
        const fills = {}; let n = 0;
        map.eachLayer(l => { if (l instanceof L.CircleMarker && l.options.pane === 'markers' && l.options.fillOpacity > 0) { n++; const c = String(l.options.fillColor).toLowerCase(); fills[c] = (fills[c] || 0) + 1; } });
        const status = document.querySelector('#plant-status-buttons .is-active')?.dataset.status;
        const sizes = [...document.querySelectorAll('#plant-size-legend [data-size-mw]')].map(s => ({ mw: Number(s.dataset.sizeMw), r: Number(s.querySelector('circle')?.getAttribute('r')) }));
        return { chips, fills, n, status, sizes };
    });
}
const YELLOW = hex('#FFC400');
async function chipsTruthful(label, reg) {
    const st = await plantState();
    const lookOn = c => { const b = cssRgb(c.bg); return b && b.a > 0.5 && de2000(b.rgb, YELLOW) < 5; };
    const wrong = st.chips.filter(c => lookOn(c) !== c.pressed).map(c => c.fuel);
    check(!wrong.length, `${label}: chips look pressed exactly when aria-pressed (${st.chips.map(c => `${c.fuel} ${c.pressed ? 'on' : 'off'}`).join(', ')})${wrong.length ? ' wrong: ' + wrong.join(', ') : ''}`);
    const pressed = st.chips.filter(c => c.pressed);
    const want = new Set(pressed.map(c => reg.FUEL_COLORS[c.fuel].toLowerCase()));
    const got = new Set(Object.keys(st.fills));
    const same = want.size === got.size && [...want].every(c => got.has(c));
    check(same, `${label}: markers drawn in exactly the pressed fuels' colours (drawn ${[...got].join(' ') || 'none'}, ${st.n} markers; pressed ${[...want].join(' ') || 'none'})`);
    const dotOk = pressed.every(c => { const d = cssRgb(c.dot); return d && de2000(d.rgb, hex(reg.FUEL_COLORS[c.fuel])) < 1; });
    check(dotOk, `${label}: each pressed chip's dot is its registry colour`);
    return st;
}

const results = { states: [] };

if (only !== 'article') {
    await page.goto(`${base}/index.html?debug`);
    await waitForFirstMap(page);
    await page.evaluate(() => document.querySelector('.tour-nudge__close')?.click());
    const reg = await page.evaluate(async () => { const m = await import('./js/constants.js'); return { FUEL_COLORS: m.FUEL_COLORS, ALL_FUELS: m.ALL_FUELS, shortfall: m.DATA_COLOURS.shortfall, plantOpacity: m.PLANT_MARKER ? m.PLANT_MARKER.fillOpacity : 0.3, sizes: m.PLANT_MARKER ? m.PLANT_MARKER.sizeLegendMw.map(mw => [mw, m.PLANT_MARKER.radius(mw)]) : [] }; });

    // Capacity Factor
    await settle();
    await legendExplainsMap('capacity', {});
    await togglesSingle('capacity');
    await setRange(page, 'wind-slider', 2); await setRange(page, 'offwind-slider', 1); await settle(3000);
    await legendExplainsMap('capacity, wind build', {});
    await setRange(page, 'wind-slider', 0); await setRange(page, 'offwind-slider', 0); await settle();

    // Complementarity (T093; replaced Sample Days): every drought source and period, every score level
    await clickSel('header button[data-mode="complementarity"]'); await settle(5000);
    for (const period of ['wk', 'mo']) {
        await clickSel(`#comp-period-toggle [data-comp-period="${period}"]`);
        for (const src of ['solar', 'wind', 'both']) {
            await clickSel(`#comp-source-toggle [data-comp-source="${src}"]`); await settle();
            await legendExplainsMap(`complementarity, droughts ${src} ${period}`, {});
        }
    }
    await togglesSingle('complementarity, droughts');
    await clickSel('#comp-view-toggle [data-comp-view="score"]');
    for (const lv of ['day', 'week', 'month']) {
        await clickSel(`#comp-level-toggle [data-comp-level="${lv}"]`); await settle();
        await legendExplainsMap(`complementarity, score ${lv}`, {});
    }
    await togglesSingle('complementarity, score');
    await clickSel('#comp-view-toggle [data-comp-view="droughts"]');

    // Potential
    await clickSel('header button[data-mode="potential"]'); await settle(4000);
    for (const [tech, displays] of [['solar', ['total', 'multiple', 'per_capita']], ['onshore', ['total', 'multiple', 'per_capita']], ['offshore', ['total', 'multiple']], ['all', ['total', 'multiple']]]) {
        await clickSel(`#potential-tech-toggle [data-tech="${tech}"]`); await settle();
        for (const d of displays) {
            if (!(await clickSel(`#potential-display-toggle [data-display="${d}"]`))) { info(`potential ${tech} ${d}: no such button`); continue; }
            await settle();
            await legendExplainsMap(`potential ${tech} ${d}`, { categorical: d === 'multiple' || d === 'per_capita' ? 'ordered' : null });
        }
        await togglesSingle(`potential ${tech}`);
    }
    await clickSel('#potential-tech-toggle [data-tech="solar"]'); await clickSel('#potential-display-toggle [data-display="total"]');

    // LCOE
    await clickSel('header button[data-mode="lcoe"]');
    await page.waitForFunction(() => window.__atlas && window.__atlas.matrixReady, null, { timeout: 300000 });
    await settle(5000);
    for (const layer of ['lcoe', 'wind_share', 'wind_saving']) {
        await clickSel(`[data-lcoe-layer="${layer}"]`); await settle(4000);
        await legendExplainsMap(`lcoe ${layer}`, {});
        await togglesSingle(`lcoe ${layer}`);
    }
    await clickSel('[data-lcoe-layer="lcoe"]'); await settle();
    await clickSel('[data-target-mode="lcoe"]'); await settle(4000);
    await legendExplainsMap('lcoe, target mode LCOE', {});
    await clickSel('[data-target-mode="utilization"]'); await settle(4000);
    {
        const pt = await page.evaluate(() => { const m = window.__lmaps[0]; const p = m.latLngToContainerPoint([9, 20]); const r = m.getContainer().getBoundingClientRect(); return { x: p.x + r.left, y: p.y + r.top }; });
        await page.mouse.click(pt.x, pt.y); await settle(4000);
        await legendExplainsMap('lcoe, reference (difference)', {});
        if (await clickSel('#lcoe-display-mode [data-mode="transmission"]')) { await settle(4000); await legendExplainsMap('lcoe, reference (TX cost)', {}); }
        await clickSel('#lcoe-display-mode [data-mode="delta"]');
        await clickSel('#lcoe-clear-ref'); await settle();
    }

    // Supply-Demand
    await clickSel('header button[data-mode="population"]'); await settle(5000);
    for (const b of ['population', 'electricity', 'uptime', 'access']) {
        await clickSel(`#population-base-toggle [data-base="${b}"]`); await settle(3000);
        await legendExplainsMap(`supply-demand ${b}`, { alpha: 0.85 });
        await togglesSingle(`supply-demand ${b}`);
    }
    for (const o of ['cf', 'lcoe', 'potential']) {
        await clickSel(`#population-overlay-mode [data-overlay="${o}"]`); await settle(4000);
        // The supply panel covers the bottom of the supply legend at 1400x900 (reported
        // in T075); collapse it so the legend is on screen, as a reader would.
        await page.evaluate(() => { const b = document.getElementById('population-supply-toggle'); if (b && b.getAttribute('aria-expanded') === 'true') b.click(); });
        await page.waitForTimeout(600);
        const covered = await page.evaluate(() => [...document.querySelectorAll('#legend-supply-stack [id$="-bar"], #legend-supply-stack .legend-gradient')].filter(e => e.checkVisibility()).some(e => { const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t !== e; }));
        if (covered) info(`supply-demand supply map ${o}: legend bar still covered after collapsing the panel`);
        await legendExplainsMap(`supply-demand supply map ${o}`, { mapSel: '#map-supply', roots: ['#legend-supply-stack'] });
    }
    await clickSel('#population-overlay-mode [data-overlay="cf"]');

    // Capacity to Displace × status × fuel
    await clickSel('#population-base-toggle [data-base="plants"]'); await settle(4000);
    const pa = reg.plantOpacity;
    for (const status of ['announced', 'existing']) {
        await clickSel(`#plant-status-buttons [data-status="${status}"]`); await settle(3000);
        await togglesSingle(`plants ${status}`);
        await chipsTruthful(`plants ${status}, all fuels`, reg);
        await legendExplainsMap(`plants ${status}, all fuels`, { roots: ['#plant-fuel-filter', '#plant-legend'], alpha: pa, points: true, categorical: true });
        for (const f of reg.ALL_FUELS) {
            await clickSel(`#plant-fuel-filter [data-fuel="${f}"]`); await settle(1500);   // off
            const st = await chipsTruthful(`plants ${status}, ${f} off`, reg);
            check(!st.fills[reg.FUEL_COLORS[f].toLowerCase()], `plants ${status}, ${f} off: no ${f} marker drawn`);
            await clickSel(`#plant-fuel-filter [data-fuel="${f}"]`); await settle(1000);   // back on
        }
        // one fuel alone, each in turn: the legend (pressed chip) explains every dot
        for (const f of reg.ALL_FUELS) {
            for (const g of reg.ALL_FUELS) if (g !== f) await clickSel(`#plant-fuel-filter [data-fuel="${g}"]`);
            await settle(1500);
            await chipsTruthful(`plants ${status}, only ${f}`, reg);
            await legendExplainsMap(`plants ${status}, only ${f}`, { roots: ['#plant-fuel-filter', '#plant-legend'], alpha: pa, points: true });
            for (const g of reg.ALL_FUELS) if (g !== f) await clickSel(`#plant-fuel-filter [data-fuel="${g}"]`);
            await settle(800);
        }
        // all off: nothing drawn, every chip looks off
        for (const f of reg.ALL_FUELS) await clickSel(`#plant-fuel-filter [data-fuel="${f}"]`);
        await settle(1500);
        const off = await chipsTruthful(`plants ${status}, all fuels off`, reg);
        check(off.n === 0, `plants ${status}, all fuels off: no markers (${off.n})`);
        for (const f of reg.ALL_FUELS) await clickSel(`#plant-fuel-filter [data-fuel="${f}"]`);
        await settle(1500);
    }
    {
        const st = await plantState();
        const ok = reg.sizes.length >= 2 && st.sizes.length === reg.sizes.length && st.sizes.every((s, i) => s.mw === reg.sizes[i][0] && Math.abs(s.r - reg.sizes[i][1]) < 0.01);
        const visible = await page.evaluate(() => document.getElementById('plant-legend')?.checkVisibility());
        check(ok && visible, `plants: size legend shows ${st.sizes.map(s => `${s.mw} MW r ${s.r.toFixed(1)}`).join(', ') || 'nothing'} at the map's radii (PLANT_MARKER.radius)`);
    }
    // Charts mode: the stacked bars use the chip colours of the pressed fuels
    await clickSel('#population-display-toggle [data-mode="charts"]'); await settle(3000);
    {
        const ds = await page.evaluate(() => {
            const cs = window.Chart ? Object.values(window.Chart.instances || {}) : [];
            return cs.flatMap(c => c.data.datasets.filter(d => typeof d.backgroundColor === 'string').map(d => ({ label: d.label, bg: d.backgroundColor })));
        });
        const fuelDs = ds.filter(d => Object.values(reg.FUEL_COLORS).some(c => c.toLowerCase() === String(d.bg).toLowerCase()));
        info(`plants charts: datasets ${ds.map(d => `${d.label} ${d.bg}`).join(', ') || 'none'}`);
        if (!ds.length) info('plants charts: Chart.js is loaded from its CDN, which check pages block; chart colours are covered by check.py and the registry lint');
        else check(fuelDs.length >= 1, `plants charts: stacked bars use the registry fuel colours (${fuelDs.length} fuel series)`);
    }
    await clickSel('#population-display-toggle [data-mode="map"]'); await settle();
}

if (only !== 'app' && fs.existsSync(path.join(SITE, 'scrollytelling/classic.html'))) {
    // Article (not in the Ember Labs copy): each map state, the year buttons of the share state.
    await page.goto(`${base}/scrollytelling/classic.html`);   // the previous article (T087); the v3 article has its own probe (scripts/article/tools/story-probe.mjs)
    await page.waitForTimeout(4000);
    const env = await page.evaluate(() => ({ land: getComputedStyle(document.documentElement).getPropertyValue('--map-land').trim(), ocean: getComputedStyle(document.getElementById('map')).backgroundColor }));
    const toHex = c => { const p = cssRgb(c); return p ? '#' + p.rgb.map(v => v.toString(16).padStart(2, '0')).join('') : c; };
    const land = env.land && env.land.startsWith('#') ? env.land : '#626E88', ocean = toHex(env.ocean) || '#414F6F';
    info(`article land ${land}, ocean ${ocean}`);
    const sections = await page.evaluate(() => [...document.querySelectorAll('[data-map]')].map((s, i) => ({ i, map: s.dataset.map })));
    const seen = new Set();
    for (const s of sections) {
        if (seen.has(s.map) || s.map === 'blank') continue;
        seen.add(s.map);
        await page.evaluate(i => document.querySelectorAll('[data-map]')[i].scrollIntoView({ block: 'start' }), s.i);
        await page.waitForTimeout(3500);
        const years = s.map === 'share' ? await page.evaluate(() => [...document.querySelectorAll('#map-controls button[data-year]')].map(b => b.dataset.year)) : [null];
        for (const y of years) {
            if (y) { await clickSel(`#map-controls button[data-year="${y}"]`); await page.waitForTimeout(2500); }
            await legendExplainsMap(`article ${s.map}${y ? ' ' + y : ''}`, { roots: ['#map-legend'], alpha: [0.8, 0.6], land, ocean, categorical: s.map === 'potential' ? 'ordered' : null });
        }
    }
}

await browser.close(); server.close();
lines.forEach(l => console.log(l));
console.log(`${failed ? 'FAIL' : 'PASS'} legend-probe-C overall (${SITE})`);
process.exit(failed ? 1 : 0);
