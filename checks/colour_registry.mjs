// T062: every data colour and colour scale comes from the registry in
// deployment/js/constants.js (RAMPS, DATA_COLOURS, NO_DATA_COLOR, rampScale).
// Fails on, anywhere else in deployment/js/*.js (workers included):
//   - named d3 colour schemes or interpolators (d3.interpolateXxx, d3.schemeXxx),
//   - colour literals: #hex, rgb(, rgba(, hsl(,
// except the UI-chrome allow-list below, each entry with its reason.
// usage: node checks/colour_registry.mjs   (ATLAS_SITE to grade another tree)
import fs from 'node:fs';
import path from 'node:path';
import { SITE } from './lib.mjs';

const JS = path.join(SITE, 'js');
const REGISTRY = 'constants.js';
const SKIP = new Set(['apache-arrow.js', 'parquet_wasm.js']);   // vendored libraries
// [file, exact literal, reason]
const ALLOW = [
    ['map.js', "'#ffffff'", 'hover and highlight rim (UI chrome, not data)'],
    ['map.js', '"#ffffff"', 'hover rim on the SVG fallback (UI chrome)'],
    ['map.js', "'#fff'", 'invisible hit-marker style (opacity 0)'],
    ['map.js', '"rgba(255,255,255,0.08)"', 'cell border stroke (UI chrome)'],
    ['voronoi-canvas.js', "'rgba(255,255,255,0.08)'", 'cell border stroke (UI chrome)'],
    ['voronoi-canvas.js', "'#ffffff'", 'hover and highlight rim (UI chrome)'],
    ['voronoi-canvas.js', "'#000'", 'land mask fill for destination-in compositing (never shown)'],
    ['voronoi-canvas.js', "'rgba('", 'rgbaStr(): formats a registry colour with alpha'],
    ['complementarity.js', "'url(#na-hatch)'", 'SVG pattern reference, not a colour'],
    ['map.js', '"na-hatch"', 'SVG pattern id, not a colour'],
    ['basemap.js', "'#626E88'", 'fallback when --map-land is not set (the same Labs token)'],
    ['app.js', "`1px solid ${DATA_COLOURS.outline}`", 'registry colour in a template'],
    ['perf-hud.js', '*', 'debug overlay (?perf only), styled as Labs, not data'],
];
const allowed = (file, lit) => ALLOW.some(([f, l]) => f === file && (l === '*' || l === lit || l.includes(lit)));

const files = [];
(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && !SKIP.has(e.name)) files.push(p);
    }
})(JS);

const findings = [];
for (const f of files) {
    const name = path.basename(f);
    if (name === REGISTRY) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');   // comments do not count
        for (const m of code.matchAll(/d3\.(interpolate[A-Z]\w*|scheme[A-Z]\w*|interpolateRgb\w*)/g))
            findings.push(`${name}:${i + 1} d3 colour scheme ${m[0]}`);
        for (const m of code.matchAll(/['"`](#[0-9a-fA-F]{3,8})\b|(?<![\w.])(?:rgba?|hsla?)\(/g)) {
            const lit = m[1] ? code.slice(m.index, m.index + m[1].length + 2) : code.slice(m.index - 1, m.index + 5);
            if (allowed(name, lit) || allowed(name, code.trim().slice(0, 200))) continue;
            if (m[1] && /url\(#|getElementById|querySelector/.test(code)) continue;
            findings.push(`${name}:${i + 1} colour literal ${m[0]}: ${code.trim().slice(0, 100)}`);
        }
    });
}
// T075: legend swatches in the page markup. Tailwind hue classes (bg-orange-500 ...)
// are remapped by the Labs config (purple-500 and sky-400 both render #37A6E6), so a
// swatch drawn with one shows a colour the map never draws; colour literals in style
// attributes bypass the registry. Swatches name a registry key instead
// (data-state-swatch, painted by app.js installRampVars; fuel chips via --fuel).
const HTML_FILES = ['index.html', 'scrollytelling/index.html', 'scrollytelling/classic.html'].map(f => path.join(SITE, f)).filter(f => fs.existsSync(f));
const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const reg = await import(path.join(JS, REGISTRY));
const SPECIAL_SWATCHES = new Set(['naHatch', 'windHatch']);
for (const f of HTML_FILES) {
    const rel = path.relative(SITE, f);
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(new RegExp(`\\bbg-(?:${HUES})-\\d{2,3}\\b`, 'g')))
            findings.push(`${rel}:${i + 1} Tailwind hue class ${m[0]} used as a colour (use data-state-swatch)`);
        for (const m of line.matchAll(/style="([^"]*)"/g))
            if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(m[1])) findings.push(`${rel}:${i + 1} colour literal in a style attribute: ${m[1].slice(0, 80)}`);
        for (const m of line.matchAll(/data-state-swatch="([^"]+)"/g))
            if (!SPECIAL_SWATCHES.has(m[1]) && !(m[1] in reg.DATA_COLOURS)) findings.push(`${rel}:${i + 1} data-state-swatch="${m[1]}" is not a DATA_COLOURS key`);
        for (const m of line.matchAll(/data-fuel="([^"]+)"/g))
            if (!(m[1] in reg.FUEL_COLORS)) findings.push(`${rel}:${i + 1} data-fuel="${m[1]}" has no registry colour`);
    });
}
// Every fuel has its own colour (the T075 bug: oil and gas and nuclear shared one).
{
    const vals = Object.values(reg.FUEL_COLORS).map(v => v.toLowerCase());
    if (new Set(vals).size !== vals.length) findings.push(`constants.js FUEL_COLORS has a repeated colour: ${vals.join(' ')}`);
    for (const k of reg.ALL_FUELS) if (!reg.FUEL_LABELS?.[k]) findings.push(`constants.js FUEL_LABELS lacks ${k}`);
}

if (findings.length) {
    findings.forEach(f => console.log(`FAIL colour-registry ${f}`));
    console.log(`FAIL colour-registry ${findings.length} finding(s) outside js/${REGISTRY}`);
    process.exit(1);
}
console.log(`PASS colour-registry ${files.length - 1} modules and ${HTML_FILES.length} pages use only the registry (allow-list: ${ALLOW.length} UI-chrome entries; no Tailwind hue swatches or style colour literals in markup)`);
